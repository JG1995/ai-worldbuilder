//! OpenRouter's image API, the image provider's only address. Its connection test asks
//! OpenRouter whether it accepts the key (`GET /key`) and lists the model among its image models
//! (`GET /images/models`), without generating an image. A generation looks the model up in the
//! same listing, to learn whether it takes an aspect ratio and image input, and then asks for one
//! image (`POST /images`).
//!
//! The requests follow the chat test's rules: no proxy, no redirect followed, the platform's
//! certificate verifier, a timeout, and the key only in the `Authorization` header and replaced by
//! `[key]` in every text passed on. At most `REPLY_BOUND` bytes of a key or listing reply are read,
//! and `GENERATION_BOUND` of a generation's. The reply is untrusted: its first image is kept only
//! when its bytes are a structurally complete PNG, JPEG or WebP file of at most `IMAGE_BOUND`
//! bytes, and its media type is the one the bytes prove, never the one the reply claims. Every
//! function takes the base URL, so tests point it at a local server.

use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, RequestBuilder, StatusCode, redirect};
use serde::Serialize;
use serde_json::{Value, json};

use super::ProviderFailure;
use super::chat::{
    hide_key, innermost_reason, provider_message, read_bounded, redirect_host, send_failure,
    status_failure,
};

/// Where every image request goes.
pub const OPENROUTER: &str = "https://openrouter.ai/api/v1";
/// `OPENROUTER`'s host, as the key's status line names it.
pub const HOST: &str = "openrouter.ai";
/// How long a whole generation, its model listing included, may take.
pub const GENERATION_TIMEOUT: Duration = Duration::from_secs(300);
/// The most of a key or model listing reply that is read.
const REPLY_BOUND: usize = 4 * 1024 * 1024;
/// The most of a generation's reply that is read.
const GENERATION_BOUND: usize = 48 * 1024 * 1024;
/// The largest image a generation keeps.
const IMAGE_BOUND: usize = 32 * 1024 * 1024;

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

/// Why a request to the image provider failed, with the system's reason and the provider's
/// message, neither of which holds the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub reason: ImageFailure,
    pub detail: Option<String>,
    pub provider_message: Option<String>,
}

impl Failed {
    pub fn new(reason: ImageFailure, detail: Option<String>) -> Self {
        Self {
            reason,
            detail,
            provider_message: None,
        }
    }
}

impl From<Failed> for ImageTestOutcome {
    fn from(failed: Failed) -> Self {
        Self::Failed {
            reason: failed.reason,
            detail: failed.detail,
            provider_message: failed.provider_message,
        }
    }
}

/// An image a generation produced: its bytes, the media type they prove, and whether the earlier
/// image went along as a reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    pub bytes: Vec<u8>,
    pub media_type: &'static str,
    pub reference_sent: bool,
}

/// The earlier image a regeneration may send, as it is stored.
#[derive(Debug, Clone, Copy)]
pub struct Reference<'a> {
    pub media_type: &'a str,
    pub bytes: &'a [u8],
}

/// Asks the API at `base` whether it accepts `key`, then whether it lists `model` among its image
/// models.
pub async fn test(base: &str, model: &str, key: &str, timeout: Duration) -> ImageTestOutcome {
    match check(base, model, key, timeout).await {
        Ok(()) => ImageTestOutcome::Success,
        Err(failed) => failed.into(),
    }
}

async fn check(base: &str, model: &str, key: &str, timeout: Duration) -> Result<(), Failed> {
    let client = client(key)?;
    get(&client, &format!("{base}/key"), key, timeout).await?;
    let listing = get(&client, &format!("{base}/images/models"), key, timeout).await?;
    listed_model(&listing, model).map_err(|reason| Failed::new(reason, None))?;
    Ok(())
}

