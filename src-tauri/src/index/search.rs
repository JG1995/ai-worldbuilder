//! Search over the stored pages: their names, aliases and paths matched with letter case and
//! accents ignored, ranked as link suggestions are, with each match's range in the original text;
//! and the words of a text query, the full-text expression that selects the pages holding them,
//! and the lines of a page that show where they are.

use std::collections::HashMap;
use std::ops::Range;

use serde::Serialize;
use unicode_normalization::char::{decompose_canonical, is_combining_mark};

use super::page_name;
use super::parse::cut_line;
use crate::order::{natural_order, path_order};

/// How many pages one answer lists at most.
pub const LIMIT: usize = 10;
/// How many lines a text match shows at most.
const LINES: usize = 3;

/// A range of a text, in UTF-16 code units of that text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct Mark {
    pub from: u64,
    pub to: u64,
}

/// What a page matched by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum MatchField {
    Name,
    Alias,
    /// Its path from the world's root without `.md`, for a query with a `/`.
    Path,
}

/// A page whose name, alias or path holds the query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct PageMatch {
    /// The page's path, relative to the world.
    pub path: String,
    /// Its name, without `.md`.
    pub name: String,
    pub field: MatchField,
    /// The alias that matched, when `field` is `alias`.
    pub alias: Option<String>,
    /// The matched characters: in the name, in the alias, or in the path without `.md`.
    pub mark: Mark,
}

/// The pages whose name, alias or path matches a query, from the pages the index holds now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PageMatches {
    /// The index is still being built: the matches among the pages it has read so far.
    Building { pages: Vec<PageMatch> },
    /// The best matches, best first.
    Ready { pages: Vec<PageMatch> },
    /// The world could not be listed, for the reason given.
    Failed { message: String },
}

/// A line of a page that holds a match of a text query's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct TextLine {
    /// The line as written, cut around its first match with `…` where cut.
    pub text: String,
    /// Where the line's first match starts in the page's text, in UTF-16 code units.
    pub at: u64,
    /// The matched words, in `text`.
    pub marks: Vec<Mark>,
}

/// A page whose text holds every word of the query, each as the start of one of its words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
pub struct TextMatch {
    /// The page's path, relative to the world.
    pub path: String,
    /// Its name, without `.md`.
    pub name: String,
    /// Its first lines that hold a match, in page order.
    pub lines: Vec<TextLine>,
}

/// The pages whose text matches a query, other than its page matches, from the pages the index
/// holds now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TextMatches {
    /// The index is still being built: the matches among the pages it has read so far.
    Building { pages: Vec<TextMatch> },
    /// The most relevant matches, best first.
    Ready { pages: Vec<TextMatch> },
    /// The world could not be listed, for the reason given.
    Failed { message: String },
}

/// A text's search form, with letter case and accents ignored: each character lowercased, then
/// canonically decomposed, without combining marks. It remembers which characters of the original
/// text each of its own came from, so a match is reported as a range of the original.
struct Folded {
    text: String,
    /// For each character of `text`: its byte offset there, and the range, in UTF-16 code units of
    /// the original, of the character it came from and of the combining marks that follow it.
    origins: Vec<(usize, u64, u64)>,
}

fn fold(text: &str) -> Folded {
    let mut folded = Folded {
        text: String::new(),
        origins: Vec::new(),
    };
    let mut at = 0;
    for original in text.chars() {
        let end = at + original.len_utf16() as u64;
        let before = folded.origins.len();
        for lower in original.to_lowercase() {
            decompose_canonical(lower, |part| {
                if !is_combining_mark(part) {
                    folded.origins.push((folded.text.len(), at, end));
                    folded.text.push(part);
                }
            });
        }
        // A character that folds to nothing, such as a decomposed accent, belongs to the one
        // before it, so a match never ends between a letter and its accent.
        if folded.origins.len() == before
            && let Some(last) = folded.origins.last_mut()
        {
            last.2 = end;
        }
        at = end;
    }
    folded
}

impl Folded {
    /// Where `query`, a folded and non-empty text, first appears: whether at the start, and the
    /// original characters it covers.
    fn find(&self, query: &str) -> Option<(bool, Mark)> {
        let start = self.text.find(query)?;
        let end = start + query.len();
        let first = self.origins.partition_point(|origin| origin.0 < start);
        let last = self.origins.partition_point(|origin| origin.0 < end) - 1;
        let mark = Mark {
            from: self.origins[first].1,
            to: self.origins[last].2,
        };
        Some((start == 0, mark))
    }
}

