//! The `settings` area: the application's settings, the AI switch, the saved text provider and
//! the saved image provider, and the commands that read and change them. The providers' keys go
//! through `secrets`, each in its own slot; the text provider's base URL's rules come from
//! `providers`, and the image provider always goes to `providers::images::OPENROUTER`.
//!
//! The commands run one at a time under the settings lock, held for the whole operation, keychain
//! calls included. Each runs on Tauri's blocking pool, because a keychain may wait for the user to
//! answer an unlock prompt.
//!
//! Settings also authorize every request to a provider: the connection tests' and the assistant's
//! answer. Each request has a kind, text or image, and each kind its own generation. A request
//! takes a snapshot of its provider with its kind's generation (`prepare_request`), reads the key
//! without the lock (`read_key`), and starts only inside `start_request`, under the lock, while
//! that generation is unchanged and AI is on; its abort is stored there with its kind before the
//! lock is released. Saving a provider and removing its key move that kind's generation and call
//! that kind's stored aborts, and switching AI off does so for both kinds, so no request leaves
//! after them and none keeps running. Each kind has one connection test, and its cancel command
//! abandons only that test, through the test's own mark.

mod store;

use std::future::Future;
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorKind, guard};
use crate::providers::images::{self, ImageFailure, ImageTestOutcome};
use crate::providers::{self, BaseUrl, ProviderFailure, TestOutcome};
use crate::secrets::{KeySlot, KeyStorage, Secrets, SecretsError};
use store::{Saved, SavedImageProvider, SavedProvider};

/// The settings as the interface sees them. It never holds a key.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Whether AI features are on.
    ai: bool,
    /// The saved text provider, if any.
    text_provider: Option<TextProvider>,
    /// The saved image provider, if any.
    image_provider: Option<ImageProvider>,
}

/// The saved text provider.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct TextProvider {
    /// The normalised base URL, without a trailing `/`.
    base_url: String,
    model: String,
    /// Where the key is stored.
    key: KeyStorage,
    /// The base URL's host, with the port when the URL names one.
    host: String,
}

/// The saved image provider. Its requests always go to OpenRouter.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct ImageProvider {
    model: String,
    /// Where the key is stored.
    key: KeyStorage,
    /// The host the key is sent to, `openrouter.ai`.
    host: String,
}

/// The provider field that broke a rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ProviderField {
    BaseUrl,
    Model,
    Key,
}

/// What saving the provider did.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ProviderSaved {
    /// The provider, and the typed key if there was one, are saved.
    Saved { settings: Settings },
    /// `field` broke the rule in `message`, so nothing was stored.
    Invalid {
        field: ProviderField,
        message: String,
    },
    /// No keychain can be reached for the typed key, so nothing was stored. Saving again with
    /// `keyFile` stores the key in the key file.
    NoKeychain,
}

/// Which provider a request goes to. Each kind's requests and connection test are abandoned apart
/// from the other kind's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Text,
    Image,
}

impl ProviderKind {
    fn slot(self) -> KeySlot {
        match self {
            Self::Text => KeySlot::Text,
            Self::Image => KeySlot::Image,
        }
    }
}

/// The settings, managed by Tauri and loaded at launch.
pub struct SettingsState {
    /// Shared with each `RequestGuard`, which removes its request's abort when dropped.
    inner: Arc<Mutex<Inner>>,
    /// Beside the settings lock, so that reading a key never needs it.
    secrets: Arc<Secrets>,
    /// Where image requests go in tests: a local server instead of OpenRouter.
    #[cfg(test)]
    pub(crate) image_base: String,
}

struct Inner {
    saved: Saved,
    /// `grimoire-data/settings.json`; `None` without an app data folder, and then nothing saves.
    file: Option<PathBuf>,
    text: KindState,
    image: KindState,
    /// Each running provider request.
    requests: Vec<Running>,
    next_request: u64,
}

/// One kind's requests.
#[derive(Default)]
struct KindState {
    /// Moves on when AI is switched off, or when this kind's provider is saved or its key removed.
    /// A request prepared before it moved never starts.
    generation: u64,
    test: TestRun,
}

/// A running provider request.
struct Running {
    id: u64,
    kind: ProviderKind,
    abort: Abort,
}

/// Aborts a running provider request. It takes no lock.
pub type Abort = Box<dyn Fn() + Send>;

/// A kind's connection test, which runs one at a time.
#[derive(Default)]
struct TestRun {
    /// Moves on whenever a running test must be abandoned, so its result is discarded.
    generation: u64,
    running: bool,
    /// The running test's request id in `Inner::requests`.
    request: Option<u64>,
}

/// A request that passed its first step: its kind, the kind's generation it was prepared in,
/// where its key is stored, and a copy of what it goes to.
#[derive(Clone)]
pub struct Prepared<P> {
    kind: ProviderKind,
    generation: u64,
    key: KeyStorage,
    provider: P,
}

/// A request to the text provider.
pub type PreparedRequest = Prepared<SavedProvider>;

impl PreparedRequest {
    pub fn base_url(&self) -> &BaseUrl {
        &self.provider.base_url
    }

    pub fn model(&self) -> &str {
        &self.provider.model
    }
}

/// Where an image provider's request goes, and with which model.
#[derive(Clone)]
pub struct ImageTarget {
    base: String,
    model: String,
}

/// A request to the image provider.
pub type PreparedImageRequest = Prepared<ImageTarget>;

impl PreparedImageRequest {
    /// `providers::images::OPENROUTER`, or a local server in tests.
    pub fn base(&self) -> &str {
        &self.provider.base
    }

    pub fn model(&self) -> &str {
        &self.provider.model
    }
}

/// The request was not started: AI was switched off, or its provider saved again or its key
/// removed, since it was prepared.
#[derive(Debug, PartialEq, Eq)]
pub struct Superseded;

/// A started request's place in the registry; dropping it removes the request's abort. It takes
/// the settings lock, so it is dropped on the blocking pool.
pub struct RequestGuard {
    inner: Arc<Mutex<Inner>>,
    id: u64,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        lock(&self.inner)
            .requests
            .retain(|running| running.id != self.id);
    }
}

/// A test that passed its first step, with a copy of what it tests.
struct PendingTest<P> {
    generation: u64,
    request: Prepared<P>,
}

/// How a test of either provider ends without its request's own result.
trait TestResult: Send + 'static {
    /// The test was abandoned.
    fn cancelled() -> Self;
    /// The key cannot be read, for the reason given, so nothing was sent.
    fn key_unreadable(detail: String) -> Self;
}

impl TestResult for TestOutcome {
    fn cancelled() -> Self {
        Self::Cancelled
    }

    fn key_unreadable(detail: String) -> Self {
        Self::failed(ProviderFailure::KeyUnreadable, Some(detail))
    }
}

impl TestResult for ImageTestOutcome {
    fn cancelled() -> Self {
        Self::Cancelled
    }

    fn key_unreadable(detail: String) -> Self {
        Self::failed(ImageFailure::KeyUnreadable, Some(detail))
    }
}

