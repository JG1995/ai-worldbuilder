//! The assistant's chat request, whose answer streams back as server-sent events.
//!
//! It follows the connection test's rules: the saved base URL followed by `/chat/completions`, no
//! proxy, no redirect followed, the platform's certificate verifier, and the key only in the
//! `Authorization` header and replaced by `[key]` in every reason and provider message passed on.
//! It has no total timeout, because an answer may stream for minutes; each read gives up after
//! the read timeout instead. Everything the provider sends is untrusted, so the parser bounds the
//! answer's text, each line and the whole stream.

use std::time::Duration;

use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, Response, redirect};
use serde::Serialize;
use serde_json::{Value, json};

use super::BaseUrl;
use super::ProviderFailure;
use super::chat::{
    hide_key, innermost_reason, provider_message, read_bounded, redirect_host, send_failure,
    status_failure,
};

/// How long the request waits for the provider to send anything, before and during the answer.
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// The most answer text kept, in bytes; the request ends as cut off past it.
const TEXT_BOUND: usize = 1024 * 1024;
/// The longest event-stream line, in bytes.
const LINE_BOUND: usize = 1024 * 1024;
/// The most the whole answer may hold, in bytes, ignored reasoning included.
const STREAM_BOUND: usize = 16 * 1024 * 1024;
/// The most of an error answer that is read for the provider's message.
const ERROR_BOUND: usize = 1024 * 1024;

/// One message of the conversation sent to the provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
}

/// How a streamed answer ended. The text itself went to `on_text` as it arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEnd {
    /// The provider finished the answer.
    Complete,
    /// The answer's text reached `TEXT_BOUND`, so the request ended there.
    CutOff,
    Failed {
        reason: ProviderFailure,
        /// The system's reason or the redirect's host, with the key replaced.
        detail: Option<String>,
        /// The provider's message, at most 500 characters, with the key replaced.
        provider_message: Option<String>,
    },
}

impl StreamEnd {
    fn failed(reason: ProviderFailure, detail: Option<String>) -> Self {
        Self::Failed {
            reason,
            detail,
            provider_message: None,
        }
    }

    fn invalid() -> Self {
        Self::failed(ProviderFailure::InvalidReply, None)
    }
}

/// Sends `messages` to `model` at `base_url`, with `key` as a bearer token when there is one, and
/// passes each piece of the answer's text to `on_text` as it arrives.
pub async fn chat_stream(
    base_url: &BaseUrl,
    model: &str,
    key: Option<&str>,
    messages: &[ChatMessage],
    read_timeout: Duration,
    mut on_text: impl FnMut(&str),
) -> StreamEnd {
    let client = Client::builder()
        // A proxy from the environment or the system settings would carry the key and the world's
        // pages to a host the user never configured.
        .no_proxy()
        .redirect(redirect::Policy::none())
        .read_timeout(read_timeout)
        .build();
    let client = match client {
        Ok(client) => client,
        Err(error) => return send_failed(&error, key),
    };
    let body = json!({ "model": model, "messages": messages, "stream": true });
    let mut request = client
        .post(base_url.chat_url())
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string());
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => return send_failed(&error, key),
    };

    let status = response.status();
    if status.is_redirection() {
        let host = redirect_host(&response).map(|host| hide_key(&host, key));
        return StreamEnd::failed(ProviderFailure::Redirected, host);
    }
    if !status.is_success() {
        let answer = match read_bounded(&mut response, ERROR_BOUND).await {
            Ok(answer) => answer,
            Err(error) => return read_failed(&error, key),
        };
        return StreamEnd::Failed {
            reason: status_failure(status, key),
            detail: None,
            provider_message: answer.and_then(|answer| provider_message(&answer, key)),
        };
    }
    let whole_reply = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"));
    match whole_reply {
        true => read_reply(&mut response, key, &mut on_text).await,
        false => read_events(&mut response, key, &mut on_text).await,
    }
}

/// A provider that ignores `stream` answers with one chat reply, which is taken whole.
async fn read_reply(
    response: &mut Response,
    key: Option<&str>,
    on_text: &mut impl FnMut(&str),
) -> StreamEnd {
    let answer = match read_bounded(response, STREAM_BOUND).await {
        Ok(Some(answer)) => answer,
        Ok(None) => return StreamEnd::invalid(),
        Err(error) => return read_failed(&error, key),
    };
    let Ok(reply) = serde_json::from_slice::<Value>(&answer) else {
        return StreamEnd::invalid();
    };
    let mut text = Text::default();
    match reply
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
    {
        Some(content) => text
            .add(content, on_text)
            .unwrap_or_else(|| text.complete()),
        None => StreamEnd::invalid(),
    }
}

