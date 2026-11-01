//! One page's text to its wiki links and aliases.
//!
//! The text is the editor's (`page::text_of`): no byte-order mark and `\n` line endings. The
//! frontmatter is found by the editor's rule: a first line that is `---` once trailing whitespace is
//! removed, up to the next such line. Its body is read as YAML for `aliases`. The rest of the text
//! goes to pulldown-cmark with only its wiki-link option, which leaves out code and Markdown links.
//! Its metadata-block option is not used, because it takes any later `---` … `---` region for
//! metadata and would lose the links between two thematic breaks.

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use yaml_rust2::parser::{Event as YamlEvent, Parser as YamlParser};
use yaml_rust2::{Yaml, YamlLoader};

/// The extensions of the image, audio, video and PDF files a link can name.
const ATTACHMENTS: [&str; 20] = [
    "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "mp3", "wav", "m4a", "ogg", "flac",
    "3gp", "mp4", "webm", "ogv", "mov", "mkv", "pdf",
];
/// A context line holds at most this many characters of its line, with at most `BEFORE_LINK` of
/// them before the link.
const CONTEXT_CHARS: usize = 160;
const BEFORE_LINK: usize = 60;
const CUT: &str = "…";

/// What a page's text holds for the index.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub aliases: Vec<String>,
    pub links: Vec<Link>,
}

/// One wiki link, `[[…]]` or `![[…]]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Where the whole link starts and ends in the text, in UTF-16 code units, as the editor counts.
    pub start: u64,
    pub end: u64,
    /// The page part: before `|` and `#`, without surrounding whitespace and a trailing `.md`.
    /// Empty for a link to the page it is in, such as `[[#Docks]]`.
    pub target: String,
    /// The part after the last `#`: a heading, or a block when it starts with `^` (kept without it).
    pub heading: Option<String>,
    pub block: Option<String>,
    /// `![[…]]`.
    pub embed: bool,
    /// The target names an image, audio, video or PDF file.
    pub attachment: bool,
    /// The line that holds the link's start, cut around the link.
    pub line: String,
}

/// The aliases and links of the page named `name` (its file name without `.md`) whose text is
/// `text`.
pub fn parse(text: &str, name: &str) -> Parsed {
    let (frontmatter, body_start) = match frontmatter(text) {
        Some((body, end)) => (Some(body), end),
        None => (None, 0),
    };
    Parsed {
        aliases: frontmatter.map_or_else(Vec::new, |body| aliases(body, name)),
        links: links(text, body_start),
    }
}

/// The frontmatter's body, the lines between its two `---` lines, and where the text after it
/// starts, in bytes.
fn frontmatter(text: &str) -> Option<(&str, usize)> {
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let body_start = first.len();
    let mut offset = body_start;
    for line in lines {
        let line_start = offset;
        offset += line.len();
        if line.trim_end() == "---" {
            return Some((&text[body_start..line_start], offset));
        }
    }
    None
}

/// The deepest nesting of lists and maps that frontmatter may have. The YAML loader builds and drops
/// its tree recursively, so deeper nesting could overflow the thread's stack and abort the app.
const MAX_YAML_DEPTH: usize = 64;

/// Whether the YAML loader can safely load `frontmatter`: it is valid YAML, nests at most
/// `MAX_YAML_DEPTH` deep, and has no YAML aliases (`*name`), which the loader expands by copying,
/// so that a few lines of nested aliases could build a document too large for memory. Reads the
/// parser's events one by one, because its own `load` recurses for each level of nesting.
fn loadable(frontmatter: &str) -> bool {
    let mut parser = YamlParser::new_from_str(frontmatter);
    let mut depth = 0;
    loop {
        match parser.next_token() {
            Ok((YamlEvent::StreamEnd, _)) => return true,
            Ok((YamlEvent::SequenceStart(..) | YamlEvent::MappingStart(..), _)) => {
                depth += 1;
                if depth > MAX_YAML_DEPTH {
                    return false;
                }
            }
            Ok((YamlEvent::SequenceEnd | YamlEvent::MappingEnd, _)) => depth -= 1,
            Ok((YamlEvent::Alias(_), _)) | Err(_) => return false,
            Ok(_) => {}
        }
    }
}

