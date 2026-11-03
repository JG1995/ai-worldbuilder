import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import type { EditorLink } from "@/types/api";
import { editorLinks, frontmatterEnd } from "./editor-links";

// The class names below are styled in the editor section of src/ui/theme.css.

/** Which view shows the page: the editing view reveals the cursor's lines, the reading view none. */
export type PreviewView = "editing" | "reading";

export const previewView = Facet.define<PreviewView, PreviewView>({
  combine: (values) => values[0] ?? "editing",
});

/** The numbers of the lines that any selection range touches; none in the reading view. */
export function revealedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  if (state.facet(previewView) === "reading") return lines;
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let number = state.doc.lineAt(range.from).number; number <= last; number++) {
      lines.add(number);
    }
  }
  return lines;
}

function sameLines(a: Set<number>, b: Set<number>) {
  return a.size === b.size && [...a].every((number) => b.has(number));
}

/** Extensions of the image files an embed can show; the core reports them as attachments. */
export const imageFile = /\.(png|jpe?g|gif|bmp|svg|webp|avif)$/i;

/**
 * Whether the image embeds' extension (src/ui/image-embeds.ts) draws the embed that starts at a
 * position, which the live preview then leaves alone. Without it, image embeds show as typed in the
 * editing view and as their names in the reading view.
 */
export const drawnImages = Facet.define<
  (state: EditorState, from: number) => boolean,
  ((state: EditorState, from: number) => boolean) | null
>({ combine: (values) => values[0] ?? null });

class TextWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly className: string,
  ) {
    super();
  }

  eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = this.className;
    span.textContent = this.text;
    return span;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-rule";
    return span;
  }
}

/**
 * A task's checkbox in place of its `[ ]`, `[x]` or `[X]`. A press toggles the character between
 * the brackets, before CodeMirror sees it, so the cursor does not move onto the line and redraw it
 * as typed; it changes nothing while the editor is read-only or not editable.
 */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly name: string,
  ) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.name === this.name;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-task-checkbox";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.setAttribute("aria-label", this.name);
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const { state } = view;
      if (event.button !== 0 || state.readOnly || !state.facet(EditorView.editable)) return;
      const at = view.posAtDOM(box) + 1;
      view.dispatch({
        changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" },
        userEvent: "input",
        annotations: isolateHistory.of("full"),
      });
    });
    return box;
  }
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new TextWidget("•", "cm-bullet") });
const rule = Decoration.replace({ widget: new RuleWidget() });
const anchorSeparator = Decoration.replace({ widget: new TextWidget(" > ", "") });

/**
 * A resolved wiki link in the reading view, which Tab reaches although the text is not editable.
 * `data-link` and the spec's `link` are where the link starts in the text; every change in the
 * reading view draws the lines' decorations again, so the attribute stays current.
 */
function focusableLink(link: EditorLink) {
  return Decoration.mark({
    attributes: { tabindex: "0", role: "link", "data-link": String(link.from) },
    link: link.from,
  });
}

/** The formatting of inline elements, by their node's name. */
const marks = new Map(
  Object.entries({
    Emphasis: "cm-em",
    StrongEmphasis: "cm-strong",
    Strikethrough: "cm-strike",
    Highlight: "cm-highlight",
    InlineCode: "cm-code",
    PageComment: "cm-comment",
    Tag: "cm-tag",
  }).map(([name, className]) => [name, Decoration.mark({ class: className })]),
);

/** Markers hidden away from the cursor, with no space after them that hides too. */
const hiddenMarks = new Set([
  "EmphasisMark",
  "StrikethroughMark",
  "HighlightMark",
  "PageCommentMark",
  "BlockId",
]);

const lineClasses = {
  heading: (level: number) => Decoration.line({ class: `cm-heading-${Math.min(level, 4)}` }),
  quote: Decoration.line({ class: "cm-quote" }),
  callout: Decoration.line({ class: "cm-callout" }),
  calloutTitle: Decoration.line({ class: "cm-callout cm-callout-title" }),
  code: Decoration.line({ class: "cm-code-block" }),
  comment: Decoration.line({ class: "cm-comment" }),
};

/** `[!type]`, an optional `+` or `-`, and the title, after a callout's first quote marker. */
const calloutLine = /^(\s*>[ \t]?)(\[!([^\]\s]+)\][+-]?[ \t]*)(.*)$/;

