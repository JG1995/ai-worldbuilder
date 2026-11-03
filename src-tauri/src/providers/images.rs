//! OpenRouter's image API, the image provider's only address. Its connection test asks
//! OpenRouter whether it accepts the key (`GET /key`) and lists the model among its image models
//! (`GET /images/models`), without generating an image.
//!
//! The requests follow the chat test's rules: no proxy, no redirect followed, the platform's
//! certificate verifier, the test's timeout, and the key only in the `Authorization` header and
//! replaced by `[key]` in every text passed on. At most `REPLY_BOUND` bytes of a reply are read.
//! Every function takes the base URL, so tests point it at a local server.

use std::time::Duration;

use reqwest::{Client, StatusCode, redirect};
use serde::Serialize;
use serde_json::Value;

use super::ProviderFailure;
use super::chat::{
    hide_key, provider_message, read_bounded, redirect_host, send_failure, status_failure,
};

/// Where every image request goes.
pub const OPENROUTER: &str = "https://openrouter.ai/api/v1";
/// `OPENROUTER`'s host, as the key's status line names it.
pub const HOST: &str = "openrouter.ai";
/// The most of a key or model listing reply that is read.
const REPLY_BOUND: usize = 4 * 1024 * 1024;

/// Why a request to the image provider failed. The text provider's `ProviderFailure` is not
/// reused, so its reasons and texts stay as they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ImageFailure {
    /// The host could not be reached.
    Unreachable,
    /// The secure connection to the host failed.
    Insecure,
    /// The host did not answer in time.
    Timeout,
    /// HTTP 401 or 403: the key was not accepted.
    KeyRefused,
    /// HTTP 402: the account is out of credit, or the key reached its limit.
    NoCredit,
    /// The model is not one of OpenRouter's image models.
    UnknownModel,
    /// HTTP 429.
    RateLimited,
    /// Another HTTP 4xx, such as a prompt the provider refuses.
    Refused,
    /// HTTP 5xx.
    ProviderError,
    /// The provider answered with a redirect, which is not followed.
    Redirected,
    /// The reply is not what OpenRouter's API answers.
    InvalidReply,
    /// The reply holds no usable image.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "generations arrive in package image-generation")
    )]
    NoImage,
    /// The key cannot be read from its storage, so nothing was sent.
    KeyUnreadable,
    /// The connection ended before the reply was complete.
    Interrupted,
}

impl From<ProviderFailure> for ImageFailure {
    /// The chat request's reasons, shared with the image requests. A 401 or 403 always refuses
    /// the key, since an image request always carries one, and a 404 is a refusal.
    fn from(failure: ProviderFailure) -> Self {
        match failure {
            ProviderFailure::Unreachable => Self::Unreachable,
            ProviderFailure::Insecure => Self::Insecure,
            ProviderFailure::Timeout => Self::Timeout,
            ProviderFailure::KeyRefused | ProviderFailure::KeyNeeded => Self::KeyRefused,
            ProviderFailure::RateLimited => Self::RateLimited,
            ProviderFailure::NotFound | ProviderFailure::Refused => Self::Refused,
            ProviderFailure::ProviderError => Self::ProviderError,
            ProviderFailure::Redirected => Self::Redirected,
            ProviderFailure::InvalidReply => Self::InvalidReply,
            ProviderFailure::KeyUnreadable => Self::KeyUnreadable,
            ProviderFailure::Interrupted => Self::Interrupted,
        }
    }
}

/// How the image provider's connection test ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ImageTestOutcome {
    /// OpenRouter accepted the key and lists the model among its image models.
    Success,
    /// The test failed for `reason`.
    Failed {
        reason: ImageFailure,
        /// The system's or the secure connection's reason, the redirect's host, or why the key
        /// cannot be read.
        detail: Option<String>,
        /// The provider's `error.message` or short text answer, at most 500 characters, with the
        /// key replaced by `[key]`.
        provider_message: Option<String>,
    },
    /// The test was cancelled, AI was switched off or the image provider was saved again, so its
    /// result is discarded.
    Cancelled,
}

impl ImageTestOutcome {
    pub fn failed(reason: ImageFailure, detail: Option<String>) -> Self {
        Self::Failed {
            reason,
            detail,
            provider_message: None,
        }
    }
}

/// Asks the API at `base` whether it accepts `key`, then whether it lists `model` among its image
/// models.
pub async fn test(base: &str, model: &str, key: &str, timeout: Duration) -> ImageTestOutcome {
    let client = Client::builder()
        // A proxy from the environment or the system settings would carry the key to a host the
        // user never consented to.
        .no_proxy()
        .redirect(redirect::Policy::none())
        .timeout(timeout)
        .build();
    let client = match client {
        Ok(client) => client,
        Err(error) => return failed_send(&error, key),
    };
    if let Err(outcome) = get(&client, &format!("{base}/key"), key).await {
        return outcome;
    }
    let listing = match get(&client, &format!("{base}/images/models"), key).await {
        Ok(listing) => listing,
        Err(outcome) => return outcome,
    };
    match lists_model(&listing, model) {
        Some(true) => ImageTestOutcome::Success,
        Some(false) => ImageTestOutcome::failed(ImageFailure::UnknownModel, None),
        None => ImageTestOutcome::failed(ImageFailure::InvalidReply, None),
    }
}

