//! The conversations of one world, in an SQLite file per world:
//! `<app data dir>/grimoire-data/conversations/<name>.sqlite`, named like the world's history
//! database by `history::file_name`. The file records the world folder's path too, so two paths
//! with the same hash never share their conversations.
//!
//! Format 2, named by `PRAGMA user_version`:
//!
//! - `meta`: one row, the world folder's path.
//! - `conversations`: each conversation's `title`, from its first message, and the times it was
//!   `created` and `updated` by its latest message, in seconds since the Unix epoch.
//! - `messages`: each message of a conversation in order (`id`): its `role` (`user` or
//!   `assistant`), `text` and `time`, and for an answer how it ended (`state`: `complete`,
//!   `stopped` or `cut_off`), how many earlier messages its request `left_out`, whether the
//!   world was still `indexing` as its pages were chosen, how many of its proposals were
//!   `unreadable`, and whether it ended inside one (`unfinished`). An answer's text is its prose
//!   alone; its proposals are kept in their own tables.
//! - `read_pages`: the path of each page an answer's request carried, in the order chosen
//!   (`ordinal`), and whether only part of it was read. Never a page's text.
//! - `accepts`: each set of an answer's proposals that an accept began: the history change it
//!   recorded, named by its id (`change`) and start time (`started`), or none when history was not
//!   recording; its `state` (`writing` until the accept finishes, then `accepted`, and `undoing`
//!   while an undo runs); and the `time` it began. A set is deleted once none of its proposals
//!   stays accepted.
//! - `proposals`: each proposal of an answer in order (`ordinal`): its `kind` (`new_page` or
//!   `edit`), its `path` (as the model gave it until a set begins, then as the accept writes it),
//!   a new page's `text`, an edit's `base` (the FNV-1a hash of its page's text when the answer
//!   ended), the `result` hash of the text its accept writes, its `state` (`pending`, `accepted`
//!   or `rejected`), whether it was `undone`, and the set it belongs to (`accept`).
//! - `proposal_changes`: each passage of an edit, in order: the text to `find` and its
//!   `replace`ment.
//!
//! Hashes are stored as the bits of a signed integer. Format 1 lacked the notes and the proposal
//! tables; a format-1 file is updated in place, in one transaction, when its world opens.
//!
//! Deleting a conversation deletes its messages with their pages, proposals and sets. Each
//! message is written in one transaction, and the file syncs fully, so after a crash a message is
//! there whole or not at all.
//!
//! A damaged file is set aside, as a damaged history database is, and a new one replaces it. A file
//! in a newer format, holding unknown data, or recording another world is left untouched; so is
//! everything when the world's path cannot name a file or there is no app data folder; so is a
//! format-1 file whose update fails. The store then keeps this opening's conversations in memory.
//! A write to the file that fails moves the store to memory too, with what the file held, for the
//! rest of the opening.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::types::{Type, Value};
use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, params, params_from_iter};
use serde::Serialize;

use super::ContextPage;
use crate::data_file;
use crate::error::{AppError, ErrorKind};
use crate::history;

/// The format this version writes. A file in a newer format is never written.
const FORMAT: i64 = 2;

/// The tables of format 1, with the notes format 2 added to `messages` last, where the update from
/// format 1 adds them, so an updated file and a new one have their columns in the same order.
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
        indexing INTEGER,
        unreadable INTEGER NOT NULL DEFAULT 0,
        unfinished INTEGER NOT NULL DEFAULT 0
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
/// The columns format 2 added to `messages` in a format-1 file.
const NOTES: &str = "
    ALTER TABLE messages ADD COLUMN unreadable INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN unfinished INTEGER NOT NULL DEFAULT 0;
";
/// The tables format 2 added, created as they are in a new file and in an updated one.
const PROPOSAL_SCHEMA: &str = "
    CREATE TABLE accepts (
        id INTEGER PRIMARY KEY,
        message INTEGER REFERENCES messages ON DELETE CASCADE,
        change INTEGER,
        started INTEGER,
        state TEXT,
        time INTEGER
    );
    CREATE TABLE proposals (
        id INTEGER PRIMARY KEY,
        message INTEGER REFERENCES messages ON DELETE CASCADE,
        ordinal INTEGER,
        kind TEXT,
        path TEXT,
        text TEXT,
        base INTEGER,
        result INTEGER,
        state TEXT,
        undone INTEGER,
        accept INTEGER REFERENCES accepts ON DELETE SET NULL
    );
    CREATE INDEX proposals_by_message ON proposals (message, ordinal);
    CREATE TABLE proposal_changes (
        proposal INTEGER REFERENCES proposals ON DELETE CASCADE,
        ordinal INTEGER,
        find TEXT,
        replace TEXT,
        PRIMARY KEY (proposal, ordinal)
    );
";
/// The tables that hold conversations, in an order that keeps their references valid.
const TABLES: [&str; 6] = [
    "conversations",
    "messages",
    "read_pages",
    "accepts",
    "proposals",
    "proposal_changes",
];
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
/// how it ended, with one line for each of its proposals that names its kind, its path and what
/// became of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub text: String,
    pub answer: Option<AnswerState>,
    pub proposals: Vec<String>,
}

/// What an answer's request carried, saved with the answer.
pub struct Answer<'a> {
    pub state: AnswerState,
    pub text: &'a str,
    /// Each page's path and whether only part of it was read, in the order chosen.
    pub pages: &'a [(String, bool)],
    pub left_out: u32,
    pub indexing: bool,
    /// The proposals read from the answer, in order.
    pub proposals: &'a [Proposal],
    /// How many proposals could not be read.
    pub unreadable: u32,
    /// Whether the answer ended inside a proposal, which was dropped.
    pub unfinished: bool,
}

/// A proposal as an answer saves it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    /// The path as the model gave it.
    pub path: String,
    pub content: ProposalContent,
}

/// What a proposal writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalContent {
    NewPage {
        text: String,
    },
    /// Passages to replace in an existing page, with the hash of the page's text when the answer
    /// ended, or none when it could not be read.
    Edit {
        passages: Vec<Passage>,
        base: Option<u64>,
    },
}

