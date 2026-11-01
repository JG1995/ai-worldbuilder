import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backlinks } from "@/types/api";
import { mockWorldIpc } from "../api/test-ipc";
import { useWorldStore } from "../stores/world-store";
import { World } from "./World";

const keshTorText = "# Kesh Tor\n\nThe road from [[Overview]] ends here.\n";
const linkAt = keshTorText.indexOf("[[");

/** Overview's backlinks: Kesh Tor links to it. */
const linked: Backlinks = {
  state: "ready",
  pages: [
    {
      path: "Places/Kesh Tor.md",
      name: "Kesh Tor",
      line: "The road from [[Overview]] ends here.",
      at: linkAt,
    },
  ],
};

type Handler = Parameters<typeof mockWorldIpc>[0];

/** Opens the test world and its Overview page, whose backlinks the core answers with `answer`. */
async function openOverview(answer: () => Backlinks, overrides: Handler = {}) {
  const calls = mockWorldIpc({
    backlinks_list: answer,
    page_read: ({ path }) =>
      path === "Places/Kesh Tor.md"
        ? { text: keshTorText, version: "k1" }
        : { text: "# Overview\n", version: "o1" },
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
  return calls;
}

const section = () => screen.findByRole("region", { name: /Linked from/ });
const backlinkCalls = (calls: { command: string; args?: unknown }[]) =>
  calls.filter(({ command }) => command === "backlinks_list").map(({ args }) => args);
const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

function editorOf(textbox: HTMLElement) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  return view;
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

describe("the backlinks section", () => {
  it("shows below the page and asks again when the index changes", async () => {
    let answer: Backlinks = { state: "building" };
    const calls = await openOverview(() => answer);
    expect(await section()).toHaveTextContent("Indexing world…");
    expect(backlinkCalls(calls)).toEqual([{ path: "Overview.md" }]);

    answer = linked;
    await act(() => emit("world:index-changed", { session: 1 }));

    const rows = within(await section()).findAllByRole("button");
    expect(await rows).toHaveLength(1);
    expect(backlinkCalls(calls)).toHaveLength(2);
  });

  it("hides while the History view shows", async () => {
    await openOverview(() => linked, { history_list: () => [] });
    await section();

    act(() => useWorldStore.getState().showHistory("Overview.md"));

    await screen.findByRole("region", { name: "History" });
    expect(screen.queryByRole("region", { name: /Linked from/ })).not.toBeInTheDocument();
  });

  it("shows for a page that is not UTF-8", async () => {
    await openOverview(() => linked, {
      page_read: () => {
        throw { kind: "not_utf8", message: "The page is not UTF-8 text." };
      },
    });

    expect(await section()).toHaveTextContent("Kesh Tor");
  });
});

describe("a backlink row", () => {
  it("opens its page in the current tab with the cursor at the link and focus in the editor", async () => {
    await openOverview(() => linked);
    const row = within(await section()).getByRole("button", { name: /Kesh Tor/ });

    fireEvent.click(row);

    const textbox = await screen.findByRole("textbox", { name: "Kesh Tor" });
    expect(tabNames()).toEqual(["Kesh Tor"]);
    await waitFor(() => expect(editorOf(textbox).hasFocus).toBe(true));
    expect(editorOf(textbox).state.selection.main.head).toBe(linkAt);
  });

  it("opens its page in a new tab with Ctrl/Cmd+click", async () => {
    await openOverview(() => linked);
    const row = within(await section()).getByRole("button", { name: /Kesh Tor/ });

    fireEvent.click(row, { ctrlKey: true });

    const textbox = await screen.findByRole("textbox", { name: "Kesh Tor" });
    expect(tabNames()).toEqual(["Overview", "Kesh Tor"]);
    await waitFor(() => expect(editorOf(textbox).state.selection.main.head).toBe(linkAt));
  });
});
