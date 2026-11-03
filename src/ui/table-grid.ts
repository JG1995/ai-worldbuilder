import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSet, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { editorLinks } from "./editor-links";
import { imageCells, imagesRedraw } from "./image-embeds";
import { bodyStart, inlineDecorator, previewView, revealedLines } from "./live-preview";
import { webLinksShown } from "./web-links";

// The class names below are styled in the editor section of src/ui/theme.css.

type Alignment = "left" | "center" | "right" | null;

/**
 * Drawn text of a cell from `at`, with its formatting's classes, or a widget a decoration draws
 * in place of the syntax at `at`; `link` is where the focusable link it belongs to starts, in the
 * reading view, and `address` the address of the web link it belongs to. Positions are offsets
 * from the start of the table's first line.
 */
type Piece = ({ text: string; className: string } | { widget: Decoration }) & {
  at: number;
  link?: number;
  address?: string;
};

/** A cell's place in the text, from its first to its last character, and what it draws. */
type Cell = { from: number; to: number; pieces: Piece[] };

type Grid = { alignments: Alignment[]; header: Cell[]; body: Cell[][] };

/**
 * Where each drawn text node's first character is, where each cell's text ends, and where each
 * focusable link starts.
 */
const textStarts = new WeakMap<Node, number>();
const cellEnds = new WeakMap<Element, number>();
const linkStarts = new WeakMap<Element, number>();

function samePiece(a: Piece, b: Piece) {
  if (a.link !== b.link || a.address !== b.address) return false;
  if ("widget" in a || "widget" in b) {
    return "widget" in a && "widget" in b && a.at === b.at && a.widget.eq(b.widget);
  }
  return a.at === b.at && a.text === b.text && a.className === b.className;
}

function sameCells(a: Cell[], b: Cell[]) {
  return (
    a.length === b.length &&
    a.every(
      (cell, index) =>
        cell.from === b[index].from &&
        cell.to === b[index].to &&
        cell.pieces.length === b[index].pieces.length &&
        cell.pieces.every((piece, at) => samePiece(piece, b[index].pieces[at])),
    )
  );
}