/// A passage of an edit: text to find in the page and its replacement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Passage {
    pub find: String,
    pub replace: String,
}

/// Where a proposal stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Pending,
    Accepted,
    Rejected,
}

impl ProposalState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "pending" => Some(Self::Pending),
            "accepted" => Some(Self::Accepted),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

/// Where a set of accepted proposals stands. `Writing` and `Undoing` are unfinished: an accept or
/// undo is writing its pages, or stopped before it could finish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetState {
    Writing,
    Accepted,
    Undoing,
}

impl SetState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Writing => "writing",
            Self::Accepted => "accepted",
            Self::Undoing => "undoing",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "writing" => Some(Self::Writing),
            "accepted" => Some(Self::Accepted),
            "undoing" => Some(Self::Undoing),
            _ => None,
        }
    }
}

/// A change in history, by its id and the time it started, which together name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HistoryChange {
    pub id: i64,
    pub started: u64,
}

/// A saved proposal and where it stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedProposal {
    pub id: i64,
    /// The path as the model gave it, or as the accept wrote it once a set began.
    pub path: String,
    pub content: ProposalContent,
    pub state: ProposalState,
    /// It was accepted, and that accept was undone.
    pub undone: bool,
    /// The set it belongs to.
    pub accept: Option<i64>,
}

/// A set of an answer's proposals that an accept began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptSet {
    pub id: i64,
    /// The change the accept recorded, or none when history was not recording.
    pub change: Option<HistoryChange>,
    pub state: SetState,
}

/// An answer's proposals, its notes and its sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerProposals {
    pub answer: i64,
    pub unreadable: u32,
    pub unfinished: bool,
    pub proposals: Vec<SavedProposal>,
    pub sets: Vec<AcceptSet>,
}

/// A proposal's page in a set: the path its accept writes and the hash of the text it writes
/// there, which tell whether the page holds the accepted text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetPage {
    pub proposal: i64,
    pub path: String,
    pub result: u64,
}

/// An unfinished set with its proposals' pages, to be resolved from what the pages hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfinishedSet {
    pub id: i64,
    pub pages: Vec<SetPage>,
}

