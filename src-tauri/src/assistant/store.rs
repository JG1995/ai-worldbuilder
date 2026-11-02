//! The conversations of one world, in an SQLite file per world:
//! `<app data dir>/grimoire-data/conversations/<name>.sqlite`, named like the world's history
//! database by `history::file_name`. The file records the world folder's path too, so two paths
//! with the same hash never share their conversations.
//!
//! Format 1, named by `PRAGMA user_version`:
//!
//! - `meta`: one row, the world folder's path.
//! - `conversations`: each conversation's `title`, from its first message, and the times it was
//!   `created` and `updated` by its latest message, in seconds since the Unix epoch.
//! - `messages`: each message of a conversation in order (`id`): its `role` (`user` or
//!   `assistant`), `text` and `time`, and for an answer how it ended (`state`: `complete`,
//!   `stopped` or `cut_off`), how many earlier messages its request `left_out`, and whether the
//!   world was still `indexing` as its pages were chosen.
//! - `read_pages`: the path of each page an answer's request carried, in the order chosen
//!   (`ordinal`), and whether only part of it was read. Never a page's text.
//!
//! Deleting a conversation deletes its messages and their pages. Each message is written in one
//! transaction, and the file syncs fully, so after a crash a message is there whole or not at all.
//!
//! A damaged file is set aside, as a damaged history database is, and a new one replaces it. A file
//! in a newer format, holding unknown data, or recording another world is left untouched; so is
//! everything when the world's path cannot name a file or there is no app data folder. The store
//! then keeps this opening's conversations in memory. A write to the file that fails moves the
//! store to memory too, with what the file held, for the rest of the opening.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, params, params_from_iter};
use serde::Serialize;

use super::ContextPage;
use crate::data_file;
use crate::error::{AppError, ErrorKind};
use crate::history;

/// The format this version writes. A file in a newer format is never written.
const FORMAT: i64 = 1;

const SCHEMA: &str = "
    CREATE TABLE conversations (
        id INTEGER PRIMARY KEY,
        title TEXT,
        created INTEGER,
        updated INTEGER
    );
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation INTEGER REFERENCES conversations ON DELETE CASCADE,
        role TEXT,
        text TEXT,
        time INTEGER,
        state TEXT,
        left_out INTEGER,
        indexing INTEGER
    );
    CREATE INDEX messages_by_conversation ON messages (conversation, id);
    CREATE TABLE read_pages (
        message INTEGER REFERENCES messages ON DELETE CASCADE,
        ordinal INTEGER,
        path TEXT,
        partial INTEGER,
        PRIMARY KEY (message, ordinal)
    );
";
/// The tables that hold conversations, in an order that keeps their references valid.
const TABLES: [&str; 3] = ["conversations", "messages", "read_pages"];
/// The most characters of a conversation's title, from its first message's first line.
const TITLE_LIMIT: usize = 60;

const USER: &str = "user";
const ASSISTANT: &str = "assistant";

/// How an answer ended, as it is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum AnswerState {
    Complete,
    Stopped,
    CutOff,
}

impl AnswerState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::Stopped => "stopped",
            Self::CutOff => "cut_off",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "complete" => Some(Self::Complete),
            "stopped" => Some(Self::Stopped),
            "cut_off" => Some(Self::CutOff),
            _ => None,
        }
    }
}

/// A stored message as a request carries it: a user message (`answer` is `None`) or an answer and
/// how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub text: String,
    pub answer: Option<AnswerState>,
}

/// What an answer's request carried, saved with the answer.
pub struct Answer<'a> {
    pub state: AnswerState,
    pub text: &'a str,
    /// Each page's path and whether only part of it was read, in the order chosen.
    pub pages: &'a [(String, bool)],
    pub left_out: u32,
    pub indexing: bool,
}

/// Why the conversations are kept differently than usual until the world closes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StoreNotice {
    /// The world's file was damaged, so it was set aside and a new one started.
    SetAside,
    /// The conversations are kept in memory only, for `reason`, and are lost when the world closes.
    NotSaved { reason: String },
}

