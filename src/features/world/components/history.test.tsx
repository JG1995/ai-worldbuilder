import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine, HistoryVersion } from "@/types/api";
import { mockWorldIpc } from "../api/test-ipc";
import { useWorldStore } from "../stores/world-store";
import { versionTime } from "./HistoryView";
import { World } from "./World";

const path = "Overview.md";

const versions: HistoryVersion[] = [
  { id: "2-after", kind: "keep_mine", at: 1_700_000_600 },
  { id: "2-before", kind: "outside", at: 1_700_000_600 },
  { id: "1-before", kind: "outside", at: 1_700_000_000 },
];

const lines: DiffLine[] = [
  { kind: "removed", text: "Old line" },
  { kind: "added", text: "# Overview" },
];

type Handler = Parameters<typeof mockWorldIpc>[0];
type Calls = { command: string; args?: unknown }[];

const commandsOf = (calls: Calls) => calls.map(({ command }) => command);
const argsOf = (calls: Calls, command: string) =>
  calls.filter((call) => call.command === command).map(({ args }) => args);

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

/** Opens the test world with its Overview page, whose history the core answers with `versions`. */
async function openOverview(overrides: Handler = {}) {
  const calls = mockWorldIpc({
    history_list: () => versions,
    history_compare: () => lines,
    ...overrides,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <World />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "Overview" }));
  const textbox = await screen.findByRole("textbox", { name: "Overview" });
  return { calls, textbox };
}

/** Chooses History in the Overview row's context menu, and returns the view once it lists. */
async function historyFromMenu() {
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Overview" }), {
    clientX: 10,
    clientY: 10,
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: /^History/ }));
  return listedHistory();
}

async function listedHistory() {
  const view = await screen.findByRole("region", { name: "History" });
  await within(view).findByRole("listbox", { name: "Versions" });
  return view;
}

const selectedOption = () => screen.getByRole("option", { selected: true });
const restoreButton = () => screen.getByRole("button", { name: "Restore this version" });

beforeEach(() => {
  useWorldStore.getState().closed();
  // jsdom has no layout: the shell lays out as at 960px and wider.
  const wide = { matches: true, addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("matchMedia", () => wide);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

describe("opening the History view", () => {
  it("from the context menu saves pending edits, lists the versions and focuses the newest", async () => {
    const { calls, textbox } = await openOverview();
    typeAtEnd(textbox, "Mine");

    const view = await historyFromMenu();

    const commands = commandsOf(calls);
    expect(commands.indexOf("page_write")).toBeLessThan(commands.indexOf("history_list"));
    expect(argsOf(calls, "page_write")).toEqual([
      { path, text: "# Overview\nMine", version: `version of ${path}`, keepMine: false },
    ]);
    expect(
      within(view)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Current",
      `${versionTime(1_700_000_600)}Keep mine`,
      `${versionTime(1_700_000_600)}Changed outside Grimoire.md`,
      `${versionTime(1_700_000_000)}Changed outside Grimoire.md`,
    ]);
    await waitFor(() => expect(selectedOption()).toHaveFocus());
    expect(selectedOption()).toHaveTextContent("Keep mine");
    expect(textbox.closest("[hidden]")).not.toBeNull();

    fireEvent.click(within(view).getByRole("button", { name: "Back to editing" }));
    expect(screen.queryByRole("region", { name: "History" })).not.toBeInTheDocument();
    expect(textbox).toHaveFocus();
  });

  it("with Ctrl+Shift+H saves pending edits first, and cancels the browser's own shortcut", async () => {
    const { calls, textbox } = await openOverview();
    typeAtEnd(textbox, "Mine");

    const notCancelled = fireEvent.keyDown(textbox, { key: "H", ctrlKey: true, shiftKey: true });
    await listedHistory();

    expect(notCancelled).toBe(false);
    const commands = commandsOf(calls);
    expect(commands.indexOf("page_write")).toBeLessThan(commands.indexOf("history_list"));
  });

  it("says that a page Grimoire.md never saved has no earlier versions yet", async () => {
    await openOverview({ history_list: () => [] });

    const view = await historyFromMenu();

    expect(
      within(view)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Current"]);
    expect(view).toHaveTextContent("Earlier versions appear once Grimoire.md saves this page.");
    await waitFor(() => expect(selectedOption()).toHaveFocus());
    expect(restoreButton()).toBeDisabled();
  });

  it("shows why the page's history cannot be read", async () => {
    await openOverview({
      history_list: () => {
        throw { kind: "io", message: "The history database cannot be written." };
      },
    });

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Overview" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^History/ }));
    const view = await screen.findByRole("region", { name: "History" });

    expect(await within(view).findByRole("alert")).toHaveTextContent(
      "The page's history cannot be read: The history database cannot be written.",
    );
    const back = within(view).getByRole("button", { name: "Back to editing" });
    await waitFor(() => expect(back).toHaveFocus());
  });
});

describe("the version list", () => {
  it("shows the changes since the selected version, and moves with Up, Down, Home and End", async () => {
    const { calls } = await openOverview();
    const view = await historyFromMenu();

    const rows = within(
      await within(view).findByRole("list", { name: "Differences" }),
    ).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "−Only in this version: Old line",
      "+Only in the current text: # Overview",
    ]);
    expect(argsOf(calls, "history_compare")).toEqual([
      { path, version: "2-after", text: "# Overview\n" },
    ]);
    await waitFor(() => expect(selectedOption()).toHaveFocus());

    const press = (key: string) =>
      fireEvent.keyDown(document.activeElement ?? document.body, { key });
    press("ArrowDown");
    expect(selectedOption()).toHaveTextContent(`${versionTime(1_700_000_600)}Changed outside`);
    expect(selectedOption()).toHaveFocus();
    press("End");
    expect(selectedOption()).toHaveTextContent(versionTime(1_700_000_000));
    press("Home");
    expect(selectedOption()).toHaveTextContent("Current");
    expect(selectedOption()).toHaveFocus();
    expect(restoreButton()).toBeDisabled();
    press("ArrowUp");
    expect(selectedOption()).toHaveTextContent("Current");
    press("ArrowDown");
    expect(restoreButton()).toBeEnabled();
  });

  it("makes Restore this version unavailable while the page shows its conflict notice", async () => {
    const { textbox } = await openOverview({
      page_write: () => {
        throw { kind: "conflict", message: "The page changed on disk." };
      },
    });
    typeAtEnd(textbox, "Mine");

    await historyFromMenu();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This page changed on disk while it had unsaved edits.",
    );
    expect(selectedOption()).toHaveTextContent("Keep mine");
    expect(restoreButton()).toBeDisabled();
  });
});

