//! The `settings` area: the application's settings, the AI switch and the saved text provider,
//! and the commands that read and change them. The provider's key goes through `secrets`, and its
//! base URL's rules come from `providers`.
//!
//! The commands run one at a time under the settings lock, held for the whole operation, keychain
//! calls included. Each runs on Tauri's blocking pool, because a keychain may wait for the user to
//! answer an unlock prompt.

mod store;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{AppError, ErrorKind, guard};
use crate::providers::BaseUrl;
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
    inner: Mutex<Inner>,
    /// Beside the settings lock, so that reading a key never needs it.
    secrets: Arc<Secrets>,
}

struct Inner {
    saved: Saved,
    /// `grimoire-data/settings.json`; `None` without an app data folder, and then nothing saves.
    file: Option<PathBuf>,
}

impl SettingsState {
    /// The settings kept in `app_data_dir`, with keys in the platform's keychain.
    pub fn load(app_data_dir: Option<&Path>) -> Self {
        let folder = app_data_dir.map(|dir| dir.join("grimoire-data"));
        Self::with_secrets(folder.as_deref(), Secrets::new(folder.as_deref()))
    }

    fn with_secrets(data_folder: Option<&Path>, secrets: Secrets) -> Self {
        let file = data_folder.map(|folder| folder.join("settings.json"));
        let saved = file.as_deref().map(store::load).unwrap_or_default();
        Self {
            inner: Mutex::new(Inner { saved, file }),
            secrets: Arc::new(secrets),
        }
    }

    fn get(&self) -> Settings {
        to_settings(&self.lock().saved)
    }

    fn set_ai(&self, on: bool) -> Result<Settings, AppError> {
        let mut inner = self.lock();
        let next = Saved {
            ai: on,
            ..inner.saved.clone()
        };
        inner.save(next)
    }

    /// Checks the fields, stores a typed key, or removes the stored key when the origin changes
    /// without one, and only then writes the settings file.
    fn save_provider(
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
    fn remove_key(&self) -> Result<Settings, AppError> {
        let mut inner = self.lock();
        if !inner.saved.ai {
            return Err(ai_off());
        }
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

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every change to the state is a whole value, so it stays consistent after a panic.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Inner {
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

fn ai_off() -> AppError {
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
        .unwrap_or_else(|_| {
            Err(AppError::new(
                ErrorKind::Internal,
                "An unexpected internal error occurred.",
            ))
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::test_support::{KEY, MockKeychain};
    use serde_json::json;
    use std::fs;
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
}
