//! The single write path. Every write to a world goes through this module.

use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

use serde::Serialize;

use super::{names, page, paths};
use crate::error::{AppError, ErrorKind};

/// How often a rename that Windows refuses because another program holds the page is tried again,
/// and how long to wait before each try.
const RENAME_RETRIES: u32 = 10;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Numbers this process's temporary files, so no two writes share one.
static TEMPORARY_FILES: AtomicU64 = AtomicU64::new(0);

/// The version of a page's bytes after a write.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PageVersion {
    pub version: String,
}

/// Saves the editor's `text` to the page at `relative` inside `root`, if the page still has the
/// bytes that `version` names. The caller holds the world lock, so writes do not overlap.
pub fn write_page(
    root: &Path,
    relative: &str,
    text: &str,
    version: &str,
) -> Result<PageVersion, AppError> {
    write_page_with(root, relative, text, version, check_and_rename)
}

/// `write_page`, with the step that puts the written temporary file in place given by the caller,
/// so tests can change the page before the check or make the rename fail.
fn write_page_with(
    root: &Path,
    relative: &str,
    text: &str,
    version: &str,
    put_in_place: impl FnOnce(&Path, &Path, &str) -> Result<(), AppError>,
) -> Result<PageVersion, AppError> {
    let page = paths::existing_page(root, relative)?;
    let current = fs::read(&page)?;
    if page::version_of(&current) != version {
        return Err(conflict());
    }
    // Unix lets a rename replace a read-only file, so the write path refuses it itself.
    let permissions = fs::metadata(&page)?.permissions();
    if permissions.readonly() {
        return Err(AppError::new(ErrorKind::Io, "The page is read-only."));
    }
    let bytes = page::rebuild(&current, text)?;
    if bytes == current {
        return Ok(PageVersion {
            version: version.to_owned(),
        });
    }

    let temporary = temporary_path(&page);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = write_temporary(file, &bytes, permissions)
        .map_err(AppError::from)
        .and_then(|()| put_in_place(&temporary, &page, version));
    if result.is_err() {
        // The failure being reported matters more than one that removing the file might add.
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(PageVersion {
        version: page::version_of(&bytes),
    })
}

/// A page or folder the user created, by its path relative to the world.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct NewEntry {
    pub path: String,
}

/// Creates an empty page `{name}.md` in the existing folder `folder` of the world at `root`, or
/// at its top level when `folder` is `None`. It never replaces an entry. The caller holds the
/// world lock, so writes do not overlap.
pub fn create_page(root: &Path, folder: Option<&str>, name: &str) -> Result<NewEntry, AppError> {
    let file_name = format!("{name}.md");
    let path = new_entry_path(&paths::existing_folder(root, folder)?, name, &file_name)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(creation_error)?;
    Ok(new_entry(folder, &file_name))
}

/// Creates an empty folder `name` as `create_page` creates a page.
pub fn create_folder(root: &Path, folder: Option<&str>, name: &str) -> Result<NewEntry, AppError> {
    let path = new_entry_path(&paths::existing_folder(root, folder)?, name, name)?;
    fs::create_dir(&path).map_err(creation_error)?;
    Ok(new_entry(folder, name))
}

/// Creates the empty folder of a new world, `name`, in `location`, a folder the user picked or the
/// default one, and returns its path.
pub fn create_world(location: &Path, name: &str) -> Result<PathBuf, AppError> {
    let path = new_entry_path(location, name, name)?;
    fs::create_dir(&path).map_err(creation_error)?;
    Ok(path)
}

/// The path of a new entry `file_name` in `parent`, once `name` passes the naming rules and no
/// entry in `parent` has `file_name` in any letter case.
fn new_entry_path(parent: &Path, name: &str, file_name: &str) -> Result<PathBuf, AppError> {
    names::check_name(name)?;
    if names::exists_case_insensitive(parent, file_name)? {
        return Err(exists());
    }
    Ok(parent.join(file_name))
}

