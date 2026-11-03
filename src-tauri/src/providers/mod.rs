//! The `providers` area: where requests to an AI provider go. It holds the rules a text provider's
//! base URL must follow, and the only code that sends a request: the connection test in `chat`,
//! the streamed answer in `stream` and the image provider's requests in `images`.

mod chat;
pub mod images;
mod stream;

use std::net::IpAddr;

#[cfg(test)]
pub use chat::test_support;
pub use chat::{ProviderFailure, TIMEOUT, TestOutcome, test};
pub use stream::{ChatMessage, READ_TIMEOUT, Role, StreamEnd, chat_stream};

use url::{Host, Origin, Url};

/// What the core adds to a base URL to send a chat request.
const CHAT_PATH: &str = "/chat/completions";

/// An OpenAI-compatible provider's base URL that follows the rules in the feature's design:
/// `https`, or `http` to this computer; no user name, password, query string or fragment; and not
/// ending in `/chat/completions`. One trailing `/` is dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseUrl(Url);

impl BaseUrl {
    /// Checks `text`, trimmed, against the rules. The error is a sentence naming the broken rule.
    pub fn parse(text: &str) -> Result<Self, String> {
        let url = Url::parse(text.trim()).map_err(|_| {
            "Enter the full address of the provider, starting with https://.".to_owned()
        })?;
        let allowed = match url.scheme() {
            "https" => true,
            "http" => is_loopback(&url),
            _ => false,
        };
        if !allowed {
            return Err(
                "The address must start with https://, or with http:// for a server on this computer."
                    .to_owned(),
            );
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("Leave the user name and password out of the address.".to_owned());
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(
                "Leave the query string (from ?) and the fragment (from #) out of the address."
                    .to_owned(),
            );
        }
        let mut url = url;
        if let Some(path) = url.path().strip_suffix('/').map(str::to_owned) {
            url.set_path(&path);
        }
        if url.path().ends_with(CHAT_PATH) {
            return Err(
                "Leave /chat/completions out of the address; Grimoire.md adds it.".to_owned(),
            );
        }
        Ok(Self(url))
    }

    /// The normalised URL, without a trailing `/`.
    pub fn as_str(&self) -> &str {
        // An `http` or `https` URL with an empty path still writes it as `/`.
        let text = self.0.as_str();
        match self.0.path() {
            "/" => text.strip_suffix('/').unwrap_or(text),
            _ => text,
        }
    }

    /// Where a chat request goes: the base URL followed by `/chat/completions`.
    pub fn chat_url(&self) -> String {
        format!("{}{CHAT_PATH}", self.as_str())
    }

    /// The scheme, host and port that a stored key belongs to.
    pub fn origin(&self) -> Origin {
        self.0.origin()
    }

    /// The host as the status line names it, with the port when the URL names one.
    pub fn host(&self) -> String {
        let host = self.0.host_str().unwrap_or_default();
        match self.0.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        }
    }
}

/// `localhost`, an address in 127.0.0.0/8 or `[::1]`.
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(address)) => IpAddr::V4(address).is_loopback(),
        Some(Host::Ipv6(address)) => IpAddr::V6(address).is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_are_accepted_and_refused_by_the_rules() {
        // Built at run time, because the secrets check refuses a literal URL with a password.
        let with_password = format!("https://{}:{}@example.com/v1", "user", "pass");
        let with_user = format!("https://{}@example.com/v1", "user");
        let cases: &[(&str, Result<&str, &str>)] = &[
            (
                "  https://openrouter.ai/api/v1/\n",
                Ok("https://openrouter.ai/api/v1"),
            ),
            ("https://example.com", Ok("https://example.com")),
            ("http://localhost:11434/v1", Ok("http://localhost:11434/v1")),
            ("http://127.0.0.1:8080/v1", Ok("http://127.0.0.1:8080/v1")),
            ("http://127.1.2.3/v1", Ok("http://127.1.2.3/v1")),
            ("http://[::1]:8080/v1", Ok("http://[::1]:8080/v1")),
            ("http://example.com/v1", Err("must start with https://")),
            ("http://192.168.1.2/v1", Err("must start with https://")),
            ("ftp://example.com/v1", Err("must start with https://")),
            (&with_password, Err("user name and password")),
            (&with_user, Err("user name and password")),
            ("https://example.com/v1?", Err("query string")),
            ("https://example.com/v1?key=1", Err("query string")),
            ("https://example.com/v1#top", Err("fragment")),
            (
                "https://example.com/v1/chat/completions",
                Err("Leave /chat/completions out"),
            ),
            (
                "https://example.com/v1/chat/completions/",
                Err("Leave /chat/completions out"),
            ),
            ("openrouter.ai/api/v1", Err("full address")),
            ("", Err("full address")),
        ];
        for (text, expected) in cases {
            let result = BaseUrl::parse(text);
            match (expected, &result) {
                (Ok(normalised), Ok(url)) => assert_eq!(url.as_str(), *normalised, "{text}"),
                (Err(rule), Err(message)) => assert!(message.contains(rule), "{text}: {message}"),
                _ => panic!("{text}: expected {expected:?}, got {result:?}"),
            }
        }
    }

    #[test]
    fn the_origin_is_the_scheme_host_and_port() {
        let url = |text| BaseUrl::parse(text).unwrap();
        let saved = url("https://openrouter.ai/api/v1");

        assert_eq!(saved.origin(), url("https://openrouter.ai/v2").origin());
        assert_eq!(
            saved.origin(),
            url("https://openrouter.ai:443/api").origin()
        );
        assert_ne!(saved.origin(), url("https://example.com/api/v1").origin());
        assert_ne!(
            saved.origin(),
            url("https://openrouter.ai:8443/api/v1").origin()
        );
        assert_ne!(
            url("http://localhost:8080/v1").origin(),
            url("https://localhost:8080/v1").origin()
        );
        assert_ne!(
            url("http://localhost:8080/v1").origin(),
            url("http://127.0.0.1:8080/v1").origin()
        );
    }

    #[test]
    fn the_host_names_the_port_only_when_the_url_does() {
        assert_eq!(
            BaseUrl::parse("https://openrouter.ai/api/v1")
                .unwrap()
                .host(),
            "openrouter.ai"
        );
        assert_eq!(
            BaseUrl::parse("http://[::1]:8080/v1").unwrap().host(),
            "[::1]:8080"
        );
    }
}
