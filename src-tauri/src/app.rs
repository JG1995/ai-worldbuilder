use serde::Serialize;
use tauri::{AppHandle, PackageInfo};

use crate::error::{AppError, guard};

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

impl From<&PackageInfo> for AppInfo {
    fn from(package: &PackageInfo) -> Self {
        Self {
            name: package.name.clone(),
            version: package.version.to_string(),
        }
    }
}

/// Reports the product name and version from the Tauri configuration.
#[tauri::command]
pub fn app_info(app: AppHandle) -> Result<AppInfo, AppError> {
    guard(|| Ok(AppInfo::from(app.package_info())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn app_info_serializes_to_name_and_version() {
        let info = AppInfo {
            name: "Grimoire.md".to_owned(),
            version: "0.1.0".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({ "name": "Grimoire.md", "version": "0.1.0" })
        );
    }
}