impl SettingsState {
    /// The settings kept in `app_data_dir`, with keys in the platform's keychain.
    pub fn load(app_data_dir: Option<&Path>) -> Self {
        let folder = app_data_dir.map(|dir| dir.join("grimoire-data"));
        Self::with_secrets(folder.as_deref(), Secrets::new(folder.as_deref()))
    }

    pub(crate) fn with_secrets(data_folder: Option<&Path>, secrets: Secrets) -> Self {
        let file = data_folder.map(|folder| folder.join("settings.json"));
        let saved = file.as_deref().map(store::load).unwrap_or_default();
        Self {
            inner: Arc::new(Mutex::new(Inner {
                saved,
                file,
                text: KindState::default(),
                image: KindState::default(),
                requests: Vec::new(),
                next_request: 0,
            })),
            secrets: Arc::new(secrets),
            #[cfg(test)]
            image_base: images::OPENROUTER.to_owned(),
        }
    }

    fn get(&self) -> Settings {
        to_settings(&self.lock().saved)
    }

    /// Whether AI features are on.
    pub fn ai_on(&self) -> bool {
        self.lock().saved.ai
    }

    pub(crate) fn set_ai(&self, on: bool) -> Result<Settings, AppError> {
        let mut inner = self.lock();
        if !on {
            inner.supersede_requests(ProviderKind::Text);
            inner.supersede_requests(ProviderKind::Image);
        }
        let next = Saved {
            ai: on,
            ..inner.saved.clone()
        };
        inner.save(next)
    }

    /// Checks the fields, stores a typed key, or removes the stored key when the origin changes
    /// without one, and only then writes the settings file.
    pub(crate) fn save_provider(
        &self,
        base_url: &str,
        model: &str,
        key: Option<&str>,
        key_file: bool,
    ) -> Result<ProviderSaved, AppError> {
        let mut inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        // A request belongs to the provider it was prepared for.
        inner.supersede_requests(ProviderKind::Text);
        let base_url = match BaseUrl::parse(base_url) {
            Ok(url) => url,
            Err(message) => return Ok(invalid(ProviderField::BaseUrl, message)),
        };
        let model = model.trim();
        if model.is_empty() {
            return Ok(invalid(ProviderField::Model, "Enter the model's ID."));
        }
        let key = match typed_key(key) {
            Ok(key) => key,
            Err(message) => return Ok(invalid(ProviderField::Key, message)),
        };

        let previous = inner.saved.provider.as_ref();
        let storage = match (key, previous) {
            (Some(key), _) => match self.secrets.store(KeySlot::Text, key, key_file) {
                Ok(storage) => storage,
                Err(SecretsError::NoKeychain) => return Ok(ProviderSaved::NoKeychain),
                Err(error) => return Err(secrets_error(error)),
            },
            (None, Some(previous)) if previous.base_url.origin() != base_url.origin() => {
                // The key belongs to the saved origin; it is deleted before the new origin is.
                self.secrets
                    .remove(KeySlot::Text, previous.key)
                    .map_err(secrets_error)?;
                KeyStorage::None
            }
            (None, Some(previous)) => previous.key,
            (None, None) => KeyStorage::None,
        };
        let next = Saved {
            ai: true,
            provider: Some(SavedProvider {
                base_url,
                model: model.to_owned(),
                key: storage,
            }),
            ..inner.saved.clone()
        };
        let settings = inner.save(next)?;
        Ok(ProviderSaved::Saved { settings })
    }

    /// Deletes the stored key, then records that none is stored.
    pub(crate) fn remove_key(&self) -> Result<Settings, AppError> {
        let mut inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        inner.supersede_requests(ProviderKind::Text);
        let Some(provider) = inner.saved.provider.clone() else {
            return Ok(to_settings(&inner.saved));
        };
        self.secrets
            .remove(KeySlot::Text, provider.key)
            .map_err(secrets_error)?;
        let next = Saved {
            provider: Some(SavedProvider {
                key: KeyStorage::None,
                ..provider
            }),
            ..inner.saved.clone()
        };
        inner.save(next)
    }

    /// Checks the fields, stores a typed key in the image provider's slot, and only then writes
    /// the settings file. A key is required unless one is stored.
    pub(crate) fn save_image_provider(
        &self,
        model: &str,
        key: Option<&str>,
        key_file: bool,
    ) -> Result<ProviderSaved, AppError> {
        let mut inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        inner.supersede_requests(ProviderKind::Image);
        let model = model.trim();
        if model.is_empty() {
            return Ok(invalid(ProviderField::Model, "Enter the model's ID."));
        }
        let key = match typed_key(key) {
            Ok(key) => key,
            Err(message) => return Ok(invalid(ProviderField::Key, message)),
        };

        let stored = inner
            .saved
            .image
            .as_ref()
            .map_or(KeyStorage::None, |image| image.key);
        let storage = match key {
            Some(key) => match self.secrets.store(KeySlot::Image, key, key_file) {
                Ok(storage) => storage,
                Err(SecretsError::NoKeychain) => return Ok(ProviderSaved::NoKeychain),
                Err(error) => return Err(secrets_error(error)),
            },
            None if stored != KeyStorage::None => stored,
            None => return Ok(invalid(ProviderField::Key, "Enter the API key.")),
        };
        let next = Saved {
            image: Some(SavedImageProvider {
                model: model.to_owned(),
                key: storage,
            }),
            ..inner.saved.clone()
        };
        let settings = inner.save(next)?;
        Ok(ProviderSaved::Saved { settings })
    }

    /// Deletes the image provider's stored key, then records that none is stored. The model stays.
    pub(crate) fn remove_image_key(&self) -> Result<Settings, AppError> {
        let mut inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        inner.supersede_requests(ProviderKind::Image);
        let Some(image) = inner.saved.image.clone() else {
            return Ok(to_settings(&inner.saved));
        };
        self.secrets
            .remove(KeySlot::Image, image.key)
            .map_err(secrets_error)?;
        let next = Saved {
            image: Some(SavedImageProvider {
                key: KeyStorage::None,
                ..image
            }),
            ..inner.saved.clone()
        };
        inner.save(next)
    }

