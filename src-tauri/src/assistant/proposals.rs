//! Proposals in an answer's text: the markup the model writes them in, reading it from a whole
//! answer and from a stream, the rules a proposal's path must keep, and applying an edit.
//!
//! A proposal is a block whose opening and closing tags start a line:
//!
//! ```text
//! <new_page path="Places/Saltmere.md">
//! The page's full text.
//! </new_page>
//! <edit path="People/Mirela.md">
//! <find>A passage of the page.</find>
//! <replace>Its replacement.</replace>
//! </edit>
//! ```
//!
//! An edit holds one or more `find` and `replace` pairs, inline or on lines of their own. One
//! newline right after an opening tag and one right before a closing tag are dropped; everything
//! else is literal, with no entity decoding. A line that starts with another tag carrying a `path`
//! attribute opens a block too, which cannot be read. The model's output is untrusted: nothing here
//! touches the world, and a path is only text until the world checks it.

use serde::Serialize;

use super::store::{Passage, Proposal, ProposalContent};
use crate::history::fnv1a_64;
use crate::index::is_attachment;

const NEW_PAGE: &str = "new_page";
const EDIT: &str = "edit";
const PATH_ATTRIBUTE: &str = " path=\"";

/// What a proposal does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ProposalKind {
    NewPage,
    Edit,
}

/// A whole answer read: its prose, its proposals in order, how many blocks could not be read, and
/// whether it ended inside a block, which was dropped.
#[derive(Debug, PartialEq, Eq)]
pub struct Parsed {
    pub prose: String,
    /// Each with the path as the model gave it, and an edit without a base hash.
    pub proposals: Vec<Proposal>,
    pub unreadable: u32,
    pub unfinished: bool,
}

/// What the splitter passes on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    /// The next piece of the prose.
    Prose(String),
    /// A proposal's opening line is complete.
    Begun { kind: ProposalKind, path: String },
}

/// Reads `raw`, a whole answer. A block still open at its end makes a `complete` answer's block
/// unreadable, and any other answer `unfinished`.
pub fn parse(raw: &str, complete: bool) -> Parsed {
    let mut splitter = Splitter::default();
    let mut pieces = splitter.feed(raw);
    pieces.extend(splitter.finish());
    let prose = pieces
        .into_iter()
        .filter_map(|piece| match piece {
            Piece::Prose(text) => Some(text),
            Piece::Begun { .. } => None,
        })
        .collect();
    // Each proposal with the key it is compared by.
    let mut kept: Vec<(String, Proposal)> = Vec::new();
    let mut unreadable = 0;
    for block in splitter.closed {
        let Some(proposal) = block.proposal() else {
            unreadable += 1;
            continue;
        };
        let key = path_key(&proposal.path);
        match kept.iter_mut().find(|(kept_key, _)| *kept_key == key) {
            None => kept.push((key, proposal)),
            Some((_, earlier)) => match (&mut earlier.content, proposal.content) {
                (
                    ProposalContent::Edit { passages, .. },
                    ProposalContent::Edit { passages: more, .. },
                ) => passages.extend(more),
                _ => unreadable += 1,
            },
        }
    }
    let unfinished = splitter.open && !complete;
    if splitter.open && complete {
        unreadable += 1;
    }
    Parsed {
        prose,
        proposals: kept.into_iter().map(|(_, proposal)| proposal).collect(),
        unreadable,
        unfinished,
    }
}

/// How two proposals' paths are compared: the page path in lowercase, or the given path in
/// lowercase when it breaks a rule.
fn path_key(given: &str) -> String {
    page_path(given).as_deref().unwrap_or(given).to_lowercase()
}

/// Splits an answer's text, fed piece by piece, into its prose and the proposals it begins. It holds
/// back at most the line that may still become an opening tag, and the text of a block.
#[derive(Default)]
pub struct Splitter {
    state: State,
    /// The blocks closed so far, in order.
    closed: Vec<Block>,
    /// The text ended inside a block.
    open: bool,
}