/** Where the pointer's caret is, in browsers that can say; WebKit has only the older method. */
function caretAt(x: number, y: number) {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * The position in the text of a press on a grid's cell: the pressed character's place in the
 * cell's text when the browser can find it, otherwise the end of the cell's text. Null when the
 * press is not on a cell.
 */
export function gridPosition(view: EditorView, event: MouseEvent): number | null {
  const cell = event.target instanceof Element ? event.target.closest("td, th") : null;
  const end = cell ? cellEnds.get(cell) : undefined;
  const wrapper = cell?.closest(".cm-table-wrap");
  if (!cell || end === undefined || !wrapper || !view.contentDOM.contains(wrapper)) return null;
  const start = view.posAtDOM(wrapper);
  const caret = caretAt(event.clientX, event.clientY);
  const textStart = caret && cell.contains(caret.node) ? textStarts.get(caret.node) : undefined;
  return start + (caret && textStart !== undefined ? textStart + caret.offset : end);
}

/**
 * Where the link that a focusable element the reading view draws, in a line or in a grid's cell,
 * starts in the text. A grid keeps its links' places from its table's start, because an edit
 * elsewhere moves a grid without drawing it again.
 */
export function linkStart(view: EditorView, link: Element): number | null {
  const wrapper = link.closest(".cm-table-wrap");
  if (!wrapper) return Number(link.getAttribute("data-link"));
  const start = linkStarts.get(link);
  return start === undefined ? null : view.posAtDOM(wrapper) + start;
}

/** A table drawn as a grid in place of its lines, built from text and elements, never HTML. */
class GridWidget extends WidgetType {
  constructor(readonly grid: Grid) {
    super();
  }

  eq(other: GridWidget) {
    const { alignments, header, body } = other.grid;
    return (
      alignments.join() === this.grid.alignments.join() &&
      sameCells(header, this.grid.header) &&
      body.length === this.grid.body.length &&
      body.every((row, index) => sameCells(row, this.grid.body[index]))
    );
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const head = document.createElement("thead");
    head.append(this.row(view, this.grid.header, "th"));
    const body = document.createElement("tbody");
    for (const cells of this.grid.body) body.append(this.row(view, cells, "td"));
    table.append(head, body);
    wrapper.append(table);
    // A press on a cell puts the cursor in its text, which shows the table as Markdown. A press
    // that follows a link has its default prevented before it gets here.
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const position = gridPosition(view, event);
      if (position === null) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: position }, userEvent: "select.pointer" });
      view.focus();
    });
    return wrapper;
  }

  private row(view: EditorView, cells: Cell[], tag: "th" | "td") {
    const row = document.createElement("tr");
    cells.forEach((cell, index) => {
      const element = document.createElement(tag);
      const alignment = this.grid.alignments[index];
      if (alignment) element.className = `cm-align-${alignment}`;
      cellEnds.set(element, cell.to);
      // The pieces of one link go in one element, which the reading view's Tab reaches once.
      let link: HTMLElement | null = null;
      for (const piece of cell.pieces) {
        if (piece.link === undefined) link = null;
        else if (!link || linkStarts.get(link) !== piece.link) {
          link = this.link(piece.link, piece.address);
          element.append(link);
        }
        (link ?? element).append(this.draw(view, piece));
      }
      row.append(element);
    });
    return row;
  }

  /**
   * A focusable link of the reading view, as the lines draw it, starting at `start`, with the
   * address of a web link.
   */
  private link(start: number, address: string | undefined) {
    const link = document.createElement("span");
    link.setAttribute("tabindex", "0");
    link.setAttribute("role", "link");
    link.setAttribute("data-link", "");
    if (address !== undefined) link.setAttribute("data-address", address);
    linkStarts.set(link, start);
    return link;
  }

  private draw(view: EditorView, piece: Piece): Node {
    if ("widget" in piece) {
      return piece.widget.spec.widget?.toDOM(view) ?? document.createTextNode("");
    }
    const text = document.createTextNode(piece.text);
    textStarts.set(text, piece.at);
    if (piece.className === "") return text;
    const span = document.createElement("span");
    span.className = piece.className;
    if (piece.address !== undefined) span.setAttribute("data-address", piece.address);
    span.append(text);
    return span;
  }
}

/** Each column's alignment, from the colons of the delimiter row's cells. */
function alignments(delimiterRow: string): Alignment[] {
  return delimiterRow
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => {
      const text = cell.trim();
      const left = text.startsWith(":");
      const right = text.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      return left ? "left" : null;
    });
}

/**
 * A row's cells between its pipes, as GFM reads them: a leading or trailing pipe opens or closes
 * the row, and nothing between two pipes is an empty cell.
 */
function rowCells(row: SyntaxNode) {
  const cells: { from: number; to: number; node: SyntaxNode | null }[] = [];
  let from = row.from;
  let node: SyntaxNode | null = null;
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === "TableCell") node = child;
    if (child.name !== "TableDelimiter") continue;
    cells.push({ from, to: child.from, node });
    from = child.to;
    node = null;
  }
  cells.push({ from, to: row.to, node });
  const first = row.firstChild;
  const last = row.lastChild;
  if (first?.name === "TableDelimiter" && first.from === row.from) cells.shift();
  if (last?.name === "TableDelimiter" && last.to === row.to) cells.pop();
  return cells;
}

/**
 * The grid of a `Table` node whose first line starts at `start`, its cells decorated by `decorate`,
 * marked with the core's `links` and with `images` in place of their image embeds.
 */
