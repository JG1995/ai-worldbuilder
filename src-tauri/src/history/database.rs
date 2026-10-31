//! The history database of one world: where its file is, its format, and opening it.
//!
//! Each world's history is one SQLite file, `<app data dir>/grimoire-data/history/<name>.sqlite`.
//! The name is the 64-bit FNV-1a hash of the world folder's path, the string the recent list
//! stores, in 16 lowercase hex digits. The database records that path too, so two paths with the
//! same hash never share a history.
//!
//! Format 1, named by `PRAGMA user_version`:
//!
//! - `meta`: one row, the world folder's path.
//! - `changes`: one row per change: its `kind` (`edit`, `new_page`, `new_folder`,
//!   `restored_missing`, `keep_mine`, `restore` or `undo`), `started` and `latest`, the times of its
//!   first and latest write in seconds since the Unix epoch, and `pending`, 1 while a write of the
//!   change is in flight.
//! - `entries`: one row per path a change touched, keyed by (`change_id`, `path`), with the state
//!   before and after (`absent`, `folder` or `page`, a page with its exact bytes), and
//!   `pending_after`, the bytes of a save in flight that extends the change. Deleting a change
//!   deletes its entries.
//!
//! The database keeps SQLite's default rollback journal and syncs fully, so a committed record
//! survives a crash or a power loss.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};

use super::Failure;

/// The format this version writes. A database in a newer format is never written.
const FORMAT: i64 = 1;

const SCHEMA: &str = "
    CREATE TABLE meta (world TEXT NOT NULL);
    CREATE TABLE changes (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        started INTEGER NOT NULL,
        latest INTEGER NOT NULL,
        pending INTEGER NOT NULL
    );
    CREATE INDEX changes_by_latest ON changes (latest);
    CREATE TABLE entries (
        change_id INTEGER NOT NULL REFERENCES changes (id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        before_kind TEXT NOT NULL,
        after_kind TEXT NOT NULL,
        before_bytes BLOB,
        after_bytes BLOB,
        pending_after BLOB,
        PRIMARY KEY (change_id, path)
    );
    CREATE INDEX entries_by_path ON entries (path, change_id);
";

/// A world's open history database.
pub struct Database {
    pub connection: Connection,
    /// The database that was there was damaged, so it was set aside and this one replaced it.
    pub set_aside: bool,
}

/// Why a database could not be used as it is.
enum Refusal {
    /// SQLite cannot read the file as a database; it is set aside and replaced.
    Damaged,
    /// Anything else, which leaves the file as it is.
    Failed(Failure),
}

impl From<rusqlite::Error> for Refusal {
    fn from(error: rusqlite::Error) -> Self {
        match error.sqlite_error_code() {
            Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt) => Self::Damaged,
            _ => Self::Failed(error.into()),
        }
    }
}

/// Opens the history database of the world at `world`, in `app_data`, and creates it when there is
/// none. `now` names a damaged database that is set aside.
pub fn open(app_data: &Path, world: &Path, now: u64) -> Result<Database, Failure> {
    let world = world.to_str().ok_or_else(|| {
        Failure::new("The world folder's path is not valid Unicode, so its history cannot be kept.")
    })?;
    let file = file(app_data, world);
    let folder = file.parent().expect("the database file is inside a folder");
    fs::create_dir_all(folder).map_err(Failure::io)?;
    match connect(&file, world) {
        Ok(connection) => {
            return Ok(Database {
                connection,
                set_aside: false,
            });
        }
        Err(Refusal::Failed(failure)) => return Err(failure),
        // `connect` has closed the damaged database, so Windows lets it be renamed.
        Err(Refusal::Damaged) => set_aside(&file, now)?,
    }
    match connect(&file, world) {
        Ok(connection) => Ok(Database {
            connection,
            set_aside: true,
        }),
        Err(Refusal::Failed(failure)) => Err(failure),
        Err(Refusal::Damaged) => Err(Failure::new(
            "A new history database could not be created in place of a damaged one.",
        )),
    }
}

/// The database file of the world whose folder's path is `world`.
pub fn file(app_data: &Path, world: &str) -> PathBuf {
    app_data
        .join("grimoire-data")
        .join("history")
        .join(format!("{:016x}.sqlite", fnv1a_64(world.as_bytes())))
}

/// The 64-bit FNV-1a hash. It is written out here because std's `DefaultHasher` may change between
/// Rust releases, and the hash names a file that must be found again.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

/// Opens the database at `file` for the world at `world`, creating format 1 in an empty one. On
/// any refusal the connection is closed before this returns.
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
            return Err(Refusal::Failed(Failure::new(
                "The history database is in a newer format than this version of Grimoire.md knows.",
            )));
        }
    }
    Ok(connection)
}

