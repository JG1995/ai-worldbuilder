import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorLink } from "@/types/api";
import { setLinks } from "./editor-links";
import { createPageState, MarkdownEditor } from "./MarkdownEditor";

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
