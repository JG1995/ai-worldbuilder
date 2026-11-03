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

describe("an edit", () => {
  const twoTables = ["Above", ...stones, "", "Between", "", ...stones];

  /** The grid widgets the editor draws, in the order of their tables. */
  function gridWidgets(editor: EditorView) {
    const widgets: unknown[] = [];
    for (const source of editor.state.facet(EditorView.decorations)) {
      const set = typeof source === "function" ? source(editor) : source;
      set.between(0, editor.state.doc.length, (_from, _to, decoration) => {
        const { widget } = decoration.spec;
        if (decoration.spec.block && widget && "grid" in widget) widgets.push(widget);
      });
    }
    return widgets;
  }

  it("away from every table keeps each table's grid as it was built", () => {
    const editor = show(twoTables);
    const before = gridWidgets(editor);
    const between = editor.state.doc.toString().indexOf("Between");

    editor.dispatch({ changes: { from: between, insert: "Still " } });

    expect(before).toHaveLength(2);
    const after = gridWidgets(editor);
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it("that completes a table shows its grid, and one that breaks a table shows its lines", () => {
    const editor = show(["| Name | Place |", "", "Between", "", ...stones]);
    expect(cellTexts(editor)).toEqual([
      ["Stone", "Weight", "Found"],
      ["Granite", "9 kg", "quarry"],
      ["Slate", "4 kg", ""],
      ["Flint", "2 kg", "river"],
    ]);

    editor.dispatch({ changes: { from: "| Name | Place |".length, insert: "\n| - | - |" } });
    const grids = () => [...editor.contentDOM.querySelectorAll("table")];
    expect(grids()).toHaveLength(2);
    expect(grids()[0].textContent).toBe("NamePlace");

    // A fence opened above a table makes the rest of the page code, far from where it was typed.
    const between = editor.state.doc.toString().indexOf("Between");
    editor.dispatch({ changes: { from: between, insert: "```\n" } });
    expect(grids()).toHaveLength(1);
    expect(grids()[0].textContent).toBe("NamePlace");
    expect(drawnLines(editor).slice(-6, -1)).toEqual(stones);
  });
});