/// Generates one image of `prompt` with `model` through the API at `base`: with `aspect_ratio`
/// when the model's listing takes one, and with `reference` when it takes image input. Nothing
/// else is sent. The whole exchange gives up after `timeout`.
pub async fn generate(
    base: &str,
    model: &str,
    key: &str,
    prompt: &str,
    aspect_ratio: &str,
    reference: Option<Reference<'_>>,
    timeout: Duration,
) -> Result<Generated, Failed> {
    let deadline = Instant::now() + timeout;
    let client = client(key)?;
    let listing = get(
        &client,
        &format!("{base}/images/models"),
        key,
        remaining(deadline)?,
    )
    .await?;
    let entry = listed_model(&listing, model).map_err(|reason| Failed::new(reason, None))?;
    let mut body = json!({ "model": model, "prompt": prompt });
    if takes_parameter(&entry, "aspect_ratio") {
        body["aspect_ratio"] = json!(aspect_ratio);
    }
    let reference = reference.filter(|_| takes_image_input(&entry));
    if let Some(reference) = reference {
        let url = format!(
            "data:{};base64,{}",
            reference.media_type,
            STANDARD.encode(reference.bytes)
        );
        body["input_references"] = json!([{ "type": "image_url", "image_url": { "url": url } }]);
    }
    let request = client
        .post(format!("{base}/images"))
        .header(CONTENT_TYPE, "application/json")
        .body(body.to_string())
        .timeout(remaining(deadline)?);
    let reply = fetch(request, key, GENERATION_BOUND)
        .await?
        .ok_or_else(|| Failed::new(ImageFailure::NoImage, None))?;
    let (bytes, media_type) = first_image(&reply).map_err(|reason| Failed::new(reason, None))?;
    Ok(Generated {
        bytes,
        media_type,
        reference_sent: reference.is_some(),
    })
}

fn client(key: &str) -> Result<Client, Failed> {
    Client::builder()
        // A proxy from the environment or the system settings would carry the key to a host the
        // user never consented to.
        .no_proxy()
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|error| failed_send(&error, key))
}

/// The time left until `deadline`, or a timeout when none is.
fn remaining(deadline: Instant) -> Result<Duration, Failed> {
    let left = deadline.saturating_duration_since(Instant::now());
    match left.is_zero() {
        true => Err(Failed::new(ImageFailure::Timeout, None)),
        false => Ok(left),
    }
}

/// The body of a successful `GET url` with `key`, or how the request failed.
async fn get(client: &Client, url: &str, key: &str, timeout: Duration) -> Result<Vec<u8>, Failed> {
    fetch(client.get(url).timeout(timeout), key, REPLY_BOUND)
        .await?
        .ok_or_else(|| Failed::new(ImageFailure::InvalidReply, None))
}

