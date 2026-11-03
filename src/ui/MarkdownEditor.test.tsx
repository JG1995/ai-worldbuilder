import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorLink } from "@/types/api";
import { setLinks } from "./editor-links";
import { createPageState, MarkdownEditor, reloadedState, replaceState } from "./MarkdownEditor";

const page = [
  "---",
  "title: Kesh Tor",
  "---",
  "# Kesh Tor",
  "",
  "Roll `3d6` at dusk.",
  "",
  "```",
  "glass storm",
  "```",
].join("\n");

function lineWith(text: string) {
  const line = [...document.querySelectorAll(".cm-line")].find(
    (element) => element.textContent === text,
  );
  if (!line) throw new Error(`No editor line "${text}"`);
  return line;
}

it("is read-only when asked, and editable when not", () => {
  const state = createPageState(page, "Kesh Tor");
  const { rerender } = render(<MarkdownEditor state={state} readOnly />);

  expect(screen.getByRole("textbox", { name: "Kesh Tor" })).toHaveAttribute(
    "aria-readonly",
    "true",
  );

  rerender(<MarkdownEditor state={state} readOnly={false} />);
  expect(screen.getByRole("textbox", { name: "Kesh Tor" })).not.toHaveAttribute("aria-readonly");
});

it("gives code and the leading frontmatter block the mono class, and nothing else", () => {
  render(<MarkdownEditor state={createPageState(page, "Kesh Tor")} readOnly />);

  for (const text of ["---", "title: Kesh Tor"]) {
    expect(lineWith(text)).toHaveClass("cm-mono");
  }
  expect(lineWith("# Kesh Tor")).not.toHaveClass("cm-mono");

  const mono = [...document.querySelectorAll(".cm-line:not(.cm-mono) .cm-mono")].map(
    (element) => element.textContent,
  );
  expect(mono).toEqual(["3d6", "glass storm"]);
});

it("treats a leading --- without a closing line as text, not frontmatter", () => {
  render(<MarkdownEditor state={createPageState("---\ntitle: open", "Draft")} readOnly />);

  expect(lineWith("title: open")).not.toHaveClass("cm-mono");
});