    /// A text request's first step, under the lock: AI is on and a provider is saved. It holds
    /// the text generation and a copy of the provider.
    pub fn prepare_request(&self) -> Result<PreparedRequest, AppError> {
        let inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        let provider = inner
            .saved
            .provider
            .clone()
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "No provider is saved."))?;
        Ok(Prepared {
            kind: ProviderKind::Text,
            generation: inner.text.generation,
            key: provider.key,
            provider,
        })
    }

    /// An image request's or the image test's first step, under the lock: AI is on, and an image
    /// provider is saved with a stored key. It holds the image generation and a copy of the
    /// provider.
    pub fn prepare_image_request(&self) -> Result<PreparedImageRequest, AppError> {
        let inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        let image = inner
            .saved
            .image
            .as_ref()
            .filter(|image| image.key != KeyStorage::None)
            .ok_or_else(|| AppError::new(ErrorKind::NotFound, "No image provider is saved."))?;
        Ok(Prepared {
            kind: ProviderKind::Image,
            generation: inner.image.generation,
            key: image.key,
            provider: ImageTarget {
                base: self.image_base().to_owned(),
                model: image.model.clone(),
            },
        })
    }

    #[cfg(not(test))]
    fn image_base(&self) -> &str {
        images::OPENROUTER
    }

    #[cfg(test)]
    fn image_base(&self) -> &str {
        &self.image_base
    }

    /// The second step, without the lock, because a keychain may wait for an unlock prompt.
    pub fn read_key<P>(&self, request: &Prepared<P>) -> Result<Option<String>, AppError> {
        self.secrets
            .read(request.kind.slot(), request.key)
            .map_err(secrets_error)
    }

    /// The third step: under the lock, unless the request's kind's generation moved or AI is off
    /// since `request` was prepared, calls `start`, which starts the request and returns its
    /// abort, and stores that abort with its kind before anything else can take the lock. `start`
    /// may take the world and assistant locks; it returns `None` when it started nothing.
    pub fn start_request<P>(
        &self,
        request: &Prepared<P>,
        start: impl FnOnce() -> Option<Abort>,
    ) -> Result<Option<RequestGuard>, Superseded> {
        let id = self.start_request_with(request, |_, _| start())?;
        Ok(id.map(|id| RequestGuard {
            inner: Arc::clone(&self.inner),
            id,
        }))
    }

    /// `start_request` with the state under the lock, and the stored request's id.
    fn start_request_with<P>(
        &self,
        request: &Prepared<P>,
        start: impl FnOnce(&mut Inner, u64) -> Option<Abort>,
    ) -> Result<Option<u64>, Superseded> {
        let mut inner = self.lock();
        if inner.kind(request.kind).generation != request.generation || !inner.saved.ai {
            return Err(Superseded);
        }
        let id = inner.next_request;
        inner.next_request += 1;
        let Some(abort) = start(&mut inner, id) else {
            return Ok(None);
        };
        inner.requests.push(Running {
            id,
            kind: request.kind,
            abort,
        });
        Ok(Some(id))
    }

    /// The test's first step, under the lock, after `request`'s: no test of its kind runs. Marks
    /// the test as running; `end_test` clears the mark.
    fn begin_test<P>(&self, request: Prepared<P>) -> Result<PendingTest<P>, AppError> {
        let mut inner = self.lock();
        let test = &mut inner.kind_mut(request.kind).test;
        if test.running {
            return Err(AppError::new(
                ErrorKind::Conflict,
                "A connection test is already running.",
            ));
        }
        test.running = true;
        Ok(PendingTest {
            generation: test.generation,
            request,
        })
    }

    /// The test's second step, `read_key`.
    fn read_test_key<P, O: TestResult>(&self, test: &PendingTest<P>) -> Result<Option<String>, O> {
        self.read_key(&test.request)
            .map_err(|error| O::key_unreadable(error.message))
    }

    /// The third step, `start_request`: unless the test was abandoned meanwhile, starts `run` with
    /// a copy of what the test tests and the key, and keeps the means to abort it before anything
    /// else can take the lock.
    fn start_test_request<P, O, F>(
        &self,
        test: &PendingTest<P>,
        key: Option<String>,
        run: impl FnOnce(P, Option<String>) -> F,
    ) -> Result<JoinHandle<O>, O>
    where
        P: Clone,
        O: TestResult,
        F: Future<Output = O> + Send + 'static,
    {
        let mut task = None;
        let started = self.start_request_with(&test.request, |inner, id| {
            let run_state = &mut inner.kind_mut(test.request.kind).test;
            if run_state.generation != test.generation {
                return None;
            }
            run_state.request = Some(id);
            let spawned = tauri::async_runtime::spawn(run(test.request.provider.clone(), key));
            let abort = spawned.inner().abort_handle();
            task = Some(spawned);
            Some(Box::new(move || abort.abort()))
        });
        match (started, task) {
            (Ok(Some(_)), Some(task)) => Ok(task),
            _ => Err(O::cancelled()),
        }
    }

    /// The second and third steps.
    fn launch_test<P, O, F>(
        &self,
        test: &PendingTest<P>,
        run: impl FnOnce(P, Option<String>) -> F,
    ) -> Result<JoinHandle<O>, O>
    where
        P: Clone,
        O: TestResult,
        F: Future<Output = O> + Send + 'static,
    {
        let key = self.read_test_key(test)?;
        self.start_test_request(test, key, run)
    }

    /// Ends `kind`'s test that began with `generation`, however it ended. A test abandoned
    /// meanwhile is cancelled, whatever its result.
    fn end_test<O: TestResult>(
        &self,
        kind: ProviderKind,
        generation: u64,
        result: Result<O, AppError>,
    ) -> Result<O, AppError> {
        let mut inner = self.lock();
        let test = &mut inner.kind_mut(kind).test;
        test.running = false;
        let request = test.request.take();
        let abandoned = test.generation != generation;
        if let Some(request) = request {
            inner.requests.retain(|running| running.id != request);
        }
        if abandoned {
            return Ok(O::cancelled());
        }
        result
    }

    fn cancel_test(&self, kind: ProviderKind) {
        self.lock().cancel_test(kind);
    }

    /// Abandons a running image test, if any, while AI is on.
    fn cancel_image_test(&self) -> Result<(), AppError> {
        let mut inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
        inner.cancel_test(ProviderKind::Image);
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    /// How many requests of `kind` are in the registry: started and not yet ended.
    #[cfg(test)]
    pub(crate) fn running_requests(&self, kind: ProviderKind) -> usize {
        let inner = self.lock();
        inner
            .requests
            .iter()
            .filter(|running| running.kind == kind)
            .count()
    }
}

/// Every change to the state is a whole value, so it stays consistent after a panic.
fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    fn kind(&self, kind: ProviderKind) -> &KindState {
        match kind {
            ProviderKind::Text => &self.text,
            ProviderKind::Image => &self.image,
        }
    }

    fn kind_mut(&mut self, kind: ProviderKind) -> &mut KindState {
        match kind {
            ProviderKind::Text => &mut self.text,
            ProviderKind::Image => &mut self.image,
        }
    }

    /// Abandons `kind`'s running test, and only the test: its request is aborted, and its result
    /// will be discarded.
    fn cancel_test(&mut self, kind: ProviderKind) {
        let test = &mut self.kind_mut(kind).test;
        test.generation += 1;
        if let Some(request) = test.request.take()
            && let Some(at) = self
                .requests
                .iter()
                .position(|running| running.id == request)
        {
            (self.requests.remove(at).abort)();
        }
    }

    /// Abandons every request of `kind`: none prepared so far starts, and each running one is
    /// aborted. A running test's result is discarded. The other kind's requests go on.
    fn supersede_requests(&mut self, kind: ProviderKind) {
        let state = self.kind_mut(kind);
        state.generation += 1;
        state.test.generation += 1;
        state.test.request = None;
        let (superseded, kept): (Vec<_>, Vec<_>) = mem::take(&mut self.requests)
            .into_iter()
            .partition(|running| running.kind == kind);
        self.requests = kept;
        for running in superseded {
            (running.abort)();
        }
    }

    /// Writes `next` to the settings file, and only then takes it as the saved settings.
    fn save(&mut self, next: Saved) -> Result<Settings, AppError> {
        let file = self
            .file
            .as_deref()
            .ok_or_else(|| AppError::new(ErrorKind::Io, "The settings cannot be saved."))?;
        store::save(file, &next)?;
        self.saved = next;
        Ok(to_settings(&self.saved))
    }
}

