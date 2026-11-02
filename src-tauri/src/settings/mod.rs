//! The `settings` area: the application's settings, the AI switch and the saved text provider,
//! and the commands that read and change them. The provider's key goes through `secrets`, and its
//! base URL's rules come from `providers`.
//!
//! The commands run one at a time under the settings lock, held for the whole operation, keychain
//! calls included. Each runs on Tauri's blocking pool, because a keychain may wait for the user to
//! answer an unlock prompt.
//!
//! Settings also authorize every request to the provider: the connection test's and the
//! assistant's answer. A request takes a snapshot of the provider with the provider generation
//! (`prepare_request`), reads the key without the lock (`read_key`), and starts only inside
//! `start_request`, under the lock, while the generation is unchanged and AI is on; its abort is
//! stored there before the lock is released. Switching AI off, saving the provider and removing
//! the key move the generation and call every stored abort, so no request leaves after them and
//! none keeps running. `provider_test_cancel` abandons only the test, through its own mark.

mod store;

use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorKind, guard};
use crate::providers::{self, BaseUrl, ProviderFailure, TestOutcome};
use crate::secrets::{KeyStorage, Secrets, SecretsError};
use store::{Saved, SavedProvider};

/// The settings as the interface sees them. It never holds a key.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Whether AI features are on.
    ai: bool,
    /// The saved text provider, if any.
    text_provider: Option<TextProvider>,
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

/// The settings, managed by Tauri and loaded at launch.
pub struct SettingsState {
    /// Shared with each `RequestGuard`, which removes its request's abort when dropped.
    inner: Arc<Mutex<Inner>>,
    /// Beside the settings lock, so that reading a key never needs it.
    secrets: Arc<Secrets>,
}

struct Inner {
    saved: Saved,
    /// `grimoire-data/settings.json`; `None` without an app data folder, and then nothing saves.
    file: Option<PathBuf>,
    /// Moves on when AI is switched off, the provider is saved or its key removed. A request
    /// prepared before it moved never starts.
    provider_generation: u64,
    /// The abort of each running provider request, by request id.
    requests: Vec<(u64, Abort)>,
    next_request: u64,
    test: TestRun,
}

/// Aborts a running provider request. It takes no lock.
pub type Abort = Box<dyn Fn() + Send>;

/// The connection test, which runs one at a time.
#[derive(Default)]
struct TestRun {
    /// Moves on whenever a running test must be abandoned, so its result is discarded.
    generation: u64,
    running: bool,
    /// The running test's request id in `Inner::requests`.
    request: Option<u64>,
}

/// A request that passed its first step: the provider generation it was prepared in, and a copy of
/// the provider it goes to.
#[derive(Clone)]
pub struct PreparedRequest {
    generation: u64,
    provider: SavedProvider,
}

impl PreparedRequest {
    pub fn base_url(&self) -> &BaseUrl {
        &self.provider.base_url
    }

    pub fn model(&self) -> &str {
        &self.provider.model
    }
}

/// The request was not started: AI was switched off, or the provider saved again or its key
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
        lock(&self.inner).requests.retain(|(id, _)| *id != self.id);
    }
}

