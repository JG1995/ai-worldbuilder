//! The conversations of one world session, in an SQLite database. For now it is kept in memory; its
//! schema is the one a world's conversation file will hold. Each write is one transaction.

use rusqlite::{Connection, params};

use crate::error::{AppError, ErrorKind};

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
        left_out INTEGER
    );
    CREATE TABLE read_pages (
        message INTEGER REFERENCES messages ON DELETE CASCADE,
        ordinal INTEGER,
        path TEXT,
        partial INTEGER,
        PRIMARY KEY (message, ordinal)
    );
";
/// The most characters of a conversation's title, from its first message's first line.
const TITLE_LIMIT: usize = 60;

const USER: &str = "user";
const ASSISTANT: &str = "assistant";

/// How an answer ended, as it is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// A stored message: a user message (`answer` is `None`) or an answer and how it ended.
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
}

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn in_memory() -> Result<Self, AppError> {
        let connection = Connection::open_in_memory().map_err(store_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .and_then(|()| connection.execute_batch(SCHEMA))
            .map_err(store_error)?;
        Ok(Self { connection })
    }

    /// Adds a user message to `conversation`, or to a new conversation titled by the message when
    /// there is none, and returns the conversation's id.
    pub fn add_user_message(
        &mut self,
        conversation: Option<i64>,
        text: &str,
        now: i64,
    ) -> Result<i64, AppError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        let conversation = match conversation {
            Some(id) => {
                let updated = transaction
                    .execute(
                        "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                        params![id, now],
                    )
                    .map_err(store_error)?;
                if updated == 0 {
                    return Err(no_conversation());
                }
                id
            }
            None => {
                transaction
                    .execute(
                        "INSERT INTO conversations (title, created, updated) VALUES (?1, ?2, ?2)",
                        params![title(text), now],
                    )
                    .map_err(store_error)?;
                transaction.last_insert_rowid()
            }
        };
        transaction
            .execute(
                "INSERT INTO messages (conversation, role, text, time) VALUES (?1, ?2, ?3, ?4)",
                params![conversation, USER, text, now],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)?;
        Ok(conversation)
    }

    /// Readies `conversation` to answer its last message again: that message must be a user
    /// message whose answer is missing or stopped, and a stopped answer is removed. Returns the
    /// message's text.
    pub fn prepare_retry(&mut self, conversation: i64) -> Result<String, AppError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        let last: Vec<(i64, String, String, Option<String>)> = {
            let mut statement = transaction
                .prepare(
                    "SELECT id, role, text, state FROM messages WHERE conversation = ?1
                     ORDER BY id DESC LIMIT 2",
                )
                .map_err(store_error)?;
            statement
                .query_map([conversation], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .and_then(Iterator::collect)
                .map_err(store_error)?
        };
        let text = match last.as_slice() {
            [(_, role, text, _), ..] if role == USER => text.clone(),
            [(answer, _, _, Some(state)), (_, role, text, _)]
                if role == USER && state == AnswerState::Stopped.as_str() =>
            {
                transaction
                    .execute("DELETE FROM messages WHERE id = ?1", [answer])
                    .map_err(store_error)?;
                text.clone()
            }
            [] => return Err(no_conversation()),
            _ => {
                return Err(AppError::new(
                    ErrorKind::Conflict,
                    "The last message already has its answer.",
                ));
            }
        };
        transaction.commit().map_err(store_error)?;
        Ok(text)
    }

    /// Saves the answer to `conversation`'s last message.
    pub fn add_answer(
        &mut self,
        conversation: i64,
        answer: &Answer,
        now: i64,
    ) -> Result<(), AppError> {
        let transaction = self.connection.transaction().map_err(store_error)?;
        transaction
            .execute(
                "INSERT INTO messages (conversation, role, text, time, state, left_out)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conversation,
                    ASSISTANT,
                    answer.text,
                    now,
                    answer.state.as_str(),
                    answer.left_out
                ],
            )
            .map_err(store_error)?;
        let message = transaction.last_insert_rowid();
        for (ordinal, (path, partial)) in answer.pages.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO read_pages (message, ordinal, path, partial) VALUES (?1, ?2, ?3, ?4)",
                    params![message, ordinal as i64, path, partial],
                )
                .map_err(store_error)?;
        }
        transaction
            .execute(
                "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                params![conversation, now],
            )
            .map_err(store_error)?;
        transaction.commit().map_err(store_error)
    }

    /// `conversation`'s messages in order.
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

    /// The pages saved with `conversation`'s last answer, for the tests.
    #[cfg(test)]
    pub fn last_answer_pages(&self, conversation: i64) -> Vec<(String, bool)> {
        let message: Option<i64> = self
            .connection
            .query_row(
                "SELECT max(id) FROM messages WHERE conversation = ?1 AND role = 'assistant'",
                [conversation],
                |row| row.get(0),
            )
            .unwrap();
        let mut statement = self
            .connection
            .prepare("SELECT path, partial FROM read_pages WHERE message = ?1 ORDER BY ordinal")
            .unwrap();
        statement
            .query_map([message], |row| Ok((row.get(0)?, row.get(1)?)))
            .and_then(Iterator::collect)
            .unwrap()
    }
}

/// A conversation's title: its first message's first line, cut to `TITLE_LIMIT` characters.
fn title(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or_default();
    line.chars().take(TITLE_LIMIT).collect()
}

fn no_conversation() -> AppError {
    AppError::new(ErrorKind::NotFound, "The conversation does not exist.")
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
        }
    }

    #[test]
    fn messages_and_answers_are_kept_in_order_with_their_pages() {
        let mut store = Store::in_memory().unwrap();
        let title = format!("  {}\nsecond line", "x".repeat(70));

        let conversation = store.add_user_message(None, &title, 1).unwrap();
        let pages = [("Places/Saltmere.md".to_owned(), true)];
        store
            .add_answer(
                conversation,
                &Answer {
                    state: AnswerState::CutOff,
                    text: "Long",
                    pages: &pages,
                    left_out: 2,
                },
                2,
            )
            .unwrap();
        assert_eq!(
            store
                .add_user_message(Some(conversation), "Next", 3)
                .unwrap(),
            conversation
        );

        assert_eq!(
            store.messages(conversation).unwrap(),
            [
                user(&title),
                Message {
                    text: "Long".to_owned(),
                    answer: Some(AnswerState::CutOff)
                },
                user("Next"),
            ]
        );
        assert_eq!(store.last_answer_pages(conversation), pages);
        let stored: String = store
            .connection
            .query_row("SELECT title FROM conversations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, "x".repeat(60));
        assert_eq!(
            store
                .add_user_message(Some(99), "Lost", 4)
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn retry_replaces_a_stopped_answer_accepts_a_missing_one_and_refuses_after_an_answer() {
        let mut store = Store::in_memory().unwrap();
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
    }
}
