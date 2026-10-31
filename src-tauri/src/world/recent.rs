//! The application's own data: the recent worlds, the last open world and each recent world's
//! workspace, in `<app data dir>/grimoire-data/worlds.json`.
//!
//! The file is one JSON document, `{ "format": 1, "nextId", "lastOpen", "worlds" }`. A missing or
//! unreadable file, or one in another format, loads as an empty list and is replaced on the next
//! save. Nothing is ever written at the root of the app data folder, where the webview keeps its
//! profile.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const FORMAT: u32 = 1;
/// How many worlds the list keeps. The world opened longest ago drops off first.
const MAX_WORLDS: usize = 10;
/// The file tree's default width in pixels, as in `src/ui/Shell.tsx`.
const DEFAULT_TREE_WIDTH: u32 = 264;

/// The open tabs in order, the active tab, the expanded folders and the tree width of a world.
/// Paths are relative to the world.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<String>,
    pub active: Option<String>,
    pub expanded: Vec<String>,
    pub tree_width: u32,
}

impl Default for Workspace {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            active: None,
            expanded: Vec::new(),
            tree_width: DEFAULT_TREE_WIDTH,
        }
    }
}

/// A recent world as the welcome screen and the world menu show it.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RecentWorld {
    id: String,
    name: String,
    path: String,
    /// No folder exists at `path` any more.
    missing: bool,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    format: u32,
    /// The number in the next new world's id. Ids are never reused.
    next_id: u64,
    /// The id of the world that was open when the application last closed.
    last_open: Option<String>,
    /// Most recently opened first.
    worlds: Vec<StoredWorld>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            format: FORMAT,
            next_id: 1,
            last_open: None,
            worlds: Vec::new(),
        }
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorld {
    id: String,
    /// The folder as the folder dialog returned it. The same string is the same world.
    path: String,
    name: String,
    /// Seconds since the Unix epoch.
    last_opened: u64,
    workspace: Workspace,
}

/// The recent worlds. Every change is saved at once. Without a file (`Default`), the list lives
/// only in memory.
#[derive(Debug, Default)]
pub struct Recent {
    file: Option<PathBuf>,
    document: Document,
}

impl Recent {
    /// Loads the list kept in `app_data_dir`, or an empty one when it cannot be read.
    pub fn load(app_data_dir: &Path) -> Self {
        let file = app_data_dir.join("grimoire-data").join("worlds.json");
        let document = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Document>(&bytes).ok())
            .filter(|document| document.format == FORMAT)
            .map(|mut document| {
                document.worlds.truncate(MAX_WORLDS);
                document
            })
            .unwrap_or_default();
        Self {
            file: Some(file),
            document,
        }
    }

    /// Records that the folder at `root` opened as the world `name`: it moves to the top of the
    /// list, or joins it there, and becomes the last open world. Returns its id, or `None` for a
    /// path that is not valid Unicode, which JSON cannot hold.
    pub fn opened(&mut self, root: &Path, name: &str) -> Option<String> {
        let path = root.to_str()?;
        let worlds = &mut self.document.worlds;
        let mut world = match worlds.iter().position(|world| world.path == path) {
            Some(index) => worlds.remove(index),
            None => {
                let id = self.document.next_id.to_string();
                self.document.next_id += 1;
                StoredWorld {
                    id,
                    path: path.to_owned(),
                    name: name.to_owned(),
                    last_opened: 0,
                    workspace: Workspace::default(),
                }
            }
        };
        world.name = name.to_owned();
        world.last_opened = now();
        let id = world.id.clone();
        worlds.insert(0, world);
        // A world that drops off takes its workspace with it.
        worlds.truncate(MAX_WORLDS);
        self.document.last_open = Some(id.clone());
        self.save();
        Some(id)
    }

    /// Records that the user closed the world, so the next launch shows the welcome screen.
    pub fn closed(&mut self) {
        if self.document.last_open.take().is_some() {
            self.save();
        }
    }

    /// Forgets a world and its workspace. Nothing in its folder changes.
    pub fn remove(&mut self, id: &str) {
        self.document.worlds.retain(|world| world.id != id);
        if self.document.last_open.as_deref() == Some(id) {
            self.document.last_open = None;
        }
        self.save();
    }

    /// The recent worlds except `open`, the open world's id, most recently opened first.
    pub fn list(&self, open: Option<&str>) -> Vec<RecentWorld> {
        self.document
            .worlds
            .iter()
            .filter(|world| Some(world.id.as_str()) != open)
            .map(|world| RecentWorld {
                id: world.id.clone(),
                name: world.name.clone(),
                path: world.path.clone(),
                missing: !Path::new(&world.path).is_dir(),
            })
            .collect()
    }

    pub fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.find(id).map(|world| PathBuf::from(&world.path))
    }

    /// The folder of the world that was open when the application last closed.
    pub fn last_open(&self) -> Option<PathBuf> {
        self.path_of(self.document.last_open.as_deref()?)
    }

    /// The folder that holds the most recently opened world.
    pub fn latest_parent(&self) -> Option<PathBuf> {
        let latest = self.document.worlds.first()?;
        Path::new(&latest.path).parent().map(PathBuf::from)
    }

    pub fn workspace(&self, id: &str) -> Option<Workspace> {
        self.find(id).map(|world| world.workspace.clone())
    }

    pub fn set_workspace(&mut self, id: &str, workspace: Workspace) {
        let Some(world) = self.document.worlds.iter_mut().find(|world| world.id == id) else {
            return;
        };
        if world.workspace != workspace {
            world.workspace = workspace;
            self.save();
        }
    }

    fn find(&self, id: &str) -> Option<&StoredWorld> {
        self.document.worlds.iter().find(|world| world.id == id)
    }

    /// The list is a convenience: a world still opens when it cannot be stored, so a failed save
    /// is reported on standard error and changes nothing else.
    fn save(&self) {
        let Some(file) = &self.file else { return };
        let result = serde_json::to_vec_pretty(&self.document)
            .map_err(io::Error::other)
            .and_then(|bytes| write_atomically(file, &bytes));
        if let Err(error) = result {
            eprintln!("Grimoire.md could not save its recent worlds: {error}");
        }
    }
}