#[derive(Default)]
enum State {
    #[default]
    LineStart,
    /// Inside a line of prose.
    Prose,
    /// The start of a line that may still become an opening tag.
    Held(String),
    /// Inside a block, at the start of one of its lines or not.
    Block { block: Block, line_start: bool },
    /// Right after a closing tag, whose line break belongs to the block.
    Closed,
}

/// A block of the answer, from its opening line to its closing tag.
struct Block {
    name: String,
    /// The proposal's kind and path, when the opening tag is one and can be read.
    opening: Option<(ProposalKind, String)>,
    /// The text after the opening tag, up to the line of the closing tag.
    content: String,
    /// The start of the current line, while it may still be the closing tag.
    closing: String,
}

impl Splitter {
    /// Takes in the next piece of the answer's text.
    pub fn feed(&mut self, delta: &str) -> Vec<Piece> {
        let mut pieces = Pieces::default();
        for character in delta.chars() {
            self.take(character, &mut pieces);
        }
        pieces.0
    }

    /// Ends the text: a held line is prose unless it is a whole opening line.
    pub fn finish(&mut self) -> Vec<Piece> {
        let mut pieces = Pieces::default();
        match std::mem::take(&mut self.state) {
            State::Held(line) => match Block::opening(&line) {
                Some(block) => {
                    pieces.begun(&block);
                    self.open = true;
                }
                None => pieces.prose(&line),
            },
            State::Block { .. } => self.open = true,
            State::LineStart | State::Prose | State::Closed => {}
        }
        pieces.0
    }

    fn take(&mut self, character: char, pieces: &mut Pieces) {
        let after_prose = |character| match character {
            '\n' => State::LineStart,
            _ => State::Prose,
        };
        self.state = match std::mem::take(&mut self.state) {
            State::LineStart if character == '<' => State::Held(character.to_string()),
            State::LineStart | State::Prose => {
                pieces.prose(character.encode_utf8(&mut [0; 4]));
                after_prose(character)
            }
            State::Held(mut line) if character == '\n' => match Block::opening(&line) {
                Some(mut block) => {
                    pieces.begun(&block);
                    block.content.push('\n');
                    State::Block {
                        block,
                        line_start: true,
                    }
                }
                None => {
                    line.push('\n');
                    pieces.prose(&line);
                    State::LineStart
                }
            },
            State::Held(mut line) => {
                line.push(character);
                if may_open(&line) {
                    State::Held(line)
                } else {
                    pieces.prose(&line);
                    State::Prose
                }
            }
            State::Block {
                mut block,
                line_start: true,
            } => {
                block.closing.push(character);
                let closing = format!("</{}>", block.name);
                if block.closing == closing {
                    self.closed.push(block);
                    State::Closed
                } else if closing.starts_with(&block.closing) {
                    State::Block {
                        block,
                        line_start: true,
                    }
                } else {
                    let line = std::mem::take(&mut block.closing);
                    block.content.push_str(&line);
                    State::Block {
                        block,
                        line_start: character == '\n',
                    }
                }
            }
            State::Block {
                mut block,
                line_start: false,
            } => {
                block.content.push(character);
                State::Block {
                    block,
                    line_start: character == '\n',
                }
            }
            State::Closed if character == '\n' => State::LineStart,
            State::Closed => {
                pieces.prose(character.encode_utf8(&mut [0; 4]));
                State::Prose
            }
        };
    }
}

/// Pieces in order, with neighbouring prose joined.
#[derive(Default)]
struct Pieces(Vec<Piece>);

impl Pieces {
    fn prose(&mut self, text: &str) {
        match self.0.last_mut() {
            Some(Piece::Prose(prose)) => prose.push_str(text),
            _ => self.0.push(Piece::Prose(text.to_owned())),
        }
    }

    fn begun(&mut self, block: &Block) {
        if let Some((kind, path)) = &block.opening {
            self.0.push(Piece::Begun {
                kind: *kind,
                path: path.clone(),
            });
        }
    }
}

/// The tag name at the start of `line`, which starts with `<`, and what follows it.
fn tag_name(line: &str) -> (&str, &str) {
    let rest = &line[1..];
    let end = rest
        .find(|character: char| !(character.is_ascii_lowercase() || character == '_'))
        .unwrap_or(rest.len());
    rest.split_at(end)
}

