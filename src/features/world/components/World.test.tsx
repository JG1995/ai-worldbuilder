import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldOpened } from "@/types/api";
import { mockWorldIpc, testWorld } from "../api/test-ipc";
import { autosaveDelay } from "../logic/saving";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";

function renderWorld() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <World />
    </QueryClientProvider>,
  );
}

// The welcome screen shows once the core has found no world to reopen.
const openWorldButton = () => screen.findByRole("button", { name: "Open world…" });
const tree = () => screen.findByRole("tree", { name: testWorld.name });

async function chooseFromWorldMenu(item: string) {
  fireEvent.click(screen.getByRole("button", { name: "World menu" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

beforeEach(() => {
  useWorldStore.getState().closed();
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

describe("opening and closing a world", () => {
  it("opens the picked world and shows its name and tree", async () => {
    mockWorldIpc();
    renderWorld();

    fireEvent.click(await openWorldButton());

    const entries = await tree();
    expect(screen.getByRole("heading", { name: testWorld.name })).toBeInTheDocument();
    expect(within(entries).getByRole("treeitem", { name: "Places" })).toBeInTheDocument();
    expect(within(entries).getByRole("treeitem", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("No page is open.")).toBeInTheDocument();
  });

  it("changes nothing when the folder dialog is cancelled", async () => {
    const calls = mockWorldIpc({ world_open: () => null });
    renderWorld();

    const button = await openWorldButton();
    await act(async () => fireEvent.click(button));

    expect(await openWorldButton()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.map(({ command }) => command)).toEqual([
      "world_restore",
      "recent_list",
      "world_open",
    ]);
  });

  it("explains a folder that cannot be opened and keeps the open world", async () => {
    let fail = false;
    mockWorldIpc({
      world_open: () => {
        if (fail) throw { kind: "io", message: "Permission denied." };
        return testWorld;
      },
    });
    renderWorld();
    fireEvent.click(await openWorldButton());
    await tree();
    fail = true;

    await chooseFromWorldMenu("Open world…");

    const dialog = await screen.findByRole("dialog", { name: "The folder cannot be opened" });
    expect(dialog).toHaveTextContent("Permission denied.");
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await tree()).toBeInTheDocument();
  });

  it("returns to the welcome screen on Close world", async () => {
    const calls = mockWorldIpc();
    renderWorld();
    fireEvent.click(await openWorldButton());
    await tree();

    await chooseFromWorldMenu("Close world");

    expect(await screen.findByRole("button", { name: "Open world…" })).toBeInTheDocument();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(calls.map(({ command }) => command)).toContain("world_close");
  });
});

describe("pages that cannot be shown", () => {
  async function openPage(name: string) {
    renderWorld();
    fireEvent.click(await openWorldButton());
    fireEvent.click(within(await tree()).getByRole("treeitem", { name }));
  }

  it("shows the not-UTF-8 notice instead of an editor", async () => {
    mockWorldIpc({
      page_read: () => {
        throw { kind: "not_utf8", message: "The page is not UTF-8 text." };
      },
    });

    await openPage("Overview");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This page is not UTF-8 text. It cannot be edited here and has not been changed.",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows a read failure with its reason, and Close closes the tab", async () => {
    mockWorldIpc({
      page_read: () => {
        throw { kind: "io", message: "Permission denied." };
      },
    });

    await openPage("Overview");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The page cannot be read: Permission denied.");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(within(notice).getByRole("button", { name: "Close" }));
    expect(await screen.findByText("No page is open.")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("shows a readable page in an editable editor under its title", async () => {
    mockWorldIpc();

    await openPage("Overview");

    expect(await screen.findByRole("textbox", { name: "Overview" })).not.toHaveAttribute(
      "aria-readonly",
    );
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
  });
});

/** Opens the test world and its Overview page, and returns the page's editor. */
async function openOverview() {
  renderWorld();
  fireEvent.click(await openWorldButton());
  fireEvent.click(within(await tree()).getByRole("treeitem", { name: "Overview" }));
  return screen.findByRole("textbox", { name: "Overview" });
}

function typeAtEnd(textbox: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}

/**
 * The commands called, in order, without `links_in`: an editor asks for its links whenever its
 * text pauses or the index changes, at no fixed point in a flow.
 */
const commandsOf = (calls: { command: string }[]) =>
  calls.map(({ command }) => command).filter((command) => command !== "links_in");
const writesOf = (calls: { command: string; args?: unknown }[]) =>
  calls.filter(({ command }) => command === "page_write").map(({ args }) => args);

const failingWrite = () => {
  throw { kind: "io", message: "Another program is using the file." };
};

// Shorter than the autosave delay, so a save seen within it was not an autosave.
const atOnce = { timeout: autosaveDelay / 2 };

describe("saving", () => {
  it("saves the active page at once on Ctrl+S and cancels the browser's own action", async () => {
    const calls = mockWorldIpc();
    typeAtEnd(await openOverview(), "More");

    const notCancelled = fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(notCancelled).toBe(false);
    await waitFor(
      () =>
        expect(writesOf(calls)).toEqual([
          {
            path: "Overview.md",
            text: "# Overview\nMore",
            version: "version of Overview.md",
            keepMine: false,
          },
        ]),
      atOnce,
    );
  });

  it("saves a page at once when another tab becomes active", async () => {
    const calls = mockWorldIpc();
    typeAtEnd(await openOverview(), "More");

    fireEvent.click(screen.getByRole("treeitem", { name: "Places" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Kesh Tor" }), { ctrlKey: true });

    await waitFor(() => expect(writesOf(calls)).toHaveLength(1), atOnce);
    expect(screen.getByRole("tab", { name: "Kesh Tor" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("focus", () => {
  /** Opens Overview, then Kesh Tor in a new tab, and returns Kesh Tor's editor. */
  async function openTwoPages() {
    await openOverview();
    fireEvent.click(screen.getByRole("treeitem", { name: "Places" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Kesh Tor" }), { ctrlKey: true });
    return screen.findByRole("textbox", { name: "Kesh Tor" });
  }

  const pressCtrlTab = () =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", ctrlKey: true });

  it("moves to the next page's editor on Ctrl+Tab in an editor", async () => {
    mockWorldIpc();
    const keshTor = await openTwoPages();
    act(() => EditorView.findFromDOM(keshTor)?.focus());

    pressCtrlTab();

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Overview" })).toHaveFocus());
  });

  it("stays on a focused tab on Ctrl+Tab", async () => {
    mockWorldIpc();
    await openTwoPages();
    const tab = screen.getByRole("tab", { name: "Kesh Tor" });
    act(() => tab.focus());

    pressCtrlTab();

    expect(await screen.findByRole("textbox", { name: "Overview" })).not.toHaveFocus();
    expect(tab).toHaveFocus();
  });

  it("moves to the tab that takes the place of a missing page closed from its notice", async () => {
    mockWorldIpc({
      page_write: () => {
        throw { kind: "not_found", message: "The page or folder does not exist." };
      },
    });
    typeAtEnd(await openTwoPages(), "More");
    await act(() => useWorldStore.getState().flush("Places/Kesh Tor.md"));

    const notice = screen.getByRole("alert");
    fireEvent.click(within(notice).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus());
    expect(screen.queryByRole("tab", { name: "Kesh Tor" })).not.toBeInTheDocument();
  });
});

describe("closing a page that cannot be saved", () => {
  const closeOverview = () =>
    fireEvent.click(screen.getByRole("button", { name: "Close Overview" }));
  const dialog = () => screen.findByRole("dialog", { name: '"Overview" could not be saved' });

  it("asks with Cancel focused; Cancel keeps the tab, Try again saves again, Discard closes it", async () => {
    const calls = mockWorldIpc({ page_write: failingWrite });
    typeAtEnd(await openOverview(), "More");

    closeOverview();
    const asked = await dialog();
    expect(asked).toHaveTextContent("Another program is using the file.");
    await waitFor(() =>
      expect(within(asked).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();

    closeOverview();
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(3));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Discard changes" }));

    expect(await screen.findByText("No page is open.")).toBeInTheDocument();
    expect(writesOf(calls)).toHaveLength(3);
  });

  it("closes the tab once Try again saves", async () => {
    let fail = true;
    mockWorldIpc({ page_write: () => (fail ? failingWrite() : { version: "saved" }) });
    typeAtEnd(await openOverview(), "More");
    closeOverview();
    const asked = await dialog();

    fail = false;
    fireEvent.click(within(asked).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No page is open.")).toBeInTheDocument();
  });

  it("asks before replacing it from the tree, and Cancel keeps it", async () => {
    mockWorldIpc({ page_write: failingWrite });
    typeAtEnd(await openOverview(), "More");

    fireEvent.click(screen.getByRole("treeitem", { name: "Places" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Kesh Tor" }));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Kesh Tor" })).not.toBeInTheDocument();
  });

  it("replaces only the tab whose save it checked when another tab becomes active meanwhile", async () => {
    let finishOverviewSave = () => {};
    const overviewSave = new Promise<void>((resolve) => {
      finishOverviewSave = resolve;
    });
    mockWorldIpc({
      page_write: ({ path }) =>
        path === "Overview.md" ? overviewSave.then(() => ({ version: "saved" })) : failingWrite(),
    });
    await openOverview();
    fireEvent.click(screen.getByRole("treeitem", { name: "Places" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Mirror lake" }), { ctrlKey: true });
    typeAtEnd(await screen.findByRole("textbox", { name: "Mirror lake" }), "Unsaved");
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    typeAtEnd(await screen.findByRole("textbox", { name: "Overview" }), "More");

    fireEvent.click(screen.getByRole("treeitem", { name: "Kesh Tor" }));
    fireEvent.click(screen.getByRole("tab", { name: "Mirror lake" }));
    await act(async () => finishOverviewSave());

    const asked = await screen.findByRole("dialog", { name: '"Mirror lake" could not be saved' });
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("tab", { name: "Kesh Tor" })).not.toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Mirror lake" })).toHaveTextContent(
      "# Mirror lakeUnsaved",
    );
  });

  it("asks when a conflict's Keep mine finds the page no longer UTF-8, which keeps the text read-only", async () => {
    let conflicted = false;
    const calls = mockWorldIpc({
      page_read: () => {
        if (conflicted) throw { kind: "not_utf8", message: "The page is not UTF-8 text." };
        return { text: "# Overview\n", version: "mine" };
      },
      page_write: () => {
        conflicted = true;
        throw { kind: "conflict", message: "The page changed on disk." };
      },
    });
    const textbox = await openOverview();
    typeAtEnd(textbox, "More");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const conflict = await screen.findByRole("alert");

    fireEvent.click(within(conflict).getByRole("button", { name: "Keep mine" }));

    expect(
      await screen.findByText(
        "This page is not UTF-8 text. It cannot be edited here and has not been changed.",
      ),
    ).toBeInTheDocument();
    expect(textbox).toHaveAttribute("aria-readonly", "true");
    expect(textbox).toHaveTextContent("# OverviewMore");
    closeOverview();
    expect(await dialog()).toHaveTextContent("The page is not UTF-8 text.");
    expect(writesOf(calls)).toHaveLength(1);
  });
});

describe("changing worlds", () => {
  it("saves pages before Open world… shows the folder dialog, and Cancel on a failing page stops it", async () => {
    const calls = mockWorldIpc({ page_write: failingWrite });
    typeAtEnd(await openOverview(), "More");

    await chooseFromWorldMenu("Open world…");
    const asked = await screen.findByRole("dialog", { name: '"Overview" could not be saved' });
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(commandsOf(calls).filter((command) => command === "world_open")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
  });

  it("saves pages and the workspace before Close world, then lists the recent worlds again", async () => {
    const calls = mockWorldIpc();
    typeAtEnd(await openOverview(), "More");

    await chooseFromWorldMenu("Close world");

    expect(await screen.findByRole("button", { name: "Open world…" })).toBeInTheDocument();
    const commands = commandsOf(calls);
    expect(commands.slice(commands.indexOf("page_write"))).toEqual([
      "page_write",
      "workspace_save",
      "world_close",
      "recent_list",
    ]);
  });

  /** A test world whose second Open world… waits for `pick` to answer the folder dialog. */
  function worldWithPendingDialog() {
    const second: WorldOpened = {
      ...testWorld,
      session: 2,
      workspace: { tabs: ["Overview.md"], active: "Overview.md", expanded: [], treeWidth: 264 },
    };
    let world = 1;
    const dialog = { pick: () => {}, cancel: () => {} };
    const calls = mockWorldIpc({
      world_open: () =>
        world === 1
          ? testWorld
          : new Promise<WorldOpened | null>((resolve) => {
              dialog.pick = () => resolve(second);
              dialog.cancel = () => resolve(null);
            }),
      page_read: () => ({ text: `# World ${world}\n`, version: `world ${world}` }),
    });
    return {
      calls,
      dialog,
      async openFolderDialog() {
        world = 2;
        await chooseFromWorldMenu("Open world…");
        await waitFor(() => expect(commandsOf(calls).at(-1)).toBe("world_open"));
      },
    };
  }

  // jsdom does not enforce `inert`, so the tests check that it is set; browsers then refuse input.
  const isInert = (element: HTMLElement) => element.closest("[inert]") !== null;

  it("refuses edits while the folder dialog is open, and Cancel restores editing", async () => {
    const { calls, dialog, openFolderDialog } = worldWithPendingDialog();
    const textbox = await openOverview();

    await openFolderDialog();

    expect(textbox).toHaveAttribute("aria-readonly", "true");
    expect(isInert(screen.getByRole("tree"))).toBe(true);
    await act(async () => dialog.cancel());
    await waitFor(() => expect(textbox).not.toHaveAttribute("aria-readonly"));
    expect(isInert(textbox)).toBe(false);
    typeAtEnd(textbox, "More");
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(
      () =>
        expect(writesOf(calls)).toEqual([
          { path: "Overview.md", text: "# World 1\nMore", version: "world 1", keepMine: false },
        ]),
      atOnce,
    );
  });

  it("lets nothing from one world reach the next", async () => {
    const { calls, dialog, openFolderDialog } = worldWithPendingDialog();
    const textbox = await openOverview();
    await openFolderDialog();
    expect(textbox).toHaveAttribute("aria-readonly", "true");

    await act(async () => dialog.pick());

    const next = await screen.findByRole("textbox", { name: "Overview" });
    await waitFor(() => expect(next).toHaveTextContent("# World 2"));
    expect(next).not.toHaveAttribute("aria-readonly");
    expect(isInert(next)).toBe(false);
    await act(() => new Promise((resolve) => setTimeout(resolve, autosaveDelay + 100)));
    expect(writesOf(calls)).toEqual([]);
  });
});