fn to_settings(saved: &Saved) -> Settings {
    Settings {
        ai: saved.ai,
        text_provider: saved.provider.as_ref().map(|provider| TextProvider {
            base_url: provider.base_url.as_str().to_owned(),
            model: provider.model.clone(),
            key: provider.key,
            host: provider.base_url.host(),
        }),
        image_provider: saved.image.as_ref().map(|image| ImageProvider {
            model: image.model.clone(),
            key: image.key,
            host: images::HOST.to_owned(),
        }),
    }
}

/// A typed key, trimmed, or `None` when none was typed; or why it is refused.
fn typed_key(key: Option<&str>) -> Result<Option<&str>, &'static str> {
    let key = key.map(str::trim).filter(|key| !key.is_empty());
    if key.is_some_and(|key| !key.chars().all(|char| char.is_ascii_graphic())) {
        // The message never quotes the character, which is part of the key.
        return Err("The key can hold only letters, digits and ASCII symbols, with no spaces.");
    }
    Ok(key)
}

fn invalid(field: ProviderField, message: impl Into<String>) -> ProviderSaved {
    ProviderSaved::Invalid {
        field,
        message: message.into(),
    }
}

pub(crate) fn ai_off() -> AppError {
    AppError::new(ErrorKind::AiOff, "AI features are off.")
}

fn secrets_error(error: SecretsError) -> AppError {
    match error {
        SecretsError::NoKeychain => {
            AppError::new(ErrorKind::Keychain, "No system keychain is available.")
        }
        SecretsError::Keychain(reason) => AppError::new(ErrorKind::Keychain, reason),
        SecretsError::File(error) => error.into(),
    }
}

/// Runs `work` with the settings on Tauri's blocking pool, inside `guard`.
async fn blocking<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&SettingsState) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(move || guard(|| work(&app.state::<SettingsState>())))
        .await
        .unwrap_or_else(|_| Err(internal()))
}

fn internal() -> AppError {
    AppError::new(
        ErrorKind::Internal,
        "An unexpected internal error occurred.",
    )
}

/// The text provider's connection test.
async fn test_text(provider: SavedProvider, key: Option<String>, timeout: Duration) -> TestOutcome {
    providers::test(&provider.base_url, &provider.model, key.as_deref(), timeout).await
}

/// The image provider's connection test.
async fn test_image(
    target: ImageTarget,
    key: Option<String>,
    timeout: Duration,
) -> ImageTestOutcome {
    // `prepare_image_request` lets only a provider with a stored key be tested.
    let key = key.unwrap_or_default();
    images::test(&target.base, &target.model, &key, timeout).await
}

/// Sends one connection test, prepared by `prepare`, through `run`. Its steps run on the blocking
/// pool, because a save waiting for a keychain's unlock prompt holds the settings lock.
async fn run_test<P, O, F>(
    app: AppHandle,
    prepare: impl FnOnce(&SettingsState) -> Result<Prepared<P>, AppError> + Send + 'static,
    run: impl FnOnce(P, Option<String>) -> F + Send + 'static,
) -> Result<O, AppError>
where
    P: Clone + Send + 'static,
    O: TestResult,
    F: Future<Output = O> + Send + 'static,
{
    let test = blocking(app.clone(), move |state| state.begin_test(prepare(state)?)).await?;
    let (kind, generation) = (test.request.kind, test.generation);
    let launched = blocking(app.clone(), move |state| Ok(state.launch_test(&test, run))).await;
    let result = match launched {
        // An aborted request ends as cancelled in `end_test`, because its generation moved on.
        Ok(Ok(task)) => task.await.map_err(|_| internal()),
        Ok(Err(outcome)) => Ok(outcome),
        Err(error) => Err(error),
    };
    blocking(app, move |state| state.end_test(kind, generation, result)).await
}

#[tauri::command]
pub async fn settings_get(app: AppHandle) -> Result<Settings, AppError> {
    blocking(app, |state| Ok(state.get())).await
}

#[tauri::command]
pub async fn settings_ai_set(app: AppHandle, on: bool) -> Result<Settings, AppError> {
    blocking(app, move |state| state.set_ai(on)).await
}

#[tauri::command]
pub async fn provider_save(
    app: AppHandle,
    base_url: String,
    model: String,
    key: Option<String>,
    key_file: bool,
) -> Result<ProviderSaved, AppError> {
    blocking(app, move |state| {
        state.save_provider(&base_url, &model, key.as_deref(), key_file)
    })
    .await
}

#[tauri::command]
pub async fn provider_key_remove(app: AppHandle) -> Result<Settings, AppError> {
    blocking(app, |state| state.remove_key()).await
}

/// Sends one test request to the saved text provider.
#[tauri::command]
pub async fn provider_test(app: AppHandle) -> Result<TestOutcome, AppError> {
    run_test(app, SettingsState::prepare_request, |provider, key| {
        test_text(provider, key, providers::TIMEOUT)
    })
    .await
}

