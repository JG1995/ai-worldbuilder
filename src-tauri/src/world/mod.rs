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
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, ErrorKind, guard};
use crate::history::{self, History, HistoryVersion, Kind};
use page::{DiffLine, PageText};
use recent::{Recent, RecentWorld, Workspace};
use tree::TreeEntry;
pub use watch::{EventSink, WorldEvent};
use write::{NewEntry, OwnWrites, PageVersion, Recorder, Recording, RestoredPage};

const APP_TITLE: &str = "Grimoire.md";
/// Why an opening has no history when the application has no data folder to keep it in.
const NO_APP_DATA: &str = "The application has no data folder to keep history in.";
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
    /// The app data folder, which holds each world's history. Without it, as in most tests, no
    /// history is kept.
    app_data: Option<PathBuf>,
    /// The folder New world creates its folder in, once the user has picked one with Browse….
    new_location: Option<PathBuf>,
}

struct OpenWorld {
    root: PathBuf,
    /// Its entry in the recent list, which holds its workspace; `None` when it cannot be stored.
    recent_id: Option<String>,
    /// What the application wrote in it, so the watcher leaves those writes out.
    own_writes: OwnWrites,
    /// Its history, or why it has none: there is no app data folder, or the history could not open.
    history: Result<History, String>,
    /// Whether its writes are being recorded, as the interface was last told.
    recording: bool,
    /// Lives exactly as long as this opening: replacing or clearing the open world drops it.
    _watcher: Option<watch::Watcher>,
}

impl OpenWorld {
    /// Takes in what became of a write's record in the opening `session`, and returns the event
    /// that tells the interface when recording stopped or started again. It is sent once per change
    /// of state, not once per write.
    fn recorded(&mut self, outcome: Recording, session: u64) -> Option<WorldEvent> {
        match outcome {
            Recording::Recorded if !self.recording => {
                self.recording = true;
                Some(WorldEvent::HistoryRecording { session })
            }
            Recording::Failed(message) if self.recording => {
                self.recording = false;
                Some(WorldEvent::HistoryNotRecording { session, message })
            }
            _ => None,
        }
    }
}

/// A page on disk compared with the editor's text.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Comparison {
    version: String,
    lines: Vec<DiffLine>,
}

/// Where New world will create its folder, as a path to show.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct NewLocation {
    location: String,
}

/// The result of opening a world.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct WorldOpened {
    name: String,
    /// Increases with every open, so the interface can tell one opening from the next.
    session: u64,
    workspace: Workspace,
}

impl WorldState {
    /// Loads the recent worlds kept in the app data folder, at launch, and keeps the folder for
    /// the worlds' histories.
    pub fn load_recent(&self, app_data: &Path) {
        let mut inner = self.lock();
        inner.recent = Recent::load(app_data);
        inner.app_data = Some(app_data.to_path_buf());
    }

    /// Takes where the watcher sends its events, once, at launch.
    pub fn set_events(&self, sink: EventSink) {
        let _ = self.events.set(sink);
    }

    pub fn is_open(&self) -> bool {
        self.lock().world.is_some()
    }

    /// Opens the folder at `root`, replacing the open world, unless the folder cannot be read. The
    /// world moves to the top of the recent list and opens with its stored workspace and its
    /// history, and a new watcher starts for it.
    fn open(&self, root: PathBuf) -> Result<WorldOpened, AppError> {
        fs::read_dir(&root)?;
        let name = root.file_name().map_or_else(
            || root.display().to_string(),
            |name| name.to_string_lossy().into_owned(),
        );
        let (session, stored) = {
            let mut inner = self.lock();
            // The old world's watcher stops and its history closes before the session changes.
            inner.world = None;
            inner.session += 1;
            let session = inner.session;
            let watcher = self.watch(&root, session);
            let recent_id = inner.recent.opened(&root, &name);
            let stored = recent_id
                .as_deref()
                .and_then(|id| inner.recent.workspace(id));
            let (history, recording) = match &inner.app_data {
                Some(app_data) => self.open_history(app_data, &root, session),
                None => (Err(NO_APP_DATA.to_owned()), false),
            };
            inner.world = Some(OpenWorld {
                root: root.clone(),
                recent_id,
                own_writes: OwnWrites::default(),
                history,
                recording,
                _watcher: watcher,
            });
            (session, stored)
        };
        Ok(WorldOpened {
            name,
            session,
            workspace: stored.map_or_else(Workspace::default, |stored| existing_in(&root, stored)),
        })
    }

