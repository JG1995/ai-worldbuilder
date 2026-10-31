//! The `world` area: the open world and the commands that browse, read, save and create in it.

mod dialog;
mod names;
mod page;
mod paths;
mod tree;
mod write;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, ErrorKind, guard};
use page::PageText;
use tree::TreeEntry;
use write::{NewEntry, PageVersion};

const APP_TITLE: &str = "Grimoire.md";
/// The file tree's default width in pixels, as in `src/ui/Shell.tsx`.
const DEFAULT_TREE_WIDTH: u32 = 264;

/// The open world, if any, and what New world needs, managed by Tauri.
#[derive(Default)]
pub struct WorldState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    world: Option<OpenWorld>,
    /// The session of the latest opening. It changes together with `world`, under one lock, so a
    /// session number always names the world it was given with.
    session: u64,
    /// The folder of the world opened most recently in this session, open or not.
    last_opened: Option<PathBuf>,
    /// The folder New world creates its folder in, once the user has picked one with Browse….
    new_location: Option<PathBuf>,
}

struct OpenWorld {
    root: PathBuf,
}

/// Where New world will create its folder, as a path to show.
#[derive(Debug, Serialize)]
pub struct NewLocation {
    location: String,
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
        let session = {
            let mut inner = self.lock();
            inner.session += 1;
            inner.last_opened = Some(root.clone());
            inner.world = Some(OpenWorld { root });
            inner.session
        };
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
        self.lock().world = None;
    }

    /// The folder that holds the open world, where the folder dialog starts.
    fn parent_folder(&self) -> Option<PathBuf> {
        let inner = self.lock();
        inner.world.as_ref()?.root.parent().map(PathBuf::from)
    }

    /// Forgets a location picked with Browse…, so New world starts again from the default.
    fn reset_new_location(&self) {
        self.lock().new_location = None;
    }

    fn set_new_location(&self, location: PathBuf) {
        self.lock().new_location = Some(location);
    }

    /// Where New world creates its folder: the folder picked with Browse…, otherwise the parent of
    /// the world opened most recently in this session, otherwise `fallback`, the user's Documents
    /// or home folder.
    fn new_location(
        &self,
        fallback: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<PathBuf, AppError> {
        let picked_or_recent = {
            let inner = self.lock();
            inner.new_location.clone().or_else(|| {
                let last = inner.last_opened.as_ref()?;
                last.parent().map(PathBuf::from)
            })
        };
        picked_or_recent.or_else(fallback).ok_or_else(|| {
            AppError::new(
                ErrorKind::Io,
                "No Documents or home folder was found for the new world.",
            )
        })
    }

    /// Creates the new world's folder at the location and opens it.
    fn create(
        &self,
        name: &str,
        fallback: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<WorldOpened, AppError> {
        let root = write::create_world(&self.new_location(fallback)?, name)?;
        self.open(root)
    }

    /// Holds the world lock while the entry is created, so it never overlaps a write.
    fn create_entry(
        &self,
        create: impl FnOnce(&Path) -> Result<NewEntry, AppError>,
    ) -> Result<NewEntry, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        create(&world.root)
    }

    fn tree(&self) -> Result<Vec<TreeEntry>, AppError> {
        tree::list(&self.root()?)
    }

    fn read_page(&self, path: &str) -> Result<PageText, AppError> {
        page::read(&paths::existing_page(&self.root()?, path)?)
    }

    /// Holds the world lock for the whole write, so writes never overlap.
    fn write_page(&self, path: &str, text: &str, version: &str) -> Result<PageVersion, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        write::write_page(&world.root, path, text, version)
    }

    fn root(&self) -> Result<PathBuf, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        Ok(world.root.clone())
    }

    /// The state stays consistent after a panic, because every change to it is a whole field.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
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

/// Saves the editor's text to a page if the page still has the bytes of `version`, and returns the
/// version of the bytes it now has.
#[tauri::command]
pub async fn page_write(
    state: State<'_, WorldState>,
    path: String,
    text: String,
    version: String,
) -> Result<PageVersion, AppError> {
    guard(|| state.write_page(&path, &text, &version))
}

/// Creates an empty page `{name}.md` in `folder`, or at the world's top level when it is `null`.
#[tauri::command]
pub async fn page_create(
    state: State<'_, WorldState>,
    folder: Option<String>,
    name: String,
) -> Result<NewEntry, AppError> {
    guard(|| state.create_entry(|root| write::create_page(root, folder.as_deref(), &name)))
}

/// Creates an empty folder `name` in `folder`, or at the world's top level when it is `null`.
#[tauri::command]
pub async fn folder_create(
    state: State<'_, WorldState>,
    folder: Option<String>,
    name: String,
) -> Result<NewEntry, AppError> {
    guard(|| state.create_entry(|root| write::create_folder(root, folder.as_deref(), &name)))
}

/// Starts a New world dialog: forgets any location picked before and returns the default one.
#[tauri::command]
pub async fn world_new_location(
    app: AppHandle,
    state: State<'_, WorldState>,
) -> Result<NewLocation, AppError> {
    guard(|| {
        state.reset_new_location();
        Ok(display(&state.new_location(|| standard_folder(&app))?))
    })
}

/// Shows the folder dialog at the new world's location and keeps the folder the user picks.
/// Cancelling returns `null` and keeps the location.
#[tauri::command]
pub async fn world_new_browse(
    app: AppHandle,
    state: State<'_, WorldState>,
) -> Result<Option<NewLocation>, AppError> {
    let start = guard(|| Ok(state.new_location(|| standard_folder(&app)).ok()))?;
    let Some(folder) = dialog::pick_folder(&app, start).await else {
        return Ok(None);
    };
    guard(|| {
        let location = display(&folder);
        state.set_new_location(folder);
        Ok(Some(location))
    })
}