/// The body of a successful `GET url` with `key`, or how the request failed.
async fn get(client: &Client, url: &str, key: &str) -> Result<Vec<u8>, ImageTestOutcome> {
    let mut response = client
        .get(url)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| failed_send(&error, key))?;
    let status = response.status();
    if status.is_redirection() {
        let host = redirect_host(&response).map(|host| hide_key(&host, Some(key)));
        return Err(ImageTestOutcome::failed(ImageFailure::Redirected, host));
    }
    let body = read_bounded(&mut response, REPLY_BOUND)
        .await
        .map_err(|error| failed_send(&error, key))?;
    if status.is_success() {
        return body.ok_or_else(|| ImageTestOutcome::failed(ImageFailure::InvalidReply, None));
    }
    Err(ImageTestOutcome::Failed {
        reason: status_failure_of(status, key),
        detail: None,
        provider_message: body.and_then(|body| provider_message(&body, Some(key))),
    })
}

/// The chat request's reason for `status`, with 402 as `NoCredit`.
fn status_failure_of(status: StatusCode, key: &str) -> ImageFailure {
    match status {
        StatusCode::PAYMENT_REQUIRED => ImageFailure::NoCredit,
        status => status_failure(status, Some(key)).into(),
    }
}

fn failed_send(error: &reqwest::Error, key: &str) -> ImageTestOutcome {
    let (reason, detail) = send_failure(error, Some(key));
    ImageTestOutcome::failed(reason.into(), detail)
}

/// Whether the model listing `{ "data": [{ "id" }, …] }` names `model`, or `None` when it is not
/// such a listing.
fn lists_model(listing: &[u8], model: &str) -> Option<bool> {
    let listing = serde_json::from_slice::<Value>(listing).ok()?;
    let models = listing["data"].as_array()?;
    Some(
        models
            .iter()
            .any(|entry| entry["id"].as_str() == Some(model)),
    )
}

#[cfg(test)]
mod tests {
    use super::super::TIMEOUT;
    use super::super::test_support::*;
    use super::*;
    use serde_json::json;
    use std::env;
    use tauri::async_runtime::block_on;

    const MODEL: &str = "google/gemini-2.5-flash-image";
    const KEY: &str = "sk-or-test-0123456789";
    const KEY_REPLY: &str = r#"{"data":{"label":"sk-or-…789","limit":null}}"#;

    fn listing(models: &[&str]) -> String {
        let data: Vec<Value> = models.iter().map(|id| json!({ "id": id })).collect();
        json!({ "data": data }).to_string()
    }

    /// A server that answers `/api/v1/key` with `key` and `/api/v1/images/models` with `models`.
    fn openrouter(key: Vec<u8>, models: Vec<u8>) -> Server {
        Server::start(move |request| match request.path.as_str() {
            "/api/v1/key" => Some(key.clone()),
            "/api/v1/images/models" => Some(models.clone()),
            _ => Some(json_answer("404 Not Found", "{}")),
        })
    }

    fn base(server: &Server) -> String {
        format!("http://{}/api/v1", server.address())
    }

    fn run(server: &Server) -> ImageTestOutcome {
        block_on(test(&base(server), MODEL, KEY, Duration::from_secs(10)))
    }