function gridOf(
  state: EditorState,
  table: SyntaxNode,
  start: number,
  decorate: ReturnType<typeof inlineDecorator>,
  links: DecorationSet,
  images: DecorationSet,
): Grid {
  const cellOf = (cell: ReturnType<typeof rowCells>[number]): Cell => {
    if (!cell.node) {
      const at = Math.min(cell.from + 1, cell.to) - start;
      return { from: at, to: at, pieces: [] };
    }
    const { from, to } = cell.node;
    const pieces: Piece[] = [];
    /**
     * Where the focusable link that `active` marks starts, if it marks one, and the address of the
     * web link it marks, if any.
     */
    const linkOf = (active: readonly Decoration[]) => {
      const link = active.find((mark) => mark.spec.link !== undefined)?.spec.link;
      const address = active.find((mark) => mark.spec.attributes?.["data-address"] !== undefined)
        ?.spec.attributes["data-address"];
      return {
        ...(link === undefined ? {} : { link: link - start }),
        ...(address === undefined ? {} : { address }),
      };
    };
    RangeSet.spans([Decoration.set(decorate(cell.node), true), links, images], from, to, {
      span: (spanFrom, spanTo, active) => {
        if (spanFrom === spanTo) return;
        const className = active
          .flatMap((mark) => (mark.spec.class ? [mark.spec.class] : []))
          .join(" ");
        const text = state.sliceDoc(spanFrom, spanTo);
        pieces.push({ at: spanFrom - start, text, className, ...linkOf(active) });
      },
      point: (pointFrom, _pointTo, decoration, active) => {
        if (decoration.spec.widget) {
          pieces.push({ at: pointFrom - start, widget: decoration, ...linkOf(active) });
        }
      },
    });
    return { from: from - start, to: to - start, pieces };
  };
  const header = table.getChild("TableHeader");
  const columns = header ? rowCells(header).map(cellOf) : [];
  // A row shows as many cells as the header: missing ones are empty, extra ones are not shown.
  const fitted = (row: SyntaxNode) => {
    const cells = rowCells(row).slice(0, columns.length).map(cellOf);
    while (cells.length < columns.length)
      cells.push({ from: row.to - start, to: row.to - start, pieces: [] });
    return cells;
  };
  const delimiterRow = table.getChild("TableDelimiter");
  return {
    alignments: delimiterRow ? alignments(state.sliceDoc(delimiterRow.from, delimiterRow.to)) : [],
    header: columns,
    body: table.getChildren("TableRow").map(fitted),
  };
}

/** The blocks a table can sit in; the field looks for tables only in these. */
const containers = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

/** The tables after any leading frontmatter, with the numbers of their first and last lines. */
function tablesIn(state: EditorState) {
  const start = bodyStart(state);
  const tables: { node: SyntaxNode; first: number; last: number }[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.to <= start) return false;
      if (node.name !== "Table") return containers.has(node.name);
      if (node.from >= start) {
        const first = state.doc.lineAt(node.from).number;
        tables.push({ node: node.node, first, last: state.doc.lineAt(node.to).number });
      }
      return false;
    },
  });
  return tables;
}

type Lines = { first: number; last: number };

/** Which of `tables` hold part of the cursor or the selection, as one key. */
function revealedKey(state: EditorState, tables: Lines[]) {
  const revealed = revealedLines(state);
  return tables
    .map(({ first, last }) => {
      for (let number = first; number <= last; number++) if (revealed.has(number)) return "1";
      return "0";
    })
    .join("");
}

type Grids = { decorations: DecorationSet; tables: Lines[]; revealed: string };

/**
 * The grids of the tables none of whose lines is revealed. A grid in `kept`, the previous grids
 * moved to this text, stays when its table still spans the same lines and none of `changed`, the
 * edited ranges, touches them; the others are built again.
 */
