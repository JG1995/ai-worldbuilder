mod assistant;
mod data_file;
mod error;
mod history;
mod index;
mod order;
mod providers;
mod secrets;
mod settings;
#[cfg(target_os = "linux")]
mod theme;
mod web;
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
        .manage(assistant::AssistantState::default())
        // Each image request is answered on a worker thread, so reading a file never blocks the
        // webview. A stored image of the assistant's goes to the assistant, every other request
        // to the world.
        .register_asynchronous_uri_scheme_protocol(
            world::IMAGE_SCHEME,
            |context, request, responder| {
                let app = context.app_handle().clone();
                let uri = request.uri().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let response = match assistant::is_stored_image(&uri) {
                        true => assistant::respond_image(&app, &uri),
                        false => world::respond_image(&app.state::<world::WorldState>(), &uri),
                    };
                    responder.respond(response);
                });
            },
        )
        .setup(|app| {
            #[cfg(target_os = "linux")]
            if let Some(theme) = theme::fallback() {
                app.set_theme(Some(theme));
            }
            let app_data = app.path().app_data_dir().ok();
            // Without an app data folder, the settings are the defaults and are never saved.
            app.manage(settings::SettingsState::load(app_data.as_deref()));
            let state = app.state::<world::WorldState>();
            // Without an app data folder, the recent list stays empty and is never saved.
            if let Some(folder) = &app_data {
                state.load_recent(folder);
            }
            let handle = app.handle().clone();
            // An event the webview cannot take changes nothing in the core.
            state.set_events(Arc::new(move |event: world::WorldEvent| {
                let _ = handle.emit(event.name(), &event);
            }));
            let handle = app.handle().clone();
            app.state::<assistant::AssistantState>()
                .set_image_events(Arc::new(move |changed: assistant::ImageChanged| {
                    let _ = handle.emit(assistant::IMAGE_CHANGED, changed);
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
            web::link_open,
            world::world_open,
            world::world_close,
            world::world_tree,
            world::page_read,
            world::page_write,
            world::page_compare,
            world::page_restore,
            world::page_properties,
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
            world::history_list,
            world::history_compare,
            world::history_restore,
            world::history_undo,
            world::backlinks_list,
            world::links_in,
            world::images_resolve,
            world::link_create,
            world::link_suggest,
            world::search_pages,
            world::search_text,
            world::search_create,
            settings::settings_get,
            settings::settings_ai_set,
            settings::provider_save,
            settings::provider_key_remove,
            settings::provider_test,
            settings::provider_test_cancel,
            settings::image_provider_save,
            settings::image_provider_key_remove,
            settings::image_provider_test,
            settings::image_provider_test_cancel,
            assistant::assistant_send,
            assistant::assistant_stop,
            assistant::assistant_links,
            assistant::assistant_conversations,
            assistant::assistant_conversation,
            assistant::assistant_delete,
            assistant::assistant_review,
            assistant::assistant_accept,
            assistant::assistant_reject,
            assistant::assistant_undo,
            assistant::assistant_images,
            assistant::assistant_image_generate,
            assistant::assistant_image_cancel,
            assistant::assistant_image_reject,
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
