import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { ImageEmbed } from "@/types/api";
import { imageEmbeds, imageRequests, setImages } from "./image-embeds";
import { createPageState } from "./MarkdownEditor";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

const url = (path: string, stamp: string) => `test-image://${path}?v=${stamp}`;

/**
 * An editor with images showing `lines`, then an empty last line that holds the cursor unless
 * `cursor` puts it elsewhere, with each embed resolved as `resolve` says: found at its target by
 * default.
 */
function show(
  lines: string[],
  {
    cursor,
    resolve = (target) => ({ state: "found", path: target, stamp: "1" }),
  }: { cursor?: number; resolve?: (target: string) => ImageEmbed } = {},
) {
  const text = `${lines.join("\n")}\n`;
  let state = createPageState(text, "Kesh Tor", cursor ?? text.length, { preview: true });
  state = state.update({ effects: StateEffect.appendConfig.of(imageEmbeds(url)) }).state;
  const requests = imageRequests(state);
  const answers = requests.map(({ target }) => resolve(target));
  view = new EditorView({
    state: state.update({ effects: setImages(requests, answers) }).state,
    parent: document.body,
  });
  return { view, text };
}

/** The images drawn; CodeMirror draws its own `img` elements beside widgets. */
const images = (editor: EditorView) => [...editor.contentDOM.querySelectorAll(".cm-image img")];
const placeholders = (editor: EditorView) =>
  [...editor.contentDOM.querySelectorAll(".cm-image-placeholder")].map(
    (placeholder) => placeholder.textContent,
  );

describe("an image embed", () => {
  it.each([
    ["![[name.png]]", { target: "name.png", form: "wiki" }, "name", null, null],
    ["![[Folder/name.png]]", { target: "Folder/name.png", form: "wiki" }, "name", null, null],
    ["![[./name.png]]", { target: "./name.png", form: "wiki" }, "name", null, null],
    ["![[name.png|300]]", { target: "name.png", form: "wiki" }, "name", "300", null],
    ["![[name.png|300x200]]", { target: "name.png", form: "wiki" }, "name", "300", "200"],
    ["![[name.png|caption]]", { target: "name.png", form: "wiki" }, "caption", null, null],
    ["![alt](name.png)", { target: "name.png", form: "markdown" }, "alt", null, null],
    [
      "![alt](../images/a%20b.png)",
      { target: "../images/a%20b.png", form: "markdown" },
      "alt",
      null,
      null,
    ],
    [
      "![alt](<images/a b.png>)",
      { target: "<images/a b.png>", form: "markdown" },
      "alt",
      null,
      null,
    ],
    ["![alt|300](name.png)", { target: "name.png", form: "markdown" }, "alt", "300", null],
  ])(
    "%s asks for its target and shows with its text alternative and size",
    (embed, request, alt, width, height) => {
      const { view, text } = show([embed]);

      expect(imageRequests(view.state)).toEqual([request]);
      const [image] = images(view);
      expect(image).toHaveAttribute("src", url(request.target, "1"));
      expect(image).toHaveAttribute("alt", alt);
      expect(image.getAttribute("width")).toBe(width);
      expect(image.getAttribute("height")).toBe(height);
      expect(image.hasAttribute("style")).toBe(false);
      expect(view.state.doc.toString()).toBe(text);
    },
  );

  it("is not one when it names a page or other file, or sits in code", () => {
    const { view } = show(["![[Saltmere]] ![[notes.pdf]] ![x](a.txt) `![[map.png]]`"]);

    expect(imageRequests(view.state)).toEqual([]);
    expect(images(view)).toEqual([]);
  });

  it("shows in place of its text off the cursor's line, and below its text on that line", () => {
    const { view } = show(["Before ![[map.png]] after", "", "![[map.png|40]]"], { cursor: 0 });

    const [revealed, , away] = view.contentDOM.querySelectorAll(".cm-line");
    expect(revealed.textContent).toBe("Before ![[map.png]] after");
    expect(revealed.querySelector("img")).toBeNull();
    expect(revealed.nextElementSibling?.matches("div.cm-image")).toBe(true);
    expect(away.textContent).toBe("");
    expect(away.querySelector(".cm-image img")).toHaveAttribute("width", "40");

    // Each target is asked for once.
    expect(imageRequests(view.state)).toEqual([{ target: "map.png", form: "wiki" }]);
  });

  it("shows a placeholder for an image that is missing, outside the world or on the web", () => {
    const states: Record<string, ImageEmbed> = {
      "gone.png": { state: "missing" },
      "../../far.png": { state: "outside" },
      "https://example.com/a.png": { state: "web" },
      "data:image/png;base64,AAAA": { state: "web" },
    };
    const { view, text } = show(
      [
        "![[gone.png]]",
        "![Old map](../../far.png)",
        "![](https://example.com/a.png)",
        "![](data:image/png;base64,AAAA)",
      ],
      { resolve: (target) => states[target] },
    );

    expect(images(view)).toEqual([]);
    expect(placeholders(view)).toEqual([
      expect.stringContaining("gone.png was not found."),
      expect.stringContaining("Old map is not in this world."),
      expect.stringContaining("Web images are not loaded: https://example.com/a.png"),
      expect.stringContaining("Web images are not loaded: data:image/png;base64,AAAA"),
    ]);
    expect(view.state.doc.toString()).toBe(text);
  });

  it("puts its name in a placeholder as text, never as markup", () => {
    const { view } = show(["![<b>bold</b>](gone.png)"], {
      resolve: () => ({ state: "missing" }),
    });

    expect(placeholders(view)).toEqual([expect.stringContaining("<b>bold</b> was not found.")]);
    expect(view.contentDOM.querySelector("b")).toBeNull();
  });

  it("turns into the cannot-be-shown placeholder when its image fails to load", () => {
    const { view } = show(["![[torn.png]]"]);

    images(view)[0].dispatchEvent(new Event("error"));

    expect(images(view)).toEqual([]);
    expect(placeholders(view)).toEqual([expect.stringContaining("torn.png cannot be shown.")]);
  });

  it("shows inside a table's grid cell", () => {
    const { view } = show(["| Map | Size |", "| --- | --- |", "| ![Old map](map.png) | big |"]);

    const cell = view.contentDOM.querySelector("td");
    expect(cell?.querySelector(".cm-image img")).toHaveAttribute("alt", "Old map");
  });
});
