//! The file watcher: tells the interface what changed in the open world's folder outside the
//! application.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt,
};
use serde::Serialize;

use super::paths::{is_allowed_name, is_page_name};

/// How long the folder must be quiet before a burst of changes is reported as one batch.
const SETTLE_TIME: Duration = Duration::from_millis(500);

/// What the watcher, and the world's history, tell the interface. Each event carries the session of
/// the opening it belongs to, so the interface can ignore events from a world that is no longer
/// open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum WorldEvent {
    /// Entries were created, removed or renamed (`tree`), or pages changed (`pages`, by path).
    Changed {
        session: u64,
        tree: bool,
        pages: Vec<String>,
    },
    /// The world's folder is gone.
    Missing { session: u64 },
    /// The watcher could not start or stopped working.
    WatchFailed { session: u64, message: String },
    /// The world's changes are not being recorded in its history, for the reason in `message`.
    HistoryNotRecording { session: u64, message: String },
    /// The world's changes are being recorded again.
    HistoryRecording { session: u64 },
    /// The world's history database was damaged, so it was set aside and a new one started.
    HistorySetAside { session: u64 },
    /// The page index was built, or what it holds changed.
    IndexChanged { session: u64 },
    /// The page index cannot be built, because the world cannot be listed, for the reason in
    /// `message`.
    IndexFailed { session: u64, message: String },
}

impl WorldEvent {
    /// The name the interface listens to.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Changed { .. } => "world:changed",
            Self::Missing { .. } => "world:missing",
            Self::WatchFailed { .. } => "world:watch-failed",
            Self::HistoryNotRecording { .. } => "world:history-not-recording",
            Self::HistoryRecording { .. } => "world:history-recording",
            Self::HistorySetAside { .. } => "world:history-set-aside",
            Self::IndexChanged { .. } => "world:index-changed",
            Self::IndexFailed { .. } => "world:index-failed",
        }
    }
}

/// Where the watcher sends its events; in the application, to the webview.
pub type EventSink = Arc<dyn Fn(WorldEvent) + Send + Sync>;

/// What one batch of outside changes means for the interface.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changes {
    /// Whether the tree may have changed: an entry other than a non-Markdown file was created,
    /// removed or renamed.
    pub tree: bool,
    /// The pages that changed, were created or removed, or were renamed (both names).
    pub pages: Vec<String>,
}

/// A running watcher. Dropping it stops it without waiting, so it can be dropped while the world
/// lock is held: a batch it is still handling finds that its world is no longer open.
pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

/// Starts watching the world at `root` for the opening `session`. `changes_of` turns each batch
/// into changes, or returns `None` once the world of `session` is no longer open. A watcher that
/// cannot start sends `world:watch-failed` and returns `None`; the world still opens.
pub fn start(
    root: &Path,
    session: u64,
    sink: EventSink,
    mut changes_of: impl FnMut(&[DebouncedEvent]) -> Option<Changes> + Send + 'static,
) -> Option<Watcher> {
    let watched = root.to_path_buf();
    let send = Arc::clone(&sink);
    let mut missing_sent = false;
    let mut failure_sent = false;
    let handler = move |result: DebounceEventResult| match result {
        Ok(events) => {
            let Some(changes) = changes_of(&events) else {
                return;
            };
            if changes.tree || !changes.pages.is_empty() {
                send(WorldEvent::Changed {
                    session,
                    tree: changes.tree,
                    pages: changes.pages,
                });
            }
            // The root may be a link the user picked, so `is_dir` follows it.
            if !missing_sent && !watched.is_dir() {
                missing_sent = true;
                send(WorldEvent::Missing { session });
            }
        }
        Err(errors) => {
            if !failure_sent {
                failure_sent = true;
                let message = errors.first().map_or_else(
                    || "The file watcher stopped.".to_owned(),
                    ToString::to_string,
                );
                send(WorldEvent::WatchFailed { session, message });
            }
        }
    };
    // Neither the watcher nor a file-ID cache may follow links out of the world: notify follows
    // them by default, and the debouncer's `FileIdMap`, its default on Windows and macOS, walks the
    // tree following links. Without that cache, a rename may arrive as separate From and To events,
    // which `changes` handles alike.
    let config = notify::Config::default().with_follow_symlinks(false);
    let started = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        SETTLE_TIME,
        None,
        handler,
        NoCache::new(),
        config,
    )
    .and_then(|mut debouncer| {
        debouncer.watch(root, RecursiveMode::Recursive)?;
        Ok(debouncer)
    });
    match started {
        Ok(debouncer) => Some(Watcher {
            _debouncer: debouncer,
        }),
        Err(error) => {
            sink(WorldEvent::WatchFailed {
                session,
                message: error.to_string(),
            });
            None
        }
    }
}

