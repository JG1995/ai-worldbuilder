//! Confinement: turns a path from the interface into a path inside the open world, or refuses it.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::error::{AppError, ErrorKind};

/// Whether one name, a file or folder name or one segment of a relative path, may be used inside a
/// world. The tree lists only names that pass, so every listed entry can be opened.
///
/// It refuses empty names, names that start with `.` (which covers `.` and `..`) and NUL. On
/// Windows it also refuses `\` and `:`, which are separators, drive and stream markers there, and a
/// trailing space or dot, which Win32 strips, so the name would reach a different entry.
pub fn is_allowed_name(name: &str) -> bool {
    let refused_on_windows =
        cfg!(windows) && (name.contains(['\\', ':']) || name.ends_with([' ', '.']));
    !name.is_empty() && !name.starts_with('.') && !name.contains('\0') && !refused_on_windows
}

/// Whether a file name is a Markdown page: it ends in `.md` in any letter case.
pub fn is_page_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

/// The absolute path of an existing page, a `.md` file, at `relative` inside `root`.
///
/// The root may itself be a link, because the user picked it, but no entry below it may be a
/// symbolic link or, on Windows, a junction: std reports both as links there.
pub fn existing_page(root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let segments = segments(relative)?;
    if !segments.last().is_some_and(|name| is_page_name(name)) {
        return Err(invalid_path());
    }
    let (path, metadata) = walk(root, &segments)?;
    if !metadata.is_file() {
        return Err(not_found());
    }
    Ok(path)
}

/// The absolute path of the existing folder at `relative` inside `root`, or of the root itself
/// when `relative` is `None`, that is to hold a new entry. The caller adds the entry's name only
/// after `names::check_name` has accepted it, which keeps it one plain segment.
pub fn existing_folder(root: &Path, relative: Option<&str>) -> Result<PathBuf, AppError> {
    let Some(relative) = relative else {
        check_root(root)?;
        return Ok(root.to_path_buf());
    };
    let (path, metadata) = walk(root, &segments(relative)?)?;
    if !metadata.is_dir() {
        return Err(not_found());
    }
    Ok(path)
}