    /// Opens the history of the world at `root` for the opening `session`, resolving the records
    /// that writes left pending with what is on disk now, and removing changes past retention. It
    /// tells the interface when a damaged history was set aside, or when changes are not being
    /// recorded, and returns the history, or why there is none, with whether it records.
    fn open_history(
        &self,
        app_data: &Path,
        root: &Path,
        session: u64,
    ) -> (Result<History, String>, bool) {
        let opened = History::open(app_data, root, now(), |path| state_on_disk(root, path));
        if let Some(sink) = self.events.get() {
            if opened.set_aside {
                sink(WorldEvent::HistorySetAside { session });
            }
            if let Some(failure) = &opened.not_recording {
                sink(WorldEvent::HistoryNotRecording {
                    session,
                    message: failure.reason().to_owned(),
                });
            }
        }
        let recording = opened.not_recording.is_none();
        let history = opened.history.ok_or_else(|| {
            opened
                .not_recording
                .map_or_else(String::new, history::Failure::into_reason)
        });
        (history, recording)
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
        create: impl FnOnce(&Path, &mut OwnWrites, &mut Recorder) -> Result<NewEntry, AppError>,
    ) -> Result<NewEntry, AppError> {
        self.with_world(create)
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

    /// Holds the world lock for the whole write, so writes never overlap. Keep mine sets
    /// `keep_mine`, which records the save as Keep mine's.
    fn write_page(
        &self,
        path: &str,
        text: &str,
        version: &str,
        keep_mine: bool,
    ) -> Result<PageVersion, AppError> {
        self.with_world(|root, own, recorder| {
            write::write_page(root, own, recorder, path, text, version, keep_mine)
        })
    }

    /// Writes a page that is gone back, under the world lock like a save.
    fn restore_page(&self, path: &str, text: &str) -> Result<PageVersion, AppError> {
        self.with_world(|root, own, recorder| write::restore_page(root, own, recorder, path, text))
    }

    /// The page's earlier versions, newest first, without the newest ones whose bytes the page
    /// holds now, which the History view shows as Current. An opening without a history fails
    /// with `io` and the reason it has none.
    fn history_list(&self, path: &str) -> Result<Vec<HistoryVersion>, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        let current = fs::read(paths::existing_page(&world.root, path)?)?;
        let history = world
            .history
            .as_ref()
            .map_err(|reason| AppError::new(ErrorKind::Io, reason.clone()))?;
        Ok(history
            .versions(path)?
            .into_iter()
            .skip_while(|(_, bytes)| *bytes == current)
            .map(|(version, _)| version)
            .collect())
    }

