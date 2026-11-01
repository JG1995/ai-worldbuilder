import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { EditorLink } from "@/types/api";
import { editorLinks, findAnchor, linkAt, setLinks } from "./editor-links";
import { createPageState } from "./MarkdownEditor";

function link(text: string, written: string, fields: Partial<EditorLink> = {}): EditorLink {
  const from = text.indexOf(written);
  return {
    from,
    to: from + written.length,
    state: "resolved",
    target: "",
    path: null,
    heading: null,
    block: null,
    ...fields,
  };
}

/** Each marked range of `state`'s text, with its class. */
function marks(state: EditorState) {
  const found: [string, string][] = [];
  state.field(editorLinks).marks.between(0, state.doc.length, (from, to, mark) => {
    found.push([state.sliceDoc(from, to), mark.spec.class]);
  });
  return found;
}

const text = "See [[Mirela]], [[Harbour|the docks]] and ![[map.png]].";
const linked = createPageState(text, "Kesh").update({
  effects: setLinks([
    link(text, "[[Mirela]]"),
    link(text, "[[Harbour|the docks]]", { state: "unresolved" }),
    link(text, "![[map.png]]", { state: "attachment" }),
  ]),
}).state;

describe("the editor's links", () => {
  it("mark resolved and unresolved links over the whole link, and attachments not at all", () => {
    expect(marks(linked)).toEqual([
      ["[[Mirela]]", "cm-link"],
      ["[[Harbour|the docks]]", "cm-link-unresolved"],
    ]);
  });

  it("move with edits elsewhere, and a link an edit touches loses its mark until the next answer", () => {
    const edited = linked.update({
      changes: [
        { from: 0, insert: "> " },
        { from: text.indexOf("Harbour"), insert: "Old " },
        { from: text.length, insert: " Done." },
      ],
    }).state;

    expect(marks(edited)).toEqual([["[[Mirela]]", "cm-link"]]);
    expect(linkAt(edited, edited.doc.toString().indexOf("Mirela"))?.from).toBe(
      text.indexOf("[[Mirela]]") + 2,
    );
    expect(linkAt(edited, edited.doc.toString().indexOf("Old"))).toBeNull();
  });

  it("keep their marks when text is typed right before or after a link", () => {
    const at = text.indexOf("[[Mirela]]");
    const edited = linked.update({
      changes: [
        { from: at, insert: "x" },
        { from: at + "[[Mirela]]".length, insert: "y" },
      ],
    }).state;

    expect(marks(edited)[0]).toEqual(["[[Mirela]]", "cm-link"]);
  });

  it("are found at a position inside a link or at either end, attachments included", () => {
    const mirela = text.indexOf("[[Mirela]]");

    expect(linkAt(linked, mirela)?.from).toBe(mirela);
    expect(linkAt(linked, mirela + "[[Mirela]]".length)?.from).toBe(mirela);
    expect(linkAt(linked, text.indexOf("map.png"))?.state).toBe("attachment");
    expect(linkAt(linked, text.indexOf(" and ") + 2)).toBeNull();
    expect(linkAt(EditorState.create({ doc: text }), mirela)).toBeNull();
  });
});

describe("finding a link's heading or block", () => {
  const page = [
    "---",
    "title: Docks",
    "---",
    "Intro with a #tag.",
    "",
    "```",
    "# Docks",
    "```",
    "",
    "##   The DOCKS ##",
    "",
    "Harbour wall",
    "============",
    "",
    "A quay where boats moor. ^quay-1",
    "",
    "Not a block^quay-1",
    "",
    "# Docks",
  ].join("\n");
  const state = createPageState(page, "Saltmere");
  const anchor = (heading: string | null, block: string | null) =>
    findAnchor(state, { heading, block });

  it("finds the first ATX or Setext heading by its text in any letter case, outside code and frontmatter", () => {
    expect(anchor("the docks", null)).toBe(page.indexOf("##   The DOCKS"));
    expect(anchor("HARBOUR WALL", null)).toBe(page.indexOf("Harbour wall"));
    expect(anchor("docks", null)).toBe(page.lastIndexOf("# Docks"));
  });

  it("finds the first line that ends in whitespace and the block's id", () => {
    expect(anchor(null, "quay-1")).toBe(page.indexOf("A quay"));
  });

  it("finds nothing for a heading or block the page does not have, or a link that names neither", () => {
    expect(anchor("Harbour", null)).toBeNull();
    expect(anchor("title: Docks", null)).toBeNull();
    expect(anchor(null, "quay")).toBeNull();
    expect(anchor(null, null)).toBeNull();
  });
});
