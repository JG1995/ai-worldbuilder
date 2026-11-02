//! The `secrets` area: where the text provider's API key is stored. It goes to the OS keychain
//! (Credential Manager on Windows, Keychain on macOS, the Secret Service on Linux) under one
//! entry, or, only when no keychain can be reached and the user agreed for that save, to the key
//! file `grimoire-data/keys.json`, `{ "format": 1, "textProvider": "<key>" }`, which only the
//! user's account can read.
//!
//! Only `read` returns the key, for the request that sends it. Nothing here formats or prints a
//! key, and nothing that holds one derives `Debug`.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use keyring_core::{CredentialStore, Entry, Error};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::data_file::write_atomically;

/// The keychain entry's service and user.
const SERVICE: &str = "io.github.jg1995.grimoire";
const USER: &str = "text-provider";
const KEY_FILE_FORMAT: u32 = 1;

/// Where the text provider's key is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum KeyStorage {
    /// The OS keychain.
    Keychain,
    /// The key file, which only the user's account can read.
    File,
    /// No key is stored.
    None,
}

/// Why a key could not be stored or removed. No variant holds the key or any part of it.
#[derive(Debug)]
pub enum SecretsError {
    /// No keychain service can be reached, so the store could not be built.
    NoKeychain,
    /// The keychain can be reached but refused or failed, for the plain reason given.
    Keychain(String),
    /// The key file could not be written or deleted.
    File(io::Error),
}

type StoreFactory = Box<dyn Fn() -> keyring_core::Result<Arc<CredentialStore>> + Send + Sync>;

/// The text provider's key in the keychain or the key file. The keychain's store is built on first
/// use and kept once that succeeds; a failure means no keychain can be reached, and the next
/// operation tries again.
pub struct Secrets {
    /// `grimoire-data/keys.json`; `None` without an app data folder.
    key_file: Option<PathBuf>,
    factory: StoreFactory,
    store: Mutex<Option<Arc<CredentialStore>>>,
}

impl Secrets {
    /// Keys in the platform's keychain, or in the key file in `data_folder`.
    pub fn new(data_folder: Option<&Path>) -> Self {
        Self::with_factory(data_folder, Box::new(platform_store))
    }

    fn with_factory(data_folder: Option<&Path>, factory: StoreFactory) -> Self {
        Self {
            key_file: data_folder.map(|folder| folder.join("keys.json")),
            factory,
            store: Mutex::new(None),
        }
    }

    /// Stores `key` in the keychain and deletes any key the key file holds. When no keychain can
    /// be reached, it writes the key file only with `file_consent`, and otherwise stores nothing
    /// and returns `NoKeychain`. A keychain that refuses never leads to the key file.
    pub fn store(&self, key: &str, file_consent: bool) -> Result<KeyStorage, SecretsError> {
        match self.entry() {
            Ok(entry) => {
                entry.set_password(key).map_err(keychain_error)?;
                self.delete_key_file()?;
                Ok(KeyStorage::Keychain)
            }
            Err(SecretsError::NoKeychain) if file_consent => {
                self.write_key_file(key)?;
                Ok(KeyStorage::File)
            }
            Err(error) => Err(error),
        }
    }

