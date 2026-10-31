import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PageTab path={path} session={testWorld.session} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
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

  it("offers Compare, which shows the diff in place of the editor and resolves with Keep mine", async () => {
    const { calls, notice } = await conflictedPage();

    fireEvent.click(within(notice).getByRole("button", { name: "Compare" }));

    const compare = await screen.findByRole("region", { name: "Compare" });
    expect(screen.queryByRole("textbox", { name: "Overview" })).not.toBeInTheDocument();
    const compared = calls
      .filter(({ command }) => command === "page_compare")
      .map(({ args }) => args);
    expect(compared).toEqual([{ path, text: "# Overview\nMine" }]);
    fireEvent.click(within(compare).getByRole("button", { name: "Keep mine" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Compare" })).not.toBeInTheDocument();
    expect(writesOf(calls).at(-1)).toEqual({ path, text: "# Overview\nMine", version: "theirs" });
  });

  it("resolves from Compare with Load theirs, reading the version on disk then", async () => {
    const { textbox, notice } = await conflictedPage();
    fireEvent.click(within(notice).getByRole("button", { name: "Compare" }));

    fireEvent.click(
      within(await screen.findByRole("region", { name: "Compare" })).getByRole("button", {
        name: "Load theirs",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(textbox).toHaveTextContent("# Overview.md changed elsewhere");
  });
});

describe("the missing-page notice", () => {
  /** A page whose save finds it deleted on disk. */
  async function missingPage(overrides: Parameters<typeof mockWorldIpc>[0] = {}) {
    const calls = mockWorldIpc({
      page_write: () => {
        throw { kind: "not_found", message: "The page or folder does not exist." };
      },
      ...overrides,
    });
    const textbox = await renderPage();
    typeAtEnd(textbox, "Mine");
    await saveNow();
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("This page was deleted or moved outside Grimoire.md.");
    return { calls, textbox, notice };
  }

  it("keeps the text read-only, and Restore writes it back", async () => {
    const { calls, textbox, notice } = await missingPage();
    expect(textbox).toHaveAttribute("aria-readonly", "true");

    fireEvent.click(within(notice).getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(
      calls.filter(({ command }) => command === "page_restore").map(({ args }) => args),
    ).toEqual([{ path, text: "# Overview\nMine" }]);
    expect(textbox).not.toHaveAttribute("aria-readonly");
  });

  it("closes the tab with Close, discarding the text without saving", async () => {
    const { calls, notice } = await missingPage();

    fireEvent.click(within(notice).getByRole("button", { name: "Close" }));

    expect(useWorldStore.getState().tabs).toEqual([]);
    expect(writesOf(calls)).toHaveLength(1);
  });
});