it("passes the nonce of the style element in the document head to CodeMirror", () => {
  // As Tauri serves index.html: its empty style element carries the per-load style nonce.
  const style = document.createElement("style");
  style.setAttribute("nonce", "per-load-nonce");
  document.head.append(style);
  try {
    render(<MarkdownEditor state={createPageState(page, "Kesh Tor")} readOnly />);

    const editor = document.querySelector<HTMLElement>(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    expect(view?.state.facet(EditorView.cspNonce)).toBe("per-load-nonce");
  } finally {
    style.remove();
  }
});

it("reports each change to its text, and nothing for other updates", () => {
  const changes: string[] = [];
  render(
    <MarkdownEditor
      state={createPageState("# Kesh", "Kesh Tor")}
      readOnly={false}
      onChange={(state) => changes.push(state.doc.toString())}
    />,
  );
  const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Kesh Tor" }));
  if (!view) throw new Error("No editor");

  view.dispatch({ selection: { anchor: 2 } });
  view.dispatch({ changes: { from: 6, insert: " Tor" }, userEvent: "input.type" });

  expect(changes).toEqual(["# Kesh Tor"]);
});

it("reports its last state when it unmounts", () => {
  const state = createPageState(page, "Kesh Tor");
  let last: unknown;
  const { unmount } = render(
    <MarkdownEditor state={state} readOnly onUnmount={(editor) => (last = editor)} />,
  );

  unmount();

  expect(last).toMatchObject({ doc: state.doc });
});

it("keeps asking its suggest function for a link typed after replaceState", async () => {
  const suggest = vi.fn(async () => ({ indexing: false, items: [] }));
  render(
    <MarkdownEditor state={createPageState("", "Kesh Tor")} readOnly={false} suggest={suggest} />,
  );
  const view = EditorView.findFromDOM(screen.getByRole("textbox", { name: "Kesh Tor" }));
  if (!view) throw new Error("No editor");

  replaceState(view, createPageState("See ", "Kesh Tor", 4));
  view.dispatch({
    changes: { from: 4, insert: "[[Mi" },
    selection: { anchor: 8 },
    userEvent: "input.type",
  });

  await waitFor(() => expect(suggest).toHaveBeenCalledWith("Mi"));
});

describe("following a link", () => {
  const text = "Ruled by [[Mirela]] since spring.";
  const link: EditorLink = {
    from: text.indexOf("[["),
    to: text.indexOf("]]") + 2,
    state: "resolved",
    target: "Mirela",
    path: "Mirela.md",
    heading: null,
    block: null,
  };

  /** An editor showing `text` with its one link, the cursor at `cursor`, reporting follows. */
  function renderLinked(cursor: number) {
    const onFollow = vi.fn();
    const state = createPageState(text, "Kesh Tor", cursor);
    render(
      <MarkdownEditor
        state={state.update({ effects: setLinks([link]) }).state}
        readOnly={false}
        onFollow={onFollow}
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "Kesh Tor" });
    const view = EditorView.findFromDOM(textbox);
    if (!view) throw new Error("No editor");
    return { onFollow, textbox, view };
  }

  /** jsdom lays out no text, so the editor's position under the pointer is given. */
  function pointAt(position: number) {
    vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(position);
  }

  it("follows on Ctrl+click and Cmd+click over a link, and the click does nothing else", () => {
    const { onFollow, textbox, view } = renderLinked(0);
    pointAt(link.from + 3);

    const ctrl = fireEvent.mouseDown(textbox, { button: 0, ctrlKey: true });
    const cmd = fireEvent.mouseDown(textbox, { button: 0, metaKey: true });

    expect(onFollow.mock.calls).toEqual([[link], [link]]);
    expect([ctrl, cmd]).toEqual([false, false]);
    expect(view.state.selection.main.head).toBe(0);
  });

  it("leaves a plain click, a click with other keys and a Ctrl+click beside a link alone", () => {
    const { onFollow, textbox } = renderLinked(0);
    // CodeMirror measures the selection it draws for a click; jsdom lays out nothing.
    const range = Range.prototype as Partial<Range>;
    range.getClientRects = () => [] as unknown as DOMRectList;
    range.getBoundingClientRect = () => new DOMRect();
    pointAt(link.from + 3);

    fireEvent.mouseDown(textbox, { button: 0 });
    fireEvent.mouseDown(textbox, { button: 0, ctrlKey: true, shiftKey: true });
    pointAt(text.indexOf("since"));
    fireEvent.mouseDown(textbox, { button: 0, ctrlKey: true });

    expect(onFollow).not.toHaveBeenCalled();
    delete range.getClientRects;
    delete range.getBoundingClientRect;
  });

  it("follows on Alt+Enter with the cursor in a link, and leaves Alt+Enter elsewhere alone", () => {
    const inside = renderLinked(link.to);
    const followed = fireEvent.keyDown(inside.textbox, { key: "Enter", altKey: true });
    cleanup();
    const outside = renderLinked(text.length);
    const ignored = fireEvent.keyDown(outside.textbox, { key: "Enter", altKey: true });

    expect(inside.onFollow).toHaveBeenCalledWith(link);
    expect(followed).toBe(false);
    expect(outside.onFollow).not.toHaveBeenCalled();
    expect(ignored).toBe(true);
  });
});

describe("the live preview", () => {
  const tasks = "Before the tide:\n\n- [ ] Bar the gate\n- [x] Ring the bell\n";

  /** An editor showing `text`, with the cursor on its first line, reporting each change. */
  function renderPreview(text: string, { readOnly = false, preview = true } = {}) {
    const changes: string[] = [];
    render(
      <MarkdownEditor
        state={createPageState(text, "Kesh Tor", 0, { preview })}
        readOnly={readOnly}
        onChange={(state) => changes.push(state.doc.toString())}
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "Kesh Tor" });
    const view = EditorView.findFromDOM(textbox);
    if (!view) throw new Error("No editor");
    return { changes, textbox, view };
  }

  it("toggles a task as one change that Ctrl+Z undoes alone", () => {
    const { changes, textbox, view } = renderPreview(tasks);
    view.dispatch({ changes: { from: 6, insert: "x" }, userEvent: "input.type" });
    const typed = view.state.doc.toString();
    const cursor = view.state.selection.main.head;

    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Bar the gate" }), { button: 0 });
    expect(view.state.doc.toString()).toBe(typed.replace("- [ ] Bar", "- [x] Bar"));
    expect(changes).toEqual([typed, view.state.doc.toString()]);
    expect(view.state.selection.main.head).toBe(cursor);

    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Ring the bell" }), { button: 0 });
    expect(view.state.doc.toString()).toContain("- [ ] Ring");

    fireEvent.keyDown(textbox, { key: "z", ctrlKey: true });
    fireEvent.keyDown(textbox, { key: "z", ctrlKey: true });
    expect(view.state.doc.toString()).toBe(typed);
  });

  it("changes nothing when a task is pressed while the editor is read-only", () => {
    const { changes, view } = renderPreview(tasks, { readOnly: true });

    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Bar the gate" }), { button: 0 });

    expect(view.state.doc.toString()).toBe(tasks);
    expect(changes).toEqual([]);
  });

  it("shows the syntax as typed in a state created without it", () => {
    renderPreview("Intro\n\n**bone** and [[Mirela]]", { preview: false });

    expect(lineWith("**bone** and [[Mirela]]")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps showing through replaceState a state that reloadedState built from it", () => {
    const { view } = renderPreview(tasks);

    replaceState(view, reloadedState(view.state, `${tasks}- [ ] Light the lamp\n`, "Kesh Tor"));

    expect(screen.getByRole("checkbox", { name: "Light the lamp" })).toBeInTheDocument();
    expect(lineWith("•  Light the lamp")).toBeInTheDocument();
  });
});

