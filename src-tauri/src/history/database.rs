//! The history database of one world: where its file is, its format, and opening it.
//!
//! Each world's history is one SQLite file, `<app data dir>/grimoire-data/history/<name>.sqlite`.
//! The name is the 64-bit FNV-1a hash of the world folder's path, the string the recent list
//! stores, in 16 lowercase hex digits. The database records that path too, so two paths with the
//! same hash never share a history.
//!
//! Format 2, named by `PRAGMA user_version`:
//!
//! - `meta`: one row, the world folder's path.
//! - `changes`: one row per change: its `kind` (`edit`, `new_page`, `new_folder`,
//!   `restored_missing`, `keep_mine`, `restore`, `undo`, `accepted`, `rename`, `move` or `delete`),
//!   `started` and `latest`, the times of its first and latest write in seconds since the Unix
//!   epoch, and `pending`, 1 while a write of the change is in flight.
//! - `entries`: one row per path a change touched, keyed by (`change_id`, `path`), with the state
//!   before and after (`absent`, `folder` or `page`, a page with its exact bytes), and
//!   `pending_after`, the bytes of a save in flight that extends the change.
//! - `moves`: for a change that moved a page or folder, such as a rename, a move or the undo of
//!   one, the one root it moved, `from_path` to `to_path`.
//!
//! Deleting a change deletes its entries and its move. Format 1 had no `moves`; opening a format 1
//! database of the world adds the table in one transaction, so a failed update leaves format 1.
//!
//! The database keeps SQLite's default rollback journal and syncs fully, so a committed record
//! survives a crash or a power loss.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, ErrorCode};

use super::Failure;
use crate::data_file;
#[cfg(test)]
use crate::data_file::with_suffix;

/// The format this version writes. A database in a newer format is never written.
const FORMAT: i64 = 2;

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

/// What format 2 adds to format 1.
const MOVES: &str = "
    CREATE TABLE moves (
        change_id INTEGER PRIMARY KEY REFERENCES changes (id) ON DELETE CASCADE,
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL
    );
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
        .join(file_name(world))
}

/// The name of the database file of the world whose folder's path is `world`, `<16 hex
/// digits>.sqlite`. The world's page index names its cache file the same.
pub fn file_name(world: &str) -> String {
    format!("{:016x}.sqlite", fnv1a_64(world.as_bytes()))
}

/// The 64-bit FNV-1a hash. It is written out here because std's `DefaultHasher` may change between
/// Rust releases, and the hash names a file that must be found again.
pub(crate) fn fnv1a_64(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET_BASIS, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

/// Opens the database at `file` for the world at `world`, creating the format in an empty one and
/// updating a format 1 one. On any refusal the connection is closed before this returns.
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
            return Err(Refusal::Failed(Failure::new(
                "The history database is in a newer format than this version of Grimoire.md knows.",
            )));
        }
    }
    Ok(connection)
}

/// Creates the format in one transaction, in a database that holds nothing yet.
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
    transaction.execute_batch(MOVES)?;
    transaction.execute("INSERT INTO meta (world) VALUES (?1)", [world])?;
    transaction.pragma_update(None, "user_version", FORMAT)?;
    transaction.commit()?;
    Ok(())
}

/// Updates a format 1 database to the format in one transaction, so a failure leaves it format 1.
fn update_from_format_1(connection: &mut Connection) -> Result<(), Refusal> {
    let update = |connection: &mut Connection| -> rusqlite::Result<()> {
        let transaction = connection.transaction()?;
        transaction.execute_batch(MOVES)?;
        transaction.pragma_update(None, "user_version", FORMAT)?;
        transaction.commit()
    };
    update(connection).map_err(|error| {
        Refusal::Failed(Failure::new(format!(
            "The history database could not be updated to this version's format. {}",
            Failure::from(error).reason()
        )))
    })
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

/// Sets a damaged database aside with `data_file::set_aside`, which never replaces an earlier
/// set-aside file, and gives a failure in history's words.
fn set_aside(file: &Path, now: u64) -> Result<(), Failure> {
    data_file::set_aside(file, now).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            Failure::new(
                "A damaged history database could not be set aside, because its new name is taken.",
            )
        } else {
            Failure::io(error)
        }
    })
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
    fn a_new_world_creates_its_database_in_format_2_and_a_second_open_reuses_it() {
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
        assert_eq!(format_and_world(&file), (2, WORLD.to_owned()));
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
        assert_eq!(format_and_world(&file), (2, WORLD.to_owned()));
    }

    /// Writes a format 1 database of `WORLD` holding one change with one entry, then runs `extra`.
    fn write_format_1(app_data: &TempDir, extra: &str) -> PathBuf {
        let file = file(app_data.path(), WORLD);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        let connection = Connection::open(&file).unwrap();
        connection.execute_batch(SCHEMA).unwrap();
        connection
            .execute_batch(&format!(
                "INSERT INTO meta (world) VALUES ('{WORLD}');
                 INSERT INTO changes (kind, started, latest, pending) VALUES ('edit', 1, 2, 0);
                 INSERT INTO entries
                     (change_id, path, before_kind, after_kind, before_bytes, after_bytes)
                     VALUES (1, 'Page.md', 'page', 'page', x'6f6e65', x'74776f');
                 {extra}
                 PRAGMA user_version = 1;"
            ))
            .unwrap();
        file
    }

    /// Every row of `table`, as text.
    fn rows(file: &Path, table: &str) -> Vec<String> {
        let connection = Connection::open(file).unwrap();
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|column| row.get::<_, rusqlite::types::Value>(column))
                    .collect::<Result<Vec<_>, _>>()
                    .map(|values| format!("{values:?}"))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// The tables and indexes of the database at `file`, with the SQL that made them.
    fn schema(file: &Path) -> Vec<(String, Option<String>)> {
        let connection = Connection::open(file).unwrap();
        connection
            .prepare("SELECT name, sql FROM sqlite_schema ORDER BY name")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn a_format_1_database_is_updated_in_place_keeping_every_change_and_entry() {
        let app_data = tempfile::tempdir().unwrap();
        let file = write_format_1(&app_data, "");
        let before = ["meta", "changes", "entries"].map(|table| rows(&file, table));

        let database = opened(&app_data).unwrap();
        drop(database);

        assert_eq!(format_and_world(&file), (2, WORLD.to_owned()));
        assert_eq!(
            ["meta", "changes", "entries"].map(|table| rows(&file, table)),
            before
        );
        let new = tempfile::tempdir().unwrap();
        drop(opened(&new).unwrap());
        assert_eq!(schema(&file), schema(&super::file(new.path(), WORLD)));
    }

    #[test]
    fn a_format_1_database_whose_update_fails_is_refused_and_left_as_it_was() {
        let app_data = tempfile::tempdir().unwrap();
        // A table in the way of the update.
        let file = write_format_1(&app_data, "CREATE TABLE moves (id INTEGER);");
        let before = snapshot(&file);

        let refused = opened(&app_data).err().unwrap();

        assert!(
            refused
                .reason()
                .starts_with("The history database could not be updated to this version's format."),
            "{}",
            refused.reason()
        );
        assert_eq!(snapshot(&file), before);
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn a_newer_database_and_another_world_s_database_are_refused_and_left_unchanged() {
        let app_data = tempfile::tempdir().unwrap();
        let file = file(app_data.path(), WORLD);
        drop(opened(&app_data).unwrap());

        let connection = Connection::open(&file).unwrap();
        connection.pragma_update(None, "user_version", 3).unwrap();
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
