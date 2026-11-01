//! Resolving a link's target to a page, by the DESIGN's rules, over the pages the tree lists and
//! their aliases. Link text is untrusted, and only a listed page can ever be the result, so a target
//! that leads outside the world, through a hidden segment or through a link never resolves.

use std::cmp::Ordering;
use std::collections::HashMap;

use crate::order::path_order;

/// The world's pages and aliases, arranged for resolving links.
#[derive(Debug, Default)]
pub struct Table {
    /// Page paths relative to the world, with `/` separators and their extension.
    pages: Vec<String>,
    /// Each lookup maps a lowercase key to the pages it names, by index into `pages`.
    by_name: HashMap<String, Vec<usize>>,
    by_path: HashMap<String, Vec<usize>>,
    by_alias: HashMap<String, Vec<usize>>,
}

impl Table {
    /// A table of `pages`, by path, and `aliases`, as (page path, alias). An alias of a page that is
    /// not listed is left out.
    pub fn new<'a>(
        pages: impl IntoIterator<Item = &'a str>,
        aliases: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Self {
        let mut table = Self::default();
        let mut index_of = HashMap::new();
        for path in pages {
            let index = table.pages.len();
            table.pages.push(path.to_owned());
            index_of.insert(path, index);
            let stem = without_extension(path);
            let name = stem.rsplit('/').next().unwrap_or(stem);
            push(&mut table.by_name, name.to_lowercase(), index);
            push(&mut table.by_path, stem.to_lowercase(), index);
        }
        for (path, alias) in aliases {
            if let Some(&index) = index_of.get(path) {
                push(&mut table.by_alias, alias.to_lowercase(), index);
            }
        }
        table
    }

    /// The page that a link in the page at `from` to `target` leads to: `target` is the link's
    /// page part, as `parse` gives it, so an empty one is the page `from` itself.
    pub fn resolve(&self, from: &str, target: &str) -> Option<&str> {
        let candidates = if target.is_empty() {
            self.by_path.get(&without_extension(from).to_lowercase())
        } else if target.starts_with("./") || target.starts_with("../") {
            let joined = join(folder_of(from), target)?;
            self.by_path.get(&joined.to_lowercase())
        } else if target.contains('/') {
            self.by_path.get(&join("", target)?.to_lowercase())
        } else {
            let key = target.to_lowercase();
            self.by_name.get(&key).or_else(|| self.by_alias.get(&key))
        }?;
        let best = candidates
            .iter()
            .map(|&index| self.pages[index].as_str())
            .min_by(|a, b| preference(from, a, b))?;
        Some(best)
    }
}

/// The path, relative to the world, where a page is created for the unresolved link in the page at
/// `from` to `target`: a bare name in `from`'s folder, a target starting with `./` or `../` joined
/// to that folder, and any other path from the world's root, with `.md` added once. A join above
/// the root is `None`. The path is only lexical: link text is untrusted, so the write path still
/// confines every segment and applies the naming rules.
pub fn creation_path(from: &str, target: &str) -> Option<String> {
    let target = without_extension(target);
    let path = if target.starts_with("./") || target.starts_with("../") {
        join(folder_of(from), target)?
    } else if target.contains('/') {
        join("", target)?
    } else {
        match folder_of(from) {
            "" => target.to_owned(),
            folder => format!("{folder}/{target}"),
        }
    };
    Some(format!("{path}.md"))
}

fn push(map: &mut HashMap<String, Vec<usize>>, key: String, index: usize) {
    let indexes = map.entry(key).or_default();
    if !indexes.contains(&index) {
        indexes.push(index);
    }
}

/// Which of two pages a link from `from` prefers: one in `from`'s folder, then the one with fewer
/// folders in its path, then the first in the tree's order.
fn preference(from: &str, a: &str, b: &str) -> Ordering {
    let folder = folder_of(from);
    (folder_of(a) != folder)
        .cmp(&(folder_of(b) != folder))
        .then_with(|| a.matches('/').count().cmp(&b.matches('/').count()))
        .then_with(|| path_order(a, b))
}

/// The folder of a path relative to the world, `""` at the top level.
fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

/// A page path without its `.md`, in any letter case.
fn without_extension(path: &str) -> &str {
    let cut = path.len().saturating_sub(3);
    match path.get(cut..) {
        Some(extension) if extension.eq_ignore_ascii_case(".md") => &path[..cut],
        _ => path,
    }
}

