//! Reading a page's text for the editor.

use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, ErrorKind};

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
    let text = String::from_utf8(bytes).map_err(|_| {
        AppError::new(
            ErrorKind::NotUtf8,
            "The page is not UTF-8 text, so it cannot be edited here. It has not been changed.",
        )
    })?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    Ok(PageText {
        text: text.replace("\r\n", "\n").replace('\r', "\n"),
        version,
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

    #[test]
    fn equal_bytes_have_equal_versions_and_different_bytes_different_ones() {
        assert_eq!(version_of(b"one\n"), version_of(b"one\n"));
        assert_ne!(version_of(b"one\n"), version_of(b"one\r\n"));
        assert_ne!(version_of(b"one\n"), version_of(b"two\n"));
        assert_ne!(version_of(b""), version_of(b"\xef\xbb\xbf"));
    }
}