/// Whether `start`, the start of a line, can still become an opening line.
fn may_open(start: &str) -> bool {
    let (name, after) = tag_name(start);
    if after.is_empty() {
        return true;
    }
    match name {
        "" => false,
        NEW_PAGE | EDIT => after.starts_with([' ', '\t', '>']),
        _ => PATH_ATTRIBUTE.starts_with(after) || after.starts_with(PATH_ATTRIBUTE),
    }
}

impl Block {
    /// The block that `line`, a whole line, opens, if it is an opening line.
    fn opening(line: &str) -> Option<Self> {
        if !line.starts_with('<') {
            return None;
        }
        let (name, after) = tag_name(line);
        let kind = match name {
            NEW_PAGE => ProposalKind::NewPage,
            EDIT => ProposalKind::Edit,
            "" => return None,
            _ if after.starts_with(PATH_ATTRIBUTE) => return Some(Self::new(name, None, "")),
            _ => return None,
        };
        if !after.starts_with([' ', '\t', '>']) {
            return None;
        }
        Some(match path_attribute(after) {
            Some((path, content)) => Self::new(name, Some((kind, path.to_owned())), content),
            None => Self::new(name, None, ""),
        })
    }

    fn new(name: &str, opening: Option<(ProposalKind, String)>, content: &str) -> Self {
        Self {
            name: name.to_owned(),
            opening,
            content: content.to_owned(),
            closing: String::new(),
        }
    }

    /// The proposal the block holds, if it follows the grammar.
    fn proposal(self) -> Option<Proposal> {
        let (kind, path) = self.opening?;
        let content = match kind {
            ProposalKind::NewPage => ProposalContent::NewPage {
                text: inner(&self.content).to_owned(),
            },
            ProposalKind::Edit => ProposalContent::Edit {
                passages: passages(&self.content)?,
                base: None,
            },
        };
        Some(Proposal { path, content })
    }
}

/// The non-empty path of an opening tag's `path` attribute, and the text after the tag, from
/// `after`, what follows the tag's name.
fn path_attribute(after: &str) -> Option<(&str, &str)> {
    let value = after
        .trim_start_matches([' ', '\t'])
        .strip_prefix(&PATH_ATTRIBUTE[1..])?;
    let (path, rest) = value.split_once('"')?;
    let content = rest.trim_start_matches([' ', '\t']).strip_prefix('>')?;
    (!path.is_empty()).then_some((path, content))
}

/// An edit's passages, each a `find` element followed by a `replace` element, with nothing but
/// white space around them; none if there is no pair, anything else, or an empty `find`.
fn passages(content: &str) -> Option<Vec<Passage>> {
    let mut passages = Vec::new();
    let mut rest = content.trim_start();
    while !rest.is_empty() {
        let (find, after) = element(rest, "find")?;
        let (replace, after) = element(after.trim_start(), "replace")?;
        if find.is_empty() {
            return None;
        }
        passages.push(Passage {
            find: find.to_owned(),
            replace: replace.to_owned(),
        });
        rest = after.trim_start();
    }
    (!passages.is_empty()).then_some(passages)
}

/// The text of the element `name` at the start of `text`, and what follows it.
fn element<'a>(text: &'a str, name: &str) -> Option<(&'a str, &'a str)> {
    let start = text.strip_prefix(&format!("<{name}>"))?;
    let (value, after) = start.split_once(&format!("</{name}>"))?;
    Some((inner(value), after))
}

/// `text` without one newline at its start and one at its end.
fn inner(text: &str) -> &str {
    let text = text.strip_prefix('\n').unwrap_or(text);
    text.strip_suffix('\n').unwrap_or(text)
}

