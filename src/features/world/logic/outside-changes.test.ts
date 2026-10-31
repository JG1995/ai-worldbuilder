import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageText, WorldEvents, WorldOpened } from "@/types/api";
import { mockWorldIpc, testWorld } from "../api/test-ipc";
import { World } from "../components/World";
import { useWorldStore } from "../stores/world-store";
import { reloadToast } from "./outside-changes";

const overview = "Overview.md";
const keshTor = "Places/Kesh Tor.md";

/** The pages on disk, which a test changes as another program would. */
let disk: Map<string, PageText | "not_utf8">;

/** Mocks the core with `disk`, opening the test world with both pages in tabs. */
function mockDisk(active: string) {
  const opened: WorldOpened = {
    ...testWorld,
    workspace: { tabs: [overview, keshTor], active, expanded: [], treeWidth: 264 },
  };
  return mockWorldIpc({
    world_open: () => opened,
    page_read: ({ path }) => {
      const page = disk.get(String(path));
      if (page === "not_utf8") throw { kind: "not_utf8", message: "The page is not UTF-8 text." };
      if (!page) throw { kind: "not_found", message: "The page or folder does not exist." };
      return page;
    },
  });
}

/** Renders the world screens; this file is plain TypeScript, so without JSX. */
function renderWorld() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(World)));
}

async function openWorld() {
  renderWorld();
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
}

/** Opens the world, shows `first` so it is read, then shows `second`, whose editor it returns. */
async function bothPagesRead(first: string, second: string) {
  await openWorld();
  await screen.findByRole("textbox", { name: nameOf(first) });
  fireEvent.click(screen.getByRole("tab", { name: nameOf(second) }));
  return screen.findByRole("textbox", { name: nameOf(second) });
}

const nameOf = (path: string) => (path === overview ? "Overview" : "Kesh Tor");

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

const changed = (payload: Partial<WorldEvents["world:changed"]>) =>
  act(() => emit("world:changed", { session: 1, tree: false, pages: [], ...payload }));

const commandsOf = (calls: { command: string }[], command: string) =>
  calls.filter((call) => call.command === command);

beforeEach(() => {
  useWorldStore.getState().closed();
  disk = new Map([
    [overview, { text: "# Overview\n", version: "o1" }],
    [keshTor, { text: "# Kesh Tor\n", version: "k1" }],
  ]);
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

describe("a change on disk", () => {
  it("reloads open pages without unsaved edits, with one toast for the batch, and refreshes the tree", async () => {
    const calls = mockDisk(overview);
    const textbox = await bothPagesRead(overview, keshTor);
    // The cursor after "# Kesh To", on a first line that the new text shortens.
    editorOf(textbox).dispatch({ selection: { anchor: 9 } });
    disk.set(overview, { text: "# Overview\nChanged elsewhere\n", version: "o2" });
    disk.set(keshTor, { text: "# Kesh\nMore\n", version: "k2" });

    await changed({ tree: true, pages: [overview, keshTor, "Not open.md"] });

    await waitFor(() => expect(textbox).toHaveTextContent("# KeshMore"));
    const view = editorOf(textbox);
    expect(view.state.selection.main.head).toBe("# Kesh".length);
    // A fresh undo history: undo cannot bring the old text back.
    expect(undo(view)).toBe(false);
    expect(await screen.findAllByText(reloadToast)).toHaveLength(1);
    expect(commandsOf(calls, "world_tree")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(await screen.findByRole("textbox", { name: "Overview" })).toHaveTextContent(
      "# OverviewChanged elsewhere",
    );
    expect(commandsOf(calls, "page_write")).toEqual([]);
  });

  it("is ignored from an earlier world or when the page has its version, and conflicts with unsaved edits", async () => {
    const calls = mockDisk(overview);
    await openWorld();
    const textbox = await screen.findByRole("textbox", { name: "Overview" });
    const reads = () => commandsOf(calls, "page_read").length;
    const readsBefore = reads();

    disk.set(overview, { text: "# Overview\nTheirs\n", version: "o2" });
    await changed({ session: 0, pages: [overview] });
    expect(reads()).toBe(readsBefore);

    disk.set(overview, { text: "# Overview\n", version: "o1" });
    await changed({ pages: [overview] });
    await waitFor(() => expect(reads()).toBe(readsBefore + 1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    typeAtEnd(textbox, "Mine");
    disk.set(overview, { text: "# Overview\nTheirs\n", version: "o2" });
    await changed({ pages: [overview] });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("This page changed on disk while it had unsaved edits.");
    expect(within(notice).getByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(textbox).toHaveTextContent("# OverviewMine");
    expect(screen.queryByText(reloadToast)).not.toBeInTheDocument();
  });

  it("shows the missing-page notice over the kept text of a page deleted on disk", async () => {
    mockDisk(overview);
    await openWorld();
    const textbox = await screen.findByRole("textbox", { name: "Overview" });
    typeAtEnd(textbox, "Mine");
    disk.delete(overview);

    await changed({ tree: true, pages: [overview] });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("This page was deleted or moved outside Grimoire.md.");
    expect(within(notice).getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(textbox).toHaveTextContent("# OverviewMine");
    expect(textbox).toHaveAttribute("aria-readonly", "true");
  });

  it("keeps unsaved text read-only under the notice of a page no longer UTF-8, and shows an unedited one without an editor", async () => {
    const calls = mockDisk(keshTor);
    const textbox = await bothPagesRead(keshTor, overview);
    typeAtEnd(textbox, "Mine");
    disk.set(overview, "not_utf8");
    disk.set(keshTor, "not_utf8");

    await changed({ pages: [overview, keshTor] });

    expect(await screen.findByRole("alert")).toHaveTextContent("This page is not UTF-8 text.");
    expect(textbox).toHaveTextContent("# OverviewMine");
    expect(textbox).toHaveAttribute("aria-readonly", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Kesh Tor" }));
    expect(await screen.findByText(/This page is not UTF-8 text/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Kesh Tor" })).not.toBeInTheDocument();
    expect(commandsOf(calls, "page_write")).toEqual([]);
  });
});

describe("world-level notices", () => {
  it("show a watcher that could not start, even when its event comes before the world opens", async () => {
    mockDisk(overview);
    renderWorld();
    const open = await screen.findByRole("button", { name: "Open world…" });

    await act(() => emit("world:watch-failed", { session: 1, message: "Too many watches." }));
    fireEvent.click(open);

    expect(
      await screen.findByText("Outside changes may not appear until the world is reopened."),
    ).toBeInTheDocument();
  });

  it("show a world whose folder is gone, with Close world", async () => {
    const calls = mockDisk(overview);
    await openWorld();
    await screen.findByRole("textbox", { name: "Overview" });

    await act(() => emit("world:missing", { session: 1 }));

    const notice = (await screen.findByText("The world's folder cannot be found.")).closest(
      '[role="alert"]',
    );
    if (!(notice instanceof HTMLElement)) throw new Error("No notice");
    fireEvent.click(within(notice).getByRole("button", { name: "Close world" }));
    expect(await screen.findByRole("button", { name: "Open world…" })).toBeInTheDocument();
    expect(commandsOf(calls, "world_close")).toHaveLength(1);
  });
});
