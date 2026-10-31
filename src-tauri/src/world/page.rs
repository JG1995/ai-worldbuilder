//! Reading a page's text for the editor, and rebuilding a page's bytes from the edited text.

use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::path::Path;

use serde::Serialize;
use similar::{Algorithm, DiffOp, capture_diff_slices};

use crate::error::{AppError, ErrorKind};

const BYTE_ORDER_MARK: &str = "\u{feff}";

/// A page's text as the editor shows it, with the version of the bytes it came from.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PageText {
    pub text: String,
    pub version: String,
}

/// Reads the page at `path`. The text loses a leading byte-order mark and has `\r\n` and lone `\r`
/// line endings turned into `\n`, as CodeMirror would.
pub fn read(path: &Path) -> Result<PageText, AppError> {
    let bytes = fs::read(path)?;
    let version = version_of(&bytes);
    let text = decode(&bytes)?;
    let text = text.strip_prefix(BYTE_ORDER_MARK).unwrap_or(text);
    Ok(PageText {
        text: text.replace("\r\n", "\n").replace('\r', "\n"),
        version,
    })
}

/// The bytes to write for the editor's `text` (with `\n` line endings) over a page whose bytes are
/// `current`.
///
/// Lines whose content the diff finds unchanged keep their exact bytes. A replaced line takes the
/// endings of the lines it replaced, in order. Any other line that needs an ending, an inserted
/// line or a former last line that gains a newline, takes the page's most common ending. The final
/// line has a newline only if `text` ends with one, and a byte-order mark stays.
pub fn rebuild(current: &[u8], text: &str) -> Result<Vec<u8>, AppError> {
    let current = decode(current)?;
    let (mark, current) = match current.strip_prefix(BYTE_ORDER_MARK) {
        Some(rest) => (BYTE_ORDER_MARK, rest),
        None => ("", current),
    };
    let old = Lines::split(current);
    let new: Vec<&str> = text.split('\n').collect();
    let common = old.most_common_ending();

    // `endings[i]` is the ending of new line `i` that comes from the old lines, if any.
    let mut endings: Vec<Option<&str>> = vec![None; new.len()];
    for op in capture_diff_slices(Algorithm::Myers, &old.contents, &new) {
        match op {
            DiffOp::Equal {
                old_index,
                new_index,
                len,
            } => {
                for offset in 0..len {
                    endings[new_index + offset] = old.ending(old_index + offset);
                }
            }
            DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                for offset in 0..new_len.min(old_len) {
                    endings[new_index + offset] = old.ending(old_index + offset);
                }
            }
            DiffOp::Delete { .. } | DiffOp::Insert { .. } => {}
        }
    }

    let mut bytes = String::with_capacity(mark.len() + text.len() + new.len());
    bytes.push_str(mark);
    let last = new.len() - 1;
    for (index, (content, ending)) in new.iter().zip(endings).enumerate() {
        bytes.push_str(content);
        if index < last {
            bytes.push_str(ending.unwrap_or(common));
        }
    }
    Ok(bytes.into_bytes())
}

/// A page's text split into line contents and the endings between them. There is always one more
/// content than endings: the last content follows the last ending and may be empty.
struct Lines<'a> {
    contents: Vec<&'a str>,
    endings: Vec<&'a str>,
}

impl<'a> Lines<'a> {
    /// Splits at `\r\n`, `\n` and lone `\r`, as `read` normalizes them.
    fn split(text: &'a str) -> Self {
        let mut contents = Vec::new();
        let mut endings = Vec::new();
        let mut start = 0;
        let bytes = text.as_bytes();
        let mut index = 0;
        while index < bytes.len() {
            let width = match bytes[index] {
                b'\r' if bytes.get(index + 1) == Some(&b'\n') => 2,
                b'\r' | b'\n' => 1,
                _ => {
                    index += 1;
                    continue;
                }
            };
            contents.push(&text[start..index]);
            endings.push(&text[index..index + width]);
            index += width;
            start = index;
        }
        contents.push(&text[start..]);
        Self { contents, endings }
    }

    /// The ending after content `index`, or `None` for the last content, which has none.
    fn ending(&self, index: usize) -> Option<&'a str> {
        self.endings.get(index).copied()
    }

    /// The most frequent ending, or `\n` when there is none or the most frequent ones tie.
    fn most_common_ending(&self) -> &'static str {
        let count = |ending: &str| self.endings.iter().filter(|&&e| e == ending).count();
        let mut counts = [
            ("\n", count("\n")),
            ("\r\n", count("\r\n")),
            ("\r", count("\r")),
        ];
        counts.sort_by_key(|&(_, count)| std::cmp::Reverse(count));
        if counts[0].1 == counts[1].1 {
            "\n"
        } else {
            counts[0].0
        }
    }
}

fn decode(bytes: &[u8]) -> Result<&str, AppError> {
    std::str::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorKind::NotUtf8,
            "The page is not UTF-8 text, so it cannot be edited here. It has not been changed.",
        )
    })
}