/// A conversation as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ConversationSummary {
    pub id: i64,
    pub title: String,
    /// When its latest message was sent, in seconds since the Unix epoch.
    pub updated: i64,
}

/// The world's conversations, the latest message's newest first, and how they are kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Conversations {
    pub items: Vec<ConversationSummary>,
    pub notice: Option<StoreNotice>,
}

/// A conversation with its messages in order. Each user message is followed by its answer, or by
/// nothing when its answer never arrived.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub messages: Vec<SavedMessage>,
}

/// A saved message. Times are in seconds since the Unix epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "role",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SavedMessage {
    User {
        text: String,
        time: i64,
    },
    /// An answer, with the pages its request carried in the order chosen, how many earlier
    /// messages it left out, and whether the world was still being indexed.
    Answer {
        text: String,
        time: i64,
        state: AnswerState,
        pages: Vec<ContextPage>,
        left_out: u32,
        indexing: bool,
    },
}

/// One world's conversations, in its file or, when that cannot be used, in memory.
pub struct Store {
    connection: Connection,
    /// `connection` is the world's file, rather than a database in memory.
    saving: bool,
    notice: Option<StoreNotice>,
}

/// Why a message could not be written.
enum WriteFailure {
    /// The database failed; a write to the file is tried again in memory.
    Store(rusqlite::Error),
    /// The write is refused as the user asked it, such as for a conversation that does not exist.
    Refused(AppError),
}

impl From<rusqlite::Error> for WriteFailure {
    fn from(error: rusqlite::Error) -> Self {
        Self::Store(error)
    }
}

impl From<WriteFailure> for AppError {
    fn from(failure: WriteFailure) -> Self {
        match failure {
            WriteFailure::Store(error) => store_error(error),
            WriteFailure::Refused(error) => error,
        }
    }
}

impl Store {
    /// Opens the conversations of the world at `world` from its file in `app_data`, and creates
    /// the file when there is none. `now` names a damaged file that is set aside. When the file
    /// cannot be used, the store is in memory, and its notice says why.
    pub fn open(app_data: Option<&Path>, world: &Path, now: u64) -> Result<Self, AppError> {
        match open_file(app_data, world, now) {
            Ok((connection, set_aside)) => Ok(Self {
                connection,
                saving: true,
                notice: set_aside.then_some(StoreNotice::SetAside),
            }),
            Err(reason) => {
                let connection = memory_database().map_err(store_error)?;
                Ok(Self {
                    connection,
                    saving: false,
                    notice: Some(StoreNotice::NotSaved { reason }),
                })
            }
        }
    }

    /// Runs `write` in one transaction. When writing to the file fails, the store moves to memory,
    /// with what the file held, and runs `write` again there, so the chat goes on unsaved.
    fn write<T>(
        &mut self,
        write: impl Fn(&Transaction) -> Result<T, WriteFailure>,
    ) -> Result<T, AppError> {
        match self.attempt(&write) {
            Err(WriteFailure::Store(error)) if self.saving => {
                self.move_to_memory(failure_reason(&error));
                self.attempt(&write).map_err(AppError::from)
            }
            result => result.map_err(AppError::from),
        }
    }