/// Writes `bytes` to a temporary file next to `file` and then renames it over `file`, so the file
/// always holds either its old or its new content. Creates the folder if needed.
fn write_atomically(file: &Path, bytes: &[u8]) -> io::Result<()> {
    let folder = file.parent().expect("the data file is inside a folder");
    fs::create_dir_all(folder)?;
    let temporary = folder.join(format!(".worlds.json.{}.tmp", process::id()));
    let result = File::create(&temporary)
        .and_then(|mut out| {
            out.write_all(bytes)?;
            out.sync_all()
        })
        .and_then(|()| fs::rename(&temporary, file));
    if result.is_err() {
        // The failure being reported matters more than one that removing the file might add.
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tempfile::TempDir;

    fn data_file(app_data: &TempDir) -> PathBuf {
        app_data.path().join("grimoire-data").join("worlds.json")
    }

    fn stored(app_data: &TempDir) -> Value {
        serde_json::from_slice(&fs::read(data_file(app_data)).unwrap()).unwrap()
    }

    /// `count` world folders named `World 1` … in one temporary folder.
    fn worlds(count: usize) -> (TempDir, Vec<PathBuf>) {
        let parent = tempfile::tempdir().unwrap();
        let roots = (1..=count)
            .map(|number| {
                let root = parent.path().join(format!("World {number}"));
                fs::create_dir(&root).unwrap();
                root
            })
            .collect();
        (parent, roots)
    }

    fn names(recent: &Recent) -> Vec<String> {
        recent
            .list(None)
            .into_iter()
            .map(|world| world.name)
            .collect()
    }

    fn names_except(recent: &Recent, open: &str) -> Vec<String> {
        recent
            .list(Some(open))
            .into_iter()
            .map(|world| world.name)
            .collect()
    }

    #[test]
    fn the_list_is_saved_in_its_format_under_grimoire_data_and_loads_again() {
        let app_data = tempfile::tempdir().unwrap();
        let (_parent, roots) = worlds(1);
        let mut recent = Recent::load(app_data.path());

        let id = recent.opened(&roots[0], "World 1").unwrap();
        let workspace = Workspace {
            tabs: vec!["Places/Kesh Tor.md".into()],
            active: Some("Places/Kesh Tor.md".into()),
            expanded: vec!["Places".into()],
            tree_width: 300,
        };
        recent.set_workspace(&id, workspace.clone());

        // Only the data file, inside grimoire-data/, with no temporary file left beside it.
        let entries: Vec<_> = fs::read_dir(app_data.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, ["grimoire-data"]);
        assert_eq!(
            fs::read_dir(app_data.path().join("grimoire-data"))
                .unwrap()
                .count(),
            1
        );
        let document = stored(&app_data);
        assert_eq!(document["format"], 1);
        assert_eq!(document["nextId"], 2);
        assert_eq!(document["lastOpen"], json!(id));
        assert_eq!(
            document["worlds"][0]["path"],
            json!(roots[0].to_str().unwrap())
        );
        assert_eq!(document["worlds"][0]["workspace"]["treeWidth"], 300);
        assert!(document["worlds"][0]["lastOpened"].as_u64().unwrap() > 0);

        let loaded = Recent::load(app_data.path());
        assert_eq!(loaded.document, recent.document);
        assert_eq!(loaded.workspace(&id), Some(workspace));
        assert_eq!(loaded.last_open(), Some(roots[0].clone()));
    }

    #[test]
    fn unreadable_data_loads_as_an_empty_list_and_the_next_save_replaces_it() {
        let (_parent, roots) = worlds(1);
        for content in [
            b"\xff\xfe not text".as_slice(),
            b"{ \"format\": 1, \"worlds\": [",
            br#"{ "format": 2, "nextId": 1, "lastOpen": null, "worlds": [] }"#,
            br#"{ "format": 1, "worlds": "none" }"#,
        ] {
            let app_data = tempfile::tempdir().unwrap();
            fs::create_dir(app_data.path().join("grimoire-data")).unwrap();
            fs::write(data_file(&app_data), content).unwrap();

            let mut recent = Recent::load(app_data.path());
            assert!(recent.list(None).is_empty());
            assert_eq!(recent.last_open(), None);

            recent.opened(&roots[0], "World 1");
            assert_eq!(stored(&app_data)["format"], 1);
            assert_eq!(Recent::load(app_data.path()).list(None).len(), 1);
        }
    }

    #[test]
    fn a_missing_file_loads_as_an_empty_list() {
        let app_data = tempfile::tempdir().unwrap();

        let recent = Recent::load(app_data.path());

        assert!(recent.list(None).is_empty());
        assert!(!app_data.path().join("grimoire-data").exists());
    }

    #[test]
    fn opening_moves_a_world_to_the_top_and_keeps_its_id() {
        let mut recent = Recent::default();
        let (_parent, roots) = worlds(3);
        let first = recent.opened(&roots[0], "World 1").unwrap();
        recent.opened(&roots[1], "World 2");
        recent.opened(&roots[2], "World 3");

        let again = recent.opened(&roots[0], "World 1").unwrap();

        assert_eq!(again, first);
        assert_eq!(names(&recent), ["World 1", "World 3", "World 2"]);
        assert_eq!(recent.last_open(), Some(roots[0].clone()));
        assert_eq!(recent.latest_parent(), roots[0].parent().map(PathBuf::from));
    }

    #[test]
    fn the_list_keeps_ten_worlds_and_one_that_drops_off_loses_its_workspace() {
        let mut recent = Recent::default();
        let (_parent, roots) = worlds(11);
        let oldest = recent.opened(&roots[0], "World 1").unwrap();
        let workspace = Workspace {
            tree_width: 300,
            ..Workspace::default()
        };
        recent.set_workspace(&oldest, workspace);
        for (number, root) in roots.iter().enumerate().skip(1) {
            recent.opened(root, &format!("World {}", number + 1));
        }

        assert_eq!(recent.list(None).len(), 10);
        assert_eq!(names(&recent).last().unwrap(), "World 2");
        assert_eq!(recent.workspace(&oldest), None);

        // Opened again, it is a new entry with a new id and the default workspace.
        let back = recent.opened(&roots[0], "World 1").unwrap();
        assert_ne!(back, oldest);
        assert_eq!(recent.workspace(&back), Some(Workspace::default()));
    }

    #[test]
    fn removing_forgets_the_world_and_changes_nothing_on_disk() {
        let mut recent = Recent::default();
        let (_parent, roots) = worlds(2);
        fs::write(roots[0].join("Saltmere.md"), "# Saltmere\n").unwrap();
        let first = recent.opened(&roots[0], "World 1").unwrap();
        recent.opened(&roots[1], "World 2");
        recent.opened(&roots[0], "World 1");

        recent.remove(&first);

        assert_eq!(names(&recent), ["World 2"]);
        assert_eq!(recent.path_of(&first), None);
        assert_eq!(recent.last_open(), None);
        assert_eq!(fs::read_dir(&roots[0]).unwrap().count(), 1);
    }

    #[test]
    fn a_world_whose_folder_is_gone_is_listed_as_missing() {
        let mut recent = Recent::default();
        let (_parent, roots) = worlds(2);
        recent.opened(&roots[0], "World 1");
        let open = recent.opened(&roots[1], "World 2").unwrap();
        fs::remove_dir(&roots[0]).unwrap();

        assert_eq!(
            recent.list(None),
            [
                RecentWorld {
                    id: open.clone(),
                    name: "World 2".into(),
                    path: roots[1].to_str().unwrap().into(),
                    missing: false,
                },
                RecentWorld {
                    id: "1".into(),
                    name: "World 1".into(),
                    path: roots[0].to_str().unwrap().into(),
                    missing: true,
                },
            ]
        );
        // The open world is left out of the list the world menu shows.
        assert_eq!(names_except(&recent, &open), ["World 1"]);
    }

    #[test]
    fn closing_clears_the_last_open_world() {
        let app_data = tempfile::tempdir().unwrap();
        let (_parent, roots) = worlds(1);
        let mut recent = Recent::load(app_data.path());
        recent.opened(&roots[0], "World 1");

        recent.closed();

        assert_eq!(recent.last_open(), None);
        assert_eq!(stored(&app_data)["lastOpen"], Value::Null);
        assert_eq!(names(&recent), ["World 1"]);
    }
}