    /// Deletes the key from `storage`. A key that is already gone counts as deleted.
    pub fn remove(&self, storage: KeyStorage) -> Result<(), SecretsError> {
        match storage {
            KeyStorage::Keychain => match self.entry()?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(keychain_error(error)),
            },
            KeyStorage::File => self.delete_key_file(),
            KeyStorage::None => Ok(()),
        }
    }

    /// The key stored in `storage`, or `None` when none is stored. A key file that group or others
    /// can read is never used.
    pub fn read(&self, storage: KeyStorage) -> Result<Option<String>, SecretsError> {
        match storage {
            KeyStorage::Keychain => self
                .entry()?
                .get_password()
                .map(Some)
                .map_err(keychain_error),
            KeyStorage::File => self.read_key_file().map(Some),
            KeyStorage::None => Ok(None),
        }
    }

    /// The keychain entry of the text provider's key, building the store if it is not built yet.
    fn entry(&self) -> Result<Entry, SecretsError> {
        let mut store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        let built = match &*store {
            Some(built) => built.clone(),
            None => {
                let built = (self.factory)().map_err(|_| SecretsError::NoKeychain)?;
                store.insert(built).clone()
            }
        };
        built.build(SERVICE, USER, None).map_err(keychain_error)
    }

    fn write_key_file(&self, key: &str) -> Result<(), SecretsError> {
        let file = self.key_file.as_deref().ok_or_else(no_data_folder)?;
        let bytes = serde_json::to_vec_pretty(&json!({
            "format": KEY_FILE_FORMAT,
            "textProvider": key,
        }))
        .map_err(io::Error::other)
        .map_err(SecretsError::File)?;
        write_atomically(file, &bytes, true).map_err(SecretsError::File)
    }

    /// The key file's key. No reason quotes the file's content, which holds the key.
    fn read_key_file(&self) -> Result<String, SecretsError> {
        let path = self.key_file.as_deref().ok_or_else(no_data_folder)?;
        let mut file = File::open(path).map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => file_error("The key file is missing."),
            _ => SecretsError::File(error),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The open file's own mode, so it cannot change between the check and the read.
            let mode = file
                .metadata()
                .map_err(SecretsError::File)?
                .permissions()
                .mode();
            if mode & 0o077 != 0 {
                return Err(file_error(
                    "The key file is open to other users, so it is not used. Remove the key and save it again.",
                ));
            }
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(SecretsError::File)?;
        serde_json::from_slice::<KeyFile>(&bytes)
            .ok()
            .filter(|stored| stored.format == KEY_FILE_FORMAT)
            .map(|stored| stored.text_provider)
            .ok_or_else(|| file_error("The key file holds no key Grimoire.md can read."))
    }

    /// The key file holds only the text provider's key, so without it the file is deleted.
    fn delete_key_file(&self) -> Result<(), SecretsError> {
        let Some(file) = &self.key_file else {
            return Ok(());
        };
        match fs::remove_file(file) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(SecretsError::File(error)),
            _ => Ok(()),
        }
    }
}

/// The key file's content. It holds the key, so it derives no `Debug`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyFile {
    format: u32,
    text_provider: String,
}

fn file_error(reason: &str) -> SecretsError {
    SecretsError::File(io::Error::other(reason))
}

fn no_data_folder() -> SecretsError {
    SecretsError::File(io::Error::other(
        "The application has no data folder to keep the key file in.",
    ))
}

/// A plain reason for a keychain error. `BadEncoding` and `BadDataFormat` carry the stored bytes,
/// and `Ambiguous` entries whose debug text may show them, so those get a fixed reason, and no
/// keychain error is ever formatted with `Debug`.
fn keychain_error(error: Error) -> SecretsError {
    let reason = match error {
        Error::NoStorageAccess(cause) => {
            format!("The system keychain is locked or refused access ({cause}).")
        }
        Error::PlatformFailure(cause) => format!("The system keychain failed ({cause})."),
        Error::TooLong(..) => "The key is too long for the system keychain.".to_owned(),
        Error::BadEncoding(_) | Error::BadDataFormat(..) => {
            "The system keychain holds a key in a form Grimoire.md cannot read.".to_owned()
        }
        Error::NoEntry => "The system keychain holds no key.".to_owned(),
        Error::Invalid(..) | Error::BadStoreFormat(_) | Error::NotSupportedByStore(_) => {
            format!("The system keychain refused the request ({error}).")
        }
        _ => "The system keychain failed.".to_owned(),
    };
    SecretsError::Keychain(reason)
}

#[cfg(target_os = "linux")]
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    Ok(dbus_secret_service_keyring_store::Store::new()?)
}

#[cfg(target_os = "windows")]
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    Ok(windows_native_keyring_store::Store::new()?)
}

#[cfg(target_os = "macos")]
fn platform_store() -> keyring_core::Result<Arc<CredentialStore>> {
    Ok(apple_native_keyring_store::keychain::Store::new()?)
}

/// A mock keychain for the tests of this area and of `settings`. It never touches a real keychain.
#[cfg(test)]
pub mod test_support {
    use super::*;
    use keyring_core::api::CredentialStoreApi;
    use keyring_core::mock;

    pub const KEY: &str = "sk-test-0123456789";

    pub struct MockKeychain(Arc<mock::Store>);

    impl MockKeychain {
        pub fn new() -> Self {
            Self(mock::Store::new().unwrap())
        }

