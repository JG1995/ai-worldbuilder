import { EditorView } from "@codemirror/view";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
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
