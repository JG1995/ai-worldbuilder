//! The page index's cache database: `<app data dir>/grimoire-data/index/<name>.sqlite`, named like
//! the world's history file (ADR 0005). It is a cache of the world's files, so it never syncs to
//! disk, and a file that is damaged, in another format or recorded for another world is deleted and
//! created again. When the file cannot be used at all, the caller keeps the index in memory.
//!
//! Format 2, named by `PRAGMA user_version`:
//!
//! - `meta`: one row, the world folder's path.
//! - `pages`: each page the tree lists, by its `id`, which it keeps while it is stored, and its
//!   unique `path`, with the `size` and `modified` time (nanoseconds since the Unix epoch) it had
//!   when it was read, and whether it was `readable` as UTF-8.
//! - `aliases`: each page's aliases, with their lowercase `key`.
//! - `links`: each page's wiki links, keyed by (`source`, `ordinal`): where the link `start`s and
//!   `finish`es in UTF-16 code units, its `target` and lowercase `key`, its `heading` or `block`,
//!   whether it is an `embed`, its context `line`, and the page it is `resolved` to, if any.
//!   Attachment links are not stored.
//! - `texts`: an FTS5 table of each readable page's text, as the editor shows it, under the page's
//!   `id` as its rowid. Its `unicode61` tokenizer ignores letter case and accents
//!   (`remove_diacritics 2`), and its prefix indexes of one and two characters keep short queries
//!   fast. It keeps its own copy of the text, which the lines of a text match come from.
//!
//! Format 1 had no `id` and no `texts`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};

/// The format this version writes. Any other is discarded.
pub const FORMAT: i64 = 2;
/// How long a statement waits while another connection holds the file.
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

const SCHEMA: &str = "
    CREATE TABLE meta (world TEXT NOT NULL);
    CREATE TABLE pages (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        modified INTEGER NOT NULL,
        readable INTEGER NOT NULL
    );
    CREATE TABLE aliases (
        path TEXT NOT NULL,
        alias TEXT NOT NULL,
        key TEXT NOT NULL,
        PRIMARY KEY (path, alias)
    );
    CREATE INDEX aliases_by_key ON aliases (key);
    CREATE TABLE links (
        source TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        start INTEGER NOT NULL,
        finish INTEGER NOT NULL,
        target TEXT NOT NULL,
        key TEXT NOT NULL,
        heading TEXT,
        block TEXT,
        embed INTEGER NOT NULL,
        line TEXT NOT NULL,
        resolved TEXT,
        PRIMARY KEY (source, ordinal)
    );
    CREATE INDEX links_by_resolved ON links (resolved);
    CREATE VIRTUAL TABLE texts USING fts5 (
        text,
        tokenize = 'unicode61 remove_diacritics 2',
        prefix = '1 2'
    );
";

/// The cache file of the world whose folder's path is `world`, in `app_data`.
pub fn file(app_data: &Path, world: &str) -> PathBuf {
    app_data
        .join("grimoire-data")
        .join("index")
        .join(crate::history::file_name(world))
}

/// Opens the cache at `file` for the world at `world`, creating its folder and format 2 when they
/// are missing, and deleting and recreating a file it cannot trust. `None` when the folder or file
/// cannot be created, opened, deleted or recreated, or another connection keeps it busy.
pub fn open(file: &Path, world: &str) -> Option<Connection> {
    fs::create_dir_all(file.parent()?).ok()?;
    match connect(file, world) {
        Ok(Some(connection)) => return Some(connection),
        Ok(None) => {}
        Err(_) => return None,
    }
    // `connect` has closed the file, so Windows lets it be deleted.
    remove(file).ok()?;
    remove(&journal(file)).ok()?;
    connect(file, world).ok().flatten()
}

/// A database in memory in format 2, for an index that cannot be stored.
pub fn open_in_memory(world: &str) -> Connection {
    let connection = Connection::open_in_memory().expect("SQLite can open a database in memory");
    create(&connection, world).expect("SQLite can create tables in memory");
    connection
}

