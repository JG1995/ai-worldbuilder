import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorLink } from "@/types/api";
import { setLinks } from "./editor-links";
import { linkPreviews, type PreviewSource } from "./link-previews";
import { createPageState } from "./MarkdownEditor";
import { webLinks } from "./web-links";

const text = [
  "See [[Saltmere#Harbour]], [[Ghost]], ![[map.png]] and [docks](https://docks.example).",
  "",
  "| Who |",
  "| --- |",
  "| [[Saltmere]] |",
  "",
  "End.",
].join("\n");

const saltmere = [
  "# Saltmere",
  "",
  "A salt town.",
  "",
  "Its walls are white.",
  "",
  "## Harbour",
  "",
  "Boats come at dusk.",
].join("\n");

function linkTo(written: string, from: number, fields: Partial<EditorLink> = {}): EditorLink {
  return {
    from,
    to: from + written.length,
    state: "resolved",
    target: "Saltmere",
    path: "Places/Saltmere.md",
    heading: null,
    block: null,
    ...fields,
  };
}

const harbour = linkTo("[[Saltmere#Harbour]]", text.indexOf("[[Saltmere#"), { heading: "Harbour" });
const links = [
  harbour,
  linkTo("[[Ghost]]", text.indexOf("[[Ghost"), {
    state: "unresolved",
    target: "Ghost",
    path: null,
  }),
  linkTo("![[map.png]]", text.indexOf("![["), {
    state: "attachment",
    target: "map.png",
    path: null,
  }),
  linkTo("[[Saltmere]]", text.indexOf("| [[") + 2),
];

/** The preview's source, reading `page` after `delay` ms or failing, and recording follows. */
function sourceOf({ page = saltmere as string | Error, delay = 0 } = {}) {
  const answer = () => (page instanceof Error ? Promise.reject(page) : Promise.resolve(page));
  const read = vi.fn((_path: string) =>
    delay === 0
      ? answer()
      : new Promise<string>((resolve) => setTimeout(resolve, delay)).then(answer),
  );
  const pageState = (shown: string, title: string) =>
    createPageState(shown, title, 0, { preview: true });
  const source = { read, page: pageState, follow: vi.fn() } satisfies PreviewSource;
  return source;
}

/** An editor of `text` with its links, web links and previews from `source`, cursor at its end. */
function renderEditor(source: PreviewSource) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = createPageState(text, "Kesh Tor", text.length, { preview: true }).update({
    effects: [setLinks(links), StateEffect.appendConfig.of([webLinks, linkPreviews(source)])],
  }).state;
  return new EditorView({ state, parent });
}

