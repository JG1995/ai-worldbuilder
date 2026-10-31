import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPageState } from "../editor/MarkdownEditor";
import { PageSaver } from "./saving";
import { type PageStatus, useWorldStore, workspaceSaveDelay } from "./store";
import { mockWorldIpc } from "./test-ipc";

const store = () => useWorldStore.getState();

function openWorld(tabs: string[] = [], active: string | null = null, session = 1) {
  store().opened({
    name: "Sample",
    session,
    workspace: { tabs, active, expanded: [], treeWidth: 264 },
  });
}

/** A ready page whose saver writes nothing, with a spy on the saver's `dispose`. */
function readyPage(text: string) {
  const saver = new PageSaver(
    "A.md",
    { text, version: "v1" },
    { read: vi.fn(), write: vi.fn(), notify: vi.fn() },
  );
  const dispose = vi.spyOn(saver, "dispose");
  const page: PageStatus = {
    status: "ready",
    editor: createPageState(text, "A"),
    saver,
    notice: null,
  };
  return { page, dispose };
}

beforeEach(() => store().closed());

describe("opening pages", () => {
  it("opens a page in a new tab when no tab is active, and activates it", () => {
    openWorld();

    store().openPage("Places/Saltmere.md", { newTab: false });

    expect(store().tabs).toEqual(["Places/Saltmere.md"]);
    expect(store().active).toBe("Places/Saltmere.md");
    expect(store().pages["Places/Saltmere.md"]).toEqual({ status: "loading" });
  });

  it("replaces the active tab's page and forgets the page it showed", () => {
    openWorld(["A.md", "B.md", "C.md"], "B.md");

    store().openPage("D.md", { newTab: false });

    expect(store().tabs).toEqual(["A.md", "D.md", "C.md"]);
    expect(store().active).toBe("D.md");
    expect(store().pages["B.md"]).toBeUndefined();
  });

  it("activates the tab of a page that is already open instead of opening another", () => {
    openWorld(["A.md", "B.md"], "B.md");

    store().openPage("A.md", { newTab: false });
    store().openPage("A.md", { newTab: true });

    expect(store().tabs).toEqual(["A.md", "B.md"]);
    expect(store().active).toBe("A.md");
  });

  it("appends a new tab at the end and activates it when asked for a new tab", () => {
    openWorld(["A.md", "B.md"], "A.md");

    store().openPage("C.md", { newTab: true });

    expect(store().tabs).toEqual(["A.md", "B.md", "C.md"]);
    expect(store().active).toBe("C.md");
  });

  it("expands the active page's ancestor folders and keeps other expanded folders", () => {
    openWorld();
    store().toggleFolder("Other", true);

    store().openPage("Places/Coast/Cliffs.md", { newTab: false });

    expect([...store().expanded].sort()).toEqual(["Other", "Places", "Places/Coast"]);
  });
});

describe("closing tabs", () => {
  it("activates the right neighbour of the closed active tab", () => {
    openWorld(["A.md", "B.md", "C.md"], "B.md");

    store().closeTab("B.md");

    expect(store().tabs).toEqual(["A.md", "C.md"]);
    expect(store().active).toBe("C.md");
    expect(store().pages["B.md"]).toBeUndefined();
  });

  it("activates the left neighbour when the closed active tab was last", () => {
    openWorld(["A.md", "B.md"], "B.md");

    store().closeTab("B.md");

    expect(store().active).toBe("A.md");
  });

  it("keeps the active tab when another tab closes, and leaves none after the last", () => {
    openWorld(["A.md", "B.md"], "A.md");

    store().closeTab("B.md");
    expect(store().active).toBe("A.md");

    store().closeTab("A.md");
    expect(store().tabs).toEqual([]);
    expect(store().active).toBeNull();
  });
});