        /// Secrets that keep their keys in this keychain and in a key file in `data_folder`.
        pub fn secrets(&self, data_folder: Option<&Path>) -> Secrets {
            let store = self.0.clone();
            Secrets::with_factory(
                data_folder,
                Box::new(move || Ok(store.clone() as Arc<CredentialStore>)),
            )
        }

        /// Secrets whose keychain can never be reached.
        pub fn unreachable(data_folder: Option<&Path>) -> Secrets {
            Secrets::with_factory(data_folder, Box::new(unreachable_store))
        }

        /// The key stored in the text provider's entry.
        pub fn password(&self) -> keyring_core::Result<String> {
            self.entry().get_password()
        }

        /// Makes the entry's next call fail as a locked keychain does.
        pub fn fail_next_call(&self) {
            let entry = self.entry();
            let credential: &mock::Cred = entry.as_any().downcast_ref().unwrap();
            credential.set_error(Error::NoStorageAccess("locked".into()));
        }

        fn entry(&self) -> Entry {
            self.0.build(SERVICE, USER, None).unwrap()
        }
    }

    pub fn unreachable_store() -> keyring_core::Result<Arc<CredentialStore>> {
        Err(Error::PlatformFailure("no session bus".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{KEY, MockKeychain, unreachable_store};
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn key_file(folder: &tempfile::TempDir) -> PathBuf {
        folder.path().join("keys.json")
    }

    #[test]
    fn a_key_goes_to_the_keychain_and_is_removed_from_it() {
        let folder = tempfile::tempdir().unwrap();
        let keychain = MockKeychain::new();
        let secrets = keychain.secrets(Some(folder.path()));

        assert_eq!(secrets.store(KEY, false).unwrap(), KeyStorage::Keychain);
        assert_eq!(keychain.password().unwrap(), KEY);
        assert!(!key_file(&folder).exists());

        secrets.remove(KeyStorage::Keychain).unwrap();
        assert!(matches!(keychain.password(), Err(Error::NoEntry)));
        // A key that is already gone counts as deleted.
        secrets.remove(KeyStorage::Keychain).unwrap();
    }

    #[test]
    fn without_a_keychain_nothing_is_stored_unless_the_user_agreed_to_the_key_file() {
        let folder = tempfile::tempdir().unwrap();
        let secrets = MockKeychain::unreachable(Some(folder.path()));

        assert!(matches!(
            secrets.store(KEY, false),
            Err(SecretsError::NoKeychain)
        ));
        assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 0);

        assert_eq!(secrets.store(KEY, true).unwrap(), KeyStorage::File);
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(key_file(&folder)).unwrap()).unwrap();
        assert_eq!(stored, json!({ "format": 1, "textProvider": KEY }));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(key_file(&folder))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        secrets.remove(KeyStorage::File).unwrap();
        assert!(!key_file(&folder).exists());
        secrets.remove(KeyStorage::File).unwrap();
    }

    #[test]
    fn a_keychain_that_refuses_stores_nothing_and_never_falls_back_to_the_file() {
        let folder = tempfile::tempdir().unwrap();
        let keychain = MockKeychain::new();
        let secrets = keychain.secrets(Some(folder.path()));
        keychain.fail_next_call();

        let error = secrets.store(KEY, true).unwrap_err();

        let SecretsError::Keychain(reason) = error else {
            panic!("expected a keychain error, got {error:?}");
        };
        assert!(reason.contains("locked or refused"), "{reason}");
        assert!(!reason.contains(KEY));
        assert!(keychain.password().is_err());
        assert!(!key_file(&folder).exists());
    }

    #[test]
    fn a_failed_keychain_removal_is_reported() {
        let keychain = MockKeychain::new();
        let secrets = keychain.secrets(None);
        secrets.store(KEY, false).unwrap();
        keychain.fail_next_call();

        assert!(matches!(
            secrets.remove(KeyStorage::Keychain),
            Err(SecretsError::Keychain(_))
        ));
        assert_eq!(keychain.password().unwrap(), KEY);
    }

    #[test]
    fn a_keychain_save_deletes_the_key_file() {
        let folder = tempfile::tempdir().unwrap();
        let keychain = MockKeychain::new();
        let reachable = Arc::new(AtomicBool::new(false));
        let gate = reachable.clone();
        let later = keychain.secrets(None);
        // Unreachable until `reachable` is set, then the mock keychain.
        let secrets = Secrets::with_factory(
            Some(folder.path()),
            Box::new(move || {
                if gate.load(Ordering::SeqCst) {
                    (later.factory)()
                } else {
                    unreachable_store()
                }
            }),
        );
        assert_eq!(secrets.store(KEY, true).unwrap(), KeyStorage::File);

        // The keychain can be reached now, and the store built after the earlier failure is used.
        reachable.store(true, Ordering::SeqCst);
        assert_eq!(
            secrets.store("sk-new", false).unwrap(),
            KeyStorage::Keychain
        );

        assert_eq!(keychain.password().unwrap(), "sk-new");
        assert!(!key_file(&folder).exists());
    }

    #[test]
    fn a_stored_key_is_read_back_from_the_keychain_and_the_key_file() {
        let folder = tempfile::tempdir().unwrap();
        let keychain = MockKeychain::new();
        let secrets = keychain.secrets(Some(folder.path()));
        secrets.store(KEY, false).unwrap();
        let file_only = MockKeychain::unreachable(Some(folder.path()));
        file_only.store("sk-in-file", true).unwrap();

        assert_eq!(
            secrets.read(KeyStorage::Keychain).unwrap().as_deref(),
            Some(KEY)
        );
        assert_eq!(
            secrets.read(KeyStorage::File).unwrap().as_deref(),
            Some("sk-in-file")
        );
        assert_eq!(secrets.read(KeyStorage::None).unwrap(), None);
    }

    #[test]
    fn a_key_that_cannot_be_read_gives_a_reason_without_the_key() {
        let folder = tempfile::tempdir().unwrap();
        let keychain = MockKeychain::new();
        let secrets = keychain.secrets(Some(folder.path()));

        let SecretsError::Keychain(reason) = secrets.read(KeyStorage::Keychain).unwrap_err() else {
            panic!("expected a keychain error");
        };
        assert_eq!(reason, "The system keychain holds no key.");
        let SecretsError::File(error) = secrets.read(KeyStorage::File).unwrap_err() else {
            panic!("expected a file error");
        };
        assert_eq!(error.to_string(), "The key file is missing.");
        assert!(matches!(
            MockKeychain::unreachable(None).read(KeyStorage::Keychain),
            Err(SecretsError::NoKeychain)
        ));

        // A key file that holds the key in a form it cannot use never quotes it.
        fs::write(key_file(&folder), json!({ "format": KEY }).to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(key_file(&folder), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let SecretsError::File(error) = secrets.read(KeyStorage::File).unwrap_err() else {
            panic!("expected a file error");
        };
        assert!(!error.to_string().contains(KEY), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn a_key_file_open_to_other_users_is_not_used() {
        use std::os::unix::fs::PermissionsExt;
        let folder = tempfile::tempdir().unwrap();
        let secrets = MockKeychain::unreachable(Some(folder.path()));
        secrets.store(KEY, true).unwrap();
        fs::set_permissions(key_file(&folder), fs::Permissions::from_mode(0o644)).unwrap();

        let SecretsError::File(error) = secrets.read(KeyStorage::File).unwrap_err() else {
            panic!("expected a file error");
        };

        assert!(error.to_string().contains("open to other users"), "{error}");
    }

    /// Stores, finds and deletes a key in the real platform keychain, under a service of its own.
    /// It may ask to unlock the keychain. Run by name only.
    #[test]
    #[ignore = "uses the real platform keychain"]
    fn platform_keychain_round_trip() {
        let store = platform_store().expect("a keychain can be reached");
        let entry = store
            .build("io.github.jg1995.grimoire.test", USER, None)
            .unwrap();

        entry.set_password("grimoire-round-trip").unwrap();
        let found = store
            .build("io.github.jg1995.grimoire.test", USER, None)
            .unwrap()
            .get_password();
        entry.delete_credential().unwrap();

        assert_eq!(found.unwrap(), "grimoire-round-trip");
        assert!(matches!(entry.get_password(), Err(Error::NoEntry)));
    }

    /// With no session bus, as when run with `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent`,
    /// the production store cannot be built, which is `NoKeychain`. Run by name only.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "needs an environment without a reachable Secret Service"]
    fn platform_store_unreachable() {
        // Only builds the entry, so it never writes to a keychain that turns out to be reachable.
        let secrets = Secrets::new(None);

        assert!(matches!(secrets.entry(), Err(SecretsError::NoKeychain)));
    }
}
