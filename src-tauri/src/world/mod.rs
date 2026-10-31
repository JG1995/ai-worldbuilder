//! The `world` area: the open world and the commands that browse, read, save and create in it,
//! that open recent worlds and keep their workspaces, and the watcher that reports outside changes.

mod dialog;
mod names;
mod page;
mod paths;
mod recent;
mod tree;
mod watch;
mod write;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, ErrorKind, guard};
use page::{DiffLine, PageText};
use recent::{Recent, RecentWorld, Workspace};
use tree::TreeEntry;
pub use watch::{EventSink, WorldEvent};
use write::{NewEntry, OwnWrites, PageVersion};

const APP_TITLE: &str = "Grimoire.md";
/// The limits on a workspace from the interface: the tree width range of `src/ui/Shell.tsx`, and
/// more tabs and expanded folders than anyone opens.
const TREE_WIDTHS: (u32, u32) = (200, 420);
const MAX_TABS: usize = 100;
const MAX_EXPANDED: usize = 5_000;

/// The open world, if any, the recent worlds, and what New world needs, managed by Tauri.
#[derive(Default)]
pub struct WorldState {
    /// Shared with the open world's watcher, which reads the own-write record under this lock.
    inner: Arc<Mutex<Inner>>,
    /// Where the watcher sends its events. Without it, as in most tests, no watcher starts.
    events: OnceLock<EventSink>,
}

#[derive(Default)]
struct Inner {
    world: Option<OpenWorld>,
    /// The session of the latest opening. It changes together with `world`, under one lock, so a
    /// session number always names the world it was given with.
    session: u64,
    /// The recent worlds. They change under the same lock as `world`, so the list and the open
    /// world always agree.
    recent: Recent,
    /// The folder New world creates its folder in, once the user has picked one with Browse….
    new_location: Option<PathBuf>,
}

struct OpenWorld {
    root: PathBuf,
    /// Its entry in the recent list, which holds its workspace; `None` when it cannot be stored.
    recent_id: Option<String>,
    /// What the application wrote in it, so the watcher leaves those writes out.
    own_writes: OwnWrites,
    /// Lives exactly as long as this opening: replacing or clearing the open world drops it.
    _watcher: Option<watch::Watcher>,
}

/// A page on disk compared with the editor's text.
#[derive(Debug, Serialize)]
pub struct Comparison {
    version: String,
    lines: Vec<DiffLine>,
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

impl WorldState {
    /// Loads the recent worlds kept in the app data folder, at launch.
    pub fn load_recent(&self, app_data: &Path) {
        self.lock().recent = Recent::load(app_data);
    }

    /// Takes where the watcher sends its events, once, at launch.
    pub fn set_events(&self, sink: EventSink) {
        let _ = self.events.set(sink);
    }

    pub fn is_open(&self) -> bool {
        self.lock().world.is_some()
    }