fn new_entry(folder: Option<&str>, file_name: &str) -> NewEntry {
    let path = folder.map_or_else(
        || file_name.to_owned(),
        |folder| format!("{folder}/{file_name}"),
    );
    NewEntry { path }
}

/// An entry that appeared between the clash check and the creation is still a clash.
fn creation_error(error: io::Error) -> AppError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        exists()
    } else {
        error.into()
    }
}

fn exists() -> AppError {
    AppError::new(
        ErrorKind::Exists,
        "Something with this name already exists here. Letter case does not count.",
    )
}

/// A hidden file beside `page`, which the tree does not list: `.{file name}.{process}-{number}.tmp`.
fn temporary_path(page: &Path) -> PathBuf {
    let name = page.file_name().unwrap_or_default().to_string_lossy();
    let number = TEMPORARY_FILES.fetch_add(1, Ordering::Relaxed);
    page.with_file_name(format!(".{name}.{}-{number}.tmp", process::id()))
}

/// Writes and flushes the temporary file with the page's permissions, then closes it, which
/// Windows requires before the rename.
fn write_temporary(mut file: File, bytes: &[u8], permissions: Permissions) -> io::Result<()> {
    file.write_all(bytes)?;
    file.set_permissions(permissions)?;
    file.sync_all()
}

/// Checks that the page still has the bytes of `version`, then replaces it with `temporary`.
fn check_and_rename(temporary: &Path, page: &Path, version: &str) -> Result<(), AppError> {
    if page::version_of(&fs::read(page)?) != version {
        return Err(conflict());
    }
    Ok(rename_with_retry(temporary, page)?)
}

/// Renames `from` over `to`, trying again for a while when Windows reports that another program
/// holds the file (raw OS errors 5, 32 and 33: access denied, sharing and lock violations).
fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut retries = 0;
    loop {
        match fs::rename(from, to) {
            Err(error) if retries < RENAME_RETRIES && is_held_by_another_program(&error) => {
                retries += 1;
                thread::sleep(RENAME_RETRY_DELAY);
            }
            result => return result,
        }
    }
}