    /// The lines of the page's version `version` compared with the editor's `text`: lines only in
    /// `text` are added, and lines only in the version removed.
    fn history_compare(
        &self,
        path: &str,
        version: &str,
        text: &str,
    ) -> Result<Vec<DiffLine>, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        paths::existing_page(&world.root, path)?;
        let bytes = match &world.history {
            Ok(history) => history.version_bytes(path, version)?,
            Err(_) => None,
        };
        let bytes = bytes.ok_or_else(unknown_version)?;
        Ok(page::compare(&page::text_of(&bytes)?, text))
    }

    /// Writes the exact bytes of the page's version `version` over the page, if the page still has
    /// the bytes of `page_version`, under the world lock like a save, and records it as a restore.
    fn history_restore(
        &self,
        path: &str,
        version: &str,
        page_version: &str,
    ) -> Result<RestoredPage, AppError> {
        self.with_world(|root, own, recorder| {
            let bytes = match recorder.history() {
                Some(history) => history.version_bytes(path, version)?,
                None => None,
            };
            let bytes = bytes.ok_or_else(unknown_version)?;
            write::write_bytes(
                root,
                own,
                recorder,
                path,
                &bytes,
                page_version,
                Kind::Restore,
            )
        })
    }

    /// Writes back what the change `change` replaced, under the world lock like a save.
    fn history_undo(&self, change: &str) -> Result<RestoredPage, AppError> {
        self.with_world(|root, own, recorder| write::undo(root, own, recorder, change))
    }

    fn root(&self) -> Result<PathBuf, AppError> {
        let inner = self.lock();
        let world = inner.world.as_ref().ok_or_else(no_world)?;
        Ok(world.root.clone())
    }

    /// Runs `write` on the open world's folder with the world lock held, so the write and its
    /// record in history happen together, in the order of writes. When the record failed while the
    /// opening was recording, or succeeded while it was not, the interface is told.
    fn with_world<T>(
        &self,
        write: impl FnOnce(&Path, &mut OwnWrites, &mut Recorder) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut inner = self.lock();
        let session = inner.session;
        let world = inner.world.as_mut().ok_or_else(no_world)?;
        let mut recorder = Recorder::new(world.history.as_mut().ok(), now());
        let result = write(&world.root, &mut world.own_writes, &mut recorder);
        let outcome = recorder.outcome();
        if let Some(event) = world.recorded(outcome, session)
            && let Some(sink) = self.events.get()
        {
            sink(event);
        }
        result
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
/// version of the bytes it now has. Keep mine sets `keep_mine`, so history records it as such.
#[tauri::command]
pub async fn page_write(
    state: State<'_, WorldState>,
    path: String,
    text: String,
    version: String,
    keep_mine: bool,
) -> Result<PageVersion, AppError> {
    guard(|| state.write_page(&path, &text, &version, keep_mine))
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

/// A page's earlier versions, newest first, without those equal to the page on disk.
#[tauri::command]
pub async fn history_list(
    state: State<'_, WorldState>,
    path: String,
) -> Result<Vec<HistoryVersion>, AppError> {
    guard(|| state.history_list(&path))
}

/// Compares a version of a page with the editor's text, line by line.
#[tauri::command]
pub async fn history_compare(
    state: State<'_, WorldState>,
    path: String,
    version: String,
    text: String,
) -> Result<Vec<DiffLine>, AppError> {
    guard(|| state.history_compare(&path, &version, &text))
}

/// Writes a version's exact bytes back to its page if the page still has the bytes of
/// `page_version`, and returns the page's new text and version, with the change that recorded it.
#[tauri::command]
pub async fn history_restore(
    state: State<'_, WorldState>,
    path: String,
    version: String,
    page_version: String,
) -> Result<RestoredPage, AppError> {
    guard(|| state.history_restore(&path, &version, &page_version))
}

/// Undoes a restore: writes back the bytes it replaced if the page still holds the restored ones.
#[tauri::command]
pub async fn history_undo(
    state: State<'_, WorldState>,
    change: String,
) -> Result<RestoredPage, AppError> {
    guard(|| state.history_undo(&change))
}

/// Creates an empty page `{name}.md` in `folder`, or at the world's top level when it is `null`.
#[tauri::command]
pub async fn page_create(
    state: State<'_, WorldState>,
    folder: Option<String>,
    name: String,
) -> Result<NewEntry, AppError> {
    guard(|| {
        state.create_entry(|root, own, recorder| {
            write::create_page(root, own, recorder, folder.as_deref(), &name)
        })
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
        state.create_entry(|root, own, recorder| {
            write::create_folder(root, own, recorder, folder.as_deref(), &name)
        })
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

fn unknown_version() -> AppError {
    AppError::new(
        ErrorKind::NotFound,
        "This version is no longer in the page's history.",
    )
}

/// What is at `relative` in the world at `root` now, for history's recovery. A path that
/// confinement refuses, or that cannot be read, counts as absent.
fn state_on_disk(root: &Path, relative: &str) -> history::State {
    if let Ok(page) = paths::existing_page(root, relative) {
        return fs::read(page).map_or(history::State::Absent, history::State::Page);
    }
    if paths::existing_folder(root, Some(relative)).is_ok() {
        history::State::Folder
    } else {
        history::State::Absent
    }
}

/// The time in seconds since the Unix epoch.
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
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
                .write_page("Places/Saltmere.md", "# Saltmere\n", "any", false)
                .unwrap_err()
                .kind,
            ErrorKind::NoWorld
        );
        assert_eq!(
            state
                .create_entry(|root, own, recorder| write::create_page(
                    root, own, recorder, None, "New"
                ))
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
                .write_page("Places/Saltmere.md", "mine\n", &version, false)
                .map(drop),
            state.restore_page("Places/Saltmere.md", "mine\n").map(drop),
            state
                .create_entry(|root, own, recorder| {
                    write::create_page(root, own, recorder, None, "New")
                })
                .map(drop),
            state
                .create_entry(|root, own, recorder| {
                    write::create_folder(root, own, recorder, None, "New")
                })
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
            .write_page(
                "Places/Saltmere.md",
                "# Saltmere harbour\n",
                &page.version,
                false,
            )
            .unwrap();
        state
            .create_entry(|root, own, recorder| {
                write::create_page(root, own, recorder, Some("Places"), "Kesh Tor")
            })
            .unwrap();
        state
            .create_entry(|root, own, recorder| {
                write::create_folder(root, own, recorder, None, "Factions")
            })
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
            .create_entry(|root, own, recorder| {
                write::create_page(root, own, recorder, Some("Places"), "Kesh Tor")
            })
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
            .write_page(
                "Places/Saltmere.md",
                "# Saltmere harbour\n",
                &page.version,
                false,
            )
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

    mod history {
        use super::*;
        use crate::history::testing::{file, stored};
        use crate::history::{Entry, State};

        /// A world state launched with `app_data`, whose events go to the returned receiver.
        fn launched_and_watched(app_data: &TempDir) -> (WorldState, mpsc::Receiver<WorldEvent>) {
            let (state, events) = watched();
            state.load_recent(app_data.path());
            (state, events)
        }

        /// The history events sent so far, in order. They are sent while a command runs, so they
        /// are all there when it returns.
        fn history_events(events: &mpsc::Receiver<WorldEvent>) -> Vec<WorldEvent> {
            events
                .try_iter()
                .filter(|event| event.name().starts_with("world:history-"))
                .collect()
        }

        /// Saves `text` over the Saltmere page of the open world.
        fn save(state: &WorldState, text: &str) {
            let page = state.read_page("Places/Saltmere.md").unwrap();
            state
                .write_page("Places/Saltmere.md", text, &page.version, false)
                .unwrap();
        }

        #[test]
        fn a_save_through_the_world_state_records_the_bytes_it_replaced() {
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let state = launched(&app_data);
            state.open(world.path().to_path_buf()).unwrap();

            save(&state, "# Saltmere harbour\n");

            let changes = stored(app_data.path(), world.path());
            assert_eq!(changes.len(), 1);
            assert_eq!(changes[0].kind, "edit");
            assert!(!changes[0].pending);
            assert_eq!(
                changes[0].entries[0].entry,
                Entry {
                    path: "Places/Saltmere.md".to_owned(),
                    before: State::Page("\u{feff}# Saltmere\r\n".into()),
                    after: State::Page("\u{feff}# Saltmere harbour\r\n".into()),
                }
            );
            // The world folder gains nothing of the application's.
            assert_eq!(fs::read_dir(world.path()).unwrap().count(), 2);
        }

        #[test]
        fn opening_tells_the_interface_about_a_damaged_and_a_newer_history() {
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let database = file(app_data.path(), world.path());
            fs::create_dir_all(database.parent().unwrap()).unwrap();
            fs::write(&database, [7u8; 4096]).unwrap();
            let (state, events) = launched_and_watched(&app_data);

            let damaged = state.open(world.path().to_path_buf()).unwrap().session;
            assert_eq!(
                history_events(&events),
                [WorldEvent::HistorySetAside { session: damaged }]
            );
            state.close();

            let connection = rusqlite::Connection::open(&database).unwrap();
            connection.pragma_update(None, "user_version", 2).unwrap();
            drop(connection);
            let newer = state.open(world.path().to_path_buf()).unwrap().session;
            assert_eq!(
                history_events(&events),
                [WorldEvent::HistoryNotRecording {
                    session: newer,
                    message: "The history database is in a newer format than this version of \
                              Grimoire.md knows."
                        .to_owned(),
                }]
            );
            // Writes still go ahead.
            save(&state, "# Saltmere harbour\n");
            assert!(history_events(&events).is_empty());
        }

        #[cfg(unix)]
        #[test]
        fn a_failing_then_working_history_says_so_once_each_way() {
            use std::os::unix::fs::PermissionsExt;
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let (state, events) = launched_and_watched(&app_data);
            let session = state.open(world.path().to_path_buf()).unwrap().session;
            let folder = file(app_data.path(), world.path())
                .parent()
                .unwrap()
                .to_path_buf();

            fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
            save(&state, "# One\n");
            save(&state, "# Two\n");
            fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
            save(&state, "# Three\n");
            save(&state, "# Four\n");

            assert_eq!(
                history_events(&events),
                [
                    WorldEvent::HistoryNotRecording {
                        session,
                        message: "The history database cannot be written.".to_owned(),
                    },
                    WorldEvent::HistoryRecording { session },
                ]
            );
        }

        #[test]
        fn a_world_removed_from_the_recent_list_keeps_its_history() {
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let state = launched(&app_data);
            state.open(world.path().to_path_buf()).unwrap();
            save(&state, "# Saltmere harbour\n");
            let id = state.lock().world.as_ref().unwrap().recent_id.clone();
            state.close();

            state.remove_recent(&id.unwrap());
            state.open(world.path().to_path_buf()).unwrap();

            assert_eq!(stored(app_data.path(), world.path()).len(), 1);
        }

        const SALTMERE: &str = "Places/Saltmere.md";

        fn ids(versions: &[HistoryVersion]) -> Vec<&str> {
            versions.iter().map(|version| version.id.as_str()).collect()
        }

        #[test]
        fn the_list_leaves_out_the_newest_versions_the_page_holds_and_compares_from_a_version() {
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let state = launched(&app_data);
            state.open(world.path().to_path_buf()).unwrap();
            assert!(state.history_list(SALTMERE).unwrap().is_empty());
            save(&state, "# Saltmere harbour\n");

            let versions = state.history_list(SALTMERE).unwrap();
            let lines = state
                .history_compare(SALTMERE, "1-before", "# Saltmere harbour\n")
                .unwrap();

            // The edit's text is the page on disk, so only the text before it is listed.
            assert_eq!(ids(&versions), ["1-before"]);
            assert_eq!(
                serde_json::to_value(&versions[0]).unwrap(),
                json!({ "id": "1-before", "kind": "outside", "at": versions[0].at })
            );
            assert_eq!(
                serde_json::to_value(&lines).unwrap(),
                json!([
                    { "kind": "removed", "text": "# Saltmere" },
                    { "kind": "added", "text": "# Saltmere harbour" },
                ])
            );
            assert_eq!(
                state
                    .history_compare(SALTMERE, "9-after", "")
                    .unwrap_err()
                    .kind,
                ErrorKind::NotFound
            );
            // Another tool writes the edit's text back as it was: the edit is listed again.
            fs::write(world.path().join(SALTMERE), "# Other\n").unwrap();
            assert_eq!(
                ids(&state.history_list(SALTMERE).unwrap()),
                ["1-after", "1-before"]
            );
        }

        #[test]
        fn after_a_relaunch_the_list_still_holds_the_versions_and_restoring_one_writes_its_bytes() {
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let state = launched(&app_data);
            state.open(world.path().to_path_buf()).unwrap();
            save(&state, "# Saltmere harbour\n");
            state.close();
            drop(state);

            let relaunched = launched(&app_data);
            relaunched.open(world.path().to_path_buf()).unwrap();
            let versions = relaunched.history_list(SALTMERE).unwrap();
            let page = relaunched.read_page(SALTMERE).unwrap();
            let restored = relaunched
                .history_restore(SALTMERE, &versions[0].id, &page.version)
                .unwrap();

            assert_eq!(
                fs::read(world.path().join(SALTMERE)).unwrap(),
                "\u{feff}# Saltmere\r\n".as_bytes()
            );
            assert_eq!(restored.text, "# Saltmere\n");
            assert_eq!(restored.change.as_deref(), Some("2"));
            assert_eq!(
                relaunched
                    .history_restore(SALTMERE, "9-after", &restored.version)
                    .unwrap_err()
                    .kind,
                ErrorKind::NotFound
            );
            let undone = relaunched.history_undo("2").unwrap();
            assert_eq!(undone.text, "# Saltmere harbour\n");
        }

        #[test]
        fn an_opening_without_a_history_says_why_its_history_cannot_be_read() {
            let state = WorldState::default();
            let world = world();
            state.open(world.path().to_path_buf()).unwrap();

            let error = state.history_list(SALTMERE).unwrap_err();

            assert_eq!(error.kind, ErrorKind::Io);
            assert_eq!(error.message, NO_APP_DATA);
        }

        #[cfg(unix)]
        #[test]
        fn while_history_is_not_recording_a_restore_still_writes_and_names_no_change() {
            use std::os::unix::fs::PermissionsExt;
            let app_data = tempfile::tempdir().unwrap();
            let world = world();
            let state = launched(&app_data);
            state.open(world.path().to_path_buf()).unwrap();
            save(&state, "# Saltmere harbour\n");
            let folder = file(app_data.path(), world.path())
                .parent()
                .unwrap()
                .to_path_buf();

            fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
            let page = state.read_page(SALTMERE).unwrap();
            let restored = state.history_restore(SALTMERE, "1-before", &page.version);
            fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();

            let restored = restored.unwrap();
            assert_eq!(restored.change, None);
            assert_eq!(
                fs::read(world.path().join(SALTMERE)).unwrap(),
                "\u{feff}# Saltmere\r\n".as_bytes()
            );
        }

        #[test]
        fn a_moved_world_starts_an_empty_history_and_leaves_the_old_one_unchanged() {
            let app_data = tempfile::tempdir().unwrap();
            let parent = tempfile::tempdir().unwrap();
            let (old, new) = (parent.path().join("Kesh"), parent.path().join("Kesh moved"));
            fs::create_dir_all(old.join("Places")).unwrap();
            fs::write(old.join("Places/Saltmere.md"), "# Saltmere\n").unwrap();
            let state = launched(&app_data);
            state.open(old.clone()).unwrap();
            save(&state, "# Saltmere harbour\n");
            state.close();
            let old_history = fs::read(file(app_data.path(), &old)).unwrap();

            fs::rename(&old, &new).unwrap();
            state.open(new.clone()).unwrap();

            assert!(stored(app_data.path(), &new).is_empty());
            assert_eq!(fs::read(file(app_data.path(), &old)).unwrap(), old_history);
        }
    }
}