/// The changes a batch of `events` in the world at `root` reports to the interface. It leaves out
/// reads and metadata changes, every path with a segment that confinement refuses (which covers
/// `.obsidian` and the write path's temporary files), and every path for which `is_own` says that
/// it still holds what the application last wrote there.
pub fn changes(
    root: &Path,
    events: &[DebouncedEvent],
    mut is_own: impl FnMut(&str) -> bool,
) -> Changes {
    let mut changes = Changes::default();
    for event in events {
        let structural = match event.kind {
            EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_)) => continue,
            EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Create(_)
            | EventKind::Remove(_) => true,
            EventKind::Modify(_) => false,
            EventKind::Any | EventKind::Other => true,
        };
        // The back end could not keep up, so anything may have changed.
        if event.need_rescan() {
            changes.tree = true;
        }
        let known_file = matches!(
            event.kind,
            EventKind::Create(CreateKind::File) | EventKind::Remove(RemoveKind::File)
        );
        for path in &event.paths {
            let Some(relative) = relative_path(root, path) else {
                continue;
            };
            if is_own(&relative) {
                continue;
            }
            let page = is_page_name(&relative);
            // A path of unknown kind may be a folder, so it counts unless it is a page's.
            if structural && (page || !known_file) {
                changes.tree = true;
            }
            if page && !changes.pages.contains(&relative) {
                changes.pages.push(relative);
            }
        }
    }
    changes
}

