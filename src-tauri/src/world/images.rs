//! The world's images for the webview: what a page's image embeds resolve to, and the
//! `grimoire-image` scheme that serves the files. Embeds and requests are untrusted. Resolution
//! reads only folder listings, and can only ever name an image file the listing shows; the scheme
//! serves only such a file of the open world, through page confinement, and answers every other
//! request with an empty 404, so a refusal says nothing about what exists.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::time::UNIX_EPOCH;

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::http::{HeaderValue, Response, StatusCode, Uri, header};

use super::WorldState;
use super::paths::{self, image_type, is_allowed_name};
use crate::error::AppError;
use crate::index::resolve::{Table, folder_of, join};
use crate::order::path_order;

/// The scheme the webview loads the open world's images through.
pub const IMAGE_SCHEME: &str = "grimoire-image";
/// The largest image the scheme serves, so one request cannot hold the whole of a huge file.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// How an image embed is written: `![[target]]` or `![alt](target)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ImageForm {
    Wiki,
    Markdown,
}

/// An image embed of a page, as the interface found it: a wiki embed's target, or a Markdown
/// image's destination as written, without a size, alt text or title.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct ImageRequest {
    target: String,
    form: ImageForm,
}

/// What an image embed leads to.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ImageEmbed {
    /// The image file at `path`, relative to the world. `stamp` changes with the file's size or
    /// modification time, so a changed image gets a new URL.
    Found { path: String, stamp: String },
    /// No image of the world matches.
    Missing,
    /// The target is absolute, leads outside the world, or goes through a hidden segment, a
    /// symbolic link or a junction.
    Outside,
    /// The target is a web or `data:` address, which is never loaded.
    Web,
}

/// The world's image files, and what resolution must know about the links it does not follow.
#[derive(Debug, Default)]
struct ImageFiles {
    /// Each image file's path, relative to the world, and stamp, in the tree's order of paths.
    images: Vec<(String, String)>,
    /// The lowercase paths of the entries that are symbolic links or junctions, files or folders.
    links: HashSet<String>,
    /// The lowercase names of those entries that have an image extension.
    linked_names: HashSet<String>,
}

/// What each of `embeds` in the page at `from` resolves to, from the image files in the world at
/// `root` now. `from` is only used lexically, for its folder.
pub fn resolve(
    root: &Path,
    from: &str,
    embeds: &[ImageRequest],
) -> Result<Vec<ImageEmbed>, AppError> {
    let files = image_files(root)?;
    let table = Table::new(files.images.iter().map(|(path, _)| path.as_str()), []);
    let stamps: HashMap<&str, &str> = files
        .images
        .iter()
        .map(|(path, stamp)| (path.as_str(), stamp.as_str()))
        .collect();
    Ok(embeds
        .iter()
        .map(|embed| match resolve_one(&files, &table, from, embed) {
            Ok(path) => ImageEmbed::Found {
                stamp: stamps[path].to_owned(),
                path: path.to_owned(),
            },
            Err(embed) => embed,
        })
        .collect())
}

/// The listed image path that `request` names from the page at `from`, or what it is instead.
fn resolve_one<'a>(
    files: &ImageFiles,
    table: &'a Table,
    from: &str,
    request: &ImageRequest,
) -> Result<&'a str, ImageEmbed> {
    let target = match request.form {
        ImageForm::Wiki => Cow::Borrowed(request.target.as_str()),
        ImageForm::Markdown => {
            let target = request.target.as_str();
            let target = target
                .strip_prefix('<')
                .and_then(|target| target.strip_suffix('>'))
                .unwrap_or(target);
            percent_decode_str(target)
                .decode_utf8()
                .map_err(|_| ImageEmbed::Missing)?
        }
    };
    let lower = target.to_lowercase();
    if ["http:", "https:", "//", "data:"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return Err(ImageEmbed::Web);
    }
    let bytes = target.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if target.starts_with('/') || target.contains('\\') || drive {
        return Err(ImageEmbed::Outside);
    }
    let bare = !target.contains('/');
    let found = match request.form {
        ImageForm::Wiki => table.resolve(from, &target),
        ImageForm::Markdown if bare => table
            .at_path(from, &target)
            .or_else(|| table.resolve(from, &target)),
        ImageForm::Markdown => table.at_path(from, &target),
    };
    if let Some(path) = found {
        return Ok(path);
    }
    // The paths the target names lexically, as resolution tried them; `None` leaves the world.
    let candidates = match request.form {
        ImageForm::Wiki if target.starts_with("./") || target.starts_with("../") => {
            vec![join(folder_of(from), &target)]
        }
        ImageForm::Wiki if !bare => vec![join("", &target)],
        ImageForm::Wiki => vec![Some(target.clone().into_owned())],
        ImageForm::Markdown => vec![join(folder_of(from), &target), join("", &target)],
    };
    let outside = candidates.iter().all(Option::is_none)
        || candidates.iter().flatten().any(|path| files.refuses(path))
        || (bare && files.linked_names.contains(&lower));
    Err(if outside {
        ImageEmbed::Outside
    } else {
        ImageEmbed::Missing
    })
}