/// Whether finishing or resolving a set changed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settling {
    Settled,
    /// The set was no longer unfinished, so nothing changed.
    AlreadySettled,
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
    /// An answer, by its id, with the pages its request carried in the order chosen, how many
    /// earlier messages it left out, and whether the world was still being indexed.
    Answer {
        id: i64,
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
    /// The sets an earlier process or opening left unfinished, until they are taken to be resolved.
    unfinished: Vec<UnfinishedSet>,
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
                unfinished: unfinished_sets(&connection).map_err(store_error)?,
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
                    unfinished: Vec::new(),
                })
            }
        }
    }

    /// Takes the sets that were unfinished when the store opened, so they are resolved once. Sets
    /// begun since are never among them.
    pub fn take_unfinished(&mut self) -> Vec<UnfinishedSet> {
        std::mem::take(&mut self.unfinished)
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
    /// message whose answer is missing or stopped, and a stopped answer is removed, unless one of
    /// its proposals belongs to a set, accepted or still being accepted. Returns the message's
    /// text.
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
                    let in_set: bool = transaction.query_row(
                        "SELECT EXISTS (SELECT 1 FROM proposals
                                        WHERE message = ?1 AND accept IS NOT NULL)",
                        [answer],
                        |row| row.get(0),
                    )?;
                    if in_set {
                        return Err(WriteFailure::Refused(AppError::new(
                            ErrorKind::Conflict,
                            "The last answer has accepted proposals.",
                        )));
                    }
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

    /// Saves the answer to `conversation`'s last message, with the pages its request carried and
    /// its proposals, and returns the answer's id.
    pub fn add_answer(
        &mut self,
        conversation: i64,
        answer: &Answer,
        now: i64,
    ) -> Result<i64, AppError> {
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO messages (conversation, role, text, time, state, left_out, indexing,
                                       unreadable, unfinished)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    conversation,
                    ASSISTANT,
                    answer.text,
                    now,
                    answer.state.as_str(),
                    answer.left_out,
                    answer.indexing,
                    answer.unreadable,
                    answer.unfinished
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
            for (ordinal, proposal) in answer.proposals.iter().enumerate() {
                add_proposal(transaction, message, ordinal, proposal)?;
            }
            transaction.execute(
                "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                params![conversation, now],
            )?;
            Ok(message)
        })
    }

    /// Rejects a pending proposal that belongs to no set.
    pub fn reject(&mut self, proposal: i64) -> Result<(), AppError> {
        self.write(|transaction| {
            let standing = proposal_standing(transaction, proposal)?
                .ok_or_else(|| WriteFailure::Refused(no_proposal()))?;
            if !standing.free() {
                return Err(WriteFailure::Refused(not_pending()));
            }
            transaction.execute(
                "UPDATE proposals SET state = ?2 WHERE id = ?1",
                params![proposal, ProposalState::Rejected.as_str()],
            )?;
            Ok(())
        })
    }

    /// Begins a set of `answer`'s proposals for an accept that recorded `change`, before the
    /// accept writes anything: each proposal must be pending and in no set, and takes the path
    /// the accept writes and the hash of the text it writes there. Returns the set's id.
    pub fn begin_accept(
        &mut self,
        answer: i64,
        pages: &[SetPage],
        change: Option<HistoryChange>,
        now: i64,
    ) -> Result<i64, AppError> {
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO accepts (message, change, started, state, time)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    answer,
                    change.map(|change| change.id),
                    change.map(|change| change.started as i64),
                    SetState::Writing.as_str(),
                    now
                ],
            )?;
            let set = transaction.last_insert_rowid();
            for page in pages {
                let standing = proposal_standing(transaction, page.proposal)?
                    .filter(|standing| standing.answer == answer)
                    .ok_or_else(|| WriteFailure::Refused(no_proposal()))?;
                if !standing.free() {
                    return Err(WriteFailure::Refused(not_pending()));
                }
                transaction.execute(
                    "UPDATE proposals SET accept = ?2, path = ?3, result = ?4 WHERE id = ?1",
                    params![page.proposal, set, page.path, hash_value(page.result)],
                )?;
            }
            Ok(set)
        })
    }

    /// Marks an accepted set as being undone, before the undo writes anything, and returns its
    /// accepted proposals' pages.
    pub fn begin_undo(&mut self, set: i64) -> Result<UnfinishedSet, AppError> {
        self.write(|transaction| {
            let state: SetState = transaction
                .query_row("SELECT state FROM accepts WHERE id = ?1", [set], |row| {
                    stored(row, 0, SetState::parse)
                })
                .optional()?
                .ok_or_else(|| WriteFailure::Refused(no_set()))?;
            if state != SetState::Accepted {
                return Err(WriteFailure::Refused(AppError::new(
                    ErrorKind::Conflict,
                    "The proposals are no longer accepted.",
                )));
            }
            transaction.execute(
                "UPDATE accepts SET state = ?2 WHERE id = ?1",
                params![set, SetState::Undoing.as_str()],
            )?;
            Ok(UnfinishedSet {
                id: set,
                pages: set_pages(transaction, set)?,
            })
        })
    }

    /// Settles an unfinished set: its proposals in `accepted` become accepted, and the rest of
    /// its proposals pending and in no set, marked undone when the set was being undone. The set
    /// stays, accepted, while any of its proposals does; otherwise it is deleted. This finishes an
    /// accept with the proposals it wrote, an undo with none, and resolves a set left unfinished
    /// with the proposals whose pages hold their results. A set that is no longer unfinished is
    /// left as it is.
    pub fn settle(&mut self, set: i64, accepted: &[i64]) -> Result<Settling, AppError> {
        self.write(|transaction| {
            let state = transaction
                .query_row("SELECT state FROM accepts WHERE id = ?1", [set], |row| {
                    stored(row, 0, SetState::parse)
                })
                .optional()?;
            let undoing = match state {
                Some(SetState::Writing) => false,
                Some(SetState::Undoing) => true,
                Some(SetState::Accepted) | None => return Ok(Settling::AlreadySettled),
            };
            transaction.execute(
                "UPDATE proposals SET state = ?2, undone = undone OR ?3 WHERE accept = ?1",
                params![set, ProposalState::Pending.as_str(), undoing],
            )?;
            let mut kept = 0;
            for proposal in accepted {
                kept += transaction.execute(
                    "UPDATE proposals SET state = ?3, undone = 0 WHERE id = ?1 AND accept = ?2",
                    params![proposal, set, ProposalState::Accepted.as_str()],
                )?;
            }
            transaction.execute(
                "UPDATE proposals SET accept = NULL WHERE accept = ?1 AND state = ?2",
                params![set, ProposalState::Pending.as_str()],
            )?;
            if kept == 0 {
                transaction.execute("DELETE FROM accepts WHERE id = ?1", [set])?;
            } else {
                transaction.execute(
                    "UPDATE accepts SET state = ?2 WHERE id = ?1",
                    params![set, SetState::Accepted.as_str()],
                )?;
            }
            Ok(Settling::Settled)
        })
    }

    /// Deletes `conversation` with its messages and their pages, proposals and sets, for good.
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
        self.read_messages(conversation).map_err(store_error)
    }

    fn read_messages(&self, conversation: i64) -> rusqlite::Result<Vec<Message>> {
        let mut proposals = self.connection.prepare(
            "SELECT kind, path, state, undone FROM proposals WHERE message = ?1 ORDER BY ordinal",
        )?;
        let mut statement = self
            .connection
            .prepare("SELECT id, text, state FROM messages WHERE conversation = ?1 ORDER BY id")?;
        let mut rows = statement.query([conversation])?;
        let mut messages = Vec::new();
        while let Some(row) = rows.next()? {
            let state: Option<String> = row.get(2)?;
            messages.push(Message {
                text: row.get(1)?,
                answer: state.as_deref().and_then(AnswerState::parse),
                proposals: proposals
                    .query_map([row.get::<_, i64>(0)?], |proposal| {
                        Ok(summary(
                            stored(proposal, 0, Kind::parse)?,
                            &proposal.get::<_, String>(1)?,
                            stored(proposal, 2, ProposalState::parse)?,
                            proposal.get(3)?,
                        ))
                    })?
                    .collect::<Result<_, _>>()?,
            });
        }
        Ok(messages)
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

    /// The proposals, notes and sets of the answer `answer`.
    pub fn answer_proposals(&self, answer: i64) -> Result<AnswerProposals, AppError> {
        let conversation: Option<i64> = self
            .connection
            .query_row(
                "SELECT conversation FROM messages WHERE id = ?1 AND role = ?2",
                params![answer, ASSISTANT],
                |row| row.get(0),
            )
            .optional()
            .map_err(store_error)?;
        let answers = match conversation {
            Some(conversation) => self.proposals(conversation)?,
            None => Vec::new(),
        };
        answers
            .into_iter()
            .find(|proposals| proposals.answer == answer)
            .ok_or_else(no_proposal)
    }

    /// The set `set`.
    pub fn accept_set(&self, set: i64) -> Result<AcceptSet, AppError> {
        self.connection
            .query_row(
                "SELECT change, started, state FROM accepts WHERE id = ?1",
                [set],
                |row| {
                    Ok(AcceptSet {
                        id: set,
                        change: history_change(row.get(0)?, row.get(1)?),
                        state: stored(row, 2, SetState::parse)?,
                    })
                },
            )
            .optional()
            .map_err(store_error)?
            .ok_or_else(no_set)
    }

    /// The answers of `conversation` that have proposals or notes, in order, each with its
    /// proposals and sets.
    pub fn proposals(&self, conversation: i64) -> Result<Vec<AnswerProposals>, AppError> {
        self.read_proposals(conversation)
            .map_err(store_error)?
            .ok_or_else(no_conversation)
    }

    fn read_proposals(&self, conversation: i64) -> rusqlite::Result<Option<Vec<AnswerProposals>>> {
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM conversations WHERE id = ?1)",
            [conversation],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let mut answers = self.connection.prepare(
            "SELECT id, unreadable, unfinished FROM messages
             WHERE conversation = ?1 AND role = ?2
               AND (unreadable > 0 OR unfinished
                    OR EXISTS (SELECT 1 FROM proposals WHERE message = messages.id))
             ORDER BY id",
        )?;
        let mut proposals = self.connection.prepare(
            "SELECT id, kind, path, text, base, state, undone, accept FROM proposals
             WHERE message = ?1 ORDER BY ordinal",
        )?;
        let mut passages = self.connection.prepare(
            "SELECT find, replace FROM proposal_changes WHERE proposal = ?1 ORDER BY ordinal",
        )?;
        let mut sets = self.connection.prepare(
            "SELECT id, change, started, state FROM accepts WHERE message = ?1 ORDER BY id",
        )?;
        let mut rows = answers.query(params![conversation, ASSISTANT])?;
        let mut read = Vec::new();
        while let Some(row) = rows.next()? {
            let answer: i64 = row.get(0)?;
            let mut answer_proposals = Vec::new();
            let mut proposal_rows = proposals.query([answer])?;
            while let Some(proposal) = proposal_rows.next()? {
                let id: i64 = proposal.get(0)?;
                let content = match stored(proposal, 1, Kind::parse)? {
                    Kind::NewPage => ProposalContent::NewPage {
                        text: proposal.get(3)?,
                    },
                    Kind::Edit => ProposalContent::Edit {
                        passages: passages
                            .query_map([id], |passage| {
                                Ok(Passage {
                                    find: passage.get(0)?,
                                    replace: passage.get(1)?,
                                })
                            })?
                            .collect::<Result<_, _>>()?,
                        base: proposal.get::<_, Option<i64>>(4)?.map(hash_of),
                    },
                };
                answer_proposals.push(SavedProposal {
                    id,
                    path: proposal.get(2)?,
                    content,
                    state: stored(proposal, 5, ProposalState::parse)?,
                    undone: proposal.get(6)?,
                    accept: proposal.get(7)?,
                });
            }
            let answer_sets = sets
                .query_map([answer], |set| {
                    Ok(AcceptSet {
                        id: set.get(0)?,
                        change: history_change(set.get(1)?, set.get(2)?),
                        state: stored(set, 3, SetState::parse)?,
                    })
                })?
                .collect::<Result<_, _>>()?;
            read.push(AnswerProposals {
                answer,
                unreadable: row.get(1)?,
                unfinished: row.get(2)?,
                proposals: answer_proposals,
                sets: answer_sets,
            });
        }
        Ok(Some(read))
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
                    id: row.get(0)?,
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

/// Opens the file at `file` for the world at `world`, creating the format in an empty one and
/// updating a format-1 file. On any refusal the connection is closed before this returns.
fn connect(file: &Path, world: &str) -> Result<Connection, Refusal> {
    let mut connection = Connection::open(file)?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    // Reading the format is the first read of the file, so it finds a damaged one.
    let format: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    match format {
        0 => create(&mut connection, world)?,
        1 => {
            check_world(&connection, world)?;
            update_from_format_1(&mut connection)?;
        }
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

/// Creates the format in one transaction, in a file that holds nothing yet.
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
    transaction.execute_batch(PROPOSAL_SCHEMA)?;
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

/// Updates a format-1 file to the format in one transaction, so a failure leaves it format 1.
fn update_from_format_1(connection: &mut Connection) -> Result<(), Refusal> {
    let update = |connection: &mut Connection| -> rusqlite::Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute_batch(NOTES)?;
        transaction.execute_batch(PROPOSAL_SCHEMA)?;
        transaction.pragma_update(None, "user_version", FORMAT)?;
        transaction.commit()
    };
    update(connection).map_err(|error| {
        Refusal::Failed(format!(
            "The conversation store could not be updated to this version's format. {}",
            failure_reason(&error)
        ))
    })
}

/// An empty store in memory.
fn memory_database() -> rusqlite::Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.execute_batch(SCHEMA)?;
    connection.execute_batch(PROPOSAL_SCHEMA)?;
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

/// Saves `proposal` as the `ordinal`th of the answer `message`, with its passages.
fn add_proposal(
    transaction: &Transaction,
    message: i64,
    ordinal: usize,
    proposal: &Proposal,
) -> rusqlite::Result<()> {
    let (kind, text, base, passages) = match &proposal.content {
        ProposalContent::NewPage { text } => (Kind::NewPage, Some(text), None, &[][..]),
        ProposalContent::Edit { passages, base } => {
            (Kind::Edit, None, base.map(hash_value), passages.as_slice())
        }
    };
    transaction.execute(
        "INSERT INTO proposals (message, ordinal, kind, path, text, base, state, undone)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![
            message,
            ordinal as i64,
            kind.as_str(),
            proposal.path,
            text,
            base,
            ProposalState::Pending.as_str()
        ],
    )?;
    let proposal = transaction.last_insert_rowid();
    for (ordinal, passage) in passages.iter().enumerate() {
        transaction.execute(
            "INSERT INTO proposal_changes (proposal, ordinal, find, replace)
             VALUES (?1, ?2, ?3, ?4)",
            params![proposal, ordinal as i64, passage.find, passage.replace],
        )?;
    }
    Ok(())
}

/// A proposal's kind, as it is stored.
#[derive(Clone, Copy)]
enum Kind {
    NewPage,
    Edit,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::NewPage => "new_page",
            Self::Edit => "edit",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "new_page" => Some(Self::NewPage),
            "edit" => Some(Self::Edit),
            _ => None,
        }
    }
}