/// Abandons a running text provider test, if any.
#[tauri::command]
pub async fn provider_test_cancel(app: AppHandle) -> Result<(), AppError> {
    blocking(app, |state| {
        state.cancel_test(ProviderKind::Text);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn image_provider_save(
    app: AppHandle,
    model: String,
    key: Option<String>,
    key_file: bool,
) -> Result<ProviderSaved, AppError> {
    blocking(app, move |state| {
        state.save_image_provider(&model, key.as_deref(), key_file)
    })
    .await
}

#[tauri::command]
pub async fn image_provider_key_remove(app: AppHandle) -> Result<Settings, AppError> {
    blocking(app, |state| state.remove_image_key()).await
}

/// Asks OpenRouter whether it accepts the saved image key and lists the saved model, without
/// generating an image.
#[tauri::command]
pub async fn image_provider_test(app: AppHandle) -> Result<ImageTestOutcome, AppError> {
    run_test(app, SettingsState::prepare_image_request, |target, key| {
        test_image(target, key, providers::TIMEOUT)
    })
    .await
}

/// Abandons a running image provider test, if any.
#[tauri::command]
pub async fn image_provider_test_cancel(app: AppHandle) -> Result<(), AppError> {
    blocking(app, |state| state.cancel_image_test()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::test_support::{CHAT_REPLY, Server, json_answer};
    use crate::secrets::test_support::{KEY, MockKeychain};
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;
    use std::time::Instant;
    use tauri::async_runtime::block_on;
    use tempfile::TempDir;

    const BASE_URL: &str = "https://openrouter.ai/api/v1";
    const MODEL: &str = "anthropic/claude-sonnet-4.5";

    struct Fixture {
        folder: TempDir,
        keychain: MockKeychain,
        state: SettingsState,
    }

    impl Fixture {
        fn new() -> Self {
            let folder = tempfile::tempdir().unwrap();
            let keychain = MockKeychain::new();
            let state = SettingsState::with_secrets(
                Some(folder.path()),
                keychain.secrets(Some(folder.path())),
            );
            Self {
                folder,
                keychain,
                state,
            }
        }

        fn file(&self) -> PathBuf {
            self.folder.path().join("settings.json")
        }

        fn file_text(&self) -> String {
            fs::read_to_string(self.file()).unwrap()
        }

        fn save(&self, base_url: &str, key: Option<&str>) -> Result<ProviderSaved, AppError> {
            self.state.save_provider(base_url, MODEL, key, false)
        }
    }

    fn saved_key(saved: ProviderSaved) -> KeyStorage {
        match saved {
            ProviderSaved::Saved { settings } => settings.text_provider.unwrap().key,
            other => panic!("expected saved, got {other:?}"),
        }
    }

    #[test]
    fn without_a_file_ai_is_on_and_no_provider_is_saved() {
        let fixture = Fixture::new();

        assert_eq!(
            serde_json::to_value(fixture.state.get()).unwrap(),
            json!({ "ai": true, "textProvider": null, "imageProvider": null })
        );
    }

    #[test]
    fn the_ai_switch_is_saved_and_survives_a_restart() {
        let fixture = Fixture::new();

        let settings = fixture.state.set_ai(false).unwrap();

        assert!(!settings.ai);
        let reloaded = SettingsState::with_secrets(
            Some(fixture.folder.path()),
            fixture.keychain.secrets(Some(fixture.folder.path())),
        );
        assert!(!reloaded.get().ai);
    }

    #[cfg(unix)]
    #[test]
    fn a_switch_that_cannot_be_saved_keeps_its_state() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        fs::set_permissions(fixture.folder.path(), fs::Permissions::from_mode(0o500)).unwrap();

        let error = fixture.state.set_ai(false).unwrap_err();

        fs::set_permissions(fixture.folder.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(error.kind, ErrorKind::Io);
        assert!(fixture.state.get().ai);
    }

    #[test]
    fn without_an_app_data_folder_nothing_saves() {
        let state = SettingsState::with_secrets(None, MockKeychain::new().secrets(None));

        let error = state.set_ai(false).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(error.message, "The settings cannot be saved.");
        assert!(state.get().ai);
    }

    #[test]
    fn provider_commands_are_refused_while_ai_is_off() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();
        fixture.state.set_ai(false).unwrap();

        assert_eq!(
            fixture.save(BASE_URL, Some("sk-other")).unwrap_err().kind,
            ErrorKind::AiOff
        );
        assert_eq!(
            fixture.state.remove_key().unwrap_err().kind,
            ErrorKind::AiOff
        );
        assert_eq!(fixture.keychain.password().unwrap(), KEY);

        // Switching AI on again shows the provider unchanged.
        let settings = fixture.state.set_ai(true).unwrap();
        assert_eq!(settings.text_provider.unwrap().key, KeyStorage::Keychain);
    }

    #[test]
    fn a_save_stores_the_key_in_the_keychain_and_never_in_the_settings() {
        let fixture = Fixture::new();

        let saved = fixture
            .state
            .save_provider(
                " https://openrouter.ai/api/v1/ ",
                " anthropic/claude-sonnet-4.5\n",
                Some(&format!(" {KEY} ")),
                false,
            )
            .unwrap();

        assert_eq!(
            serde_json::to_value(&saved).unwrap(),
            json!({
                "state": "saved",
                "settings": {
                    "ai": true,
                    "textProvider": {
                        "baseUrl": BASE_URL,
                        "model": MODEL,
                        "key": "keychain",
                        "host": "openrouter.ai",
                    },
                    "imageProvider": null,
                },
            })
        );
        assert_eq!(fixture.keychain.password().unwrap(), KEY);
        let text = fixture.file_text();
        assert!(
            text.contains(BASE_URL) && text.contains("\"keychain\""),
            "{text}"
        );
        assert!(!text.contains(KEY));
        assert!(
            !serde_json::to_string(&fixture.state.get())
                .unwrap()
                .contains(KEY)
        );
    }

    #[test]
    fn each_field_that_breaks_a_rule_is_named_and_nothing_is_stored() {
        let fixture = Fixture::new();
        let cases = [
            (
                "http://example.com/v1",
                MODEL,
                Some(KEY),
                ProviderField::BaseUrl,
            ),
            (BASE_URL, "  ", Some(KEY), ProviderField::Model),
            (BASE_URL, MODEL, Some("sk key"), ProviderField::Key),
            (BASE_URL, MODEL, Some("sk-\u{7}"), ProviderField::Key),
            (BASE_URL, MODEL, Some("sk-ключ"), ProviderField::Key),
        ];
        for (base_url, model, key, field) in cases {
            let saved = fixture
                .state
                .save_provider(base_url, model, key, false)
                .unwrap();

            let ProviderSaved::Invalid {
                field: named,
                message,
            } = saved
            else {
                panic!("{base_url} {model}: expected invalid, got {saved:?}");
            };
            assert_eq!(named, field);
            assert!(!message.contains("ключ") && !message.contains('\u{7}'));
        }
        assert!(fixture.keychain.password().is_err());
        assert!(!fixture.file().exists());
    }

    #[test]
    fn without_a_keychain_nothing_is_stored_until_the_user_agrees_to_the_key_file() {
        let folder = tempfile::tempdir().unwrap();
        let state = SettingsState::with_secrets(
            Some(folder.path()),
            MockKeychain::unreachable(Some(folder.path())),
        );

        let saved = state
            .save_provider(BASE_URL, MODEL, Some(KEY), false)
            .unwrap();

        assert_eq!(saved, ProviderSaved::NoKeychain);
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 0);
        assert_eq!(state.get().text_provider, None);

        let saved = state
            .save_provider(BASE_URL, MODEL, Some(KEY), true)
            .unwrap();
        assert_eq!(saved_key(saved), KeyStorage::File);
        let settings = fs::read_to_string(folder.path().join("settings.json")).unwrap();
        assert!(settings.contains("\"file\"") && !settings.contains(KEY));
    }

    #[test]
    fn a_keychain_that_refuses_saves_nothing() {
        let fixture = Fixture::new();
        fixture.keychain.fail_next_call();

        let error = fixture.save(BASE_URL, Some(KEY)).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Keychain);
        assert!(!error.message.contains(KEY));
        assert!(!fixture.file().exists());
        assert_eq!(fixture.state.get().text_provider, None);
    }

    #[test]
    fn without_a_typed_key_a_path_change_keeps_the_key_and_an_origin_change_removes_it() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();

        let saved = fixture.save("https://openrouter.ai/api/v2", None).unwrap();
        assert_eq!(saved_key(saved), KeyStorage::Keychain);
        assert_eq!(fixture.keychain.password().unwrap(), KEY);

        let saved = fixture.save("https://example.com/v1", None).unwrap();
        assert_eq!(saved_key(saved), KeyStorage::None);
        assert!(fixture.keychain.password().is_err());
        assert!(fixture.file_text().contains("\"none\""));
    }

    #[test]
    fn an_origin_change_whose_key_cannot_be_removed_saves_nothing() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();
        let before = fixture.file_text();
        fixture.keychain.fail_next_call();

        let error = fixture.save("https://example.com/v1", None).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Keychain);
        assert_eq!(fixture.file_text(), before);
        assert_eq!(
            fixture.state.get().text_provider.unwrap().base_url,
            BASE_URL
        );
        assert_eq!(fixture.keychain.password().unwrap(), KEY);
    }

    #[test]
    fn without_a_provider_or_a_typed_key_no_key_is_recorded() {
        let fixture = Fixture::new();

        let saved = fixture.save("http://localhost:11434/v1", None).unwrap();

        assert_eq!(saved_key(saved), KeyStorage::None);
    }

    #[test]
    fn removing_the_key_deletes_it_and_then_records_none() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();

        fixture.keychain.fail_next_call();
        let error = fixture.state.remove_key().unwrap_err();
        assert_eq!(error.kind, ErrorKind::Keychain);
        assert_eq!(
            fixture.state.get().text_provider.unwrap().key,
            KeyStorage::Keychain
        );

        let settings = fixture.state.remove_key().unwrap();
        assert_eq!(settings.text_provider.unwrap().key, KeyStorage::None);
        assert!(fixture.keychain.password().is_err());
        assert!(fixture.file_text().contains("\"none\""));
    }

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);

    type TextTest = PendingTest<SavedProvider>;

    /// The text test's steps as `provider_test` runs them.
    impl SettingsState {
        fn begin_text_test(&self) -> Result<TextTest, AppError> {
            self.begin_test(self.prepare_request()?)
        }

        fn launch_text_test(
            &self,
            test: &TextTest,
        ) -> Result<JoinHandle<TestOutcome>, TestOutcome> {
            self.launch_test(test, |provider, key| test_text(provider, key, TEST_TIMEOUT))
        }

        fn end_text_test(
            &self,
            generation: u64,
            result: Result<TestOutcome, AppError>,
        ) -> Result<TestOutcome, AppError> {
            self.end_test(ProviderKind::Text, generation, result)
        }
    }

    /// The steps `provider_test` runs, without Tauri's blocking pool.
    fn run_test(state: &SettingsState) -> Result<TestOutcome, AppError> {
        let test = state.begin_text_test()?;
        let result = match state.launch_text_test(&test) {
            Ok(task) => block_on(task).map_err(|_| internal()),
            Err(outcome) => Ok(outcome),
        };
        state.end_text_test(test.generation, result)
    }

    /// A fixture whose provider, with a key in the keychain, is `server`.
    fn saved_at(server: &Server) -> Fixture {
        let fixture = Fixture::new();
        fixture
            .save(server.base_url("/v1").as_str(), Some(KEY))
            .unwrap();
        fixture
    }

    fn wait_for_request(server: &Server) {
        let start = Instant::now();
        while server.requests().is_empty() {
            assert!(start.elapsed() < TEST_TIMEOUT, "no request arrived");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn only_the_test_sends_a_request_with_the_saved_model_and_key() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let fixture = saved_at(&server);
        fixture.state.get();
        fixture.state.set_ai(false).unwrap();
        fixture.state.set_ai(true).unwrap();
        fixture.save(server.base_url("/v1").as_str(), None).unwrap();
        assert!(server.requests().is_empty());

        assert_eq!(run_test(&fixture.state).unwrap(), TestOutcome::Connected);

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "/v1/chat/completions");
        assert_eq!(
            requests[0].header("authorization"),
            Some(format!("Bearer {KEY}").as_str())
        );
        assert!(String::from_utf8_lossy(&requests[0].body).contains(MODEL));
    }

    #[test]
    fn a_test_is_refused_while_ai_is_off_without_a_provider_and_while_one_runs() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture.state.begin_text_test().err().unwrap().kind,
            ErrorKind::NotFound
        );

        let server = Server::silent();
        let fixture = saved_at(&server);
        // The first test is still reading its key.
        let first = fixture.state.begin_text_test().unwrap();
        assert_eq!(
            fixture.state.begin_text_test().err().unwrap().kind,
            ErrorKind::Conflict
        );
        // Its request is running.
        let task = fixture.state.launch_text_test(&first).ok().unwrap();
        assert_eq!(
            fixture.state.begin_text_test().err().unwrap().kind,
            ErrorKind::Conflict
        );

        fixture.state.set_ai(false).unwrap();
        let result = block_on(task).map_err(|_| internal());
        assert_eq!(
            fixture
                .state
                .end_text_test(first.generation, result)
                .unwrap(),
            TestOutcome::Cancelled
        );
        assert_eq!(
            fixture.state.begin_text_test().err().unwrap().kind,
            ErrorKind::AiOff
        );
    }

    #[test]
    fn cancelling_saving_or_switching_ai_off_during_a_test_cancels_it() {
        for name in ["cancel", "save", "AI off"] {
            let server = Server::silent();
            let fixture = saved_at(&server);
            let test = fixture.state.begin_text_test().unwrap();
            let task = fixture.state.launch_text_test(&test).ok().unwrap();
            wait_for_request(&server);

            match name {
                "cancel" => fixture.state.cancel_test(ProviderKind::Text),
                "save" => drop(fixture.save("https://example.com/v1", None).unwrap()),
                _ => drop(fixture.state.set_ai(false).unwrap()),
            }

            // The silent server would hold the request until its timeout; it was aborted.
            let result = block_on(task).map_err(|_| internal());
            assert!(result.is_err(), "{name}");
            assert_eq!(
                fixture
                    .state
                    .end_text_test(test.generation, result)
                    .unwrap(),
                TestOutcome::Cancelled,
                "{name}"
            );
            assert!(!fixture.state.lock().text.test.running, "{name}");
        }
    }

    #[test]
    fn a_test_cancelled_after_reading_its_key_sends_nothing() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let fixture = saved_at(&server);
        let test = fixture.state.begin_text_test().unwrap();
        let key = fixture
            .state
            .read_test_key::<_, TestOutcome>(&test)
            .unwrap();

        fixture.state.cancel_test(ProviderKind::Text);

        let started = fixture
            .state
            .start_test_request(&test, key, |provider, key| {
                test_text(provider, key, TEST_TIMEOUT)
            });
        assert_eq!(started.err(), Some(TestOutcome::Cancelled));
        assert_eq!(
            fixture
                .state
                .end_text_test(test.generation, Ok(TestOutcome::Cancelled))
                .unwrap(),
            TestOutcome::Cancelled
        );
        // A new test can start.
        assert_eq!(run_test(&fixture.state).unwrap(), TestOutcome::Connected);
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn a_key_that_cannot_be_read_ends_the_test_before_any_request() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let fixture = saved_at(&server);
        fixture.keychain.fail_next_call();

        let outcome = run_test(&fixture.state).unwrap();

        let TestOutcome::Failed {
            reason: ProviderFailure::KeyUnreadable,
            detail: Some(detail),
            ..
        } = outcome
        else {
            panic!("expected key_unreadable, got {outcome:?}");
        };
        assert!(detail.contains("locked or refused"), "{detail}");
        assert!(server.requests().is_empty());
        assert!(!fixture.state.lock().text.test.running);
    }

    /// Starts a request whose abort counts its calls in `aborted`.
    fn start_counted<P>(
        state: &SettingsState,
        request: &Prepared<P>,
        aborted: &Arc<AtomicUsize>,
    ) -> Result<Option<RequestGuard>, Superseded> {
        let aborted = Arc::clone(aborted);
        state.start_request(request, || {
            Some(Box::new(move || {
                aborted.fetch_add(1, Ordering::SeqCst);
            }))
        })
    }

    #[test]
    fn ai_off_a_provider_save_and_a_key_removal_abort_a_running_request() {
        for name in ["AI off", "save", "key removal"] {
            let fixture = Fixture::new();
            fixture.save(BASE_URL, Some(KEY)).unwrap();
            let request = fixture.state.prepare_request().unwrap();
            let aborted = Arc::new(AtomicUsize::new(0));
            let guard = start_counted(&fixture.state, &request, &aborted).unwrap();
            assert!(guard.is_some(), "{name}");

            match name {
                "AI off" => drop(fixture.state.set_ai(false).unwrap()),
                "save" => drop(fixture.save(BASE_URL, None).unwrap()),
                _ => drop(fixture.state.remove_key().unwrap()),
            }

            assert_eq!(aborted.load(Ordering::SeqCst), 1, "{name}");
            // The request was prepared before the change, so it can no longer start.
            let mut started = false;
            let result = fixture.state.start_request(&request, || {
                started = true;
                None
            });
            assert_eq!(result.err(), Some(Superseded), "{name}");
            assert!(!started, "{name}");
        }
    }

    #[test]
    fn a_finished_request_is_no_longer_aborted() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();
        let request = fixture.state.prepare_request().unwrap();
        let aborted = Arc::new(AtomicUsize::new(0));

        drop(start_counted(&fixture.state, &request, &aborted).unwrap());
        fixture.state.set_ai(false).unwrap();

        assert_eq!(aborted.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn cancelling_the_test_leaves_an_answer_s_request_alone() {
        let server = Server::silent();
        let fixture = saved_at(&server);
        let answer = fixture.state.prepare_request().unwrap();
        let aborted = Arc::new(AtomicUsize::new(0));
        let _guard = start_counted(&fixture.state, &answer, &aborted).unwrap();
        let test = fixture.state.begin_text_test().unwrap();
        let task = fixture.state.launch_text_test(&test).ok().unwrap();

        fixture.state.cancel_test(ProviderKind::Text);

        assert!(block_on(task).is_err());
        assert_eq!(aborted.load(Ordering::SeqCst), 0);
        // The provider generation did not move, so an answer prepared before still starts.
        let started = start_counted(&fixture.state, &answer, &aborted).unwrap();
        assert!(started.is_some());
    }

    const IMAGE_MODEL: &str = "google/gemini-2.5-flash-image";
    const IMAGE_KEY: &str = "sk-or-image-0123456789";

    type ImageTest = PendingTest<ImageTarget>;

    /// The image test's steps as `image_provider_test` runs them.
    impl SettingsState {
        fn begin_image_test(&self) -> Result<ImageTest, AppError> {
            self.begin_test(self.prepare_image_request()?)
        }

        fn launch_image_test(
            &self,
            test: &ImageTest,
        ) -> Result<JoinHandle<ImageTestOutcome>, ImageTestOutcome> {
            self.launch_test(test, |target, key| test_image(target, key, TEST_TIMEOUT))
        }
    }

    fn run_image_test(state: &SettingsState) -> Result<ImageTestOutcome, AppError> {
        let test = state.begin_image_test()?;
        let result = match state.launch_image_test(&test) {
            Ok(task) => block_on(task).map_err(|_| internal()),
            Err(outcome) => Ok(outcome),
        };
        state.end_test(ProviderKind::Image, test.generation, result)
    }

    impl Fixture {
        fn save_image(&self, key: Option<&str>) -> Result<ProviderSaved, AppError> {
            self.state.save_image_provider(IMAGE_MODEL, key, false)
        }
    }

    /// A fixture with a text provider and an image provider, each with a key in the keychain,
    /// whose requests both go to `server`.
    fn both_at(server: &Server) -> Fixture {
        let mut fixture = saved_at(server);
        fixture.state.image_base = format!("http://{}/api/v1", server.address());
        fixture.save_image(Some(IMAGE_KEY)).unwrap();
        fixture
    }

    #[test]
    fn the_image_provider_keeps_its_own_key_and_leaves_the_text_provider_alone() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();

        let saved = fixture
            .state
            .save_image_provider(
                &format!(" {IMAGE_MODEL}\n"),
                Some(&format!(" {IMAGE_KEY} ")),
                false,
            )
            .unwrap();

        let ProviderSaved::Saved { settings } = saved else {
            panic!("expected saved, got {saved:?}");
        };
        assert_eq!(
            serde_json::to_value(&settings).unwrap()["imageProvider"],
            json!({ "model": IMAGE_MODEL, "key": "keychain", "host": "openrouter.ai" })
        );
        assert_eq!(settings.text_provider.unwrap().key, KeyStorage::Keychain);
        assert_eq!(
            fixture.keychain.password_of(KeySlot::Image).unwrap(),
            IMAGE_KEY
        );
        assert_eq!(fixture.keychain.password().unwrap(), KEY);
        let text = fixture.file_text();
        assert!(text.contains(IMAGE_MODEL), "{text}");
        assert!(!text.contains(IMAGE_KEY) && !text.contains(KEY));

        // Saved again without a key, the stored one stays.
        let saved = fixture.save_image(None).unwrap();
        let ProviderSaved::Saved { settings } = saved else {
            panic!("expected saved, got {saved:?}");
        };
        assert_eq!(settings.image_provider.unwrap().key, KeyStorage::Keychain);
        // And a text save keeps the image provider.
        fixture.save(BASE_URL, None).unwrap();
        assert!(fixture.state.get().image_provider.is_some());
    }

    #[test]
    fn an_image_save_needs_a_model_and_a_key_unless_one_is_stored() {
        let fixture = Fixture::new();
        let cases = [
            (
                " ",
                Some(IMAGE_KEY),
                ProviderField::Model,
                "Enter the model's ID.",
            ),
            (IMAGE_MODEL, None, ProviderField::Key, "Enter the API key."),
            (
                IMAGE_MODEL,
                Some("  "),
                ProviderField::Key,
                "Enter the API key.",
            ),
            (
                IMAGE_MODEL,
                Some("sk key"),
                ProviderField::Key,
                "The key can hold only letters, digits and ASCII symbols, with no spaces.",
            ),
        ];
        for (model, key, field, message) in cases {
            let saved = fixture
                .state
                .save_image_provider(model, key, false)
                .unwrap();

            assert_eq!(
                saved,
                ProviderSaved::Invalid {
                    field,
                    message: message.to_owned()
                },
                "{model} {key:?}"
            );
        }
        assert!(fixture.keychain.password_of(KeySlot::Image).is_err());
        assert!(!fixture.file().exists());
    }

    #[test]
    fn without_a_keychain_the_image_key_goes_to_the_key_file_only_with_consent() {
        let folder = tempfile::tempdir().unwrap();
        let state = SettingsState::with_secrets(
            Some(folder.path()),
            MockKeychain::unreachable(Some(folder.path())),
        );

        let saved = state
            .save_image_provider(IMAGE_MODEL, Some(IMAGE_KEY), false)
            .unwrap();
        assert_eq!(saved, ProviderSaved::NoKeychain);
        assert_eq!(state.get().image_provider, None);

        let saved = state
            .save_image_provider(IMAGE_MODEL, Some(IMAGE_KEY), true)
            .unwrap();
        let ProviderSaved::Saved { settings } = saved else {
            panic!("expected saved, got {saved:?}");
        };
        assert_eq!(settings.image_provider.unwrap().key, KeyStorage::File);
        let keys = fs::read_to_string(folder.path().join("keys.json")).unwrap();
        assert!(keys.contains("imageProvider") && !keys.contains("textProvider"));
    }

    #[test]
    fn removing_the_image_key_keeps_the_model_and_the_text_key() {
        let fixture = Fixture::new();
        fixture.save(BASE_URL, Some(KEY)).unwrap();
        fixture.save_image(Some(IMAGE_KEY)).unwrap();

        let settings = fixture.state.remove_image_key().unwrap();

        let image = settings.image_provider.unwrap();
        assert_eq!(
            (image.model.as_str(), image.key),
            (IMAGE_MODEL, KeyStorage::None)
        );
        assert!(fixture.keychain.password_of(KeySlot::Image).is_err());
        assert_eq!(fixture.keychain.password().unwrap(), KEY);
        assert_eq!(
            fixture.state.begin_image_test().err().unwrap().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn image_provider_commands_are_refused_while_ai_is_off() {
        let fixture = Fixture::new();
        fixture.save_image(Some(IMAGE_KEY)).unwrap();
        fixture.state.set_ai(false).unwrap();

        let refusals = [
            fixture.save_image(Some("sk-other")).err(),
            fixture.state.remove_image_key().err(),
            fixture.state.begin_image_test().err(),
            fixture.state.cancel_image_test().err(),
        ];

        for refusal in refusals {
            assert_eq!(refusal.map(|error| error.kind), Some(ErrorKind::AiOff));
        }
        assert_eq!(
            fixture.keychain.password_of(KeySlot::Image).unwrap(),
            IMAGE_KEY
        );
    }

    #[test]
    fn each_provider_s_save_and_key_removal_abort_only_its_own_requests_and_ai_off_aborts_both() {
        for name in [
            "image save",
            "image key removal",
            "text save",
            "text key removal",
            "AI off",
        ] {
            let fixture = Fixture::new();
            fixture.save(BASE_URL, Some(KEY)).unwrap();
            fixture.save_image(Some(IMAGE_KEY)).unwrap();
            let text = fixture.state.prepare_request().unwrap();
            let image = fixture.state.prepare_image_request().unwrap();
            let text_aborted = Arc::new(AtomicUsize::new(0));
            let image_aborted = Arc::new(AtomicUsize::new(0));
            let _text_guard = start_counted(&fixture.state, &text, &text_aborted).unwrap();
            let _image_guard = start_counted(&fixture.state, &image, &image_aborted).unwrap();

            match name {
                "image save" => drop(fixture.save_image(None).unwrap()),
                "image key removal" => drop(fixture.state.remove_image_key().unwrap()),
                "text save" => drop(fixture.save(BASE_URL, None).unwrap()),
                "text key removal" => drop(fixture.state.remove_key().unwrap()),
                _ => drop(fixture.state.set_ai(false).unwrap()),
            }

            let (text_hit, image_hit) = match name {
                "image save" | "image key removal" => (false, true),
                "text save" | "text key removal" => (true, false),
                _ => (true, true),
            };
            assert_eq!(
                text_aborted.load(Ordering::SeqCst),
                usize::from(text_hit),
                "{name}"
            );
            assert_eq!(
                image_aborted.load(Ordering::SeqCst),
                usize::from(image_hit),
                "{name}"
            );
            // A request prepared before its own kind was superseded can no longer start.
            let text_again = start_counted(&fixture.state, &text, &text_aborted);
            let image_again = start_counted(&fixture.state, &image, &image_aborted);
            assert_eq!(text_again.is_err(), text_hit, "{name}");
            assert_eq!(image_again.is_err(), image_hit, "{name}");
        }
    }

    #[test]
    fn the_image_test_sends_the_image_key_to_the_image_api_only() {
        let server = Server::start(|request| match request.path.as_str() {
            "/api/v1/key" => Some(json_answer("200 OK", r#"{"data":{}}"#)),
            "/api/v1/images/models" => Some(json_answer(
                "200 OK",
                &json!({ "data": [{ "id": IMAGE_MODEL }] }).to_string(),
            )),
            _ => Some(json_answer("404 Not Found", "{}")),
        });
        let fixture = both_at(&server);

        assert_eq!(
            run_image_test(&fixture.state).unwrap(),
            ImageTestOutcome::Success
        );

        let requests = server.requests();
        let paths: Vec<&str> = requests
            .iter()
            .map(|request| request.path.as_str())
            .collect();
        assert_eq!(paths, ["/api/v1/key", "/api/v1/images/models"]);
        for request in &requests {
            assert_eq!(
                request.header("authorization"),
                Some(format!("Bearer {IMAGE_KEY}").as_str())
            );
        }
    }

    #[test]
    fn saving_one_provider_cancels_its_own_test_and_not_the_other_s() {
        for image_saved in [true, false] {
            let server = Server::silent();
            let fixture = both_at(&server);
            let text_test = fixture.state.begin_text_test().unwrap();
            let image_test = fixture.state.begin_image_test().unwrap();
            let text_task = fixture.state.launch_text_test(&text_test).ok().unwrap();
            let image_task = fixture.state.launch_image_test(&image_test).ok().unwrap();
            let start = Instant::now();
            while server.requests().len() < 2 {
                assert!(
                    start.elapsed() < TEST_TIMEOUT,
                    "the requests did not arrive"
                );
                thread::sleep(Duration::from_millis(10));
            }

            let other = match image_saved {
                true => {
                    fixture.save_image(None).unwrap();
                    let result = block_on(image_task).map_err(|_| internal());
                    let outcome = fixture
                        .state
                        .end_test(ProviderKind::Image, image_test.generation, result)
                        .unwrap();
                    assert_eq!(outcome, ImageTestOutcome::Cancelled);
                    ProviderKind::Text
                }
                false => {
                    fixture.save(server.base_url("/v1").as_str(), None).unwrap();
                    let result = block_on(text_task).map_err(|_| internal());
                    let outcome = fixture
                        .state
                        .end_text_test(text_test.generation, result)
                        .unwrap();
                    assert_eq!(outcome, TestOutcome::Cancelled);
                    ProviderKind::Image
                }
            };

            // The other kind's test still runs, with its request registered.
            let inner = fixture.state.lock();
            assert!(inner.kind(other).test.running, "{other:?}");
            assert!(inner.requests.iter().any(|running| running.kind == other));
            drop(inner);
            fixture.state.set_ai(false).unwrap();
        }
    }
}
