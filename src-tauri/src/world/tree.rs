//! The world's file tree: its visible folders and Markdown pages, sorted.

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::iter::Peekable;
use std::path::Path;
use std::str::Chars;

use serde::Serialize;

use super::paths::{check_root, is_allowed_name, is_page_name};
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Folder,
    Page,
}

/// One listed entry, in the shape of the interface's `TreeEntry`.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct TreeEntry {
    /// Relative to the world, with `/` separators. A page's path keeps its extension.
    pub path: String,
    /// A page's name drops the extension.
    pub name: String,
    pub kind: EntryKind,
    /// A folder's entries; absent for a page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeEntry>>,
}

/// Lists the world at `root`.
pub fn list(root: &Path) -> Result<Vec<TreeEntry>, AppError> {
    check_root(root)?;
    Ok(list_folder(root, None)?)
}

/// Lists one folder recursively. Entry types come from the directory entries themselves, which do
/// not follow links, so links and junctions are skipped rather than followed.
fn list_folder(folder: &Path, prefix: Option<&str>) -> io::Result<Vec<TreeEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(folder)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !is_allowed_name(&name) {
            continue;
        }
        let file_type = entry.file_type()?;
        let path = match prefix {
            Some(prefix) => format!("{prefix}/{name}"),
            None => name.clone(),
        };
        if file_type.is_dir() {
            let children = list_folder(&entry.path(), Some(&path))?;
            entries.push(TreeEntry {
                path,
                name,
                kind: EntryKind::Folder,
                children: Some(children),
            });
        } else if file_type.is_file() && is_page_name(&name) {
            let name = name[..name.len() - ".md".len()].to_owned();
            entries.push(TreeEntry {
                path,
                name,
                kind: EntryKind::Page,
                children: None,
            });
        }
    }
    entries.sort_by(|a, b| {
        (a.kind == EntryKind::Page)
            .cmp(&(b.kind == EntryKind::Page))
            .then_with(|| natural_order(&a.name, &b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(entries)
}

/// Compares names ignoring letter case (Unicode lowercase), with runs of digits compared as numbers.
fn natural_order(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        let ordering = match (a.peek(), b.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (x, y) = (digits(&mut a), digits(&mut b));
                let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
                x.len().cmp(&y.len()).then_with(|| x.cmp(y))
            }
            (Some(x), Some(y)) => {
                let ordering = x.cmp(y);
                a.next();
                b.next();
                ordering
            }
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
}

fn digits(chars: &mut Peekable<Chars>) -> String {
    let mut run = String::new();
    while let Some(digit) = chars.next_if(char::is_ascii_digit) {
        run.push(digit);
    }
    run
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::fs;
    use tempfile::TempDir;

    fn names(entries: &[TreeEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    fn find<'a>(entries: &'a [TreeEntry], name: &str) -> &'a TreeEntry {
        entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("no entry {name}"))
    }

    fn world(files: &[&str], folders: &[&str]) -> TempDir {
        let world = tempfile::tempdir().unwrap();
        for folder in folders {
            fs::create_dir_all(world.path().join(folder)).unwrap();
        }
        for file in files {
            fs::write(world.path().join(file), "text").unwrap();
        }
        world
    }

    #[test]
    fn lists_visible_folders_and_markdown_pages_with_relative_paths() {
        let world = world(
            &["Index.md", "Places/Saltmere.md", "Places/Coast/Cliffs.md"],
            &["Places/Coast"],
        );

        let tree = list(world.path()).unwrap();

        assert_eq!(names(&tree), ["Places", "Index"]);
        let places = find(&tree, "Places");
        assert_eq!(places.kind, EntryKind::Folder);
        assert_eq!(places.path, "Places");
        let children = places.children.as_deref().unwrap();
        assert_eq!(names(children), ["Coast", "Saltmere"]);
        assert_eq!(find(children, "Saltmere").path, "Places/Saltmere.md");
        assert_eq!(find(children, "Saltmere").kind, EntryKind::Page);
        let coast = find(children, "Coast").children.as_deref().unwrap();
        assert_eq!(coast[0].path, "Places/Coast/Cliffs.md");
        assert_eq!(find(&tree, "Index").children, None);
    }

    #[test]
    fn hides_dot_entries_and_non_markdown_files_but_keeps_empty_folders() {
        let world = world(
            &[
                ".hidden.md",
                ".obsidian/workspace.md",
                ".trash/Old.md",
                "map.png",
                "notes.txt",
                "Art/cover.png",
            ],
            &[".obsidian", ".trash", "Art", "Empty"],
        );

        let tree = list(world.path()).unwrap();

        assert_eq!(names(&tree), ["Art", "Empty"]);
        assert_eq!(find(&tree, "Art").children, Some(Vec::new()));
        assert_eq!(find(&tree, "Empty").children, Some(Vec::new()));
    }

    #[test]
    fn lists_upper_case_extensions_and_both_case_variants() {
        let world = world(&["Note.MD", "Gods.md"], &[]);
        // Case variants can only coexist on a case-sensitive file system.
        let variants = fs::write(world.path().join("gods.md"), "text").is_ok()
            && fs::read_dir(world.path()).unwrap().count() == 3;

        let tree = list(world.path()).unwrap();

        assert_eq!(find(&tree, "Note").path, "Note.MD");
        if variants {
            assert_eq!(names(&tree), ["Gods", "gods", "Note"]);
        }
    }

    #[test]
    fn sorts_folders_first_then_case_insensitively_in_natural_order() {
        let world = world(
            &[
                "act 3.md",
                "Act 10.md",
                "Act 2.md",
                "beta.md",
                "Alpha.md",
                "Ærø.md",
            ],
            &["Zeta", "act 1", "Act 12"],
        );

        let tree = list(world.path()).unwrap();

        assert_eq!(
            names(&tree),
            [
                "act 1", "Act 12", "Zeta", "Act 2", "act 3", "Act 10", "Alpha", "beta", "Ærø"
            ]
        );
    }

    #[test]
    fn a_missing_root_is_world_missing() {
        let world = tempfile::tempdir().unwrap();

        let error = list(&world.path().join("gone")).unwrap_err();

        assert_eq!(error.kind, ErrorKind::WorldMissing);
    }

    #[cfg(unix)]
    #[test]
    fn lists_names_that_are_legal_on_unix_and_hides_links() {
        use std::os::unix::fs::symlink;
        let world = world(
            &["Session 1: Arrival.md", r"a\b.md", "Real.md"],
            &["Places"],
        );
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("Secret.md"), "secret").unwrap();
        symlink(outside.path(), world.path().join("Elsewhere")).unwrap();
        symlink(world.path().join("Real.md"), world.path().join("Alias.md")).unwrap();
        symlink(world.path().join("Places"), world.path().join("Linked")).unwrap();

        let tree = list(world.path()).unwrap();

        assert_eq!(
            names(&tree),
            ["Places", r"a\b", "Real", "Session 1: Arrival"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn skips_a_name_that_is_not_valid_utf8() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let world = world(&["Real.md"], &[]);
        fs::write(world.path().join(OsStr::from_bytes(b"Bad\xff.md")), "text").unwrap();

        assert_eq!(names(&list(world.path()).unwrap()), ["Real"]);
    }
}