/// The answer a proposal belongs to, its state and its set.
struct Standing {
    answer: i64,
    state: ProposalState,
    accept: Option<i64>,
}

impl Standing {
    /// Pending and in no set, so it can be rejected or accepted.
    fn free(&self) -> bool {
        self.state == ProposalState::Pending && self.accept.is_none()
    }
}

fn proposal_standing(
    transaction: &Transaction,
    proposal: i64,
) -> rusqlite::Result<Option<Standing>> {
    transaction
        .query_row(
            "SELECT message, state, accept FROM proposals WHERE id = ?1",
            [proposal],
            |row| {
                Ok(Standing {
                    answer: row.get(0)?,
                    state: stored(row, 1, ProposalState::parse)?,
                    accept: row.get(2)?,
                })
            },
        )
        .optional()
}

/// The pages of the proposals in `set` that are accepted or being accepted.
fn set_pages(connection: &Connection, set: i64) -> rusqlite::Result<Vec<SetPage>> {
    connection
        .prepare("SELECT id, path, result FROM proposals WHERE accept = ?1 ORDER BY id")?
        .query_map([set], |row| {
            Ok(SetPage {
                proposal: row.get(0)?,
                path: row.get(1)?,
                result: hash_of(row.get(2)?),
            })
        })?
        .collect()
}

