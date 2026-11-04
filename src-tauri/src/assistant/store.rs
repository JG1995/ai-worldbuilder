//! The conversations of one world, in an SQLite file per world:
//! `<app data dir>/grimoire-data/conversations/<name>.sqlite`, named like the world's history
//! database by `history::file_name`. The file records the world folder's path too, so two paths
//! with the same hash never share their conversations.
//!
//! Format 3, named by `PRAGMA user_version`:
//!
//! - `meta`: one row, the world folder's path.
//! - `conversations`: each conversation's `title`, from its first message, and the times it was
//!   `created` and `updated` by its latest message, in seconds since the Unix epoch.
//! - `messages`: each message of a conversation in order (`id`): its `role` (`user` or
//!   `assistant`), `text` and `time`; for a user message the image it `regenerates`, if any,
//!   without a foreign key, so it reads as none once that image is gone; and for an answer how it
//!   ended (`state`: `complete`, `stopped` or `cut_off`), how many earlier messages its request
//!   `left_out`, whether the world was still `indexing` as its pages were chosen, how many of its
//!   proposals were `unreadable`, whether it ended inside one (`unfinished`), and the same two
//!   notes for its image requests (`image_unreadable`, `image_unfinished`). An answer's text is
//!   its prose alone; its proposals and images are kept in their own tables.
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
//! - `images`: each image request of an answer in order (`ordinal`): its `name`, `frame`
//!   (`square`, `portrait` or `landscape`) and `prompt`; the image it `revises`, for a
//!   regeneration; what its generation did with that image (`reference`: `sent`, `not_taken` or
//!   `gone`); its `state` (`not_generated`, `generating`, `pending`, `approving`, `approved`,
//!   `undoing` or `rejected`), with the `reason` it is not generated (`stopped`, `answer_failed`,
//!   `over_limit`, `cancelled`, `interrupted`, `no_provider` or `failed`); whether it was
//!   `undone`; and while it is approved or marked, the `path` its approval writes and the history
//!   change it recorded (`change`, `started`). `approving` and `undoing` are marks set before an
//!   approval or its undo touches a file and settled from that file; `generating` rows left by an
//!   earlier opening become `not_generated` (`interrupted`) when the store opens.
//! - `image_bytes`: a generated image's `media_type` and `bytes`, from its generation until it is
//!   rejected. Never a page's text or a key.
//!
//! Hashes are stored as the bits of a signed integer. Format 1 lacked the notes and the proposal
//! tables, and format 2 the image columns and tables; an earlier file is updated in place, through
//! each format, in one transaction, when its world opens.
//!
//! Deleting a conversation deletes its messages with their pages, proposals, sets, images and
//! image bytes. Each message is written in one transaction, and the file syncs fully, so after a
//! crash a message is there whole or not at all.
//!
//! The store numbers each new image itself, past the highest image id it has held since it opened,
//! rather than leaving it to SQLite, which gives a new row the id of a deleted highest row. A
//! stored image's URL names it by its session and id alone, and the webview keeps an image it has
//! loaded for a URL, so an image deleted with its conversation or a retried answer must never hand
//! its id to another image in the same opening, including after the store moves to memory.
//!
//! A damaged file is set aside, as a damaged history database is, and a new one replaces it. A file
//! in a newer format, holding unknown data, or recording another world is left untouched; so is
//! everything when the world's path cannot name a file or there is no app data folder; so is an
//! earlier file whose update fails. The store then keeps this opening's conversations in memory.
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
const FORMAT: i64 = 3;

/// The tables of format 1, with the columns formats 2 and 3 added to `messages` last, where the
/// updates add them, so an updated file and a new one have their columns in the same order.
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
        unfinished INTEGER NOT NULL DEFAULT 0,
        regenerates INTEGER,
        image_unreadable INTEGER NOT NULL DEFAULT 0,
        image_unfinished INTEGER NOT NULL DEFAULT 0
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
/// The columns format 3 added to `messages` in an earlier file. `regenerates` names an image
/// without a foreign key, because `images` comes after `messages` in `TABLES`.
const IMAGE_NOTES: &str = "
    ALTER TABLE messages ADD COLUMN regenerates INTEGER;
    ALTER TABLE messages ADD COLUMN image_unreadable INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN image_unfinished INTEGER NOT NULL DEFAULT 0;
";
/// The tables format 3 added, created as they are in a new file and in an updated one.
const IMAGE_SCHEMA: &str = "
    CREATE TABLE images (
        id INTEGER PRIMARY KEY,
        message INTEGER REFERENCES messages ON DELETE CASCADE,
        ordinal INTEGER,
        name TEXT,
        frame TEXT,
        prompt TEXT,
        revises INTEGER REFERENCES images ON DELETE SET NULL,
        reference TEXT,
        state TEXT,
        reason TEXT,
        undone INTEGER,
        path TEXT,
        change INTEGER,
        started INTEGER
    );
    CREATE INDEX images_by_message ON images (message, ordinal);
    CREATE TABLE image_bytes (
        image INTEGER PRIMARY KEY REFERENCES images ON DELETE CASCADE,
        media_type TEXT,
        bytes BLOB
    );
";
/// The tables that hold conversations, in an order that keeps their references valid, apart from
/// an image's `revises`, which can name any image.
const TABLES: [&str; 8] = [
    "conversations",
    "messages",
    "read_pages",
    "accepts",
    "proposals",
    "proposal_changes",
    "images",
    "image_bytes",
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
/// became of it, and one for each of its images that names it and what became of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub text: String,
    pub answer: Option<AnswerState>,
    pub proposals: Vec<String>,
    pub images: Vec<String>,
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
    /// The image requests read from the answer, in order.
    pub images: &'a [NewImage],
    /// How many image requests could not be read.
    pub image_unreadable: u32,
    /// Whether the answer ended inside an image request, which was dropped.
    pub image_unfinished: bool,
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

/// The shape an image request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ImageFrame {
    Square,
    Portrait,
    Landscape,
}

impl ImageFrame {
    fn as_str(self) -> &'static str {
        match self {
            Self::Square => "square",
            Self::Portrait => "portrait",
            Self::Landscape => "landscape",
        }
    }

    pub(super) fn parse(text: &str) -> Option<Self> {
        match text {
            "square" => Some(Self::Square),
            "portrait" => Some(Self::Portrait),
            "landscape" => Some(Self::Landscape),
            _ => None,
        }
    }
}

/// Where an image stands. `Approving` and `Undoing` are marks: an approval or its undo is writing
/// the image's file, or stopped before it could settle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageState {
    NotGenerated,
    Generating,
    Pending,
    Approving,
    Approved,
    Undoing,
    Rejected,
}

impl ImageState {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotGenerated => "not_generated",
            Self::Generating => "generating",
            Self::Pending => "pending",
            Self::Approving => "approving",
            Self::Approved => "approved",
            Self::Undoing => "undoing",
            Self::Rejected => "rejected",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "not_generated" => Some(Self::NotGenerated),
            "generating" => Some(Self::Generating),
            "pending" => Some(Self::Pending),
            "approving" => Some(Self::Approving),
            "approved" => Some(Self::Approved),
            "undoing" => Some(Self::Undoing),
            "rejected" => Some(Self::Rejected),
            _ => None,
        }
    }
}

/// Why an image is not generated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum NotGenerated {
    /// Its answer was stopped.
    Stopped,
    /// Its answer failed.
    AnswerFailed,
    /// Its answer requested more images than are generated for one answer.
    OverLimit,
    Cancelled,
    /// Its generation never finished, or never started.
    Interrupted,
    /// No image provider was saved.
    NoProvider,
    Failed,
}