    /// Opens the folder at `root`, replacing the open world, unless the folder cannot be read. The
    /// world moves to the top of the recent list and opens with its stored workspace, and a new
    /// watcher starts for it.
    fn open(&self, root: PathBuf) -> Result<WorldOpened, AppError> {
        fs::read_dir(&root)?;
        let name = root.file_name().map_or_else(
            || root.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
        let (session, stored) = {
            let mut inner = self.lock();
            // The old world's watcher stops before the session changes.
            inner.world = None;
            inner.session += 1;
            let watcher = self.watch(&root, inner.session);
            let recent_id = inner.recent.opened(&root, &name);
            let stored = recent_id
                .as_deref()
                .and_then(|id| inner.recent.workspace(id));
            inner.world = Some(OpenWorld {
                root: root.clone(),
                recent_id,
                own_writes: OwnWrites::default(),
                _watcher: watcher,
            });
            (inner.session, stored)
        };
        Ok(WorldOpened {
            name,
            session,
            workspace: stored.map_or_else(Workspace::default, |stored| existing_in(&root, stored)),
        })
    }

    /// Opens a world from the recent list: `not_found` for an id that is not in it, and
    /// `world_missing` when its folder is gone.
    fn open_recent(&self, id: &str) -> Result<WorldOpened, AppError> {
        let root = self.lock().recent.path_of(id).ok_or_else(|| {
            AppError::new(
                ErrorKind::NotFound,
                "This world is no longer in the recent list.",
            )
        })?;
        paths::check_root(&root)?;
        self.open(root)
    }

    /// Opens the world that was open when the application last closed, if its folder is there.
    fn restore(&self) -> Option<WorldOpened> {
        let root = self.lock().recent.last_open()?;
        // A folder that is gone or cannot be read leaves the welcome screen, which marks it.
        self.open(root).ok()
    }

    /// The recent worlds, without the open one.
    fn recent_list(&self) -> Vec<RecentWorld> {
        let inner = self.lock();
        let open = inner
            .world
            .as_ref()
            .and_then(|world| world.recent_id.as_deref());
        inner.recent.list(open)
    }

    fn remove_recent(&self, id: &str) {
        self.lock().recent.remove(id);
    }

    /// Stores the open world's workspace, within the limits on input from the interface.
    fn save_workspace(&self, workspace: Workspace) -> Result<(), AppError> {
        let workspace = limited(workspace)?;
        let mut inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        if let Some(id) = world.recent_id.clone() {
            inner.recent.set_workspace(&id, workspace);
        }
        Ok(())
    }

    /// Closes the world, which stops its watcher. The next launch then starts on the welcome screen.
    fn close(&self) {
        let mut inner = self.lock();
        inner.world = None;
        inner.recent.closed();
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
    /// the most recently opened recent world, otherwise `fallback`, the user's Documents or home
    /// folder.
    fn new_location(
        &self,
        fallback: impl FnOnce() -> Option<PathBuf>,
    ) -> Result<PathBuf, AppError> {
        let picked_or_recent = {
            let inner = self.lock();
            inner
                .new_location
                .clone()
                .or_else(|| inner.recent.latest_parent())
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
        create: impl FnOnce(&Path, &mut OwnWrites) -> Result<NewEntry, AppError>,
    ) -> Result<NewEntry, AppError> {
        self.with_world(|world| create(&world.root, &mut world.own_writes))
    }

    fn tree(&self) -> Result<Vec<TreeEntry>, AppError> {
        tree::list(&self.root()?)
    }

    fn read_page(&self, path: &str) -> Result<PageText, AppError> {
        page::read(&paths::existing_page(&self.root()?, path)?)
    }

    /// The page on disk, line by line, against the editor's `text`, with the version on disk.
    fn compare_page(&self, path: &str, text: &str) -> Result<Comparison, AppError> {
        let page = self.read_page(path)?;
        Ok(Comparison {
            lines: page::compare(&page.text, text),
            version: page.version,
        })
    }

    /// Holds the world lock for the whole write, so writes never overlap.
    fn write_page(&self, path: &str, text: &str, version: &str) -> Result<PageVersion, AppError> {
        self.with_world(|world| {
            write::write_page(&world.root, &mut world.own_writes, path, text, version)
        })
    }

    /// Writes a page that is gone back, under the world lock like a save.
    fn restore_page(&self, path: &str, text: &str) -> Result<PageVersion, AppError> {
        self.with_world(|world| write::restore_page(&world.root, &mut world.own_writes, path, text))
    }

    fn root(&self) -> Result<PathBuf, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        Ok(world.root.clone())
    }

    /// Runs `write` on the open world with the world lock held.
    fn with_world<T>(
        &self,
        write: impl FnOnce(&mut OpenWorld) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut inner = self.lock();
        write(inner.world.as_mut().ok_or_else(no_world)?)
    }

    /// Starts the watcher for the opening `session` of the world at `root`. Its batches are read
    /// under the world lock, so a write of the application's is never half done when the watcher
    /// compares a page with the own-write record.
    fn watch(&self, root: &Path, session: u64) -> Option<watch::Watcher> {
        let sink = Arc::clone(self.events.get()?);
        let shared = Arc::clone(&self.inner);
        watch::start(root, session, sink, move |events| {
            let mut inner = lock(&shared);
            if inner.session != session {
                return None;
            }
            let OpenWorld {
                root, own_writes, ..
            } = inner.world.as_mut()?;
            Some(watch::changes(root, events, |relative| {
                own_writes.is_own(root, relative)
            }))
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }
}

/// The state stays consistent after a panic, because every change to it is a whole field.
fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
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
        set_title(&app, Some(&opened.name));
        Ok(Some(opened))
    })
}

#[tauri::command]
pub async fn world_close(app: AppHandle, state: State<'_, WorldState>) -> Result<(), AppError> {
    guard(|| {
        state.close();
        set_title(&app, None);
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

/// Compares a page on disk with the editor's text, line by line.
#[tauri::command]
pub async fn page_compare(
    state: State<'_, WorldState>,
    path: String,
    text: String,
) -> Result<Comparison, AppError> {
    guard(|| state.compare_page(&path, &text))
}

/// Writes the editor's text back to a page that was deleted or moved outside the application,
/// recreating its folders. Returns `conflict` when something is at its path again.
#[tauri::command]
pub async fn page_restore(
    state: State<'_, WorldState>,
    path: String,
    text: String,
) -> Result<PageVersion, AppError> {
    guard(|| state.restore_page(&path, &text))
}

/// Creates an empty page `{name}.md` in `folder`, or at the world's top level when it is `null`.
#[tauri::command]
pub async fn page_create(
    state: State<'_, WorldState>,
    folder: Option<String>,
    name: String,
) -> Result<NewEntry, AppError> {
    guard(|| {
        state.create_entry(|root, own| write::create_page(root, own, folder.as_deref(), &name))
    })
}

/// Creates an empty folder `name` in `folder`, or at the world's top level when it is `null`.
#[tauri::command]
pub async fn folder_create(
    state: State<'_, WorldState>,
    folder: Option<String>,
    name: String,
) -> Result<NewEntry, AppError> {
    guard(|| {
        state.create_entry(|root, own| write::create_folder(root, own, folder.as_deref(), &name))
    })
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
        set_title(&app, Some(&opened.name));
        Ok(opened)
    })
}

/// The recent worlds, most recently opened first, without the open world.
#[tauri::command]
pub async fn recent_list(state: State<'_, WorldState>) -> Result<Vec<RecentWorld>, AppError> {
    guard(|| Ok(state.recent_list()))
}

/// Removes a world from the recent list. Nothing in its folder changes.
#[tauri::command]
pub async fn recent_remove(state: State<'_, WorldState>, id: String) -> Result<(), AppError> {
    guard(|| {
        state.remove_recent(&id);
        Ok(())
    })
}

/// Opens a world from the recent list, by its id, so the interface never names a folder.
#[tauri::command]
pub async fn world_open_recent(
    app: AppHandle,
    state: State<'_, WorldState>,
    id: String,
) -> Result<WorldOpened, AppError> {
    guard(|| {
        let opened = state.open_recent(&id)?;
        set_title(&app, Some(&opened.name));
        Ok(opened)
    })
}

/// Opens the world that was open when the application last closed, or returns `null` when there
/// is none or its folder is gone.
#[tauri::command]
pub async fn world_restore(
    app: AppHandle,
    state: State<'_, WorldState>,
) -> Result<Option<WorldOpened>, AppError> {
    guard(|| {
        let opened = state.restore();
        if let Some(opened) = &opened {
            set_title(&app, Some(&opened.name));
        }
        Ok(opened)
    })
}

/// Stores the open world's tabs, expanded folders and tree width for its next opening.
#[tauri::command]
pub async fn workspace_save(
    state: State<'_, WorldState>,
    workspace: Workspace,
) -> Result<(), AppError> {
    guard(|| state.save_workspace(workspace))
}

/// The stored workspace with only the tabs that are still pages and the expanded paths that are
/// still folders in the world at `root`. A gone active tab gives way to the first tab left.
fn existing_in(root: &Path, stored: Workspace) -> Workspace {
    let tabs: Vec<String> = stored
        .tabs
        .into_iter()
        .filter(|tab| paths::existing_page(root, tab).is_ok())
        .collect();
    let active = stored
        .active
        .filter(|active| tabs.contains(active))
        .or_else(|| tabs.first().cloned());
    let expanded = stored
        .expanded
        .into_iter()
        .filter(|folder| paths::existing_folder(root, Some(folder)).is_ok())
        .collect();
    Workspace {
        tabs,
        active,
        expanded,
        tree_width: stored.tree_width.clamp(TREE_WIDTHS.0, TREE_WIDTHS.1),
    }
}

/// A workspace from the interface, refused when any path is not a relative path that confinement
/// accepts lexically, and otherwise clamped and truncated to the limits.
fn limited(mut workspace: Workspace) -> Result<Workspace, AppError> {
    let mut all_paths = workspace
        .tabs
        .iter()
        .chain(&workspace.expanded)
        .chain(&workspace.active);
    if !all_paths.all(|path| path.split('/').all(paths::is_allowed_name)) {
        return Err(AppError::new(
            ErrorKind::InvalidPath,
            "The workspace names a path that is not a valid page or folder path in this world.",
        ));
    }
    workspace.tabs.truncate(MAX_TABS);
    workspace.expanded.truncate(MAX_EXPANDED);
    workspace.tree_width = workspace.tree_width.clamp(TREE_WIDTHS.0, TREE_WIDTHS.1);
    Ok(workspace)
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

/// Shows the open world's name in the window title, or only the application's name when no world
/// is open. The core sets the title, because `core:default` does not let the webview do it. A title
/// that cannot be set changes nothing else, so the command still succeeds.
fn set_title(app: &AppHandle, world: Option<&str>) {
    let title = world.map_or_else(
        || APP_TITLE.to_owned(),
        |name| format!("{name} — {APP_TITLE}"),
    );
    if let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = window.set_title(&title);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime};
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
                .create_entry(|root, own| write::create_page(root, own, None, "New"))
                .unwrap_err()
                .kind,
            ErrorKind::NoWorld
        );
    }

