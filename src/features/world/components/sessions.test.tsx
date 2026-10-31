import { EditorView } from "@codemirror/view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentWorld, WorldOpened } from "@/types/api";
import { closeRequestedEvent } from "../api/commands";
import { mockWorldIpc, testWorld } from "../api/test-ipc";
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

const commandsOf = (calls: { command: string }[]) => calls.map(({ command }) => command);
const argsOf = (calls: { command: string; args?: unknown }[], command: string) =>
  calls.filter((call) => call.command === command).map(({ args }) => args);

function typeAtEnd(textbox: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(textbox);
  if (!view) throw new Error("No editor");
  view.dispatch({
    changes: { from: view.state.doc.length, insert: text },
    userEvent: "input.type",
  });
}

/** Opens the test world from the welcome screen, and returns its Overview page's editor. */
async function openOverview() {
  renderWorld();
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "Overview" }));
  return screen.findByRole("textbox", { name: "Overview" });
}

const failingWrite = () => {
  throw { kind: "io", message: "Another program is using the file." };
};

// jsdom does not enforce `inert`, so the tests check that it is set; browsers then refuse input.
const isInert = (element: HTMLElement) => element.closest("[inert]") !== null;

const recentWorlds: RecentWorld[] = [
  { id: "1", name: "Kesh", path: "/home/tester/Worlds/Kesh", missing: false },
  { id: "2", name: "Saltmere", path: "/home/tester/Worlds/Saltmere", missing: true },
];

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

