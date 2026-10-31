//! The `history` area: the changes the application makes to a world, kept in the world's database
//! in the app data folder. It knows nothing about Tauri, the webview or confinement, and it never
//! reads or writes a world folder: the world area gives it paths and bytes, and a closure when it
//! needs to know what is on disk.
//!
//! A write that replaces something commits a pending record of the states before and after, then
//! writes, then completes the record, or abandons it when the write fails. When the world next
//! opens, a pending record left by a crash is removed only when every path it touched still holds
//! its state before; otherwise it is completed, so the bytes a write replaced are never lost.

mod database;

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, ErrorCode, OptionalExtension, Transaction, params};

/// How long saves of one page keep extending the change of its editing session: 5 minutes.
const SESSION_SECONDS: u64 = 5 * 60;
/// How old a change must be before it is removed when the world opens: 90 days.
const RETENTION_SECONDS: u64 = 90 * 24 * 60 * 60;
/// How many of the most recent changes are kept whatever their age.
const KEPT_CHANGES: i64 = 100;

/// Why history could not record, as the not-recording notice gives it: a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure(String);

impl Failure {
    fn new(reason: impl Into<String>) -> Self {
        Self(reason.into())
    }

    fn io(error: std::io::Error) -> Self {
        Self(crate::error::AppError::from(error).message)
    }

    pub fn reason(&self) -> &str {
        &self.0
    }

    pub fn into_reason(self) -> String {
        self.0
    }
}

impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        match error.sqlite_error_code() {
            Some(ErrorCode::DiskFull) => Self::new("The disk is full."),
            Some(ErrorCode::CannotOpen | ErrorCode::ReadOnly | ErrorCode::PermissionDenied) => {
                Self::new("The history database cannot be written.")
            }
            _ => Self(format!("The history database reported an error: {error}.")),
        }
    }
}

/// What is at a path of the world.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Absent,
    Folder,
    /// A page, with its exact bytes.
    Page(Vec<u8>),
}

impl State {
    fn kind(&self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Folder => "folder",
            Self::Page(_) => "page",
        }
    }

    fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Page(bytes) => Some(bytes),
            _ => None,
        }
    }

    fn stored(kind: &str, bytes: Option<Vec<u8>>) -> Self {
        match (kind, bytes) {
            ("page", Some(bytes)) => Self::Page(bytes),
            ("folder", _) => Self::Folder,
            _ => Self::Absent,
        }
    }
}

/// How a change came about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Edit,
    NewPage,
    NewFolder,
    RestoredMissing,
    KeepMine,
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Restore this version records it from PR page-history"
        )
    )]
    Restore,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "Undo records it from PR page-history")
    )]
    Undo,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::NewPage => "new_page",
            Self::NewFolder => "new_folder",
            Self::RestoredMissing => "restored_missing",
            Self::KeepMine => "keep_mine",
            Self::Restore => "restore",
            Self::Undo => "undo",
        }
    }
}

/// One path a change touches, relative to the world, with its states before and after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub before: State,
    pub after: State,
}

/// A pending record of a write in flight, which `complete` or `abandon` ends.
#[derive(Debug)]
pub struct Record {
    change: i64,
    /// The path of the editing session the write extends, whose bytes wait in `pending_after`.
    extends: Option<String>,
    now: u64,
}

/// The editing session of one path in this opening: the change its saves extend.
#[derive(Debug, Clone, Copy)]
struct Session {
    change: i64,
    started: u64,
}

/// The history of one opening of a world.
pub struct History {
    connection: Connection,
    /// Each path's editing session. A new opening starts without any.
    sessions: HashMap<String, Session>,
}

/// The result of opening a world's history.
pub struct Opened {
    /// None when the database could not be opened, or when it must not be written.
    pub history: Option<History>,
    /// Why changes are not being recorded, when they are not.
    pub not_recording: Option<Failure>,
    /// A damaged database was set aside and a new one replaced it.
    pub set_aside: bool,
}