/// Creates an empty folder `name` at the new world's location and opens it as the world.
#[tauri::command]
pub async fn world_create(
    app: AppHandle,
    state: State<'_, WorldState>,
    name: String,
) -> Result<WorldOpened, AppError> {
    guard(|| {
        let opened = state.create(&name, || standard_folder(&app))?;
        set_title(&app, &format!("{} — {APP_TITLE}", opened.name));
        Ok(opened)
    })
}

/// The user's Documents folder, or their home folder when there is none.
fn standard_folder(app: &AppHandle) -> Option<PathBuf> {
    let paths = app.path();
    paths.document_dir().or_else(|_| paths.home_dir()).ok()
}

fn display(location: &Path) -> NewLocation {
    NewLocation {
        location: location.display().to_string(),
    }
}

fn no_world() -> AppError {
    AppError::new(ErrorKind::NoWorld, "No world is open.")
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
        assert_eq!(
            state
                .write_page("Places/Saltmere.md", "# Saltmere\n", "any")
                .unwrap_err()
                .kind,
            ErrorKind::NoWorld
        );
        assert_eq!(
            state
                .create_entry(|root| write::create_page(root, None, "New"))
                .unwrap_err()
                .kind,
            ErrorKind::NoWorld
        );
    }

    #[test]
    fn new_entries_are_created_in_the_open_world() {
        let state = WorldState::default();
        let world = world();
        state.open(world.path().to_path_buf()).unwrap();

        let page = state
            .create_entry(|root| write::create_page(root, Some("Places"), "Kesh Tor"))
            .unwrap();

        assert_eq!(page.path, "Places/Kesh Tor.md");
        assert_eq!(state.read_page(&page.path).unwrap().text, "");
    }

    /// No Documents or home folder: only a location from the session can be used.
    const NO_STANDARD_FOLDER: fn() -> Option<PathBuf> = || None;

    #[test]
    fn a_new_world_location_is_the_picked_folder_then_the_last_world_s_parent_then_the_standard_folder()
     {
        let state = WorldState::default();
        let documents = tempfile::tempdir().unwrap();
        let standard = || Some(documents.path().to_path_buf());
        let parent = tempfile::tempdir().unwrap();
        let last = parent.path().join("Glass Steppe");
        fs::create_dir(&last).unwrap();
        let picked = tempfile::tempdir().unwrap();

        assert_eq!(state.new_location(standard).unwrap(), documents.path());
        assert_eq!(
            state.new_location(NO_STANDARD_FOLDER).unwrap_err().kind,
            ErrorKind::Io
        );

        state.open(last.clone()).unwrap();
        state.close();
        assert_eq!(state.new_location(standard).unwrap(), parent.path());

        state.set_new_location(picked.path().to_path_buf());
        assert_eq!(state.new_location(standard).unwrap(), picked.path());

        state.reset_new_location();
        assert_eq!(state.new_location(standard).unwrap(), parent.path());
    }

    #[test]
    fn creating_a_world_makes_an_empty_folder_at_the_location_and_opens_it() {
        let state = WorldState::default();
        let location = tempfile::tempdir().unwrap();
        state.set_new_location(location.path().to_path_buf());

        let opened = state.create("Saltmere", NO_STANDARD_FOLDER).unwrap();

        assert_eq!(opened.name, "Saltmere");
        assert_eq!(opened.session, 1);
        assert_eq!(state.root().unwrap(), location.path().join("Saltmere"));
        assert!(state.tree().unwrap().is_empty());
        assert_eq!(fs::read_dir(location.path()).unwrap().count(), 1);
    }

    #[test]
    fn a_world_that_cannot_be_created_creates_nothing_and_keeps_the_open_world() {
        let state = WorldState::default();
        let world = world();
        let location = tempfile::tempdir().unwrap();
        fs::create_dir(location.path().join("saltmere")).unwrap();
        let opened = state.open(world.path().to_path_buf()).unwrap();
        state.set_new_location(location.path().to_path_buf());

        let clash = state.create("Saltmere", NO_STANDARD_FOLDER).unwrap_err();
        let invalid = state.create("Salt#mere", NO_STANDARD_FOLDER).unwrap_err();

        assert_eq!(clash.kind, ErrorKind::Exists);
        assert_eq!(invalid.kind, ErrorKind::InvalidName);
        assert_eq!(fs::read_dir(location.path()).unwrap().count(), 1);
        assert_eq!(state.root().unwrap(), world.path());
        // The next opening still takes the next session.
        let next = state.open(world.path().to_path_buf()).unwrap();
        assert_eq!(next.session, opened.session + 1);
    }

    #[test]
    fn a_page_read_from_the_open_world_saves_with_its_version() {
        let state = WorldState::default();
        let world = world();
        state.open(world.path().to_path_buf()).unwrap();
        let page = state.read_page("Places/Saltmere.md").unwrap();

        let saved = state
            .write_page("Places/Saltmere.md", "# Saltmere harbour\n", &page.version)
            .unwrap();

        assert_eq!(
            fs::read(world.path().join("Places/Saltmere.md")).unwrap(),
            "\u{feff}# Saltmere harbour\r\n".as_bytes()
        );
        assert_eq!(
            saved.version,
            state.read_page("Places/Saltmere.md").unwrap().version
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
