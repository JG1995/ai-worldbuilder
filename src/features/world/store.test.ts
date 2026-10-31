import { beforeEach, describe, expect, it } from "vitest";
import { useWorldStore } from "./store";

const store = () => useWorldStore.getState();

function openWorld(tabs: string[] = [], active: string | null = null) {
  store().opened({
    name: "Sample",
    session: 1,
    workspace: { tabs, active, expanded: [], treeWidth: 264 },
  });
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

it("ignores a page result for a page that is no longer open", () => {
  openWorld(["A.md"], "A.md");

  store().setPage("Gone.md", { status: "not_utf8" });
  store().setPage("A.md", { status: "read_error", message: "Permission denied." });

  expect(store().pages).toEqual({
    "A.md": { status: "read_error", message: "Permission denied." },
  });
});