    fn attempt<T>(
        &mut self,
        write: &impl Fn(&Transaction) -> Result<T, WriteFailure>,
    ) -> Result<T, WriteFailure> {
        let transaction = self.connection.transaction()?;
        let value = write(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    /// Keeps the conversations in memory from now on, starting from what the file still holds, or
    /// from nothing when it cannot be read. The file is left as it is.
    fn move_to_memory(&mut self, reason: String) {
        if let Ok(memory) = copied(&self.connection).or_else(|_| memory_database()) {
            self.connection = memory;
        }
        self.saving = false;
        self.notice = Some(StoreNotice::NotSaved { reason });
    }

    /// Adds a user message to `conversation`, or to a new conversation titled by the message when
    /// there is none, and returns the conversation's id.
    pub fn add_user_message(
        &mut self,
        conversation: Option<i64>,
        text: &str,
        now: i64,
    ) -> Result<i64, AppError> {
        self.write(|transaction| {
            let conversation = match conversation {
                Some(id) => {
                    let updated = transaction.execute(
                        "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                        params![id, now],
                    )?;
                    if updated == 0 {
                        return Err(WriteFailure::Refused(no_conversation()));
                    }
                    id
                }
                None => {
                    transaction.execute(
                        "INSERT INTO conversations (title, created, updated) VALUES (?1, ?2, ?2)",
                        params![title(text), now],
                    )?;
                    transaction.last_insert_rowid()
                }
            };
            transaction.execute(
                "INSERT INTO messages (conversation, role, text, time) VALUES (?1, ?2, ?3, ?4)",
                params![conversation, USER, text, now],
            )?;
            Ok(conversation)
        })
    }

    /// Readies `conversation` to answer its last message again: that message must be a user
    /// message whose answer is missing or stopped, and a stopped answer is removed. Returns the
    /// message's text.
    pub fn prepare_retry(&mut self, conversation: i64) -> Result<String, AppError> {
        self.write(|transaction| {
            let last: Vec<(i64, String, String, Option<String>)> = transaction
                .prepare(
                    "SELECT id, role, text, state FROM messages WHERE conversation = ?1
                     ORDER BY id DESC LIMIT 2",
                )?
                .query_map([conversation], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<_, _>>()?;
            match last.as_slice() {
                [(_, role, text, _), ..] if role == USER => Ok(text.clone()),
                [(answer, _, _, Some(state)), (_, role, text, _)]
                    if role == USER && state == AnswerState::Stopped.as_str() =>
                {
                    transaction.execute("DELETE FROM messages WHERE id = ?1", [answer])?;
                    Ok(text.clone())
                }
                [] => Err(WriteFailure::Refused(no_conversation())),
                _ => Err(WriteFailure::Refused(AppError::new(
                    ErrorKind::Conflict,
                    "The last message already has its answer.",
                ))),
            }
        })
    }

    /// Saves the answer to `conversation`'s last message, with the pages its request carried.
    pub fn add_answer(
        &mut self,
        conversation: i64,
        answer: &Answer,
        now: i64,
    ) -> Result<(), AppError> {
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO messages (conversation, role, text, time, state, left_out, indexing)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    conversation,
                    ASSISTANT,
                    answer.text,
                    now,
                    answer.state.as_str(),
                    answer.left_out,
                    answer.indexing
                ],
            )?;
            let message = transaction.last_insert_rowid();
            for (ordinal, (path, partial)) in answer.pages.iter().enumerate() {
                transaction.execute(
                    "INSERT INTO read_pages (message, ordinal, path, partial)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![message, ordinal as i64, path, partial],
                )?;
            }
            transaction.execute(
                "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                params![conversation, now],
            )?;
            Ok(())
        })
    }

    /// Deletes `conversation` with its messages and their pages, for good.
    pub fn delete(&mut self, conversation: i64) -> Result<(), AppError> {
        self.write(|transaction| {
            let deleted =
                transaction.execute("DELETE FROM conversations WHERE id = ?1", [conversation])?;
            if deleted == 0 {
                return Err(WriteFailure::Refused(no_conversation()));
            }
            Ok(())
        })
    }

    /// `conversation`'s messages in order, as a request carries them.
    pub fn messages(&self, conversation: i64) -> Result<Vec<Message>, AppError> {
        let mut statement = self
            .connection
            .prepare("SELECT text, state FROM messages WHERE conversation = ?1 ORDER BY id")
            .map_err(store_error)?;
        statement
            .query_map([conversation], |row| {
                let state: Option<String> = row.get(1)?;
                Ok(Message {
                    text: row.get(0)?,
                    answer: state.as_deref().and_then(AnswerState::parse),
                })
            })
            .and_then(Iterator::collect)
            .map_err(store_error)
    }

    /// The conversations, the latest message's newest first, and the store's notice.
    pub fn conversations(&self) -> Result<Conversations, AppError> {
        let mut statement = self
            .connection
            .prepare("SELECT id, title, updated FROM conversations ORDER BY updated DESC, id DESC")
            .map_err(store_error)?;
        let items = statement
            .query_map([], |row| {
                Ok(ConversationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    updated: row.get(2)?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(store_error)?;
        Ok(Conversations {
            items,
            notice: self.notice.clone(),
        })
    }

    /// `conversation` with its messages, and each answer with its pages.
    pub fn conversation(&self, conversation: i64) -> Result<Conversation, AppError> {
        self.read_conversation(conversation)
            .map_err(store_error)?
            .ok_or_else(no_conversation)
    }

    fn read_conversation(&self, id: i64) -> rusqlite::Result<Option<Conversation>> {
        let Some(title) = self
            .connection
            .query_row(
                "SELECT title FROM conversations WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let mut pages = self
            .connection
            .prepare("SELECT path, partial FROM read_pages WHERE message = ?1 ORDER BY ordinal")?;
        let mut statement = self.connection.prepare(
            "SELECT id, role, text, time, state, left_out, indexing FROM messages
             WHERE conversation = ?1 ORDER BY id",
        )?;
        let mut rows = statement.query([id])?;
        let mut messages = Vec::new();
        while let Some(row) = rows.next()? {
            let text: String = row.get(2)?;
            let time: i64 = row.get(3)?;
            let state: Option<String> = row.get(4)?;
            let message = match state.as_deref().and_then(AnswerState::parse) {
                None => SavedMessage::User { text, time },
                Some(state) => SavedMessage::Answer {
                    text,
                    time,
                    state,
                    pages: pages
                        .query_map([row.get::<_, i64>(0)?], |page| {
                            Ok(ContextPage {
                                path: page.get(0)?,
                                partial: page.get(1)?,
                            })
                        })?
                        .collect::<Result<_, _>>()?,
                    left_out: row.get::<_, Option<u32>>(5)?.unwrap_or(0),
                    indexing: row.get::<_, Option<bool>>(6)?.unwrap_or(false),
                },
            };
            messages.push(message);
        }
        Ok(Some(Conversation {
            id,
            title,
            messages,
        }))
    }
}

/// The conversation file of the world whose folder's path is `world`.
fn file(app_data: &Path, world: &str) -> PathBuf {
    app_data
        .join("grimoire-data")
        .join("conversations")
        .join(history::file_name(world))
}

/// Opens the world's file, setting a damaged one aside first, and says whether it did; otherwise
/// gives the reason the file cannot be used, having left it as it was.
fn open_file(
    app_data: Option<&Path>,
    world: &Path,
    now: u64,
) -> Result<(Connection, bool), String> {
    let app_data = app_data.ok_or("There is no app data folder to save them in.")?;
    let world = world
        .to_str()
        .ok_or("The world folder's path is not valid Unicode.")?;
    let file = file(app_data, world);
    let folder = file
        .parent()
        .expect("the conversation file is inside a folder");
    fs::create_dir_all(folder).map_err(io_reason)?;
    match connect(&file, world) {
        Ok(connection) => return Ok((connection, false)),
        Err(Refusal::Failed(reason)) => return Err(reason),
        // `connect` has closed the damaged file, so Windows lets it be renamed.
        Err(Refusal::Damaged) => data_file::set_aside(&file, now).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "A damaged conversation store could not be set aside, because its new name is taken."
                    .to_owned()
            } else {
                io_reason(error)
            }
        })?,
    }
    match connect(&file, world) {
        Ok(connection) => Ok((connection, true)),
        Err(Refusal::Failed(reason)) => Err(reason),
        Err(Refusal::Damaged) => {
            Err("A new conversation store could not be created in place of a damaged one.".into())
        }
    }
}