impl History {
    /// Opens the history of the world at `world`, kept in `app_data`, at the time `now`, in seconds
    /// since the Unix epoch. It resolves the records that writes left pending, with `state_of`
    /// giving what is at a path of the world now, then removes the changes past retention.
    pub fn open(
        app_data: &Path,
        world: &Path,
        now: u64,
        state_of: impl FnMut(&str) -> State,
    ) -> Opened {
        match database::open(app_data, world, now) {
            Err(failure) => Opened {
                history: None,
                not_recording: Some(failure),
                set_aside: false,
            },
            Ok(database) => {
                let mut history = Self {
                    connection: database.connection,
                    sessions: HashMap::new(),
                };
                let ready = history.recover(state_of).and_then(|()| history.retain(now));
                Opened {
                    history: Some(history),
                    not_recording: ready.err(),
                    set_aside: database.set_aside,
                }
            }
        }
    }

    /// Commits a pending record of a write about to replace `entries`' states before.
    pub fn begin(&mut self, kind: Kind, entries: &[Entry], now: u64) -> Result<Record, Failure> {
        let change = self.insert(kind, entries, now, true)?;
        Ok(Record {
            change,
            extends: None,
            now,
        })
    }

    /// Records a write that is already done, such as a new page or folder, which replaced nothing.
    pub fn add(&mut self, kind: Kind, entries: &[Entry], now: u64) -> Result<(), Failure> {
        self.insert(kind, entries, now, false).map(drop)
    }

    /// Commits a pending record of a save of the page at `path` from `before` to `after`. The save
    /// extends the path's editing session when the session started less than 5 minutes before
    /// `now`, its change is still the path's latest, and the page still holds the bytes the change
    /// left; otherwise it starts a new `edit` change, which becomes the path's session.
    pub fn begin_save(
        &mut self,
        path: &str,
        before: &[u8],
        after: &[u8],
        now: u64,
    ) -> Result<Record, Failure> {
        if let Some(session) = self.sessions.get(path).copied()
            && now < session.started + SESSION_SECONDS
            && self.continues(session.change, path, before)?
        {
            let transaction = self.connection.transaction()?;
            transaction.execute(
                "UPDATE entries SET pending_after = ?1 WHERE change_id = ?2 AND path = ?3",
                params![after, session.change, path],
            )?;
            set_pending(&transaction, session.change, true)?;
            transaction.commit()?;
            return Ok(Record {
                change: session.change,
                extends: Some(path.to_owned()),
                now,
            });
        }
        let entry = Entry {
            path: path.to_owned(),
            before: State::Page(before.to_vec()),
            after: State::Page(after.to_vec()),
        };
        let record = self.begin(Kind::Edit, &[entry], now)?;
        self.sessions.insert(
            path.to_owned(),
            Session {
                change: record.change,
                started: now,
            },
        );
        Ok(record)
    }

    /// Completes a record once its write is in place.
    pub fn complete(&mut self, record: Record) -> Result<(), Failure> {
        let transaction = self.connection.transaction()?;
        if let Some(path) = &record.extends {
            transaction.execute(
                "UPDATE entries SET after_bytes = pending_after, pending_after = NULL
                 WHERE change_id = ?1 AND path = ?2",
                params![record.change, path],
            )?;
            transaction.execute(
                "UPDATE changes SET latest = ?1 WHERE id = ?2",
                params![record.now as i64, record.change],
            )?;
        }
        set_pending(&transaction, record.change, false)?;
        Ok(transaction.commit()?)
    }

    /// Removes a record whose write failed, so history shows no change for it. A save that extended
    /// a session leaves the session's change as it was.
    pub fn abandon(&mut self, record: Record) -> Result<(), Failure> {
        let transaction = self.connection.transaction()?;
        if let Some(path) = &record.extends {
            transaction.execute(
                "UPDATE entries SET pending_after = NULL WHERE change_id = ?1 AND path = ?2",
                params![record.change, path],
            )?;
            set_pending(&transaction, record.change, false)?;
        } else {
            transaction.execute("DELETE FROM changes WHERE id = ?1", [record.change])?;
            self.sessions
                .retain(|_, session| session.change != record.change);
        }
        Ok(transaction.commit()?)
    }

