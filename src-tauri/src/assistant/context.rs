//! Chooses the pages a message's request carries, in the DESIGN's order: the active page, the pages
//! the message names, the pages one link away from the active page, then the pages whose text
//! matches the message. The request's budgets live here, counted in characters (Unicode scalar
//! values).

use std::collections::HashSet;

use crate::index::{self, BuildState};
use crate::world::WorldState;

/// The most characters of one page that a request carries.
pub const PAGE_LIMIT: usize = 12_000;
/// The most characters of page text that a request carries in all.
pub const PAGES_LIMIT: usize = 48_000;
/// The most characters of earlier messages that a request carries.
pub const EARLIER_LIMIT: usize = 32_000;
/// The most pages chosen because their text matches the message.
pub const TEXT_MATCHES: usize = 5;

/// A page as the request carries it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChosenPage {
    pub path: String,
    pub text: String,
    /// Whether the text was cut, so only part of the page was read.
    pub partial: bool,
}

/// The pages a request carries, and whether the index was still being built when they were chosen.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Context {
    pub pages: Vec<ChosenPage>,
    pub indexing: bool,
}

/// The pages for `message`, sent in the opening `session` while `active` was the active page, each
/// at most once, read as UTF-8 while that session is open: each cut to `PAGE_LIMIT`, and the page
/// that reaches `PAGES_LIMIT` cut to the space left, after which no page is added. A page that
/// cannot be read is skipped.
pub fn choose(world: &WorldState, session: u64, active: Option<&str>, message: &str) -> Context {
    let (paths, indexing) = candidates(world, session, active, message);
    let mut pages = Vec::new();
    let mut left = PAGES_LIMIT;
    for path in paths {
        // Once the page text is full, no page is added.
        if left == 0 {
            break;
        }
        let Ok(text) = world.read_page_in(session, &path) else {
            continue;
        };
        let (text, over_page) = cut(text, PAGE_LIMIT);
        let (text, over_total) = cut(text, left);
        left -= text.chars().count();
        pages.push(ChosenPage {
            path,
            text,
            partial: over_page || over_total,
        });
    }
    Context { pages, indexing }
}

/// The paths of the pages to read for `message`, in order and each once, from what the index holds
/// now, and whether it was still being built. The index is asked under its own lock alone, and no
/// page is read until that lock is released. Without an index answer, only the active page.
fn candidates(
    world: &WorldState,
    session: u64,
    active: Option<&str>,
    message: &str,
) -> (Vec<String>, bool) {
    let links = index::parse(message, "").links;
    let found = world.query_index_in(session, |index| {
        let mut paths: Vec<String> = active.map(str::to_owned).into_iter().collect();
        // As on a page at the world's top level.
        for link in links.iter().filter(|link| !link.attachment) {
            paths.extend(index.resolve_stored("", &link.target)?);
        }
        paths.extend(index.pages_named_in(message)?);
        if let Some(active) = active {
            paths.extend(index.links_from(active)?);
            paths.extend(index.linked_from(active)?);
        }
        paths.extend(index.matching_text(message, TEXT_MATCHES)?);
        // Read after the queries, because a storage failure can have emptied the index.
        Ok((paths, index.state() == &BuildState::Building))
    });
    let (mut paths, indexing) =
        found.unwrap_or_else(|_| (active.map(str::to_owned).into_iter().collect(), false));
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(path.clone()));
    (paths, indexing)
}