/// The page path a proposal's path, as the model gave it, names from the world's top level, with
/// `.md` added once; otherwise the rule it breaks. The world's confinement and naming rules still
/// apply to the page path.
pub fn page_path(given: &str) -> Result<String, String> {
    let broken = |rule: &str| Err(rule.to_owned());
    if given.starts_with(['/', '\\']) {
        return broken("The path starts at the top of the disk, not of the world.");
    }
    if given.contains('\\') {
        return broken("The path separates its folders with a backslash.");
    }
    let bytes = given.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return broken("The path starts with a drive.");
    }
    if given.split('/').any(|segment| segment.is_empty()) {
        return broken("The path has an empty name in it.");
    }
    if given
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return broken("The path leads out of its folder with . or ..");
    }
    let name = given.rsplit('/').next().unwrap_or(given);
    if is_attachment(name) {
        return broken("The path names a file that is not a Markdown page.");
    }
    if name.to_ascii_lowercase().ends_with(".md") {
        Ok(given.to_owned())
    } else {
        Ok(format!("{given}.md"))
    }
}

/// Applies an edit's passages to a page's `text`: each must occur exactly once, and no two may
/// overlap; otherwise the reason it no longer applies.
pub fn apply(text: &str, passages: &[Passage]) -> Result<String, String> {
    let mut found = Vec::with_capacity(passages.len());
    for passage in passages {
        let missing = || "A passage of the edit is not in the page.".to_owned();
        let first = passage.find.chars().next().ok_or_else(missing)?;
        let start = text.find(&passage.find).ok_or_else(missing)?;
        if text[start + first.len_utf8()..].contains(&passage.find) {
            return Err("A passage of the edit appears more than once in the page.".to_owned());
        }
        found.push((start, start + passage.find.len(), passage.replace.as_str()));
    }
    found.sort_by_key(|(start, _, _)| *start);
    if found.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err("Two passages of the edit overlap in the page.".to_owned());
    }
    let mut result = String::with_capacity(text.len());
    let mut copied = 0;
    for (start, end, replace) in found {
        result.push_str(&text[copied..start]);
        result.push_str(replace);
        copied = end;
    }
    result.push_str(&text[copied..]);
    Ok(result)
}

