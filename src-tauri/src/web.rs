//! Opens web links in the system's default browser. The address comes from the webview, so it is
//! untrusted: only an absolute `http` or `https` URL with a host reaches the browser.

use std::io;

use url::Url;

use crate::error::{AppError, ErrorKind, guard};

/// The longest address that opens, in bytes.
const MAX_ADDRESS: usize = 8192;

const REFUSED: &str = "Only web addresses (http or https) can be opened.";

/// Opens `address` in the default browser, or refuses it with `invalid_path` unless it is an
/// absolute `http` or `https` URL with a host; a browser that cannot be started gives `io`.
#[tauri::command]
pub async fn link_open(address: String) -> Result<(), AppError> {
    guard(|| open_checked(&address, webbrowser::open))
}

/// Checks `address` and hands the URL it parses to, as the parser writes it, to `open`. `url`
/// drops tabs and line breaks silently, so control characters and whitespace are refused before
/// parsing.
fn open_checked(address: &str, open: impl FnOnce(&str) -> io::Result<()>) -> Result<(), AppError> {
    let refused = || AppError::new(ErrorKind::InvalidPath, REFUSED);
    if address.len() > MAX_ADDRESS
        || address
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(refused());
    }
    let url = Url::parse(address).map_err(|_| refused())?;
    let web = matches!(url.scheme(), "http" | "https");
    if !web || url.host_str().is_none_or(str::is_empty) {
        return Err(refused());
    }
    open(url.as_str()).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// What `open_checked` hands to the opener for `address`, which records it and opens nothing.
    fn opened(address: &str) -> (Result<(), AppError>, Vec<String>) {
        let recorded = RefCell::new(Vec::new());
        let result = open_checked(address, |url| {
            recorded.borrow_mut().push(url.to_owned());
            Ok(())
        });
        (result, recorded.into_inner())
    }

    #[test]
    fn web_addresses_reach_the_opener_as_parsed() {
        for (address, url) in [
            ("https://example.com/map", "https://example.com/map"),
            (
                "https://example.com/map?a=1&b=2#ford",
                "https://example.com/map?a=1&b=2#ford",
            ),
            // The parser writes the root path a bare host leaves out.
            ("http://example.com", "http://example.com/"),
        ] {
            let (result, recorded) = opened(address);
            assert!(result.is_ok(), "{address}");
            assert_eq!(recorded, [url]);
        }
    }

    #[test]
    fn every_other_address_is_refused_and_nothing_opens() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_ADDRESS));
        for address in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:a@b.c",
            "data:text/html,x",
            "ftp://x",
            "example.com",
            "/etc/passwd",
            "https://",
            "https://example.com/\nmap",
            "https://exam\tple.com",
            "https://example.com/ map",
            "https://example.com/\u{0}",
            "",
            long.as_str(),
        ] {
            let (result, recorded) = opened(address);
            let error = result.expect_err(address);
            assert_eq!(error.kind, ErrorKind::InvalidPath, "{address:?}");
            assert_eq!(error.message, REFUSED);
            assert!(recorded.is_empty(), "{address:?}");
        }
    }

    #[test]
    fn an_address_of_the_longest_length_opens() {
        let path = "a".repeat(MAX_ADDRESS - "https://example.com/".len());
        let address = format!("https://example.com/{path}");

        let (result, recorded) = opened(&address);

        assert!(result.is_ok());
        assert_eq!(recorded, [address]);
    }

    #[test]
    fn a_browser_that_cannot_start_gives_io_with_its_reason() {
        let error = open_checked("https://example.com", |_| {
            Err(io::Error::other("No browser was found."))
        })
        .unwrap_err();

        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(error.message, "No browser was found.");
    }
}
