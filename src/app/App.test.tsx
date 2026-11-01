import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { mockWorldIpc } from "@/features/world/api/test-ipc";
import { App } from "./App";

it("launches on the welcome screen when the core has no world to reopen", async () => {
  const calls = mockWorldIpc();

  render(<App />);

  expect(await screen.findByRole("button", { name: "Open world…" })).toBeInTheDocument();
  expect(screen.getByText("No worlds yet.")).toBeInTheDocument();
  expect(calls.map(({ command }) => command)).toEqual(["world_restore", "recent_list"]);
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