/// The page's aliases from the frontmatter's `aliases` property, a list of strings or one string.
/// Frontmatter that `loadable` refuses gives none, because page text is untrusted.
fn aliases(frontmatter: &str, name: &str) -> Vec<String> {
    if !loadable(frontmatter) {
        return Vec::new();
    }
    let Ok(documents) = YamlLoader::load_from_str(frontmatter) else {
        return Vec::new();
    };
    let Some(document) = documents.first() else {
        return Vec::new();
    };
    let values: Vec<&str> = match &document["aliases"] {
        Yaml::Array(items) => items.iter().filter_map(Yaml::as_str).collect(),
        Yaml::String(alias) => vec![alias.as_str()],
        _ => Vec::new(),
    };
    let name = name.to_lowercase();
    let mut kept: Vec<String> = Vec::new();
    for alias in values {
        let alias = alias.trim();
        let usable = !alias.is_empty()
            && alias.to_lowercase() != name
            && !alias.contains(['[', ']', '|', '#', '^']);
        if usable && !kept.iter().any(|kept| kept == alias) {
            kept.push(alias.to_owned());
        }
    }
    kept
}

/// The wiki links in `text` after its first `body_start` bytes.
fn links(text: &str, body_start: usize) -> Vec<Link> {
    let body = &text[body_start..];
    let mut offsets = Utf16Offsets::new(text);
    let mut links = Vec::new();
    for (event, range) in Parser::new_ext(body, Options::ENABLE_WIKILINKS).into_offset_iter() {
        let (dest, embed) = match event {
            Event::Start(Tag::Link {
                link_type: LinkType::WikiLink { .. },
                dest_url,
                ..
            }) => (dest_url, false),
            Event::Start(Tag::Image {
                link_type: LinkType::WikiLink { .. },
                dest_url,
                ..
            }) => (dest_url, true),
            _ => continue,
        };
        let (start, end) = (body_start + range.start, body_start + range.end);
        if text[start..end].contains('\n') {
            continue;
        }
        let Some(mut link) = link_of(&dest, embed) else {
            continue;
        };
        link.line = context_line(text, start, end);
        link.start = offsets.at(start);
        link.end = offsets.at(end);
        links.push(link);
    }
    links
}

/// A link to the destination `dest`, the text before any `|`, without its position and line. A
/// destination with neither a target nor a heading or block is not a link.
fn link_of(dest: &str, embed: bool) -> Option<Link> {
    let (target, anchor) = match dest.split_once('#') {
        Some((target, rest)) => (target, rest.rsplit('#').next()),
        None => (dest, None),
    };
    let target = target.trim();
    let target = strip_suffix_ignoring_case(target, ".md").trim_end();
    let anchor = anchor.map(str::trim).filter(|anchor| !anchor.is_empty());
    let (heading, block) = match anchor {
        Some(anchor) => match anchor.strip_prefix('^') {
            Some("") => (None, None),
            Some(block) => (None, Some(block.to_owned())),
            None => (Some(anchor.to_owned()), None),
        },
        None => (None, None),
    };
    if target.is_empty() && heading.is_none() && block.is_none() {
        return None;
    }
    Some(Link {
        start: 0,
        end: 0,
        attachment: is_attachment(target),
        target: target.to_owned(),
        heading,
        block,
        embed,
        line: String::new(),
    })
}

fn strip_suffix_ignoring_case<'a>(text: &'a str, suffix: &str) -> &'a str {
    let cut = text.len().wrapping_sub(suffix.len());
    match text.get(cut..) {
        Some(end) if end.eq_ignore_ascii_case(suffix) => &text[..cut],
        _ => text,
    }
}

fn is_attachment(target: &str) -> bool {
    target.rsplit_once('.').is_some_and(|(_, extension)| {
        ATTACHMENTS
            .iter()
            .any(|known| extension.eq_ignore_ascii_case(known))
    })
}

/// The line of `text` that holds the link from `start` to `end` (in bytes), cut to at most
/// `CONTEXT_CHARS` characters with at most `BEFORE_LINK` before the link, with `…` where cut.
fn context_line(text: &str, start: usize, end: usize) -> String {
    let line_start = text[..start].rfind('\n').map_or(0, |newline| newline + 1);
    let line_end = text[end..]
        .find('\n')
        .map_or(text.len(), |newline| end + newline);
    let line = &text[line_start..line_end];
    let before = text[line_start..start].chars().count();
    let skip = before.saturating_sub(BEFORE_LINK);
    let mut context = String::new();
    if skip > 0 {
        context.push_str(CUT);
    }
    context.extend(line.chars().skip(skip).take(CONTEXT_CHARS));
    if line.chars().count() > skip + CONTEXT_CHARS {
        context.push_str(CUT);
    }
    context
}

