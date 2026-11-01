//! Suggesting pages for a link while it is typed, by the DESIGN's ranking, over the stored pages and
//! their aliases, and the text each suggestion writes between the link's brackets.

use std::collections::HashMap;

use serde::Serialize;

use super::page_name;
use crate::order::{natural_order, path_order};

/// How many pages one answer suggests at most.
const LIMIT: usize = 10;

/// Characters that a link cannot name a page through.
const NOT_IN_LINKS: [char; 5] = ['[', ']', '|', '#', '^'];

/// A page suggested for a link being typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct LinkSuggestion {
    /// The page's path, relative to the world.
    pub path: String,
    /// Its name, without `.md`.
    pub name: String,
    /// The alias that matched the typed text, when the page matched by an alias.
    pub alias: Option<String>,
    /// The text to write between the link's brackets: the page's name when no other page has it,
    /// ignoring letter case, else its path from the world's root without `.md`, then `|` and the
    /// alias when an alias matched.
    pub insert: String,
}

/// The pages suggested for a link being typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct LinkSuggestions {
    /// The index is still being built, so pages it has not read yet are missing.
    pub indexing: bool,
    /// The best matches, best first.
    pub items: Vec<LinkSuggestion>,
}

/// How a page matched, best first: at the start of its name, path or alias before elsewhere in it,
/// then by its name or path before by an alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    elsewhere: bool,
    alias: bool,
}

/// The pages among `pages`, by path, with `aliases` as (page path, alias), that a link in the page
/// at `from` whose page part so far is `query` may name. Without a `/`, the query matches names and
/// aliases; with one, paths from the world's root without `.md`. Letter case is ignored, a page
/// appears once by its best match, and ties go by the tree's order. Pages that no link can name are
/// left out, and so is the page at `from`, which still counts when another page shares its name.
pub fn suggest(
    pages: &[String],
    aliases: &[(String, String)],
    from: &str,
    query: &str,
) -> Vec<LinkSuggestion> {
    let query = query.trim().to_lowercase();
    let by_path = query.contains('/');
    let mut sharing: HashMap<String, usize> = HashMap::new();
    for path in pages {
        *sharing.entry(page_name(path).to_lowercase()).or_default() += 1;
    }
    let mut aliases_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for (path, alias) in aliases {
        aliases_of.entry(path).or_default().push(alias);
    }

    let mut matches: Vec<(Rank, &str, Option<&str>)> = Vec::new();
    for path in pages.iter().filter(|path| *path != from) {
        let name = page_name(path);
        let best = if by_path {
            rank(without_extension(path), &query, false).map(|rank| (rank, None))
        } else {
            let by_name = rank(name, &query, false).map(|rank| (rank, None));
            let by_alias = aliases_of
                .get(path.as_str())
                .into_iter()
                .flatten()
                .filter_map(|&alias| rank(alias, &query, true).map(|rank| (rank, Some(alias))));
            by_name.into_iter().chain(by_alias).min_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| natural_order(a.1.unwrap_or(""), b.1.unwrap_or("")))
            })
        };
        if let Some((rank, alias)) = best {
            matches.push((rank, path, alias));
        }
    }
    matches.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| path_order(a.1, b.1)));

    matches
        .into_iter()
        .filter_map(|(_, path, alias)| {
            let name = page_name(path);
            let page = if sharing[&name.to_lowercase()] == 1 {
                name
            } else {
                without_extension(path)
            };
            if page.contains(NOT_IN_LINKS) {
                return None;
            }
            Some(LinkSuggestion {
                path: path.to_owned(),
                name: name.to_owned(),
                alias: alias.map(str::to_owned),
                insert: match alias {
                    Some(alias) => format!("{page}|{alias}"),
                    None => page.to_owned(),
                },
            })
        })
        .take(LIMIT)
        .collect()
}

/// How `text` matches `query`, a lowercase query, or `None` when it does not contain it.
fn rank(text: &str, query: &str, alias: bool) -> Option<Rank> {
    let at = text.to_lowercase().find(query)?;
    Some(Rank {
        elsewhere: at != 0,
        alias,
    })
}

