//! Images that answers request: generating them through the image provider, keeping them in the
//! conversation store, and serving their bytes to the webview through the image scheme. Nothing
//! here writes to the world.
//!
//! A generation starts for an image that is not generated: `send` starts the first four of an
//! answer once the answer is saved, and `assistant_image_generate` starts one. A start follows the
//! lock order: inside `SettingsState::start_request`, under the settings lock while the image
//! provider's generation is unchanged and AI is on; then under the world lock while the session is
//! open; then under the assistant lock, where the store marks the image generating and the request
//! is spawned and kept with its abort before any lock is released. The request holds no lock. Its
//! finish takes only the assistant lock and the store's lock, records the image as generated or not
//! unless its entry is gone or its session's store is no longer the current one, sends
//! `assistant:image-changed`, and only then drops the request's place in settings' registry, which
//! takes the settings lock.
//!
//! A generation stops on Cancel (`cancelled`), on saving the image provider, removing its key or
//! switching AI off, through settings' registry, and on `assistant_stop` with `generations`, which
//! the interface passes before the world changes or the window closes (each `interrupted`). It
//! stops too, recording nothing, when its conversation is deleted, when a retry deletes its answer,
//! and when the store of a newer session opens; its row is then gone, or left generating in the
//! older session's file, which makes it interrupted when it opens again. A failure's reason and the
//! provider's message are kept in memory for the opening only.

use std::borrow::Cow;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::str::FromStr;
use std::sync::Arc;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::http::{Response, Uri};

use super::proposals::RequestedImage;
use super::store::{
    self, ImageBytes, ImageFrame, ImageReference, NewImage, NotGenerated, SavedImage, Store,
};
use super::{AssistantState, Inner, Services, SharedStore, blocking, lock_store, store_of};
use crate::error::AppError;
use crate::history::Kind;
use crate::providers::images::{
    self as provider, Failed, GENERATION_TIMEOUT, Generated, ImageFailure, Reference,
};
use crate::settings::{self, Abort, PreparedImageRequest};
use crate::world::{self, ChangeId};

/// The most images generated for one answer; its further requests are not generated.
const PER_ANSWER: usize = 4;
/// The first segment of a stored image's path in the image scheme.
const STORED: &str = "stored";
/// The event sent whenever an image's state changes.
pub const IMAGE_CHANGED: &str = "assistant:image-changed";

/// Where an image stands, as review shows it. An approval or undo that is writing shows as the
/// state it started from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ImageState {
    NotGenerated,
    Generating,
    Pending,
    Approved,
    Rejected,
}

/// Why a generation failed, kept in memory for the opening.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct GenerationFailure {
    reason: ImageFailure,
    /// The system's or the secure connection's reason, the redirect's host, or why the key cannot
    /// be read.
    detail: Option<String>,
    /// The provider's message, at most 500 characters, with the key replaced by `[key]`.
    provider_message: Option<String>,
}

impl From<Failed> for GenerationFailure {
    fn from(failed: Failed) -> Self {
        Self {
            reason: failed.reason,
            detail: failed.detail,
            provider_message: failed.provider_message,
        }
    }
}

/// An image as review shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ImageReview {
    id: i64,
    name: String,
    frame: ImageFrame,
    /// Exactly the prompt sent, or to be sent.
    prompt: String,
    state: ImageState,
    /// Why it is not generated, while it is not.
    not_generated: Option<NotGenerated>,
    /// Why its generation failed, when it failed in this opening.
    failure: Option<GenerationFailure>,
    /// It was approved, and that approval was undone.
    undone: bool,
    /// The path its approval wrote, while it is approved.
    path: Option<String>,
    /// Its approval can be undone: history holds its change.
    undo: bool,
    /// The image it regenerates, while that image exists, and that image's name.
    revises: Option<i64>,
    revises_name: Option<String>,
    /// What its generation did with the image it regenerates.
    reference: Option<ImageReference>,
}

/// An answer's images and its notes about image requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct AnswerImages {
    answer: i64,
    /// How many image requests could not be read.
    unreadable: u32,
    /// The answer ended before an image request was complete.
    unfinished: bool,
    images: Vec<ImageReview>,
}

