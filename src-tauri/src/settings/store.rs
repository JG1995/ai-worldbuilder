//! The settings file, `grimoire-data/settings.json`:
//! `{ "format": 1, "ai": true, "textProvider": { "baseUrl", "model", "key" } | null,
//! "imageProvider": { "model", "key" } | null }`, where each `key` says where that provider's key
//! is stored (`keychain`, `file` or `none`), never the key itself. A file without `imageProvider`,
//! as earlier versions wrote, loads with no image provider.
//!
//! A missing or unreadable file, one in another format, or one whose base URL breaks the rules
//! loads as the defaults (AI on, no provider) and is replaced on the next save.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::data_file::write_atomically;
use crate::providers::BaseUrl;
use crate::secrets::KeyStorage;

const FORMAT: u32 = 1;

/// The saved settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    pub ai: bool,
    pub provider: Option<SavedProvider>,
    pub image: Option<SavedImageProvider>,
}

impl Default for Saved {
    fn default() -> Self {
        Self {
            ai: true,
            provider: None,
            image: None,
        }
    }
}

/// The saved text provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedProvider {
    pub base_url: BaseUrl,
    pub model: String,
    pub key: KeyStorage,
}

/// The saved image provider, whose requests always go to OpenRouter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedImageProvider {
    pub model: String,
    pub key: KeyStorage,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    format: u32,
    ai: bool,
    text_provider: Option<StoredProvider>,
    #[serde(default)]
    image_provider: Option<SavedImageProvider>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProvider {
    base_url: String,
    model: String,
    key: KeyStorage,
}

/// The settings in `file`, or the defaults.
pub fn load(file: &Path) -> Saved {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Document>(&bytes).ok())
        .filter(|document| document.format == FORMAT)
        .and_then(|document| {
            let provider = match document.text_provider {
                Some(stored) => Some(SavedProvider {
                    base_url: BaseUrl::parse(&stored.base_url).ok()?,
                    model: stored.model,
                    key: stored.key,
                }),
                None => None,
            };
            Some(Saved {
                ai: document.ai,
                provider,
                image: document.image_provider,
            })
        })
        .unwrap_or_default()
}

/// Replaces `file` with `saved` in one step.
pub fn save(file: &Path, saved: &Saved) -> io::Result<()> {
    let document = Document {
        format: FORMAT,
        ai: saved.ai,
        text_provider: saved.provider.as_ref().map(|provider| StoredProvider {
            base_url: provider.base_url.as_str().to_owned(),
            model: provider.model.clone(),
            key: provider.key,
        }),
        image_provider: saved.image.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(io::Error::other)?;
    write_atomically(file, &bytes, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn provider() -> SavedProvider {
        SavedProvider {
            base_url: BaseUrl::parse("https://openrouter.ai/api/v1").unwrap(),
            model: "anthropic/claude-sonnet-4.5".into(),
            key: KeyStorage::Keychain,
        }
    }

    #[test]
    fn settings_are_saved_in_their_format_and_load_again() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("grimoire-data").join("settings.json");
        let saved = Saved {
            ai: false,
            provider: Some(provider()),
            image: Some(SavedImageProvider {
                model: "google/gemini-2.5-flash-image".into(),
                key: KeyStorage::File,
            }),
        };

        save(&file, &saved).unwrap();

        let document: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            document,
            json!({
                "format": 1,
                "ai": false,
                "textProvider": {
                    "baseUrl": "https://openrouter.ai/api/v1",
                    "model": "anthropic/claude-sonnet-4.5",
                    "key": "keychain",
                },
                "imageProvider": {
                    "model": "google/gemini-2.5-flash-image",
                    "key": "file",
                },
            })
        );
        assert_eq!(load(&file), saved);
    }

    #[test]
    fn a_file_without_an_image_provider_loads_with_none() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("settings.json");
        fs::write(
            &file,
            br#"{ "format": 1, "ai": false, "textProvider": { "baseUrl": "https://openrouter.ai/api/v1", "model": "anthropic/claude-sonnet-4.5", "key": "keychain" } }"#,
        )
        .unwrap();

        assert_eq!(
            load(&file),
            Saved {
                ai: false,
                provider: Some(provider()),
                image: None,
            }
        );
    }

    #[test]
    fn a_missing_unreadable_or_unknown_file_loads_as_the_defaults() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("settings.json");
        assert_eq!(load(&file), Saved::default());
        assert!(Saved::default().ai);

        for content in [
            b"\xff\xfe not text".as_slice(),
            b"{ \"format\": 1, \"ai\": ",
            br#"{ "format": 2, "ai": false, "textProvider": null }"#,
            br#"{ "format": 1, "ai": "off", "textProvider": null }"#,
            br#"{ "format": 1, "ai": false, "textProvider": { "baseUrl": "http://example.com", "model": "m", "key": "none" } }"#,
        ] {
            fs::write(&file, content).unwrap();
            assert_eq!(load(&file), Saved::default(), "{content:?}");
        }

        save(&file, &Saved::default()).unwrap();
        let document: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(
            document,
            json!({ "format": 1, "ai": true, "textProvider": null, "imageProvider": null })
        );
    }
}