/// An opaque token for a page's exact bytes: their length and a hash. The hash is stable within a
/// process only, so tokens are never stored.
pub fn version_of(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    format!("{}-{:016x}", bytes.len(), hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use std::fs;

    fn read_bytes(bytes: &[u8]) -> Result<PageText, AppError> {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("Page.md");
        fs::write(&path, bytes).unwrap();
        read(&path)
    }

    #[test]
    fn returns_the_text_with_the_version_of_its_bytes() {
        let page = read_bytes(b"# Saltmere\n\nA harbour town.\n").unwrap();

        assert_eq!(page.text, "# Saltmere\n\nA harbour town.\n");
        assert_eq!(page.version, version_of(b"# Saltmere\n\nA harbour town.\n"));
    }

    #[test]
    fn normalizes_line_endings_and_strips_a_byte_order_mark() {
        for bytes in [
            b"one\ntwo\n".as_slice(),
            b"one\r\ntwo\r\n",
            b"one\r\ntwo\n",
            b"one\rtwo\r",
            b"\xef\xbb\xbfone\r\ntwo\n",
        ] {
            assert_eq!(read_bytes(bytes).unwrap().text, "one\ntwo\n", "{bytes:?}");
        }
    }

    #[test]
    fn refuses_bytes_that_are_not_utf8() {
        let error = read_bytes(b"caf\xe9\n").unwrap_err();

        assert_eq!(error.kind, ErrorKind::NotUtf8);
    }

    fn rebuilt(current: &[u8], text: &str) -> Vec<u8> {
        rebuild(current, text).unwrap()
    }

    #[test]
    fn unchanged_text_rebuilds_the_original_bytes() {
        for bytes in [
            b"".as_slice(),
            b"one",
            b"one\ntwo\n",
            b"one\r\ntwo",
            b"one\r\ntwo\nthree\rfour\r\n",
            b"\xef\xbb\xbfone\r\n\r\n",
            b"one\r\r\ntwo",
        ] {
            let text = read_bytes(bytes).unwrap().text;
            assert_eq!(rebuilt(bytes, &text), bytes, "{bytes:?}");
        }
    }

    #[test]
    fn an_edited_line_changes_only_its_content_bytes() {
        let cases: [(&[u8], &[u8]); 4] = [
            (b"one\ntwo\nthree\n", b"one\nTWO\nthree\n"),
            (b"one\r\ntwo\r\nthree\r\n", b"one\r\nTWO\r\nthree\r\n"),
            (b"one\r\ntwo\nthree\r", b"one\r\nTWO\nthree\r"),
            (
                b"\xef\xbb\xbfone\r\ntwo\r\nthree",
                b"\xef\xbb\xbfone\r\nTWO\r\nthree",
            ),
        ];
        for (current, expected) in cases {
            let text = read_bytes(current).unwrap().text.replace("two", "TWO");
            assert_eq!(rebuilt(current, &text), expected, "{current:?}");
        }
    }

    #[test]
    fn replaced_lines_take_the_old_endings_in_order() {
        assert_eq!(
            rebuilt(b"a\r\nb\nc\r\n", "A\nB\nC\nD\nc\n"),
            b"A\r\nB\nC\r\nD\r\nc\r\n"
        );
    }

    #[test]
    fn inserted_lines_take_the_most_common_ending() {
        assert_eq!(
            rebuilt(b"one\r\ntwo\r\nthree\n", "one\nnew\ntwo\nthree\n"),
            b"one\r\nnew\r\ntwo\r\nthree\n"
        );
        assert_eq!(
            rebuilt(b"one\rtwo\rthree\n", "one\ntwo\nnew\nthree\n"),
            b"one\rtwo\rnew\rthree\n"
        );
    }

    #[test]
    fn inserted_lines_take_lf_on_a_tie_or_without_endings() {
        assert_eq!(
            rebuilt(b"one\r\ntwo\rthree", "one\nnew\ntwo\nthree"),
            b"one\r\nnew\ntwo\rthree"
        );
        assert_eq!(rebuilt(b"", "one\ntwo\n"), b"one\ntwo\n");
        assert_eq!(rebuilt(b"\xef\xbb\xbf", "one\n"), b"\xef\xbb\xbfone\n");
    }

    #[test]
    fn deleted_lines_go_with_their_endings() {
        assert_eq!(
            rebuilt(b"one\r\ntwo\nthree\r\n", "one\nthree\n"),
            b"one\r\nthree\r\n"
        );
        assert_eq!(rebuilt(b"one\r\ntwo\r\n", ""), b"");
    }

    #[test]
    fn a_former_last_line_that_gains_a_newline_takes_the_most_common_ending() {
        assert_eq!(rebuilt(b"one\r\ntwo", "one\ntwo\n"), b"one\r\ntwo\r\n");
        assert_eq!(
            rebuilt(b"one\r\ntwo", "one\ntwo\nthree"),
            b"one\r\ntwo\r\nthree"
        );
    }

    #[test]
    fn the_final_line_has_a_newline_only_if_the_text_ends_with_one() {
        assert_eq!(rebuilt(b"one\r\ntwo\r\n", "one\ntwo"), b"one\r\ntwo");
    }

    #[test]
    fn lone_carriage_return_pages_keep_their_endings() {
        assert_eq!(
            rebuilt(b"one\rtwo\rthree\r", "one\ntwo!\nthree\nfour\n"),
            b"one\rtwo!\rthree\rfour\r"
        );
    }

    #[test]
    fn rebuilding_refuses_current_bytes_that_are_not_utf8() {
        assert_eq!(
            rebuild(b"caf\xe9\n", "cafe\n").unwrap_err().kind,
            ErrorKind::NotUtf8
        );
    }

    #[test]
    fn equal_bytes_have_equal_versions_and_different_bytes_different_ones() {
        assert_eq!(version_of(b"one\n"), version_of(b"one\n"));
        assert_ne!(version_of(b"one\n"), version_of(b"one\r\n"));
        assert_ne!(version_of(b"one\n"), version_of(b"two\n"));
        assert_ne!(version_of(b""), version_of(b"\xef\xbb\xbf"));
    }
}