/// A user message that regenerates an image: its position, from 0, among the messages
/// `assistant_conversation` lists, and the image with its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Regeneration {
    message: u32,
    image: i64,
    name: String,
}

/// A conversation's answers that have images or notes about them, in order, and its
/// regeneration messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ConversationImages {
    answers: Vec<AnswerImages>,
    regenerations: Vec<Regeneration>,
}

/// What `assistant:image-changed` carries: an image of `conversation`, in the world opening
/// `session`, changed its state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImageChanged {
    pub session: u64,
    pub conversation: i64,
}

/// Where image changes are sent: the application's events, or a test's record.
pub type ImageSink = Arc<dyn Fn(ImageChanged) + Send + Sync>;

/// A running generation.
pub(super) struct Generation {
    id: u64,
    image: i64,
    session: u64,
    conversation: i64,
    /// Cancel asked for it, so it ends as cancelled whatever its request did.
    cancelled: bool,
    /// Aborts its request. It takes no lock.
    abort: Abort,
}

/// The running generations and this opening's failures, kept in the assistant's state.
#[derive(Default)]
pub(super) struct Generations {
    running: Vec<Generation>,
    next: u64,
    /// Why each image of the current store's session whose generation failed did.
    failures: HashMap<i64, GenerationFailure>,
}

impl Generations {
    /// Aborts and forgets the generations `which` selects, so their finishes record nothing.
    fn drop_where(&mut self, which: impl Fn(&Generation) -> bool) {
        let (dropped, kept) = std::mem::take(&mut self.running)
            .into_iter()
            .partition(|generation| which(generation));
        self.running = kept;
        for generation in dropped {
            (generation.abort)();
        }
    }

    /// Forgets the generations of an older session than `session`, aborting them, and the
    /// failures, which belong to the store being replaced.
    pub(super) fn replace_session(&mut self, session: u64) {
        self.drop_where(|generation| generation.session != session);
        self.failures.clear();
    }

    /// Forgets the generations of the deleted `conversation`, aborting them.
    pub(super) fn drop_conversation(&mut self, conversation: i64) {
        self.drop_where(|generation| generation.conversation == conversation);
    }

    /// Aborts every generation; each finish records it as interrupted.
    pub(super) fn abort_all(&self) {
        for generation in &self.running {
            (generation.abort)();
        }
    }

    /// Forgets the generations of `conversation` whose images `store` no longer holds, aborting
    /// them.
    pub(super) fn drop_gone(&mut self, conversation: i64, store: &Store) {
        let gone: Vec<u64> = self
            .running
            .iter()
            .filter(|generation| {
                generation.conversation == conversation && store.image(generation.image).is_err()
            })
            .map(|generation| generation.id)
            .collect();
        self.drop_where(|generation| gone.contains(&generation.id));
    }
}

impl AssistantState {
    /// Takes where image changes are sent, once, at launch.
    pub fn set_image_events(&self, sink: ImageSink) {
        let _ = self.image_events.set(sink);
    }

    /// Sends `changed`, with no lock of the assistant's held.
    fn image_changed(&self, changed: ImageChanged) {
        if let Some(sink) = self.image_events.get() {
            sink(changed);
        }
    }
}

/// An answer's image requests as it saves them, by how it ended: the first `PER_ANSWER` of an
/// answer that `generates` (one that is complete or cut off) interrupted until they start, or not
/// generated for lack of an image `provider`, and the rest over the limit; every request of any
/// other answer not generated for `otherwise`.
pub(super) fn new_images(
    requested: &[RequestedImage],
    generates: bool,
    provider: bool,
    otherwise: NotGenerated,
) -> Vec<NewImage> {
    requested
        .iter()
        .enumerate()
        .map(|(index, image)| NewImage {
            name: image.name.clone(),
            frame: image.frame,
            prompt: image.prompt.clone(),
            revises: None,
            reason: match (generates, index < PER_ANSWER, provider) {
                (false, _, _) => otherwise,
                (true, false, _) => NotGenerated::OverLimit,
                (true, true, true) => NotGenerated::Interrupted,
                (true, true, false) => NotGenerated::NoProvider,
            },
        })
        .collect()
}

