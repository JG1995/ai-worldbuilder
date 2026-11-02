import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TreeEntry } from "@/types/api";
import { mockWorldIpc, shellLayout, testTree, testWorld } from "../api/test-ipc";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";
import type { AssistantPorts, WorldScreenParts } from "./WorldScreen";

type Handler = Parameters<typeof mockWorldIpc>[0];

/** The ports the world's screen handed to its layout last. */
let ports: AssistantPorts;

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

const textOf = (textbox: HTMLElement) => editorOf(textbox).state.doc.toString();
const tab = (name: string) => screen.getByRole("tab", { name });
const row = (name: string) => screen.getByRole("treeitem", { name });
const flashingRows = () =>
  screen.getAllByRole("treeitem").filter((item) => item.classList.contains("tree-flash"));

/**
 * Opens the test world with Kesh Tor and Overview in tabs, both read, Overview active and the
 * Places folder expanded. Returns the calls and Overview's editor.
 */
async function openWorld(overrides: Handler = {}) {
  const calls = mockWorldIpc({
    world_open: () => ({
      ...testWorld,
      workspace: {
        ...testWorld.workspace,
        tabs: ["Places/Kesh Tor.md", "Overview.md"],
        active: "Places/Kesh Tor.md",
        expanded: ["Places"],
      },
    }),
    ...overrides,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const layout = (parts: WorldScreenParts) => {
    ports = parts.assistantPorts;
    return shellLayout(parts);
  };
  render(
    <QueryClientProvider client={client}>
      <World layout={layout} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  await screen.findByRole("textbox", { name: "Kesh Tor" });
  fireEvent.click(tab("Overview"));
  const textbox = await screen.findByRole("textbox", { name: "Overview" });
  return { calls, textbox };
}

const countOf = (calls: { command: string }[], command: string) =>
  calls.filter((call) => call.command === command).length;

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

it("flushPages saves an open page's edits first, and reports a save that failed", async () => {
  let failing = false;
  const { calls, textbox } = await openWorld({
    page_write: ({ path, text }) => {
      if (failing) throw { kind: "io", message: "The disk is full." };
      return { version: `version of ${String(path)} saved as ${String(text)}` };
    },
  });
  typeAtEnd(textbox, "Mine");

  expect(await ports.flushPages(["Overview.md", "Places/Saltmere.md"])).toBe(true);
  expect(calls.filter(({ command }) => command === "page_write").map(({ args }) => args)).toEqual([
    {
      path: "Overview.md",
      text: "# Overview\nMine",
      version: "version of Overview.md",
      keepMine: false,
    },
  ]);

  failing = true;
  typeAtEnd(textbox, " again");
  let flushed: boolean | undefined;
  await act(async () => {
    flushed = await ports.flushPages(["Overview.md"]);
  });
  expect(flushed).toBe(false);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This page could not be saved: The disk is full.",
  );
});

it("pagesWritten puts written text in open tabs as one undoable step, refreshes the tree, and flashes rows only when asked", async () => {
  let tree: TreeEntry[] = testTree;
  const { calls, textbox } = await openWorld({ world_tree: () => tree });
  const saltmere = { path: "Places/Saltmere.md", name: "Saltmere", kind: "page" } as const;
  tree = [{ ...testTree[0], children: [...(testTree[0].children ?? []), saltmere] }, testTree[1]];
  const listings = countOf(calls, "world_tree");

  await act(() =>
    ports.pagesWritten(
      [
        { path: "Overview.md", text: "# Overview\nAccepted\n", version: "accepted" },
        { path: "Places/Kesh Tor.md", text: "# Kesh Tor\nAccepted\n", version: "accepted" },
        { path: "Places/Saltmere.md", text: "# Saltmere\n", version: "new" },
      ],
      { flash: true },
    ),
  );

  expect(countOf(calls, "world_tree")).toBe(listings + 1);
  expect(flashingRows()).toEqual([row("Kesh Tor"), row("Saltmere"), row("Overview")]);
  expect(textOf(textbox)).toBe("# Overview\nAccepted\n");
  // The written text is the saved text, so there is nothing to save.
  expect(await ports.flushPages(["Overview.md"])).toBe(true);
  expect(countOf(calls, "page_write")).toBe(0);
  undo(editorOf(textbox));
  expect(textOf(textbox)).toBe("# Overview\n");
  fireEvent.click(tab("Kesh Tor"));
  expect(textOf(await screen.findByRole("textbox", { name: "Kesh Tor" }))).toBe(
    "# Kesh Tor\nAccepted\n",
  );

  // jsdom has no AnimationEvent, so React listens for the prefixed name there.
  fireEvent(row("Saltmere"), new Event("webkitAnimationEnd", { bubbles: true }));
  await act(() =>
    ports.pagesWritten([{ path: "Overview.md", text: "# Overview\n", version: "undone" }], {
      flash: false,
    }),
  );
  expect(flashingRows()).toEqual([]);
});

it("pagesDeleted closes a deleted page's clean tab and keeps one with unsaved text", async () => {
  const { calls, textbox } = await openWorld();
  const listings = countOf(calls, "world_tree");
  typeAtEnd(textbox, "Typed after the undo");

  await act(() => ports.pagesDeleted(["Overview.md", "Places/Kesh Tor.md"]));

  expect(screen.queryByRole("tab", { name: "Kesh Tor" })).not.toBeInTheDocument();
  expect(tab("Overview")).toBeInTheDocument();
  expect(textOf(textbox)).toBe("# Overview\nTyped after the undo");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This page was deleted or moved outside Grimoire.md.",
  );
  expect(countOf(calls, "world_tree")).toBe(listings + 1);
  expect(countOf(calls, "page_write")).toBe(0);
});

it("showToast shows a toast in the world whose action runs once", async () => {
  await openWorld();
  const run = vi.fn();

  act(() => ports.showToast("Accepted 1 change", { label: "Undo", run }));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

  expect(run).toHaveBeenCalledOnce();
  expect(screen.queryByText("Accepted 1 change")).not.toBeInTheDocument();
});

it("setReviewPaths shows the review dot on those pages' tabs only", async () => {
  await openWorld();

  act(() => ports.setReviewPaths(["Overview.md"]));

  await waitFor(() =>
    expect(tab("Overview")).toHaveAccessibleDescription("Changes waiting for review"),
  );
  expect(tab("Kesh Tor")).toHaveAccessibleDescription("");
  act(() => ports.setReviewPaths([]));
  expect(tab("Overview")).toHaveAccessibleDescription("");
});