/// A page path without its `.md`, in any letter case.
fn without_extension(path: &str) -> &str {
    let cut = path.len().saturating_sub(3);
    match path.get(cut..) {
        Some(extension) if extension.eq_ignore_ascii_case(".md") => &path[..cut],
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGES: [&str; 11] = [
        "Mirela.md",
        "Kesh Tor.md",
        "Places/Saltmere.md",
        "Lore/Saltmere.md",
        "Lore/Old Mira.md",
        "People/Amira.md",
        "Places/Mirror lake.md",
        "Chronicle [draft].md",
        "Notes #1.md",
        "Places/Harbour.md",
        "Places/Harbour.MD",
    ];

    /// The page the link is typed in, which is none of `PAGES` unless a test says so.
    const FROM: &str = "Overview.md";

    fn suggested(query: &str) -> Vec<LinkSuggestion> {
        let pages: Vec<String> = PAGES.iter().map(|path| (*path).to_owned()).collect();
        let aliases: Vec<(String, String)> = [
            ("Mirela.md", "the captain"),
            ("Mirela.md", "Mira"),
            ("Kesh Tor.md", "Old Mire"),
            ("Places/Saltmere.md", "Salt town"),
            ("Places/Saltmere.md", "Mire town"),
        ]
        .iter()
        .map(|(path, alias)| ((*path).to_owned(), (*alias).to_owned()))
        .collect();
        suggest(&pages, &aliases, FROM, query)
    }

    fn inserts(query: &str) -> Vec<String> {
        suggested(query)
            .into_iter()
            .map(|suggestion| suggestion.insert)
            .collect()
    }

    #[test]
    fn matches_at_the_start_come_first_then_names_before_aliases_then_the_tree_s_order() {
        // "mir": Mirror lake and Mirela (also by its alias Mira) at the start of their names, a
        // Saltmere at the start of its alias Mire town, Old Mira and Amira elsewhere in their
        // names, and Kesh Tor elsewhere in its alias Old Mire.
        assert_eq!(
            inserts("MIR"),
            [
                "Mirror lake",
                "Mirela",
                "Places/Saltmere|Mire town",
                "Old Mira",
                "Amira",
                "Kesh Tor|Old Mire"
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn a_page_matched_only_by_an_alias_shows_the_alias_and_names_itself_in_the_link() {
        let captain = &suggested("capt")[0];

        assert_eq!(captain.path, "Mirela.md");
        assert_eq!(captain.name, "Mirela");
        assert_eq!(captain.alias.as_deref(), Some("the captain"));
        assert_eq!(captain.insert, "Mirela|the captain");
    }

    #[test]
    fn a_shared_name_writes_the_path_and_an_alias_of_it_writes_the_path_with_the_alias() {
        assert_eq!(
            inserts("saltm"),
            ["Lore/Saltmere", "Places/Saltmere"].map(str::to_owned)
        );
        assert_eq!(inserts("salt t"), ["Places/Saltmere|Salt town".to_owned()]);
        // Names that differ only in letter case are the same name.
        assert_eq!(
            inserts("harb"),
            ["Places/Harbour", "Places/Harbour"].map(str::to_owned)
        );
    }

    #[test]
    fn a_query_with_a_slash_matches_paths_and_not_aliases() {
        assert_eq!(
            inserts("places/"),
            [
                "Places/Harbour",
                "Places/Harbour",
                "Mirror lake",
                "Places/Saltmere"
            ]
            .map(str::to_owned)
        );
        assert_eq!(inserts("e/sal"), ["Lore/Saltmere".to_owned()]);
        assert!(inserts("captain/").is_empty());
    }

    #[test]
    fn names_no_link_can_name_are_left_out() {
        assert!(inserts("draft").is_empty());
        assert!(inserts("notes").is_empty());
    }

    #[test]
    fn an_empty_query_lists_pages_in_the_tree_s_order() {
        let all = suggested("  ");

        assert_eq!(
            all.iter()
                .map(|page| page.path.as_str())
                .collect::<Vec<_>>(),
            [
                "Lore/Old Mira.md",
                "Lore/Saltmere.md",
                "People/Amira.md",
                "Places/Harbour.MD",
                "Places/Harbour.md",
                "Places/Mirror lake.md",
                "Places/Saltmere.md",
                "Kesh Tor.md",
                "Mirela.md",
            ]
        );
        assert!(all.iter().all(|page| page.alias.is_none()));
    }

    #[test]
    fn at_most_ten_pages_are_suggested() {
        let pages: Vec<String> = (1..=12).map(|number| format!("Act {number}.md")).collect();

        let first = suggest(&pages, &[], FROM, "act");

        assert_eq!(
            first
                .iter()
                .map(|page| page.name.as_str())
                .collect::<Vec<_>>(),
            (1..=10)
                .map(|number| format!("Act {number}"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_linking_page_is_not_suggested_but_still_shares_its_name() {
        let saltmere = "Lore/Saltmere.md";
        let alone = [saltmere.to_owned()];
        let alias = [(saltmere.to_owned(), "Salt town".to_owned())];
        for query in ["", "saltmere", "salt t", "lore/"] {
            assert!(
                suggest(&alone, &alias, saltmere, query).is_empty(),
                "{query:?}"
            );
        }

        let both = [saltmere.to_owned(), "Places/Saltmere.md".to_owned()];
        let inserts: Vec<String> = suggest(&both, &[], saltmere, "saltm")
            .into_iter()
            .map(|suggestion| suggestion.insert)
            .collect();
        assert_eq!(inserts, ["Places/Saltmere".to_owned()]);
    }

    #[test]
    fn nothing_matches_a_query_no_name_or_alias_holds() {
        assert!(suggested("zzz").is_empty());
    }
}