    #[test]
    fn reads_and_writes_after_the_world_s_folder_is_gone_are_world_missing() {
        let state = WorldState::default();
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("Kesh");
        fs::create_dir_all(root.join("Places")).unwrap();
        fs::write(root.join("Places/Saltmere.md"), "# Saltmere\n").unwrap();
        state.open(root.clone()).unwrap();
        let version = state.read_page("Places/Saltmere.md").unwrap().version;
        fs::remove_dir_all(&root).unwrap();

        let kinds = [
            state.tree().map(drop),
            state.read_page("Places/Saltmere.md").map(drop),
            state.compare_page("Places/Saltmere.md", "mine\n").map(drop),
            state
                .write_page("Places/Saltmere.md", "mine\n", &version)
                .map(drop),
            state.restore_page("Places/Saltmere.md", "mine\n").map(drop),
            state
                .create_entry(|root, own| write::create_page(root, own, None, "New"))
                .map(drop),
            state
                .create_entry(|root, own| write::create_folder(root, own, None, "New"))
                .map(drop),
        ]
        .map(|result| result.unwrap_err().kind);

        assert_eq!(kinds, [ErrorKind::WorldMissing; 7]);
        assert!(!root.exists());
    }

    /// The next event the watcher sends, within five seconds.
    fn next_event(events: &mpsc::Receiver<WorldEvent>) -> WorldEvent {
        events
            .recv_timeout(Duration::from_secs(5))
            .expect("the watcher sent no event within five seconds")
    }