/// Why a file could not be used as it is.
enum Refusal {
    /// SQLite cannot read the file as a database; it is set aside and replaced.
    Damaged,
    /// Anything else, which leaves the file as it is.
    Failed(String),
}

impl From<rusqlite::Error> for Refusal {
    fn from(error: rusqlite::Error) -> Self {
        match error.sqlite_error_code() {
            Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => Self::Damaged,
            _ => Self::Failed(failure_reason(&error)),
        }
    }
}

/// Opens the file at `file` for the world at `world`, creating format 1 in an empty one. On any
/// refusal the connection is closed before this returns.
fn connect(file: &Path, world: &str) -> Result<Connection, Refusal> {
    let mut connection = Connection::open(file)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    // Reading the format is the first read of the file, so it finds a damaged one.
    let format: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match format {
        0 => create(&mut connection, world)?,
        FORMAT => check_world(&connection, world)?,
        _ => {
            return Err(Refusal::Failed(
                "The conversation store is in a newer format than this version of Grimoire.md knows."
                    .to_owned(),
            ));
        }
    }
    Ok(connection)
}

/// Creates format 1 in one transaction, in a file that holds nothing yet.
fn create(connection: &mut Connection, world: &str) -> Result<(), Refusal> {
    let transaction = connection.transaction()?;
    let objects: i64 =
        transaction.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
    if objects > 0 {
        return Err(Refusal::Failed(
            "The conversation store holds data in a format Grimoire.md does not know.".to_owned(),
        ));
    }
    transaction.execute_batch("CREATE TABLE meta (world TEXT NOT NULL);")?;
    transaction.execute_batch(SCHEMA)?;
    transaction.execute("INSERT INTO meta (world) VALUES (?1)", [world])?;
    transaction.pragma_update(None, "user_version", FORMAT)?;
    transaction.commit()?;
    Ok(())
}