impl ImageFiles {
    /// Whether `path`, relative to the world, has a segment confinement refuses, such as a hidden
    /// one, or is or lies under an entry that is a link or junction.
    fn refuses(&self, path: &str) -> bool {
        if !path.split('/').all(is_allowed_name) {
            return true;
        }
        let path = path.to_lowercase();
        let folders = path.match_indices('/').map(|(end, _)| &path[..end]);
        folders
            .chain([path.as_str()])
            .any(|prefix| self.links.contains(prefix))
    }
}

/// Lists the image files of the world at `root`, as the tree lists pages: only names
/// `is_allowed_name` allows, with entry types from the directory entries themselves, so links and
/// junctions are recorded but never followed, and a subfolder the user may not read listed as
/// empty.
fn image_files(root: &Path) -> Result<ImageFiles, AppError> {
    paths::check_root(root)?;
    let mut files = ImageFiles::default();
    list_folder(root, None, &mut files)?;
    files.images.sort_by(|(a, _), (b, _)| path_order(a, b));
    Ok(files)
}

fn list_folder(folder: &Path, prefix: Option<&str>, files: &mut ImageFiles) -> io::Result<()> {
    let read_dir = match fs::read_dir(folder) {
        Err(error) if prefix.is_some() && error.kind() == io::ErrorKind::PermissionDenied => {
            return Ok(());
        }
        result => result?,
    };
    for entry in read_dir {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !is_allowed_name(&name) {
            continue;
        }
        let path = match prefix {
            Some(prefix) => format!("{prefix}/{name}"),
            None => name.clone(),
        };
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            if image_type(&name).is_some() {
                files.linked_names.insert(name.to_lowercase());
            }
            files.links.insert(path.to_lowercase());
        } else if file_type.is_dir() {
            list_folder(&entry.path(), Some(&path), files)?;
        } else if file_type.is_file() && image_type(&name).is_some() {
            // A file removed since the listing is left out.
            if let Ok(metadata) = entry.metadata() {
                files.images.push((path, stamp(&metadata)));
            }
        }
    }
    Ok(())
}

/// A file's size and modification time, as one string.
fn stamp(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    format!("{}-{modified}", metadata.len())
}

/// Answers a request of the image scheme. A panic answers as a refusal, so every request gets a
/// response.
pub fn respond(state: &WorldState, uri: &Uri) -> Response<Vec<u8>> {
    catch_unwind(AssertUnwindSafe(|| serve(state, uri.path()))).unwrap_or_else(|_| refused())
}

/// Serves the image at `uri_path`, `/<session>/<path relative to the world>` percent-encoded as
/// the interface's `convertFileSrc` gives it, when that session is the open world and the path is
/// an image file confinement allows. The file is checked and opened under the world lock, and read
/// after it is released, so a large image never holds up a save.
fn serve(state: &WorldState, uri_path: &str) -> Response<Vec<u8>> {
    let Some((file, content_type)) = open(state, uri_path) else {
        return refused();
    };
    let mut bytes = Vec::new();
    // The file may have grown since it was checked.
    match file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes) {
        Ok(read) if read as u64 <= MAX_IMAGE_BYTES => image(bytes, content_type),
        _ => refused(),
    }
}