/// The images to start of those an answer saved, in order.
pub(super) fn to_start(saved: Vec<i64>, generates: bool, provider: bool) -> Vec<i64> {
    match generates && provider {
        true => saved.into_iter().take(PER_ANSWER).collect(),
        false => Vec::new(),
    }
}

/// The store of the opening `session`, when it is the current one.
fn current_store(inner: &Inner, session: u64) -> Option<SharedStore> {
    inner
        .store
        .as_ref()
        .filter(|(current, _)| *current == session)
        .map(|(_, store)| Arc::clone(store))
}

/// Refuses while AI is off; otherwise the open world's session and its store.
fn open_store<S: Services>(services: &S) -> Result<(u64, SharedStore), AppError> {
    if !services.settings().ai_on() {
        return Err(settings::ai_off());
    }
    let world = services.world().current()?;
    let store = store_of(&mut services.assistant().lock(), &world)?;
    Ok((world.session, store))
}

/// Starts each of `images`, saved in the opening `session`, with the image provider `prepared`
/// for. Their key is read once, with no lock held; when it cannot be read, each fails.
pub(super) fn start_all<S: Services>(
    services: &S,
    session: u64,
    prepared: &PreparedImageRequest,
    images: &[i64],
) {
    match services.settings().read_key(prepared) {
        // `prepare_image_request` lets only a provider with a stored key through, and a stored
        // key always reads as one.
        Ok(key) => {
            let key = key.unwrap_or_default();
            for &image in images {
                let _ = start(services, session, prepared, &key, image);
            }
        }
        Err(error) => {
            for &image in images {
                let _ = fail_unstarted(
                    services,
                    session,
                    image,
                    key_unreadable(error.message.clone()),
                );
            }
        }
    }
}

fn key_unreadable(detail: String) -> GenerationFailure {
    GenerationFailure {
        reason: ImageFailure::KeyUnreadable,
        detail: Some(detail),
        provider_message: None,
    }
}

/// What a generation sends, read under the store's lock as it starts.
struct Job {
    prompt: String,
    frame: ImageFrame,
    /// For a regeneration, the image it revises, or `None` inside when that has no bytes now.
    revised: Option<Option<ImageBytes>>,
}

/// Starts generating `image`, which must not be generated, in the opening `session`'s store,
/// following the lock order. Nothing starts when the request was superseded or the session
/// ended meanwhile.
fn start<S: Services>(
    services: &S,
    session: u64,
    prepared: &PreparedImageRequest,
    key: &str,
    image: i64,
) -> Result<(), AppError> {
    let assistant = services.assistant();
    let mut refusal = None;
    let mut launched = None;
    let started = services.settings().start_request(prepared, || {
        services
            .world()
            .while_open(session, |_| {
                let mut inner = assistant.lock();
                let store = current_store(&inner, session)?;
                let (conversation, job) = match begin(&mut lock_store(&store), image) {
                    Ok(begun) => begun,
                    Err(error) => {
                        refusal = Some(error);
                        return None;
                    }
                };
                let reference = match &job.revised {
                    None => None,
                    Some(None) => Some(ImageReference::Gone),
                    Some(Some(_)) => Some(ImageReference::NotTaken),
                };
                let generations = &mut inner.generations;
                generations.failures.remove(&image);
                let id = generations.next;
                generations.next += 1;
                let task =
                    tauri::async_runtime::spawn(request(prepared.clone(), key.to_owned(), job));
                let abort = task.inner().abort_handle();
                let own = abort.clone();
                generations.running.push(Generation {
                    id,
                    image,
                    session,
                    conversation,
                    cancelled: false,
                    abort: Box::new(move || own.abort()),
                });
                launched = Some((id, task, conversation, reference));
                Some(Box::new(move || abort.abort()) as Abort)
            })
            .flatten()
    });
    if let Some(error) = refusal {
        return Err(error);
    }
    let (Ok(Some(guard)), Some((id, task, conversation, reference))) = (started, launched) else {
        return Ok(());
    };
    assistant.image_changed(ImageChanged {
        session,
        conversation,
    });
    let services = services.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = task.await;
        let _ = blocking(&services, move |services| {
            if let Some(changed) = finish(services.assistant(), id, outcome, reference) {
                services.assistant().image_changed(changed);
            }
            // Its place in settings' registry goes last, with no other lock held.
            drop(guard);
            Ok(())
        })
        .await;
    });
    Ok(())
}

