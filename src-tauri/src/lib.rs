mod error;
mod history;
#[cfg(target_os = "linux")]
mod theme;
mod world;

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use error::{AppError, ErrorKind, guard};

const MAIN_WINDOW: &str = "main";
/// Tells the interface that the user asked to close the window while a world is open.
const CLOSE_REQUESTED: &str = "app:close-requested";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch hands over to this instance before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(world::WorldState::default())
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Some(theme) = theme::fallback() {
                app.set_theme(Some(theme));
            }
            let state = app.state::<world::WorldState>();
            // Without an app data folder, the recent list stays empty and is never saved.
            if let Ok(folder) = app.path().app_data_dir() {
                state.load_recent(&folder);
            }
            let handle = app.handle().clone();
            // An event the webview cannot take changes nothing in the core.
            state.set_events(Arc::new(move |event: world::WorldEvent| {
                let _ = handle.emit(event.name(), &event);
            }));
            Ok(())
        })
        .on_window_event(|window, event| {
            // With a world open, the interface saves first and then calls `app_close`. With none,
            // the window closes at once.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() == MAIN_WINDOW
                && window.state::<world::WorldState>().is_open()
            {
                api.prevent_close();
                let _ = window.emit(CLOSE_REQUESTED, ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_close,
            world::world_open,
            world::world_close,
            world::world_tree,
            world::page_read,
            world::page_write,
            world::page_compare,
            world::page_restore,
            world::page_create,
            world::folder_create,
            world::world_new_location,
            world::world_new_browse,
            world::world_create,
            world::recent_list,
            world::recent_remove,
            world::world_open_recent,
            world::world_restore,
            world::workspace_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Closes the window once the interface has saved; `core:default` does not let the webview do it.
#[tauri::command]
async fn app_close(app: AppHandle) -> Result<(), AppError> {
    guard(|| {
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return Ok(());
        };
        window
            .destroy()
            .map_err(|_| AppError::new(ErrorKind::Internal, "The window cannot be closed."))
    })
}

/// Brings the window to the front when the application is launched a second time.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
