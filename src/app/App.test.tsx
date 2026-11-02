import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerChannel } from "@/features/assistant/api/test-ipc";
import { mockWorldIpc, testWorld } from "@/features/world/api/test-ipc";
import { useWorldStore } from "@/features/world/stores/world-store";
import type { AnswerEvent } from "@/types/api";
import { App } from "./App";

it("launches on the welcome screen when the core has no world to reopen", async () => {
  const calls = mockWorldIpc();

  render(<App />);

  expect(await screen.findByRole("button", { name: "Open world…" })).toBeInTheDocument();
  expect(screen.getByText("No worlds yet.")).toBeInTheDocument();
  expect(calls.map(({ command }) => command)).toEqual(["world_restore", "recent_list"]);
});

it("opens Settings with Ctrl+, and Escape closes it, returning focus", async () => {
  mockWorldIpc({ settings_get: () => ({ ai: true, textProvider: null }) });
  render(<App />);
  const openWorld = await screen.findByRole("button", { name: "Open world…" });
  act(() => openWorld.focus());

  fireEvent.keyDown(openWorld, { key: ",", ctrlKey: true });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(settings).getByRole("switch", { name: "AI features" })).toHaveFocus();
  fireEvent.keyDown(settings, { key: "Escape" });

  expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  expect(openWorld).toHaveFocus();
});

it("opens a page from quick open: Ctrl+O, typing part of its name and Enter", async () => {
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
  const calls = mockWorldIpc({
    search_pages: () => ({
      state: "ready",
      pages: [
        {
          path: "Places/Kesh Tor.md",
          name: "Kesh Tor",
          field: "name",
          alias: null,
          mark: { from: 0, to: 4 },
        },
      ],
    }),
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
  await screen.findByRole("tree");

  fireEvent.keyDown(document.body, { key: "o", ctrlKey: true });
  const query = await screen.findByRole("combobox", { name: "Search pages" });
  fireEvent.change(query, { target: { value: "kesh" } });
  await screen.findByRole("option", { name: /^Kesh Tor/ });
  fireEvent.keyDown(query, { key: "Enter" });

  const editor = await screen.findByRole("textbox", { name: "Kesh Tor" });
  await waitFor(() => expect(editor).toHaveFocus());
  expect(screen.queryByRole("dialog", { name: "Search pages" })).not.toBeInTheDocument();
  expect(calls).toContainEqual({ command: "search_pages", args: { query: "kesh" } });
});

describe("the assistant", () => {
  beforeEach(() => {
    useWorldStore.getState().closed();
    // jsdom has no layout: the shell lays out as at 1280px and wider.
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

  /** Opens the test world, with its assistant's side pane closed, under these settings. */
  async function openWorld(
    settings: () => unknown,
    overrides: Record<string, (args: Record<string, unknown>) => unknown> = {},
  ) {
    const calls = mockWorldIpc({
      ...overrides,
      settings_get: settings,
      world_open: () => ({
        ...testWorld,
        workspace: { ...testWorld.workspace, assistantOpen: false },
      }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open world…" }));
    await screen.findByRole("tree");
    await waitFor(() => expect(calls.map(({ command }) => command)).toContain("settings_get"));
    return calls;
  }

  const withProvider = () => ({
    ai: true,
    textProvider: {
      baseUrl: "https://api.example.com/v1",
      model: "mistral-small",
      key: "none",
      host: "api.example.com",
    },
  });

  const pressShortcut = () =>
    fireEvent.keyDown(document.body, { key: "A", ctrlKey: true, shiftKey: true });

  it("has a button with AI on, and Ctrl+Shift+A opens its pane with focus inside", async () => {
    await openWorld(() => ({ ai: true, textProvider: null }));

    const button = await screen.findByRole("button", { name: "Assistant" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    pressShortcut();

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Assistant" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("has no button, no pane and no shortcut with AI off", async () => {
    await openWorld(() => ({ ai: false, textProvider: null }));
    await act(() => Promise.resolve());

    // An uncancelled shortcut is left to the webview.
    expect(pressShortcut()).toBe(true);
    expect(screen.queryByRole("button", { name: "Assistant" })).not.toBeInTheDocument();
    // Only the file tree's pane.
    expect(screen.getAllByRole("complementary", { hidden: true })).toHaveLength(1);
  });

  it("focuses the composer when the pane opens with a provider saved", async () => {
    await openWorld(withProvider);

    fireEvent.click(await screen.findByRole("button", { name: "Assistant" }));

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("keeps a streaming answer and Stop while the pane is closed and opened again", async () => {
    let send: (event: AnswerEvent) => void = () => {};
    await openWorld(withProvider, {
      assistant_send: (args) => {
        send = answerChannel(args);
        return new Promise(() => {});
      },
    });
    const button = await screen.findByRole("button", { name: "Assistant" });
    fireEvent.click(button);
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "Who lives at Kesh Tor?" } });
    fireEvent.keyDown(message, { key: "Enter" });
    await screen.findByRole("button", { name: "Stop" });
    act(() => send({ kind: "context", conversation: 1, pages: [], leftOut: 0 }));
    act(() => send({ kind: "text", delta: "Brother Ketil" }));

    fireEvent.click(button);
    expect(screen.queryByRole("complementary", { name: "Assistant" })).toBeNull();
    act(() => send({ kind: "text", delta: " keeps the shrine." }));
    fireEvent.click(button);

    const pane = screen.getByRole("complementary", { name: "Assistant" });
    expect(within(pane).getByRole("textbox", { name: "Answer" })).toHaveTextContent(
      "Brother Ketil keeps the shrine.",
    );
    expect(within(pane).getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("stops a running answer before the world closes", async () => {
    const calls = await openWorld(withProvider, { assistant_stop: () => null });

    fireEvent.click(screen.getByRole("button", { name: "World menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close world" }));

    await screen.findByRole("button", { name: "Open world…" });
    const commands = calls.map(({ command }) => command);
    expect(commands.lastIndexOf("assistant_stop")).toBeLessThan(commands.indexOf("world_close"));
    expect(commands.lastIndexOf("assistant_stop")).toBeGreaterThan(commands.indexOf("world_open"));
  });

  it("has no button while the settings load", async () => {
    await openWorld(() => new Promise(() => {}));

    expect(screen.queryByRole("button", { name: "Assistant" })).not.toBeInTheDocument();
  });
});
