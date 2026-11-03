import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorLink } from "@/types/api";
import { setLinks } from "./editor-links";
import { createPageState } from "./MarkdownEditor";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/**
 * An editor with the live preview showing `lines`, then an empty last line that holds the cursor,
 * and with the core's `links`.
 */
function show(lines: string[], links: EditorLink[] = []) {
  const text = `${lines.join("\n")}\n`;
  const state = createPageState(text, "Kesh Tor", text.length, { preview: true });
  view = new EditorView({
    state: state.update({ effects: setLinks(links) }).state,
    parent: document.body,
  });
  return view;
}

const grid = (editor: EditorView) => editor.contentDOM.querySelector("table");

function cellTexts(editor: EditorView) {
  return [...(grid(editor)?.querySelectorAll("tr") ?? [])].map((row) =>
    [...row.children].map((cell) => cell.textContent),
  );
}

function drawnLines(editor: EditorView) {
  return [...editor.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent);
}

const stones = [
  "| Stone | Weight | Found |",
  "| :--- | :---: | ---: |",
  "| Granite | 9 kg | quarry |",
  "| Slate | 4 kg |",
  "| Flint | 2 kg | river | extra |",
];

describe("away from the cursor, a table", () => {
  it("shows as a grid of header and body cells, aligned by its delimiter row, as GFM fits rows", () => {
    const editor = show(stones);

    expect(cellTexts(editor)).toEqual([
      ["Stone", "Weight", "Found"],
      ["Granite", "9 kg", "quarry"],
      ["Slate", "4 kg", ""],
      ["Flint", "2 kg", "river"],
    ]);
    const header = [...(grid(editor)?.querySelectorAll("thead th") ?? [])];
    expect(header.map((cell) => cell.className)).toEqual([
      "cm-align-left",
      "cm-align-center",
      "cm-align-right",
    ]);
    expect(grid(editor)?.querySelectorAll("tbody td")).toHaveLength(9);
    expect(drawnLines(editor)).toEqual([""]);
    expect(editor.state.doc.toString()).toBe(`${stones.join("\n")}\n`);
  });

  it("formats its cells' text as elsewhere, with the core's links", () => {
    const lines = ["| Kind | Note | Who |", "| - | - | - |", "| **bold** | `3d6` | [[Mirela]] |"];
    const from = `${lines[0]}\n${lines[1]}\n`.length + lines[2].indexOf("[[");
    const editor = show(lines, [
      {
        from,
        to: from + "[[Mirela]]".length,
        state: "resolved",
        target: "Mirela",
        path: "Mirela.md",
        heading: null,
        block: null,
      },
    ]);
    const formatted = (name: string) => grid(editor)?.querySelector(`.${name}`)?.textContent;

    expect(cellTexts(editor)[1]).toEqual(["bold", "3d6", "Mirela"]);
    expect(["cm-strong", "cm-code", "cm-link"].map(formatted)).toEqual(["bold", "3d6", "Mirela"]);
  });

  it("shows as Markdown while the cursor is in any of its lines, and as a grid again after", () => {
    const editor = show(["Above", ...stones]);
    const text = editor.state.doc.toString();

    for (const number of [2, 4, 6]) {
      editor.dispatch({ selection: { anchor: editor.state.doc.line(number).from + 1 } });
      expect(grid(editor)).toBeNull();
      expect(drawnLines(editor).slice(1, 6)).toEqual(stones);

      editor.dispatch({ selection: { anchor: 0 } });
      expect(cellTexts(editor)[0]).toEqual(["Stone", "Weight", "Found"]);
    }
    expect(editor.state.doc.toString()).toBe(text);
  });

  it("puts the cursor in a pressed cell's text, which shows the table as Markdown", () => {
    const editor = show(stones);
    const slate = grid(editor)?.querySelectorAll("tbody tr")[1].children[1];

    slate?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
    );

    // jsdom cannot find the pressed character, so the cursor goes to the end of the cell's text.
    const line = editor.state.doc.line(4);
    expect(editor.state.selection.main.head).toBe(line.from + line.text.indexOf("4 kg") + 4);
    expect(grid(editor)).toBeNull();
    expect(editor.state.doc.toString()).toBe(`${stones.join("\n")}\n`);
  });
});
