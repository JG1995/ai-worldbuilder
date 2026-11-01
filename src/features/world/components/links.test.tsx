import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorLink, EditorLinks, LinkedPage } from "@/types/api";
import { mockWorldIpc } from "../api/test-ipc";
import { outsideWorldToast } from "../logic/links";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";

const overviewText = [
  "# Overview",
  "",
  "Shelter at [[Kesh Tor#Shelter]], see [[#Rules]], visit [[Saltmere]], map ![[map.png]].",
  "",
  "## Rules",
  "",
].join("\n");
const keshTorText = "# Kesh Tor\n\nBasalt.\n\n## Shelter\n\nA cave.\n";

/** The core's links of `text`, which holds each link at most once. */
function linksOf(text: string): EditorLink[] {
  const link = (written: string, fields: Partial<EditorLink>): EditorLink[] => {
    const from = text.indexOf(written);
    if (from === -1) return [];
    const base = { target: "", path: null, heading: null, block: null };
    return [{ from, to: from + written.length, state: "resolved", ...base, ...fields }];
  };
  return [
    ...link("[[Kesh Tor#Shelter]]", {
      target: "Kesh Tor",
      path: "Places/Kesh Tor.md",
      heading: "Shelter",
    }),
    ...link("[[#Rules]]", { path: "Overview.md", heading: "Rules" }),
    ...link("[[Saltmere]]", { state: "unresolved", target: "Saltmere" }),
    ...link("![[map.png]]", { state: "attachment", target: "map.png" }),
  ];
}

type Handler = Parameters<typeof mockWorldIpc>[0];

/** Opens the test world and its Overview page, whose links the core reports from its text. */
async function openOverview(overrides: Handler = {}) {
  const calls = mockWorldIpc({
    page_read: ({ path }) =>
      path === "Places/Kesh Tor.md"
        ? { text: keshTorText, version: "k1" }
        : path === "Overview.md"
          ? { text: overviewText, version: "o1" }
          : { text: "", version: "new" },
    links_in: ({ text }): EditorLinks => ({ state: "ready", links: linksOf(String(text)) }),
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

function editorOf(textbox: HTMLElement) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  return view;
}

const callsOf = (calls: { command: string; args?: unknown }[], command: string) =>
  calls.filter((call) => call.command === command).map(({ args }) => args);
const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
const activeTab = () => screen.getByRole("tab", { selected: true }).textContent;

/** Waits until the editor marks its links, then follows the one written as `written`. */
async function follow(textbox: HTMLElement, written: string) {
  const view = editorOf(textbox);
  await waitFor(() => expect(textbox.querySelector(".cm-link")).not.toBeNull());
  const at = view.state.doc.toString().indexOf(written) + 2;
  act(() => view.dispatch({ selection: { anchor: at } }));
  fireEvent.keyDown(textbox, { key: "Enter", altKey: true });
}

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
  // jsdom has no layout for text, which the editor measures to scroll the cursor into view.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

describe("a page's links", () => {
  it("are asked for when the page shows, after typing pauses and when the index changes", async () => {
    const { calls, textbox } = await openOverview();
    await waitFor(() => expect(textbox.querySelector(".cm-link-unresolved")).not.toBeNull());
    expect(textbox.querySelector(".cm-link")).toHaveTextContent("[[Kesh Tor#Shelter]]");
    expect(callsOf(calls, "links_in")).toEqual([{ path: "Overview.md", text: overviewText }]);

    const view = editorOf(textbox);
    act(() => view.dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.type" }));
    await waitFor(() => expect(callsOf(calls, "links_in")).toHaveLength(2));
    expect(callsOf(calls, "links_in")[1]).toEqual({
      path: "Overview.md",
      text: `> ${overviewText}`,
    });

    await act(() => emit("world:index-changed", { session: 1 }));
    await waitFor(() => expect(callsOf(calls, "links_in")).toHaveLength(3));
  });

  it("are asked for again when the page reloads after an outside change", async () => {
    let onDisk = { text: overviewText, version: "o1" };
    const { calls } = await openOverview({ page_read: () => onDisk });
    await waitFor(() => expect(callsOf(calls, "links_in")).toHaveLength(1));

    onDisk = { text: "# Overview\n\n[[Saltmere]]\n", version: "o2" };
    await act(() => emit("world:changed", { session: 1, tree: false, pages: ["Overview.md"] }));

    await waitFor(() =>
      expect(callsOf(calls, "links_in").at(-1)).toEqual({ path: "Overview.md", text: onDisk.text }),
    );
  });
});

describe("following a link", () => {
  it("opens the linked page in a new tab at the heading, with focus", async () => {
    const { textbox } = await openOverview();

    await follow(textbox, "[[Kesh Tor#Shelter]]");

    const keshTor = await screen.findByRole("textbox", { name: "Kesh Tor" });
    expect(tabNames()).toEqual(["Overview", "Kesh Tor"]);
    await waitFor(() => expect(editorOf(keshTor).hasFocus).toBe(true));
    expect(editorOf(keshTor).state.selection.main.head).toBe(keshTorText.indexOf("## Shelter"));
  });

  it("activates the linked page's open tab instead of opening another", async () => {
    const { textbox } = await openOverview();
    act(() => useWorldStore.getState().openPage("Places/Kesh Tor.md", { newTab: true }));
    await screen.findByRole("textbox", { name: "Kesh Tor" });
    act(() => useWorldStore.getState().activate("Overview.md"));
    const overview = await screen.findByRole("textbox", { name: "Overview" });
    expect(overview).not.toBe(textbox);

    await follow(overview, "[[Kesh Tor#Shelter]]");

    await waitFor(() => expect(activeTab()).toBe("Kesh Tor"));
    expect(tabNames()).toEqual(["Overview", "Kesh Tor"]);
  });

  it("moves the cursor to a heading of the same page", async () => {
    const { textbox } = await openOverview();

    await follow(textbox, "[[#Rules]]");

    expect(editorOf(textbox).state.selection.main.head).toBe(overviewText.indexOf("## Rules"));
    expect(tabNames()).toEqual(["Overview"]);
  });

  it("does nothing for an attachment, and nothing while the index is being built", async () => {
    let answer = (text: string): EditorLinks => ({ state: "ready", links: linksOf(text) });
    const { calls, textbox } = await openOverview({ links_in: ({ text }) => answer(String(text)) });

    await follow(textbox, "![[map.png]]");
    answer = () => ({ state: "not_ready" });
    await act(() => emit("world:index-changed", { session: 1 }));
    await waitFor(() => expect(textbox.querySelector(".cm-link")).toBeNull());
    const view = editorOf(textbox);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("Salt") } }));
    fireEvent.keyDown(textbox, { key: "Enter", altKey: true });

    expect(tabNames()).toEqual(["Overview"]);
    expect(callsOf(calls, "link_create")).toEqual([]);
  });
});

