//! The connection test's chat request, and the rules it shares with the streamed answer in
//! `stream`: how a failed request, an error answer and a redirect are reported.
//!
//! The request goes to the saved base URL followed by `/chat/completions`, through no proxy and
//! without following a redirect. The certificate is checked by the platform's verifier, at most
//! `ANSWER_BOUND` bytes of the answer are read, and the request gives up after its timeout. The
//! key goes only into the `Authorization` header, and every text passed on has it replaced.

use std::error::Error;
use std::io;
use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::{Client, Response, StatusCode, redirect};
use serde::Serialize;
use serde_json::{Value, json};
use url::Position;

use super::BaseUrl;

/// How long a test waits for the provider's answer.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// The most of an answer that is read; a larger one is not a chat reply the test can use.
const ANSWER_BOUND: usize = 1024 * 1024;
/// The most characters of a provider's message that are passed on.
const MESSAGE_LIMIT: usize = 500;
/// The test's one message. Reasoning models refuse some limits, so the request sets none.
const PROMPT: &str = "Reply with the word OK.";
/// What replaces the key in any text passed on.
const KEY_MARK: &str = "[key]";

/// How a connection test ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TestOutcome {
    /// The provider answered with a chat reply.
    Connected,
    /// The test was cancelled, AI was switched off or the provider was saved again, so its result
    /// is discarded.
    Cancelled,
    /// The test failed for `reason`.
    Failed {
        reason: ProviderFailure,
        /// The system's or the secure connection's reason, the redirect's host, or why the key
        /// cannot be read.
        detail: Option<String>,
        /// The provider's `error.message` or short text answer, at most 500 characters, with the
        /// key replaced by `[key]`.
        provider_message: Option<String>,
    },
}

/// Why a request to the provider failed: the connection test or a streamed answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailure {
    /// The host could not be reached.
    Unreachable,
    /// The secure connection to the host failed.
    Insecure,
    /// The host did not answer in time.
    Timeout,
    /// HTTP 401 or 403 with a key.
    KeyRefused,
    /// HTTP 401 or 403 without a key.
    KeyNeeded,
    /// HTTP 404.
    NotFound,
    /// HTTP 429.
    RateLimited,
    /// Another HTTP 4xx.
    Refused,
    /// HTTP 5xx.
    ProviderError,
    /// The provider answered with a redirect, which is not followed.
    Redirected,
    /// The answer is not an OpenAI-compatible chat reply.
    InvalidReply,
    /// The key cannot be read from its storage, so nothing was sent.
    KeyUnreadable,
    /// The connection ended before the answer was complete.
    Interrupted,
}

impl TestOutcome {
    pub fn failed(reason: ProviderFailure, detail: Option<String>) -> Self {
        Self::Failed {
            reason,
            detail,
            provider_message: None,
        }
    }
}

/// Sends the test request for `model` to `base_url`, with `key` as a bearer token when there is
/// one, and tells how it went.
pub async fn test(
    base_url: &BaseUrl,
    model: &str,
    key: Option<&str>,
    timeout: Duration,
) -> TestOutcome {
    let client = Client::builder()
        // A proxy from the environment or the system settings would carry the key to a host the
        // user never configured.
        .no_proxy()
        .redirect(redirect::Policy::none())
        .timeout(timeout)
        .build();
    let client = match client {
        Ok(client) => client,
        Err(error) => return failed(send_failure(&error, key)),
    };
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": PROMPT }],
    });
    let mut request = client
        .post(base_url.chat_url())
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string());
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => return failed(send_failure(&error, key)),
    };

    let status = response.status();
    if status.is_redirection() {
        let host = redirect_host(&response).map(|host| hide_key(&host, key));
        return TestOutcome::failed(ProviderFailure::Redirected, host);
    }
    let answer = match read_bounded(&mut response, ANSWER_BOUND).await {
        Ok(answer) => answer,
        Err(error) => return failed(send_failure(&error, key)),
    };
    if status.is_success() {
        return match answer.as_deref().is_some_and(is_chat_reply) {
            true => TestOutcome::Connected,
            false => TestOutcome::failed(ProviderFailure::InvalidReply, None),
        };
    }
    TestOutcome::Failed {
        reason: status_failure(status, key),
        detail: None,
        provider_message: answer.and_then(|answer| provider_message(&answer, key)),
    }
}

fn failed((reason, detail): (ProviderFailure, Option<String>)) -> TestOutcome {
    TestOutcome::failed(reason, detail)
}