    /// Inserts a change with its entries in one commit. Any change but an edit's ends the editing
    /// sessions of its paths.
    fn insert(
        &mut self,
        kind: Kind,
        entries: &[Entry],
        now: u64,
        pending: bool,
    ) -> Result<i64, Failure> {
        for entry in entries {
            self.sessions.remove(&entry.path);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO changes (kind, started, latest, pending) VALUES (?1, ?2, ?2, ?3)",
            params![kind.name(), now as i64, pending],
        )?;
        let change = transaction.last_insert_rowid();
        {
            let mut insert = transaction.prepare(
                "INSERT INTO entries (change_id, path, before_kind, after_kind, before_bytes, after_bytes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for entry in entries {
                insert.execute(params![
                    change,
                    entry.path,
                    entry.before.kind(),
                    entry.after.kind(),
                    entry.before.bytes(),
                    entry.after.bytes(),
                ])?;
            }
        }
        transaction.commit()?;
        Ok(change)
    }

    /// Whether a save from `before` continues the session's `change` of `path`: the change is still
    /// the path's latest, and it left the page holding `before`.
    fn continues(&self, change: i64, path: &str, before: &[u8]) -> Result<bool, Failure> {
        let continues = self
            .connection
            .query_row(
                "SELECT (SELECT max(change_id) FROM entries WHERE path = ?2) = ?1
                     AND after_kind = 'page' AND after_bytes = ?3
                 FROM entries WHERE change_id = ?1 AND path = ?2",
                params![change, path, before],
                |row| row.get(0),
            )
            .optional()?;
        Ok(continues.unwrap_or(false))
    }

    /// Resolves the records that writes left pending, in one commit. A save that extended a
    /// session keeps its bytes when the page holds them. A pending change is removed when every
    /// path it touched still holds its state before, so the write did not happen, and is completed
    /// otherwise.
    fn recover(&mut self, mut state_of: impl FnMut(&str) -> State) -> Result<(), Failure> {
        let transaction = self.connection.transaction()?;
        let pending: Vec<i64> = transaction
            .prepare("SELECT id FROM changes WHERE pending = 1")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        for change in pending {
            let entries: Vec<(String, State, Option<Vec<u8>>)> = transaction
                .prepare(
                    "SELECT path, before_kind, before_bytes, pending_after
                     FROM entries WHERE change_id = ?1",
                )?
                .query_map([change], |row| {
                    let kind: String = row.get(1)?;
                    Ok((row.get(0)?, State::stored(&kind, row.get(2)?), row.get(3)?))
                })?
                .collect::<Result<_, _>>()?;
            if entries.iter().any(|(_, _, extension)| extension.is_some()) {
                for (path, _, extension) in entries {
                    let Some(bytes) = extension else { continue };
                    let written = state_of(&path) == State::Page(bytes);
                    let promote = if written {
                        "UPDATE entries SET after_bytes = pending_after, pending_after = NULL
                         WHERE change_id = ?1 AND path = ?2"
                    } else {
                        "UPDATE entries SET pending_after = NULL WHERE change_id = ?1 AND path = ?2"
                    };
                    transaction.execute(promote, params![change, path])?;
                }
                set_pending(&transaction, change, false)?;
            } else if entries
                .iter()
                .all(|(path, before, _)| state_of(path) == *before)
            {
                transaction.execute("DELETE FROM changes WHERE id = ?1", [change])?;
            } else {
                set_pending(&transaction, change, false)?;
            }
        }
        Ok(transaction.commit()?)
    }

    /// Removes the changes whose latest write is older than 90 days at `now`, except the 100 most
    /// recent changes, whatever their age.
    fn retain(&mut self, now: u64) -> Result<(), Failure> {
        let cutoff = now.saturating_sub(RETENTION_SECONDS) as i64;
        self.connection.execute(
            "DELETE FROM changes WHERE latest < ?1
             AND id < (SELECT id FROM changes ORDER BY id DESC LIMIT 1 OFFSET ?2)",
            params![cutoff, KEPT_CHANGES - 1],
        )?;
        Ok(())
    }
}

fn set_pending(transaction: &Transaction, change: i64, pending: bool) -> rusqlite::Result<usize> {
    transaction.execute(
        "UPDATE changes SET pending = ?1 WHERE id = ?2",
        params![pending, change],
    )
}

/// Reading a world's history database back, for tests across the core.
#[cfg(test)]
pub mod testing {
    use super::*;

    /// A change as the database holds it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Stored {
        pub id: i64,
        pub kind: String,
        pub started: u64,
        pub latest: u64,
        pub pending: bool,
        pub entries: Vec<StoredEntry>,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct StoredEntry {
        pub entry: Entry,
        pub pending_after: Option<Vec<u8>>,
    }