/**
 * The decorations of one visible range, from the syntax tree and the core's links. A node that
 * starts above the range still gives its lines in the range their classes; every other decoration
 * belongs to the range it starts in, so no two ranges add the same one.
 */
class RangeBuilder {
  readonly ranges: Range<Decoration>[] = [];

  constructor(
    private readonly state: EditorState,
    private readonly revealed: Set<number>,
    private readonly links: Map<number, EditorLink>,
    private readonly from: number,
    private readonly to: number,
  ) {}

  private get reading() {
    return this.state.facet(previewView) === "reading";
  }

  private drawsImage(from: number) {
    return this.state.facet(drawnImages)?.(this.state, from) ?? false;
  }

  /** Whether any line from `from` to `to` holds part of the cursor or the selection. */
  private isRevealed(from: number, to: number) {
    const { doc } = this.state;
    const last = doc.lineAt(to).number;
    for (let number = doc.lineAt(from).number; number <= last; number++) {
      if (this.revealed.has(number)) return true;
    }
    return false;
  }

  private inRange(from: number) {
    return from >= this.from && from <= this.to;
  }

  /**
   * Shows `decoration` from `from` to `to`, unless the cursor's lines show the syntax there. A
   * plugin may not replace a line break, so hidden text that spans lines hides line by line, and a
   * widget that would span lines is not drawn.
   */
  private replace(from: number, to: number, decoration = hidden) {
    if (from >= to || this.isRevealed(from, to)) return;
    const { doc } = this.state;
    if (to > doc.lineAt(from).to && decoration !== hidden) return;
    for (let at = from; at < to; ) {
      const line = doc.lineAt(at);
      const end = Math.min(line.to, to);
      if (at < end && this.inRange(at)) this.ranges.push(decoration.range(at, end));
      at = line.to + 1;
    }
  }

  private mark(from: number, to: number, decoration: Decoration) {
    if (from < to && this.inRange(from)) this.ranges.push(decoration.range(from, to));
  }

  /** `decoration` on each line from `from` to `to` that is in this visible range. */
  private lines(from: number, to: number, decoration: Decoration) {
    const { doc } = this.state;
    const first = doc.lineAt(Math.max(from, this.from)).number;
    const last = doc.lineAt(Math.min(to, this.to)).number;
    for (let number = first; number <= last; number++) {
      const line = doc.line(number);
      this.ranges.push(decoration.range(line.from));
    }
  }

  /** Decorates `node` and says whether to go on into its children. */
  enter(node: SyntaxNodeRef): boolean {
    const { name } = node;
    const mark = marks.get(name);
    if (mark) this.mark(node.from, node.to, mark);
    if (hiddenMarks.has(name)) {
      this.replace(node.from, node.to);
      return false;
    }
    const heading = /^ATXHeading(\d)$/.exec(name);
    if (heading) return this.atxHeading(node, Number(heading[1]));
    const setext = /^SetextHeading(\d)$/.exec(name);
    if (setext) return this.setextHeading(node, Number(setext[1]));
    switch (name) {
      case "InlineCode":
        return true;
      case "CodeMark":
        // Only inline code's: fenced code is handled whole.
        this.replace(node.from, node.to);
        return false;
      case "FencedCode":
        return this.fencedCode(node);
      case "CodeBlock":
        this.lines(node.from, node.to, lineClasses.code);
        return false;
      case "Blockquote":
        return this.blockquote(node);
      case "QuoteMark":
        this.replace(node.from, this.spaceAfter(node.to, 1));
        return false;
      case "ListMark":
        if (node.node.parent?.parent?.name === "BulletList") {
          this.replace(node.from, node.to, bullet);
        }
        return false;
      case "TaskMarker":
        return this.taskMarker(node);
      case "HorizontalRule":
        this.replace(node.from, node.to, rule);
        return false;
      case "Link":
        return this.link(node);
      case "Autolink":
        this.replace(node.from, node.from + 1);
        this.replace(node.to - 1, node.to);
        return false;
      case "Escape":
        this.replace(node.from, node.from + 1);
        return false;
      case "PageComment":
        if (this.reading) this.replace(node.from, node.to);
        return !this.reading;
      case "PageCommentBlock":
        this.lines(node.from, node.to, lineClasses.comment);
        if (this.reading) this.replace(node.from, node.to);
        return !this.reading;
      case "WikiLink":
      case "WikiEmbed":
        if (!this.drawsImage(node.from)) this.wikiLink(node);
        return false;
      case "Image":
        // Its text, while no image can show.
        return !this.drawsImage(node.from) && this.reading && this.link(node, 2);
      case "Table":
      case "HTMLBlock":
      case "HTMLTag":
        return false;
      default:
        return true;
    }
  }