impl NotGenerated {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::AnswerFailed => "answer_failed",
            Self::OverLimit => "over_limit",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::NoProvider => "no_provider",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "stopped" => Some(Self::Stopped),
            "answer_failed" => Some(Self::AnswerFailed),
            "over_limit" => Some(Self::OverLimit),
            "cancelled" => Some(Self::Cancelled),
            "interrupted" => Some(Self::Interrupted),
            "no_provider" => Some(Self::NoProvider),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// What a regeneration's generation did with the image it revises: sent it, left it out because
/// the model takes no image input, or found it gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ImageReference {
    Sent,
    NotTaken,
    Gone,
}

impl ImageReference {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::NotTaken => "not_taken",
            Self::Gone => "gone",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "sent" => Some(Self::Sent),
            "not_taken" => Some(Self::NotTaken),
            "gone" => Some(Self::Gone),
            _ => None,
        }
    }
}

/// An image request as an answer saves it, not generated yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewImage {
    pub name: String,
    pub frame: ImageFrame,
    pub prompt: String,
    /// The image it regenerates, kept only when that image exists.
    pub revises: Option<i64>,
    /// Why it is not generated yet.
    pub reason: NotGenerated,
}

/// A saved image request and where it stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedImage {
    pub id: i64,
    pub name: String,
    pub frame: ImageFrame,
    pub prompt: String,
    /// The image it regenerates, while that image exists.
    pub revises: Option<i64>,
    /// What its generation did with the image it revises, once it is generated.
    pub reference: Option<ImageReference>,
    pub state: ImageState,
    /// Why it is not generated, while it is not.
    pub reason: Option<NotGenerated>,
    /// It was approved, and that approval was undone.
    pub undone: bool,
    /// While it is approved or marked: the path its approval writes, and the change the approval
    /// recorded, or none when history was not recording.
    pub path: Option<String>,
    pub change: Option<HistoryChange>,
}

/// A generated image's file content and its media type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageBytes {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

/// An image with its conversation, its answer and its bytes, which it has from its generation
/// until it is rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredImage {
    pub conversation: i64,
    pub answer: i64,
    pub image: SavedImage,
    pub bytes: Option<ImageBytes>,
}

/// An answer's images and its notes about image requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedAnswerImages {
    pub answer: i64,
    /// How many image requests could not be read.
    pub unreadable: u32,
    /// Whether the answer ended inside an image request.
    pub unfinished: bool,
    pub images: Vec<SavedImage>,
}

/// A user message that regenerates an image, with the image's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedRegeneration {
    /// The message's position, from 0, among its conversation's messages, as `conversation` lists
    /// them; `SavedMessage` carries no id for a user message.
    pub message: u32,
    pub image: i64,
    pub name: String,
}

/// A conversation's answers that have images or notes about them, in order, and its regeneration
/// messages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedImages {
    pub answers: Vec<SavedAnswerImages>,
    pub regenerations: Vec<SavedRegeneration>,
}

/// The image a regeneration message revises, with what a request tells the model of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Regenerated {
    pub image: i64,
    pub name: String,
    pub prompt: String,
}