/// The sets that are unfinished, with their proposals' pages.
fn unfinished_sets(connection: &Connection) -> rusqlite::Result<Vec<UnfinishedSet>> {
    let ids: Vec<i64> = connection
        .prepare("SELECT id FROM accepts WHERE state IN (?1, ?2) ORDER BY id")?
        .query_map(
            [SetState::Writing.as_str(), SetState::Undoing.as_str()],
            |row| row.get(0),
        )?
        .collect::<Result<_, _>>()?;
    ids.into_iter()
        .map(|id| {
            Ok(UnfinishedSet {
                id,
                pages: set_pages(connection, id)?,
            })
        })
        .collect()
}

/// The value in `column` of `row`, read as text by `parse`.
fn stored<T>(
    row: &rusqlite::Row,
    column: usize,
    parse: impl Fn(&str) -> Option<T>,
) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    parse(&text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            Type::Text,
            format!("unknown value {text:?}").into(),
        )
    })
}

/// The history change stored as its id and start time, when there is one.
fn history_change(id: Option<i64>, started: Option<i64>) -> Option<HistoryChange> {
    id.zip(started).map(|(id, started)| HistoryChange {
        id,
        started: started as u64,
    })
}

/// The line a request carries for a proposal: its kind, its path and what became of it.
fn summary(kind: Kind, path: &str, state: ProposalState, undone: bool) -> String {
    let kind = match kind {
        Kind::NewPage => "new page",
        Kind::Edit => "edit of",
    };
    let outcome = match (state, undone) {
        (ProposalState::Pending, false) => "pending",
        (ProposalState::Pending, true) => "undone",
        (ProposalState::Accepted, _) => "accepted",
        (ProposalState::Rejected, _) => "rejected",
    };
    format!("[Proposed {kind} \"{path}\": {outcome}]")
}

/// A hash as it is stored: its bits as a signed integer, since SQLite has no unsigned one.
fn hash_value(hash: u64) -> i64 {
    hash as i64
}

fn hash_of(value: i64) -> u64 {
    value as u64
}

/// A conversation's title: its first message's first line, cut to `TITLE_LIMIT` characters.
fn title(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or_default();
    line.chars().take(TITLE_LIMIT).collect()
}

fn no_conversation() -> AppError {
    AppError::new(ErrorKind::NotFound, "The conversation does not exist.")
}

fn no_proposal() -> AppError {
    AppError::new(ErrorKind::NotFound, "The proposal does not exist.")
}

fn not_pending() -> AppError {
    AppError::new(ErrorKind::Conflict, "The proposal is no longer pending.")
}