/// How a page matched, best first: at the start of its name, path or alias before elsewhere in it,
/// then by its name or path before by an alias.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    elsewhere: bool,
    alias: bool,
}

/// The pages among `pages`, by path, with `aliases` as (page path, alias), whose name, alias or path
/// holds `query` as one piece, with letter case and accents ignored. Without a `/`, the query
/// matches names and aliases; with one, paths from the world's root without `.md`. A page appears
/// once, by its best match, ties go by the tree's order, and at most 10 are listed. Every page is a
/// candidate, whatever its name holds. A query that is empty once trimmed and folded matches none.
pub fn page_matches(pages: &[String], aliases: &[(String, String)], query: &str) -> Vec<PageMatch> {
    let trimmed = query.trim();
    let query = fold(trimmed).text;
    if query.is_empty() {
        return Vec::new();
    }
    let by_path = trimmed.contains('/');
    let mut aliases_of: HashMap<&str, Vec<&str>> = HashMap::new();
    for (path, alias) in aliases {
        aliases_of.entry(path).or_default().push(alias);
    }
    let rank = |text: &str, alias: bool| {
        fold(text).find(&query).map(|(start, mark)| {
            let rank = Rank {
                elsewhere: !start,
                alias,
            };
            (rank, mark)
        })
    };

    let mut matches: Vec<(Rank, &str, MatchField, Option<&str>, Mark)> = Vec::new();
    for path in pages {
        let best = if by_path {
            rank(without_extension(path), false)
                .map(|(rank, mark)| (rank, MatchField::Path, None, mark))
        } else {
            let by_name = rank(page_name(path), false)
                .map(|(rank, mark)| (rank, MatchField::Name, None, mark));
            let by_alias = aliases_of
                .get(path.as_str())
                .into_iter()
                .flatten()
                .filter_map(|&alias| {
                    rank(alias, true)
                        .map(|(rank, mark)| (rank, MatchField::Alias, Some(alias), mark))
                });
            by_name.into_iter().chain(by_alias).min_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| natural_order(a.2.unwrap_or(""), b.2.unwrap_or("")))
            })
        };
        if let Some((rank, field, alias, mark)) = best {
            matches.push((rank, path, field, alias, mark));
        }
    }
    matches.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| path_order(a.1, b.1)));

    matches
        .into_iter()
        .take(LIMIT)
        .map(|(_, path, field, alias, mark)| PageMatch {
            path: path.to_owned(),
            name: page_name(path).to_owned(),
            field,
            alias: alias.map(str::to_owned),
            mark,
        })
        .collect()
}

/// A page path without its `.md`, in any letter case.
fn without_extension(path: &str) -> &str {
    let cut = path.len().saturating_sub(3);
    match path.get(cut..) {
        Some(extension) if extension.eq_ignore_ascii_case(".md") => &path[..cut],
        _ => path,
    }
}

/// The words of `text`: runs that start with a letter or digit and go on through letters, digits
/// and combining marks, as SQLite's `unicode61` tokenizer keeps the marks it folds inside a token.
/// Every other character separates words. Byte ranges of `text`.
fn words(text: &str) -> impl Iterator<Item = Range<usize>> + '_ {
    let mut chars = text.char_indices().peekable();
    std::iter::from_fn(move || {
        let (start, _) = chars.find(|(_, c)| c.is_alphanumeric())?;
        let mut end = text.len();
        while let Some(&(at, c)) = chars.peek() {
            if !(c.is_alphanumeric() || is_combining_mark(c)) {
                end = at;
                break;
            }
            chars.next();
        }
        Some(start..end)
    })
}

/// A text query: its words, which a page's text must each hold as the start of a word, with
/// letter case and accents ignored.
pub struct TextQuery {
    expression: String,
    /// Each word's search form.
    folded: Vec<String>,
}

impl TextQuery {
    /// The text query in `query`, or `None` when it has no words, which matches no page.
    pub fn new(query: &str) -> Option<Self> {
        let mut expression = Vec::new();
        let mut folded = Vec::new();
        for range in words(query) {
            let word = &query[range];
            let form = fold(word).text;
            // A word of marks alone, such as a lone vowel sign, would be the start of every word.
            if !form.is_empty() {
                // Letters, digits and marks only, so the quotes hold no syntax and no quote.
                expression.push(format!("\"{word}\"*"));
                folded.push(form);
            }
        }
        (!folded.is_empty()).then(|| Self {
            expression: expression.join(" "),
            folded,
        })
    }

    /// The full-text expression that selects the pages holding every word as the start of a
    /// token: each word quoted, as a prefix. SQLite's tokenizer splits and folds the words as it
    /// split and folded the pages' text.
    pub fn expression(&self) -> &str {
        &self.expression
    }