fn check_world(connection: &Connection, world: &str) -> Result<(), Refusal> {
    let stored: String = connection.query_row("SELECT world FROM meta", [], |row| row.get(0))?;
    if stored == world {
        Ok(())
    } else {
        Err(Refusal::Failed(
            "The conversation store belongs to another world folder.".to_owned(),
        ))
    }
}

/// An empty store in memory.
fn memory_database() -> rusqlite::Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.execute_batch(SCHEMA)?;
    Ok(connection)
}

/// A store in memory holding every conversation `from` holds.
fn copied(from: &Connection) -> rusqlite::Result<Connection> {
    let mut memory = memory_database()?;
    let transaction = memory.transaction()?;
    for table in TABLES {
        let mut select = from.prepare(&format!("SELECT * FROM {table}"))?;
        let columns = select.column_count();
        let mut insert = transaction.prepare(&format!(
            "INSERT INTO {table} VALUES ({})",
            vec!["?"; columns].join(", ")
        ))?;
        let mut rows = select.query([])?;
        while let Some(row) = rows.next()? {
            let values = (0..columns)
                .map(|column| row.get::<_, Value>(column))
                .collect::<rusqlite::Result<Vec<_>>>()?;
            insert.execute(params_from_iter(values))?;
        }
    }
    transaction.commit()?;
    Ok(memory)
}

/// A conversation's title: its first message's first line, cut to `TITLE_LIMIT` characters.
fn title(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or_default();
    line.chars().take(TITLE_LIMIT).collect()
}

fn no_conversation() -> AppError {
    AppError::new(ErrorKind::NotFound, "The conversation does not exist.")
}

/// Why the file cannot be used or written, as the not-saved notice gives it: a sentence.
fn failure_reason(error: &rusqlite::Error) -> String {
    match error.sqlite_error_code() {
        Some(ErrorCode::DiskFull) => "The disk is full.".to_owned(),
        Some(ErrorCode::CannotOpen | ErrorCode::ReadOnly | ErrorCode::PermissionDenied) => {
            "The conversation store cannot be written.".to_owned()
        }
        _ => format!("The conversation store reported an error: {error}."),
    }
}

fn io_reason(error: io::Error) -> String {
    AppError::from(error).message
}