  /** The position after up to `count` spaces or tabs from `at` on its line. */
  private spaceAfter(at: number, count = Number.POSITIVE_INFINITY) {
    const line = this.state.doc.lineAt(at);
    let end = at;
    while (end < line.to && end - at < count && /[ \t]/.test(line.text[end - line.from])) end++;
    return end;
  }

  private atxHeading(node: SyntaxNodeRef, level: number) {
    this.lines(node.from, node.to, lineClasses.heading(level));
    for (let mark = node.node.firstChild; mark; mark = mark.nextSibling) {
      if (mark.name !== "HeaderMark") continue;
      if (mark.from === node.from) this.replace(mark.from, this.spaceAfter(mark.to));
      else {
        // A closing sequence, and the space before it.
        const before = this.state.sliceDoc(node.from, mark.from).trimEnd().length;
        this.replace(node.from + before, mark.to);
      }
    }
    return true;
  }

  private setextHeading(node: SyntaxNodeRef, level: number) {
    const underline = node.node.getChild("HeaderMark");
    this.lines(node.from, underline ? underline.from - 1 : node.to, lineClasses.heading(level));
    if (underline) this.replace(underline.from, underline.to);
    return true;
  }

  private fencedCode(node: SyntaxNodeRef) {
    const { doc } = this.state;
    this.lines(node.from, node.to, lineClasses.code);
    const first = doc.lineAt(node.from);
    this.replace(node.from, first.to);
    const last = node.node.lastChild;
    if (last?.name === "CodeMark" && last.from > first.to) this.replace(last.from, last.to);
    return false;
  }

  private blockquote(node: SyntaxNodeRef) {
    const first = this.state.doc.lineAt(node.from);
    const callout = node.node.parent?.name === "Document" ? calloutLine.exec(first.text) : null;
    if (!callout) {
      this.lines(node.from, node.to, lineClasses.quote);
      return true;
    }
    const [, quote, marker, type, title] = callout;
    const markerFrom = first.from + quote.length;
    this.lines(first.from, first.from, lineClasses.calloutTitle);
    if (node.to > first.to) this.lines(first.to + 1, node.to, lineClasses.callout);
    if (title.trim() !== "") this.replace(markerFrom, markerFrom + marker.length);
    else {
      const name = type.charAt(0).toUpperCase() + type.slice(1);
      const widget = Decoration.replace({ widget: new TextWidget(name, "") });
      this.replace(markerFrom, first.to, widget);
    }
    return true;
  }

  private taskMarker(node: SyntaxNodeRef) {
    const checked = this.state.sliceDoc(node.from + 1, node.from + 2) !== " ";
    const name = this.state.sliceDoc(node.to, this.state.doc.lineAt(node.to).to).trim();
    this.replace(
      node.from,
      node.to,
      Decoration.replace({ widget: new CheckboxWidget(checked, name) }),
    );
    return false;
  }

  /**
   * An inline link, `[text](address)`, or an image, `![text](address)`, whose opening mark is
   * `opening` long: its text shows, or its address when it has none.
   */
  private link(node: SyntaxNodeRef, opening = 1) {
    const children = [];
    for (let child = node.node.firstChild; child; child = child.nextSibling) children.push(child);
    const close = children.find(
      (child) => child.name === "LinkMark" && this.state.sliceDoc(child.from, child.to) === "]",
    );
    const open = children.find(
      (child) => child.name === "LinkMark" && this.state.sliceDoc(child.from, child.to) === "(",
    );
    if (!close || !open || open.from !== close.to) return true;
    const url = children.find((child) => child.name === "URL");
    const text = node.from + opening;
    if (close.from === text && url) {
      this.replace(node.from, url.from);
      this.replace(url.to, node.to);
      return false;
    }
    this.replace(node.from, text);
    this.replace(close.from, node.to);
    return true;
  }