fn no_set() -> AppError {
    AppError::new(ErrorKind::NotFound, "The accepted proposals do not exist.")
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
            proposals: Vec::new(),
        }
    }

    fn answer(state: AnswerState, text: &'static str) -> Answer<'static> {
        Answer {
            state,
            text,
            pages: &[],
            left_out: 0,
            indexing: false,
            proposals: &[],
            unreadable: 0,
            unfinished: false,
        }
    }

    fn titles(store: &Store) -> Vec<String> {
        let listed = store.conversations().unwrap().items;
        listed.into_iter().map(|item| item.title).collect()
    }

    /// The number of rows in each of format 1's tables in the world's file, read with a connection
    /// of its own.
    fn rows_in_file(app_data: &TempDir) -> [i64; 3] {
        let connection = Connection::open(file_of(app_data)).unwrap();
        ["conversations", "messages", "read_pages"].map(|table| {
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
        let answer = store
            .add_answer(
                first,
                &Answer {
                    state: AnswerState::CutOff,
                    text: "Long",
                    pages: &pages,
                    left_out: 2,
                    indexing: true,
                    proposals: &[],
                    unreadable: 0,
                    unfinished: false,
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
                        id: answer,
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
        assert_eq!((format, world.as_str()), (2, WORLD));
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
                    proposals: &[],
                    unreadable: 0,
                    unfinished: false,
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
                    answer: Some(AnswerState::Complete),
                    proposals: Vec::new(),
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
                "PRAGMA user_version = 3;",
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
    fn deleting_a_conversation_removes_its_messages_pages_proposals_and_sets_and_nothing_else() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let gone = store.add_user_message(None, "Gone", 1).unwrap();
        let pages = [("A.md".to_owned(), false)];
        let gone_proposals = [new_page("Gone.md"), edit("A.md")];
        let gone_answer = store
            .add_answer(
                gone,
                &Answer {
                    pages: &pages,
                    proposals: &gone_proposals,
                    ..answer(AnswerState::Complete, "Hi")
                },
                2,
            )
            .unwrap();
        let ids = proposal_ids(&store, gone);
        store
            .begin_accept(gone_answer, &pages_of(&ids), None, 2)
            .unwrap();
        let kept = store.add_user_message(None, "Kept", 3).unwrap();
        let kept_proposals = [new_page("Kept.md")];
        store
            .add_answer(
                kept,
                &Answer {
                    pages: &pages,
                    proposals: &kept_proposals,
                    ..answer(AnswerState::Complete, "Hi")
                },
                4,
            )
            .unwrap();

        store.delete(gone).unwrap();

        assert_eq!(rows_in_file(&app_data), [1, 2, 1]);
        assert_eq!(proposal_rows_in_file(&app_data), [0, 1, 0]);
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

    /// A format-1 file as the previous version wrote it, with two conversations, their answers and
    /// the pages they read.
    const FORMAT_1: &str = "
        CREATE TABLE meta (world TEXT NOT NULL);
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
        INSERT INTO meta (world) VALUES ('/home/tester/Worlds/Kesh');
        INSERT INTO conversations VALUES (1, 'Saltmere', 10, 30), (2, 'Kesh', 40, 60);
        INSERT INTO messages VALUES
            (1, 1, 'user', 'Saltmere', 10, NULL, NULL, NULL),
            (2, 1, 'assistant', 'A harbour town.', 30, 'complete', 1, 0),
            (3, 2, 'user', 'Kesh', 40, NULL, NULL, NULL),
            (4, 2, 'assistant', 'A city', 60, 'cut_off', 0, 1);
        INSERT INTO read_pages VALUES
            (2, 0, 'Places/Saltmere.md', 0),
            (2, 1, 'People/Ada.md', 1),
            (4, 0, 'Kesh.md', 0);
        PRAGMA user_version = 1;
    ";

    /// Writes the format-1 file, followed by `extra`, as the world's file.
    fn write_format_1(app_data: &TempDir, extra: &str) -> PathBuf {
        let file = file_of(app_data);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let connection = Connection::open(&file).unwrap();
        connection.execute_batch(FORMAT_1).unwrap();
        connection.execute_batch(extra).unwrap();
        file
    }

    /// Every row the query reads, as values.
    fn rows(connection: &Connection, query: &str) -> Vec<Vec<Value>> {
        let mut statement = connection.prepare(query).unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns).map(|column| row.get(column)).collect()
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// Each table's column names, in order.
    fn columns(file: &Path) -> Vec<Vec<String>> {
        let connection = Connection::open(file).unwrap();
        TABLES
            .iter()
            .map(|table| {
                rows(&connection, &format!("PRAGMA table_info({table})"))
                    .into_iter()
                    .map(|row| match &row[1] {
                        Value::Text(name) => name.clone(),
                        other => panic!("a column name is text, not {other:?}"),
                    })
                    .collect()
            })
            .collect()
    }

    /// The format-1 tables' rows, in the columns format 1 has.
    const FORMAT_1_ROWS: [&str; 3] = [
        "SELECT * FROM conversations ORDER BY id",
        "SELECT id, conversation, role, text, time, state, left_out, indexing FROM messages
         ORDER BY id",
        "SELECT * FROM read_pages ORDER BY message, ordinal",
    ];

    /// The number of rows in each table format 2 added, in the world's file.
    fn proposal_rows_in_file(app_data: &TempDir) -> [i64; 3] {
        let connection = Connection::open(file_of(app_data)).unwrap();
        ["accepts", "proposals", "proposal_changes"].map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
    }

    fn new_page(path: &str) -> Proposal {
        Proposal {
            path: path.to_owned(),
            content: ProposalContent::NewPage {
                text: format!("# {path}\n"),
            },
        }
    }

    fn edit(path: &str) -> Proposal {
        Proposal {
            path: path.to_owned(),
            content: ProposalContent::Edit {
                passages: vec![
                    Passage {
                        find: "old".to_owned(),
                        replace: "new".to_owned(),
                    },
                    Passage {
                        find: "grey".to_owned(),
                        replace: "green".to_owned(),
                    },
                ],
                // A hash with its high bit set, which SQLite stores as a negative integer.
                base: Some(u64::MAX - 1),
            },
        }
    }

    /// A conversation whose stopped answer proposes the pages `A.md`, `B.md` and `C.md`: its id,
    /// the answer's id and the proposals' ids.
    fn with_proposals(store: &mut Store) -> (i64, i64, [i64; 3]) {
        let conversation = store.add_user_message(None, "Propose", 1).unwrap();
        let proposals = [new_page("A.md"), new_page("B.md"), edit("C.md")];
        let answer = store
            .add_answer(
                conversation,
                &Answer {
                    proposals: &proposals,
                    ..answer(AnswerState::Stopped, "Here")
                },
                2,
            )
            .unwrap();
        let ids = proposal_ids(store, conversation);
        (conversation, answer, [ids[0], ids[1], ids[2]])
    }

    fn proposal_ids(store: &Store, conversation: i64) -> Vec<i64> {
        store.proposals(conversation).unwrap()[0]
            .proposals
            .iter()
            .map(|proposal| proposal.id)
            .collect()
    }

    /// The pages an accept of `proposals` writes: each at a path of its own, with a result hash
    /// whose high bit is set.
    fn pages_of(proposals: &[i64]) -> Vec<SetPage> {
        proposals
            .iter()
            .map(|&proposal| SetPage {
                proposal,
                path: format!("Written/{proposal}.md"),
                result: u64::MAX - proposal as u64,
            })
            .collect()
    }

    /// Each proposal of the conversation's first answer with proposals: its state, whether it was
    /// undone and its set.
    fn standing(store: &Store, conversation: i64) -> Vec<(ProposalState, bool, Option<i64>)> {
        store.proposals(conversation).unwrap()[0]
            .proposals
            .iter()
            .map(|proposal| (proposal.state, proposal.undone, proposal.accept))
            .collect()
    }

    fn sets(store: &Store, conversation: i64) -> Vec<(i64, SetState)> {
        store.proposals(conversation).unwrap()[0]
            .sets
            .iter()
            .map(|set| (set.id, set.state))
            .collect()
    }

    use ProposalState::{Accepted, Pending, Rejected};

    #[test]
    fn a_format_1_file_is_updated_in_place_keeping_every_row() {
        let app_data = tempfile::tempdir().unwrap();
        let file = write_format_1(&app_data, "");
        let connection = Connection::open(&file).unwrap();
        let before = FORMAT_1_ROWS.map(|query| rows(&connection, query));
        drop(connection);

        let store = opened(&app_data);

        assert_eq!(store.conversations().unwrap().notice, None);
        assert_eq!(titles(&store), ["Kesh", "Saltmere"]);
        drop(store);
        let connection = Connection::open(&file).unwrap();
        assert_eq!(FORMAT_1_ROWS.map(|query| rows(&connection, query)), before);
        assert_eq!(
            rows(&connection, "SELECT unreadable, unfinished FROM messages"),
            vec![vec![Value::Integer(0), Value::Integer(0)]; 4]
        );
        let format: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(format, 2);
        // A move to memory copies the columns in order, so they must match a new file's.
        let new = tempfile::tempdir().unwrap();
        drop(opened(&new));
        assert_eq!(columns(&file), columns(&file_of(&new)));
    }

    #[test]
    fn a_format_1_file_whose_update_fails_is_left_as_it_was_and_the_store_works_in_memory() {
        let app_data = tempfile::tempdir().unwrap();
        // A table in the way of the update, which fails after the notes were added.
        let file = write_format_1(&app_data, "CREATE TABLE accepts (id INTEGER);");
        let before = fs::read(&file).unwrap();

        let mut store = opened(&app_data);
        store.add_user_message(None, "In memory", 1).unwrap();

        let Some(StoreNotice::NotSaved { reason }) = store.conversations().unwrap().notice else {
            panic!("the store is not saved");
        };
        assert!(
            reason.starts_with(
                "The conversation store could not be updated to this version's format."
            ),
            "{reason}"
        );
        assert_eq!(titles(&store), ["In memory"]);
        drop(store);
        assert_eq!(fs::read(&file).unwrap(), before);
    }

    #[test]
    fn an_answer_keeps_its_proposals_passages_and_notes_across_reopening() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Propose", 1).unwrap();
        store
            .add_answer(conversation, &answer(AnswerState::Complete, "Plain"), 2)
            .unwrap();
        store
            .add_user_message(Some(conversation), "Again", 3)
            .unwrap();
        let proposals = [new_page("Places/Saltmere"), edit("People/Ada.md")];
        let answer_id = store
            .add_answer(
                conversation,
                &Answer {
                    proposals: &proposals,
                    unreadable: 2,
                    unfinished: true,
                    ..answer(AnswerState::Stopped, "Prose")
                },
                4,
            )
            .unwrap();
        drop(store);

        let store = opened(&app_data);

        let read = store.proposals(conversation).unwrap();
        let ids: Vec<i64> = read[0]
            .proposals
            .iter()
            .map(|proposal| proposal.id)
            .collect();
        assert_eq!(
            read,
            [AnswerProposals {
                answer: answer_id,
                unreadable: 2,
                unfinished: true,
                proposals: proposals
                    .into_iter()
                    .zip(ids)
                    .map(|(proposal, id)| SavedProposal {
                        id,
                        path: proposal.path,
                        content: proposal.content,
                        state: Pending,
                        undone: false,
                        accept: None,
                    })
                    .collect(),
                sets: vec![],
            }],
            "only the answer with proposals or notes is listed"
        );
        let Some(SavedMessage::Answer { text, .. }) =
            store.conversation(conversation).unwrap().messages.pop()
        else {
            panic!("the last message is the answer");
        };
        assert_eq!(text, "Prose");
        assert_eq!(store.proposals(99).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn finishing_an_accept_keeps_the_written_proposals_and_frees_the_rest() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (conversation, answer, [a, b, _]) = with_proposals(&mut store);
        let change = HistoryChange {
            id: 7,
            started: 1_700_000_000,
        };

        let set = store
            .begin_accept(answer, &pages_of(&[a, b]), Some(change), 5)
            .unwrap();

        assert_eq!(
            standing(&store, conversation),
            [
                (Pending, false, Some(set)),
                (Pending, false, Some(set)),
                (Pending, false, None)
            ]
        );
        let read = store.proposals(conversation).unwrap();
        assert_eq!(
            read[0].sets,
            [AcceptSet {
                id: set,
                change: Some(change),
                state: SetState::Writing
            }]
        );
        assert_eq!(read[0].proposals[0].path, format!("Written/{a}.md"));

        assert_eq!(store.settle(set, &[a]).unwrap(), Settling::Settled);
        let finished = [
            (Accepted, false, Some(set)),
            (Pending, false, None),
            (Pending, false, None),
        ];
        assert_eq!(standing(&store, conversation), finished);
        assert_eq!(sets(&store, conversation), [(set, SetState::Accepted)]);

        assert_eq!(store.settle(set, &[b]).unwrap(), Settling::AlreadySettled);
        assert_eq!(standing(&store, conversation), finished);

        // A set with nothing written is deleted.
        let empty = store
            .begin_accept(answer, &pages_of(&[b]), None, 6)
            .unwrap();
        assert_eq!(store.settle(empty, &[]).unwrap(), Settling::Settled);
        assert_eq!(standing(&store, conversation), finished);
        assert_eq!(sets(&store, conversation), [(set, SetState::Accepted)]);
        assert_eq!(store.settle(empty, &[]).unwrap(), Settling::AlreadySettled);
    }

    #[test]
    fn an_undo_marks_its_set_and_settling_returns_the_proposals_as_undone() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (conversation, answer, [a, b, _]) = with_proposals(&mut store);
        let set = store
            .begin_accept(answer, &pages_of(&[a, b]), None, 5)
            .unwrap();
        store.settle(set, &[a, b]).unwrap();

        assert_eq!(
            store.begin_undo(set).unwrap(),
            UnfinishedSet {
                id: set,
                pages: pages_of(&[a, b])
            }
        );
        assert_eq!(sets(&store, conversation), [(set, SetState::Undoing)]);

        // Resolved after an undo that restored only `b`'s page.
        assert_eq!(store.settle(set, &[a]).unwrap(), Settling::Settled);
        assert_eq!(
            standing(&store, conversation)[..2],
            [(Accepted, false, Some(set)), (Pending, true, None)]
        );
        assert_eq!(sets(&store, conversation), [(set, SetState::Accepted)]);

        store.begin_undo(set).unwrap();
        assert_eq!(store.settle(set, &[]).unwrap(), Settling::Settled);
        assert_eq!(
            standing(&store, conversation)[..2],
            [(Pending, true, None), (Pending, true, None)]
        );
        assert_eq!(sets(&store, conversation), []);
        assert_eq!(store.settle(set, &[]).unwrap(), Settling::AlreadySettled);

        // Accepted again, a proposal is no longer marked undone.
        let again = store
            .begin_accept(answer, &pages_of(&[a]), None, 6)
            .unwrap();
        store.settle(again, &[a]).unwrap();
        assert_eq!(
            standing(&store, conversation)[0],
            (Accepted, false, Some(again))
        );
    }

    #[test]
    fn rejecting_beginning_and_undoing_refuse_proposals_and_sets_in_the_wrong_state() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (conversation, answer, [a, b, _]) = with_proposals(&mut store);
        let (_, _, [other, ..]) = with_proposals(&mut store);
        fn kind<T>(result: Result<T, AppError>) -> ErrorKind {
            result.err().expect("the store refuses").kind
        }

        store.reject(a).unwrap();
        assert_eq!(standing(&store, conversation)[0], (Rejected, false, None));
        assert_eq!(kind(store.reject(a)), ErrorKind::Conflict);
        assert_eq!(kind(store.reject(999)), ErrorKind::NotFound);
        assert_eq!(
            kind(store.begin_accept(answer, &pages_of(&[b, a]), None, 3)),
            ErrorKind::Conflict
        );
        assert_eq!(
            kind(store.begin_accept(answer, &pages_of(&[other]), None, 3)),
            ErrorKind::NotFound
        );
        // A refused set leaves nothing behind.
        assert_eq!(sets(&store, conversation), []);
        assert_eq!(standing(&store, conversation)[1], (Pending, false, None));

        let set = store
            .begin_accept(answer, &pages_of(&[b]), None, 4)
            .unwrap();
        assert_eq!(kind(store.reject(b)), ErrorKind::Conflict);
        assert_eq!(
            kind(store.begin_accept(answer, &pages_of(&[b]), None, 5)),
            ErrorKind::Conflict
        );
        assert_eq!(kind(store.begin_undo(set)), ErrorKind::Conflict);
        assert_eq!(kind(store.begin_undo(999)), ErrorKind::NotFound);
        store.settle(set, &[b]).unwrap();
        assert_eq!(kind(store.reject(b)), ErrorKind::Conflict);
        store.begin_undo(set).unwrap();
        assert_eq!(kind(store.begin_undo(set)), ErrorKind::Conflict);
        // Refusals are not failures: the store still saves to its file.
        assert_eq!(store.conversations().unwrap().notice, None);
    }

    #[test]
    fn the_sets_left_unfinished_are_listed_once_when_the_store_opens() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (_, answer, [a, b, c]) = with_proposals(&mut store);
        let writing = store
            .begin_accept(answer, &pages_of(&[a]), None, 3)
            .unwrap();
        let undoing = store
            .begin_accept(answer, &pages_of(&[b]), None, 4)
            .unwrap();
        store.settle(undoing, &[b]).unwrap();
        store.begin_undo(undoing).unwrap();
        assert_eq!(store.take_unfinished(), []);
        drop(store);

        let mut store = opened(&app_data);
        store
            .begin_accept(answer, &pages_of(&[c]), None, 5)
            .unwrap();

        assert_eq!(
            store.take_unfinished(),
            [
                UnfinishedSet {
                    id: writing,
                    pages: pages_of(&[a])
                },
                UnfinishedSet {
                    id: undoing,
                    pages: pages_of(&[b])
                }
            ]
        );
        assert_eq!(store.take_unfinished(), []);
    }

    #[test]
    fn a_failed_write_moves_proposals_and_sets_to_memory_from_a_new_or_an_updated_file() {
        for format_1 in [false, true] {
            let app_data = tempfile::tempdir().unwrap();
            if format_1 {
                write_format_1(&app_data, "");
            }
            let mut store = opened(&app_data);
            let (conversation, answer, [a, b, c]) = with_proposals(&mut store);
            let accepted = store
                .begin_accept(
                    answer,
                    &pages_of(&[a]),
                    Some(HistoryChange { id: 3, started: 9 }),
                    3,
                )
                .unwrap();
            store.settle(accepted, &[a]).unwrap();
            store
                .begin_accept(answer, &pages_of(&[b]), None, 4)
                .unwrap();
            store.reject(c).unwrap();
            let before = store.proposals(conversation).unwrap();
            let earlier = titles(&store);
            store
                .connection
                .execute_batch(
                    "CREATE TRIGGER fail BEFORE INSERT ON messages WHEN NEW.text = 'Fails'
                     BEGIN SELECT RAISE(ABORT, 'injected'); END;",
                )
                .unwrap();

            store
                .add_user_message(Some(conversation), "Fails", 5)
                .unwrap();

            assert!(
                matches!(
                    store.conversations().unwrap().notice,
                    Some(StoreNotice::NotSaved { .. })
                ),
                "format 1: {format_1}"
            );
            assert_eq!(
                store.proposals(conversation).unwrap(),
                before,
                "format 1: {format_1}"
            );
            assert_eq!(titles(&store), earlier, "format 1: {format_1}");
            assert_eq!(
                store.messages(conversation).unwrap().last(),
                Some(&user("Fails"))
            );
        }
    }

    #[test]
    fn retry_is_refused_while_a_proposal_of_the_stopped_answer_belongs_to_a_set() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (conversation, answer, [a, ..]) = with_proposals(&mut store);
        let set = store
            .begin_accept(answer, &pages_of(&[a]), None, 3)
            .unwrap();

        assert_eq!(
            store.prepare_retry(conversation).unwrap_err().kind,
            ErrorKind::Conflict,
            "while the accept runs"
        );
        store.settle(set, &[a]).unwrap();
        assert_eq!(
            store.prepare_retry(conversation).unwrap_err().kind,
            ErrorKind::Conflict,
            "once accepted"
        );

        store.begin_undo(set).unwrap();
        store.settle(set, &[]).unwrap();
        assert_eq!(store.prepare_retry(conversation).unwrap(), "Propose");
        assert_eq!(store.messages(conversation).unwrap(), [user("Propose")]);
        assert_eq!(proposal_rows_in_file(&app_data), [0, 0, 0]);
    }
}
