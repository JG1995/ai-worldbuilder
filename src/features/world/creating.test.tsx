import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeEntry } from "../../ui/FileTree";
import { useWorldStore } from "./store";
import { mockWorldIpc, testTree, testWorld } from "./test-ipc";
import { World } from "./World";

function renderWorld() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <World />
    </QueryClientProvider>,
  );
}

/** A core whose tree lists the test tree plus the entries it has created since. */
function mockCreatingIpc(overrides: Parameters<typeof mockWorldIpc>[0] = {}) {
  const created: TreeEntry[] = [];
  const calls = mockWorldIpc({
    world_tree: () =>
      testTree.map((entry) =>
        entry.path === "Places"
          ? { ...entry, children: [...created, ...(entry.children ?? [])] }
          : entry,
      ),
    page_create: ({ folder, name }) => {
      const path = `${String(folder)}/${String(name)}.md`;
      created.push({ path, name: String(name), kind: "page" });
      return { path };
    },
    folder_create: ({ folder, name }) => {
      const path = `${String(folder)}/${String(name)}`;
      created.push({ path, name: String(name), kind: "folder", children: [] });
      return { path };
    },
    ...overrides,
  });
  return calls;
}

async function openTestWorld() {
  renderWorld();
  fireEvent.click(screen.getByRole("button", { name: "Open world…" }));
  return screen.findByRole("tree", { name: testWorld.name });
}

const row = (name: string) => screen.getByRole("treeitem", { name });
const pageNameInput = () => screen.findByRole("textbox", { name: "New page name" });

function rightClick(element: HTMLElement) {
  fireEvent.contextMenu(element, { clientX: 10, clientY: 10 });
}

function submit(input: HTMLElement, name: string) {
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function pressShortcut(key: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ctrlKey: true, ...init });
}

const createCalls = (calls: { command: string; args?: unknown }[]) =>
  calls
    .filter(({ command }) => command.endsWith("_create"))
    .map(({ command, args }) => ({
      command,
      args,
    }));

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

describe("creating pages and folders", () => {
  it("creates a page in the right-clicked folder and opens it in a new tab with the editor focused", async () => {
    const calls = mockCreatingIpc();
    await openTestWorld();
    fireEvent.click(row("Overview"));
    await screen.findByRole("textbox", { name: "Overview" });

    rightClick(row("Places"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /New page/ }));
    submit(await pageNameInput(), "Kesh Harbour");

    const editor = await screen.findByRole("textbox", { name: "Kesh Harbour" });
    await waitFor(() => expect(editor).toHaveFocus());
    expect(createCalls(calls)).toEqual([
      { command: "page_create", args: { folder: "Places", name: "Kesh Harbour" } },
    ]);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Kesh Harbour",
    ]);
    expect(row("Kesh Harbour")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("textbox", { name: "New page name" })).not.toBeInTheDocument();
  });

  it("keeps focus in the tree when an existing page opens from it", async () => {
    mockCreatingIpc();
    await openTestWorld();
    act(() => row("Overview").focus());

    fireEvent.keyDown(row("Overview"), { key: "Enter" });

    await screen.findByRole("textbox", { name: "Overview" });
    expect(row("Overview")).toHaveFocus();
  });

  it("keeps the name input open with the rule an invalid name breaks", async () => {
    mockCreatingIpc({
      page_create: () => {
        throw { kind: "invalid_name", message: "Names cannot contain [ ] # or ^." };
      },
    });
    await openTestWorld();

    // The page region's New page, shown while no page is open.
    const noPage = screen.getByText("No page is open.").parentElement as HTMLElement;
    fireEvent.click(within(noPage).getByRole("button", { name: "New page" }));
    const input = await pageNameInput();
    submit(input, "[[Kesh]]");

    await waitFor(() =>
      expect(input).toHaveAccessibleDescription("Names cannot contain [ ] # or ^."),
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("cancels on Escape and creates nothing", async () => {
    const calls = mockCreatingIpc();
    await openTestWorld();
    const header = screen.getByRole("button", { name: "New page", description: "New page Ctrl+N" });
    fireEvent.click(header);

    fireEvent.keyDown(await pageNameInput(), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "New page name" })).not.toBeInTheDocument();
    expect(createCalls(calls)).toEqual([]);
  });

  it("creates a folder with Ctrl+Shift+N in the selected folder, then expands and selects it", async () => {
    const calls = mockCreatingIpc();
    await openTestWorld();
    fireEvent.click(row("Places"));

    pressShortcut("N", { shiftKey: true });
    submit(await screen.findByRole("textbox", { name: "New folder name" }), "Coast");

    const folder = await screen.findByRole("treeitem", { name: "Coast" });
    expect(createCalls(calls)).toEqual([
      { command: "folder_create", args: { folder: "Places", name: "Coast" } },
    ]);
    expect(folder).toHaveAttribute("aria-expanded", "true");
    expect(folder).toHaveAttribute("aria-selected", "true");
  });

  it("starts a page at the world's top level with Ctrl+N when nothing is selected", async () => {
    const calls = mockCreatingIpc({ page_create: ({ name }) => ({ path: `${String(name)}.md` }) });
    await openTestWorld();

    pressShortcut("n");
    submit(await pageNameInput(), "Gazetteer");

    await screen.findByRole("textbox", { name: "Gazetteer" });
    expect(createCalls(calls)).toEqual([
      { command: "page_create", args: { folder: null, name: "Gazetteer" } },
    ]);
  });

  it("ignores the shortcuts inside a dialog", async () => {
    mockCreatingIpc();
    await openTestWorld();
    fireEvent.click(screen.getByRole("button", { name: "World menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "New world…" }));
    const dialog = await screen.findByRole("dialog", { name: "New world" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveFocus();

    pressShortcut("n");
    pressShortcut("N", { shiftKey: true });

    expect(screen.queryByRole("textbox", { name: "New page name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New folder name" })).not.toBeInTheDocument();
  });
});