/// Why an answer whose status is neither a success nor a redirect failed.
pub(super) fn status_failure(status: StatusCode, key: Option<&str>) -> ProviderFailure {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN if key.is_some() => {
            ProviderFailure::KeyRefused
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderFailure::KeyNeeded,
        StatusCode::NOT_FOUND => ProviderFailure::NotFound,
        StatusCode::TOO_MANY_REQUESTS => ProviderFailure::RateLimited,
        status if status.is_client_error() => ProviderFailure::Refused,
        _ => ProviderFailure::ProviderError,
    }
}

/// The answer's body, or `None` when it is larger than `bound` bytes.
pub(super) async fn read_bounded(
    response: &mut Response,
    bound: usize,
) -> reqwest::Result<Option<Vec<u8>>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > bound {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// JSON with at least one choice that has a message, as OpenAI's chat completions answer.
fn is_chat_reply(answer: &[u8]) -> bool {
    serde_json::from_slice::<Value>(answer).is_ok_and(|reply| {
        reply["choices"]
            .as_array()
            .is_some_and(|choices| choices.iter().any(|choice| choice["message"].is_object()))
    })
}

/// The host, with its port when it names one, that a redirect points to.
pub(super) fn redirect_host(response: &Response) -> Option<String> {
    let location = response.headers().get(LOCATION)?.to_str().ok()?;
    let target = response.url().join(location).ok()?;
    Some(target[Position::BeforeHost..Position::AfterPort].to_owned())
}

/// A request that got no answer: a timeout, a failed secure connection, or an unreachable host,
/// with the innermost reason.
pub(super) fn send_failure(
    error: &reqwest::Error,
    key: Option<&str>,
) -> (ProviderFailure, Option<String>) {
    if error.is_timeout() {
        return (ProviderFailure::Timeout, None);
    }
    let reason = match is_tls_failure(error) {
        true => ProviderFailure::Insecure,
        false => ProviderFailure::Unreachable,
    };
    (reason, Some(innermost_reason(error, key)))
}

/// The innermost cause of `error`, with the key replaced.
pub(super) fn innermost_reason(error: &reqwest::Error, key: Option<&str>) -> String {
    let mut innermost: &dyn Error = error;
    while let Some(source) = innermost.source() {
        innermost = source;
    }
    hide_key(&innermost.to_string(), key)
}

/// Whether a `rustls` error is among the causes. An `io::Error`'s `source` skips the error it
/// wraps, which may be another `io::Error`, so the walk goes on through `get_ref` instead.
fn is_tls_failure(error: &reqwest::Error) -> bool {
    let mut cause: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(error) = cause {
        if error.is::<rustls::Error>() {
            return true;
        }
        cause = match error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::get_ref)
        {
            Some(wrapped) => Some(wrapped),
            None => error.source(),
        };
    }
    false
}

/// The provider's `error.message`, or the answer itself when it is not JSON, with the key
/// replaced and cut to `MESSAGE_LIMIT` characters.
pub(super) fn provider_message(answer: &[u8], key: Option<&str>) -> Option<String> {
    let text = match serde_json::from_slice::<Value>(answer) {
        Ok(json) => json.pointer("/error/message")?.as_str()?.to_owned(),
        Err(_) => String::from_utf8_lossy(answer).into_owned(),
    };
    // The key is replaced before the cut, so a cut never leaves part of it.
    let text = hide_key(text.trim(), key);
    if text.is_empty() {
        return None;
    }
    Some(match text.chars().count() > MESSAGE_LIMIT {
        true => text.chars().take(MESSAGE_LIMIT - 1).chain(['…']).collect(),
        false => text,
    })
}

pub(super) fn hide_key(text: &str, key: Option<&str>) -> String {
    match key.filter(|key| !key.is_empty()) {
        Some(key) => text.replace(key, KEY_MARK),
        None => text.to_owned(),
    }
}