/// Where a page that is gone can be written back: the absolute path of the page at `relative`
/// inside `root`, and the folders above it that are missing, outermost first, for the caller to
/// create. Each existing folder on the way must be a real folder, not a link, and the page itself
/// must be absent: anything at its path is a `conflict`.
pub fn restorable_page(root: &Path, relative: &str) -> Result<(PathBuf, Vec<PathBuf>), AppError> {
    let segments = segments(relative)?;
    let Some((page_name, folders)) = segments.split_last() else {
        return Err(invalid_path());
    };
    if !is_page_name(page_name) {
        return Err(invalid_path());
    }
    check_root(root)?;
    let mut path = root.to_path_buf();
    let mut missing = Vec::new();
    for folder in folders {
        path.push(folder);
        if !missing.is_empty() {
            missing.push(path.clone());
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(entry) if entry.file_type().is_symlink() => return Err(invalid_path()),
            Ok(entry) if entry.is_dir() => {}
            Ok(_) => {
                return Err(AppError::new(
                    ErrorKind::Io,
                    "A file is in the way of the page's folder.",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => missing.push(path.clone()),
            Err(error) => return Err(error.into()),
        }
    }
    path.push(page_name);
    if missing.is_empty() {
        match fs::symlink_metadata(&path) {
            Ok(_) => return Err(page_is_back()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok((path, missing))
}

/// Something is at the path of a page that was gone, so writing it back would replace it.
pub fn page_is_back() -> AppError {
    AppError::new(
        ErrorKind::Conflict,
        "Something is at the page's path again, so it was not restored.",
    )
}

/// Checks that the world's folder still exists. It may be a link, because the user picked it.
pub fn check_root(root: &Path) -> Result<(), AppError> {
    match fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(world_missing()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(world_missing()),
        Err(error) => Err(error.into()),
    }
}

/// The segments of a relative, `/`-separated path, each of which passes `is_allowed_name`.
fn segments(relative: &str) -> Result<Vec<&str>, AppError> {
    let segments: Vec<&str> = relative.split('/').collect();
    if segments.iter().all(|segment| is_allowed_name(segment)) {
        Ok(segments)
    } else {
        Err(invalid_path())
    }
}

/// Follows `segments` from `root` without following any link, and returns the final entry.
fn walk(root: &Path, segments: &[&str]) -> Result<(PathBuf, fs::Metadata), AppError> {
    check_root(root)?;
    let mut path = root.to_path_buf();
    let mut metadata = None;
    for segment in segments {
        if metadata
            .as_ref()
            .is_some_and(|parent: &fs::Metadata| !parent.is_dir())
        {
            return Err(not_found());
        }
        path.push(segment);
        let entry = match fs::symlink_metadata(&path) {
            Ok(entry) => entry,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(not_found()),
            Err(error) => return Err(error.into()),
        };
        if entry.file_type().is_symlink() {
            return Err(invalid_path());
        }
        metadata = Some(entry);
    }
    // `segments` always has at least one entry, so the loop set it.
    Ok((path, metadata.expect("a path has at least one segment")))
}

fn invalid_path() -> AppError {
    AppError::new(
        ErrorKind::InvalidPath,
        "The path is not a valid page or folder path in this world.",
    )
}

fn not_found() -> AppError {
    AppError::new(ErrorKind::NotFound, "The page or folder does not exist.")
}

fn world_missing() -> AppError {
    AppError::new(
        ErrorKind::WorldMissing,
        "The world's folder cannot be found.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn world() -> TempDir {
        let world = tempfile::tempdir().unwrap();
        fs::create_dir(world.path().join("Places")).unwrap();
        fs::write(world.path().join("Places/Saltmere.md"), "# Saltmere\n").unwrap();
        world
    }

    fn kind_of(result: Result<PathBuf, AppError>) -> ErrorKind {
        result.unwrap_err().kind
    }

    #[test]
    fn an_existing_page_resolves_inside_the_world() {
        let world = world();

        let path = existing_page(world.path(), "Places/Saltmere.md").unwrap();

        assert_eq!(path, world.path().join("Places").join("Saltmere.md"));
    }

    #[test]
    fn lexically_invalid_paths_are_refused() {
        let world = world();
        let absolute = world.path().join("Places/Saltmere.md");
        let refused = [
            "",
            "/Places/Saltmere.md",
            absolute.to_str().unwrap(),
            "Places//Saltmere.md",
            "Places/",
            "./Places/Saltmere.md",
            "Places/./Saltmere.md",
            "Places/../Places/Saltmere.md",
            "../outside.md",
            ".obsidian/workspace.md",
            "Places/.hidden.md",
            "Places/Salt\0mere.md",
        ];

        for path in refused {
            assert_eq!(
                kind_of(existing_page(world.path(), path)),
                ErrorKind::InvalidPath,
                "{path:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_only_names_are_refused() {
        let world = world();
        for path in [
            "C:/Places/Saltmere.md",
            "C:Saltmere.md",
            r"\\server\share\Saltmere.md",
            r"Places\Saltmere.md",
            "Places/Saltmere.md:stream",
            "Places./Saltmere.md",
            "Places /Saltmere.md",
            "Places/Saltmere.md.",
            "Places/Saltmere.md ",
        ] {
            assert_eq!(
                kind_of(existing_page(world.path(), path)),
                ErrorKind::InvalidPath,
                "{path:?}"
            );
        }
    }

    #[test]
    fn a_page_path_must_name_a_markdown_file() {
        let world = world();
        fs::write(world.path().join("Places/map.png"), [0u8; 4]).unwrap();
        fs::create_dir(world.path().join("Places/Folder.md")).unwrap();

        assert_eq!(
            kind_of(existing_page(world.path(), "Places/map.png")),
            ErrorKind::InvalidPath
        );
        assert_eq!(
            kind_of(existing_page(world.path(), "Places")),
            ErrorKind::InvalidPath
        );
        assert_eq!(
            kind_of(existing_page(world.path(), "Places/Folder.md")),
            ErrorKind::NotFound
        );
    }

    #[test]
    fn a_page_in_upper_case_md_resolves() {
        let world = world();
        fs::write(world.path().join("Note.MD"), "").unwrap();

        assert!(existing_page(world.path(), "Note.MD").is_ok());
    }

    #[test]
    fn missing_entries_are_not_found_and_a_missing_root_is_world_missing() {
        let world = world();

        assert_eq!(
            kind_of(existing_page(world.path(), "Places/Nowhere.md")),
            ErrorKind::NotFound
        );
        assert_eq!(
            kind_of(existing_page(world.path(), "Nowhere/Saltmere.md")),
            ErrorKind::NotFound
        );
        assert_eq!(
            kind_of(existing_page(world.path(), "Places/Saltmere.md/Inner.md")),
            ErrorKind::NotFound
        );

        let gone = world.path().join("gone");
        assert_eq!(
            kind_of(existing_page(&gone, "Places/Saltmere.md")),
            ErrorKind::WorldMissing
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_inside_the_path_are_refused_on_unix() {
        use std::os::unix::fs::symlink;
        let world = world();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("Secret.md"), "secret").unwrap();
        symlink(outside.path(), world.path().join("Elsewhere")).unwrap();
        symlink(
            world.path().join("Places/Saltmere.md"),
            world.path().join("Alias.md"),
        )
        .unwrap();
        symlink(world.path().join("Places"), world.path().join("Linked")).unwrap();

        for path in ["Elsewhere/Secret.md", "Alias.md", "Linked/Saltmere.md"] {
            assert_eq!(
                kind_of(existing_page(world.path(), path)),
                ErrorKind::InvalidPath,
                "{path:?}"
            );
        }
    }

    #[test]
    fn a_folder_for_a_new_entry_must_be_an_existing_folder_inside_the_world() {
        let world = world();

        assert_eq!(existing_folder(world.path(), None).unwrap(), world.path());
        assert_eq!(
            existing_folder(world.path(), Some("Places")).unwrap(),
            world.path().join("Places")
        );
        for (folder, kind) in [
            ("Places/Saltmere.md", ErrorKind::NotFound),
            ("Nowhere", ErrorKind::NotFound),
            ("", ErrorKind::InvalidPath),
            ("../Places", ErrorKind::InvalidPath),
            (".obsidian", ErrorKind::InvalidPath),
        ] {
            assert_eq!(
                kind_of(existing_folder(world.path(), Some(folder))),
                kind,
                "{folder:?}"
            );
        }
        assert_eq!(
            kind_of(existing_folder(&world.path().join("gone"), None)),
            ErrorKind::WorldMissing
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_for_a_new_entry_through_a_link_is_refused_on_unix() {
        let world = world();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), world.path().join("Elsewhere")).unwrap();
        std::os::unix::fs::symlink(world.path().join("Places"), world.path().join("Linked"))
            .unwrap();

        for folder in ["Elsewhere", "Linked"] {
            assert_eq!(
                kind_of(existing_folder(world.path(), Some(folder))),
                ErrorKind::InvalidPath,
                "{folder:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_root_itself_may_be_a_link_on_unix() {
        let world = world();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("Linked world");
        std::os::unix::fs::symlink(world.path(), &root).unwrap();

        assert!(existing_page(&root, "Places/Saltmere.md").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn names_that_are_legal_on_unix_resolve() {
        let world = world();
        fs::write(world.path().join("Session 1: Arrival.md"), "").unwrap();
        fs::write(world.path().join(r"a\b.md"), "").unwrap();

        assert!(existing_page(world.path(), "Session 1: Arrival.md").is_ok());
        assert!(existing_page(world.path(), r"a\b.md").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_inside_the_path_is_refused_on_windows() {
        let world = world();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("Secret.md"), "secret").unwrap();
        let junction = world.path().join("Elsewhere");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success());

        assert_eq!(
            kind_of(existing_page(world.path(), "Elsewhere/Secret.md")),
            ErrorKind::InvalidPath
        );
    }
}
