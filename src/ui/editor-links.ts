import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  type ChangeSet,
  type EditorState,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { EditorLink } from "@/types/api";

// The class names below are styled in the editor section of src/ui/theme.css.
const resolvedMark = Decoration.mark({ class: "cm-link" });
const unresolvedMark = Decoration.mark({ class: "cm-link-unresolved" });

/** How long finding a heading may parse a long page before it settles for what is parsed. */
const headingParseTimeout = 500;

/**
 * The number of the line that closes a leading frontmatter block, or 0 when the page has none: the
 * first line is `---` once trailing whitespace is removed, up to the next such line. The core finds
 * the frontmatter by the same rule.
 */
export function frontmatterEnd(doc: Text) {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== "---") return 0;
  for (let end = 2; end <= doc.lines; end++) {
    if (doc.line(end).text.trimEnd() === "---") return end;
  }
  return 0;
}

type Links = { links: readonly EditorLink[]; marks: DecorationSet };

/** `links` with a mark for each resolved and unresolved link; attachments get none. */
function marked(links: readonly EditorLink[]): Links {
  const ranges = links.flatMap((link) => {
    if (link.state === "attachment") return [];
    const mark = link.state === "resolved" ? resolvedMark : unresolvedMark;
    return [mark.range(link.from, link.to)];
  });
  return { links, marks: Decoration.set(ranges, true) };
}

/** `links` moved through `changes`, without each link whose text the changes touch. */
function mapped(links: readonly EditorLink[], changes: ChangeSet): Links {
  const touched: [number, number][] = [];
  changes.iterChangedRanges((from, to) => touched.push([from, to]));
  const kept = links.flatMap((link) => {
    if (touched.some(([from, to]) => from < link.to && to > link.from)) return [];
    return [{ ...link, from: changes.mapPos(link.from, 1), to: changes.mapPos(link.to, -1) }];
  });
  return marked(kept);
}

const setLinksEffect = StateEffect.define<readonly EditorLink[]>();

/** The effect that gives the editor `links`, the core's links of its current text. */
export function setLinks(links: readonly EditorLink[]) {
  return setLinksEffect.of(links);
}

/**
 * The links of the editor's text, as the core last reported them, and their marks. Edits move
 * them; a link whose text an edit touches loses its mark until the core reports the text again.
 */
export const editorLinks = StateField.define<Links>({
  create: () => marked([]),
  update: (value, transaction) => {
    let next = transaction.docChanged ? mapped(value.links, transaction.changes) : value;
    for (const effect of transaction.effects) {
      if (effect.is(setLinksEffect)) next = marked(effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
});

/** The link that `position` is in or at an end of, from the links the core last reported. */
export function linkAt(state: EditorState, position: number): EditorLink | null {
  const links = state.field(editorLinks, false)?.links ?? [];
  return links.find((link) => link.from <= position && position <= link.to) ?? null;
}

/** Where a link points inside its page: a heading, or a block `^id` (without the `^`). */
export type LinkAnchor = { heading: string | null; block: string | null };

/**
 * Where the anchor is in the page's text, after any frontmatter: the start of the first ATX or
 * Setext heading whose text, without its `#` or underline markers and surrounding whitespace,
 * equals the heading ignoring letter case; or the start of the first line that ends in whitespace
 * and `^id`. Null when the page has no such heading or block, or the link names neither.
 */
export function findAnchor(state: EditorState, { heading, block }: LinkAnchor): number | null {
  const bodyLine = frontmatterEnd(state.doc) + 1;
  if (bodyLine > state.doc.lines) return null;
  const bodyStart = state.doc.line(bodyLine).from;
  if (heading !== null) return headingStart(state, bodyStart, heading.toLowerCase());
  if (block !== null) return blockStart(state.doc, bodyLine, `^${block}`);
  return null;
}

function headingStart(state: EditorState, bodyStart: number, wanted: string) {
  const tree = ensureSyntaxTree(state, state.doc.length, headingParseTimeout) ?? syntaxTree(state);
  let found: number | null = null;
  tree.iterate({
    from: bodyStart,
    enter: (node) => {
      if (found !== null) return false;
      if (!/^(ATX|Setext)Heading\d$/.test(node.name)) return undefined;
      if (node.from >= bodyStart && headingText(state, node.node).toLowerCase() === wanted) {
        found = node.from;
      }
      return false;
    },
  });
  return found;
}

/** The parts of a syntax tree node that a heading's text is read from. */
type HeadingNode = { from: number; to: number; firstChild: HeadingPart | null };
type HeadingPart = { name: string; from: number; to: number; nextSibling: HeadingPart | null };

/** A heading's text without its markers, with whitespace runs as one space. */
function headingText(state: EditorState, heading: HeadingNode) {
  let text = "";
  let at = heading.from;
  for (let child = heading.firstChild; child; child = child.nextSibling) {
    if (child.name !== "HeaderMark") continue;
    text += state.sliceDoc(at, child.from);
    at = child.to;
  }
  text += state.sliceDoc(at, heading.to);
  return text.replace(/\s+/g, " ").trim();
}

function blockStart(doc: Text, firstLine: number, marker: string) {
  for (let number = firstLine; number <= doc.lines; number++) {
    const line = doc.line(number);
    const text = line.text.trimEnd();
    if (!text.endsWith(marker)) continue;
    const before = text.slice(0, -marker.length);
    if (before === "" || /\s$/.test(before)) return line.from;
  }
  return null;
}
