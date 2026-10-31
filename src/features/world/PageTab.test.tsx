import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageTab } from "./PageTab";
import { useWorldStore } from "./store";
import { mockWorldIpc, testWorld } from "./test-ipc";

const path = "Overview.md";

function renderPage() {
  useWorldStore.getState().opened({
    ...testWorld,
    workspace: { tabs: [path], active: path, expanded: [], treeWidth: 264 },
  });
  render(<PageTab path={path} session={testWorld.session} onClose={vi.fn()} />);
  return screen.findByRole("textbox", { name: "Overview" });
}

function editorOf(textbox: HTMLElement) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  return view;
}

function typeAtEnd(textbox: HTMLElement, text: string) {
  const view = editorOf(textbox);
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}

const saveNow = () => act(() => useWorldStore.getState().flush(path));

const writesOf = (calls: { command: string; args?: unknown }[]) =>
  calls.filter(({ command }) => command === "page_write").map(({ args }) => args);

beforeEach(() => useWorldStore.getState().closed());

describe("the failed-save notice", () => {
  it("gives the reason and keeps the text, and Retry saves", async () => {
    let fail = true;
    const calls = mockWorldIpc({
      page_write: () => {
        if (fail) throw { kind: "io", message: "Another program is using the file." };
        return { version: "v2" };
      },
    });
    const textbox = await renderPage();
    typeAtEnd(textbox, "Mine");

    await saveNow();

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(
      "This page could not be saved: Another program is using the file.",
    );
    expect(textbox).toHaveTextContent("# OverviewMine");
    fail = false;
    fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(writesOf(calls)).toHaveLength(2);
  });
});

describe("the conflict notice", () => {
  /** A page whose first save finds that it changed on disk, which now holds `theirs`. */
  async function conflictedPage() {
    let writes = 0;
    const calls = mockWorldIpc({
      page_read: ({ path }) =>
        writes === 0
          ? { text: "# Overview\n", version: "mine" }
          : { text: `# ${String(path)} changed elsewhere\n`, version: "theirs" },
      page_write: () => {
        if (++writes === 1) throw { kind: "conflict", message: "The page changed on disk." };
        return { version: "saved" };
      },
    });
    const textbox = await renderPage();
    typeAtEnd(textbox, "Mine");
    await saveNow();
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("This page changed on disk while it had unsaved edits.");
    return { calls, textbox, notice };
  }

  it("offers Keep mine, which writes the editor's text over the version on disk", async () => {
    const { calls, notice } = await conflictedPage();

    fireEvent.click(within(notice).getByRole("button", { name: "Keep mine" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(writesOf(calls).at(-1)).toEqual({
      path,
      text: "# Overview\nMine",
      version: "theirs",
    });
  });

  it("offers Load theirs, which replaces the text in one undoable step and writes nothing", async () => {
    const { calls, textbox, notice } = await conflictedPage();

    fireEvent.click(within(notice).getByRole("button", { name: "Load theirs" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(textbox).toHaveTextContent("# Overview.md changed elsewhere");
    await saveNow();
    expect(writesOf(calls)).toHaveLength(1);
    undo(editorOf(textbox));
    expect(editorOf(textbox).state.doc.toString()).toBe("# Overview\nMine");
  });
});