/// The file's connection when it holds format 2 for `world` or nothing yet (which then gets format
/// 2), `None` when it is damaged, in another format or another world's, and an error when it
/// cannot be opened or is busy. On `None` and on an error, the connection is closed.
fn connect(file: &Path, world: &str) -> rusqlite::Result<Option<Connection>> {
    let connection = Connection::open(file)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    // Reading the format is the first read of the file, so it finds a damaged one.
    let format: i64 = match connection.pragma_query_value(None, "user_version", |row| row.get(0)) {
        Ok(format) => format,
        Err(error) if is_damaged(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    connection.pragma_update(None, "synchronous", "OFF")?;
    let usable = match format {
        0 => {
            let objects: i64 =
                connection.query_row("SELECT count(*) FROM sqlite_schema", [], |row| row.get(0))?;
            objects == 0 && create(&connection, world).is_ok()
        }
        FORMAT => match connection
            .query_row("SELECT world FROM meta", [], |row| row.get::<_, String>(0))
        {
            Ok(stored) => stored == world,
            Err(error) if is_busy(&error) => return Err(error),
            Err(_) => false,
        },
        _ => false,
    };
    Ok(usable.then_some(connection))
}

/// Creates format 2 in one transaction.
fn create(connection: &Connection, world: &str) -> rusqlite::Result<()> {
    connection.execute_batch("BEGIN")?;
    let created = connection
        .execute_batch(SCHEMA)
        .and_then(|()| connection.execute("INSERT INTO meta (world) VALUES (?1)", [world]))
        .and_then(|_| connection.pragma_update(None, "user_version", FORMAT));
    match created {
        Ok(()) => connection.execute_batch("COMMIT"),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn is_damaged(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    )
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error.sqlite_error_code(),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn journal(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push("-journal");
    PathBuf::from(name)
}

fn remove(file: &Path) -> io::Result<()> {
    match fs::remove_file(file) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const WORLD: &str = "/home/tester/Worlds/Kesh";

    fn cache(app_data: &TempDir) -> PathBuf {
        file(app_data.path(), WORLD)
    }

    fn format_and_world(connection: &Connection) -> (i64, String) {
        let format = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let world = connection
            .query_row("SELECT world FROM meta", [], |row| row.get(0))
            .unwrap();
        (format, world)
    }

    fn pages(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT count(*) FROM pages", [], |row| row.get(0))
            .unwrap()
    }

    fn add_page(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO pages (path, size, modified, readable) VALUES ('Kesh Tor.md', 1, 1, 1)",
                [],
            )
            .unwrap();
    }

    #[test]
    fn a_new_file_has_format_2_and_the_world_and_a_second_open_reuses_it() {
        let app_data = tempfile::tempdir().unwrap();
        let file = cache(&app_data);
        // The history file of the same world, which nothing here may touch.
        let history = crate::history::testing::file(app_data.path(), Path::new(WORLD));
        fs::create_dir_all(history.parent().unwrap()).unwrap();
        fs::write(&history, b"history bytes").unwrap();

        let first = open(&file, WORLD).unwrap();
        assert_eq!(format_and_world(&first), (2, WORLD.to_owned()));
        add_page(&first);
        drop(first);
        let second = open(&file, WORLD).unwrap();

        assert_eq!(pages(&second), 1);
        assert_eq!(file.file_name(), history.file_name());
        assert_eq!(fs::read(&history).unwrap(), b"history bytes");
        assert_eq!(
            fs::read_dir(app_data.path().join("grimoire-data"))
                .unwrap()
                .count(),
            2
        );
    }

    #[test]
    fn a_damaged_other_format_or_other_world_file_is_deleted_and_created_again() {
        let app_data = tempfile::tempdir().unwrap();
        let file = cache(&app_data);
        type Change = fn(&Path);
        let reset: [(&str, Change); 5] = [
            ("random bytes", |file| {
                let bytes: Vec<u8> = (0u32..8192)
                    .map(|index| {
                        (index.wrapping_mul(1_103_515_245).wrapping_add(12_345) >> 16) as u8
                    })
                    .collect();
                fs::write(file, bytes).unwrap();
            }),
            ("format 1, without the page texts", |file| {
                fs::remove_file(file).unwrap();
                let connection = Connection::open(file).unwrap();
                connection
                    .execute_batch(
                        "CREATE TABLE meta (world TEXT NOT NULL);
                         CREATE TABLE pages (path TEXT PRIMARY KEY, size INTEGER NOT NULL,
                             modified INTEGER NOT NULL, readable INTEGER NOT NULL);
                         INSERT INTO pages VALUES ('Kesh Tor.md', 1, 1, 1);
                         PRAGMA user_version = 1;",
                    )
                    .unwrap();
                connection
                    .execute("INSERT INTO meta (world) VALUES (?1)", [WORLD])
                    .unwrap();
            }),
            ("an unknown format", |file| {
                Connection::open(file)
                    .unwrap()
                    .pragma_update(None, "user_version", 3)
                    .unwrap();
            }),
            ("another world", |file| {
                Connection::open(file)
                    .unwrap()
                    .execute("UPDATE meta SET world = '/home/tester/Worlds/Other'", [])
                    .unwrap();
            }),
            ("tables without a format", |file| {
                let connection = Connection::open(file).unwrap();
                connection.pragma_update(None, "user_version", 0).unwrap();
            }),
        ];
        for (case, change) in reset {
            add_page(&open(&file, WORLD).unwrap());
            change(&file);

            let reopened = open(&file, WORLD).unwrap();

            assert_eq!(format_and_world(&reopened), (2, WORLD.to_owned()), "{case}");
            assert_eq!(pages(&reopened), 0, "{case}");
            drop(reopened);
            assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        }
    }

    #[test]
    fn a_folder_that_cannot_be_created_gives_no_file() {
        let app_data = tempfile::tempdir().unwrap();
        // A file where the `grimoire-data` folder belongs.
        fs::write(app_data.path().join("grimoire-data"), b"").unwrap();

        assert!(open(&cache(&app_data), WORLD).is_none());
        assert_eq!(
            format_and_world(&open_in_memory(WORLD)),
            (2, WORLD.to_owned())
        );
    }
}