fn store_error(error: rusqlite::Error) -> AppError {
    AppError::new(
        ErrorKind::Io,
        format!("The conversation could not be stored: {error}."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;
    use tempfile::TempDir;

    const WORLD: &str = "/home/tester/Worlds/Kesh";

    fn opened(app_data: &TempDir) -> Store {
        Store::open(Some(app_data.path()), Path::new(WORLD), 1_000).unwrap()
    }

    fn file_of(app_data: &TempDir) -> PathBuf {
        file(app_data.path(), WORLD)
    }

    /// The bytes and modification time of a file, which a refused file keeps.
    fn snapshot(file: &Path) -> (Vec<u8>, SystemTime) {
        (
            fs::read(file).unwrap(),
            fs::metadata(file).unwrap().modified().unwrap(),
        )
    }

    fn user(text: &str) -> Message {
        Message {
            text: text.to_owned(),
            answer: None,
        }
    }

    fn answer(state: AnswerState, text: &'static str) -> Answer<'static> {
        Answer {
            state,
            text,
            pages: &[],
            left_out: 0,
            indexing: false,
        }
    }

    fn titles(store: &Store) -> Vec<String> {
        let listed = store.conversations().unwrap().items;
        listed.into_iter().map(|item| item.title).collect()
    }

    /// The number of rows in each table of the world's file, read with a connection of its own.
    fn rows_in_file(app_data: &TempDir) -> [i64; 3] {
        let connection = Connection::open(file_of(app_data)).unwrap();
        TABLES.map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
    }

    #[test]
    fn conversations_survive_reopening_and_list_the_latest_message_s_newest_first() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let long = format!("  {}\nsecond line", "x".repeat(70));
        let first = store.add_user_message(None, &long, 10).unwrap();
        let second = store.add_user_message(None, "Saltmere", 20).unwrap();
        let pages = [("Places/Saltmere.md".to_owned(), true)];
        store
            .add_answer(
                first,
                &Answer {
                    state: AnswerState::CutOff,
                    text: "Long",
                    pages: &pages,
                    left_out: 2,
                    indexing: true,
                },
                30,
            )
            .unwrap();
        store.add_user_message(Some(first), "Next", 40).unwrap();
        drop(store);

        let store = opened(&app_data);

        assert_eq!(store.conversations().unwrap().notice, None);
        assert_eq!(titles(&store), ["x".repeat(60), "Saltmere".to_owned()]);
        assert_eq!(
            store.conversation(first).unwrap(),
            Conversation {
                id: first,
                title: "x".repeat(60),
                messages: vec![
                    SavedMessage::User {
                        text: long.clone(),
                        time: 10
                    },
                    SavedMessage::Answer {
                        text: "Long".to_owned(),
                        time: 30,
                        state: AnswerState::CutOff,
                        pages: vec![ContextPage {
                            path: "Places/Saltmere.md".to_owned(),
                            partial: true
                        }],
                        left_out: 2,
                        indexing: true,
                    },
                    SavedMessage::User {
                        text: "Next".to_owned(),
                        time: 40
                    },
                ],
            }
        );
        assert_eq!(
            store.messages(second).unwrap(),
            [user("Saltmere")],
            "a conversation holds only its own messages"
        );
        assert_eq!(
            store.conversation(99).unwrap_err().kind,
            ErrorKind::NotFound
        );
        let connection = Connection::open(file_of(&app_data)).unwrap();
        let format: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let world: String = connection
            .query_row("SELECT world FROM meta", [], |row| row.get(0))
            .unwrap();
        assert_eq!((format, world.as_str()), (1, WORLD));
    }

    #[test]
    fn a_message_is_written_whole_or_not_at_all() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Hello", 1).unwrap();
        // Fails the write of an answer's second page, inside its transaction.
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER fail BEFORE INSERT ON read_pages WHEN NEW.ordinal = 1
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        let pages = [("A.md".to_owned(), false), ("B.md".to_owned(), false)];

        store
            .add_answer(
                conversation,
                &Answer {
                    state: AnswerState::Complete,
                    text: "Hi",
                    pages: &pages,
                    left_out: 0,
                    indexing: false,
                },
                2,
            )
            .unwrap();

        // The file holds neither the answer nor its first page; the chat goes on in memory.
        assert_eq!(rows_in_file(&app_data), [1, 1, 0]);
        assert!(matches!(
            store.conversations().unwrap().notice,
            Some(StoreNotice::NotSaved { .. })
        ));
        assert_eq!(
            store.messages(conversation).unwrap(),
            [
                user("Hello"),
                Message {
                    text: "Hi".to_owned(),
                    answer: Some(AnswerState::Complete)
                }
            ]
        );
    }

    #[test]
    fn a_damaged_file_is_set_aside_with_its_journal_and_a_new_one_works() {
        let app_data = tempfile::tempdir().unwrap();
        let file = file_of(&app_data);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        // Bytes that are not a database, from a fixed linear congruential sequence.
        let damaged: Vec<u8> = (0u32..8192)
            .map(|index| (index.wrapping_mul(1_103_515_245).wrapping_add(12_345) >> 16) as u8)
            .collect();
        fs::write(&file, &damaged).unwrap();
        // A journal SQLite does not take as hot, so it stays to be set aside.
        let journal = data_file::with_suffix(&file, "-journal");
        fs::write(&journal, b"\0left over").unwrap();

        let mut store = opened(&app_data);

        assert_eq!(
            store.conversations().unwrap().notice,
            Some(StoreNotice::SetAside)
        );
        assert_eq!(
            fs::read(data_file::with_suffix(&file, ".damaged-1000")).unwrap(),
            damaged
        );
        assert_eq!(
            fs::read(data_file::with_suffix(&journal, ".damaged-1000")).unwrap(),
            b"\0left over"
        );
        store.add_user_message(None, "Hello", 1).unwrap();
        assert_eq!(rows_in_file(&app_data), [1, 1, 0]);
    }

    #[test]
    fn a_newer_unknown_or_foreign_file_is_left_untouched_and_the_store_works_in_memory() {
        let cases: [(&str, &str, &str); 3] = [
            (
                "PRAGMA user_version = 2;",
                "",
                "The conversation store is in a newer format than this version of Grimoire.md knows.",
            ),
            (
                "PRAGMA user_version = 0; CREATE TABLE notes (text TEXT);",
                "DROP TABLE conversations; DROP TABLE messages; DROP TABLE read_pages;
                 DROP TABLE meta;",
                "The conversation store holds data in a format Grimoire.md does not know.",
            ),
            (
                "",
                "UPDATE meta SET world = '/home/tester/Worlds/Other';",
                "The conversation store belongs to another world folder.",
            ),
        ];
        for (pragma, change, reason) in cases {
            let app_data = tempfile::tempdir().unwrap();
            let file = file_of(&app_data);
            let mut store = opened(&app_data);
            store.add_user_message(None, "Kept", 1).unwrap();
            drop(store);
            let connection = Connection::open(&file).unwrap();
            connection.execute_batch(change).unwrap();
            connection.execute_batch(pragma).unwrap();
            drop(connection);
            let before = snapshot(&file);

            let mut store = opened(&app_data);
            let conversation = store.add_user_message(None, "In memory", 2).unwrap();

            assert_eq!(
                store.conversations().unwrap().notice,
                Some(StoreNotice::NotSaved {
                    reason: reason.to_owned()
                }),
                "{reason}"
            );
            assert_eq!(titles(&store), ["In memory"], "{reason}");
            assert_eq!(store.messages(conversation).unwrap(), [user("In memory")]);
            drop(store);
            assert_eq!(snapshot(&file), before, "{reason}");
            assert_eq!(
                fs::read_dir(file.parent().unwrap()).unwrap().count(),
                1,
                "{reason}"
            );
        }
    }

    #[test]
    fn without_a_usable_world_path_or_app_data_folder_nothing_is_written() {
        let app_data = tempfile::tempdir().unwrap();
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut stores = vec![(
            Store::open(None, Path::new(WORLD), 1).unwrap(),
            "There is no app data folder to save them in.",
        )];
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            let world = std::ffi::OsStr::from_bytes(b"/home/tester/Worlds/\xff");
            stores.push((
                Store::open(Some(app_data.path()), Path::new(world), 1).unwrap(),
                "The world folder's path is not valid Unicode.",
            ));
        }
        for (mut store, reason) in stores {
            store.add_user_message(None, "Hello", 1).unwrap();

            assert_eq!(
                store.conversations().unwrap(),
                Conversations {
                    items: vec![ConversationSummary {
                        id: 1,
                        title: "Hello".to_owned(),
                        updated: 1
                    }],
                    notice: Some(StoreNotice::NotSaved {
                        reason: reason.to_owned()
                    }),
                }
            );
        }
        assert_eq!(fs::read_dir(app_data.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_that_fails_moves_to_memory_with_earlier_conversations_and_reopening_uses_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let app_data = tempfile::tempdir().unwrap();
        let file = file_of(&app_data);
        let mut store = opened(&app_data);
        let earlier = store.add_user_message(None, "Earlier", 1).unwrap();
        drop(store);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();

        let mut store = opened(&app_data);
        assert_eq!(store.conversations().unwrap().notice, None);
        let later = store.add_user_message(None, "Later", 2).unwrap();

        assert_eq!(
            store.conversations().unwrap().notice,
            Some(StoreNotice::NotSaved {
                reason: "The conversation store cannot be written.".to_owned()
            })
        );
        assert_eq!(titles(&store), ["Later", "Earlier"]);
        assert_eq!(store.messages(earlier).unwrap(), [user("Earlier")]);
        store
            .add_user_message(Some(later), "Still here", 3)
            .unwrap();
        drop(store);

        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let store = opened(&app_data);
        assert_eq!(store.conversations().unwrap().notice, None);
        assert_eq!(titles(&store), ["Earlier"]);
    }

    #[test]
    fn deleting_a_conversation_removes_its_messages_and_pages_and_nothing_else() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let gone = store.add_user_message(None, "Gone", 1).unwrap();
        let pages = [("A.md".to_owned(), false)];
        let answer_with_page = Answer {
            pages: &pages,
            ..answer(AnswerState::Complete, "Hi")
        };
        store.add_answer(gone, &answer_with_page, 2).unwrap();
        let kept = store.add_user_message(None, "Kept", 3).unwrap();
        store.add_answer(kept, &answer_with_page, 4).unwrap();

        store.delete(gone).unwrap();

        assert_eq!(rows_in_file(&app_data), [1, 2, 1]);
        assert_eq!(titles(&store), ["Kept"]);
        assert_eq!(store.delete(gone).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn retry_replaces_a_stopped_answer_accepts_a_missing_one_and_refuses_after_an_answer() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Hello", 1).unwrap();

        assert_eq!(store.prepare_retry(conversation).unwrap(), "Hello");

        store
            .add_answer(conversation, &answer(AnswerState::Stopped, "Hal"), 2)
            .unwrap();
        assert_eq!(store.prepare_retry(conversation).unwrap(), "Hello");
        assert_eq!(store.messages(conversation).unwrap(), [user("Hello")]);

        for state in [AnswerState::Complete, AnswerState::CutOff] {
            store
                .add_answer(conversation, &answer(state, "Hi"), 3)
                .unwrap();
            assert_eq!(
                store.prepare_retry(conversation).unwrap_err().kind,
                ErrorKind::Conflict
            );
            store
                .connection
                .execute("DELETE FROM messages WHERE role = 'assistant'", [])
                .unwrap();
        }
        assert_eq!(
            store.prepare_retry(99).unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            store
                .add_user_message(Some(99), "Lost", 4)
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        // Refusals are not failures: the store still saves to its file.
        assert_eq!(store.conversations().unwrap().notice, None);
    }
}