/// The open image file a request names, and its content type, or `None` when it is refused.
fn open(state: &WorldState, uri_path: &str) -> Option<(File, &'static str)> {
    // Decoded exactly once: `%252e` stays the name `%2e`, never `.`.
    let decoded = percent_decode_str(uri_path.strip_prefix('/')?)
        .decode_utf8()
        .ok()?;
    let (session, relative) = decoded.split_once('/')?;
    if session.is_empty() || !session.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let session = session.parse().ok()?;
    let content_type = image_type(relative)?;
    let file = state
        .while_open(session, |root| {
            let file = File::open(paths::existing_image(root, relative).ok()?).ok()?;
            let metadata = file.metadata().ok()?;
            (metadata.is_file() && metadata.len() <= MAX_IMAGE_BYTES).then_some(file)
        })
        .flatten()?;
    Some((file, content_type))
}

fn image(bytes: Vec<u8>, content_type: &'static str) -> Response<Vec<u8>> {
    let mut response = Response::new(bytes);
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    // The scheme is a local origin with IPC access, so an SVG opened as a document must not run
    // script there. Embedded with `<img>`, it cannot anyway.
    if content_type == "image/svg+xml" {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; sandbox"),
        );
    }
    response
}

/// Every refusal: 404 with an empty body and no headers.
fn refused() -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const SVG_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

    fn write(root: &Path, path: &str, bytes: &[u8]) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn world() -> TempDir {
        let world = tempfile::tempdir().unwrap();
        for path in [
            "People/Mirela.md",
            "People/portrait.png",
            "portrait.png",
            "Places/Old/portrait.png",
            "images/a b.png",
            "name.png",
            "Folder/name.png",
            "Lore/Map.JPG",
            ".hidden/a.png",
            ".obsidian/icon.png",
            "notes.txt",
        ] {
            write(world.path(), path, b"bytes");
        }
        world
    }

    fn request(target: &str, form: ImageForm) -> ImageRequest {
        ImageRequest {
            target: target.to_owned(),
            form,
        }
    }

    fn resolved(root: &Path, from: &str, target: &str, form: ImageForm) -> ImageEmbed {
        let mut embeds = resolve(root, from, &[request(target, form)]).unwrap();
        embeds.pop().unwrap()
    }

    fn path_of(embed: ImageEmbed) -> Option<String> {
        match embed {
            ImageEmbed::Found { path, .. } => Some(path),
            _ => None,
        }
    }

    #[test]
    fn the_listing_holds_visible_image_files_in_the_tree_s_order() {
        let world = world();

        let files = image_files(world.path()).unwrap();

        let paths: Vec<&str> = files.images.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "Folder/name.png",
                "images/a b.png",
                "Lore/Map.JPG",
                "People/portrait.png",
                "Places/Old/portrait.png",
                "name.png",
                "portrait.png",
            ]
        );
    }

    #[test]
    fn embeds_resolve_by_the_rules_of_links() {
        use ImageForm::{Markdown, Wiki};
        let world = world();
        let cases = [
            (
                "People/Mirela.md",
                "portrait.png",
                Wiki,
                "People/portrait.png",
            ),
            ("Lore/Notes.md", "portrait.png", Wiki, "portrait.png"),
            (
                "Places/Old/Notes.md",
                "PORTRAIT.PNG",
                Wiki,
                "Places/Old/portrait.png",
            ),
            (
                "People/Mirela.md",
                "Folder/name.png",
                Wiki,
                "Folder/name.png",
            ),
            (
                "People/Mirela.md",
                "./portrait.png",
                Wiki,
                "People/portrait.png",
            ),
            ("People/Mirela.md", "../name.png", Wiki, "name.png"),
            ("People/Mirela.md", "name.png", Markdown, "name.png"),
            (
                "People/Mirela.md",
                "portrait.png",
                Markdown,
                "People/portrait.png",
            ),
            (
                "People/Mirela.md",
                "../images/a%20b.png",
                Markdown,
                "images/a b.png",
            ),
            (
                "People/Mirela.md",
                "<images/a b.png>",
                Markdown,
                "images/a b.png",
            ),
            ("People/Mirela.md", "Map.jpg", Markdown, "Lore/Map.JPG"),
        ];
        for (from, target, form, expected) in cases {
            assert_eq!(
                path_of(resolved(world.path(), from, target, form)).as_deref(),
                Some(expected),
                "{target:?} from {from}"
            );
        }
    }

    #[test]
    fn web_outside_and_missing_targets_are_told_apart() {
        use ImageForm::{Markdown, Wiki};
        let world = world();
        let cases = [
            ("https://x/a.png", ImageEmbed::Web),
            ("HTTP://x/a.png", ImageEmbed::Web),
            ("//x/a.png", ImageEmbed::Web),
            ("data:image/png;base64,iVBORw0KGgo=", ImageEmbed::Web),
            ("/etc/a.png", ImageEmbed::Outside),
            (r"C:\a.png", ImageEmbed::Outside),
            ("C:/a.png", ImageEmbed::Outside),
            (r"images\a b.png", ImageEmbed::Outside),
            ("../../a.png", ImageEmbed::Outside),
            (".hidden/a.png", ImageEmbed::Outside),
            (".obsidian/icon.png", ImageEmbed::Outside),
            ("unknown.png", ImageEmbed::Missing),
            ("Nowhere/unknown.png", ImageEmbed::Missing),
        ];
        for form in [Wiki, Markdown] {
            for (target, expected) in &cases {
                assert_eq!(
                    &resolved(world.path(), "People/Mirela.md", target, form),
                    expected,
                    "{target:?} as {form:?}"
                );
            }
        }
        assert_eq!(
            resolved(
                world.path(),
                "People/Mirela.md",
                "%2e%2e/%2e%2e/a.png",
                Markdown
            ),
            ImageEmbed::Outside
        );
        assert_eq!(
            resolved(world.path(), "People/Mirela.md", "a%FF.png", Markdown),
            ImageEmbed::Missing
        );
    }

    #[test]
    fn a_changed_file_gets_a_new_stamp() {
        let world = world();
        let stamp = || match resolved(world.path(), "x.md", "name.png", ImageForm::Wiki) {
            ImageEmbed::Found { stamp, .. } => stamp,
            other => panic!("{other:?}"),
        };
        let before = stamp();

        write(world.path(), "name.png", b"other bytes");

        assert_ne!(stamp(), before);
    }

    #[cfg(unix)]
    #[test]
    fn images_through_links_are_outside() {
        use ImageForm::{Markdown, Wiki};
        use std::os::unix::fs::symlink;
        let world = tempfile::tempdir().unwrap();
        write(world.path(), "real.png", b"bytes");
        write(world.path(), "Gallery/a.png", b"bytes");
        symlink(
            world.path().join("real.png"),
            world.path().join("portrait.png"),
        )
        .unwrap();
        symlink(world.path().join("Gallery"), world.path().join("Linked")).unwrap();

        let files = image_files(world.path()).unwrap();
        let paths: Vec<&str> = files.images.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(paths, ["Gallery/a.png", "real.png"]);
        for (target, form) in [
            ("portrait.png", Wiki),
            ("Portrait.png", Markdown),
            ("Linked/a.png", Wiki),
            ("linked/a.png", Markdown),
            ("./Linked/a.png", Markdown),
        ] {
            assert_eq!(
                resolved(world.path(), "Page.md", target, form),
                ImageEmbed::Outside,
                "{target:?} as {form:?}"
            );
        }
        assert_eq!(
            path_of(resolved(world.path(), "Page.md", "Gallery/a.png", Wiki)).as_deref(),
            Some("Gallery/a.png")
        );
    }

    /// A world folder inside a parent folder that holds `outside.png`, opened in a new state.
    struct Served {
        _parent: TempDir,
        root: PathBuf,
        state: WorldState,
        session: u64,
    }

    fn served() -> Served {
        let parent = tempfile::tempdir().unwrap();
        write(parent.path(), "outside.png", b"outside");
        let root = parent.path().join("World");
        write(&root, "Places/Map.png", &[137, 80, 78, 71]);
        write(&root, "Places/Saltmere.md", b"# Saltmere\n");
        write(&root, "notes.txt", b"notes");
        write(&root, ".hidden/a.png", b"hidden");
        fs::create_dir_all(root.join("Places/Folder.png")).unwrap();
        let state = WorldState::default();
        let session = state.open(root.clone()).unwrap().session;
        Served {
            _parent: parent,
            root,
            state,
            session,
        }
    }

    /// The URL `convertFileSrc` builds for `session` and `path` on Linux and macOS.
    fn url(session: impl std::fmt::Display, path: &str) -> String {
        let joined = format!("{session}/{path}");
        let encoded = utf8_percent_encode(&joined, NON_ALPHANUMERIC);
        format!("grimoire-image://localhost/{encoded}")
    }

    fn get(state: &WorldState, url: &str) -> Response<Vec<u8>> {
        respond(state, &url.parse().unwrap())
    }

    fn assert_refused(response: &Response<Vec<u8>>, case: &str) {
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{case}");
        assert!(response.body().is_empty(), "{case}");
        assert!(response.headers().is_empty(), "{case}");
    }

    #[test]
    fn an_image_of_the_open_world_is_served_with_its_type() {
        let world = served();
        let session = world.session;

        for url in [
            format!("{}?v=4-1700000000", url(session, "Places/Map.png")),
            format!("http://grimoire-image.localhost/{session}%2FPlaces%2FMap.png"),
        ] {
            let response = get(&world.state, &url);

            assert_eq!(response.status(), StatusCode::OK, "{url}");
            assert_eq!(response.body(), &[137, 80, 78, 71]);
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_TYPE], "image/png");
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
        }
    }

    #[test]
    fn each_image_type_gets_its_content_type() {
        let world = served();
        let types = [
            ("a.PNG", "image/png"),
            ("b.Jpg", "image/jpeg"),
            ("c.jpeg", "image/jpeg"),
            ("d.GIF", "image/gif"),
            ("e.bmp", "image/bmp"),
            ("f.Svg", "image/svg+xml"),
            ("g.webp", "image/webp"),
            ("h.AVIF", "image/avif"),
        ];
        for (name, content_type) in types {
            write(&world.root, name, b"bytes");

            let response = get(&world.state, &url(world.session, name));

            assert_eq!(response.status(), StatusCode::OK, "{name}");
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_TYPE], content_type, "{name}");
            assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{name}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{name}");
            // Only an SVG can hold script, so only it is sandboxed.
            let svg = content_type == "image/svg+xml";
            assert_eq!(
                headers
                    .get(header::CONTENT_SECURITY_POLICY)
                    .map(|policy| policy.to_str().unwrap()),
                svg.then_some(SVG_POLICY),
                "{name}"
            );
            assert_eq!(headers.len(), if svg { 4 } else { 3 }, "{name}");
        }
    }

    #[test]
    fn every_other_request_is_refused_alike() {
        let world = served();
        let big = File::create(world.root.join("Big.png")).unwrap();
        big.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        let session = world.session;
        let absolute = world.root.join("Places/Map.png");
        let cases = [
            (url(session + 1, "Places/Map.png"), "another session"),
            (url("x", "Places/Map.png"), "a malformed session"),
            (url("", "Places/Map.png"), "no session"),
            (
                url(format!("+{session}"), "Places/Map.png"),
                "a signed session",
            ),
            (format!("grimoire-image://localhost/{session}"), "no path"),
            (url(session, "Places/../Places/Map.png"), "a .. segment"),
            (url(session, "../outside.png"), "a path above the world"),
            (
                format!("grimoire-image://localhost/{session}%2F%2e%2e%2Foutside.png"),
                "an encoded ..",
            ),
            (
                format!("grimoire-image://localhost/{session}%2F%252e%252e%2Foutside.png"),
                "a doubly encoded ..",
            ),
            (url(session, absolute.to_str().unwrap()), "an absolute path"),
            (url(session, ".hidden/a.png"), "a hidden segment"),
            (url(session, "Places/Saltmere.md"), "a page"),
            (url(session, "notes.txt"), "a file that is not an image"),
            (url(session, "Places/Folder.png"), "a folder"),
            (url(session, "Places/Nowhere.png"), "a missing image"),
            (url(session, "Big.png"), "a file over 64 MiB"),
        ];
        for (url, case) in &cases {
            assert_refused(&get(&world.state, url), case);
        }

        world.state.close();

        assert_refused(
            &get(&world.state, &url(session, "Places/Map.png")),
            "after the world closed",
        );
    }

    #[cfg(unix)]
    #[test]
    fn images_through_links_are_refused_on_unix() {
        use std::os::unix::fs::symlink;
        let world = served();
        symlink(
            world.root.join("Places/Map.png"),
            world.root.join("Alias.png"),
        )
        .unwrap();
        symlink(world.root.join("Places"), world.root.join("Linked")).unwrap();

        for path in ["Alias.png", "Linked/Map.png"] {
            assert_refused(&get(&world.state, &url(world.session, path)), path);
        }
    }
}
