//! The folder picker, shown by the core so the webview never supplies an absolute path.

use std::path::PathBuf;

use rfd::AsyncFileDialog;
use tauri::{AppHandle, Manager};

/// Shows the system's folder dialog over the main window, starting in `start` when given, and
/// returns the picked folder, or `None` when the user cancels.
///
/// The dialog is built on the main thread, which GTK and the other platform toolkits require, and
/// awaited off it, so the event loop keeps running. This follows `pick_folder` in
/// `tauri-plugin-dialog` 2.8.4 (`src/desktop.rs`).
pub async fn pick_folder(app: &AppHandle, start: Option<PathBuf>) -> Option<PathBuf> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let main = app.clone();
    let built = app.run_on_main_thread(move || {
        let mut dialog = AsyncFileDialog::new().set_title("Open world");
        if let Some(start) = start {
            dialog = dialog.set_directory(start);
        }
        if let Some(window) = main.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        // The receiver waits for this one message, so the channel has room for it.
        let _ = sender.try_send(dialog.pick_folder());
    });
    // Without a running event loop no dialog can show, which is the same outcome as a cancel.
    built.ok()?;
    let picked = receiver.recv().await?.await?;
    Some(picked.path().to_path_buf())
}