/// A test that passed its first step, with a copy of the provider it tests.
struct PendingTest {
    generation: u64,
    request: PreparedRequest,
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
                provider_generation: 0,
                requests: Vec::new(),
                next_request: 0,
                test: TestRun::default(),
            })),
            secrets: Arc::new(secrets),
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
            inner.supersede_requests();
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
        inner.supersede_requests();
        let base_url = match BaseUrl::parse(base_url) {
            Ok(url) => url,
            Err(message) => return Ok(invalid(ProviderField::BaseUrl, message)),
        };
        let model = model.trim();
        if model.is_empty() {
            return Ok(invalid(ProviderField::Model, "Enter the model's ID."));
        }
        let key = key.map(str::trim).filter(|key| !key.is_empty());
        if key.is_some_and(|key| !key.chars().all(|char| char.is_ascii_graphic())) {
            // The message never quotes the character, which is part of the key.
            return Ok(invalid(
                ProviderField::Key,
                "The key can hold only letters, digits and ASCII symbols, with no spaces.",
            ));
        }

        let previous = inner.saved.provider.as_ref();
        let storage = match (key, previous) {
            (Some(key), _) => match self.secrets.store(key, key_file) {
                Ok(storage) => storage,
                Err(SecretsError::NoKeychain) => return Ok(ProviderSaved::NoKeychain),
                Err(error) => return Err(secrets_error(error)),
            },
            (None, Some(previous)) if previous.base_url.origin() != base_url.origin() => {
                // The key belongs to the saved origin; it is deleted before the new origin is.
                self.secrets.remove(previous.key).map_err(secrets_error)?;
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
        inner.supersede_requests();
        let Some(provider) = inner.saved.provider.clone() else {
            return Ok(to_settings(&inner.saved));
        };
        self.secrets.remove(provider.key).map_err(secrets_error)?;
        let next = Saved {
            provider: Some(SavedProvider {
                key: KeyStorage::None,
                ..provider
            }),
            ..inner.saved.clone()
        };
        inner.save(next)
    }

    /// A request's first step, under the lock: AI is on and a provider is saved. It holds the
    /// provider generation and a copy of the provider.
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
        Ok(PreparedRequest {
            generation: inner.provider_generation,
            provider,
        })
    }

    /// The second step, without the lock, because a keychain may wait for an unlock prompt.
    pub fn read_key(&self, request: &PreparedRequest) -> Result<Option<String>, AppError> {
        self.secrets
            .read(request.provider.key)
            .map_err(secrets_error)
    }

    /// The third step: under the lock, unless the provider generation moved or AI is off since
    /// `request` was prepared, calls `start`, which starts the request and returns its abort, and
    /// stores that abort before anything else can take the lock. `start` may take the world and
    /// assistant locks; it returns `None` when it started nothing.
    pub fn start_request(
        &self,
        request: &PreparedRequest,
        start: impl FnOnce() -> Option<Abort>,
    ) -> Result<Option<RequestGuard>, Superseded> {
        let id = self.start_request_with(request, |_, _| start())?;
        Ok(id.map(|id| RequestGuard {
            inner: Arc::clone(&self.inner),
            id,
        }))
    }

    /// `start_request` with the state under the lock, and the stored request's id.
    fn start_request_with(
        &self,
        request: &PreparedRequest,
        start: impl FnOnce(&mut Inner, u64) -> Option<Abort>,
    ) -> Result<Option<u64>, Superseded> {
        let mut inner = self.lock();
        if inner.provider_generation != request.generation || !inner.saved.ai {
            return Err(Superseded);
        }
        let id = inner.next_request;
        inner.next_request += 1;
        let Some(abort) = start(&mut inner, id) else {
            return Ok(None);
        };
        inner.requests.push((id, abort));
        Ok(Some(id))
    }

    /// The test's first step, under the lock: AI is on, a provider is saved and no test runs.
    /// Marks the test as running; `end_test` clears the mark.
    fn begin_test(&self) -> Result<PendingTest, AppError> {
        let request = self.prepare_request()?;
        let mut inner = self.lock();
        if inner.test.running {
            return Err(AppError::new(
                ErrorKind::Conflict,
                "A connection test is already running.",
            ));
        }
        inner.test.running = true;
        Ok(PendingTest {
            generation: inner.test.generation,
            request,
        })
    }

    /// The test's second step, `read_key`.
    fn read_test_key(&self, test: &PendingTest) -> Result<Option<String>, TestOutcome> {
        self.read_key(&test.request).map_err(|error| {
            TestOutcome::failed(ProviderFailure::KeyUnreadable, Some(error.message))
        })
    }

    /// The third step, `start_request`: unless the test was abandoned meanwhile, starts the request
    /// and keeps the means to abort it before anything else can take the lock.
    fn start_test_request(
        &self,
        test: &PendingTest,
        key: Option<String>,
        timeout: Duration,
    ) -> Result<JoinHandle<TestOutcome>, TestOutcome> {
        let mut task = None;
        let started = self.start_request_with(&test.request, |inner, id| {
            if inner.test.generation != test.generation {
                return None;
            }
            inner.test.request = Some(id);
            let SavedProvider {
                base_url, model, ..
            } = test.request.provider.clone();
            let spawned = tauri::async_runtime::spawn(async move {
                providers::test(&base_url, &model, key.as_deref(), timeout).await
            });
            let abort = spawned.inner().abort_handle();
            task = Some(spawned);
            Some(Box::new(move || abort.abort()))
        });
        match (started, task) {
            (Ok(Some(_)), Some(task)) => Ok(task),
            _ => Err(TestOutcome::Cancelled),
        }
    }

    /// The second and third steps.
    fn launch_test(
        &self,
        test: &PendingTest,
        timeout: Duration,
    ) -> Result<JoinHandle<TestOutcome>, TestOutcome> {
        let key = self.read_test_key(test)?;
        self.start_test_request(test, key, timeout)
    }

    /// Ends the test that began with `generation`, however it ended. A test abandoned meanwhile
    /// is `Cancelled`, whatever its result.
    fn end_test(
        &self,
        generation: u64,
        result: Result<TestOutcome, AppError>,
    ) -> Result<TestOutcome, AppError> {
        let mut inner = self.lock();
        inner.test.running = false;
        if let Some(request) = inner.test.request.take() {
            inner.requests.retain(|(id, _)| *id != request);
        }
        if inner.test.generation != generation {
            return Ok(TestOutcome::Cancelled);
        }
        result
    }

    fn cancel_test(&self) {
        self.lock().cancel_test();
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }
}