/// Creates format 1 in one transaction, in a database that holds nothing yet.
fn create(connection: &mut Connection, world: &str) -> Result<(), Refusal> {
    let transaction = connection.transaction()?;
    let objects: i64 =
        transaction.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
    if objects > 0 {
        return Err(Refusal::Failed(Failure::new(
            "The history database holds data in a format Grimoire.md does not know.",
        )));
    }
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
        Err(Refusal::Failed(Failure::new(
            "The history database belongs to another world folder.",
        )))
    }
}

/// Renames a damaged database, and its journal first, so the new database cannot take the old
/// journal for its own, to their names with `.damaged-<now>` appended. An earlier set-aside file of
/// the same name is never replaced.
fn set_aside(file: &Path, now: u64) -> Result<(), Failure> {
    let suffix = format!(".damaged-{now}");
    let journal = with_suffix(file, "-journal");
    if journal.exists() {
        rename_new(&journal, &with_suffix(&journal, &suffix))?;
    }
    rename_new(file, &with_suffix(file, &suffix))
}

fn rename_new(from: &Path, to: &Path) -> Result<(), Failure> {
    if to.exists() {
        return Err(Failure::new(
            "A damaged history database could not be set aside, because its new name is taken.",
        ));
    }
    fs::rename(from, to).map_err(Failure::io)
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;
    use tempfile::TempDir;

    const WORLD: &str = "/home/tester/Worlds/Kesh";

    fn opened(app_data: &TempDir) -> Result<Database, Failure> {
        open(app_data.path(), Path::new(WORLD), 1_000)
    }

    fn format_and_world(file: &Path) -> (i64, String) {
        let connection = Connection::open(file).unwrap();
        let format = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let world = connection
            .query_row("SELECT world FROM meta", [], |row| row.get(0))
            .unwrap();
        (format, world)
    }

    /// The bytes and modification time of a file, which a refused database keeps.
    fn snapshot(file: &Path) -> (Vec<u8>, SystemTime) {
        (
            fs::read(file).unwrap(),
            fs::metadata(file).unwrap().modified().unwrap(),
        )
    }

    #[test]
    fn the_file_name_is_the_fnv_1a_hash_of_the_world_path() {
        // The published FNV-1a test vectors, and one world path: a different name would lose
        // every world's history.
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(
            file(Path::new("/data"), WORLD),
            Path::new("/data/grimoire-data/history/1cbd906087384643.sqlite")
        );
    }

    #[test]
    fn a_new_world_creates_its_database_in_format_1_and_a_second_open_reuses_it() {
        let app_data = tempfile::tempdir().unwrap();

        let first = opened(&app_data).unwrap();
        assert!(!first.set_aside);
        first
            .connection
            .execute(
                "INSERT INTO changes (kind, started, latest, pending) VALUES ('edit', 1, 1, 0)",
                [],
            )
            .unwrap();
        drop(first);
        let second = opened(&app_data).unwrap();

        let file = file(app_data.path(), WORLD);
        assert_eq!(format_and_world(&file), (1, WORLD.to_owned()));
        let changes: i64 = second
            .connection
            .query_row("SELECT count(*) FROM changes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(changes, 1);
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn a_damaged_database_is_set_aside_with_its_bytes_and_a_new_one_replaces_it() {
        let app_data = tempfile::tempdir().unwrap();
        let file = file(app_data.path(), WORLD);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        // Bytes that are not a database, from a fixed linear congruential sequence.
        let damaged: Vec<u8> = (0u32..8192)
            .map(|index| (index.wrapping_mul(1_103_515_245).wrapping_add(12_345) >> 16) as u8)
            .collect();
        fs::write(&file, &damaged).unwrap();

        let database = opened(&app_data).unwrap();

        assert!(database.set_aside);
        assert_eq!(
            fs::read(with_suffix(&file, ".damaged-1000")).unwrap(),
            damaged
        );
        assert_eq!(format_and_world(&file), (1, WORLD.to_owned()));
    }

    #[test]
    fn a_newer_database_and_another_world_s_database_are_refused_and_left_unchanged() {
        let app_data = tempfile::tempdir().unwrap();
        let file = file(app_data.path(), WORLD);
        drop(opened(&app_data).unwrap());

        let connection = Connection::open(&file).unwrap();
        connection.pragma_update(None, "user_version", 2).unwrap();
        drop(connection);
        let newer = snapshot(&file);
        let refused = opened(&app_data).err().unwrap();
        assert_eq!(
            refused.reason(),
            "The history database is in a newer format than this version of Grimoire.md knows."
        );
        assert_eq!(snapshot(&file), newer);

        let connection = Connection::open(&file).unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
            .execute("UPDATE meta SET world = '/home/tester/Worlds/Other'", [])
            .unwrap();
        drop(connection);
        let other = snapshot(&file);
        let refused = opened(&app_data).err().unwrap();
        assert_eq!(
            refused.reason(),
            "The history database belongs to another world folder."
        );
        assert_eq!(snapshot(&file), other);
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }
}