/// Converts byte offsets into a text, given in increasing order, to UTF-16 code units.
struct Utf16Offsets<'a> {
    text: &'a str,
    byte: usize,
    units: u64,
}

impl<'a> Utf16Offsets<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            byte: 0,
            units: 0,
        }
    }

    fn at(&mut self, byte: usize) -> u64 {
        if byte < self.byte {
            self.byte = 0;
            self.units = 0;
        }
        self.units += self.text[self.byte..byte]
            .chars()
            .map(|c| c.len_utf16() as u64)
            .sum::<u64>();
        self.byte = byte;
        self.units
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links_of(text: &str) -> Vec<Link> {
        parse(text, "Kesh Tor").links
    }

    /// A link's target, heading, block, embed and attachment, which every form decides.
    type Form = (String, Option<String>, Option<String>, bool, bool);

    fn forms(text: &str) -> Vec<Form> {
        links_of(text)
            .into_iter()
            .map(|link| {
                (
                    link.target,
                    link.heading,
                    link.block,
                    link.embed,
                    link.attachment,
                )
            })
            .collect()
    }

    fn form(
        target: &str,
        heading: Option<&str>,
        block: Option<&str>,
        embed: bool,
        attachment: bool,
    ) -> Form {
        (
            target.to_owned(),
            heading.map(str::to_owned),
            block.map(str::to_owned),
            embed,
            attachment,
        )
    }

    /// The text each link covers, from its UTF-16 range.
    fn covered(text: &str) -> Vec<String> {
        let units: Vec<u16> = text.encode_utf16().collect();
        links_of(text)
            .iter()
            .map(|link| String::from_utf16(&units[link.start as usize..link.end as usize]).unwrap())
            .collect()
    }

    #[test]
    fn every_link_form_gives_its_target_heading_block_and_flags() {
        let text = "[[Mirela]] and [[Mirela|the captain]] and [[Saltmere#Docks]] and \
                    [[Saltmere#^harbour-1]]\n\
                    ![[Saltmere]] ![[Saltmere#Docks|the docks]] [[#Docks]] [[#^b2]]\n\
                    [[ Saltmere.MD ]] [[Places/Saltmere.md#A#B]] [[map.png]] ![[song.MP3]] \
                    [[]] [[#]] [[#^]] [[|nothing]] [Mirela](People/Mirela.md)\n";

        assert_eq!(
            forms(text),
            [
                form("Mirela", None, None, false, false),
                form("Mirela", None, None, false, false),
                form("Saltmere", Some("Docks"), None, false, false),
                form("Saltmere", None, Some("harbour-1"), false, false),
                form("Saltmere", None, None, true, false),
                form("Saltmere", Some("Docks"), None, true, false),
                form("", Some("Docks"), None, false, false),
                form("", None, Some("b2"), false, false),
                form("Saltmere", None, None, false, false),
                form("Places/Saltmere", Some("B"), None, false, false),
                form("map.png", None, None, false, true),
                form("song.MP3", None, None, true, true),
            ]
        );
        assert_eq!(
            covered(text)[..6],
            [
                "[[Mirela]]",
                "[[Mirela|the captain]]",
                "[[Saltmere#Docks]]",
                "[[Saltmere#^harbour-1]]",
                "![[Saltmere]]",
                "![[Saltmere#Docks|the docks]]",
            ]
        );
    }

    #[test]
    fn links_in_code_and_in_the_frontmatter_are_not_links() {
        let text = "---\naliases: [Mira]\nfriend: \"[[Frontmatter]]\"\n---\n\
                    Inline `[[Code span]]` here.\n\n\
                    ```\n[[Fenced]]\n```\n\n\
                    ~~~md\n[[Tilde fenced]]\n~~~\n\n\
                    \x20   [[Indented]]\n\n\
                    After [[Real]].\n";

        assert_eq!(covered(text), ["[[Real]]"]);
    }

    #[test]
    fn a_link_between_two_thematic_breaks_later_in_the_page_is_found() {
        let text = "# Kesh Tor\n\nIntro.\n\n---\n[[Between]]\n---\n\nEnd [[After]].\n";

        assert_eq!(covered(text), ["[[Between]]", "[[After]]"]);
    }

    #[test]
    fn a_page_whose_first_line_is_not_a_rule_has_no_frontmatter() {
        let text = "Intro.\n---\naliases: [Mira]\n---\n[[Mirela]]\n";

        let parsed = parse(text, "Kesh Tor");

        assert!(parsed.aliases.is_empty());
        assert_eq!(covered(text), ["[[Mirela]]"]);
    }

    #[test]
    fn a_first_rule_with_no_closing_line_is_no_frontmatter() {
        let text = "---\naliases: [Mira]\nSee [[Mirela]].\n";

        let parsed = parse(text, "Kesh Tor");

        assert!(parsed.aliases.is_empty());
        assert_eq!(covered(text), ["[[Mirela]]"]);
    }

    #[test]
    fn ranges_after_the_frontmatter_count_from_the_start_of_the_page() {
        let text = "---  \naliases: Mira\n---\t\nSee [[Mirela]].\n";

        let link = &links_of(text)[0];

        assert_eq!(text.find("[[").unwrap() as u64, link.start);
        assert_eq!(text.find("]]").unwrap() as u64 + 2, link.end);
        assert_eq!(link.line, "See [[Mirela]].");
    }

    #[test]
    fn a_link_that_spans_lines_is_not_a_link() {
        assert!(links_of("[[Mire\nla]] and [[Kesh|Tor\nhill]]\n").is_empty());
    }

    #[test]
    fn ranges_count_utf_16_code_units() {
        let text = "😀 é [[Mirela|🐉]] [[Saltmere]]";

        let links = links_of(text);

        // 😀 is two units; é is one.
        assert_eq!((links[0].start, links[0].end), (5, 18));
        assert_eq!((links[1].start, links[1].end), (19, 31));
        assert_eq!(covered(text), ["[[Mirela|🐉]]", "[[Saltmere]]"]);
    }

    #[test]
    fn a_long_line_is_cut_around_the_link() {
        let before = "a".repeat(100);
        let after = "b".repeat(300);
        let text = format!("{before}[[Mirela]]{after}\nshort [[Mirela]]");

        let links = links_of(&text);

        let expected_start = format!("…{}[[Mirela]]", "a".repeat(60));
        assert!(links[0].line.starts_with(&expected_start));
        assert!(links[0].line.ends_with("b…"));
        assert_eq!(links[0].line.chars().count(), 160 + 2);
        assert_eq!(links[1].line, "short [[Mirela]]");
    }

    fn aliases_of(frontmatter: &str) -> Vec<String> {
        parse(&format!("---\n{frontmatter}\n---\nBody\n"), "Mirela").aliases
    }

    #[test]
    fn aliases_come_from_a_list_or_a_string_and_drop_unusable_ones() {
        assert_eq!(
            aliases_of("aliases:\n  - Mira\n  - the captain\n  - 7\n  - [nested]"),
            ["Mira", "the captain"]
        );
        assert_eq!(aliases_of("aliases: [Mira, \"Cap\"]"), ["Mira", "Cap"]);
        assert_eq!(aliases_of("aliases: Mira"), ["Mira"]);
        assert_eq!(
            aliases_of("aliases: [\"\", mirela, \"a[b\", \"a]b\", a|b, \"a#b\", a^b, Ok]"),
            ["Ok"]
        );
        assert!(aliases_of("alias: Mira").is_empty());
        assert!(aliases_of("aliases: [Mira").is_empty());
        assert!(aliases_of("tags: [x]").is_empty());
        assert!(aliases_of("- just\n- a list").is_empty());
    }

    #[test]
    fn invalid_yaml_still_leaves_the_links() {
        let parsed = parse("---\naliases: [Mira\n---\n[[Mirela]]\n", "Kesh Tor");

        assert!(parsed.aliases.is_empty());
        assert_eq!(parsed.links.len(), 1);
    }

    #[test]
    fn frontmatter_with_yaml_aliases_gives_no_aliases_and_is_not_expanded() {
        // Each level doubles the one before: expanded, the last would hold 2^40 strings.
        let mut nested = "a0: &a0 [x, x]\n".to_owned();
        for level in 1..=40 {
            let before = level - 1;
            nested.push_str(&format!("a{level}: &a{level} [*a{before}, *a{before}]\n"));
        }

        assert!(aliases_of(&format!("aliases: [Mira]\n{nested}")).is_empty());
        assert!(aliases_of("name: &n Mira\naliases: [*n]").is_empty());
    }

    #[test]
    fn deeply_nested_yaml_gives_no_aliases_and_still_leaves_the_links() {
        let nested = "- ".repeat(100_000);
        let text = format!("---\naliases: [Mira]\nx:\n  {nested}y\n---\nSee [[Mirela]].\n");

        let parsed = parse(&text, "Kesh Tor");

        assert!(parsed.aliases.is_empty());
        assert_eq!(covered(&text), ["[[Mirela]]"]);
    }
}