/// Marks `image` generating, and returns its conversation and what its generation sends.
fn begin(store: &mut Store, image: i64) -> Result<(i64, Job), AppError> {
    let stored = store.image(image)?;
    store.start_generating(image)?;
    let SavedImage {
        prompt,
        frame,
        revises,
        ..
    } = stored.image;
    let revised =
        revises.map(|earlier| store.image(earlier).ok().and_then(|earlier| earlier.bytes));
    Ok((
        stored.conversation,
        Job {
            prompt,
            frame,
            revised,
        },
    ))
}

/// A generation's request, which holds no lock.
async fn request(
    prepared: PreparedImageRequest,
    key: String,
    job: Job,
) -> Result<Generated, Failed> {
    let reference = job
        .revised
        .as_ref()
        .and_then(Option::as_ref)
        .map(|earlier| Reference {
            media_type: &earlier.media_type,
            bytes: &earlier.bytes,
        });
    provider::generate(
        prepared.base(),
        prepared.model(),
        &key,
        &job.prompt,
        aspect_ratio(job.frame),
        reference,
        GENERATION_TIMEOUT,
    )
    .await
}

fn aspect_ratio(frame: ImageFrame) -> &'static str {
    match frame {
        ImageFrame::Square => "1:1",
        ImageFrame::Portrait => "3:4",
        ImageFrame::Landscape => "4:3",
    }
}

/// Records how the generation `id` ended, under the assistant lock and the store's lock only,
/// unless its entry is gone or its session's store is no longer current. `reference` is what it
/// did with the image it revises, if it sent none.
fn finish(
    assistant: &AssistantState,
    id: u64,
    outcome: tauri::Result<Result<Generated, Failed>>,
    reference: Option<ImageReference>,
) -> Option<ImageChanged> {
    let mut inner = assistant.lock();
    let generations = &mut inner.generations;
    let at = generations
        .running
        .iter()
        .position(|running| running.id == id)?;
    let generation = generations.running.remove(at);
    let store = current_store(&inner, generation.session)?;
    let mut store = lock_store(&store);
    let image = generation.image;
    // A write the file refuses is made in memory; one that fails there too leaves the image
    // generating until the store opens again.
    let _ = match (generation.cancelled, outcome) {
        (true, _) => store.not_generated(image, NotGenerated::Cancelled),
        (false, Ok(Ok(generated))) => {
            let reference = match (reference, generated.reference_sent) {
                (Some(ImageReference::NotTaken), true) => Some(ImageReference::Sent),
                (reference, _) => reference,
            };
            store.generated(image, generated.media_type, &generated.bytes, reference)
        }
        (false, Ok(Err(failed))) => {
            inner.generations.failures.insert(image, failed.into());
            store.not_generated(image, NotGenerated::Failed)
        }
        // Aborted through settings' registry or `assistant_stop`, or a panic.
        (false, Err(_)) => store.not_generated(image, NotGenerated::Interrupted),
    };
    Some(ImageChanged {
        session: generation.session,
        conversation: generation.conversation,
    })
}

/// Marks `image`, which must not be generated, as failed for `failure` without sending anything.
fn fail_unstarted<S: Services>(
    services: &S,
    session: u64,
    image: i64,
    failure: GenerationFailure,
) -> Result<(), AppError> {
    let assistant = services.assistant();
    let changed = services
        .world()
        .while_open(session, |_| -> Result<Option<ImageChanged>, AppError> {
            let mut inner = assistant.lock();
            let Some(store) = current_store(&inner, session) else {
                return Ok(None);
            };
            let mut store = lock_store(&store);
            let conversation = store.image(image)?.conversation;
            store.start_generating(image)?;
            store.not_generated(image, NotGenerated::Failed)?;
            inner.generations.failures.insert(image, failure);
            Ok(Some(ImageChanged {
                session,
                conversation,
            }))
        })
        .unwrap_or(Ok(None))?;
    if let Some(changed) = changed {
        assistant.image_changed(changed);
    }
    Ok(())
}