    /// The first lines of `text`, a page's text, that hold a word starting with one of the query's
    /// words, with every such word marked. A page whose words SQLite split differently can have
    /// none.
    pub fn lines(&self, text: &str) -> Vec<TextLine> {
        let mut found = Vec::new();
        let mut line_at = 0;
        for line in text.split('\n') {
            let marks: Vec<Range<usize>> = words(line)
                .filter(|word| {
                    let form = fold(&line[word.clone()]).text;
                    self.folded
                        .iter()
                        .any(|query| form.starts_with(query.as_str()))
                })
                .collect();
            if let Some(first) = marks.first() {
                found.push(text_line(line, line_at, first.start, &marks));
                if found.len() == LINES {
                    break;
                }
            }
            line_at += utf16_len(line) + 1;
        }
        found
    }
}

/// The line `line`, which starts at `line_at` in its page's text, cut around its first mark at the
/// byte `first`, with `marks` (byte ranges of `line`) shifted into the cut line and clipped to it.
fn text_line(line: &str, line_at: u64, first: usize, marks: &[Range<usize>]) -> TextLine {
    let cut = cut_line(line, first);
    let kept = &cut.kept;
    // The `…` in front of a line cut before its start is one code unit.
    let shift = u64::from(kept.start > 0);
    let at = |byte: usize| shift + utf16_len(&line[kept.start..byte]);
    let marks = marks
        .iter()
        .filter_map(|mark| {
            let (from, to) = (mark.start.max(kept.start), mark.end.min(kept.end));
            (from < to).then(|| Mark {
                from: at(from),
                to: at(to),
            })
        })
        .collect();
    TextLine {
        text: cut.text,
        at: line_at + utf16_len(&line[..first]),
        marks,
    }
}