describe("following an unresolved link", () => {
  it("saves the page, creates the linked page, lists it in the tree and opens it with focus", async () => {
    const { calls, textbox } = await openOverview({
      link_create: () => ({ state: "created", path: "Saltmere.md" }),
    });
    const view = editorOf(textbox);
    act(() => view.dispatch({ changes: { from: 0, insert: "> " }, userEvent: "input.type" }));
    const trees = callsOf(calls, "world_tree").length;

    await follow(textbox, "[[Saltmere]]");

    const created = await screen.findByRole("textbox", { name: "Saltmere" });
    await waitFor(() => expect(editorOf(created).hasFocus).toBe(true));
    expect(tabNames()).toEqual(["Overview", "Saltmere"]);
    expect(callsOf(calls, "link_create")).toEqual([{ from: "Overview.md", target: "Saltmere" }]);
    const commands = calls.map(({ command }) => command);
    const saved = commands.indexOf("page_write");
    expect(saved).not.toBe(-1);
    expect(saved).toBeLessThan(commands.indexOf("link_create"));
    expect(callsOf(calls, "world_tree").length).toBeGreaterThan(trees);
  });

  it("opens a page the link names by now in a new tab", async () => {
    const { textbox } = await openOverview({
      link_create: (): LinkedPage => ({ state: "existing", path: "Places/Kesh Tor.md" }),
    });

    await follow(textbox, "[[Saltmere]]");

    expect(await screen.findByRole("textbox", { name: "Kesh Tor" })).toBeInTheDocument();
    expect(tabNames()).toEqual(["Overview", "Kesh Tor"]);
  });

  it("does nothing while the index is being built", async () => {
    const { textbox } = await openOverview({
      link_create: (): LinkedPage => ({ state: "not_ready" }),
    });

    await follow(textbox, "[[Saltmere]]");

    await waitFor(() => expect(useWorldStore.getState().toasts).toEqual([]));
    expect(tabNames()).toEqual(["Overview"]);
  });

  it.each([
    ["invalid_name", "Names cannot contain [ ] # or ^, which break wiki links.", null],
    ["exists", "Something with this name already exists here. Letter case does not count.", null],
    ["invalid_path", "The path is not a valid page or folder path.", outsideWorldToast],
    ["io", "The disk is full.", "The page could not be created: The disk is full."],
  ])("shows why a %s refusal created nothing", async (kind, message, shown) => {
    const { textbox } = await openOverview({
      link_create: () => {
        throw { kind, message };
      },
    });

    await follow(textbox, "[[Saltmere]]");

    expect(await within(screen.getByRole("status")).findByText(shown ?? message)).toBeVisible();
    expect(tabNames()).toEqual(["Overview"]);
  });

  it("lists the tree again after a failure, which can leave folders it created", async () => {
    const { calls, textbox } = await openOverview({
      link_create: () => {
        throw { kind: "io", message: "The disk is full." };
      },
    });
    const trees = callsOf(calls, "world_tree").length;

    await follow(textbox, "[[Saltmere]]");

    const toast = "The page could not be created: The disk is full.";
    expect(await within(screen.getByRole("status")).findByText(toast)).toBeVisible();
    await waitFor(() => expect(callsOf(calls, "world_tree").length).toBeGreaterThan(trees));
  });

  it("shows the missing-world notice when the world's folder is gone", async () => {
    const { textbox } = await openOverview({
      link_create: () => {
        throw { kind: "world_missing", message: "The world's folder cannot be found." };
      },
    });

    await follow(textbox, "[[Saltmere]]");

    expect(await screen.findByText("The world's folder cannot be found.")).toBeInTheDocument();
    expect(tabNames()).toEqual(["Overview"]);
  });
});
