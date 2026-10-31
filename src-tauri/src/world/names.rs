//! The naming rules for new worlds, pages and folders. They apply only to names the user types for
//! a new entry, never to entries that already exist.

use std::fs;
use std::path::Path;

use crate::error::{AppError, ErrorKind};

/// Checks a name typed for a new world, page or folder against the rules, in the DESIGN's order,
/// and refuses it with `invalid_name` and the message of the first rule it breaks.
pub fn check_name(name: &str) -> Result<(), AppError> {
    match broken_rule(name) {
        Some(message) => Err(AppError::new(ErrorKind::InvalidName, message)),
        None => Ok(()),
    }
}

fn broken_rule(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        Some("Names cannot be empty.")
    } else if name.starts_with('.') {
        Some("Names cannot start with a dot.")
    } else if name.starts_with(' ') || name.ends_with(' ') {
        Some("Names cannot start or end with a space.")
    } else if name.ends_with('.') {
        Some("Names cannot end with a dot.")
    } else if name
        .chars()
        .any(|c| FORBIDDEN_CHARACTERS.contains(&c) || c.is_control())
    {
        Some(
            "Names cannot contain / \\ : * ? \" < > | or control characters, which some systems \
             forbid.",
        )
    } else if name.contains(['[', ']', '#', '^']) {
        Some("Names cannot contain [ ] # or ^, which break wiki links.")
    } else if is_reserved_on_windows(name) {
        Some(
            "Windows reserves CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9, even with an \
             extension.",
        )
    } else {
        None
    }
}

/// Characters that Windows, macOS or Linux forbid in a name or treat as separators.
const FORBIDDEN_CHARACTERS: [char; 9] = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Whether the part before the first dot names a Windows device. Win32 ignores spaces at the end
/// of that part, so `NUL .md` still names the device.
fn is_reserved_on_windows(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    matches!(
        stem.to_ascii_uppercase().as_bytes(),
        b"CON"
            | b"PRN"
            | b"AUX"
            | b"NUL"
            | [b'C', b'O', b'M', b'1'..=b'9']
            | [b'L', b'P', b'T', b'1'..=b'9']
    )
}

/// Whether `folder` holds an entry whose name equals `file_name` when letter case is ignored,
/// hidden and non-Markdown entries included. Names are compared in Unicode lowercase.
pub fn exists_case_insensitive(folder: &Path, file_name: &str) -> Result<bool, AppError> {
    let wanted = file_name.to_lowercase();
    for entry in fs::read_dir(folder)? {
        if entry?.file_name().to_string_lossy().to_lowercase() == wanted {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One rejected and one accepted example for every rule, in the rules' order.
    #[test]
    fn each_rule_rejects_a_breaking_name_with_its_message_and_accepts_a_near_miss() {
        let cases = [
            ("", "Names cannot be empty.", "a"),
            (".notes", "Names cannot start with a dot.", "notes.old"),
            (
                " Kesh",
                "Names cannot start or end with a space.",
                "Kesh Tor",
            ),
            (
                "Kesh ",
                "Names cannot start or end with a space.",
                "Kesh Tor",
            ),
            ("Kesh.", "Names cannot end with a dot.", "Kesh.v2"),
            ("Act 1/2", FORBIDDEN, "Act 1-2"),
            (r"a\b", FORBIDDEN, "a-b"),
            ("Session 1: Arrival", FORBIDDEN, "Session 1 - Arrival"),
            ("Why?", FORBIDDEN, "Why"),
            ("*", FORBIDDEN, "star"),
            ("\"Quoted\"", FORBIDDEN, "'Quoted'"),
            ("<b>", FORBIDDEN, "b"),
            ("a|b", FORBIDDEN, "a b"),
            ("Tab\there", FORBIDDEN, "Tab here"),
            ("Bell\u{7}", FORBIDDEN, "Bell"),
            ("[[Link]]", WIKI, "(Link)"),
            ("Heading #2", WIKI, "Heading 2"),
            ("Block^ref", WIKI, "Block ref"),
            ("con", RESERVED, "cone"),
            ("Com1.notes", RESERVED, "Com10.notes"),
            ("LPT9", RESERVED, "LPT0"),
            ("NUL .notes", RESERVED, "Null.notes"),
            ("aux", RESERVED, "auxiliary"),
            ("PRN", RESERVED, "PRNT"),
        ];

        for (rejected, message, accepted) in cases {
            let error = check_name(rejected).expect_err(rejected);
            assert_eq!(error.kind, ErrorKind::InvalidName, "{rejected:?}");
            assert_eq!(error.message, message, "{rejected:?}");
            assert!(check_name(accepted).is_ok(), "{accepted:?}");
        }
    }

    #[test]
    fn the_first_broken_rule_names_the_error() {
        // Starts with a dot and contains `#`: the dot rule comes first.
        assert_eq!(
            check_name(".#").unwrap_err().message,
            "Names cannot start with a dot."
        );
        // Contains `:` and `#`: the forbidden-character rule comes before the wiki-link rule.
        assert_eq!(check_name("a:#").unwrap_err().message, FORBIDDEN);
    }

    #[test]
    fn names_from_any_script_are_accepted() {
        for name in [
            "Þórr",
            "Ærøskøbing",
            "東京",
            "Kesh Tor (old)",
            "Glasswrights' Guild",
        ] {
            assert!(check_name(name).is_ok(), "{name:?}");
        }
    }

    #[test]
    fn a_clash_ignores_letter_case_and_counts_hidden_and_non_markdown_entries() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join(".Secret.md"), "").unwrap();
        fs::write(folder.path().join("Map.PNG"), [0u8]).unwrap();
        fs::create_dir(folder.path().join("Places")).unwrap();
        fs::write(folder.path().join("Kesh Tor.md"), "").unwrap();

        for clash in [".secret.md", "map.png", "PLACES", "kesh tor.MD"] {
            assert!(
                exists_case_insensitive(folder.path(), clash).unwrap(),
                "{clash:?}"
            );
        }
        for free in ["Secret.md", "Map", "Places.md", "Kesh Tor"] {
            assert!(
                !exists_case_insensitive(folder.path(), free).unwrap(),
                "{free:?}"
            );
        }
    }

    #[test]
    fn a_clash_compares_beyond_ascii_letter_case() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("Ærø.md"), "").unwrap();

        assert!(exists_case_insensitive(folder.path(), "æRØ.md").unwrap());
    }

    const FORBIDDEN: &str = "Names cannot contain / \\ : * ? \" < > | or control characters, which some systems forbid.";
    const WIKI: &str = "Names cannot contain [ ] # or ^, which break wiki links.";
    const RESERVED: &str = "Windows reserves CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9, \
         even with an extension.";
}