describe("restoring a version", () => {
  /** Opens the Overview page's history and restores its newest earlier version. */
  async function restoreNewest(overrides: Handler = {}) {
    const opened = await openOverview({
      history_restore: () => ({ text: "# Overview restored\n", version: "restored", change: "3" }),
      ...overrides,
    });
    await historyFromMenu();
    fireEvent.click(restoreButton());
    return opened;
  }

  const toastRegion = () => screen.getByRole("status");

  it("writes it, returns to the editor and offers Undo, and Ctrl+Z brings back the replaced text", async () => {
    const { calls, textbox } = await restoreNewest();

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "History" })).not.toBeInTheDocument(),
    );
    expect(argsOf(calls, "history_restore")).toEqual([
      { path, version: "2-after", pageVersion: `version of ${path}` },
    ]);
    expect(textbox).toHaveFocus();
    expect(editorOf(textbox).state.doc.toString()).toBe("# Overview restored\n");
    expect(toastRegion()).toHaveTextContent(
      `Restored the version from ${versionTime(1_700_000_600)}`,
    );
    expect(within(toastRegion()).getByRole("button", { name: "Undo" })).toBeInTheDocument();

    undo(editorOf(textbox));
    expect(editorOf(textbox).state.doc.toString()).toBe("# Overview\n");
  });

  it("offers no Undo when history did not record the restore", async () => {
    await restoreNewest({
      history_restore: () => ({ text: "# Overview restored\n", version: "restored", change: null }),
    });

    await waitFor(() => expect(toastRegion()).toHaveTextContent("Restored the version from"));
    expect(within(toastRegion()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the view open with the reason when the version cannot be written", async () => {
    const { calls } = await restoreNewest({
      history_restore: () => {
        throw { kind: "io", message: "The page is read-only." };
      },
    });

    const view = screen.getByRole("region", { name: "History" });
    expect(await within(view).findByRole("alert")).toHaveTextContent(
      "This version could not be restored: The page is read-only.",
    );
    expect(argsOf(calls, "history_restore")).toHaveLength(1);
  });

  it("is undone from its toast, which writes back the text it replaced", async () => {
    const { calls, textbox } = await restoreNewest({
      history_undo: () => ({ text: "# Overview\n", version: "undone", change: "4" }),
    });
    const undoButton = await within(toastRegion()).findByRole("button", { name: "Undo" });

    fireEvent.click(undoButton);

    await waitFor(() => expect(editorOf(textbox).state.doc.toString()).toBe("# Overview\n"));
    expect(argsOf(calls, "history_undo")).toEqual([{ change: "3" }]);
    expect(toastRegion()).not.toHaveTextContent("Restored the version");
  });

  it("says why Undo is refused when the page changed since the restore, and writes nothing", async () => {
    const refusal =
      "“Overview” changed since the restore, so nothing was undone. Its history still holds every version.";
    const { textbox } = await restoreNewest({
      // The page on disk is still the restored one, as far as the editor knows.
      page_read: () => ({ text: "# Overview restored\n", version: "restored" }),
      history_undo: () => {
        throw { kind: "conflict", message: refusal };
      },
    });

    fireEvent.click(await within(toastRegion()).findByRole("button", { name: "Undo" }));

    expect(await within(toastRegion()).findByText(refusal)).toBeInTheDocument();
    expect(editorOf(textbox).state.doc.toString()).toBe("# Overview restored\n");
  });
});