/// `path` relative to `root` with `/` separators, if it is inside the world and every segment is
/// one that confinement accepts, so the tree can list it.
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let segments: Vec<&str> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| component.as_os_str().to_str())
        .collect::<Option<_>>()?;
    if segments.is_empty() || !segments.iter().all(|segment| is_allowed_name(segment)) {
        return None;
    }
    Some(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, Flag, MetadataKind, RenameMode};
    use notify::{Event, event::AccessKind};
    use std::path::PathBuf;
    use std::time::Instant;

    fn root() -> PathBuf {
        PathBuf::from("/worlds/Kesh")
    }

    fn event(kind: EventKind, paths: &[&str]) -> DebouncedEvent {
        let event = paths.iter().fold(Event::new(kind), |event, path| {
            event.add_path(root().join(path))
        });
        DebouncedEvent::new(event, Instant::now())
    }

    fn none_own(_: &str) -> bool {
        false
    }

    fn pages(list: &[&str]) -> Vec<String> {
        list.iter().map(|page| page.to_string()).collect()
    }

    const CREATE_FILE: EventKind = EventKind::Create(CreateKind::File);
    const WRITE: EventKind = EventKind::Modify(ModifyKind::Data(DataChange::Content));

    #[test]
    fn a_page_whose_content_changed_is_a_page_change_without_a_tree_change() {
        let changes = changes(&root(), &[event(WRITE, &["Places/Kesh Tor.md"])], none_own);

        assert_eq!(
            changes,
            Changes {
                tree: false,
                pages: pages(&["Places/Kesh Tor.md"])
            }
        );
    }

    #[test]
    fn hidden_paths_and_temporary_files_are_left_out() {
        let batch = [
            event(WRITE, &[".obsidian/workspace.json"]),
            event(CREATE_FILE, &[".obsidian/plugins/note.md"]),
            event(CREATE_FILE, &["Places/.Kesh Tor.md.4242-7.tmp"]),
            event(EventKind::Remove(RemoveKind::Folder), &[".trash"]),
        ];

        assert_eq!(changes(&root(), &batch, none_own), Changes::default());
    }

    #[test]
    fn non_markdown_files_change_neither_the_tree_nor_the_pages() {
        let batch = [
            event(CREATE_FILE, &["Places/map.png"]),
            event(WRITE, &["Places/map.png"]),
            event(EventKind::Remove(RemoveKind::File), &["notes.txt"]),
        ];

        assert_eq!(changes(&root(), &batch, none_own), Changes::default());
    }

    #[test]
    fn creating_removing_and_renaming_pages_and_folders_changes_the_tree() {
        let folder = changes(
            &root(),
            &[event(EventKind::Create(CreateKind::Folder), &["Coast"])],
            none_own,
        );
        let removed = changes(
            &root(),
            &[event(EventKind::Remove(RemoveKind::File), &["Overview.md"])],
            none_own,
        );

        assert_eq!(
            folder,
            Changes {
                tree: true,
                pages: vec![]
            }
        );
        assert_eq!(
            removed,
            Changes {
                tree: true,
                pages: pages(&["Overview.md"])
            }
        );
    }

    #[test]
    fn both_names_of_a_rename_are_kept_whether_it_arrives_whole_or_in_halves() {
        let rename = |mode| EventKind::Modify(ModifyKind::Name(mode));
        let whole = [event(
            rename(RenameMode::Both),
            &["Old.md", "Places/New.md"],
        )];
        let halves = [
            event(rename(RenameMode::From), &["Old.md"]),
            event(rename(RenameMode::To), &["Places/New.md"]),
        ];

        for batch in [&whole[..], &halves[..]] {
            assert_eq!(
                changes(&root(), batch, none_own),
                Changes {
                    tree: true,
                    pages: pages(&["Old.md", "Places/New.md"])
                }
            );
        }
    }

    #[test]
    fn reads_and_metadata_changes_are_left_out() {
        let batch = [
            event(EventKind::Access(AccessKind::Any), &["Overview.md"]),
            event(
                EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
                &["Overview.md"],
            ),
        ];

        assert_eq!(changes(&root(), &batch, none_own), Changes::default());
    }

    #[test]
    fn the_application_s_own_writes_are_left_out_and_outside_ones_kept() {
        // A save renames the temporary file over the page; an outside program wrote another page.
        let batch = [
            event(
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                &[".Overview.md.4242-1.tmp", "Overview.md"],
            ),
            event(WRITE, &["Places/Kesh Tor.md"]),
        ];

        let changes = changes(&root(), &batch, |path| path == "Overview.md");

        assert_eq!(
            changes,
            Changes {
                tree: false,
                pages: pages(&["Places/Kesh Tor.md"])
            }
        );
    }

    #[test]
    fn a_page_reported_twice_is_listed_once_and_a_rescan_changes_the_tree() {
        let rescan = DebouncedEvent::new(
            Event::new(EventKind::Other).set_flag(Flag::Rescan),
            Instant::now(),
        );
        let batch = [
            event(WRITE, &["Overview.md"]),
            event(WRITE, &["Overview.md"]),
            rescan,
        ];

        assert_eq!(
            changes(&root(), &batch, none_own),
            Changes {
                tree: true,
                pages: pages(&["Overview.md"])
            }
        );
    }

    #[test]
    fn events_on_the_root_itself_or_outside_it_are_left_out() {
        let outside = DebouncedEvent::new(
            Event::new(WRITE).add_path(PathBuf::from("/elsewhere/Secret.md")),
            Instant::now(),
        );
        let batch = [event(EventKind::Remove(RemoveKind::Folder), &[""]), outside];

        assert_eq!(changes(&root(), &batch, none_own), Changes::default());
    }

    #[test]
    fn events_serialize_to_their_payload_under_their_name() {
        let changed = WorldEvent::Changed {
            session: 3,
            tree: true,
            pages: pages(&["Overview.md"]),
        };
        let failed = WorldEvent::WatchFailed {
            session: 3,
            message: "limit reached".to_owned(),
        };

        assert_eq!(changed.name(), "world:changed");
        assert_eq!(
            serde_json::to_value(&changed).unwrap(),
            serde_json::json!({ "session": 3, "tree": true, "pages": ["Overview.md"] })
        );
        assert_eq!(WorldEvent::Missing { session: 3 }.name(), "world:missing");
        assert_eq!(failed.name(), "world:watch-failed");
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({ "session": 3, "message": "limit reached" })
        );
        let index_failed = WorldEvent::IndexFailed {
            session: 3,
            message: "Permission denied.".to_owned(),
        };
        assert_eq!(
            WorldEvent::IndexChanged { session: 3 }.name(),
            "world:index-changed"
        );
        assert_eq!(index_failed.name(), "world:index-failed");
        assert_eq!(
            serde_json::to_value(&index_failed).unwrap(),
            serde_json::json!({ "session": 3, "message": "Permission denied." })
        );
    }
}