function grids(
  state: EditorState,
  kept: DecorationSet = Decoration.none,
  changed: readonly [number, number][] = [],
): Grids {
  const tables = tablesIn(state);
  const revealed = revealedKey(state, tables);
  let decorate: ReturnType<typeof inlineDecorator> | null = null;
  const links = state.field(editorLinks, false)?.marks ?? Decoration.none;
  const images = imageCells(state);
  const ranges = tables.flatMap(({ node, first, last }, index) => {
    if (revealed[index] === "1") return [];
    const from = state.doc.line(first).from;
    const to = state.doc.line(last).to;
    let grid: Decoration | null = null;
    if (!changed.some(([changeFrom, changeTo]) => changeFrom <= to && changeTo >= from)) {
      kept.between(from, to, (keptFrom, keptTo, decoration) => {
        if (keptFrom !== from || keptTo !== to) return;
        grid = decoration;
        return false;
      });
    }
    if (!grid) {
      decorate ??= inlineDecorator(state);
      const widget = new GridWidget(gridOf(state, node, from, decorate, links, images));
      grid = Decoration.replace({ block: true, widget });
    }
    return [grid.range(from, to)];
  });
  return { decorations: Decoration.set(ranges), tables, revealed };
}

/**
 * Whether every grid may draw differently: the core reported new links or images, images or web
 * links were switched on, or the view changed. An edit's own moving of the links changes only the
 * grids of the tables it touches.
 */
function redrawsAll(transaction: Transaction) {
  const { startState, state } = transaction;
  const linksChanged = startState.field(editorLinks, false) !== state.field(editorLinks, false);
  return (
    (linksChanged && (!transaction.docChanged || transaction.effects.length > 0)) ||
    startState.facet(previewView) !== state.facet(previewView) ||
    startState.facet(webLinksShown) !== state.facet(webLinksShown) ||
    imagesRedraw(startState, state)
  );
}

const gridField = StateField.define<Grids>({
  create: (state) => grids(state),
  update: (value, transaction) => {
    const { startState, state, changes } = transaction;
    if (redrawsAll(transaction)) return grids(state);
    if (transaction.docChanged || syntaxTree(startState) !== syntaxTree(state)) {
      const changed: [number, number][] = [];
      changes.iterChangedRanges((_fromA, _toA, fromB, toB) => changed.push([fromB, toB]));
      return grids(state, value.decorations.map(changes), changed);
    }
    if (!transaction.selection) return value;
    const revealed = revealedKey(state, value.tables);
    return revealed === value.revealed ? value : grids(state, value.decorations);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * CodeMirror's Up and Down step over a block in place of lines. A key's move of the cursor from the
 * line just above a grid to the line just below it, or back, lands on the grid's nearest line
 * instead, at the same column where it can, which shows the table as Markdown.
 */
const intoGrids = EditorState.transactionFilter.of((transaction) => {
  const { startState, newSelection } = transaction;
  if (transaction.docChanged || !transaction.selection) return transaction;
  if (!transaction.isUserEvent("select") || transaction.isUserEvent("select.pointer")) {
    return transaction;
  }
  const before = startState.selection.main;
  const after = newSelection.main;
  if (newSelection.ranges.length > 1 || !before.empty || !after.empty) return transaction;
  const { doc } = startState;
  const from = doc.lineAt(before.head);
  const to = doc.lineAt(after.head);
  const down = to.number > from.number;
  let landing: number | null = null;
  startState.field(gridField).decorations.between(0, doc.length, (gridFrom, gridTo) => {
    const crossed = down
      ? gridFrom === from.to + 1 && gridTo + 1 === to.from
      : gridFrom === to.to + 1 && gridTo + 1 === from.from;
    if (!crossed) return;
    const line = doc.lineAt(down ? gridFrom : gridTo);
    landing = Math.min(line.from + before.head - from.from, line.to);
    return false;
  });
  return landing === null ? transaction : [transaction, { selection: { anchor: landing } }];
});

/**
 * GFM tables as grids, each in place of its lines while none of them holds part of the cursor or
 * the selection. The grids only draw: the text keeps every character.
 */
export const tableGrid = [gridField, intoGrids];