/// The FNV-1a hash of `text` as the editor reads it: without a byte-order mark, and with `\r\n`
/// and lone `\r` line endings as `\n`, so a page read back after it was written matches.
pub fn text_hash(text: &str) -> u64 {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    fnv1a_64(text.replace("\r\n", "\n").replace('\r', "\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_page(path: &str, text: &str) -> Proposal {
        Proposal {
            path: path.to_owned(),
            content: ProposalContent::NewPage {
                text: text.to_owned(),
            },
        }
    }

    fn edit(path: &str, passages: &[(&str, &str)]) -> Proposal {
        Proposal {
            path: path.to_owned(),
            content: ProposalContent::Edit {
                passages: passages
                    .iter()
                    .map(|(find, replace)| Passage {
                        find: (*find).to_owned(),
                        replace: (*replace).to_owned(),
                    })
                    .collect(),
                base: None,
            },
        }
    }

    const ANSWER: &str = "Here are the pages.\n\
<new_page path=\"Places/Kesh Tor\">\n\
# Kesh Tor\n\
```\n\
A line that ends in </new_page> stays.\n\
```\n\
</new_page>\n\
Then the edit:\n\
<edit path=\"People/Mirela.md\">\n\
<find>She commands the Gull.</find>\n\
<replace>She commanded the Gull.</replace>\n\
<find>\n\
Her home is Saltmere.\n\
</find>\n\
<replace></replace>\n\
</edit>\n\
Done. A <edit path=\"x\"> mid-line stays.\n";

    #[test]
    fn each_tag_form_parses_and_leaves_the_rest_as_prose() {
        let parsed = parse(ANSWER, true);

        assert_eq!(
            parsed,
            Parsed {
                prose: "Here are the pages.\nThen the edit:\nDone. A <edit path=\"x\"> mid-line \
                        stays.\n"
                    .to_owned(),
                proposals: vec![
                    new_page(
                        "Places/Kesh Tor",
                        "# Kesh Tor\n```\nA line that ends in </new_page> stays.\n```"
                    ),
                    edit(
                        "People/Mirela.md",
                        &[
                            ("She commands the Gull.", "She commanded the Gull."),
                            ("Her home is Saltmere.", ""),
                        ]
                    ),
                ],
                unreadable: 0,
                unfinished: false,
            }
        );
    }

    #[test]
    fn a_block_that_breaks_the_grammar_is_unreadable_and_its_text_dropped() {
        let blocks = [
            "<new_page>\nNo path.\n</new_page>\n",
            "<new_page path=\"\">\nEmpty path.\n</new_page>\n",
            "<edit path=\"A.md\">\nNo pair.\n</edit>\n",
            "<edit path=\"A.md\">\n<find></find><replace>x</replace>\n</edit>\n",
            "<edit path=\"A.md\">\n<find>a</find>\n</edit>\n",
            "<delete path=\"A.md\">\nGone.\n</delete>\n",
        ];
        for block in blocks {
            let parsed = parse(&format!("Before.\n{block}After.\n"), true);

            assert_eq!(parsed.prose, "Before.\nAfter.\n", "{block}");
            assert_eq!(
                (parsed.proposals.len(), parsed.unreadable),
                (0, 1),
                "{block}"
            );
        }
        // A tag without a path that is no proposal's stays prose.
        assert_eq!(
            parse("<div>\nx\n</div>\n", true).prose,
            "<div>\nx\n</div>\n"
        );
    }

    #[test]
    fn a_block_open_at_the_end_is_unfinished_or_unreadable_when_the_answer_is_complete() {
        let text =
            "<new_page path=\"A.md\">\nWhole.\n</new_page>\nOn.\n<edit path=\"B.md\">\n<find>x";

        let stopped = parse(text, false);
        let complete = parse(text, true);

        assert_eq!(stopped.prose, "On.\n");
        assert_eq!(stopped.proposals, [new_page("A.md", "Whole.")]);
        assert_eq!((stopped.unreadable, stopped.unfinished), (0, true));
        assert_eq!((complete.unreadable, complete.unfinished), (1, false));
    }

    #[test]
    fn edits_of_one_page_join_and_a_second_proposal_for_a_path_is_unreadable() {
        let text = "<edit path=\"places/saltmere\">\n<find>a</find><replace>b</replace>\n</edit>\n\
<new_page path=\"Places/Saltmere.md\">\nx\n</new_page>\n\
<edit path=\"Places/Saltmere.MD\">\n<find>c</find><replace>d</replace>\n</edit>\n\
<new_page path=\"New.md\">\none\n</new_page>\n\
<new_page path=\"new\">\ntwo\n</new_page>\n";

        let parsed = parse(text, true);

        assert_eq!(
            parsed.proposals,
            [
                edit("places/saltmere", &[("a", "b"), ("c", "d")]),
                new_page("New.md", "one"),
            ]
        );
        assert_eq!(parsed.unreadable, 2);
    }

    #[test]
    fn the_streamed_prose_is_the_parsed_prose_in_every_split() {
        // Short, because every pair of split points is tried.
        let text = "Hi <b>\n<new_page path=\"A\">\n```\nx </new_page>\n```\n</new_page>tail\n\
<edit path=\"B.md\"><find>a</find>\n<replace>b</replace>\n</edit>\n<x path=\"C\">\n</x>\n\
<edit path=\"Open.md\">\n<find>cut";
        let parsed = parse(text, false);
        assert_eq!(parsed.prose, "Hi <b>\ntail\n");
        assert_eq!((parsed.proposals.len(), parsed.unreadable), (2, 1));
        let expected = parsed.prose;
        let begun = |pieces: &[Piece]| {
            pieces
                .iter()
                .filter(|piece| matches!(piece, Piece::Begun { .. }))
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut whole = Splitter::default();
        let mut pieces = whole.feed(text);
        pieces.extend(whole.finish());
        let expected_begun = begun(&pieces);
        assert_eq!(
            expected_begun,
            [
                Piece::Begun {
                    kind: ProposalKind::NewPage,
                    path: "A".to_owned()
                },
                Piece::Begun {
                    kind: ProposalKind::Edit,
                    path: "B.md".to_owned()
                },
                Piece::Begun {
                    kind: ProposalKind::Edit,
                    path: "Open.md".to_owned()
                },
            ]
        );
        let bounds: Vec<usize> = (0..=text.len())
            .filter(|&at| text.is_char_boundary(at))
            .collect();

        for &first in &bounds {
            for &second in bounds.iter().filter(|&&second| second >= first) {
                let mut splitter = Splitter::default();
                let mut pieces = Vec::new();
                for chunk in [&text[..first], &text[first..second], &text[second..]] {
                    pieces.extend(splitter.feed(chunk));
                }
                pieces.extend(splitter.finish());
                let prose: String = pieces
                    .iter()
                    .filter_map(|piece| match piece {
                        Piece::Prose(text) => Some(text.as_str()),
                        Piece::Begun { .. } => None,
                    })
                    .collect();
                assert_eq!(prose, expected, "split at {first} and {second}");
                assert_eq!(
                    begun(&pieces),
                    expected_begun,
                    "split at {first} and {second}"
                );
            }
        }
    }

    #[test]
    fn the_splitter_holds_back_only_a_line_that_may_become_a_tag() {
        let mut splitter = Splitter::default();

        assert_eq!(
            splitter.feed("Plain <b>text</b>\n<b"),
            [Piece::Prose("Plain <b>text</b>\n".to_owned())]
        );
        assert_eq!(splitter.feed("r>"), [Piece::Prose("<br>".to_owned())]);
        assert_eq!(splitter.feed("\n<new_pa"), [Piece::Prose("\n".to_owned())]);
        assert_eq!(splitter.feed("ge path=\"A.md\""), []);
        assert_eq!(
            splitter.feed(">\n"),
            [Piece::Begun {
                kind: ProposalKind::NewPage,
                path: "A.md".to_owned()
            }]
        );
    }

    #[test]
    fn each_path_rule_refuses_its_case_and_md_is_added_once() {
        for given in [
            "/abs.md", "\\abs.md", "a\\b.md", "C:x.md", "a//b.md", "a/", "", "../x",
        ] {
            assert!(page_path(given).is_err(), "{given:?}");
        }
        for given in ["./x.md", "a/../x.md", "Map.png", "Maps/Map.PNG"] {
            assert!(page_path(given).is_err(), "{given:?}");
        }
        assert_eq!(page_path("Places/Saltmere").unwrap(), "Places/Saltmere.md");
        assert_eq!(
            page_path("Places/Saltmere.MD").unwrap(),
            "Places/Saltmere.MD"
        );
        assert_eq!(page_path(".hidden/x").unwrap(), ".hidden/x.md");
        assert_eq!(page_path("Notes.txt").unwrap(), "Notes.txt.md");
    }

    #[test]
    fn apply_replaces_each_passage_once_and_refuses_missing_repeated_and_overlapping_ones() {
        let passage = |find: &str, replace: &str| Passage {
            find: find.to_owned(),
            replace: replace.to_owned(),
        };
        let text = "# Saltmere\nA port town. The bell is cracked.\n";

        assert_eq!(
            apply(
                text,
                &[passage("cracked", "whole"), passage("port", "fishing")]
            )
            .unwrap(),
            "# Saltmere\nA fishing town. The bell is whole.\n"
        );
        let refused = [
            vec![passage("harbour", "x")],
            vec![passage("e", "x")],
            // Occurs twice, overlapping itself.
            vec![passage("aa", "x")],
            vec![passage("port town", "x"), passage("town. The", "y")],
        ];
        let reasons: Vec<String> = refused
            .iter()
            .map(|passages| apply(&format!("{text}aaa"), passages).unwrap_err())
            .collect();
        assert_eq!(
            reasons,
            [
                "A passage of the edit is not in the page.",
                "A passage of the edit appears more than once in the page.",
                "A passage of the edit appears more than once in the page.",
                "Two passages of the edit overlap in the page.",
            ]
        );
    }

    #[test]
    fn a_text_s_hash_is_the_hash_of_the_text_the_editor_reads() {
        assert_eq!(text_hash("\u{feff}a\r\nb\rc"), text_hash("a\nb\nc"));
        assert_ne!(text_hash("a\nb"), text_hash("a\nb\n"));
    }
}