    fn reason(outcome: &ImageTestOutcome) -> ImageFailure {
        match outcome {
            ImageTestOutcome::Failed { reason, .. } => *reason,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn the_test_checks_the_key_and_then_finds_the_model_in_the_image_models() {
        let server = openrouter(
            json_answer("200 OK", KEY_REPLY),
            json_answer("200 OK", &listing(&["openai/gpt-image-1", MODEL])),
        );

        assert_eq!(run(&server), ImageTestOutcome::Success);

        let requests = server.requests();
        let paths: Vec<&str> = requests
            .iter()
            .map(|request| request.path.as_str())
            .collect();
        assert_eq!(paths, ["/api/v1/key", "/api/v1/images/models"]);
        for request in &requests {
            assert_eq!(request.method, "GET");
            assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {KEY}").as_str())
            );
            assert!(request.body.is_empty());
        }
    }

    #[test]
    fn a_listing_without_the_model_is_an_unknown_model_and_a_malformed_one_is_invalid() {
        let cases = [
            (listing(&["openai/gpt-image-1"]), ImageFailure::UnknownModel),
            (listing(&[]), ImageFailure::UnknownModel),
            (
                r#"{"data":{"id":"x"}}"#.to_owned(),
                ImageFailure::InvalidReply,
            ),
            (
                "<html>Welcome</html>".to_owned(),
                ImageFailure::InvalidReply,
            ),
        ];
        for (body, expected) in cases {
            let server = openrouter(
                json_answer("200 OK", KEY_REPLY),
                json_answer("200 OK", &body),
            );

            assert_eq!(
                run(&server),
                ImageTestOutcome::failed(expected, None),
                "{body}"
            );
        }
    }

    #[test]
    fn each_http_status_has_its_reason_and_a_refused_key_ends_the_test() {
        let cases = [
            ("401 Unauthorized", ImageFailure::KeyRefused),
            ("403 Forbidden", ImageFailure::KeyRefused),
            ("402 Payment Required", ImageFailure::NoCredit),
            ("404 Not Found", ImageFailure::Refused),
            ("429 Too Many Requests", ImageFailure::RateLimited),
            ("400 Bad Request", ImageFailure::Refused),
            ("500 Internal Server Error", ImageFailure::ProviderError),
            ("502 Bad Gateway", ImageFailure::ProviderError),
        ];
        for (status, expected) in cases {
            let server = openrouter(
                json_answer(status, r#"{"error":{"message":"Something is wrong."}}"#),
                json_answer("200 OK", &listing(&[MODEL])),
            );

            assert_eq!(
                run(&server),
                ImageTestOutcome::Failed {
                    reason: expected,
                    detail: None,
                    provider_message: Some("Something is wrong.".to_owned()),
                },
                "{status}"
            );
            assert_eq!(server.requests().len(), 1, "{status}");
        }
    }

    #[test]
    fn a_failed_listing_has_its_reason() {
        let server = openrouter(
            json_answer("200 OK", KEY_REPLY),
            json_answer(
                "402 Payment Required",
                r#"{"error":{"message":"No credit."}}"#,
            ),
        );

        assert_eq!(
            run(&server),
            ImageTestOutcome::Failed {
                reason: ImageFailure::NoCredit,
                detail: None,
                provider_message: Some("No credit.".to_owned()),
            }
        );
    }

    #[test]
    fn a_redirect_is_reported_with_its_host_and_not_followed() {
        let server = Server::answering(answer(
            "302 Found",
            &[("Location", &format!("https://{KEY}.elsewhere.example/key"))],
            b"",
        ));

        assert_eq!(
            run(&server),
            ImageTestOutcome::failed(
                ImageFailure::Redirected,
                Some("[key].elsewhere.example".to_owned())
            )
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn a_reply_over_4_mib_is_not_read() {
        let large = listing(&[MODEL, &"m".repeat(REPLY_BOUND)]);
        let server = openrouter(
            json_answer("200 OK", KEY_REPLY),
            json_answer("200 OK", &large),
        );

        assert_eq!(
            run(&server),
            ImageTestOutcome::failed(ImageFailure::InvalidReply, None)
        );
    }

    #[test]
    fn a_server_that_never_answers_times_out() {
        let server = Server::silent();

        let outcome = block_on(test(&base(&server), MODEL, KEY, Duration::from_millis(200)));

        assert_eq!(
            outcome,
            ImageTestOutcome::failed(ImageFailure::Timeout, None)
        );
    }

    #[test]
    fn the_key_never_appears_in_a_failure() {
        let message = format!("The key {KEY} is not valid.");
        let server = openrouter(
            json_answer(
                "401 Unauthorized",
                &json!({ "error": { "message": message } }).to_string(),
            ),
            json_answer("200 OK", &listing(&[MODEL])),
        );

        let outcome = run(&server);

        assert_eq!(reason(&outcome), ImageFailure::KeyRefused);
        let shown = serde_json::to_string(&outcome).unwrap();
        assert!(shown.contains("The key [key] is not valid."), "{shown}");
        assert!(!shown.contains(KEY), "{shown}");
    }

    #[test]
    fn a_failure_reaches_the_interface_in_its_wire_shape() {
        let outcome = ImageTestOutcome::Failed {
            reason: ImageFailure::NoImage,
            detail: None,
            provider_message: Some("No image.".to_owned()),
        };

        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            json!({
                "state": "failed",
                "reason": "no_image",
                "detail": null,
                "providerMessage": "No image.",
            })
        );
    }

    /// Runs the connection test against OpenRouter's free key and model endpoints with the key
    /// and model in `GRIMOIRE_TEST_IMAGE_KEY` and `GRIMOIRE_TEST_IMAGE_MODEL`. Nothing it prints
    /// holds the key. Run by name only.
    #[test]
    #[ignore = "sends requests to OpenRouter"]
    fn real_openrouter_test_connection() {
        let (Ok(key), Ok(model)) = (
            env::var("GRIMOIRE_TEST_IMAGE_KEY"),
            env::var("GRIMOIRE_TEST_IMAGE_MODEL"),
        ) else {
            println!("Skipped: GRIMOIRE_TEST_IMAGE_KEY and GRIMOIRE_TEST_IMAGE_MODEL must be set.");
            return;
        };

        let outcome = block_on(test(OPENROUTER, &model, &key, TIMEOUT));

        assert_eq!(outcome, ImageTestOutcome::Success);
    }
}