async fn read_events(
    response: &mut Response,
    key: Option<&str>,
    on_text: &mut impl FnMut(&str),
) -> StreamEnd {
    let mut events = Events::new(key);
    let mut received = 0;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                received += chunk.len();
                if received > STREAM_BOUND {
                    return StreamEnd::invalid();
                }
                if let Some(end) = events.feed(&chunk, on_text) {
                    return end;
                }
            }
            Ok(None) => return events.finish(on_text),
            Err(error) => return read_failed(&error, key),
        }
    }
}

fn send_failed(error: &reqwest::Error, key: Option<&str>) -> StreamEnd {
    let (reason, detail) = send_failure(error, key);
    StreamEnd::failed(reason, detail)
}

/// A read that failed after the provider started to answer: the read timeout expired, or the
/// connection broke.
fn read_failed(error: &reqwest::Error, key: Option<&str>) -> StreamEnd {
    match error.is_timeout() {
        true => StreamEnd::failed(ProviderFailure::Timeout, None),
        false => StreamEnd::failed(
            ProviderFailure::Interrupted,
            Some(innermost_reason(error, key)),
        ),
    }
}

/// The answer's text so far, bounded by `TEXT_BOUND`.
#[derive(Default)]
struct Text {
    length: usize,
}

impl Text {
    /// Passes `text` on, or as much of it as fits, and then ends the answer as cut off.
    fn add(&mut self, text: &str, on_text: &mut impl FnMut(&str)) -> Option<StreamEnd> {
        let room = TEXT_BOUND - self.length;
        if text.len() > room {
            let cut = (0..=room)
                .rev()
                .find(|&at| text.is_char_boundary(at))
                .unwrap_or(0);
            if cut > 0 {
                on_text(&text[..cut]);
            }
            return Some(StreamEnd::CutOff);
        }
        if !text.is_empty() {
            self.length += text.len();
            on_text(text);
        }
        None
    }

    /// The end of an answer the provider finished: one without text is not a chat answer.
    fn complete(&self) -> StreamEnd {
        match self.length {
            0 => StreamEnd::invalid(),
            _ => StreamEnd::Complete,
        }
    }
}

/// An event-stream parser: bytes in, the answer's text and its end out.
struct Events<'k> {
    key: Option<&'k str>,
    /// The bytes of the line not yet ended.
    line: Vec<u8>,
    /// The `data` of the event not yet ended, its lines joined by `\n`.
    data: Option<String>,
    /// Whether any `data` field arrived: a body without one is not an event stream.
    any_data: bool,
    text: Text,
}

impl<'k> Events<'k> {
    fn new(key: Option<&'k str>) -> Self {
        Self {
            key,
            line: Vec::new(),
            data: None,
            any_data: false,
            text: Text::default(),
        }
    }

    /// Takes in the next bytes, wherever they split a line or a character, and returns the
    /// answer's end once it is known.
    fn feed(&mut self, mut bytes: &[u8], on_text: &mut impl FnMut(&str)) -> Option<StreamEnd> {
        while let Some(at) = bytes.iter().position(|&byte| byte == b'\n') {
            self.line.extend_from_slice(&bytes[..at]);
            bytes = &bytes[at + 1..];
            if self.line.len() > LINE_BOUND {
                return Some(StreamEnd::invalid());
            }
            let line = std::mem::take(&mut self.line);
            if let Some(end) = self.take_line(&line, on_text) {
                return Some(end);
            }
        }
        self.line.extend_from_slice(bytes);
        match self.line.len() > LINE_BOUND {
            true => Some(StreamEnd::invalid()),
            false => None,
        }
    }

    /// The end of a body that closed: its last line and event count, but an answer that was never
    /// finished was interrupted, and a body without events is not a chat answer.
    fn finish(&mut self, on_text: &mut impl FnMut(&str)) -> StreamEnd {
        let line = std::mem::take(&mut self.line);
        if !line.is_empty()
            && let Some(end) = self.take_line(&line, on_text)
        {
            return end;
        }
        self.dispatch(on_text)
            .unwrap_or_else(|| match self.any_data {
                true => StreamEnd::failed(ProviderFailure::Interrupted, None),
                false => StreamEnd::invalid(),
            })
    }