    /// A world state whose watcher sends its events to the returned receiver.
    fn watched() -> (WorldState, mpsc::Receiver<WorldEvent>) {
        let (sender, events) = mpsc::channel();
        let state = WorldState::default();
        state.set_events(Arc::new(move |event| {
            let _ = sender.send(event);
        }));
        (state, events)
    }

    fn changed(session: u64, tree: bool, pages: &[&str]) -> WorldEvent {
        WorldEvent::Changed {
            session,
            tree,
            pages: pages.iter().map(|page| page.to_string()).collect(),
        }
    }

    /// Each outside change below is followed by a sentinel page created outside: the next event
    /// must name only the sentinel, so an event for the change before it would show up first or
    /// alongside it.
    #[test]
    fn the_watcher_reports_outside_changes_but_not_the_application_s_writes_or_an_old_world() {
        let (world, next) = (world(), world());
        let (state, events) = watched();
        let session = state.open(world.path().to_path_buf()).unwrap().session;

        fs::write(world.path().join("Outside.md"), "# Outside\n").unwrap();
        assert_eq!(next_event(&events), changed(session, true, &["Outside.md"]));

        let page = state.read_page("Places/Saltmere.md").unwrap();
        state
            .write_page("Places/Saltmere.md", "# Saltmere harbour\n", &page.version)
            .unwrap();
        state
            .create_entry(|root, own| write::create_page(root, own, Some("Places"), "Kesh Tor"))
            .unwrap();
        state
            .create_entry(|root, own| write::create_folder(root, own, None, "Factions"))
            .unwrap();
        fs::write(world.path().join("Sentinel.md"), "").unwrap();
        assert_eq!(
            next_event(&events),
            changed(session, true, &["Sentinel.md"])
        );

        let next_session = state.open(next.path().to_path_buf()).unwrap().session;
        fs::write(world.path().join("Old world.md"), "").unwrap();
        fs::write(next.path().join("Sentinel.md"), "").unwrap();
        assert_eq!(
            next_event(&events),
            changed(next_session, true, &["Sentinel.md"])
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_watcher_follows_no_link_out_of_the_world() {
        let world = world();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), world.path().join("Elsewhere")).unwrap();
        let (state, events) = watched();
        let session = state.open(world.path().to_path_buf()).unwrap().session;

        fs::write(outside.path().join("Secret.md"), "secret").unwrap();
        fs::write(world.path().join("Sentinel.md"), "").unwrap();

        assert_eq!(
            next_event(&events),
            changed(session, true, &["Sentinel.md"])
        );
    }