describe("the reading view", () => {
  const text = [
    "# Kesh Tor %%a note%%",
    "",
    "Ruled by [[Mirela]] and [[Ghost]] since spring. ^rule",
    "",
    "- [ ] Bar the gate",
    "",
    "![[map.png|300]] and ![the map](map.png)",
    "",
    "| Who | Where |",
    "| --- | --- |",
    "| [[Mirela]] | hall |",
  ].join("\n");
  const at = (written: string, from = 0) => text.indexOf(written, from);
  const linkTo = (written: string, from: number, fields: Partial<EditorLink>): EditorLink => ({
    from,
    to: from + written.length,
    state: "resolved",
    target: written.slice(2, -2),
    path: `${written.slice(2, -2)}.md`,
    heading: null,
    block: null,
    ...fields,
  });
  const mirela = linkTo("[[Mirela]]", at("[[Mirela]]"), {});
  const ghost = linkTo("[[Ghost]]", at("[[Ghost]]"), { state: "unresolved", path: null });
  const map = linkTo("![[map.png|300]]", at("![[map"), {
    state: "attachment",
    target: "map.png",
    path: null,
  });
  const inGrid = linkTo("[[Mirela]]", at("[[Mirela]]", at("| [[")), {});

  /** The reading view of `text`, with the cursor at `cursor`, reporting changes and follows. */
  function renderReading(cursor = 0) {
    const changes: string[] = [];
    const onFollow = vi.fn();
    const state = createPageState(text, "Kesh Tor", cursor, { preview: true });
    const linked = state.update({ effects: setLinks([mirela, ghost, map, inGrid]) }).state;
    const result = render(
      <MarkdownEditor
        state={linked}
        readOnly={false}
        reading
        onChange={(next) => changes.push(next.doc.toString())}
        onFollow={onFollow}
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "Kesh Tor" });
    const view = EditorView.findFromDOM(textbox);
    if (!view) throw new Error("No editor");
    return { changes, onFollow, textbox, view, rerender: result.rerender, linked };
  }

  // CodeMirror measures the selection when its content takes focus; jsdom lays out nothing.
  const range = Range.prototype as Partial<Range>;
  beforeEach(() => {
    range.getClientRects = () => [] as unknown as DOMRectList;
    range.getBoundingClientRect = () => new DOMRect();
  });
  afterEach(() => {
    delete range.getClientRects;
    delete range.getBoundingClientRect;
  });

  const focusableLinks = (textbox: HTMLElement) => [
    ...textbox.querySelectorAll<HTMLElement>('[role="link"][tabindex="0"]'),
  ];

  it("takes no typing, paste, drop or undo, and reports no change", () => {
    const changes: string[] = [];
    // A state with an edit in its history, which undo would revert in an editable editor.
    const edited = createPageState(text, "Kesh Tor", 0, { preview: true }).update({
      changes: { from: 0, insert: "Old " },
      userEvent: "input.type",
    }).state;
    render(
      <MarkdownEditor
        state={edited}
        readOnly={false}
        reading
        onChange={(next) => changes.push(next.doc.toString())}
      />,
    );
    const textbox = screen.getByRole("textbox", { name: "Kesh Tor" });
    const view = EditorView.findFromDOM(textbox);
    if (!view) throw new Error("No editor");

    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, { key: "Backspace" });
    fireEvent.keyDown(textbox, { key: "z", ctrlKey: true });
    const clipboardData = { getData: () => "pasted", types: ["text/plain"] };
    fireEvent.paste(textbox, { clipboardData });
    fireEvent.drop(textbox, { dataTransfer: { ...clipboardData, files: [] } });

    expect(textbox).toHaveAttribute("contenteditable", "false");
    expect(textbox).toHaveAttribute("aria-readonly", "true");
    expect(view.state.doc.toString()).toBe(`Old ${text}`);
    expect(changes).toEqual([]);
  });

  it("shows no syntax on any line, even the one with the cursor", () => {
    renderReading(at("Ruled"));

    expect(lineWith("Kesh Tor ")).toHaveClass("cm-heading-1");
    // The whitespace before a block id stays.
    expect(lineWith("Ruled by Mirela and Ghost since spring. ")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Bar the gate" })).toBeInTheDocument();
  });

  it("shows image embeds as their names while no image can show", () => {
    renderReading();

    expect(lineWith("map.png and the map")).toBeInTheDocument();
  });

  it("lets Tab reach its resolved links in order, the grid's too, and no others", () => {
    const { textbox } = renderReading();

    const links = focusableLinks(textbox);
    expect(links.map((link) => link.textContent)).toEqual(["Mirela", "Mirela"]);
    for (const link of links) {
      act(() => link.focus());
      expect(link).toHaveFocus();
    }
  });

  it("follows a resolved link on a click, a Ctrl+click and Enter, in a line or a grid", () => {
    const { onFollow, textbox, view } = renderReading();
    const [inLine, gridLink] = focusableLinks(textbox);

    const clicked = fireEvent.mouseDown(inLine, { button: 0 });
    fireEvent.mouseDown(gridLink, { button: 0, ctrlKey: true });
    act(() => gridLink.focus());
    fireEvent.keyDown(gridLink, { key: "Enter" });

    expect(onFollow.mock.calls).toEqual([[mirela], [inGrid], [inGrid]]);
    expect(clicked).toBe(false);
    expect(view.state.selection.main.head).toBe(0);
  });

  it("does nothing for an unresolved link, a checkbox or Alt+Enter outside a link", () => {
    const { changes, onFollow, textbox, view } = renderReading(at("[[Ghost") + 3);
    const unresolved = textbox.querySelector(".cm-link-unresolved");
    if (!unresolved) throw new Error("No unresolved link");

    fireEvent.mouseDown(unresolved, { button: 0 });
    fireEvent.mouseDown(unresolved, { button: 0, ctrlKey: true });
    fireEvent.keyDown(textbox, { key: "Enter", altKey: true });
    fireEvent.mouseDown(screen.getByRole("checkbox", { name: "Bar the gate" }), { button: 0 });

    expect(onFollow).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(text);
    expect(changes).toEqual([]);
  });

  it("switches to the editing view and back in the same editor", () => {
    const { rerender, textbox, linked } = renderReading();

    rerender(<MarkdownEditor state={linked} readOnly={false} />);
    expect(screen.getByRole("textbox", { name: "Kesh Tor" })).toBe(textbox);
    expect(textbox).toHaveAttribute("contenteditable", "true");
    expect(focusableLinks(textbox)).toEqual([]);

    rerender(<MarkdownEditor state={linked} readOnly={false} reading />);
    expect(textbox).toHaveAttribute("contenteditable", "false");
    expect(focusableLinks(textbox)).toHaveLength(2);
  });

  it("keeps the reading view, or a read-only editing view, through a reload", () => {
    const reading = renderReading();
    replaceState(reading.view, reloadedState(reading.view.state, `${text}\n`, "Kesh Tor"));
    expect(reading.textbox).toHaveAttribute("contenteditable", "false");
    expect(reading.textbox).toHaveAttribute("aria-readonly", "true");
    cleanup();

    render(<MarkdownEditor state={createPageState(text, "Kesh Tor")} readOnly />);
    const textbox = screen.getByRole("textbox", { name: "Kesh Tor" });
    const view = EditorView.findFromDOM(textbox);
    if (!view) throw new Error("No editor");
    replaceState(view, reloadedState(view.state, `${text}\n`, "Kesh Tor"));
    expect(textbox).toHaveAttribute("aria-readonly", "true");
    expect(textbox).toHaveAttribute("contenteditable", "true");
  });
});
