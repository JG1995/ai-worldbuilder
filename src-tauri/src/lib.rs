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
            world::page_create,
            world::folder_create,
            world::world_new_location,
            world::world_new_browse,
            world::world_create,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