/// The body of a successful answer to `request` sent with `key`, or `None` when it is larger than
/// `bound` bytes; or how the request failed.
async fn fetch(
    request: RequestBuilder,
    key: &str,
    bound: usize,
) -> Result<Option<Vec<u8>>, Failed> {
    let mut response = request
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| failed_send(&error, key))?;
    let status = response.status();
    if status.is_redirection() {
        let host = redirect_host(&response).map(|host| hide_key(&host, Some(key)));
        return Err(Failed::new(ImageFailure::Redirected, host));
    }
    let body = read_bounded(&mut response, bound)
        .await
        .map_err(|error| failed_read(&error, key))?;
    if status.is_success() {
        return Ok(body);
    }
    Err(Failed {
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

fn failed_send(error: &reqwest::Error, key: &str) -> Failed {
    let (reason, detail) = send_failure(error, Some(key));
    Failed::new(reason.into(), detail)
}

/// A read that failed after the provider began to answer: the timeout expired, or the connection
/// broke before the reply was complete.
fn failed_read(error: &reqwest::Error, key: &str) -> Failed {
    match error.is_timeout() {
        true => Failed::new(ImageFailure::Timeout, None),
        false => Failed::new(
            ImageFailure::Interrupted,
            Some(innermost_reason(error, Some(key))),
        ),
    }
}

/// The entry of the model listing `{ "data": [{ "id" }, …] }` that names `model`: `UnknownModel`
/// when none does, and `InvalidReply` when it is not such a listing.
fn listed_model(listing: &[u8], model: &str) -> Result<Value, ImageFailure> {
    let listing =
        serde_json::from_slice::<Value>(listing).map_err(|_| ImageFailure::InvalidReply)?;
    let models = listing["data"]
        .as_array()
        .ok_or(ImageFailure::InvalidReply)?;
    models
        .iter()
        .find(|entry| entry["id"].as_str() == Some(model))
        .cloned()
        .ok_or(ImageFailure::UnknownModel)
}

/// Whether a listed model's `supported_parameters` names `parameter`, as a map keyed by field
/// name or as a list of names.
fn takes_parameter(entry: &Value, parameter: &str) -> bool {
    match &entry["supported_parameters"] {
        Value::Object(parameters) => parameters.contains_key(parameter),
        Value::Array(names) => names.iter().any(|name| name.as_str() == Some(parameter)),
        _ => false,
    }
}

/// Whether a listed model's `architecture.input_modalities` holds `image`.
fn takes_image_input(entry: &Value) -> bool {
    entry["architecture"]["input_modalities"]
        .as_array()
        .is_some_and(|modalities| {
            modalities
                .iter()
                .any(|modality| modality.as_str() == Some("image"))
        })
}

/// The first image of a generation's reply, `{ "data": [{ "b64_json" }, …] }`, decoded, with the
/// media type its bytes prove; `NoImage` when it holds none that can be kept.
fn first_image(reply: &[u8]) -> Result<(Vec<u8>, &'static str), ImageFailure> {
    let reply = serde_json::from_slice::<Value>(reply).map_err(|_| ImageFailure::InvalidReply)?;
    let encoded = reply
        .pointer("/data/0/b64_json")
        .and_then(Value::as_str)
        .ok_or(ImageFailure::NoImage)?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ImageFailure::NoImage)?;
    if bytes.len() > IMAGE_BOUND {
        return Err(ImageFailure::NoImage);
    }
    let media_type = raster_type(&bytes).ok_or(ImageFailure::NoImage)?;
    Ok((bytes, media_type))
}

/// The media type that `bytes` prove by their structure, without decoding them: a PNG that ends
/// with its `IEND` chunk, a JPEG that ends with its end marker (after any NUL padding), or a WebP
/// whose RIFF size matches its length. Anything else, SVG and HTML included, has none.
fn raster_type(bytes: &[u8]) -> Option<&'static str> {
    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const PNG_END: &[u8] = b"\0\0\0\0IEND\xae\x42\x60\x82";
    const JPEG_START: &[u8] = &[0xFF, 0xD8, 0xFF];
    const JPEG_END: &[u8] = &[0xFF, 0xD9];
    if bytes.starts_with(PNG_SIGNATURE) {
        let complete =
            bytes.len() >= PNG_SIGNATURE.len() + PNG_END.len() && bytes.ends_with(PNG_END);
        return complete.then_some("image/png");
    }
    if bytes.starts_with(JPEG_START) {
        let end = bytes
            .iter()
            .rposition(|&byte| byte != 0)
            .map_or(0, |last| last + 1);
        let complete = end >= JPEG_START.len() + JPEG_END.len() && bytes[..end].ends_with(JPEG_END);
        return complete.then_some("image/jpeg");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        return (size + 8 == bytes.len()).then_some("image/webp");
    }
    None
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

    const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const PNG_END: &[u8] = b"\0\0\0\0IEND\xae\x42\x60\x82";

    /// A PNG's signature, `body` and its `IEND` chunk.
    fn png_of(body: &[u8]) -> Vec<u8> {
        [PNG_SIGNATURE, body, PNG_END].concat()
    }

    fn png() -> Vec<u8> {
        png_of(b"\0\0\0\rIHDR pixels")
    }

    /// A JPEG with NUL padding after its end marker, as some encoders write.
    fn jpeg() -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9, 0, 0]
    }

    /// A WebP whose RIFF size is `size`, or its true size.
    fn webp_sized(size: Option<u32>) -> Vec<u8> {
        let body = b"WEBPVP8 pixels";
        let size = size.unwrap_or(body.len() as u32);
        [b"RIFF".as_slice(), &size.to_le_bytes(), body].concat()
    }

    fn image_reply(bytes: &[u8], media_type: &str) -> Vec<u8> {
        let reply =
            json!({ "data": [{ "b64_json": STANDARD.encode(bytes), "media_type": media_type }] });
        json_answer("200 OK", &reply.to_string())
    }

    /// The model listing with another model and `entry`.
    fn image_listing(entry: Value) -> Vec<u8> {
        let listing = json!({ "data": [{ "id": "openai/gpt-image-1" }, entry] });
        json_answer("200 OK", &listing.to_string())
    }

    /// A listing entry for `MODEL` that takes an aspect ratio but no image input.
    fn plain_model() -> Value {
        json!({
            "id": MODEL,
            "architecture": { "input_modalities": ["text"] },
            "supported_parameters": { "aspect_ratio": {} },
        })
    }

    /// A server that answers the model listing with `listing` and a generation with `reply`, or
    /// never when it is `None`.
    fn generating(listing: Vec<u8>, reply: Option<Vec<u8>>) -> Server {
        Server::start(move |request| match request.path.as_str() {
            "/api/v1/images/models" => Some(listing.clone()),
            "/api/v1/images" => reply.clone(),
            _ => Some(json_answer("404 Not Found", "{}")),
        })
    }

    fn generate_with(
        server: &Server,
        reference: Option<Reference<'_>>,
        timeout: Duration,
    ) -> Result<Generated, Failed> {
        block_on(generate(
            &base(server),
            MODEL,
            KEY,
            "An ink drawing of a harbour",
            "3:4",
            reference,
            timeout,
        ))
    }

    fn generated_from(reply: Vec<u8>) -> Result<Generated, Failed> {
        let server = generating(image_listing(plain_model()), Some(reply));
        generate_with(&server, None, Duration::from_secs(10))
    }

    #[test]
    fn a_generation_sends_the_prompt_the_model_and_only_what_the_listing_takes() {
        let reference = png();
        let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&reference));
        let cases = [
            (
                json!({
                    "id": MODEL,
                    "architecture": { "input_modalities": ["text", "image"] },
                    "supported_parameters": { "aspect_ratio": { "type": "string" } },
                }),
                true,
                true,
            ),
            (
                json!({
                    "id": MODEL,
                    "architecture": { "input_modalities": ["text"] },
                    "supported_parameters": ["seed", "aspect_ratio"],
                }),
                true,
                false,
            ),
            (json!({ "id": MODEL }), false, false),
        ];
        for (entry, aspect_ratio, image_input) in cases {
            let server = generating(
                image_listing(entry.clone()),
                Some(image_reply(&png(), "image/png")),
            );
            let sent = Reference {
                media_type: "image/png",
                bytes: &reference,
            };

            let generated = generate_with(&server, Some(sent), Duration::from_secs(10)).unwrap();

            assert_eq!(generated.reference_sent, image_input, "{entry}");
            let requests = server.requests();
            let calls: Vec<(&str, &str)> = requests
                .iter()
                .map(|request| (request.method.as_str(), request.path.as_str()))
                .collect();
            assert_eq!(
                calls,
                [("GET", "/api/v1/images/models"), ("POST", "/api/v1/images")]
            );
            for request in &requests {
                assert_eq!(
                    request.header("authorization"),
                    Some(format!("Bearer {KEY}").as_str())
                );
            }
            let mut expected = json!({ "model": MODEL, "prompt": "An ink drawing of a harbour" });
            if aspect_ratio {
                expected["aspect_ratio"] = json!("3:4");
            }
            if image_input {
                expected["input_references"] =
                    json!([{ "type": "image_url", "image_url": { "url": data_url } }]);
            }
            let body: Value = serde_json::from_slice(&requests[1].body).unwrap();
            assert_eq!(body, expected, "{entry}");
        }
    }

    #[test]
    fn a_raster_image_is_kept_with_the_type_its_bytes_prove_whatever_the_reply_says() {
        let cases = [
            (png(), "image/jpeg", "image/png"),
            (jpeg(), "image/png", "image/jpeg"),
            (webp_sized(None), "image/svg+xml", "image/webp"),
        ];
        for (bytes, claimed, proven) in cases {
            let generated = generated_from(image_reply(&bytes, claimed)).unwrap();

            assert_eq!(
                generated,
                Generated {
                    bytes,
                    media_type: proven,
                    reference_sent: false,
                }
            );
        }
    }

    #[test]
    fn a_reply_without_an_image_that_can_be_kept_keeps_nothing() {
        let truncated_png = {
            let mut bytes = png();
            bytes.pop();
            bytes
        };
        let over_32_mib = png_of(&vec![0; IMAGE_BOUND]);
        let over_48_mib = format!(
            r#"{{"data":[{{"b64_json":"{}"}}]}}"#,
            "A".repeat(GENERATION_BOUND)
        );
        let cases = [
            (
                image_reply(
                    br#"<svg xmlns="http://www.w3.org/2000/svg"/>"#,
                    "image/svg+xml",
                ),
                ImageFailure::NoImage,
            ),
            (
                image_reply(b"<html><script>x</script></html>", "image/png"),
                ImageFailure::NoImage,
            ),
            (
                image_reply(&truncated_png, "image/png"),
                ImageFailure::NoImage,
            ),
            (
                image_reply(&webp_sized(Some(99)), "image/webp"),
                ImageFailure::NoImage,
            ),
            (
                image_reply(&jpeg()[..7], "image/jpeg"),
                ImageFailure::NoImage,
            ),
            (
                json_answer("200 OK", r#"{"data":[]}"#),
                ImageFailure::NoImage,
            ),
            (
                json_answer("200 OK", r#"{"data":[{"b64_json":"not base64!"}]}"#),
                ImageFailure::NoImage,
            ),
            (
                image_reply(&over_32_mib, "image/png"),
                ImageFailure::NoImage,
            ),
            (json_answer("200 OK", &over_48_mib), ImageFailure::NoImage),
            (
                answer(
                    "200 OK",
                    &[("Content-Type", "text/html")],
                    b"<html>Hi</html>",
                ),
                ImageFailure::InvalidReply,
            ),
        ];
        for (index, (reply, expected)) in cases.into_iter().enumerate() {
            let generated = generated_from(reply);

            assert_eq!(generated, Err(Failed::new(expected, None)), "case {index}");
        }
    }

    #[test]
    fn a_failed_generation_has_its_reason_and_the_provider_s_message() {
        let cases = [
            ("402 Payment Required", ImageFailure::NoCredit),
            ("429 Too Many Requests", ImageFailure::RateLimited),
            ("400 Bad Request", ImageFailure::Refused),
            ("502 Bad Gateway", ImageFailure::ProviderError),
        ];
        for (status, expected) in cases {
            let reply = json_answer(status, r#"{"error":{"message":"Not this time."}}"#);

            assert_eq!(
                generated_from(reply),
                Err(Failed {
                    reason: expected,
                    detail: None,
                    provider_message: Some("Not this time.".to_owned()),
                }),
                "{status}"
            );
        }
    }

    #[test]
    fn a_model_that_is_not_listed_is_unknown_and_nothing_is_generated() {
        let server = generating(
            image_listing(json!({ "id": "other/model" })),
            Some(image_reply(&png(), "image/png")),
        );

        let generated = generate_with(&server, None, Duration::from_secs(10));

        assert_eq!(
            generated,
            Err(Failed::new(ImageFailure::UnknownModel, None))
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn a_stalled_reply_times_out_and_one_cut_short_is_interrupted() {
        let stalled = generating(image_listing(plain_model()), None);

        let generated = generate_with(&stalled, None, Duration::from_millis(300));

        assert_eq!(generated, Err(Failed::new(ImageFailure::Timeout, None)));
        let cut_short =
            b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{\"data\""
                .to_vec();
        let generated = generated_from(cut_short);
        assert_eq!(
            generated.map_err(|failed| failed.reason),
            Err(ImageFailure::Interrupted)
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

    /// Generates one square image with the key and model in `GRIMOIRE_TEST_IMAGE_KEY` and
    /// `GRIMOIRE_TEST_IMAGE_MODEL`, then one regeneration with it as the reference, which goes
    /// along when the model's listing takes image input: two paid generations. Nothing it prints
    /// holds the key. Run by name only.
    #[test]
    #[ignore = "sends two paid generations to OpenRouter"]
    fn real_openrouter_generates_and_regenerates() {
        let (Ok(key), Ok(model)) = (
            env::var("GRIMOIRE_TEST_IMAGE_KEY"),
            env::var("GRIMOIRE_TEST_IMAGE_MODEL"),
        ) else {
            println!("Skipped: GRIMOIRE_TEST_IMAGE_KEY and GRIMOIRE_TEST_IMAGE_MODEL must be set.");
            return;
        };
        let run = |prompt: &str, reference: Option<Reference<'_>>| {
            block_on(generate(
                OPENROUTER,
                &model,
                &key,
                prompt,
                "1:1",
                reference,
                GENERATION_TIMEOUT,
            ))
        };

        let first = run("A small red lighthouse on a rock, flat vector style.", None).unwrap();
        println!(
            "Generated {} bytes of {}.",
            first.bytes.len(),
            first.media_type
        );
        let reference = Reference {
            media_type: first.media_type,
            bytes: &first.bytes,
        };
        let second = run(
            "The same small lighthouse on a rock, flat vector style, painted blue.",
            Some(reference),
        )
        .unwrap();

        println!(
            "Regenerated {} bytes of {}, with the reference {}.",
            second.bytes.len(),
            second.media_type,
            if second.reference_sent {
                "sent"
            } else {
                "not taken"
            }
        );
    }
}
