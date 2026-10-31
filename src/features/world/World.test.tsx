import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorldStore } from "./store";
import { mockWorldIpc, testWorld } from "./test-ipc";
import { World } from "./World";

function renderWorld() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <World />
    </QueryClientProvider>,
  );
}

const openWorldButton = () => screen.getByRole("button", { name: "Open world…" });
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

    fireEvent.click(openWorldButton());

    const entries = await tree();
    expect(screen.getByRole("heading", { name: testWorld.name })).toBeInTheDocument();
    expect(within(entries).getByRole("treeitem", { name: "Places" })).toBeInTheDocument();
    expect(within(entries).getByRole("treeitem", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByText("No page is open.")).toBeInTheDocument();
  });

  it("changes nothing when the folder dialog is cancelled", async () => {
    const calls = mockWorldIpc({ world_open: () => null });
    renderWorld();

    await act(async () => fireEvent.click(openWorldButton()));

    expect(openWorldButton()).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.map(({ command }) => command)).toEqual(["world_open"]);
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
    fireEvent.click(openWorldButton());
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
    fireEvent.click(openWorldButton());
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
    fireEvent.click(openWorldButton());
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
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("No page is open.")).toBeInTheDocument();
  });

  it("shows a readable page in a read-only editor under its title", async () => {
    mockWorldIpc();

    await openPage("Overview");

    expect(await screen.findByRole("textbox", { name: "Overview" })).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
  });
});
