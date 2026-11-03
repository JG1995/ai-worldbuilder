import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { EditorLink } from "@/types/api";
import { setLinks } from "./editor-links";
import { revealedLines } from "./live-preview";
import { createPageState } from "./MarkdownEditor";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

/**
 * An editor with the live preview showing `lines`, then an empty last line that holds the cursor
 * unless `cursor` puts it elsewhere, and with the core's `links`.
 */
function show(
  lines: string[],
  { cursor, links = [] }: { cursor?: number; links?: EditorLink[] } = {},
) {
  const text = `${lines.join("\n")}\n`;
  const state = createPageState(text, "Kesh Tor", cursor ?? text.length, { preview: true });
  view = new EditorView({
    state: state.update({ effects: setLinks(links) }).state,
    parent: document.body,
  });
  return view;
}

function drawnLines(editor: EditorView) {
  return [...editor.contentDOM.querySelectorAll(".cm-line")].map((line) => line.textContent);
}

/** The core's link for the first `[[` or `![[` in `text`, as `links_in` reports it. */
function linkIn(text: string, link: Partial<EditorLink>): EditorLink {
  const from = text.search(/!?\[\[/);
  return {
    from,
    to: text.indexOf("]]", from) + 2,
    state: "resolved",
    target: "",
    path: null,
    heading: null,
    block: null,
    ...link,
  };
}

describe("away from the cursor, the live preview", () => {
  it.each([
    ["# Kesh Tor", "Kesh Tor"],
    ["### Docks ###", "Docks"],
    ["*ash*, **bone**, ~~old~~ and ==new==", "ash, bone, old and new"],
    ["Roll `3d6` now", "Roll 3d6 now"],
    ["> The tide turns", "The tide turns"],
    ["- salt", "• salt"],
    ["1. first", "1. first"],
    [
      "[the docks](https://docks.example) and <https://tide.example>",
      "the docks and https://tide.example",
    ],
    ["[](https://docks.example)", "https://docks.example"],
    ["Ash %%secret%% fell", "Ash secret fell"],
    ["The bell tolls ^bell-1", "The bell tolls "],
    ["\\*not emphasis\\*", "*not emphasis*"],
    ["#lore and #ruins", "#lore and #ruins"],
    ["<b>raw</b>, $x^2$ and [^1]", "<b>raw</b>, $x^2$ and [^1]"],
    ["![map](map.png)", "![map](map.png)"],
  ])("shows %s as %s", (line, drawn) => {
    const editor = show([line]);

    expect(drawnLines(editor)[0]).toBe(drawn);
    expect(editor.state.doc.toString()).toBe(`${line}\n`);
  });

  it("gives headings their type roles, levels 4 to 6 the heading-4 role", () => {
    const editor = show([
      "# One",
      "## Two",
      "### Three",
      "#### Four",
      "###### Six",
      "Seven",
      "===",
    ]);
    const classes = [...editor.contentDOM.querySelectorAll(".cm-line")].map((line) =>
      [...line.classList].find((name) => name.startsWith("cm-heading-")),
    );

    expect(classes.slice(0, 7)).toEqual([
      "cm-heading-1",
      "cm-heading-2",
      "cm-heading-3",
      "cm-heading-4",
      "cm-heading-4",
      "cm-heading-1",
      undefined,
    ]);
    expect(drawnLines(editor).slice(5, 7)).toEqual(["Seven", ""]);
  });

  it("formats emphasis, code, highlights, comments and tags with their classes", () => {
    const editor = show(["*a* **b** ~~c~~ ==d== `e` %%f%% #g"]);
    const formatted = (name: string) => editor.contentDOM.querySelector(`.${name}`)?.textContent;

    expect(
      ["cm-em", "cm-strong", "cm-strike", "cm-highlight", "cm-code", "cm-comment", "cm-tag"].map(
        formatted,
      ),
    ).toEqual(["a", "b", "c", "d", "e", "f", "#g"]);
  });

  it("shows a code block on the code ground with its fence lines hidden", () => {
    const editor = show(["```js", "let tide = 1;", "```"]);
    const lines = [...editor.contentDOM.querySelectorAll(".cm-line")].slice(0, 3);

    expect(lines.map((line) => line.textContent)).toEqual(["", "let tide = 1;", ""]);
    for (const line of lines) expect(line).toHaveClass("cm-code-block");
  });

  it("shows a callout headed by its title, or by its type's name without one", () => {
    const titled = show(["> [!note]- The tide", "> Ebbs at dusk."]);
    expect(drawnLines(titled).slice(0, 2)).toEqual(["The tide", "Ebbs at dusk."]);
    expect(titled.contentDOM.querySelector(".cm-line")).toHaveClass("cm-callout-title");
    titled.destroy();

    const untitled = show(["> [!warning]", "> Ebbs at dusk."]);
    expect(drawnLines(untitled).slice(0, 2)).toEqual(["Warning", "Ebbs at dusk."]);
  });

  it("shows a task's brackets as a checkbox named by its text", () => {
    const editor = show(["- [x] Bar the gate", "- [ ] Ring the bell"]);
    const boxes = [...editor.contentDOM.querySelectorAll('[role="checkbox"]')];

    // The checkbox, which draws no text, between the spaces after the bullet and the brackets.
    expect(drawnLines(editor).slice(0, 2)).toEqual(["•  Bar the gate", "•  Ring the bell"]);
    expect(
      boxes.map((box) => [box.getAttribute("aria-label"), box.getAttribute("aria-checked")]),
    ).toEqual([
      ["Bar the gate", "true"],
      ["Ring the bell", "false"],
    ]);
  });

  it("shows a thematic break as a divider", () => {
    const editor = show(["Above", "", "---", "", "Below"]);

    expect(drawnLines(editor)[2]).toBe("");
    expect(
      editor.contentDOM.querySelectorAll(".cm-line")[2].querySelector(".cm-rule"),
    ).not.toBeNull();
  });

  it("formats nothing in the frontmatter", () => {
    const editor = show(["---", "title: *Kesh*", "---", "# Kesh"]);

    expect(drawnLines(editor).slice(0, 4)).toEqual(["---", "title: *Kesh*", "---", "Kesh"]);
  });

  it.each([
    ["[[Mirela]]", { target: "Mirela", path: "Mirela.md" }, "Mirela", "cm-link"],
    ["[[Mirela|the queen]]", { target: "Mirela", path: "Mirela.md" }, "the queen", "cm-link"],
    [
      "[[Kesh Tor#Shelter]]",
      { target: "Kesh Tor", heading: "Shelter" },
      "Kesh Tor > Shelter",
      "cm-link",
    ],
    ["[[#Docks]]", { heading: "Docks" }, "Docks", "cm-link"],
    ["[[Gone]]", { target: "Gone", state: "unresolved" as const }, "Gone", "cm-link-unresolved"],
    ["![[Saltmere]]", { target: "Saltmere", path: "Saltmere.md" }, "Saltmere", "cm-link"],
  ])("shows the core's link %s as %s", (text, link, drawn, style) => {
    const editor = show([text], { links: [linkIn(text, link)] });

    expect(drawnLines(editor)[0]).toBe(drawn);
    expect(editor.contentDOM.querySelector(`.${style}`)).not.toBeNull();
  });

  it("shows an audio link's display text unstyled, and an image embed as typed", () => {
    const audio = "[[Tide song.mp3]]";
    const image = "![[map.png]]";
    const editor = show([audio, image], {
      links: [
        linkIn(audio, { target: "Tide song.mp3", state: "attachment" }),
        {
          ...linkIn(image, { target: "map.png", state: "attachment" }),
          from: audio.length + 1,
          to: audio.length + 1 + image.length,
        },
      ],
    });

    expect(drawnLines(editor).slice(0, 2)).toEqual(["Tide song.mp3", image]);
    expect(editor.contentDOM.querySelector(".cm-link")).toBeNull();
  });

  it("shows wiki links as typed and unstyled while the core reports none", () => {
    const editor = show(["See [[Mirela|the queen]] and ![[Saltmere]]"]);

    expect(drawnLines(editor)[0]).toBe("See [[Mirela|the queen]] and ![[Saltmere]]");
    expect(editor.contentDOM.querySelector(".cm-link, .cm-link-unresolved")).toBeNull();
  });

  // A plugin may not hide a line break, and CodeMirror throws if one does.
  it.each([
    [
      ["[the docks](/docks", '"The docks")'],
      ["the docks", ""],
    ],
    [
      ["[](/docks", "'The docks')"],
      ["/docks", ""],
    ],
    [
      ["[](", "/docks)"],
      ["", "/docks"],
    ],
  ])("hides a link's syntax line by line when it spans lines: %j", (lines, drawn) => {
    const editor = show(lines);

    expect(drawnLines(editor).slice(0, 2)).toEqual(drawn);
    expect(editor.state.doc.toString()).toBe(`${lines.join("\n")}\n`);
  });

  it("shows HTML comments as typed and unstyled, unlike %% comments", () => {
    const editor = show(["a <!-- note --> b", "", "<!-- block -->"]);

    expect(drawnLines(editor).slice(0, 3)).toEqual(["a <!-- note --> b", "", "<!-- block -->"]);
    expect(editor.contentDOM.querySelector(".cm-comment")).toBeNull();
  });
});

describe("on the lines with the cursor or the selection, the live preview", () => {
  it("shows the Markdown as typed and keeps the formatting", () => {
    const editor = show(["# Kesh Tor", "**bone**"], { cursor: 2 });

    expect(drawnLines(editor).slice(0, 2)).toEqual(["# Kesh Tor", "bone"]);
    expect(editor.contentDOM.querySelector(".cm-line")).toHaveClass("cm-heading-1");
  });

  it("reveals every line a selection touches, and hides them again when it leaves", () => {
    const lines = ["# One", "**two**", "> three", "- four"];
    const editor = show(lines);
    const second = editor.state.doc.line(2);

    editor.dispatch({
      selection: EditorSelection.single(second.from + 3, editor.state.doc.line(4).from + 1),
    });
    expect(revealedLines(editor.state)).toEqual(new Set([2, 3, 4]));
    expect(drawnLines(editor).slice(0, 4)).toEqual(["One", "**two**", "> three", "- four"]);

    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    expect(drawnLines(editor).slice(0, 4)).toEqual(["One", "two", "three", "• four"]);
    expect(editor.state.doc.toString()).toBe(`${lines.join("\n")}\n`);
  });

  it("keeps taking edits after the cursor leaves a link that spans lines", () => {
    const editor = show(["[the docks](/docks", '"The docks")'], { cursor: 1 });

    editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    editor.dispatch(editor.state.replaceSelection("Ash"));

    expect(editor.state.doc.toString()).toBe('[the docks](/docks\n"The docks")\nAsh');
    expect(drawnLines(editor)).toEqual(["the docks", "", "Ash"]);
  });
});
