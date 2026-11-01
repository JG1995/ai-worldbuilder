import { completionStatus } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkSuggestion, LinkSuggestions } from "@/types/api";
import { mockWorldIpc } from "../api/test-ipc";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";

const mirela: LinkSuggestion = {
  path: "People/Mirela.md",
  name: "Mirela",
  alias: null,
  insert: "Mirela",
};
const captain: LinkSuggestion = {
  path: "Mira.md",
  name: "Mira",
  alias: "the captain",
  insert: "Mira|the captain",
};

type Handler = Parameters<typeof mockWorldIpc>[0];

/** Opens the test world's Overview page, whose text is "See " with the cursor at its end. */
async function openOverview(overrides: Handler = {}) {
  const calls = mockWorldIpc({
    page_read: () => ({ text: "See ", version: "o1" }),
    link_suggest: (): LinkSuggestions => ({ indexing: false, items: [mirela, captain] }),
    ...overrides,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <World />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "Overview" }));
  const textbox = await screen.findByRole("textbox", { name: "Overview" });
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  return { calls, textbox, view };
}

function editorOf(textbox: HTMLElement) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  return view;
}

/** Types `text` at the cursor, as the keyboard does. */
function type(view: EditorView, text: string) {
  const at = view.state.selection.main.head;
  act(() =>
    view.dispatch({
      changes: { from: at, insert: text },
      selection: { anchor: at + text.length },
      userEvent: "input.type",
    }),
  );
}

/**
 * Waits for the list with options named `names`. The list then takes keys at once: it ignores
 * keys for its first 75 ms, so a quick Enter after typing does not pick by accident.
 */
async function listOf(...names: RegExp[]) {
  const list = await screen.findByRole("listbox");
  await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(names.length));
  for (const [at, option] of within(list).getAllByRole("option").entries()) {
    expect(option).toHaveTextContent(names[at]);
  }
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 1_000);
  return list;
}

const suggestCalls = (calls: { command: string; args?: unknown }[]) =>
  calls.filter((call) => call.command === "link_suggest").map(({ args }) => args);

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
  // jsdom has no layout for text, which the editor measures to place the list and the cursor.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the link suggestion list", () => {
  it("lists the core's suggestions for the typed text, with folder and alias, for screen readers", async () => {
    const { calls, textbox, view } = await openOverview();

    type(view, "[[Mi");

    const list = await listOf(/^Mirela\s*People$/, /^Mira\s*alias: the captain$/);
    expect(suggestCalls(calls)).toContainEqual({ from: "Overview.md", query: "Mi" });
    const [first] = within(list).getAllByRole("option");
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(textbox).toHaveAttribute("aria-activedescendant", first.id);
  });

  it.each([
    ["Enter", (textbox: HTMLElement) => fireEvent.keyDown(textbox, { key: "Enter" })],
    ["Tab", (textbox: HTMLElement) => fireEvent.keyDown(textbox, { key: "Tab" })],
    ["a click", () => fireEvent.mouseDown(screen.getAllByRole("option")[0])],
  ])("inserts the selected page's link on %s", async (_how, pick) => {
    const { textbox, view } = await openOverview();
    type(view, "[[Mi");
    await listOf(/^Mirela/, /^Mira/);

    pick(textbox);

    expect(view.state.doc.toString()).toBe("See [[Mirela]]");
    expect(view.state.selection.main.head).toBe("See [[Mirela]]".length);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("moves the selection with Up and Down, and inserts an alias's link", async () => {
    const { textbox, view } = await openOverview();
    type(view, "![[Mi");
    const list = await listOf(/^Mirela/, /^Mira/);
    const [first, second] = within(list).getAllByRole("option");

    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(textbox).toHaveAttribute("aria-activedescendant", second.id);
    fireEvent.keyDown(textbox, { key: "ArrowUp" });
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textbox, { key: "ArrowDown" });
    fireEvent.keyDown(textbox, { key: "Enter" });

    expect(view.state.doc.toString()).toBe("See ![[Mira|the captain]]");
  });

  it("closes on Escape and leaves the text as typed", async () => {
    const { textbox, view } = await openOverview();
    type(view, "[[Mi");
    await listOf(/^Mirela/, /^Mira/);

    fireEvent.keyDown(textbox, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(view.state.doc.toString()).toBe("See [[Mi");
  });

  it("says when no page matches, and Enter then only closes the list", async () => {
    const { textbox, view } = await openOverview({
      link_suggest: (): LinkSuggestions => ({ indexing: false, items: [] }),
    });
    type(view, "[[Zz");
    await listOf(/^No page matches$/);

    fireEvent.keyDown(textbox, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(view.state.doc.toString()).toBe("See [[Zz");
  });

  it("shows Indexing world… while the index is built, and drops it once the index changes", async () => {
    let indexing = true;
    const { calls, view } = await openOverview({
      link_suggest: (): LinkSuggestions => ({ indexing, items: [mirela] }),
    });
    type(view, "[[Mi");
    await listOf(/^Mirela/);
    expect(screen.getByText("Indexing world…")).toBeInTheDocument();
    const asked = suggestCalls(calls).length;

    indexing = false;
    await act(() => emit("world:index-changed", { session: 1 }));

    await waitFor(() => expect(screen.queryByText("Indexing world…")).toBeNull());
    expect(suggestCalls(calls)).toHaveLength(asked + 1);
    expect(screen.getByRole("option")).toHaveTextContent(/^Mirela/);
  });

  it("keeps the selected row when the index changes while the list is open", async () => {
    let indexing = true;
    const { textbox, view } = await openOverview({
      link_suggest: (): LinkSuggestions => ({ indexing, items: [mirela, captain] }),
    });
    type(view, "[[Mi");
    await listOf(/^Mirela/, /^Mira/);
    fireEvent.keyDown(textbox, { key: "ArrowDown" });

    indexing = false;
    await act(() => emit("world:index-changed", { session: 1 }));
    await waitFor(() => expect(screen.queryByText("Indexing world…")).toBeNull());

    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("See [[Mira|the captain]]");
  });

  it("closes when the tab changes by keyboard, and stays closed when the tab comes back", async () => {
    await openOverview();
    fireEvent.click(screen.getByRole("treeitem", { name: "Places" }));
    fireEvent.click(await screen.findByRole("treeitem", { name: "Kesh Tor" }), { ctrlKey: true });
    await screen.findByRole("textbox", { name: "Kesh Tor" });
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    const overview = await screen.findByRole("textbox", { name: "Overview" });
    type(editorOf(overview), "[[Mi");
    await listOf(/^Mirela/, /^Mira/);

    // Ctrl+Tab leaves the focus in the editor until the tab changes, so the list never blurs.
    fireEvent.keyDown(overview, { key: "Tab", ctrlKey: true });
    await screen.findByRole("textbox", { name: "Kesh Tor" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    const textbox = await screen.findByRole("textbox", { name: "Overview" });
    const view = editorOf(textbox);

    expect(completionStatus(view.state)).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("See [[Mi\n");
  });
});
