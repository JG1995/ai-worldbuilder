//! Dark mode for a Linux desktop with no colour preference. Tauri reads the desktop portal's "no
//! preference" as light, and the webview's `prefers-color-scheme` follows it. Windows and macOS
//! always report light or dark.

use std::time::Duration;

use dbus::{arg::Variant, blocking::Connection};
use tauri::Theme;

/// The theme to set at launch: dark when the portal reports no preference or cannot be asked, and
/// none when it reports light or dark, which the window already follows.
pub fn fallback() -> Option<Theme> {
    fallback_for(portal_color_scheme())
}

fn fallback_for(color_scheme: Option<u32>) -> Option<Theme> {
    match color_scheme {
        Some(1 | 2) => None,
        _ => Some(Theme::Dark),
    }
}

/// The portal's `color-scheme`: 0 for no preference, 1 for dark and 2 for light.
fn portal_color_scheme() -> Option<u32> {
    let connection = Connection::new_session().ok()?;
    let portal = connection.with_proxy(
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        Duration::from_secs(1),
    );
    let (value,): (Variant<Variant<u32>>,) = portal
        .method_call(
            "org.freedesktop.portal.Settings",
            "Read",
            ("org.freedesktop.appearance", "color-scheme"),
        )
        .ok()?;
    Some(value.0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_no_preference_falls_back_to_dark() {
        assert_eq!(fallback_for(Some(0)), Some(Theme::Dark));
        assert_eq!(fallback_for(None), Some(Theme::Dark));
        assert_eq!(fallback_for(Some(1)), None);
        assert_eq!(fallback_for(Some(2)), None);
    }
}