const preview = () => document.querySelector<HTMLElement>(".cm-link-preview");
/** The editor that shows the previewed page. */
const previewPage = () => {
  const dom = preview()?.querySelector<HTMLElement>(".cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
};

/** Rests the pointer on `element` for the preview delay, and lets a read finish. */
async function rest(element: Element) {
  fireEvent.mouseOver(element);
  await vi.advanceTimersByTimeAsync(500);
}

function linkElement(view: EditorView, selector: string, written: string) {
  const found = [...view.contentDOM.querySelectorAll(selector)].find(
    (element) => element.textContent === written,
  );
  if (!found) throw new Error(`No ${selector} "${written}"`);
  return found;
}

let view: EditorView | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("link previews", () => {
  it("open for a resolved link, in a line or a grid, and not for other links", async () => {
    const source = sourceOf();
    view = renderEditor(source);

    await rest(linkElement(view, ".cm-link-unresolved", "Ghost"));
    await rest(linkElement(view, ".cm-web-link", "docks"));
    const embed = [...view.contentDOM.querySelectorAll(".cm-line")].find((line) =>
      line.textContent?.includes("![[map.png]]"),
    );
    await rest(embed as Element);
    expect(preview()).toBeNull();
    expect(source.read).not.toHaveBeenCalled();

    await rest(linkElement(view, ".cm-table .cm-link", "Saltmere"));
    expect(source.read).toHaveBeenCalledWith("Places/Saltmere.md");
    expect(preview()?.querySelector(".cm-link-preview-title")).toHaveTextContent(/^Saltmere$/);
    expect(previewPage()?.state.doc.toString()).toBe(saltmere);
  });

  it("starts the page at the linked heading", async () => {
    view = renderEditor(sourceOf());

    await rest(linkElement(view, ".cm-link", "Saltmere > Harbour"));
    await vi.advanceTimersByTimeAsync(50);

    const page = previewPage();
    if (!page) throw new Error("No preview");
    const heading = page.lineBlockAt(saltmere.indexOf("## Harbour")).top;
    expect(heading).toBeGreaterThan(0);
    expect(page.scrollDOM.scrollTop).toBe(heading);
  });

  it("says it is loading only while a read takes longer than 300 ms", async () => {
    view = renderEditor(sourceOf({ delay: 200 }));
    const link = linkElement(view, ".cm-link", "Saltmere > Harbour");
    await rest(link);
    await vi.advanceTimersByTimeAsync(200);
    expect(preview()).not.toHaveTextContent("Loading…");
    expect(previewPage()).not.toBeNull();
    view.destroy();

    view = renderEditor(sourceOf({ delay: 1000 }));
    await rest(linkElement(view, ".cm-link", "Saltmere > Harbour"));
    await vi.advanceTimersByTimeAsync(299);
    expect(preview()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(preview()).toHaveTextContent(/^SaltmereLoading…$/);
    await vi.advanceTimersByTimeAsync(700);
    expect(preview()).not.toHaveTextContent("Loading…");
    expect(previewPage()?.state.doc.toString()).toBe(saltmere);
  });

  it.each([
    [new Error("not UTF-8"), "This page cannot be previewed."],
    [" \n\t\n", "This page has no text yet."],
  ])("says so for a page that reads as %j", async (page, line) => {
    view = renderEditor(sourceOf({ page }));

    await rest(linkElement(view, ".cm-link", "Saltmere > Harbour"));

    expect(preview()).toHaveTextContent(new RegExp(`^Saltmere${line.replace(".", "\\.")}$`));
    expect(previewPage()).toBeNull();
  });

  it("closes on Escape, on a change to the text and when the editor goes, with its page", async () => {
    view = renderEditor(sourceOf());
    const editor = view;
    const link = () => linkElement(editor, ".cm-link", "Saltmere > Harbour");
    const openPage = async () => {
      fireEvent.mouseOut(link());
      await rest(link());
      const page = previewPage();
      if (!page) throw new Error("No preview");
      return vi.spyOn(page, "destroy");
    };

    const escaped = await openPage();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(preview()).toBeNull();
    expect(escaped).toHaveBeenCalled();

    const changed = await openPage();
    editor.dispatch({ changes: { from: text.length, insert: "!" } });
    expect(preview()).toBeNull();
    expect(changed).toHaveBeenCalled();

    const unmounted = await openPage();
    editor.destroy();
    expect(preview()).toBeNull();
    expect(unmounted).toHaveBeenCalled();
  });

  it("follows the link on a click on it, which neither focuses nor selects", async () => {
    const source = sourceOf();
    view = renderEditor(source);
    await rest(linkElement(view, ".cm-link", "Saltmere > Harbour"));
    const shown = preview();
    if (!shown) throw new Error("No preview");

    const pressed = fireEvent.mouseDown(shown, { button: 0 });
    fireEvent.click(shown, { button: 0 });

    expect(pressed).toBe(false);
    expect(source.follow).toHaveBeenCalledWith(harbour);
  });

  it("leaves a press and a click on its page's scrollbar to the scrollbar, and follows from its text", async () => {
    const source = sourceOf();
    view = renderEditor(source);
    await rest(linkElement(view, ".cm-link", "Saltmere > Harbour"));
    const scroller = preview()?.querySelector(".cm-scroller");
    if (!scroller) throw new Error("No page in the preview");

    // WebKit targets the scrolling element itself for a press on its scrollbar.
    const pressed = fireEvent.mouseDown(scroller, { button: 0 });
    fireEvent.click(scroller, { button: 0 });

    expect(pressed).toBe(true);
    expect(source.follow).not.toHaveBeenCalled();

    const line = scroller.querySelector(".cm-line");
    if (!line) throw new Error("No line in the preview's page");
    expect(fireEvent.mouseDown(line, { button: 0 })).toBe(false);
    fireEvent.click(line, { button: 0 });
    expect(source.follow).toHaveBeenCalledWith(harbour);
  });
});