/// An image marked `approving` or `undoing`, with the path its approval writes, to be resolved
/// from what that file holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageMark {
    pub image: i64,
    pub path: String,
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
    /// The images an earlier process or opening left marked, until they are taken to be resolved.
    marks: Vec<ImageMark>,
    /// The id the next new image gets: past every image id this opening has held.
    next_image: i64,
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
            Ok((connection, set_aside)) => {
                let mut store = Self {
                    unfinished: unfinished_sets(&connection).map_err(store_error)?,
                    marks: image_marks(&connection).map_err(store_error)?,
                    next_image: connection
                        .query_row("SELECT coalesce(max(id), 0) + 1 FROM images", [], |row| {
                            row.get(0)
                        })
                        .map_err(store_error)?,
                    connection,
                    saving: true,
                    notice: set_aside.then_some(StoreNotice::SetAside),
                };
                store.interrupt_generations()?;
                Ok(store)
            }
            Err(reason) => {
                let connection = memory_database().map_err(store_error)?;
                Ok(Self {
                    connection,
                    saving: false,
                    notice: Some(StoreNotice::NotSaved { reason }),
                    unfinished: Vec::new(),
                    marks: Vec::new(),
                    next_image: 1,
                })
            }
        }
    }

    /// Makes every image an earlier process or opening left generating not generated
    /// (interrupted). A file without one is not written, so a read-only file opens as before.
    fn interrupt_generations(&mut self) -> Result<(), AppError> {
        let generating: bool = self
            .connection
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM images WHERE state = ?1)",
                [ImageState::Generating.as_str()],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        if generating {
            self.write(|transaction| {
                transaction.execute(
                    "UPDATE images SET state = ?2, reason = ?3 WHERE state = ?1",
                    params![
                        ImageState::Generating.as_str(),
                        ImageState::NotGenerated.as_str(),
                        NotGenerated::Interrupted.as_str()
                    ],
                )?;
                Ok(())
            })?;
        }
        Ok(())
    }

    /// Takes the sets that were unfinished when the store opened, so they are resolved once. Sets
    /// begun since are never among them.
    pub fn take_unfinished(&mut self) -> Vec<UnfinishedSet> {
        std::mem::take(&mut self.unfinished)
    }

    /// Takes the images that were marked when the store opened, so they are resolved once. Marks
    /// made since are never among them.
    pub fn take_image_marks(&mut self) -> Vec<ImageMark> {
        std::mem::take(&mut self.marks)
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
    /// from nothing when it cannot be read. The file is left as it is, and so is `next_image`.
    fn move_to_memory(&mut self, reason: String) {
        if let Ok(memory) = copied(&self.connection).or_else(|_| memory_database()) {
            self.connection = memory;
        }
        self.saving = false;
        self.notice = Some(StoreNotice::NotSaved { reason });
    }

    /// Adds a user message to `conversation`, or to a new conversation titled by the message when
    /// there is none, and returns the conversation's id. A message that `regenerates` an image
    /// must be added to that image's conversation.
    pub fn add_user_message(
        &mut self,
        conversation: Option<i64>,
        text: &str,
        regenerates: Option<i64>,
        now: i64,
    ) -> Result<i64, AppError> {
        self.write(|transaction| {
            if let Some(image) = regenerates {
                let in_conversation: bool = transaction.query_row(
                    "SELECT EXISTS (SELECT 1 FROM images JOIN messages ON messages.id = images.message
                                    WHERE images.id = ?1 AND messages.conversation = ?2)",
                    params![image, conversation],
                    |row| row.get(0),
                )?;
                if !in_conversation {
                    return Err(WriteFailure::Refused(no_image()));
                }
            }
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
                "INSERT INTO messages (conversation, role, text, time, regenerates)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![conversation, USER, text, now, regenerates],
            )?;
            Ok(conversation)
        })
    }

    /// Readies `conversation` to answer its last message again: that message must be a user
    /// message whose answer is missing or stopped, and a stopped answer is removed with its images,
    /// unless one of its proposals belongs to a set, accepted or still being accepted, or one of
    /// its images is approved, being approved or being undone. Returns the message's text.
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
                    let approved: bool = transaction.query_row(
                        "SELECT EXISTS (SELECT 1 FROM images
                                        WHERE message = ?1 AND state IN (?2, ?3, ?4))",
                        params![
                            answer,
                            ImageState::Approving.as_str(),
                            ImageState::Approved.as_str(),
                            ImageState::Undoing.as_str()
                        ],
                        |row| row.get(0),
                    )?;
                    if approved {
                        return Err(WriteFailure::Refused(AppError::new(
                            ErrorKind::Conflict,
                            "The last answer has an approved image.",
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
    /// its proposals and its image requests, and returns the answer's id and its images' ids in
    /// order. The images are numbered from `next_image`, which moves past them once they are saved.
    pub fn add_answer(
        &mut self,
        conversation: i64,
        answer: &Answer,
        now: i64,
    ) -> Result<(i64, Vec<i64>), AppError> {
        let first_image = self.next_image;
        let saved = self.write(|transaction| {
            transaction.execute(
                "INSERT INTO messages (conversation, role, text, time, state, left_out, indexing,
                                       unreadable, unfinished, image_unreadable, image_unfinished)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    conversation,
                    ASSISTANT,
                    answer.text,
                    now,
                    answer.state.as_str(),
                    answer.left_out,
                    answer.indexing,
                    answer.unreadable,
                    answer.unfinished,
                    answer.image_unreadable,
                    answer.image_unfinished
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
            let mut images = Vec::new();
            for (ordinal, image) in answer.images.iter().enumerate() {
                let id = first_image + ordinal as i64;
                transaction.execute(
                    "INSERT INTO images (id, message, ordinal, name, frame, prompt, revises, state,
                                         reason, undone)
                     VALUES (?9, ?1, ?2, ?3, ?4, ?5, (SELECT id FROM images WHERE id = ?6), ?7, ?8,
                             0)",
                    params![
                        message,
                        ordinal as i64,
                        image.name,
                        image.frame.as_str(),
                        image.prompt,
                        image.revises,
                        ImageState::NotGenerated.as_str(),
                        image.reason.as_str(),
                        id
                    ],
                )?;
                images.push(id);
            }
            transaction.execute(
                "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                params![conversation, now],
            )?;
            Ok((message, images))
        })?;
        self.next_image = first_image + answer.images.len() as i64;
        Ok(saved)
    }

    /// Starts generating an image that is not generated.
    pub fn start_generating(&mut self, image: i64) -> Result<(), AppError> {
        self.write(|transaction| {
            require(
                transaction,
                image,
                ImageState::NotGenerated,
                "The image is being generated or was generated already.",
            )?;
            transaction.execute(
                "UPDATE images SET state = ?2, reason = NULL WHERE id = ?1",
                params![image, ImageState::Generating.as_str()],
            )?;
            Ok(())
        })
    }

    /// Keeps a generating image's `bytes`, of `media_type`, and makes it pending. `reference` says
    /// what a regeneration did with the image it revises.
    pub fn generated(
        &mut self,
        image: i64,
        media_type: &str,
        bytes: &[u8],
        reference: Option<ImageReference>,
    ) -> Result<(), AppError> {
        self.write(|transaction| {
            require(transaction, image, ImageState::Generating, NOT_GENERATING)?;
            transaction.execute(
                "UPDATE images SET state = ?2, reference = ?3 WHERE id = ?1",
                params![
                    image,
                    ImageState::Pending.as_str(),
                    reference.map(ImageReference::as_str)
                ],
            )?;
            transaction.execute(
                "INSERT INTO image_bytes (image, media_type, bytes) VALUES (?1, ?2, ?3)",
                params![image, media_type, bytes],
            )?;
            Ok(())
        })
    }

    /// Ends a generating image's generation without an image, for `reason`.
    pub fn not_generated(&mut self, image: i64, reason: NotGenerated) -> Result<(), AppError> {
        self.write(|transaction| {
            require(transaction, image, ImageState::Generating, NOT_GENERATING)?;
            transaction.execute(
                "UPDATE images SET state = ?2, reason = ?3 WHERE id = ?1",
                params![image, ImageState::NotGenerated.as_str(), reason.as_str()],
            )?;
            Ok(())
        })
    }

    /// Rejects a pending image for good and deletes its bytes.
    pub fn reject_image(&mut self, image: i64) -> Result<(), AppError> {
        self.write(|transaction| {
            require(transaction, image, ImageState::Pending, NOT_PENDING_IMAGE)?;
            transaction.execute(
                "UPDATE images SET state = ?2 WHERE id = ?1",
                params![image, ImageState::Rejected.as_str()],
            )?;
            transaction.execute("DELETE FROM image_bytes WHERE image = ?1", [image])?;
            Ok(())
        })
    }

    /// Marks a pending image as being approved, before its approval writes anything, with the path
    /// the approval writes and the change it recorded, or none when history was not recording.
    pub fn begin_approving(
        &mut self,
        image: i64,
        path: &str,
        change: Option<HistoryChange>,
    ) -> Result<(), AppError> {
        self.write(|transaction| {
            require(transaction, image, ImageState::Pending, NOT_PENDING_IMAGE)?;
            transaction.execute(
                "UPDATE images SET state = ?2, path = ?3, change = ?4, started = ?5 WHERE id = ?1",
                params![
                    image,
                    ImageState::Approving.as_str(),
                    path,
                    change.map(|change| change.id),
                    change.map(|change| change.started as i64)
                ],
            )?;
            Ok(())
        })
    }

    /// Marks an approved image as being undone, before the undo writes anything.
    pub fn begin_undoing(&mut self, image: i64) -> Result<(), AppError> {
        self.write(|transaction| {
            require(
                transaction,
                image,
                ImageState::Approved,
                "The image is no longer approved.",
            )?;
            transaction.execute(
                "UPDATE images SET state = ?2 WHERE id = ?1",
                params![image, ImageState::Undoing.as_str()],
            )?;
            Ok(())
        })
    }

    /// Settles a marked image by whether the file at its path holds its bytes (`written`): an
    /// image being approved becomes approved when it does and pending otherwise, and an image being
    /// undone stays approved when it does and becomes pending and undone otherwise. This finishes
    /// an approval or an undo, and resolves a mark a stop left. An image that is no longer marked,
    /// or no longer exists, is left as it is.
    pub fn settle_image(&mut self, image: i64, written: bool) -> Result<Settling, AppError> {
        self.write(|transaction| {
            let state = transaction
                .query_row("SELECT state FROM images WHERE id = ?1", [image], |row| {
                    stored(row, 0, ImageState::parse)
                })
                .optional()?;
            match (state, written) {
                (Some(ImageState::Approving | ImageState::Undoing), true) => {
                    transaction.execute(
                        "UPDATE images SET state = ?2, undone = 0 WHERE id = ?1",
                        params![image, ImageState::Approved.as_str()],
                    )?;
                }
                (Some(state @ (ImageState::Approving | ImageState::Undoing)), false) => {
                    transaction.execute(
                        "UPDATE images SET state = ?2, undone = undone OR ?3, path = NULL,
                                           change = NULL, started = NULL
                         WHERE id = ?1",
                        params![
                            image,
                            ImageState::Pending.as_str(),
                            state == ImageState::Undoing
                        ],
                    )?;
                }
                _ => return Ok(Settling::AlreadySettled),
            }
            Ok(Settling::Settled)
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
        let mut images = self.connection.prepare(
            "SELECT name, state, undone, path FROM images WHERE message = ?1 ORDER BY ordinal",
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
                images: images
                    .query_map([row.get::<_, i64>(0)?], image_line)?
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

    /// The image `image` with its conversation, its answer and its bytes.
    pub fn image(&self, image: i64) -> Result<StoredImage, AppError> {
        self.read_image(image)
            .map_err(store_error)?
            .ok_or_else(no_image)
    }

    fn read_image(&self, image: i64) -> rusqlite::Result<Option<StoredImage>> {
        let Some((conversation, answer, saved)) = self
            .connection
            .query_row(
                &format!(
                    "SELECT messages.conversation, images.message, {IMAGE_COLUMNS}
                     FROM images JOIN messages ON messages.id = images.message
                     WHERE images.id = ?1"
                ),
                [image],
                |row| Ok((row.get(0)?, row.get(1)?, saved_image(row, 2)?)),
            )
            .optional()?
        else {
            return Ok(None);
        };
        let bytes = self
            .connection
            .query_row(
                "SELECT media_type, bytes FROM image_bytes WHERE image = ?1",
                [image],
                |row| {
                    Ok(ImageBytes {
                        media_type: row.get(0)?,
                        bytes: row.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(Some(StoredImage {
            conversation,
            answer,
            image: saved,
            bytes,
        }))
    }

    /// The answers of `conversation` that have images or notes about them, in order, each with its
    /// images, and the conversation's regeneration messages whose image still exists.
    pub fn images(&self, conversation: i64) -> Result<SavedImages, AppError> {
        self.read_images(conversation)
            .map_err(store_error)?
            .ok_or_else(no_conversation)
    }

    fn read_images(&self, conversation: i64) -> rusqlite::Result<Option<SavedImages>> {
        let exists: bool = self.connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM conversations WHERE id = ?1)",
            [conversation],
            |row| row.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let mut images = self.connection.prepare(&format!(
            "SELECT {IMAGE_COLUMNS} FROM images WHERE message = ?1 ORDER BY ordinal"
        ))?;
        let answers = self
            .connection
            .prepare(
                "SELECT id, image_unreadable, image_unfinished FROM messages
                 WHERE conversation = ?1 AND role = ?2
                   AND (image_unreadable > 0 OR image_unfinished
                        OR EXISTS (SELECT 1 FROM images WHERE message = messages.id))
                 ORDER BY id",
            )?
            .query_map(params![conversation, ASSISTANT], |row| {
                let answer: i64 = row.get(0)?;
                Ok(SavedAnswerImages {
                    answer,
                    unreadable: row.get(1)?,
                    unfinished: row.get(2)?,
                    images: images
                        .query_map([answer], |image| saved_image(image, 0))?
                        .collect::<Result<_, _>>()?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let regenerations = self
            .connection
            .prepare(
                "SELECT (SELECT count(*) FROM messages AS earlier
                         WHERE earlier.conversation = messages.conversation
                           AND earlier.id < messages.id),
                        images.id, images.name
                 FROM messages JOIN images ON images.id = messages.regenerates
                 WHERE messages.conversation = ?1 ORDER BY messages.id",
            )?
            .query_map([conversation], |row| {
                Ok(SavedRegeneration {
                    message: row.get(0)?,
                    image: row.get(1)?,
                    name: row.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(Some(SavedImages {
            answers,
            regenerations,
        }))
    }

    /// The image that `conversation`'s last message regenerates, when it is a regeneration message
    /// and the image still exists.
    pub fn last_regeneration(&self, conversation: i64) -> Result<Option<Regenerated>, AppError> {
        self.connection
            .query_row(
                "SELECT images.id, images.name, images.prompt
                 FROM messages JOIN images ON images.id = messages.regenerates
                 WHERE messages.id = (SELECT max(id) FROM messages WHERE conversation = ?1)",
                [conversation],
                |row| {
                    Ok(Regenerated {
                        image: row.get(0)?,
                        name: row.get(1)?,
                        prompt: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(store_error)
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
        1 | 2 => {
            check_world(&connection, world)?;
            update(&mut connection, format)?;
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
    transaction.execute_batch(IMAGE_SCHEMA)?;
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

/// Updates a file in the earlier format `from` to the format, through each format between, in one
/// transaction, so a failure leaves it as it was.
fn update(connection: &mut Connection, from: i64) -> Result<(), Refusal> {
    let update = |connection: &mut Connection| -> rusqlite::Result<()> {
        let transaction = connection.transaction()?;
        if from < 2 {
            transaction.execute_batch(NOTES)?;
            transaction.execute_batch(PROPOSAL_SCHEMA)?;
        }
        transaction.execute_batch(IMAGE_NOTES)?;
        transaction.execute_batch(IMAGE_SCHEMA)?;
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
    connection.execute_batch(IMAGE_SCHEMA)?;
    Ok(connection)
}

/// A store in memory holding every conversation `from` holds.
fn copied(from: &Connection) -> rusqlite::Result<Connection> {
    let mut memory = memory_database()?;
    let transaction = memory.transaction()?;
    // An image's `revises` can name an image copied after it; references are checked at commit.
    transaction.pragma_update(None, "defer_foreign_keys", true)?;
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

/// The columns `saved_image` reads, in order.
const IMAGE_COLUMNS: &str = "images.id, images.name, images.frame, images.prompt, images.revises,
    images.reference, images.state, images.reason, images.undone, images.path, images.change,
    images.started";

/// The image in `row`, read from `IMAGE_COLUMNS` starting at the column `first`.
fn saved_image(row: &rusqlite::Row, first: usize) -> rusqlite::Result<SavedImage> {
    let reference: Option<String> = row.get(first + 5)?;
    let reason: Option<String> = row.get(first + 7)?;
    Ok(SavedImage {
        id: row.get(first)?,
        name: row.get(first + 1)?,
        frame: stored(row, first + 2, ImageFrame::parse)?,
        prompt: row.get(first + 3)?,
        revises: row.get(first + 4)?,
        reference: reference
            .map(|_| stored(row, first + 5, ImageReference::parse))
            .transpose()?,
        state: stored(row, first + 6, ImageState::parse)?,
        reason: reason
            .map(|_| stored(row, first + 7, NotGenerated::parse))
            .transpose()?,
        undone: row.get(first + 8)?,
        path: row.get(first + 9)?,
        change: history_change(row.get(first + 10)?, row.get(first + 11)?),
    })
}

/// Refuses unless `image` is in the state `from`, with `refusal` when it is in another.
fn require(
    transaction: &Transaction,
    image: i64,
    from: ImageState,
    refusal: &'static str,
) -> Result<(), WriteFailure> {
    let state = transaction
        .query_row("SELECT state FROM images WHERE id = ?1", [image], |row| {
            stored(row, 0, ImageState::parse)
        })
        .optional()?
        .ok_or_else(|| WriteFailure::Refused(no_image()))?;
    if state != from {
        return Err(WriteFailure::Refused(AppError::new(
            ErrorKind::Conflict,
            refusal,
        )));
    }
    Ok(())
}

/// The images that are marked, with the paths their approvals write.
fn image_marks(connection: &Connection) -> rusqlite::Result<Vec<ImageMark>> {
    connection
        .prepare("SELECT id, path FROM images WHERE state IN (?1, ?2) ORDER BY id")?
        .query_map(
            [ImageState::Approving.as_str(), ImageState::Undoing.as_str()],
            |row| {
                Ok(ImageMark {
                    image: row.get(0)?,
                    path: row.get(1)?,
                })
            },
        )?
        .collect()
}

/// The line a request carries for an image, read from its `name, state, undone, path`: its name
/// and what became of it. An image being approved or undone counts as it was before.
fn image_line(row: &rusqlite::Row) -> rusqlite::Result<String> {
    let name: String = row.get(0)?;
    let outcome = match (stored(row, 1, ImageState::parse)?, row.get(2)?) {
        (ImageState::NotGenerated | ImageState::Generating, _) => "not generated".to_owned(),
        (ImageState::Pending | ImageState::Approving, false) => "pending".to_owned(),
        (ImageState::Pending | ImageState::Approving, true) => "undone".to_owned(),
        (ImageState::Approved | ImageState::Undoing, _) => {
            format!("saved as {}", row.get::<_, String>(3)?)
        }
        (ImageState::Rejected, _) => "rejected".to_owned(),
    };
    Ok(format!("[Image \"{name}\": {outcome}]"))
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

fn no_image() -> AppError {
    AppError::new(ErrorKind::NotFound, "The image does not exist.")
}

const NOT_PENDING_IMAGE: &str = "The image is no longer pending.";
const NOT_GENERATING: &str = "The image is no longer being generated.";

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
            images: Vec::new(),
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
            images: &[],
            image_unreadable: 0,
            image_unfinished: false,
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
        let first = store.add_user_message(None, &long, None, 10).unwrap();
        let second = store.add_user_message(None, "Saltmere", None, 20).unwrap();
        let pages = [("Places/Saltmere.md".to_owned(), true)];
        let (answer, _) = store
            .add_answer(
                first,
                &Answer {
                    pages: &pages,
                    left_out: 2,
                    indexing: true,
                    ..answer(AnswerState::CutOff, "Long")
                },
                30,
            )
            .unwrap();
        store
            .add_user_message(Some(first), "Next", None, 40)
            .unwrap();
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
        assert_eq!((format, world.as_str()), (3, WORLD));
    }

    #[test]
    fn a_message_is_written_whole_or_not_at_all() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Hello", None, 1).unwrap();
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
                    pages: &pages,
                    ..answer(AnswerState::Complete, "Hi")
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
                    images: Vec::new(),
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
        store.add_user_message(None, "Hello", None, 1).unwrap();
        assert_eq!(rows_in_file(&app_data), [1, 1, 0]);
    }

    #[test]
    fn a_newer_unknown_or_foreign_file_is_left_untouched_and_the_store_works_in_memory() {
        let cases: [(&str, &str, &str); 3] = [
            (
                "PRAGMA user_version = 4;",
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
            store.add_user_message(None, "Kept", None, 1).unwrap();
            drop(store);
            let connection = Connection::open(&file).unwrap();
            connection.execute_batch(change).unwrap();
            connection.execute_batch(pragma).unwrap();
            drop(connection);
            let before = snapshot(&file);

            let mut store = opened(&app_data);
            let conversation = store.add_user_message(None, "In memory", None, 2).unwrap();

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
            store.add_user_message(None, "Hello", None, 1).unwrap();

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
        let earlier = store.add_user_message(None, "Earlier", None, 1).unwrap();
        drop(store);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o444)).unwrap();

        let mut store = opened(&app_data);
        assert_eq!(store.conversations().unwrap().notice, None);
        let later = store.add_user_message(None, "Later", None, 2).unwrap();

        assert_eq!(
            store.conversations().unwrap().notice,
            Some(StoreNotice::NotSaved {
                reason: "The conversation store cannot be written.".to_owned()
            })
        );
        assert_eq!(titles(&store), ["Later", "Earlier"]);
        assert_eq!(store.messages(earlier).unwrap(), [user("Earlier")]);
        store
            .add_user_message(Some(later), "Still here", None, 3)
            .unwrap();
        drop(store);

        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let store = opened(&app_data);
        assert_eq!(store.conversations().unwrap().notice, None);
        assert_eq!(titles(&store), ["Earlier"]);
    }

    #[test]
    fn deleting_a_conversation_removes_its_messages_pages_proposals_sets_and_images_and_nothing_else()
     {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let gone = store.add_user_message(None, "Gone", None, 1).unwrap();
        let pages = [("A.md".to_owned(), false)];
        let gone_proposals = [new_page("Gone.md"), edit("A.md")];
        let images = [new_image("Gate"), new_image("Tower")];
        let (gone_answer, gone_images) = store
            .add_answer(
                gone,
                &Answer {
                    pages: &pages,
                    proposals: &gone_proposals,
                    images: &images,
                    ..answer(AnswerState::Complete, "Hi")
                },
                2,
            )
            .unwrap();
        let ids = proposal_ids(&store, gone);
        store
            .begin_accept(gone_answer, &pages_of(&ids), None, 2)
            .unwrap();
        drive(&mut store, gone_images[0], ImageState::Approved);
        let kept = store.add_user_message(None, "Kept", None, 3).unwrap();
        let kept_proposals = [new_page("Kept.md")];
        let (_, kept_images) = store
            .add_answer(
                kept,
                &Answer {
                    pages: &pages,
                    proposals: &kept_proposals,
                    images: &images[..1],
                    ..answer(AnswerState::Complete, "Hi")
                },
                4,
            )
            .unwrap();
        drive(&mut store, kept_images[0], ImageState::Pending);

        store.delete(gone).unwrap();

        assert_eq!(rows_in_file(&app_data), [1, 2, 1]);
        assert_eq!(proposal_rows_in_file(&app_data), [0, 1, 0]);
        assert_eq!(image_rows_in_file(&app_data), [1, 1]);
        assert!(store.image(kept_images[0]).unwrap().bytes.is_some());
        assert_eq!(titles(&store), ["Kept"]);
        assert_eq!(store.delete(gone).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn retry_replaces_a_stopped_answer_accepts_a_missing_one_and_refuses_after_an_answer() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Hello", None, 1).unwrap();

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
                .add_user_message(Some(99), "Lost", None, 4)
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
        let conversation = store.add_user_message(None, "Propose", None, 1).unwrap();
        let proposals = [new_page("A.md"), new_page("B.md"), edit("C.md")];
        let (answer, _) = store
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

    /// What a format-2 file adds to the format-1 file: the notes, the proposal tables, and an
    /// answer's accepted, pending (undone) and rejected proposals with an edit's passages.
    const FORMAT_2: &str = "
        ALTER TABLE messages ADD COLUMN unreadable INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE messages ADD COLUMN unfinished INTEGER NOT NULL DEFAULT 0;
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
        UPDATE messages SET unreadable = 2, unfinished = 1 WHERE id = 4;
        INSERT INTO accepts VALUES (1, 2, 7, 1700000000, 'accepted', 35);
        INSERT INTO proposals VALUES
            (1, 2, 0, 'new_page', 'Places/Kesh Tor.md', '# Kesh Tor', NULL, -5, 'accepted', 0, 1),
            (2, 2, 1, 'edit', 'People/Ada.md', NULL, -2, NULL, 'pending', 1, NULL),
            (3, 4, 0, 'new_page', 'Kesh/Gate.md', '# Gate', NULL, NULL, 'rejected', 0, NULL);
        INSERT INTO proposal_changes VALUES (2, 0, 'old', 'new'), (2, 1, 'grey', 'green');
        PRAGMA user_version = 2;
    ";

    /// The format-2 tables' rows, in the columns format 2 has.
    const FORMAT_2_ROWS: [&str; 6] = [
        "SELECT * FROM conversations ORDER BY id",
        "SELECT id, conversation, role, text, time, state, left_out, indexing, unreadable,
                unfinished FROM messages ORDER BY id",
        "SELECT * FROM read_pages ORDER BY message, ordinal",
        "SELECT * FROM accepts ORDER BY id",
        "SELECT * FROM proposals ORDER BY id",
        "SELECT * FROM proposal_changes ORDER BY proposal, ordinal",
    ];

    #[test]
    fn an_earlier_file_is_updated_in_place_to_format_3_keeping_every_row() {
        let cases: [(&str, &str, &[&str]); 2] = [
            ("format 1", "", &FORMAT_1_ROWS),
            ("format 2", FORMAT_2, &FORMAT_2_ROWS),
        ];
        for (name, extra, queries) in cases {
            let app_data = tempfile::tempdir().unwrap();
            let file = write_format_1(&app_data, extra);
            let connection = Connection::open(&file).unwrap();
            let before: Vec<_> = queries
                .iter()
                .map(|query| rows(&connection, query))
                .collect();
            drop(connection);

            let store = opened(&app_data);

            assert_eq!(store.conversations().unwrap().notice, None, "{name}");
            assert_eq!(titles(&store), ["Kesh", "Saltmere"], "{name}");
            drop(store);
            let connection = Connection::open(&file).unwrap();
            let after: Vec<_> = queries
                .iter()
                .map(|query| rows(&connection, query))
                .collect();
            assert_eq!(after, before, "{name}");
            assert_eq!(
                rows(
                    &connection,
                    "SELECT regenerates, image_unreadable, image_unfinished FROM messages"
                ),
                vec![vec![Value::Null, Value::Integer(0), Value::Integer(0)]; 4],
                "{name}"
            );
            let format: i64 = connection
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .unwrap();
            assert_eq!(format, 3, "{name}");
            // A move to memory copies the columns in order, so they must match a new file's.
            let new = tempfile::tempdir().unwrap();
            drop(opened(&new));
            assert_eq!(columns(&file), columns(&file_of(&new)), "{name}");
        }
    }

    #[test]
    fn an_earlier_file_whose_update_fails_is_left_as_it_was_and_the_store_works_in_memory() {
        // A table in the way of the last step of the update, so a format-1 file fails after its
        // update to format 2.
        let in_the_way = "CREATE TABLE images (id INTEGER);";
        for (name, extra) in [
            ("format 1", in_the_way.to_owned()),
            ("format 2", format!("{FORMAT_2}{in_the_way}")),
        ] {
            let app_data = tempfile::tempdir().unwrap();
            let file = write_format_1(&app_data, &extra);
            let before = fs::read(&file).unwrap();

            let mut store = opened(&app_data);
            store.add_user_message(None, "In memory", None, 1).unwrap();

            let Some(StoreNotice::NotSaved { reason }) = store.conversations().unwrap().notice
            else {
                panic!("the store is not saved ({name})");
            };
            assert!(
                reason.starts_with(
                    "The conversation store could not be updated to this version's format."
                ),
                "{name}: {reason}"
            );
            assert_eq!(titles(&store), ["In memory"], "{name}");
            drop(store);
            assert_eq!(fs::read(&file).unwrap(), before, "{name}");
        }
    }

    #[test]
    fn an_answer_keeps_its_proposals_passages_and_notes_across_reopening() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Propose", None, 1).unwrap();
        store
            .add_answer(conversation, &answer(AnswerState::Complete, "Plain"), 2)
            .unwrap();
        store
            .add_user_message(Some(conversation), "Again", None, 3)
            .unwrap();
        let proposals = [new_page("Places/Saltmere"), edit("People/Ada.md")];
        let (answer_id, _) = store
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
    fn a_failed_write_moves_proposals_sets_and_images_to_memory_from_a_new_or_an_updated_file() {
        for (name, file) in [
            ("new", None),
            ("format 1", Some("")),
            ("format 2", Some(FORMAT_2)),
        ] {
            let app_data = tempfile::tempdir().unwrap();
            if let Some(extra) = file {
                write_format_1(&app_data, extra);
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
            let (_, _, [earlier_image, _]) =
                with_images(&mut store, Some(conversation), ["Gate", "Tower"]);
            drive(&mut store, earlier_image, ImageState::Approved);
            let revising = regenerate(&mut store, conversation, earlier_image);
            // The copy must not depend on an image being copied after the image it revises.
            store
                .connection
                .execute(
                    "UPDATE images SET revises = ?2 WHERE id = ?1",
                    [earlier_image, revising],
                )
                .unwrap();
            let before = store.proposals(conversation).unwrap();
            let images_before = store.images(conversation).unwrap();
            let earlier = titles(&store);
            store
                .connection
                .execute_batch(
                    "CREATE TRIGGER fail BEFORE INSERT ON messages WHEN NEW.text = 'Fails'
                     BEGIN SELECT RAISE(ABORT, 'injected'); END;",
                )
                .unwrap();

            store
                .add_user_message(Some(conversation), "Fails", None, 5)
                .unwrap();

            assert!(
                matches!(
                    store.conversations().unwrap().notice,
                    Some(StoreNotice::NotSaved { .. })
                ),
                "{name}"
            );
            assert_eq!(store.proposals(conversation).unwrap(), before, "{name}");
            assert_eq!(store.images(conversation).unwrap(), images_before, "{name}");
            assert_eq!(images_before.regenerations.len(), 1, "{name}");
            for image in [earlier_image, revising] {
                assert_eq!(store.image(image).unwrap().bytes, Some(png()), "{name}");
            }
            assert_eq!(titles(&store), earlier, "{name}");
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

    /// A generated image's bytes, with a NUL and a high byte, which a BLOB keeps.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\xff";
    const CHANGE: HistoryChange = HistoryChange {
        id: 4,
        started: 1_700_000_000,
    };
    const IMAGE_STATES: [ImageState; 7] = [
        ImageState::NotGenerated,
        ImageState::Generating,
        ImageState::Pending,
        ImageState::Approving,
        ImageState::Approved,
        ImageState::Undoing,
        ImageState::Rejected,
    ];

    fn png() -> ImageBytes {
        ImageBytes {
            media_type: "image/png".to_owned(),
            bytes: PNG.to_vec(),
        }
    }

    fn new_image(name: &str) -> NewImage {
        NewImage {
            name: name.to_owned(),
            frame: ImageFrame::Portrait,
            prompt: format!("An ink drawing of {name}"),
            revises: None,
            reason: NotGenerated::Interrupted,
        }
    }

    /// Adds a message to `conversation`, or to a new one, and a stopped answer requesting the
    /// images named `names`: the conversation's id, the answer's id and the images' ids.
    fn with_images<const N: usize>(
        store: &mut Store,
        conversation: Option<i64>,
        names: [&str; N],
    ) -> (i64, i64, [i64; N]) {
        let conversation = store
            .add_user_message(conversation, "Draw", None, 1)
            .unwrap();
        let images = names.map(new_image);
        let (answer, ids) = store
            .add_answer(
                conversation,
                &Answer {
                    images: &images,
                    ..answer(AnswerState::Stopped, "Here")
                },
                2,
            )
            .unwrap();
        (conversation, answer, ids.try_into().unwrap())
    }

    /// The path an approval of `image` writes in these tests.
    fn path_of(image: i64) -> String {
        format!("images/{image}.png")
    }

    /// Takes a not-generated image to `state` through the operations that lead there.
    fn drive(store: &mut Store, image: i64, state: ImageState) {
        if state == ImageState::NotGenerated {
            return;
        }
        store.start_generating(image).unwrap();
        if state == ImageState::Generating {
            return;
        }
        store.generated(image, "image/png", PNG, None).unwrap();
        if state == ImageState::Rejected {
            store.reject_image(image).unwrap();
        }
        if matches!(state, ImageState::Pending | ImageState::Rejected) {
            return;
        }
        store
            .begin_approving(image, &path_of(image), Some(CHANGE))
            .unwrap();
        if state == ImageState::Approving {
            return;
        }
        store.settle_image(image, true).unwrap();
        if state == ImageState::Undoing {
            store.begin_undoing(image).unwrap();
        }
    }

    /// Adds a message regenerating `image` to `conversation`, and an answer whose one image
    /// revises it, which is pending; returns that image's id.
    fn regenerate(store: &mut Store, conversation: i64, image: i64) -> i64 {
        store
            .add_user_message(Some(conversation), "Brighter", Some(image), 5)
            .unwrap();
        let revising = [NewImage {
            revises: Some(image),
            ..new_image("Gate at dawn")
        }];
        let (_, ids) = store
            .add_answer(
                conversation,
                &Answer {
                    images: &revising,
                    ..answer(AnswerState::Complete, "Again")
                },
                6,
            )
            .unwrap();
        drive(store, ids[0], ImageState::Pending);
        ids[0]
    }

    /// The number of rows in each table format 3 added, in the world's file.
    fn image_rows_in_file(app_data: &TempDir) -> [i64; 2] {
        let connection = Connection::open(file_of(app_data)).unwrap();
        ["images", "image_bytes"].map(|table| {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        })
    }

    fn state_of(store: &Store, image: i64) -> ImageState {
        store.image(image).unwrap().image.state
    }

    #[test]
    fn an_answer_keeps_its_images_notes_and_bytes_and_a_regeneration_its_image_across_reopening() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let conversation = store.add_user_message(None, "Draw", None, 1).unwrap();
        store
            .add_answer(conversation, &answer(AnswerState::Complete, "Plain"), 2)
            .unwrap();
        store
            .add_user_message(Some(conversation), "Again", None, 3)
            .unwrap();
        let requested = [
            NewImage {
                frame: ImageFrame::Landscape,
                ..new_image("Gate")
            },
            NewImage {
                reason: NotGenerated::OverLimit,
                revises: Some(999),
                ..new_image("Tower")
            },
        ];
        let (first, ids) = store
            .add_answer(
                conversation,
                &Answer {
                    images: &requested,
                    image_unreadable: 2,
                    image_unfinished: true,
                    ..answer(AnswerState::Complete, "Here")
                },
                4,
            )
            .unwrap();
        let [gate, tower] = ids[..] else {
            panic!("two images are saved, not {ids:?}");
        };
        drive(&mut store, gate, ImageState::Pending);
        store
            .add_user_message(Some(conversation), "Brighter", Some(gate), 5)
            .unwrap();
        assert_eq!(
            store.last_regeneration(conversation).unwrap(),
            Some(Regenerated {
                image: gate,
                name: "Gate".to_owned(),
                prompt: "An ink drawing of Gate".to_owned(),
            })
        );
        let revising = [NewImage {
            revises: Some(gate),
            ..new_image("Gate at dawn")
        }];
        let (second, revised) = store
            .add_answer(
                conversation,
                &Answer {
                    images: &revising,
                    ..answer(AnswerState::Complete, "Again")
                },
                6,
            )
            .unwrap();
        assert_eq!(store.last_regeneration(conversation).unwrap(), None);
        let other = store.add_user_message(None, "Other", None, 7).unwrap();
        for (conversation, image) in [(Some(other), gate), (None, gate), (Some(conversation), 999)]
        {
            assert_eq!(
                store
                    .add_user_message(conversation, "Lost", Some(image), 8)
                    .unwrap_err()
                    .kind,
                ErrorKind::NotFound,
                "a message regenerates only an image of its own conversation"
            );
        }
        drop(store);

        let store = opened(&app_data);

        // The fifth message, after Draw, Plain, Again and Here.
        let message = 4;
        assert!(
            matches!(
                &store.conversation(conversation).unwrap().messages[message as usize],
                SavedMessage::User { text, .. } if text == "Brighter"
            ),
            "a regeneration's position names its message in the conversation's list"
        );
        let not_generated = |id, name: &str, reason| SavedImage {
            id,
            name: name.to_owned(),
            frame: ImageFrame::Portrait,
            prompt: format!("An ink drawing of {name}"),
            revises: None,
            reference: None,
            state: ImageState::NotGenerated,
            reason: Some(reason),
            undone: false,
            path: None,
            change: None,
        };
        let gate_image = SavedImage {
            frame: ImageFrame::Landscape,
            state: ImageState::Pending,
            reason: None,
            ..not_generated(gate, "Gate", NotGenerated::Interrupted)
        };
        assert_eq!(
            store.images(conversation).unwrap(),
            SavedImages {
                answers: vec![
                    SavedAnswerImages {
                        answer: first,
                        unreadable: 2,
                        unfinished: true,
                        images: vec![
                            gate_image.clone(),
                            not_generated(tower, "Tower", NotGenerated::OverLimit),
                        ],
                    },
                    SavedAnswerImages {
                        answer: second,
                        unreadable: 0,
                        unfinished: false,
                        images: vec![SavedImage {
                            revises: Some(gate),
                            ..not_generated(revised[0], "Gate at dawn", NotGenerated::Interrupted)
                        }],
                    },
                ],
                regenerations: vec![SavedRegeneration {
                    message,
                    image: gate,
                    name: "Gate".to_owned(),
                }],
            },
            "only answers with images or notes are listed, and a missing image is revised by none"
        );
        assert_eq!(
            store.image(gate).unwrap(),
            StoredImage {
                conversation,
                answer: first,
                image: gate_image,
                bytes: Some(png()),
            }
        );
        assert_eq!(store.image(tower).unwrap().bytes, None);
        assert_eq!(store.image(999).unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(store.images(99).unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(
            store.images(other).unwrap(),
            SavedImages {
                answers: vec![],
                regenerations: vec![],
            }
        );
    }

    #[test]
    fn each_image_operation_moves_an_image_only_from_its_own_state() {
        type Operation = fn(&mut Store, i64) -> Result<(), AppError>;
        let operations: [(&str, ImageState, Operation, ImageState); 6] = [
            (
                "start generating",
                ImageState::NotGenerated,
                |store, image| store.start_generating(image),
                ImageState::Generating,
            ),
            (
                "generated",
                ImageState::Generating,
                |store, image| store.generated(image, "image/png", PNG, None),
                ImageState::Pending,
            ),
            (
                "not generated",
                ImageState::Generating,
                |store, image| store.not_generated(image, NotGenerated::Cancelled),
                ImageState::NotGenerated,
            ),
            (
                "reject",
                ImageState::Pending,
                |store, image| store.reject_image(image),
                ImageState::Rejected,
            ),
            (
                "begin approving",
                ImageState::Pending,
                |store, image| store.begin_approving(image, "images/Gate.png", None),
                ImageState::Approving,
            ),
            (
                "begin undoing",
                ImageState::Approved,
                |store, image| store.begin_undoing(image),
                ImageState::Undoing,
            ),
        ];
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        for (name, from, operation, to) in operations {
            for state in IMAGE_STATES {
                let (_, _, [image]) = with_images(&mut store, None, ["Gate"]);
                drive(&mut store, image, state);

                let result = operation(&mut store, image);

                if state == from {
                    result.unwrap();
                    assert_eq!(state_of(&store, image), to, "{name}");
                } else {
                    assert_eq!(
                        result.unwrap_err().kind,
                        ErrorKind::Conflict,
                        "{name} from {state:?}"
                    );
                    assert_eq!(state_of(&store, image), state, "{name} from {state:?}");
                }
            }
            assert_eq!(
                operation(&mut store, 999).unwrap_err().kind,
                ErrorKind::NotFound,
                "{name}"
            );
        }
        // Refusals are not failures: the store still saves to its file.
        assert_eq!(store.conversations().unwrap().notice, None);
    }

    #[test]
    fn operations_keep_reasons_bytes_and_paths_and_a_rejection_deletes_the_bytes() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (_, _, [image, rejected]) = with_images(&mut store, None, ["Gate", "Tower"]);

        store.start_generating(image).unwrap();
        assert_eq!(store.image(image).unwrap().image.reason, None);
        store.not_generated(image, NotGenerated::Failed).unwrap();
        assert_eq!(
            store.image(image).unwrap().image.reason,
            Some(NotGenerated::Failed)
        );
        store.start_generating(image).unwrap();
        store
            .generated(image, "image/png", PNG, Some(ImageReference::NotTaken))
            .unwrap();
        store
            .begin_approving(image, "images/Gate.png", Some(CHANGE))
            .unwrap();
        let stored = store.image(image).unwrap();
        assert_eq!(
            (
                stored.image.reason,
                stored.image.reference,
                stored.image.path.as_deref(),
                stored.image.change,
                stored.bytes
            ),
            (
                None,
                Some(ImageReference::NotTaken),
                Some("images/Gate.png"),
                Some(CHANGE),
                Some(png())
            )
        );

        drive(&mut store, rejected, ImageState::Pending);
        assert_eq!(image_rows_in_file(&app_data), [2, 2]);
        store.reject_image(rejected).unwrap();
        assert_eq!(store.image(rejected).unwrap().bytes, None);
        assert_eq!(image_rows_in_file(&app_data), [2, 1]);
    }

    #[test]
    fn settling_a_marked_image_follows_its_file_and_leaves_other_images_alone() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        // The mark, whether the file holds the image's bytes, and the state and undone mark that
        // follow, with whether the path and change are kept.
        let cases = [
            (
                ImageState::Approving,
                true,
                ImageState::Approved,
                false,
                true,
            ),
            (
                ImageState::Approving,
                false,
                ImageState::Pending,
                false,
                false,
            ),
            (ImageState::Undoing, true, ImageState::Approved, false, true),
            (ImageState::Undoing, false, ImageState::Pending, true, false),
        ];
        for (mark, written, state, undone, kept) in cases {
            let (_, _, [image]) = with_images(&mut store, None, ["Gate"]);
            drive(&mut store, image, mark);

            assert_eq!(
                store.settle_image(image, written).unwrap(),
                Settling::Settled
            );

            let stored = store.image(image).unwrap();
            let case = format!("{mark:?} written: {written}");
            assert_eq!(
                (
                    stored.image.state,
                    stored.image.undone,
                    stored.image.path.is_some(),
                    stored.image.change.is_some()
                ),
                (state, undone, kept, kept),
                "{case}"
            );
            assert_eq!(stored.bytes, Some(png()), "{case}");
            assert_eq!(
                store.settle_image(image, !written).unwrap(),
                Settling::AlreadySettled,
                "{case}"
            );
        }

        // Approved again, an undone image is no longer undone.
        let (_, _, [image]) = with_images(&mut store, None, ["Gate"]);
        drive(&mut store, image, ImageState::Undoing);
        store.settle_image(image, false).unwrap();
        store
            .begin_approving(image, "images/Gate.png", None)
            .unwrap();
        store.settle_image(image, true).unwrap();
        assert!(!store.image(image).unwrap().image.undone);

        for state in IMAGE_STATES {
            if matches!(state, ImageState::Approving | ImageState::Undoing) {
                continue;
            }
            let (_, _, [image]) = with_images(&mut store, None, ["Gate"]);
            drive(&mut store, image, state);
            assert_eq!(
                store.settle_image(image, false).unwrap(),
                Settling::AlreadySettled,
                "{state:?}"
            );
            assert_eq!(state_of(&store, image), state, "{state:?}");
        }
        assert_eq!(
            store.settle_image(999, true).unwrap(),
            Settling::AlreadySettled
        );
    }

    #[test]
    fn retry_is_refused_while_an_image_of_the_stopped_answer_is_approved_and_removes_its_images() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (conversation, _, [image, other]) = with_images(&mut store, None, ["Gate", "Tower"]);
        drive(&mut store, other, ImageState::Pending);
        drive(&mut store, image, ImageState::Pending);
        let refused = |store: &mut Store, while_: &str| {
            assert_eq!(
                store.prepare_retry(conversation).unwrap_err().kind,
                ErrorKind::Conflict,
                "while {while_}"
            );
        };

        store
            .begin_approving(image, "images/Gate.png", None)
            .unwrap();
        refused(&mut store, "it is being approved");
        store.settle_image(image, true).unwrap();
        refused(&mut store, "it is approved");
        store.begin_undoing(image).unwrap();
        refused(&mut store, "its approval is being undone");
        store.settle_image(image, false).unwrap();

        assert_eq!(store.prepare_retry(conversation).unwrap(), "Draw");
        assert_eq!(store.messages(conversation).unwrap(), [user("Draw")]);
        assert_eq!(image_rows_in_file(&app_data), [0, 0]);
    }

    #[test]
    fn images_left_generating_open_as_interrupted_and_marks_are_listed_once() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (_, _, [generating, approving, undoing, pending]) =
            with_images(&mut store, None, ["Gate", "Tower", "Quay", "Moor"]);
        drive(&mut store, generating, ImageState::Generating);
        drive(&mut store, approving, ImageState::Approving);
        drive(&mut store, undoing, ImageState::Undoing);
        drive(&mut store, pending, ImageState::Pending);
        assert_eq!(store.take_image_marks(), []);
        drop(store);

        let mut store = opened(&app_data);
        store
            .begin_approving(pending, "images/Moor.png", None)
            .unwrap();

        let interrupted = store.image(generating).unwrap().image;
        assert_eq!(
            (interrupted.state, interrupted.reason),
            (ImageState::NotGenerated, Some(NotGenerated::Interrupted))
        );
        assert_eq!(
            store.take_image_marks(),
            [
                ImageMark {
                    image: approving,
                    path: path_of(approving)
                },
                ImageMark {
                    image: undoing,
                    path: path_of(undoing)
                }
            ]
        );
        assert_eq!(store.take_image_marks(), []);
        assert_eq!(store.conversations().unwrap().notice, None);
        drop(store);
        let store = opened(&app_data);
        assert_eq!(state_of(&store, generating), ImageState::NotGenerated);
    }

    #[test]
    fn earlier_messages_carry_a_line_for_each_image_and_what_became_of_it() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let names = [
            "Gate", "Tower", "Quay", "Moor", "Fen", "Ford", "Mill", "Weir",
        ];
        let (conversation, _, ids) = with_images(&mut store, None, names);
        let states = [
            ImageState::NotGenerated,
            ImageState::Generating,
            ImageState::Pending,
            ImageState::Approving,
            ImageState::Approved,
            ImageState::Undoing,
            ImageState::Rejected,
            ImageState::Undoing,
        ];
        for (image, state) in ids.into_iter().zip(states) {
            drive(&mut store, image, state);
        }
        store.settle_image(ids[7], false).unwrap();

        let messages = store.messages(conversation).unwrap();

        assert_eq!(
            messages[1].images,
            [
                "[Image \"Gate\": not generated]".to_owned(),
                "[Image \"Tower\": not generated]".to_owned(),
                "[Image \"Quay\": pending]".to_owned(),
                "[Image \"Moor\": pending]".to_owned(),
                format!("[Image \"Fen\": saved as {}]", path_of(ids[4])),
                format!("[Image \"Ford\": saved as {}]", path_of(ids[5])),
                "[Image \"Mill\": rejected]".to_owned(),
                "[Image \"Weir\": undone]".to_owned(),
            ]
        );
        assert_eq!(messages[0].images, Vec::<String>::new());
    }

    #[test]
    fn an_image_deleted_with_its_conversation_or_a_retried_answer_never_gives_its_id_to_a_new_one()
    {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (kept, _, _) = with_images(&mut store, None, ["Gate"]);
        let (deleted, _, [highest]) = with_images(&mut store, None, ["Tower"]);
        store.delete(deleted).unwrap();

        let (retried, _, [after_delete]) = with_images(&mut store, Some(kept), ["Quay"]);
        assert!(after_delete > highest, "{after_delete} after {highest}");

        store.prepare_retry(retried).unwrap();
        let (_, _, [after_retry]) = with_images(&mut store, None, ["Moor"]);
        assert!(
            after_retry > after_delete,
            "{after_retry} after {after_delete}"
        );
    }

    #[test]
    fn a_store_that_moves_to_memory_keeps_counting_past_a_deleted_image() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        with_images(&mut store, None, ["Gate"]);
        let (deleted, _, [highest]) = with_images(&mut store, None, ["Tower"]);
        store.delete(deleted).unwrap();

        store.move_to_memory("Gone".to_owned());
        let (_, _, [next]) = with_images(&mut store, None, ["Quay"]);

        assert!(!store.saving);
        assert!(next > highest, "{next} after {highest}");
    }

    #[test]
    fn reopening_numbers_new_images_past_the_highest_one_stored() {
        let app_data = tempfile::tempdir().unwrap();
        let mut store = opened(&app_data);
        let (_, _, [_, highest]) = with_images(&mut store, None, ["Gate", "Tower"]);
        drop(store);

        let mut store = opened(&app_data);
        let (_, _, [next]) = with_images(&mut store, None, ["Quay"]);

        assert_eq!(next, highest + 1);
    }
}