    #[test]
    fn new_entries_are_created_in_the_open_world() {
        let state = WorldState::default();
        let world = world();
        state.open(world.path().to_path_buf()).unwrap();

        let page = state
            .create_entry(|root, own| write::create_page(root, own, Some("Places"), "Kesh Tor"))
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

    /// A world state that keeps its recent worlds in `app_data`, as at launch.
    fn launched(app_data: &TempDir) -> WorldState {
        let state = WorldState::default();
        state.load_recent(app_data.path());
        state
    }

    fn workspace(tabs: &[&str], active: Option<&str>, expanded: &[&str]) -> Workspace {
        Workspace {
            tabs: tabs.iter().map(|tab| tab.to_string()).collect(),
            active: active.map(str::to_owned),
            expanded: expanded.iter().map(|folder| folder.to_string()).collect(),
            tree_width: 300,
        }
    }

    #[test]
    fn a_relaunch_restores_the_last_world_with_its_workspace_minus_what_is_gone() {
        let app_data = tempfile::tempdir().unwrap();
        let world = world();
        fs::create_dir(world.path().join("Factions")).unwrap();
        fs::write(world.path().join("Overview.md"), "# Overview\n").unwrap();
        fs::write(world.path().join("Gone.md"), "# Gone\n").unwrap();
        let state = launched(&app_data);
        state.open(world.path().to_path_buf()).unwrap();
        state
            .save_workspace(workspace(
                &["Overview.md", "Gone.md", "Places/Saltmere.md"],
                Some("Places/Saltmere.md"),
                &["Places", "Factions"],
            ))
            .unwrap();
        // The application closes with the world open; then the page and a folder go.
        fs::remove_file(world.path().join("Gone.md")).unwrap();
        fs::remove_dir(world.path().join("Factions")).unwrap();

        let relaunched = launched(&app_data);
        let restored = relaunched.restore().unwrap();

        assert_eq!(relaunched.root().unwrap(), world.path());
        assert_eq!(
            restored.workspace,
            workspace(
                &["Overview.md", "Places/Saltmere.md"],
                Some("Places/Saltmere.md"),
                &["Places"],
            )
        );
    }

    #[test]
    fn a_gone_active_tab_gives_way_to_the_first_tab_left() {
        let world = world();
        fs::write(world.path().join("Overview.md"), "# Overview\n").unwrap();
        let stored = workspace(&["Places/Saltmere.md", "Overview.md"], Some("Gone.md"), &[]);

        let kept = existing_in(world.path(), stored);

        assert_eq!(kept.active.as_deref(), Some("Places/Saltmere.md"));
    }

    #[test]
    fn nothing_is_restored_after_close_world_or_when_the_folder_is_gone() {
        let app_data = tempfile::tempdir().unwrap();
        let world = world();
        let state = launched(&app_data);
        state.open(world.path().to_path_buf()).unwrap();
        state.close();
        assert!(launched(&app_data).restore().is_none());

        state.open(world.path().to_path_buf()).unwrap();
        let gone = world.path().to_path_buf();
        drop(world);

        let relaunched = launched(&app_data);
        assert!(relaunched.restore().is_none());
        assert!(!relaunched.is_open());
        assert_eq!(
            serde_json::to_value(relaunched.recent_list()).unwrap()[0]["missing"],
            true
        );
        assert!(!gone.exists());
    }

    #[test]
    fn a_recent_world_opens_by_id_unless_it_is_unknown_or_its_folder_is_gone() {
        let state = WorldState::default();
        let first = world();
        let second = world();
        state.open(first.path().to_path_buf()).unwrap();
        state.open(second.path().to_path_buf()).unwrap();
        let listed = serde_json::to_value(state.recent_list()).unwrap();
        // The open world is left out of the list.
        assert_eq!(listed.as_array().unwrap().len(), 1);
        let first_id = listed[0]["id"].as_str().unwrap().to_owned();

        let opened = state.open_recent(&first_id).unwrap();
        assert_eq!(opened.session, 3);
        assert_eq!(state.root().unwrap(), first.path());

        assert_eq!(
            state.open_recent("unknown").unwrap_err().kind,
            ErrorKind::NotFound
        );
        let second_id = serde_json::to_value(state.recent_list()).unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        drop(second);
        assert_eq!(
            state.open_recent(&second_id).unwrap_err().kind,
            ErrorKind::WorldMissing
        );
        assert_eq!(state.root().unwrap(), first.path());
    }

    #[test]
    fn a_workspace_with_a_path_outside_the_world_is_refused() {
        let state = WorldState::default();
        let world = world();
        assert_eq!(
            state.save_workspace(Workspace::default()).unwrap_err().kind,
            ErrorKind::NoWorld
        );
        let opened = state.open(world.path().to_path_buf()).unwrap();
        state
            .save_workspace(workspace(&["Places/Saltmere.md"], None, &[]))
            .unwrap();

        for refused in [
            workspace(&["../outside.md"], None, &[]),
            workspace(&["/etc/passwd.md"], None, &[]),
            workspace(&[], Some("Places/../../outside.md"), &[]),
            workspace(&[], None, &[".obsidian"]),
            workspace(&[], None, &[""]),
        ] {
            assert_eq!(
                state.save_workspace(refused).unwrap_err().kind,
                ErrorKind::InvalidPath
            );
        }
        // The stored workspace is the last accepted one.
        let reopened = state.open(world.path().to_path_buf()).unwrap();
        assert_eq!(reopened.workspace.tabs, ["Places/Saltmere.md"]);
        assert_eq!(reopened.session, opened.session + 1);
    }

    #[test]
    fn a_workspace_is_clamped_and_truncated_to_the_limits() {
        let pages: Vec<String> = (0..150).map(|number| format!("Page {number}.md")).collect();
        let folders: Vec<String> = (0..6_000)
            .map(|number| format!("Folder {number}"))
            .collect();
        let wide = Workspace {
            tabs: pages.clone(),
            active: None,
            expanded: folders.clone(),
            tree_width: 9_000,
        };

        let kept = limited(wide).unwrap();
        let narrow = limited(Workspace {
            tree_width: 10,
            ..Workspace::default()
        })
        .unwrap();

        assert_eq!(kept.tabs, pages[..100]);
        assert_eq!(kept.expanded, folders[..5_000]);
        assert_eq!(kept.tree_width, 420);
        assert_eq!(narrow.tree_width, 200);
    }
}
