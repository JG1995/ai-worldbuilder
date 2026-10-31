mod error;
mod world;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(world::WorldState::default())
        .invoke_handler(tauri::generate_handler![
            world::world_open,
            world::world_close,
            world::world_tree,
            world::page_read,
            world::page_write,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
