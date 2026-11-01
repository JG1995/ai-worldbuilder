import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWorldIpc, testWorld } from "../api/test-ipc";
import { autosaveDelay } from "../logic/saving";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";
import type { QuickOpenPorts } from "./WorldScreen";

/** The ports the stand-in slot was last rendered with. */
let ports: QuickOpenPorts | null = null;

/** Stands in for the search feature's dialog: a modal dialog that takes focus. */
function StandIn(given: QuickOpenPorts) {
  ports = given;
  return (
    <div role="dialog" aria-modal="true" aria-label="Stand-in quick open">
      {/* biome-ignore lint/a11y/noAutofocus: the stand-in takes focus as the real dialog does. */}
      <input aria-label="Stand-in query" autoFocus />
    </div>
  );
}

function renderWorld({ slot = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <World quickOpen={slot ? (given) => <StandIn {...given} /> : undefined} />
    </QueryClientProvider>,
  );
}

/** Opens the test world and its Overview page, and returns the page's editor. */
async function openOverview(options?: { slot?: boolean }) {
  renderWorld(options);
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  const tree = await screen.findByRole("tree", { name: testWorld.name });
  fireEvent.click(within(tree).getByRole("treeitem", { name: "Overview" }));
  return screen.findByRole("textbox", { name: "Overview" });
}

function editorOf(textbox: HTMLElement) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  return view;
}

const standIn = () => screen.queryByRole("dialog", { name: "Stand-in quick open" });
/** Presses a shortcut where focus is; false when it was cancelled. */
const press = (key: string, init: Partial<KeyboardEventInit> = { ctrlKey: true }) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
const slot = () => {
  if (!ports) throw new Error("The slot was never rendered");
  return ports;
};
const writesOf = (calls: { command: string }[]) =>
  calls.filter(({ command }) => command === "page_write");
const failingWrite = () => {
  throw { kind: "io", message: "Another program is using the file." };
};

beforeEach(() => {
  ports = null;
  useWorldStore.getState().closed();
  useWorldStore.getState().setChangingWorld(false);
  // jsdom has no layout: the shell lays out as at 960px and wider, and the tab strip never overflows.
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

describe("the quick open slot", () => {
  it("opens from Ctrl+O, Ctrl+K and the tree's Search button, saving pending edits first", async () => {
    const calls = mockWorldIpc();
    const view = editorOf(await openOverview());
    act(() => view.dispatch({ changes: { from: 0, insert: "More " }, userEvent: "input.type" }));

    expect(press("o")).toBe(false);
    expect(standIn()).toBeInTheDocument();
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1), { timeout: autosaveDelay / 2 });
    expect(slot().activePage).toBe("Overview.md");

    act(() => slot().close());
    expect(standIn()).not.toBeInTheDocument();
    expect(press("k", { metaKey: true })).toBe(false);
    expect(standIn()).toBeInTheDocument();

    act(() => slot().close());
    const search = screen.getByRole("button", { name: "Search pages" });
    expect(search).toHaveAccessibleDescription("Search pages Ctrl+O");
    fireEvent.click(search);
    expect(standIn()).toBeInTheDocument();
  });

  it("does not open in a modal dialog or during a world change, which closes it", async () => {
    mockWorldIpc();
    await openOverview();
    const { setChangingWorld } = useWorldStore.getState();

    act(() => setChangingWorld(true));
    expect(press("o")).toBe(false);
    expect(standIn()).not.toBeInTheDocument();
    act(() => setChangingWorld(false));

    fireEvent.click(screen.getByRole("button", { name: "World menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New world…" }));
    const newWorld = await screen.findByRole("dialog", { name: "New world" });
    await waitFor(() => expect(newWorld).toContainElement(document.activeElement as HTMLElement));
    expect(press("o")).toBe(false);
    expect(standIn()).not.toBeInTheDocument();
    fireEvent.click(within(newWorld).getByRole("button", { name: "Cancel" }));

    press("o");
    expect(standIn()).toBeInTheDocument();
    act(() => setChangingWorld(true));
    expect(standIn()).not.toBeInTheDocument();
  });

  it("opens a page in the current tab after saving the page it replaces, asking when it cannot", async () => {
    mockWorldIpc({ page_write: failingWrite });
    const view = editorOf(await openOverview());
    act(() => view.dispatch({ changes: { from: 0, insert: "More " }, userEvent: "input.type" }));
    press("o");

    act(() => {
      slot().close();
      slot().openPage("Places/Kesh Tor.md", { newTab: false });
    });

    const asked = await screen.findByRole("dialog", { name: '"Overview" could not be saved' });
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Kesh Tor" })).not.toBeInTheDocument();
    expect(standIn()).not.toBeInTheDocument();
  });

  it("opens a page in the current or a new tab with focus in its editor", async () => {
    mockWorldIpc();
    await openOverview();

    press("o");
    act(() => {
      slot().close();
      slot().openPage("Places/Kesh Tor.md", { newTab: true });
    });
    const keshTor = await screen.findByRole("textbox", { name: "Kesh Tor" });
    await waitFor(() => expect(keshTor).toHaveFocus());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Kesh Tor",
    ]);

    press("o");
    act(() => {
      slot().close();
      slot().openPage("Places/Mirror lake.md", { newTab: false });
    });
    const mirrorLake = await screen.findByRole("textbox", { name: "Mirror lake" });
    await waitFor(() => expect(mirrorLake).toHaveFocus());
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Mirror lake",
    ]);
  });

  it("focuses the active page's own editor with its cursor kept", async () => {
    mockWorldIpc();
    const overview = await openOverview();
    const view = editorOf(overview);
    act(() => view.dispatch({ selection: { anchor: 3 } }));

    press("o");
    expect(screen.getByRole("textbox", { name: "Stand-in query" })).toHaveFocus();
    act(() => {
      slot().close();
      slot().openPage("Overview.md", { newTab: false });
    });

    await waitFor(() => expect(overview).toHaveFocus());
    expect(view.state.selection.main.head).toBe(3);
  });

  it("opens a created page in a new tab once the tree lists it, and follows the index", async () => {
    const calls = mockWorldIpc();
    await openOverview();
    press("o");
    const listings = () => calls.filter(({ command }) => command === "world_tree").length;
    const before = listings();

    act(() => {
      slot().close();
      slot().pageCreated("Places/Harbor.md");
    });

    const harbor = await screen.findByRole("textbox", { name: "Harbor" });
    await waitFor(() => expect(harbor).toHaveFocus());
    expect(listings()).toBe(before + 1);
    expect(screen.getByRole("tab", { name: "Harbor" })).toHaveAttribute("aria-selected", "true");

    press("o");
    act(() => useWorldStore.getState().indexChanged(testWorld.session));
    expect(slot().indexRevision).toBe(1);
    expect(slot().activePage).toBe("Places/Harbor.md");
    act(() => slot().refreshTree());
    await waitFor(() => expect(listings()).toBe(before + 2));
    act(() => {
      slot().close();
      slot().showWorldMissing();
    });
    expect(await screen.findByText("The world's folder cannot be found.")).toBeInTheDocument();
  });

  it("is not there without a slot: no Search button, and Ctrl+O is left alone", async () => {
    mockWorldIpc();
    await openOverview({ slot: false });

    expect(press("o")).toBe(true);
    expect(screen.queryByRole("button", { name: "Search pages" })).not.toBeInTheDocument();
    expect(ports).toBeNull();
  });
});