fn is_held_by_another_program(error: &io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

fn conflict() -> AppError {
    AppError::new(
        ErrorKind::Conflict,
        "The page changed on disk since it was last read or saved.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A world with one page, `Page.md`, holding `bytes`, and the version of those bytes.
    fn world_with_page(bytes: &[u8]) -> (TempDir, String) {
        let world = tempfile::tempdir().unwrap();
        fs::write(world.path().join("Page.md"), bytes).unwrap();
        (world, page::version_of(bytes))
    }

    fn page_bytes(world: &TempDir) -> Vec<u8> {
        fs::read(world.path().join("Page.md")).unwrap()
    }

    /// The names in the world's folder, which shows any temporary file left behind.
    fn entries(world: &TempDir) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(world.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_save_replaces_the_page_and_returns_the_version_of_its_new_bytes() {
        let (world, version) = world_with_page(b"\xef\xbb\xbf# Kesh\r\n\r\nOld line\r\n");

        let saved = write_page(world.path(), "Page.md", "# Kesh\n\nNew line\n", &version).unwrap();

        assert_eq!(
            page_bytes(&world),
            b"\xef\xbb\xbf# Kesh\r\n\r\nNew line\r\n"
        );
        assert_eq!(saved.version, page::version_of(&page_bytes(&world)));
        assert_eq!(entries(&world), ["Page.md"]);
    }

    #[test]
    fn unchanged_text_writes_nothing_and_keeps_the_modification_time() {
        let (world, version) = world_with_page(b"one\r\ntwo\r\n");
        let path = world.path().join("Page.md");
        // An hour ago, so any write would move it beyond the file system's timestamp resolution.
        let before = std::time::SystemTime::now() - Duration::from_secs(3600);
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(before)
            .unwrap();

        let saved = write_page(world.path(), "Page.md", "one\ntwo\n", &version).unwrap();

        assert_eq!(saved.version, version);
        assert_eq!(page_bytes(&world), b"one\r\ntwo\r\n");
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
        assert_eq!(entries(&world), ["Page.md"]);
    }

    #[test]
    fn a_stale_version_is_a_conflict_and_leaves_the_page_unchanged() {
        let (world, _) = world_with_page(b"theirs\n");

        let error = write_page(
            world.path(),
            "Page.md",
            "mine\n",
            &page::version_of(b"before\n"),
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(page_bytes(&world), b"theirs\n");
    }

    #[test]
    fn a_change_after_the_temporary_file_is_written_is_a_conflict_and_is_kept() {
        let (world, version) = world_with_page(b"one\n");

        let error = write_page_with(
            world.path(),
            "Page.md",
            "mine\n",
            &version,
            |temporary, page, version| {
                assert!(temporary.exists());
                fs::write(page, b"theirs\n").unwrap();
                check_and_rename(temporary, page, version)
            },
        )
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Conflict);
        assert_eq!(page_bytes(&world), b"theirs\n");
        assert_eq!(entries(&world), ["Page.md"]);
    }

    #[test]
    fn a_failing_rename_leaves_the_page_intact_and_removes_the_temporary_file() {
        let (world, version) = world_with_page(b"one\n");

        let error = write_page_with(world.path(), "Page.md", "two\n", &version, |_, _, _| {
            Err(io::Error::other("the rename failed").into())
        })
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(error.message, "the rename failed");
        assert_eq!(page_bytes(&world), b"one\n");
        assert_eq!(entries(&world), ["Page.md"]);
    }

    #[test]
    fn a_deleted_page_is_not_found() {
        let (world, version) = world_with_page(b"one\n");
        fs::remove_file(world.path().join("Page.md")).unwrap();

        let error = write_page(world.path(), "Page.md", "two\n", &version).unwrap_err();

        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(entries(&world).is_empty());
    }

    #[test]
    fn a_read_only_page_is_refused_and_left_intact() {
        let (world, version) = world_with_page(b"one\n");
        let path = world.path().join("Page.md");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let error = write_page(world.path(), "Page.md", "two\n", &version).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(error.message, "The page is read-only.");
        assert_eq!(page_bytes(&world), b"one\n");
        assert_eq!(entries(&world), ["Page.md"]);
    }

    #[test]
    fn a_page_that_is_not_utf8_is_never_written() {
        let (world, version) = world_with_page(b"caf\xe9\n");

        let error = write_page(world.path(), "Page.md", "cafe\n", &version).unwrap_err();

        assert_eq!(error.kind, ErrorKind::NotUtf8);
        assert_eq!(page_bytes(&world), b"caf\xe9\n");
        assert_eq!(entries(&world), ["Page.md"]);
    }

    #[test]
    fn paths_outside_the_world_are_refused() {
        let (world, version) = world_with_page(b"one\n");

        let error = write_page(world.path(), "../Page.md", "two\n", &version).unwrap_err();

        assert_eq!(error.kind, ErrorKind::InvalidPath);
    }

    #[test]
    fn a_new_page_is_an_empty_file_and_a_new_folder_an_empty_folder() {
        let world = tempfile::tempdir().unwrap();
        fs::create_dir(world.path().join("Places")).unwrap();

        let page = create_page(world.path(), Some("Places"), "Kesh Tor").unwrap();
        let folder = create_folder(world.path(), None, "Factions").unwrap();

        assert_eq!(page.path, "Places/Kesh Tor.md");
        assert_eq!(
            fs::read(world.path().join("Places/Kesh Tor.md")).unwrap(),
            b""
        );
        assert_eq!(folder.path, "Factions");
        assert_eq!(
            fs::read_dir(world.path().join("Factions")).unwrap().count(),
            0
        );
        assert_eq!(entries(&world), ["Factions", "Places"]);
    }

    #[test]
    fn a_clash_in_any_letter_case_creates_nothing_and_keeps_the_entry() {
        let world = tempfile::tempdir().unwrap();
        fs::write(world.path().join("kesh tor.MD"), b"kept").unwrap();
        fs::write(world.path().join(".factions"), b"hidden").unwrap();

        let page = create_page(world.path(), None, "Kesh Tor").unwrap_err();
        let folder = create_folder(world.path(), None, "Kesh tor.md").unwrap_err();

        assert_eq!(page.kind, ErrorKind::Exists);
        assert_eq!(folder.kind, ErrorKind::Exists);
        assert_eq!(fs::read(world.path().join("kesh tor.MD")).unwrap(), b"kept");
        assert_eq!(entries(&world), [".factions", "kesh tor.MD"]);
    }

    #[test]
    fn a_name_that_breaks_a_rule_creates_nothing() {
        let world = tempfile::tempdir().unwrap();

        let page = create_page(world.path(), None, "../Escape").unwrap_err();
        let folder = create_folder(world.path(), None, "Act/2").unwrap_err();

        assert_eq!(page.kind, ErrorKind::InvalidName);
        assert_eq!(folder.kind, ErrorKind::InvalidName);
        assert!(entries(&world).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_through_a_link_is_refused_and_nothing_is_created_behind_it() {
        let world = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), world.path().join("Elsewhere")).unwrap();

        let page = create_page(world.path(), Some("Elsewhere"), "Secret").unwrap_err();
        let folder = create_folder(world.path(), Some("Elsewhere"), "Secret").unwrap_err();

        assert_eq!(page.kind, ErrorKind::InvalidPath);
        assert_eq!(folder.kind, ErrorKind::InvalidPath);
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    /// A dangling link at the new name: creating through it would write outside the world.
    #[cfg(unix)]
    #[test]
    fn a_link_at_the_new_name_is_a_clash_and_is_not_followed() {
        let world = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("Planted.md"),
            world.path().join("Planted.md"),
        )
        .unwrap();

        let error = create_page(world.path(), None, "Planted").unwrap_err();

        assert_eq!(error.kind, ErrorKind::Exists);
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_new_world_is_an_empty_folder_at_the_location_and_a_clash_creates_nothing() {
        let location = tempfile::tempdir().unwrap();
        fs::write(location.path().join("glass steppe"), b"a file").unwrap();

        let root = create_world(location.path(), "Saltmere").unwrap();
        let clash = create_world(location.path(), "Glass Steppe").unwrap_err();
        let invalid = create_world(location.path(), "Saltmere: Two").unwrap_err();

        assert_eq!(root, location.path().join("Saltmere"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(clash.kind, ErrorKind::Exists);
        assert_eq!(invalid.kind, ErrorKind::InvalidName);
        let mut names: Vec<_> = fs::read_dir(location.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["Saltmere", "glass steppe"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_save_keeps_the_page_mode() {
        use std::os::unix::fs::PermissionsExt;
        let (world, version) = world_with_page(b"one\n");
        let path = world.path().join("Page.md");
        fs::set_permissions(&path, Permissions::from_mode(0o640)).unwrap();

        write_page(world.path(), "Page.md", "two\n", &version).unwrap();

        assert_eq!(page_bytes(&world), b"two\n");
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o640);
    }

    /// Another program holds the page open without sharing deletion, as an editor or a sync client
    /// can. Windows then refuses to replace it, and the save fails once the retries run out.
    #[cfg(windows)]
    #[test]
    fn a_page_held_by_another_program_fails_after_the_retries_and_saves_once_released() {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ: the page can still be read, so the save reaches the rename.
        const SHARE_READ_ONLY: u32 = 0x1;
        let (world, version) = world_with_page(b"one\n");
        let path = world.path().join("Page.md");
        let holder = OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ_ONLY)
            .open(&path)
            .unwrap();

        let error = write_page(world.path(), "Page.md", "two\n", &version).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(page_bytes(&world), b"one\n");
        assert_eq!(entries(&world), ["Page.md"]);

        // Released while the retries run, the save goes through.
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            drop(holder);
        });
        write_page(world.path(), "Page.md", "two\n", &version).unwrap();
        release.join().unwrap();
        assert_eq!(page_bytes(&world), b"two\n");
        assert_eq!(entries(&world), ["Page.md"]);
    }
}
