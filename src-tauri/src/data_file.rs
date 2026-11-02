//! Writing the application's own data files in `<app data dir>/grimoire-data/`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process;

/// Writes `bytes` to a temporary file next to `file` and then renames it over `file`, so the file
/// always holds either its old or its new content. Creates the folder if needed.
///
/// With `private`, on Unix the temporary file is created with mode 0600 before anything is
/// written to it, so the content is never readable by other users, not even for a moment. On
/// Windows the per-user app data folder's permissions keep it private, and the flag changes
/// nothing.
pub fn write_atomically(file: &Path, bytes: &[u8], private: bool) -> io::Result<()> {
    let folder = file.parent().expect("the data file is inside a folder");
    let name = file.file_name().expect("the data file has a name");
    fs::create_dir_all(folder)?;
    let temporary = folder.join(format!(".{}.{}.tmp", name.display(), process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if private {
        // A file left over from a crash keeps its own mode when it is opened again, so only a
        // file this call creates is written to.
        let _ = fs::remove_file(&temporary);
        options.create_new(true).mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    let result = options
        .open(&temporary)
        .and_then(|mut out| {
            out.write_all(bytes)?;
            out.sync_all()
        })
        .and_then(|()| fs::rename(&temporary, file));
    if result.is_err() {
        // The failure being reported matters more than one that removing the file might add.
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Renames a damaged SQLite database, and its journal first, so a new database cannot take the old
/// journal for its own, to their names with `.damaged-<now>` appended. An earlier set-aside file of
/// the same name is never replaced: the rename fails with `AlreadyExists` instead.
pub fn set_aside(file: &Path, now: u64) -> io::Result<()> {
    let suffix = format!(".damaged-{now}");
    let journal = with_suffix(file, "-journal");
    if journal.exists() {
        rename_new(&journal, &with_suffix(&journal, &suffix))?;
    }
    rename_new(file, &with_suffix(file, &suffix))
}

fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::Error::from(io::ErrorKind::AlreadyExists));
    }
    fs::rename(from, to)
}

/// `file` with `suffix` appended to its name.
pub fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_private_file_is_readable_only_by_its_owner_even_over_a_wider_leftover() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("grimoire-data").join("keys.json");
        fs::create_dir(file.parent().unwrap()).unwrap();
        // A temporary file left over from a crash, readable by everyone.
        let leftover = file.with_file_name(format!(".keys.json.{}.tmp", process::id()));
        fs::write(&leftover, "old").unwrap();
        fs::set_permissions(&leftover, fs::Permissions::from_mode(0o644)).unwrap();

        write_atomically(&file, b"secret", true).unwrap();

        assert_eq!(fs::read(&file).unwrap(), b"secret");
        assert_eq!(mode(&file), 0o600);
        assert!(!leftover.exists());
    }
}

#[cfg(test)]
mod set_aside_tests {
    use super::*;

    #[test]
    fn a_file_and_its_journal_are_set_aside_and_an_earlier_set_aside_file_is_never_replaced() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("store.sqlite");
        let journal = with_suffix(&file, "-journal");
        fs::write(&file, "damaged").unwrap();
        fs::write(&journal, "journal").unwrap();

        set_aside(&file, 7).unwrap();

        assert!(!file.exists() && !journal.exists());
        assert_eq!(
            fs::read(with_suffix(&file, ".damaged-7")).unwrap(),
            b"damaged"
        );
        assert_eq!(
            fs::read(with_suffix(&journal, ".damaged-7")).unwrap(),
            b"journal"
        );

        fs::write(&file, "damaged again").unwrap();
        let taken = set_aside(&file, 7).unwrap_err();

        assert_eq!(taken.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&file).unwrap(), b"damaged again");
        assert_eq!(
            fs::read(with_suffix(&file, ".damaged-7")).unwrap(),
            b"damaged"
        );
    }
}