/// `text` cut to its first `limit` characters, and whether it was cut.
fn cut(mut text: String, limit: usize) -> (String, bool) {
    match text.char_indices().nth(limit) {
        Some((at, _)) => {
            text.truncate(at);
            (text, true)
        }
        None => (text, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    /// A temporary world with `pages`, as (path, bytes), open and indexed.
    fn indexed_world(pages: &[(&str, &[u8])]) -> (TempDir, WorldState, u64) {
        let folder = tempfile::tempdir().unwrap();
        for (path, bytes) in pages {
            let file = folder.path().join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, bytes).unwrap();
        }
        let world = WorldState::default();
        world.open(folder.path().to_path_buf()).unwrap();
        let session = world.current().unwrap().session;
        wait_until_indexed(&world, session);
        (folder, world, session)
    }

    fn wait_until_indexed(world: &WorldState, session: u64) {
        let start = Instant::now();
        while !world
            .query_index_in(session, |index| Ok(index.state() == &BuildState::Ready))
            .unwrap()
        {
            assert!(start.elapsed() < Duration::from_secs(10), "never indexed");
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn paths(context: &Context) -> Vec<&str> {
        context
            .pages
            .iter()
            .map(|page| page.path.as_str())
            .collect()
    }

    #[test]
    fn pages_come_in_the_design_s_order_each_once() {
        let (_folder, world, session) = indexed_world(&[
            (
                "Places/Kesh Tor.md",
                b"The tor. See [[Saltmere]] and [[Linked]].",
            ),
            ("Linked.md", b"A page."),
            ("Mirela.md", b"# Mirela"),
            ("Venn.md", b"---\naliases: [the Trader]\n---\n"),
            ("Saltmere.md", b"A port."),
            ("Ketil.md", b"[[Kesh Tor]] is home."),
            ("Storms.md", b"Glassfall weather."),
            ("Unrelated.md", b"Nothing here."),
        ]);
        let message = "Tell [[Linked]] about mirela, THE TRADER and glassfall.";

        let context = choose(&world, session, Some("Places/Kesh Tor.md"), message);

        assert_eq!(
            paths(&context),
            [
                "Places/Kesh Tor.md",
                "Linked.md",
                "Mirela.md",
                "Venn.md",
                "Saltmere.md",
                "Ketil.md",
                "Storms.md",
            ]
        );
        assert!(!context.indexing);
        assert!(context.pages.iter().all(|page| !page.partial));
        assert_eq!(context.pages[4].text, "A port.");
    }

    #[test]
    fn a_long_page_is_cut_and_the_page_that_reaches_the_total_is_cut_to_the_space_left() {
        // Two bytes a character: the budgets count characters.
        let long = |letter: &str, count: usize| letter.repeat(count).into_bytes();
        let active = [
            b"[[B]] [[C]] [[D]] [[E]] [[F]]\n".as_slice(),
            &long("ä", 12_500),
        ]
        .concat();
        let (_folder, world, session) = indexed_world(&[
            ("A.md", &active),
            ("B.md", &long("b", 10_000)),
            ("C.md", &long("c", 10_000)),
            ("D.md", &long("d", 10_000)),
            ("E.md", &long("é", 10_000)),
            ("F.md", &long("f", 10)),
        ]);

        let context = choose(&world, session, Some("A.md"), "Go");

        let read: Vec<(&str, usize, bool)> = context
            .pages
            .iter()
            .map(|page| (page.path.as_str(), page.text.chars().count(), page.partial))
            .collect();
        assert_eq!(
            read,
            [
                ("A.md", 12_000, true),
                ("B.md", 10_000, false),
                ("C.md", 10_000, false),
                ("D.md", 10_000, false),
                ("E.md", 6_000, true),
            ]
        );
    }

    #[test]
    fn a_page_that_is_not_utf8_is_skipped_and_a_building_index_is_noted() {
        let (folder, world, session) = indexed_world(&[
            ("A.md", b"[[Binary]] [[Saltmere]]"),
            ("Binary.md", &[0xff, 0xfe, 0x00]),
            ("Saltmere.md", b"A port."),
        ]);
        world
            .query_index_in(session, |index| {
                index.set_state(BuildState::Building);
                Ok(())
            })
            .unwrap();

        let context = choose(&world, session, Some("A.md"), "Hello");

        assert_eq!(paths(&context), ["A.md", "Saltmere.md"]);
        assert!(context.indexing);
        // A page is read only in its session.
        world.open(folder.path().to_path_buf()).unwrap();
        assert_eq!(
            choose(&world, session, Some("A.md"), "Hello"),
            Context::default()
        );
    }
}