describe("new entries", () => {
  it("go in the right-clicked folder, then the selected folder, then the active page's, then the top level", () => {
    openWorld();
    expect(store().newEntryFolder()).toBeNull();

    store().openPage("Places/Coast/Cliffs.md", { newTab: false });
    expect(store().newEntryFolder()).toBe("Places/Coast");

    store().toggleFolder("Factions", true);
    expect(store().newEntryFolder()).toBe("Factions");
    expect(store().newEntryFolder("Characters")).toBe("Characters");

    // A folder stays selected only until another page becomes active.
    store().openPage("Overview.md", { newTab: true });
    expect(store().newEntryFolder()).toBeNull();
  });

  it("select a toggled or created folder until another page becomes active", () => {
    openWorld(["A.md", "B.md"], "A.md");

    store().toggleFolder("Places", false);
    expect(store().selectedFolder).toBe("Places");

    store().closeTab("B.md");
    expect(store().selectedFolder).toBe("Places");

    store().folderCreated("Places/Coast");
    expect(store().selectedFolder).toBe("Places/Coast");
    expect([...store().expanded].sort()).toEqual(["Places", "Places/Coast"]);

    store().closeTab("A.md");
    expect(store().selectedFolder).toBeNull();
  });

  it("open the name input in its expanded folder and keep it open with an error", () => {
    openWorld();

    store().startNaming("page", "Places/Coast");
    store().setNameError("Names cannot be empty.");

    expect(store().nameInput).toEqual({
      kind: "page",
      folder: "Places/Coast",
      error: "Names cannot be empty.",
    });
    expect([...store().expanded].sort()).toEqual(["Places", "Places/Coast"]);
  });

  it("open a created page in a new tab, selected, and remember it until its editor shows", () => {
    openWorld(["A.md"], "A.md");
    store().toggleFolder("Places", true);
    store().startNaming("page", "Places");

    store().pageCreated("Places/Kesh Tor.md");

    expect(store().nameInput).toBeNull();
    expect(store().tabs).toEqual(["A.md", "Places/Kesh Tor.md"]);
    expect(store().active).toBe("Places/Kesh Tor.md");
    expect(store().selectedFolder).toBeNull();
    expect(store().createdPage).toBe("Places/Kesh Tor.md");
    store().createdPageShown();
    expect(store().createdPage).toBeNull();
  });
});

describe("page results", () => {
  it("are ignored for a page that is no longer open", () => {
    openWorld(["A.md"], "A.md");

    store().setPage(1, "Gone.md", { status: "not_utf8" });
    store().setPage(1, "A.md", { status: "read_error", message: "Permission denied." });

    expect(store().pages).toEqual({
      "A.md": { status: "read_error", message: "Permission denied." },
    });
  });

  it("are ignored when they come from another world with a page at the same path", () => {
    openWorld(["A.md"], "A.md", 1);
    const first = readyPage("first world");
    store().setPage(1, "A.md", first.page);

    openWorld(["A.md"], "A.md", 2);
    // The first world's tab hands back its editor as it unmounts, and its saver reports.
    store().setEditor(1, "A.md", createPageState("first world, edited", "A"));
    store().setNotice(1, "A.md", { kind: "conflict" });
    store().setPage(1, "A.md", first.page);

    expect(store().pages["A.md"]).toEqual({ status: "loading" });
  });
});

describe("savers", () => {
  it("stop when their page closes or is replaced in its tab", () => {
    openWorld(["A.md", "B.md"], "A.md");
    const a = readyPage("a");
    const b = readyPage("b");
    store().setPage(1, "A.md", a.page);
    store().setPage(1, "B.md", b.page);

    store().openPage("C.md", { newTab: false });
    store().closeTab("B.md");

    expect(a.dispose).toHaveBeenCalled();
    expect(b.dispose).toHaveBeenCalled();
  });

  it("stop when their world closes or another opens", () => {
    openWorld(["A.md"], "A.md", 1);
    const first = readyPage("first");
    store().setPage(1, "A.md", first.page);
    openWorld(["A.md"], "A.md", 2);
    expect(first.dispose).toHaveBeenCalled();
    const second = readyPage("second");
    store().setPage(2, "A.md", second.page);

    store().closed();

    expect(second.dispose).toHaveBeenCalled();
  });
});

describe("the workspace", () => {
  const saves = (calls: { command: string; args?: unknown }[]) =>
    calls.filter(({ command }) => command === "workspace_save").map(({ args }) => args);

  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("saves once, half a second after tabs, expanded folders and the tree width stop changing", async () => {
    const calls = mockWorldIpc();
    openWorld(["A.md"], "A.md");
    await vi.advanceTimersByTimeAsync(workspaceSaveDelay);
    // Opening a world is not a change to save.
    expect(saves(calls)).toEqual([]);

    store().openPage("Places/B.md", { newTab: true });
    store().toggleFolder("Places", false);
    store().setTreeWidth(300);
    await vi.advanceTimersByTimeAsync(workspaceSaveDelay - 1);
    expect(saves(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(saves(calls)).toEqual([
      {
        workspace: {
          tabs: ["A.md", "Places/B.md"],
          active: "Places/B.md",
          expanded: [],
          treeWidth: 300,
        },
      },
    ]);
  });

  it("saves nothing for a world that closed or changed before the delay ended", async () => {
    const calls = mockWorldIpc();
    openWorld();
    store().setTreeWidth(300);
    store().closed();
    openWorld([], null, 2);
    store().setTreeWidth(320);
    openWorld([], null, 3);

    await vi.advanceTimersByTimeAsync(workspaceSaveDelay);

    expect(saves(calls)).toEqual([]);
  });
});