/// A small HTTP server on loopback for the tests of this area and of `settings`. It records each
/// request and answers it from a script.
#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::thread;

    pub const CHAT_REPLY: &str =
        r#"{"choices":[{"index":0,"message":{"role":"assistant","content":"OK"}}]}"#;

    /// A request as the server received it, with header names in lower case.
    #[derive(Debug, Clone)]
    pub struct Recorded {
        pub method: String,
        pub path: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Recorded {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(header, _)| header == name)
                .map(|(_, value)| value.as_str())
        }
    }

    /// How the server answers a request: `parts` written one after another with a short pause
    /// between them, and then the connection closed, or held until the client gives up.
    struct Reply {
        parts: Vec<Vec<u8>>,
        hold: bool,
    }

    type Script = dyn Fn(&Recorded) -> Reply + Send + Sync;

    pub struct Server {
        address: SocketAddr,
        requests: Arc<Mutex<Vec<Recorded>>>,
    }

    impl Server {
        /// A server that answers each request with the bytes `script` gives, or never.
        pub fn start(
            script: impl Fn(&Recorded) -> Option<Vec<u8>> + Send + Sync + 'static,
        ) -> Self {
            Self::serving(move |request| match script(request) {
                Some(answer) => Reply {
                    parts: vec![answer],
                    hold: false,
                },
                None => Reply {
                    parts: Vec::new(),
                    hold: true,
                },
            })
        }

        /// A server that answers every request with `parts`, pausing between them, and then
        /// closes the connection, or holds it open with `hold`.
        pub fn streaming(parts: Vec<Vec<u8>>, hold: bool) -> Self {
            Self::serving(move |_| Reply {
                parts: parts.clone(),
                hold,
            })
        }

        fn serving(script: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = requests.clone();
            let script: Arc<Script> = Arc::new(script);
            // The thread ends with the test process.
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let recorded = recorded.clone();
                    let script = script.clone();
                    thread::spawn(move || serve(stream, &recorded, &*script));
                }
            });
            Self { address, requests }
        }

        /// A server that answers every request with `answer`.
        pub fn answering(answer: Vec<u8>) -> Self {
            Self::start(move |_| Some(answer.clone()))
        }

        /// A server that never answers.
        pub fn silent() -> Self {
            Self::start(|_| None)
        }

        /// The base URL `http://127.0.0.1:<port><path>`.
        pub fn base_url(&self, path: &str) -> BaseUrl {
            BaseUrl::parse(&format!("http://{}{path}", self.address)).unwrap()
        }

        pub fn address(&self) -> SocketAddr {
            self.address
        }

        pub fn requests(&self) -> Vec<Recorded> {
            self.requests.lock().unwrap().clone()
        }
    }

    /// An HTTP/1.1 answer with `status`, `headers` and `body`, after which the server closes.
    pub fn answer(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        [head.as_bytes(), body].concat()
    }

    /// The head of a `200` event stream without a length, so its body ends when the server closes.
    pub fn stream_head() -> Vec<u8> {
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".to_vec()
    }

    pub fn json_answer(status: &str, body: &str) -> Vec<u8> {
        answer(
            status,
            &[("Content-Type", "application/json")],
            body.as_bytes(),
        )
    }

    fn serve(mut stream: TcpStream, requests: &Mutex<Vec<Recorded>>, script: &Script) {
        let mut received = Vec::new();
        let mut buffer = [0; 8192];
        let head_end = loop {
            if let Some(end) = find(&received, b"\r\n\r\n") {
                break end;
            }
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => received.extend_from_slice(&buffer[..read]),
            }
            // A TLS handshake gets a plain HTTP answer, as a server without TLS gives.
            if received.first() == Some(&0x16) {
                let _ = stream.write_all(&answer("400 Bad Request", &[], b""));
                return;
            }
        };
        let head = String::from_utf8_lossy(&received[..head_end]).into_owned();
        let mut lines = head.split("\r\n");
        let mut request_line = lines.next().unwrap_or_default().split(' ');
        let method = request_line.next().unwrap_or_default().to_owned();
        let path = request_line.next().unwrap_or_default().to_owned();
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_lowercase(), value.trim().to_owned()))
            .collect();
        let length = headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        let mut body = received[head_end + 4..].to_vec();
        while body.len() < length {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => body.extend_from_slice(&buffer[..read]),
            }
        }
        let request = Recorded {
            method,
            path,
            headers,
            body,
        };
        requests.lock().unwrap().push(request.clone());
        let reply = script(&request);
        for (index, part) in reply.parts.iter().enumerate() {
            if index > 0 {
                thread::sleep(Duration::from_millis(20));
            }
            // The client may stop reading early, as for an answer over the bound.
            if stream
                .write_all(part)
                .and_then(|()| stream.flush())
                .is_err()
            {
                return;
            }
        }
        if reply.hold {
            // Holds the connection until the client gives up.
            while matches!(stream.read(&mut buffer), Ok(read) if read > 0) {}
        }
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use std::env;
    use std::net::TcpListener;
    use std::process::Command;
    use tauri::async_runtime::block_on;

    const MODEL: &str = "anthropic/claude-sonnet-4.5";
    const KEY: &str = "sk-test-0123456789";

    fn run(base_url: &BaseUrl, key: Option<&str>) -> TestOutcome {
        block_on(test(base_url, MODEL, key, Duration::from_secs(10)))
    }

    fn reason(outcome: &TestOutcome) -> ProviderFailure {
        match outcome {
            TestOutcome::Failed { reason, .. } => *reason,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn the_test_sends_one_request_with_the_model_the_prompt_and_the_key() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));

        let outcome = run(&server.base_url("/api/v1/"), Some(KEY));

        assert_eq!(outcome, TestOutcome::Connected);
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/api/v1/chat/completions");
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {KEY}").as_str())
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(
            body,
            json!({
                "model": MODEL,
                "messages": [{ "role": "user", "content": "Reply with the word OK." }],
            })
        );
    }

    #[test]
    fn without_a_key_the_request_has_no_authorization_header() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));

        assert_eq!(run(&server.base_url(""), None), TestOutcome::Connected);

        assert_eq!(server.requests()[0].path, "/chat/completions");
        assert_eq!(server.requests()[0].header("authorization"), None);
    }

    #[test]
    fn each_http_status_has_its_reason() {
        let cases = [
            ("401 Unauthorized", Some(KEY), ProviderFailure::KeyRefused),
            ("403 Forbidden", Some(KEY), ProviderFailure::KeyRefused),
            ("401 Unauthorized", None, ProviderFailure::KeyNeeded),
            ("404 Not Found", Some(KEY), ProviderFailure::NotFound),
            (
                "429 Too Many Requests",
                Some(KEY),
                ProviderFailure::RateLimited,
            ),
            ("400 Bad Request", Some(KEY), ProviderFailure::Refused),
            (
                "422 Unprocessable Entity",
                Some(KEY),
                ProviderFailure::Refused,
            ),
            (
                "500 Internal Server Error",
                Some(KEY),
                ProviderFailure::ProviderError,
            ),
            (
                "503 Service Unavailable",
                Some(KEY),
                ProviderFailure::ProviderError,
            ),
        ];
        for (status, key, expected) in cases {
            let server = Server::answering(json_answer(
                status,
                r#"{"error":{"message":"Something is wrong."}}"#,
            ));

            let outcome = run(&server.base_url("/v1"), key);

            assert_eq!(
                outcome,
                TestOutcome::Failed {
                    reason: expected,
                    detail: None,
                    provider_message: Some("Something is wrong.".to_owned()),
                },
                "{status}"
            );
        }
    }

    #[test]
    fn a_redirect_is_reported_with_its_host_and_not_followed() {
        let server = Server::answering(answer(
            "302 Found",
            &[(
                "Location",
                "https://elsewhere.example:8443/v1/chat/completions",
            )],
            b"",
        ));

        let outcome = run(&server.base_url("/v1"), Some(KEY));

        assert_eq!(
            outcome,
            TestOutcome::failed(
                ProviderFailure::Redirected,
                Some("elsewhere.example:8443".to_owned())
            )
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn a_redirect_host_that_holds_the_key_is_reported_without_it() {
        let server = Server::answering(answer(
            "302 Found",
            &[("Location", &format!("https://{KEY}.elsewhere.example/v1"))],
            b"",
        ));

        let outcome = run(&server.base_url("/v1"), Some(KEY));

        assert_eq!(
            outcome,
            TestOutcome::failed(
                ProviderFailure::Redirected,
                Some("[key].elsewhere.example".to_owned())
            )
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn an_answer_that_is_not_a_chat_reply_is_invalid() {
        let too_large = format!(
            r#"{{"choices":[{{"message":{{"content":"{}"}}}}]}}"#,
            "a".repeat(ANSWER_BOUND)
        );
        let answers = [
            answer(
                "200 OK",
                &[("Content-Type", "text/html")],
                b"<html>Welcome</html>",
            ),
            json_answer("200 OK", r#"{"data":[]}"#),
            json_answer("200 OK", r#"{"choices":[]}"#),
            json_answer("200 OK", &too_large),
        ];
        for answer in answers {
            let server = Server::answering(answer);

            let outcome = run(&server.base_url("/v1"), Some(KEY));

            assert_eq!(
                outcome,
                TestOutcome::failed(ProviderFailure::InvalidReply, None)
            );
        }
    }

    #[test]
    fn a_closed_port_is_unreachable() {
        let address = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        // The listener is dropped, so nothing listens on the port any more.
        let base_url = BaseUrl::parse(&format!("http://{address}/v1")).unwrap();

        let outcome = run(&base_url, Some(KEY));

        assert_eq!(reason(&outcome), ProviderFailure::Unreachable);
        let TestOutcome::Failed { detail, .. } = outcome else {
            unreachable!()
        };
        assert!(detail.is_some_and(|detail| !detail.is_empty()));
    }

    #[test]
    fn https_to_a_server_without_tls_is_insecure() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let base_url = BaseUrl::parse(&format!("https://{}/v1", server.address())).unwrap();

        let outcome = run(&base_url, Some(KEY));

        assert_eq!(reason(&outcome), ProviderFailure::Insecure, "{outcome:?}");
        assert!(server.requests().is_empty());
    }

    #[test]
    fn a_server_that_never_answers_times_out() {
        let server = Server::silent();

        let outcome = block_on(test(
            &server.base_url("/v1"),
            MODEL,
            Some(KEY),
            Duration::from_millis(200),
        ));

        assert_eq!(outcome, TestOutcome::failed(ProviderFailure::Timeout, None));
    }

    #[test]
    fn a_provider_message_is_cut_and_never_shows_the_key() {
        let message = format!(
            "The key {KEY} is not valid for this model. {}",
            "x".repeat(600)
        );
        let server = Server::answering(json_answer(
            "400 Bad Request",
            &json!({ "error": { "message": message } }).to_string(),
        ));

        let outcome = run(&server.base_url("/v1"), Some(KEY));

        let TestOutcome::Failed {
            provider_message: Some(shown),
            ..
        } = outcome
        else {
            panic!("expected a provider message, got {outcome:?}");
        };
        assert!(shown.starts_with("The key [key] is not valid"), "{shown}");
        assert!(!shown.contains(KEY));
        assert_eq!(shown.chars().count(), 500);
        assert!(shown.ends_with('…'));
    }

    #[test]
    fn a_text_answer_is_the_provider_message() {
        let server = Server::answering(answer(
            "502 Bad Gateway",
            &[("Content-Type", "text/plain")],
            b"  upstream <b>down</b>\n",
        ));

        let outcome = run(&server.base_url("/v1"), None);

        assert_eq!(
            outcome,
            TestOutcome::Failed {
                reason: ProviderFailure::ProviderError,
                detail: None,
                provider_message: Some("upstream <b>down</b>".to_owned()),
            }
        );
    }

    /// Marks the child process that `requests_ignore_proxy_variables` starts, with the base URL
    /// to test.
    const PROXY_CHILD: &str = "GRIMOIRE_PROXY_CHILD_BASE_URL";

    /// Runs this test binary again with every proxy variable pointing at a recording server, so
    /// that the environment changes only in the child.
    #[test]
    fn requests_ignore_proxy_variables() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let proxy = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let proxy_url = format!("http://{}", proxy.address());
        let mut child = Command::new(env::current_exe().unwrap());
        child
            .args([
                "providers::chat::tests::proxy_child",
                "--exact",
                "--ignored",
            ])
            .env(PROXY_CHILD, server.base_url("/v1").as_str());
        for name in ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"] {
            child
                .env(name, &proxy_url)
                .env(name.to_lowercase(), &proxy_url);
        }
        for name in ["NO_PROXY", "no_proxy"] {
            child.env_remove(name);
        }

        let output = child.output().unwrap();

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{stdout}");
        assert!(stdout.contains("1 passed"), "{stdout}");
        assert_eq!(server.requests().len(), 1);
        assert!(proxy.requests().is_empty());
    }

    /// The child of `requests_ignore_proxy_variables`; without its marker it does nothing.
    #[test]
    #[ignore = "run by requests_ignore_proxy_variables"]
    fn proxy_child() {
        let Ok(base_url) = env::var(PROXY_CHILD) else {
            return;
        };

        let outcome = run(&BaseUrl::parse(&base_url).unwrap(), Some(KEY));

        assert_eq!(outcome, TestOutcome::Connected);
    }

    /// Sends the test request to the provider in `GRIMOIRE_TEST_BASE_URL`, `GRIMOIRE_TEST_MODEL`
    /// and `GRIMOIRE_TEST_API_KEY`. Nothing it prints holds the key. Run by name only.
    #[test]
    #[ignore = "sends a request to a real provider"]
    fn real_provider_answers() {
        // A variable's error can show its value, so it is never printed.
        let variable = |name: &str| env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let base_url = BaseUrl::parse(&variable("GRIMOIRE_TEST_BASE_URL")).unwrap();
        let model = variable("GRIMOIRE_TEST_MODEL");
        let key = variable("GRIMOIRE_TEST_API_KEY");

        let outcome = block_on(test(&base_url, &model, Some(&key), TIMEOUT));

        assert_eq!(outcome, TestOutcome::Connected);
    }
}