/// Every change to the state is a whole value, so it stays consistent after a panic.
fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    /// Abandons a running test, and only the test: its request is aborted, and its result will be
    /// discarded.
    fn cancel_test(&mut self) {
        self.test.generation += 1;
        if let Some(request) = self.test.request.take()
            && let Some(at) = self.requests.iter().position(|(id, _)| *id == request)
        {
            let (_, abort) = self.requests.remove(at);
            abort();
        }
    }

    /// Abandons every provider request: none prepared so far starts, and each running one is
    /// aborted. A running test's result is discarded.
    fn supersede_requests(&mut self) {
        self.provider_generation += 1;
        self.test.generation += 1;
        self.test.request = None;
        for (_, abort) in mem::take(&mut self.requests) {
            abort();
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
    }
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

/// Sends one test request to the saved provider. Its steps run on the blocking pool, because a
/// save waiting for a keychain's unlock prompt holds the settings lock.
#[tauri::command]
pub async fn provider_test(app: AppHandle) -> Result<TestOutcome, AppError> {
    let test = blocking(app.clone(), |state| state.begin_test()).await?;
    let generation = test.generation;
    let launched = blocking(app.clone(), move |state| {
        Ok(state.launch_test(&test, providers::TIMEOUT))
    })
    .await;
    let result = match launched {
        // An aborted request ends as `Cancelled` in `end_test`, because its generation moved on.
        Ok(Ok(task)) => task.await.map_err(|_| internal()),
        Ok(Err(outcome)) => Ok(outcome),
        Err(error) => Err(error),
    };
    blocking(app, move |state| state.end_test(generation, result)).await
}

/// Abandons a running test, if any.
#[tauri::command]
pub async fn provider_test_cancel(app: AppHandle) -> Result<(), AppError> {
    blocking(app, |state| {
        state.cancel_test();
        Ok(())
    })
    .await
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
            json!({ "ai": true, "textProvider": null })
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

    /// The steps `provider_test` runs, without Tauri's blocking pool.
    fn run_test(state: &SettingsState) -> Result<TestOutcome, AppError> {
        let test = state.begin_test()?;
        let result = match state.launch_test(&test, TEST_TIMEOUT) {
            Ok(task) => block_on(task).map_err(|_| internal()),
            Err(outcome) => Ok(outcome),
        };
        state.end_test(test.generation, result)
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
            fixture.state.begin_test().err().unwrap().kind,
            ErrorKind::NotFound
        );

        let server = Server::silent();
        let fixture = saved_at(&server);
        // The first test is still reading its key.
        let first = fixture.state.begin_test().unwrap();
        assert_eq!(
            fixture.state.begin_test().err().unwrap().kind,
            ErrorKind::Conflict
        );
        // Its request is running.
        let task = fixture
            .state
            .launch_test(&first, TEST_TIMEOUT)
            .ok()
            .unwrap();
        assert_eq!(
            fixture.state.begin_test().err().unwrap().kind,
            ErrorKind::Conflict
        );

        fixture.state.set_ai(false).unwrap();
        let result = block_on(task).map_err(|_| internal());
        assert_eq!(
            fixture.state.end_test(first.generation, result).unwrap(),
            TestOutcome::Cancelled
        );
        assert_eq!(
            fixture.state.begin_test().err().unwrap().kind,
            ErrorKind::AiOff
        );
    }

    #[test]
    fn cancelling_saving_or_switching_ai_off_during_a_test_cancels_it() {
        for name in ["cancel", "save", "AI off"] {
            let server = Server::silent();
            let fixture = saved_at(&server);
            let test = fixture.state.begin_test().unwrap();
            let task = fixture.state.launch_test(&test, TEST_TIMEOUT).ok().unwrap();
            wait_for_request(&server);

            match name {
                "cancel" => fixture.state.cancel_test(),
                "save" => drop(fixture.save("https://example.com/v1", None).unwrap()),
                _ => drop(fixture.state.set_ai(false).unwrap()),
            }

            // The silent server would hold the request until its timeout; it was aborted.
            let result = block_on(task).map_err(|_| internal());
            assert!(result.is_err(), "{name}");
            assert_eq!(
                fixture.state.end_test(test.generation, result).unwrap(),
                TestOutcome::Cancelled,
                "{name}"
            );
            assert!(!fixture.state.lock().test.running, "{name}");
        }
    }

    #[test]
    fn a_test_cancelled_after_reading_its_key_sends_nothing() {
        let server = Server::answering(json_answer("200 OK", CHAT_REPLY));
        let fixture = saved_at(&server);
        let test = fixture.state.begin_test().unwrap();
        let key = fixture.state.read_test_key(&test).unwrap();

        fixture.state.cancel_test();

        let started = fixture.state.start_test_request(&test, key, TEST_TIMEOUT);
        assert_eq!(started.err(), Some(TestOutcome::Cancelled));
        assert_eq!(
            fixture
                .state
                .end_test(test.generation, Ok(TestOutcome::Cancelled))
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
        assert!(!fixture.state.lock().test.running);
    }

    /// Starts a request whose abort counts its calls in `aborted`.
    fn start_counted(
        state: &SettingsState,
        request: &PreparedRequest,
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
        let test = fixture.state.begin_test().unwrap();
        let task = fixture.state.launch_test(&test, TEST_TIMEOUT).ok().unwrap();

        fixture.state.cancel_test();

        assert!(block_on(task).is_err());
        assert_eq!(aborted.load(Ordering::SeqCst), 0);
        // The provider generation did not move, so an answer prepared before still starts.
        let started = start_counted(&fixture.state, &answer, &aborted).unwrap();
        assert!(started.is_some());
    }
}