    fn take_line(&mut self, line: &[u8], on_text: &mut impl FnMut(&str)) -> Option<StreamEnd> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            return self.dispatch(on_text);
        }
        // A comment, such as a keep-alive.
        if line.starts_with(b":") {
            return None;
        }
        let Some(value) = line.strip_prefix(b"data:") else {
            // `event`, `id`, `retry` and unknown fields say nothing about a chat answer.
            return None;
        };
        let value = value.strip_prefix(b" ").unwrap_or(value);
        let Ok(value) = std::str::from_utf8(value) else {
            return Some(StreamEnd::invalid());
        };
        self.any_data = true;
        match &mut self.data {
            Some(data) => {
                data.push('\n');
                data.push_str(value);
            }
            None => self.data = Some(value.to_owned()),
        }
        None
    }

    /// Ends the current event and takes in its data.
    fn dispatch(&mut self, on_text: &mut impl FnMut(&str)) -> Option<StreamEnd> {
        let data = self.data.take()?;
        if data == "[DONE]" {
            return Some(self.text.complete());
        }
        let Ok(event) = serde_json::from_str::<Value>(&data) else {
            return Some(StreamEnd::invalid());
        };
        if let Some(error) = event.get("error").filter(|error| error.is_object()) {
            let code = &error["code"];
            let reason = match code.as_u64() == Some(429) || code.as_str() == Some("429") {
                true => ProviderFailure::RateLimited,
                false => ProviderFailure::ProviderError,
            };
            return Some(StreamEnd::Failed {
                reason,
                detail: None,
                provider_message: provider_message(data.as_bytes(), self.key),
            });
        }
        let mut finished = false;
        for choice in event["choices"].as_array().into_iter().flatten() {
            // Only `content` is the answer; `reasoning` and `reasoning_content` are left out.
            if let Some(content) = choice["delta"]["content"].as_str()
                && let Some(end) = self.text.add(content, on_text)
            {
                return Some(end);
            }
            finished |= !choice["finish_reason"].is_null();
        }
        finished.then(|| self.text.complete())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_support::*;
    use std::env;
    use tauri::async_runtime::block_on;

    const MODEL: &str = "anthropic/claude-sonnet-4.5";
    const KEY: &str = "sk-test-0123456789";
    const TIMEOUT: Duration = Duration::from_secs(10);

    fn messages() -> Vec<ChatMessage> {
        vec![
            ChatMessage {
                role: Role::System,
                content: "You help.".to_owned(),
            },
            ChatMessage {
                role: Role::User,
                content: "Where is Saltmere?".to_owned(),
            },
        ]
    }

    /// Streams from `server` and returns the end and the text received.
    fn stream_from(server: &Server, key: Option<&str>, timeout: Duration) -> (StreamEnd, String) {
        let mut text = String::new();
        let end = block_on(chat_stream(
            &server.base_url("/api/v1/"),
            MODEL,
            key,
            &messages(),
            timeout,
            |piece| text.push_str(piece),
        ));
        (end, text)
    }

    fn run(server: &Server) -> (StreamEnd, String) {
        stream_from(server, Some(KEY), TIMEOUT)
    }

    fn delta(text: &str) -> String {
        let event = json!({ "choices": [{ "index": 0, "delta": { "content": text } }] });
        format!("data: {event}\n\n")
    }

    fn events(body: &str) -> Vec<u8> {
        answer(
            "200 OK",
            &[("Content-Type", "text/event-stream")],
            body.as_bytes(),
        )
    }

    fn reason(end: &StreamEnd) -> ProviderFailure {
        match end {
            StreamEnd::Failed { reason, .. } => *reason,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn the_request_asks_for_a_stream_with_the_model_the_messages_and_the_key() {
        let server = Server::answering(events(&format!("{}data: [DONE]\n\n", delta("Hi"))));

        assert_eq!(run(&server), (StreamEnd::Complete, "Hi".to_owned()));
        assert_eq!(
            stream_from(&server, None, TIMEOUT),
            (StreamEnd::Complete, "Hi".to_owned())
        );

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].path, "/api/v1/chat/completions");
        assert_eq!(requests[0].header("content-type"), Some("application/json"));
        assert_eq!(
            requests[0].header("authorization"),
            Some(format!("Bearer {KEY}").as_str())
        );
        assert_eq!(requests[1].header("authorization"), None);
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            body,
            json!({
                "model": MODEL,
                "messages": [
                    { "role": "system", "content": "You help." },
                    { "role": "user", "content": "Where is Saltmere?" },
                ],
                "stream": true,
            })
        );
    }

    #[test]
    fn text_split_anywhere_inside_lines_and_characters_arrives_whole() {
        let body = format!(
            ": comment\r\n\r\nevent: message\ndata:{}\n\n{}{}data: [DONE]\n\n",
            r#"{"choices":[{"delta":{"content":"Salt"}}]}"#,
            delta("mere, ünder the ☾ — "),
            delta("🜁 ok"),
        );
        // Every byte its own chunk, so every line and every multi-byte character is split.
        let mut events = Events::new(Some(KEY));
        let mut text = String::new();
        let mut end = None;
        for byte in body.as_bytes() {
            end = events.feed(std::slice::from_ref(byte), &mut |piece| {
                text.push_str(piece)
            });
            if end.is_some() {
                break;
            }
        }

        assert_eq!(end, Some(StreamEnd::Complete));
        assert_eq!(text, "Saltmere, ünder the ☾ — 🜁 ok");
    }

    #[test]
    fn comments_and_reasoning_are_ignored() {
        let reasoning = r#"data: {"choices":[{"delta":{"reasoning":"Hmm","reasoning_content":"Let me think"}}]}"#;
        let server = Server::answering(events(&format!(
            ": OPENROUTER PROCESSING\n\n{reasoning}\n\n{}data: [DONE]\n\n",
            delta("Answer")
        )));

        assert_eq!(run(&server), (StreamEnd::Complete, "Answer".to_owned()));
    }

    #[test]
    fn done_or_a_finish_reason_completes_without_waiting_for_the_connection_to_close() {
        let finish = r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#;
        for ending in ["data: [DONE]\n\n".to_owned(), format!("{finish}\n\n")] {
            let server = Server::streaming(
                vec![
                    stream_head(),
                    delta("One").into_bytes(),
                    ending.into_bytes(),
                ],
                true,
            );

            assert_eq!(run(&server), (StreamEnd::Complete, "One".to_owned()));
        }
    }

    #[test]
    fn a_stream_that_ends_without_finishing_is_interrupted() {
        let server = Server::streaming(vec![stream_head(), delta("Half").into_bytes()], false);

        let (end, text) = run(&server);

        assert_eq!(reason(&end), ProviderFailure::Interrupted);
        assert_eq!(text, "Half");
    }

    #[test]
    fn a_web_page_is_not_a_chat_answer() {
        let page = b"<!doctype html>\n<html>\n<body>Welcome</body>\n</html>\n";
        let server = Server::answering(answer("200 OK", &[("Content-Type", "text/html")], page));

        assert_eq!(run(&server), (StreamEnd::invalid(), String::new()));
    }

    #[test]
    fn an_error_event_fails_with_its_message_without_the_key() {
        let error = |code: Value| {
            let event = json!({ "error": { "code": code, "message": format!("Upstream failed for {KEY}.") } });
            events(&format!("{}data: {event}\n\n", delta("Part")))
        };
        let cases = [
            (json!(502), ProviderFailure::ProviderError),
            (json!(429), ProviderFailure::RateLimited),
            (json!("429"), ProviderFailure::RateLimited),
        ];
        for (code, expected) in cases {
            let server = Server::answering(error(code));

            let (end, text) = run(&server);

            assert_eq!(
                end,
                StreamEnd::Failed {
                    reason: expected,
                    detail: None,
                    provider_message: Some("Upstream failed for [key].".to_owned()),
                }
            );
            assert_eq!(text, "Part");
        }
    }

    #[test]
    fn a_whole_chat_reply_is_accepted() {
        let server = Server::answering(json_answer(
            "200 OK",
            r#"{"choices":[{"message":{"role":"assistant","content":"All at once"}}]}"#,
        ));

        assert_eq!(
            run(&server),
            (StreamEnd::Complete, "All at once".to_owned())
        );
    }

    #[test]
    fn an_answer_without_text_is_not_a_chat_answer() {
        let answers = [
            events("data: [DONE]\n\n"),
            events(r#"data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}"#),
            events("data: <html>\n\n"),
            json_answer("200 OK", r#"{"choices":[{"message":{"content":""}}]}"#),
            json_answer("200 OK", r#"{"data":[]}"#),
        ];
        for answer in answers {
            let server = Server::answering(answer);

            assert_eq!(run(&server), (StreamEnd::invalid(), String::new()));
        }
    }

    #[test]
    fn text_past_its_bound_is_cut_off_at_the_bound() {
        let piece = "é".repeat(100_000);
        let mut body = String::new();
        while body.len() < TEXT_BOUND + 300_000 {
            body.push_str(&delta(&piece));
        }
        let server = Server::answering(events(&body));

        let (end, text) = run(&server);

        assert_eq!(end, StreamEnd::CutOff);
        assert_eq!(text.len(), TEXT_BOUND);
    }

    #[test]
    fn an_over_long_line_or_stream_is_not_a_chat_answer() {
        let long_line = events(&format!(": {}\n\n", "x".repeat(LINE_BOUND + 1)));
        let reasoning = format!(
            "data: {}\n\n",
            json!({ "choices": [{ "delta": { "reasoning": "y".repeat(500_000) } }] })
        );
        let long_stream = events(&reasoning.repeat(STREAM_BOUND / reasoning.len() + 1));
        for answer in [long_line, long_stream] {
            let server = Server::answering(answer);

            assert_eq!(run(&server).0, StreamEnd::invalid());
        }
    }

    #[test]
    fn a_silent_provider_times_out_before_and_after_the_headers() {
        let before = Server::silent();
        let after = Server::streaming(vec![stream_head(), delta("Wait").into_bytes()], true);

        let short = Duration::from_millis(200);
        assert_eq!(
            stream_from(&before, Some(KEY), short),
            (
                StreamEnd::failed(ProviderFailure::Timeout, None),
                String::new()
            )
        );
        assert_eq!(
            stream_from(&after, Some(KEY), short),
            (
                StreamEnd::failed(ProviderFailure::Timeout, None),
                "Wait".to_owned()
            )
        );
    }

    #[test]
    fn error_answers_and_redirects_fail_as_the_test_does() {
        let cases = [
            ("401 Unauthorized", ProviderFailure::KeyRefused),
            ("404 Not Found", ProviderFailure::NotFound),
            ("429 Too Many Requests", ProviderFailure::RateLimited),
            ("400 Bad Request", ProviderFailure::Refused),
            ("500 Internal Server Error", ProviderFailure::ProviderError),
        ];
        for (status, expected) in cases {
            let message = format!("Key {KEY} is wrong.");
            let server = Server::answering(json_answer(
                status,
                &json!({ "error": { "message": message } }).to_string(),
            ));

            assert_eq!(
                run(&server).0,
                StreamEnd::Failed {
                    reason: expected,
                    detail: None,
                    provider_message: Some("Key [key] is wrong.".to_owned()),
                },
                "{status}"
            );
        }

        let server = Server::answering(answer(
            "307 Temporary Redirect",
            &[("Location", "https://elsewhere.example/v1/chat/completions")],
            b"",
        ));
        assert_eq!(
            run(&server).0,
            StreamEnd::failed(
                ProviderFailure::Redirected,
                Some("elsewhere.example".to_owned())
            )
        );
        assert_eq!(server.requests().len(), 1);
    }

    /// Streams a short answer from the provider in `GRIMOIRE_TEST_BASE_URL`, `GRIMOIRE_TEST_MODEL`
    /// and `GRIMOIRE_TEST_API_KEY`. Nothing it prints holds the key. Run by name only.
    #[test]
    #[ignore = "sends a request to a real provider"]
    fn real_provider_streams() {
        // A variable's error can show its value, so it is never printed.
        let variable = |name: &str| env::var(name).unwrap_or_else(|_| panic!("{name} is not set"));
        let base_url = BaseUrl::parse(&variable("GRIMOIRE_TEST_BASE_URL")).unwrap();
        let model = variable("GRIMOIRE_TEST_MODEL");
        let key = variable("GRIMOIRE_TEST_API_KEY");
        let messages = [ChatMessage {
            role: Role::User,
            content: "Reply with one short sentence about the sea.".to_owned(),
        }];
        let mut text = String::new();

        let end = block_on(chat_stream(
            &base_url,
            &model,
            Some(&key),
            &messages,
            READ_TIMEOUT,
            |piece| text.push_str(piece),
        ));

        // The end is compared, not printed, because a failure's message could hold the key.
        assert!(end == StreamEnd::Complete, "the answer did not complete");
        assert!(!text.trim().is_empty());
    }
}