describe("launching", () => {
  it("reopens the last world with its tabs, active tab, expanded folders and tree width, reading only the active page", async () => {
    const restored: WorldOpened = {
      ...testWorld,
      workspace: {
        tabs: ["Overview.md", "Places/Kesh Tor.md", "Places/Mirror lake.md"],
        active: "Places/Kesh Tor.md",
        expanded: ["Places"],
        treeWidth: 320,
      },
    };
    const calls = mockWorldIpc({ world_restore: () => restored });

    renderWorld();

    expect(await screen.findByRole("textbox", { name: "Kesh Tor" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Kesh Tor",
      "Mirror lake",
    ]);
    expect(screen.getByRole("tab", { name: "Kesh Tor" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("treeitem", { name: "Places" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("separator", { name: "File tree width" })).toHaveAttribute(
      "aria-valuenow",
      "320",
    );
    expect(argsOf(calls, "page_read")).toEqual([{ path: "Places/Kesh Tor.md" }]);
    expect(screen.queryByRole("button", { name: "Open world…" })).not.toBeInTheDocument();
  });

  it("restores once per page load though StrictMode runs the launch twice, so the world's events count", async () => {
    let restores = 0;
    const calls = mockWorldIpc({
      world_restore: (): WorldOpened => ({ ...testWorld, session: ++restores }),
    });

    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <World />
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(await screen.findByRole("tree", { name: testWorld.name })).toBeInTheDocument();
    await act(() => emit("world:watch-failed", { session: 1, message: "Too many watches." }));

    expect(
      await screen.findByText("Outside changes may not appear until the world is reopened."),
    ).toBeInTheDocument();
    expect(commandsOf(calls).filter((command) => command === "world_restore")).toHaveLength(1);
  });

  it('shows "No worlds yet." when nothing is stored', async () => {
    mockWorldIpc();

    renderWorld();

    expect(await screen.findByText("No worlds yet.")).toBeInTheDocument();
  });
});

describe("recent worlds on the welcome screen", () => {
  it("are listed with a missing one marked Not found, which Remove takes off the list", async () => {
    let listed = recentWorlds;
    const calls = mockWorldIpc({
      recent_list: () => listed,
      recent_remove: ({ id }) => {
        listed = listed.filter((world) => world.id !== id);
        return null;
      },
    });
    renderWorld();

    const missing = (await screen.findByRole("button", { name: /Saltmere/ })).closest("li");
    if (!missing) throw new Error("No list item");
    expect(missing).toHaveTextContent("Not found");
    expect(screen.getByRole("button", { name: /Kesh/ }).closest("li")).not.toHaveTextContent(
      "Not found",
    );
    fireEvent.click(within(missing).getByRole("button", { name: "Remove" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Saltmere/ })).not.toBeInTheDocument(),
    );
    expect(argsOf(calls, "recent_remove")).toEqual([{ id: "2" }]);
  });

  it("open when chosen", async () => {
    const calls = mockWorldIpc({ recent_list: () => recentWorlds });
    renderWorld();

    fireEvent.click(await screen.findByRole("button", { name: /Kesh/ }));

    expect(await screen.findByRole("tree", { name: testWorld.name })).toBeInTheDocument();
    expect(argsOf(calls, "world_open_recent")).toEqual([{ id: "1" }]);
  });

  it("explain a world whose folder cannot be found", async () => {
    mockWorldIpc({
      recent_list: () => recentWorlds,
      world_open_recent: () => {
        throw { kind: "world_missing", message: "The world's folder cannot be found." };
      },
    });
    renderWorld();

    fireEvent.click(await screen.findByRole("button", { name: /Saltmere/ }));

    const dialog = await screen.findByRole("dialog", { name: "The world cannot be opened" });
    expect(dialog).toHaveTextContent("The world's folder cannot be found.");
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open world…" })).toBeInTheDocument();
  });
});

describe("switching from the world menu", () => {
  it("lists the recent worlds, and saves pages and the workspace before the chosen one opens", async () => {
    const calls = mockWorldIpc({
      // The core leaves the open world out.
      recent_list: () => [{ ...recentWorlds[1], missing: false }],
      world_open_recent: (): WorldOpened => ({ ...testWorld, name: "Saltmere", session: 2 }),
    });
    typeAtEnd(await openOverview(), "More");

    fireEvent.click(screen.getByRole("button", { name: "World menu" }));
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim()),
    ).toEqual(["Saltmere", "Open world…", "New world…", "Close world"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Saltmere" }));

    expect(await screen.findByRole("heading", { name: "Saltmere" })).toBeInTheDocument();
    const commands = commandsOf(calls);
    expect(
      commands.slice(commands.indexOf("page_write"), commands.indexOf("world_open_recent") + 1),
    ).toEqual(["page_write", "workspace_save", "world_open_recent"]);
    expect(argsOf(calls, "workspace_save").at(-1)).toEqual({
      workspace: { tabs: ["Overview.md"], active: "Overview.md", expanded: [], treeWidth: 264 },
    });
  });
});

describe("closing the window", () => {
  const requestClose = () => act(() => emit(closeRequestedEvent));

  it("saves every page and the workspace, then closes", async () => {
    const calls = mockWorldIpc();
    typeAtEnd(await openOverview(), "More");

    await requestClose();

    await waitFor(() => expect(commandsOf(calls)).toContain("app_close"));
    const commands = commandsOf(calls);
    expect(commands.slice(commands.indexOf("page_write"))).toEqual([
      "page_write",
      "workspace_save",
      "app_close",
    ]);
  });

  it("asks about a page that cannot save, takes no edits meanwhile, and closes only after a choice other than Cancel", async () => {
    const calls = mockWorldIpc({ page_write: failingWrite });
    const textbox = await openOverview();
    typeAtEnd(textbox, "More");

    await requestClose();
    const asked = await screen.findByRole("dialog", { name: '"Overview" could not be saved' });
    expect(textbox).toHaveAttribute("aria-readonly", "true");
    expect(isInert(screen.getByRole("tree"))).toBe(true);
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(textbox).not.toHaveAttribute("aria-readonly"));
    expect(isInert(textbox)).toBe(false);
    expect(commandsOf(calls)).not.toContain("app_close");

    await requestClose();
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: '"Overview" could not be saved' }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() => expect(commandsOf(calls)).toContain("app_close"));
  });

  it("asks about a page only after the dialog of its closing tab is answered, so one dialog shows at once", async () => {
    const calls = mockWorldIpc({ page_write: failingWrite });
    typeAtEnd(await openOverview(), "More");
    fireEvent.click(screen.getByRole("button", { name: "Close Overview" }));
    const asked = await screen.findByRole("dialog", { name: '"Overview" could not be saved' });

    await requestClose();
    // Every command answers within the current task, so a second dialog would show by the next.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getAllByRole("dialog")).toEqual([asked]);
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: '"Overview" could not be saved' }),
      ).getByRole("button", { name: "Discard changes" }),
    );
    await waitFor(() => expect(commandsOf(calls)).toContain("app_close"));
  });
});
