//! The `world` area: the open world and the commands that browse and read it.

mod dialog;
mod page;
mod paths;
mod tree;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, ErrorKind, guard};
use page::PageText;
use tree::TreeEntry;

const APP_TITLE: &str = "Grimoire.md";
/// The file tree's default width in pixels, as in `src/ui/Shell.tsx`.
const DEFAULT_TREE_WIDTH: u32 = 264;

/// The open world, if any, managed by Tauri.
#[derive(Default)]
pub struct WorldState {
    world: Mutex<Option<OpenWorld>>,
    sessions: AtomicU64,
}

struct OpenWorld {
    root: PathBuf,
}

/// The result of opening a world.
#[derive(Debug, Serialize)]
pub struct WorldOpened {
    name: String,
    /// Increases with every open, so the interface can tell one opening from the next.
    session: u64,
    workspace: Workspace,
}

/// The open tabs, expanded folders and tree width to show. Nothing is stored yet, so a world
/// always opens with none and the default width.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    tabs: Vec<String>,
    active: Option<String>,
    expanded: Vec<String>,
    tree_width: u32,
}

impl WorldState {
    /// Opens the folder at `root`, replacing the open world, unless the folder cannot be read.
    fn open(&self, root: PathBuf) -> Result<WorldOpened, AppError> {
        fs::read_dir(&root)?;
        let name = root.file_name().map_or_else(
            || root.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
        let session = self.sessions.fetch_add(1, Ordering::Relaxed) + 1;
        *self.lock() = Some(OpenWorld { root });
        Ok(WorldOpened {
            name,
            session,
            workspace: Workspace {
                tabs: Vec::new(),
                active: None,
                expanded: Vec::new(),
                tree_width: DEFAULT_TREE_WIDTH,
            },
        })
    }

    fn close(&self) {
        *self.lock() = None;
    }

    /// The folder that holds the open world, where the folder dialog starts.
    fn parent_folder(&self) -> Option<PathBuf> {
        let world = self.lock();
        world.as_ref()?.root.parent().map(PathBuf::from)
    }

    fn tree(&self) -> Result<Vec<TreeEntry>, AppError> {
        tree::list(&self.root()?)
    }

    fn read_page(&self, path: &str) -> Result<PageText, AppError> {
        page::read(&paths::existing_page(&self.root()?, path)?)
    }

    fn root(&self) -> Result<PathBuf, AppError> {
        let world = self.lock();
        let world = world
            .as_ref()
            .ok_or_else(|| AppError::new(ErrorKind::NoWorld, "No world is open."))?;
        Ok(world.root.clone())
    }

    /// The state stays consistent after a panic, because every change replaces it whole.
    fn lock(&self) -> MutexGuard<'_, Option<OpenWorld>> {
        self.world.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Shows the folder dialog and opens the picked folder as the world. Cancelling returns `null`.
#[tauri::command]
pub async fn world_open(
    app: AppHandle,
    state: State<'_, WorldState>,
) -> Result<Option<WorldOpened>, AppError> {
    let start = guard(|| Ok(state.parent_folder()))?;
    let Some(folder) = dialog::pick_folder(&app, start).await else {
        return Ok(None);
    };
    guard(|| {
        let opened = state.open(folder)?;
        set_title(&app, &format!("{} — {APP_TITLE}", opened.name));
        Ok(Some(opened))
    })
}

#[tauri::command]
pub async fn world_close(app: AppHandle, state: State<'_, WorldState>) -> Result<(), AppError> {
    guard(|| {
        state.close();
        set_title(&app, APP_TITLE);
        Ok(())
    })
}

#[tauri::command]
pub async fn world_tree(state: State<'_, WorldState>) -> Result<Vec<TreeEntry>, AppError> {
    guard(|| state.tree())
}

#[tauri::command]
pub async fn page_read(state: State<'_, WorldState>, path: String) -> Result<PageText, AppError> {
    guard(|| state.read_page(&path))
}

/// The core sets the title, because `core:default` does not let the webview do it. A title that
/// cannot be set changes nothing else, so the command still succeeds.
fn set_title(app: &AppHandle, title: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(title);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::SystemTime;
    use tempfile::TempDir;

    fn world() -> TempDir {
        let world = tempfile::tempdir().unwrap();
        fs::create_dir(world.path().join("Places")).unwrap();
        fs::write(
            world.path().join("Places/Saltmere.md"),
            "\u{feff}# Saltmere\r\n",
        )
        .unwrap();
        fs::write(world.path().join("map.png"), [0u8, 1, 2]).unwrap();
        world
    }

    #[test]
    fn opening_returns_the_folder_name_a_new_session_and_the_default_workspace() {
        let state = WorldState::default();
        let world = world();

        let first = state.open(world.path().to_path_buf()).unwrap();
        let second = state.open(world.path().to_path_buf()).unwrap();

        assert_eq!(second.session, first.session + 1);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            json!({
                "name": world.path().file_name().unwrap().to_str().unwrap(),
                "session": first.session,
                "workspace": { "tabs": [], "active": null, "expanded": [], "treeWidth": 264 },
            })
        );
    }

    #[test]
    fn a_folder_that_cannot_be_read_is_refused_and_the_open_world_stays() {
        let state = WorldState::default();
        let world = world();
        state.open(world.path().to_path_buf()).unwrap();

        let error = state.open(world.path().join("gone")).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Io);
        assert_eq!(state.root().unwrap(), world.path());
    }

    #[test]
    fn commands_need_an_open_world() {
        let state = WorldState::default();
        let world = world();
        state.open(world.path().to_path_buf()).unwrap();
        state.close();

        assert_eq!(state.tree().unwrap_err().kind, ErrorKind::NoWorld);
        assert_eq!(
            state.read_page("Places/Saltmere.md").unwrap_err().kind,
            ErrorKind::NoWorld
        );
    }

    #[test]
    fn opening_listing_and_reading_change_nothing_on_disk() {
        let state = WorldState::default();
        let world = world();
        let snapshot = |root: &std::path::Path| -> Vec<(PathBuf, Vec<u8>, SystemTime)> {
            ["Places/Saltmere.md", "map.png"]
                .iter()
                .map(|file| {
                    let path = root.join(file);
                    let modified = fs::metadata(&path).unwrap().modified().unwrap();
                    (path.clone(), fs::read(&path).unwrap(), modified)
                })
                .collect()
        };
        let before = snapshot(world.path());

        state.open(world.path().to_path_buf()).unwrap();
        let tree = state.tree().unwrap();
        let page = state
            .read_page(&tree[0].children.as_ref().unwrap()[0].path)
            .unwrap();

        assert_eq!(page.text, "# Saltmere\n");
        assert_eq!(snapshot(world.path()), before);
        assert_eq!(fs::read_dir(world.path()).unwrap().count(), 2);
    }
}