/// Starts generating `image` of the open world's store, which must not be generated, with the
/// saved image provider.
fn generate_image<S: Services>(services: &S, image: i64) -> Result<(), AppError> {
    let (session, _) = open_store(services)?;
    let prepared = services.settings().prepare_image_request()?;
    match services.settings().read_key(&prepared) {
        // A stored key always reads as one; see `start_all`.
        Ok(key) => start(
            services,
            session,
            &prepared,
            &key.unwrap_or_default(),
            image,
        ),
        Err(error) => fail_unstarted(services, session, image, key_unreadable(error.message)),
    }
}

/// Stops generating `image` of the open world's store, if it is being generated; it ends as
/// cancelled.
fn cancel_image<S: Services>(services: &S, image: i64) -> Result<(), AppError> {
    let (session, _) = open_store(services)?;
    let mut inner = services.assistant().lock();
    if let Some(generation) = inner
        .generations
        .running
        .iter_mut()
        .find(|generation| generation.image == image && generation.session == session)
    {
        generation.cancelled = true;
        (generation.abort)();
    }
    Ok(())
}

/// Rejects the pending `image` for good and deletes its bytes.
fn reject_image<S: Services>(services: &S, image: i64) -> Result<(), AppError> {
    let (session, store) = open_store(services)?;
    let conversation = {
        let mut store = lock_store(&store);
        let conversation = store.image(image)?.conversation;
        store.reject_image(image)?;
        conversation
    };
    services.assistant().image_changed(ImageChanged {
        session,
        conversation,
    });
    Ok(())
}

/// `conversation`'s images as review shows them. Whether an approval can be undone is read from
/// the world's history with no assistant or store lock held.
fn review_images<S: Services>(
    services: &S,
    conversation: i64,
) -> Result<ConversationImages, AppError> {
    let (session, store) = open_store(services)?;
    let saved = lock_store(&store).images(conversation)?;
    let failures = services.assistant().lock().generations.failures.clone();
    let names: HashMap<i64, String> = saved
        .answers
        .iter()
        .flat_map(|answer| &answer.images)
        .map(|image| (image.id, image.name.clone()))
        .collect();
    let world = services.world();
    let answers = saved
        .answers
        .into_iter()
        .map(|answer| {
            let images = answer
                .images
                .into_iter()
                .map(|image| review_image(world, session, image, &failures, &names))
                .collect::<Result<_, AppError>>()?;
            Ok(AnswerImages {
                answer: answer.answer,
                unreadable: answer.unreadable,
                unfinished: answer.unfinished,
                images,
            })
        })
        .collect::<Result<_, AppError>>()?;
    Ok(ConversationImages {
        answers,
        regenerations: saved
            .regenerations
            .into_iter()
            .map(|regeneration| Regeneration {
                message: regeneration.message,
                image: regeneration.image,
                name: regeneration.name,
            })
            .collect(),
    })
}