/// `target`'s `/`-separated segments joined to `folder` lexically: `.` stays, `..` goes up one
/// folder. A join that goes above the world's root is `None`.
fn join(folder: &str, target: &str) -> Option<String> {
    let mut segments: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    for segment in target.split('/') {
        match segment {
            "." => {}
            ".." => {
                segments.pop()?;
            }
            _ => segments.push(segment),
        }
    }
    Some(segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGES: [&str; 13] = [
        "Kesh Tor.md",
        "Mirela.md",
        "Saltmere.md",
        "Places/Saltmere.md",
        "Places/Kesh.md",
        "Places/Coast/Cliffs.md",
        "People/Ana.md",
        "Lore/Ana.md",
        "Lore/Deep/Ana.MD",
        "Atlas/Twins.md",
        "Beta/Twins.md",
        "Gods.md",
        "Places/Harbour.md",
    ];

    fn table() -> Table {
        Table::new(
            PAGES,
            [
                ("Mirela.md", "Mira"),
                ("Mirela.md", "the captain"),
                ("Places/Harbour.md", "Gods"),
                ("People/Ana.md", "Wanderer"),
                ("Lore/Deep/Ana.MD", "wanderer"),
                ("Gone.md", "Ghost"),
            ],
        )
    }

    #[test]
    fn every_rule_resolves_as_the_design_says() {
        let table = table();
        let cases: [(&str, &str, Option<&str>, &str); 24] = [
            (
                "Kesh Tor.md",
                "mirela",
                Some("Mirela.md"),
                "a name in any case",
            ),
            (
                "Kesh Tor.md",
                "MIRELA",
                Some("Mirela.md"),
                "a name in upper case",
            ),
            ("Kesh Tor.md", "Mira", Some("Mirela.md"), "an alias"),
            (
                "Kesh Tor.md",
                "THE CAPTAIN",
                Some("Mirela.md"),
                "an alias in any case",
            ),
            (
                "Kesh Tor.md",
                "Gods",
                Some("Gods.md"),
                "a name wins over an alias",
            ),
            (
                "Kesh Tor.md",
                "",
                Some("Kesh Tor.md"),
                "an empty target is the page itself",
            ),
            (
                "Kesh Tor.md",
                "Places/Saltmere",
                Some("Places/Saltmere.md"),
                "a root path",
            ),
            (
                "Kesh Tor.md",
                "places/saltmere",
                Some("Places/Saltmere.md"),
                "a path in any case",
            ),
            (
                "Kesh Tor.md",
                "Lore/Deep/Ana",
                Some("Lore/Deep/Ana.MD"),
                "an upper-case extension",
            ),
            (
                "Places/Kesh.md",
                "Saltmere",
                Some("Places/Saltmere.md"),
                "the linking folder first",
            ),
            (
                "Kesh Tor.md",
                "Saltmere",
                Some("Saltmere.md"),
                "the root folder first",
            ),
            (
                "Places/Coast/Cliffs.md",
                "Saltmere",
                Some("Saltmere.md"),
                "fewest folders",
            ),
            (
                "Kesh Tor.md",
                "Ana",
                Some("Lore/Ana.md"),
                "tree order among equal depths",
            ),
            (
                "Kesh Tor.md",
                "Twins",
                Some("Atlas/Twins.md"),
                "tree order of folders",
            ),
            (
                "Kesh Tor.md",
                "wanderer",
                Some("People/Ana.md"),
                "a shared alias by depth",
            ),
            (
                "Places/Coast/Cliffs.md",
                "../Kesh",
                Some("Places/Kesh.md"),
                "../ from a folder",
            ),
            (
                "Places/Kesh.md",
                "./Saltmere",
                Some("Places/Saltmere.md"),
                "./ in a folder",
            ),
            (
                "Places/Kesh.md",
                "./Coast/../Harbour",
                Some("Places/Harbour.md"),
                "a relative walk",
            ),
            ("Places/Kesh.md", "../../Mirela", None, "../ above the root"),
            (
                "Kesh Tor.md",
                "../Mirela",
                None,
                "../ above the root at the top level",
            ),
            (
                "Kesh Tor.md",
                "Coast/Cliffs",
                None,
                "a path is from the root",
            ),
            (
                "Kesh Tor.md",
                "Places/Mira",
                None,
                "aliases apply only to bare names",
            ),
            ("Kesh Tor.md", "Ghost", None, "an alias of an unlisted page"),
            ("Kesh Tor.md", "Nowhere", None, "no page matches"),
        ];
        for (from, target, expected, rule) in cases {
            assert_eq!(table.resolve(from, target), expected, "{rule}");
        }
    }

    #[test]
    fn an_unresolved_link_s_page_is_created_where_the_design_says() {
        let cases = [
            (
                "Kesh Tor.md",
                "Harbor",
                Some("Harbor.md"),
                "a bare name at the top level",
            ),
            (
                "Places/Kesh.md",
                "Harbor",
                Some("Places/Harbor.md"),
                "a bare name in the linking page's folder",
            ),
            (
                "Places/Kesh.md",
                "Harbor.md",
                Some("Places/Harbor.md"),
                "a given .md is not added again",
            ),
            (
                "Places/Kesh.md",
                "Harbor.MD",
                Some("Places/Harbor.md"),
                "a given .md in any case",
            ),
            (
                "Places/Kesh.md",
                "./Docks/Harbor",
                Some("Places/Docks/Harbor.md"),
                "./ joins the linking page's folder",
            ),
            (
                "Places/Coast/Cliffs.md",
                "../Harbor",
                Some("Places/Harbor.md"),
                "../ goes up from it",
            ),
            (
                "Places/Kesh.md",
                "Lore/Gods/Harbor",
                Some("Lore/Gods/Harbor.md"),
                "a path is from the root",
            ),
            (
                "Places/Kesh.md",
                "Lore/./Harbor",
                Some("Lore/Harbor.md"),
                "a . segment stays where it is",
            ),
            ("Kesh Tor.md", "../Harbor", None, "../ above the root"),
            (
                "Places/Kesh.md",
                "../../Harbor",
                None,
                "../ above the root from a folder",
            ),
            (
                "Kesh Tor.md",
                "Lore/../../Harbor",
                None,
                "a root path above the root",
            ),
        ];
        for (from, target, expected, rule) in cases {
            assert_eq!(creation_path(from, target).as_deref(), expected, "{rule}");
        }
    }

    #[test]
    fn hidden_and_unlisted_targets_never_resolve() {
        // The world holds `.obsidian/Mirela.md` and a link `Linked/` to `Places/`, which the tree
        // does not list, so they are not in the table.
        let table = table();

        for target in [
            ".obsidian/Mirela",
            "Linked/Saltmere",
            "./.obsidian/Mirela",
            "/etc/passwd",
        ] {
            assert_eq!(table.resolve("Kesh Tor.md", target), None, "{target}");
        }
    }
}