fn utf16_len(text: &str) -> u64 {
    text.encode_utf16().count() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGES: [&str; 13] = [
        "People/Mirëla.md",
        "People/Mire\u{308}la.md",
        "Kesh Tor.md",
        "Places/Saltmere.md",
        "Lore/Saltmere.md",
        "Lore/Old Mira.md",
        "People/Amira.md",
        "Places/Mirror lake.md",
        "Chronicle [draft].md",
        "Notes #1.md",
        "Clans|Houses^2.md",
        "Places/Harbour.md",
        "Lore/𝔊ate of Mirth.md",
    ];

    fn matched(query: &str) -> Vec<PageMatch> {
        let pages: Vec<String> = PAGES.iter().map(|path| (*path).to_owned()).collect();
        let aliases: Vec<(String, String)> = [
            ("People/Mirëla.md", "the captain"),
            ("People/Mirëla.md", "Mira"),
            ("Kesh Tor.md", "Old Mire"),
            ("Places/Saltmere.md", "Salt town"),
            ("Places/Saltmere.md", "Mire town"),
            ("Places/Harbour.md", "Ærø harbour"),
        ]
        .iter()
        .map(|(path, alias)| ((*path).to_owned(), (*alias).to_owned()))
        .collect();
        page_matches(&pages, &aliases, query)
    }

    fn paths(query: &str) -> Vec<String> {
        matched(query).into_iter().map(|page| page.path).collect()
    }

    fn mark(from: u64, to: u64) -> Mark {
        Mark { from, to }
    }

    /// Each row: the query, then each listed page with what it matched by and its mark.
    #[test]
    fn pages_match_and_rank_by_name_alias_or_path_with_their_marks() {
        type Row = (&'static str, MatchField, Option<&'static str>, Mark);
        let cases: [(&str, &str, Vec<Row>); 12] = [
            (
                "case and accents ignored, precomposed and decomposed, marking the whole name",
                "MIRELA",
                vec![
                    (
                        "People/Mire\u{308}la.md",
                        MatchField::Name,
                        None,
                        mark(0, 7),
                    ),
                    ("People/Mirëla.md", MatchField::Name, None, mark(0, 6)),
                ],
            ),
            (
                "a decomposed accent stays with its letter in the mark",
                "mire",
                vec![
                    (
                        "People/Mire\u{308}la.md",
                        MatchField::Name,
                        None,
                        mark(0, 5),
                    ),
                    ("People/Mirëla.md", MatchField::Name, None, mark(0, 4)),
                    (
                        "Places/Saltmere.md",
                        MatchField::Alias,
                        Some("Mire town"),
                        mark(0, 4),
                    ),
                    (
                        "Kesh Tor.md",
                        MatchField::Alias,
                        Some("Old Mire"),
                        mark(4, 8),
                    ),
                ],
            ),
            (
                "start before elsewhere, name before alias, then the tree's order",
                "mir",
                vec![
                    (
                        "People/Mire\u{308}la.md",
                        MatchField::Name,
                        None,
                        mark(0, 3),
                    ),
                    ("People/Mirëla.md", MatchField::Name, None, mark(0, 3)),
                    ("Places/Mirror lake.md", MatchField::Name, None, mark(0, 3)),
                    (
                        "Places/Saltmere.md",
                        MatchField::Alias,
                        Some("Mire town"),
                        mark(0, 3),
                    ),
                    ("Lore/Old Mira.md", MatchField::Name, None, mark(4, 7)),
                    ("Lore/𝔊ate of Mirth.md", MatchField::Name, None, mark(9, 12)),
                    ("People/Amira.md", MatchField::Name, None, mark(1, 4)),
                    (
                        "Kesh Tor.md",
                        MatchField::Alias,
                        Some("Old Mire"),
                        mark(4, 7),
                    ),
                ],
            ),
            (
                "a page is listed once, by its best match",
                "mira",
                vec![
                    (
                        "People/Mirëla.md",
                        MatchField::Alias,
                        Some("Mira"),
                        mark(0, 4),
                    ),
                    ("Lore/Old Mira.md", MatchField::Name, None, mark(4, 8)),
                    ("People/Amira.md", MatchField::Name, None, mark(1, 5)),
                ],
            ),
            (
                "names no link can hold are listed",
                "draft",
                vec![("Chronicle [draft].md", MatchField::Name, None, mark(11, 16))],
            ),
            (
                "a # in a name",
                "#1",
                vec![("Notes #1.md", MatchField::Name, None, mark(6, 8))],
            ),
            (
                "| and ^ in a name",
                "s|houses^",
                vec![("Clans|Houses^2.md", MatchField::Name, None, mark(4, 13))],
            ),
            (
                "a letter without a canonical decomposition stays as it is",
                "ærø",
                vec![(
                    "Places/Harbour.md",
                    MatchField::Alias,
                    Some("Ærø harbour"),
                    mark(0, 3),
                )],
            ),
            (
                "a query with / matches paths without .md, across the folder",
                "e/sal",
                vec![("Lore/Saltmere.md", MatchField::Path, None, mark(3, 8))],
            ),
            (
                "a path match marks in UTF-16 code units",
                "lore/𝔊a",
                vec![("Lore/𝔊ate of Mirth.md", MatchField::Path, None, mark(0, 8))],
            ),
            ("a query with / never matches an alias", "captain/", vec![]),
            ("nothing holds it", "zzz", vec![]),
        ];

        for (case, query, expected) in cases {
            let found: Vec<(String, MatchField, Option<String>, Mark)> = matched(query)
                .into_iter()
                .map(|page| (page.path, page.field, page.alias, page.mark))
                .collect();
            let expected: Vec<(String, MatchField, Option<String>, Mark)> = expected
                .into_iter()
                .map(|(path, field, alias, mark)| {
                    (path.to_owned(), field, alias.map(str::to_owned), mark)
                })
                .collect();
            assert_eq!(found, expected, "{case}");
        }
    }

    #[test]
    fn a_match_names_its_page_and_alias() {
        let captain = &matched("captain")[0];

        assert_eq!(captain.path, "People/Mirëla.md");
        assert_eq!(captain.name, "Mirëla");
        assert_eq!(captain.alias.as_deref(), Some("the captain"));
        assert_eq!(captain.mark, mark(4, 11));
    }

    #[test]
    fn a_query_ending_in_md_matches_no_path_extension() {
        assert!(paths("harbour.md").is_empty());
        assert!(paths("places/harbour.md").is_empty());
        assert_eq!(paths("places/harbour"), ["Places/Harbour.md"]);
    }

    #[test]
    fn empty_and_blank_queries_and_a_lone_accent_match_nothing() {
        for query in ["", "   ", "\u{308}"] {
            assert!(paths(query).is_empty(), "{query:?}");
        }
    }

    #[test]
    fn at_most_ten_pages_are_listed() {
        let pages: Vec<String> = (1..=12).map(|number| format!("Act {number}.md")).collect();

        let names: Vec<String> = page_matches(&pages, &[], " act ")
            .into_iter()
            .map(|page| page.name)
            .collect();

        assert_eq!(
            names,
            (1..=10)
                .map(|number| format!("Act {number}"))
                .collect::<Vec<_>>()
        );
    }
}