fn review_image(
    world: &world::WorldState,
    session: u64,
    image: SavedImage,
    failures: &HashMap<i64, GenerationFailure>,
    names: &HashMap<i64, String>,
) -> Result<ImageReview, AppError> {
    let state = match image.state {
        store::ImageState::NotGenerated => ImageState::NotGenerated,
        store::ImageState::Generating => ImageState::Generating,
        store::ImageState::Pending | store::ImageState::Approving => ImageState::Pending,
        store::ImageState::Approved | store::ImageState::Undoing => ImageState::Approved,
        store::ImageState::Rejected => ImageState::Rejected,
    };
    let undo = match (state, image.change) {
        (ImageState::Approved, Some(change)) => world.holds_change(
            session,
            ChangeId {
                id: change.id,
                started: change.started,
            },
            Kind::ApprovedImage,
        )?,
        _ => false,
    };
    let not_generated = image.reason.filter(|_| state == ImageState::NotGenerated);
    Ok(ImageReview {
        failure: not_generated
            .filter(|reason| *reason == NotGenerated::Failed)
            .and_then(|_| failures.get(&image.id).cloned()),
        not_generated,
        path: image.path.filter(|_| state == ImageState::Approved),
        revises_name: image
            .revises
            .and_then(|revised| names.get(&revised).cloned()),
        id: image.id,
        name: image.name,
        frame: image.frame,
        prompt: image.prompt,
        state,
        undone: image.undone,
        undo,
        revises: image.revises,
        reference: image.reference,
    })
}

/// `conversation`'s images, with each answer's notes, and its regeneration messages.
pub(crate) async fn images<S: Services>(
    services: S,
    conversation: i64,
) -> Result<ConversationImages, AppError> {
    blocking(&services, move |services| {
        review_images(services, conversation)
    })
    .await
}

/// Starts generating an image that is not generated, and returns once it has started.
pub(crate) async fn generate<S: Services>(services: S, image: i64) -> Result<(), AppError> {
    blocking(&services, move |services| generate_image(services, image)).await
}

/// Stops generating an image, if it is being generated.
pub(crate) async fn cancel<S: Services>(services: S, image: i64) -> Result<(), AppError> {
    blocking(&services, move |services| cancel_image(services, image)).await
}

/// Rejects a pending image for good.
pub(crate) async fn reject<S: Services>(services: S, image: i64) -> Result<(), AppError> {
    blocking(&services, move |services| reject_image(services, image)).await
}

/// The image scheme's path of `uri`, decoded exactly once, as the world's handler decodes it.
fn decoded_path(uri: &Uri) -> Option<Cow<'_, str>> {
    percent_decode_str(uri.path().strip_prefix('/')?)
        .decode_utf8()
        .ok()
}

/// Whether a request of the image scheme asks for a stored image: its path, decoded once, starts
/// with the segment `stored`, which no world handler path can.
pub fn is_stored_image(uri: &Uri) -> bool {
    decoded_path(uri).is_some_and(|path| path.split('/').next() == Some(STORED))
}

/// Answers a request of the image scheme for a stored image, `stored/<session>/<image>` as the
/// interface's `convertFileSrc` encodes it, with the image's bytes and stored type, when that
/// session is the open world's and the current store holds bytes for the image. Every refusal is
/// the world handler's empty 404, and so is a panic.
pub fn respond_image<S: Services>(services: &S, uri: &Uri) -> Response<Vec<u8>> {
    catch_unwind(AssertUnwindSafe(|| match stored_bytes(services, uri) {
        Some((bytes, content_type)) => world::image_response(bytes, content_type),
        None => world::refused_image(),
    }))
    .unwrap_or_else(|_| world::refused_image())
}

/// The bytes and type of the stored image `uri` names. The session is checked under the world
/// lock alone; the bytes are copied under the assistant lock and the store's lock.
fn stored_bytes<S: Services>(services: &S, uri: &Uri) -> Option<(Vec<u8>, &'static str)> {
    let path = decoded_path(uri)?;
    let mut segments = path.split('/');
    let (Some(STORED), Some(session), Some(image), None) = (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) else {
        return None;
    };
    let (session, image) = (decimal::<u64>(session)?, decimal::<i64>(image)?);
    services.world().while_open(session, |_| ())?;
    let store = current_store(&services.assistant().lock(), session)?;
    let bytes = lock_store(&store).image(image).ok()?.bytes?;
    // Only a type the generation proved is ever stored; anything else is refused all the same.
    let content_type = match bytes.media_type.as_str() {
        "image/png" => "image/png",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        _ => return None,
    };
    Some((bytes.bytes, content_type))
}

/// `text` as a number, when it is only decimal digits.
fn decimal<T: FromStr>(text: &str) -> Option<T> {
    let digits = !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    digits.then(|| text.parse().ok()).flatten()
}