    /// The database file of the world at `world`.
    pub fn file(app_data: &Path, world: &Path) -> std::path::PathBuf {
        database::file(app_data, world.to_str().unwrap())
    }

    /// Every change in the history of the world at `world`, oldest first, read through a
    /// connection of its own.
    pub fn stored(app_data: &Path, world: &Path) -> Vec<Stored> {
        let connection = Connection::open(file(app_data, world)).unwrap();
        let mut changes: Vec<Stored> = connection
            .prepare("SELECT id, kind, started, latest, pending FROM changes ORDER BY id")
            .unwrap()
            .query_map([], |row| {
                Ok(Stored {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    started: row.get::<_, i64>(2)? as u64,
                    latest: row.get::<_, i64>(3)? as u64,
                    pending: row.get(4)?,
                    entries: Vec::new(),
                })
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut entries = connection
            .prepare(
                "SELECT path, before_kind, before_bytes, after_kind, after_bytes, pending_after
                 FROM entries WHERE change_id = ?1 ORDER BY path",
            )
            .unwrap();
        for change in &mut changes {
            change.entries = entries
                .query_map([change.id], |row| {
                    let before: String = row.get(1)?;
                    let after: String = row.get(3)?;
                    Ok(StoredEntry {
                        entry: Entry {
                            path: row.get(0)?,
                            before: State::stored(&before, row.get(2)?),
                            after: State::stored(&after, row.get(4)?),
                        },
                        pending_after: row.get(5)?,
                    })
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
        }
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{Stored, stored};
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;
    use tempfile::TempDir;

    const PAGE: &str = "Page.md";

    /// An app data folder with the history of one world, which no test reads.
    struct Fixture {
        app_data: TempDir,
        world: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                app_data: tempfile::tempdir().unwrap(),
                world: PathBuf::from("/home/tester/Worlds/Kesh"),
            }
        }

        /// Opens the history at `now`, with every path holding `on_disk`.
        fn open_with(&self, now: u64, on_disk: impl FnMut(&str) -> State) -> History {
            let opened = History::open(self.app_data.path(), &self.world, now, on_disk);
            assert_eq!(opened.not_recording, None);
            opened.history.unwrap()
        }

        fn open(&self, now: u64) -> History {
            self.open_with(now, |_| State::Absent)
        }

        fn stored(&self) -> Vec<Stored> {
            stored(self.app_data.path(), &self.world)
        }
    }

    /// Saves `PAGE` from `before` to `after` at `now`, all the way through.
    fn save(history: &mut History, before: &[u8], after: &[u8], now: u64) {
        let record = history.begin_save(PAGE, before, after, now).unwrap();
        history.complete(record).unwrap();
    }

    fn page_entry(before: &[u8], after: &[u8]) -> Entry {
        Entry {
            path: PAGE.to_owned(),
            before: State::Page(before.to_vec()),
            after: State::Page(after.to_vec()),
        }
    }

    /// Each stored change's kind and states, oldest first.
    fn kinds_and_entries(changes: &[Stored]) -> Vec<(&str, Vec<Entry>)> {
        changes
            .iter()
            .map(|change| {
                let entries = change.entries.iter().map(|e| e.entry.clone()).collect();
                (change.kind.as_str(), entries)
            })
            .collect()
    }

    #[test]
    fn saves_within_five_minutes_of_the_session_s_start_extend_one_change() {
        let fixture = Fixture::new();
        let mut history = fixture.open(0);

        save(&mut history, b"one", b"two", 0);
        save(&mut history, b"two", b"three", 120);
        save(&mut history, b"three", b"four", 301);

        let changes = fixture.stored();
        assert_eq!(
            kinds_and_entries(&changes),
            [
                ("edit", vec![page_entry(b"one", b"three")]),
                ("edit", vec![page_entry(b"three", b"four")]),
            ]
        );
        assert_eq!((changes[0].started, changes[0].latest), (0, 120));
        assert!(changes.iter().all(|change| !change.pending));
    }

    #[test]
    fn a_save_from_other_bytes_than_the_session_left_starts_a_new_change() {
        let fixture = Fixture::new();
        let mut history = fixture.open(0);

        save(&mut history, b"one", b"two", 0);
        // Another tool wrote "theirs" over "two" in between.
        save(&mut history, b"theirs", b"mine", 10);

        assert_eq!(
            kinds_and_entries(&fixture.stored()),
            [
                ("edit", vec![page_entry(b"one", b"two")]),
                ("edit", vec![page_entry(b"theirs", b"mine")]),
            ]
        );
    }

    #[test]
    fn keep_mine_a_restore_and_an_undo_never_extend_and_end_the_session() {
        for kind in [Kind::KeepMine, Kind::Restore, Kind::Undo] {
            let fixture = Fixture::new();
            let mut history = fixture.open(0);
            save(&mut history, b"one", b"two", 0);

            let record = history
                .begin(kind, &[page_entry(b"two", b"other")], 10)
                .unwrap();
            history.complete(record).unwrap();
            save(&mut history, b"other", b"three", 20);

            assert_eq!(
                kinds_and_entries(&fixture.stored()),
                [
                    ("edit", vec![page_entry(b"one", b"two")]),
                    (kind.name(), vec![page_entry(b"two", b"other")]),
                    ("edit", vec![page_entry(b"other", b"three")]),
                ]
            );
        }
    }

    #[test]
    fn a_new_opening_starts_a_new_session() {
        let fixture = Fixture::new();
        let mut history = fixture.open(0);
        save(&mut history, b"one", b"two", 0);
        drop(history);

        let mut reopened = fixture.open(10);
        save(&mut reopened, b"two", b"three", 20);

        assert_eq!(fixture.stored().len(), 2);
    }

    #[test]
    fn an_abandoned_save_leaves_no_change_and_an_abandoned_extension_leaves_the_session_s_change() {
        let fixture = Fixture::new();
        let mut history = fixture.open(0);

        let record = history.begin_save(PAGE, b"one", b"two", 0).unwrap();
        history.abandon(record).unwrap();
        assert!(fixture.stored().is_empty());

        save(&mut history, b"one", b"two", 10);
        let record = history.begin_save(PAGE, b"two", b"three", 20).unwrap();
        history.abandon(record).unwrap();
        save(&mut history, b"two", b"four", 30);

        let changes = fixture.stored();
        assert_eq!(
            kinds_and_entries(&changes),
            [("edit", vec![page_entry(b"one", b"four")])]
        );
        assert_eq!(changes[0].entries[0].pending_after, None);
    }

    /// Leaves `PAGE` with a pending new change from "old" to "new", as a crash before `complete`
    /// would, and returns the fixture.
    fn crashed_during_a_save() -> Fixture {
        let fixture = Fixture::new();
        let mut history = fixture.open(0);
        history.begin_save(PAGE, b"old", b"new", 0).unwrap();
        fixture
    }

    #[test]
    fn recovery_removes_a_pending_change_whose_paths_hold_their_states_before() {
        let fixture = crashed_during_a_save();
        assert!(fixture.stored()[0].pending);

        fixture.open_with(10, |_| State::Page(b"old".to_vec()));

        assert!(fixture.stored().is_empty());
    }

    #[test]
    fn recovery_completes_a_pending_change_whose_path_holds_its_state_after_other_bytes_or_nothing()
    {
        for on_disk in [
            State::Page(b"new".to_vec()),
            State::Page(b"other".to_vec()),
            State::Absent,
        ] {
            let fixture = crashed_during_a_save();

            fixture.open_with(10, |_| on_disk.clone());

            let changes = fixture.stored();
            assert_eq!(
                kinds_and_entries(&changes),
                [("edit", vec![page_entry(b"old", b"new")])]
            );
            assert!(!changes[0].pending);
        }
    }

    #[test]
    fn recovery_removes_a_restore_only_when_every_path_is_still_absent() {
        let restored = [
            Entry {
                path: "Places".to_owned(),
                before: State::Absent,
                after: State::Folder,
            },
            Entry {
                path: "Places/Kesh.md".to_owned(),
                before: State::Absent,
                after: State::Page(b"mine".to_vec()),
            },
        ];
        for (folder_on_disk, kept) in [(State::Absent, 0), (State::Folder, 1)] {
            let fixture = Fixture::new();
            let mut history = fixture.open(0);
            history.begin(Kind::RestoredMissing, &restored, 0).unwrap();

            fixture.open_with(10, |path| {
                if path == "Places" {
                    folder_on_disk.clone()
                } else {
                    State::Absent
                }
            });

            assert_eq!(fixture.stored().len(), kept);
        }
    }

    #[test]
    fn recovery_promotes_a_session_save_the_page_holds_and_clears_one_it_does_not() {
        for (on_disk, after) in [(b"three", b"three"), (b"two__", b"two__")] {
            let fixture = Fixture::new();
            let mut history = fixture.open(0);
            save(&mut history, b"one", b"two__", 0);
            history.begin_save(PAGE, b"two__", b"three", 10).unwrap();
            drop(history);

            fixture.open_with(20, |_| State::Page(on_disk.to_vec()));

            let changes = fixture.stored();
            assert_eq!(
                kinds_and_entries(&changes),
                [("edit", vec![page_entry(b"one", after)])]
            );
            assert_eq!(changes[0].entries[0].pending_after, None);
            assert!(!changes[0].pending);
        }
    }

    const DAY: u64 = 24 * 60 * 60;

    /// Adds a completed change of `PAGE` at each of `times`, with bytes naming its number.
    fn changes_at(history: &mut History, times: impl IntoIterator<Item = u64>) {
        for (number, time) in times.into_iter().enumerate() {
            let entry = page_entry(
                format!("before {number}").as_bytes(),
                format!("after {number}").as_bytes(),
            );
            history.add(Kind::KeepMine, &[entry], time).unwrap();
        }
    }

    #[test]
    fn retention_removes_changes_older_than_90_days_but_keeps_the_100_most_recent() {
        let fixture = Fixture::new();
        let now = 1_000 * DAY;
        let mut history = fixture.open(0);
        // 150 changes: 120 older than 90 days, then 30 within them.
        let old = (0..120).map(|day| now - 200 * DAY + day * DAY / 10);
        let recent = (0..30).map(|day| now - 90 * DAY + 1 + day);
        changes_at(&mut history, old.chain(recent));
        drop(history);

        fixture.open(now);

        let kept = fixture.stored();
        assert_eq!(kept.len(), 100);
        assert_eq!(kept[0].id, 51);
        assert_eq!(
            kept[0].entries[0].entry,
            page_entry(b"before 50", b"after 50")
        );
    }

    #[test]
    fn retention_keeps_the_100_most_recent_changes_of_a_world_left_alone() {
        let fixture = Fixture::new();
        let mut history = fixture.open(0);
        changes_at(&mut history, (0..105).map(|second| second * 10));
        drop(history);

        fixture.open(1_000 * DAY);

        let kept = fixture.stored();
        assert_eq!(kept.len(), 100);
        assert_eq!(kept.first().unwrap().id, 6);
        assert_eq!(
            kept.last().unwrap().entries[0].entry,
            page_entry(b"before 104", b"after 104")
        );
    }

    /// The format at the DESIGN's scale: opening a world whose history holds 10,000 changes past
    /// retention, each with a 20 KB page before and after, takes at most a second. Run it in
    /// release mode: `cargo test --release history:: -- --ignored`.
    #[test]
    #[ignore = "builds a 400 MB database; run in release mode"]
    fn opening_with_10_000_changes_past_retention_takes_at_most_a_second() {
        let fixture = Fixture::new();
        let now = 1_000 * DAY;
        let mut history = fixture.open(0);
        let page: Vec<u8> = (0..20 * 1024).map(|index| (index % 251) as u8).collect();
        {
            let transaction = history.connection.transaction().unwrap();
            for number in 0..10_000 {
                transaction
                    .execute(
                        "INSERT INTO changes (kind, started, latest, pending)
                         VALUES ('edit', ?1, ?1, 0)",
                        [number],
                    )
                    .unwrap();
                transaction
                    .execute(
                        "INSERT INTO entries
                         (change_id, path, before_kind, after_kind, before_bytes, after_bytes)
                         VALUES (?1, ?2, 'page', 'page', ?3, ?3)",
                        params![
                            transaction.last_insert_rowid(),
                            format!("Page {}.md", number % 500),
                            page
                        ],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
        }
        drop(history);

        let started = Instant::now();
        fixture.open(now);
        let elapsed = started.elapsed();

        eprintln!("Opening with recovery and retention took {elapsed:?}.");
        assert_eq!(fixture.stored().len(), 100);
        assert!(elapsed.as_secs_f64() <= 1.0, "took {elapsed:?}");
    }
}