  /**
   * A wiki link or embed the core reported: its display text, the part after `|`, or the target
   * with ` > ` before the heading or block. A link the core did not report shows as typed, and so
   * does an image embed in the editing view; the reading view shows an image embed's name. A
   * resolved link in the reading view takes keyboard focus.
   */
  private wikiLink(node: SyntaxNodeRef) {
    const link = this.links.get(node.from);
    if (!link || link.to !== node.to) return;
    const image = link.state === "attachment" && imageFile.test(link.target);
    if (image && !this.reading) return;
    const open = node.node.firstChild;
    const close = node.node.lastChild;
    if (!open || !close) return;
    if (this.reading && link.state === "resolved") {
      this.mark(node.from, node.to, focusableLink(link));
    }
    this.replace(open.from, open.to);
    this.replace(close.from, close.to);
    const inner = this.state.sliceDoc(open.to, close.from);
    const pipe = inner.indexOf("|");
    if (image) {
      if (pipe >= 0) this.replace(open.to + pipe, close.from);
      return;
    }
    if (pipe >= 0 && inner.slice(pipe + 1).trim() !== "") {
      this.replace(open.to, open.to + pipe + 1);
      return;
    }
    if (pipe >= 0) this.replace(open.to + pipe, close.from);
    const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
    for (let at = target.indexOf("#"); at >= 0; at = target.indexOf("#", at + 1)) {
      const from = open.to + at;
      if (at === 0) this.replace(from, from + 1);
      else this.replace(from, from + 1, anchorSeparator);
    }
  }
}

/** The core's links, by where they start. */
function linksByStart(state: EditorState) {
  return new Map((state.field(editorLinks, false)?.links ?? []).map((link) => [link.from, link]));
}

/** Where the text after any leading frontmatter starts. */
export function bodyStart(state: EditorState) {
  const end = frontmatterEnd(state.doc);
  return end === 0 ? 0 : state.doc.line(end).to + 1;
}

/**
 * Decorates the inline elements inside a node by the same rules as the lines away from the cursor,
 * for text the editor draws outside its lines, such as a table's cells. Each call gives the
 * decorations of one node's children.
 */
export function inlineDecorator(state: EditorState) {
  const links = linksByStart(state);
  return (node: SyntaxNode): Range<Decoration>[] => {
    const builder = new RangeBuilder(state, new Set(), links, node.from, node.to);
    const walk = (child: SyntaxNode) => {
      if (!builder.enter(child)) return;
      for (let inner = child.firstChild; inner; inner = inner.nextSibling) walk(inner);
    };
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
    return builder.ranges;
  };
}

/** The decorations of the visible ranges, outside any leading frontmatter. */
function previewDecorations(view: EditorView, revealed: Set<number>): DecorationSet {
  const { state } = view;
  const start = bodyStart(state);
  const links = linksByStart(state);
  const tree = syntaxTree(state);
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    const builder = new RangeBuilder(state, revealed, links, from, to);
    tree.iterate({
      from: Math.max(from, start),
      to,
      enter: (node) => {
        if (node.to <= start) return false;
        if (node.from < start) return true;
        return builder.enter(node);
      },
    });
    ranges.push(...builder.ranges);
  }
  return Decoration.set(ranges, true);
}

/**
 * The live preview: Markdown's elements formatted, with their syntax hidden on the lines that hold
 * no part of the cursor or the selection. Only what is drawn changes; the text keeps every
 * character, and only a checkbox's press changes it.
 */
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    revealed: Set<number>;

    constructor(view: EditorView) {
      this.revealed = revealedLines(view.state);
      this.decorations = previewDecorations(view, this.revealed);
    }

    update(update: ViewUpdate) {
      const revealed = revealedLines(update.state);
      const changed =
        update.docChanged ||
        update.viewportChanged ||
        !sameLines(revealed, this.revealed) ||
        update.startState.facet(previewView) !== update.state.facet(previewView) ||
        update.startState.facet(drawnImages) !== update.state.facet(drawnImages) ||
        update.startState.field(editorLinks, false) !== update.state.field(editorLinks, false) ||
        syntaxTree(update.startState) !== syntaxTree(update.state);
      this.revealed = revealed;
      if (changed) this.decorations = previewDecorations(update.view, revealed);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
