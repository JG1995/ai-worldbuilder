import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { mockWorldIpc } from "@/features/world/api/test-ipc";
import { App } from "./App";

it("launches on the welcome screen when the core has no world to reopen", async () => {
  const calls = mockWorldIpc();

  render(<App />);

  expect(await screen.findByRole("button", { name: "Open world…" })).toBeInTheDocument();
  expect(screen.getByText("No worlds yet.")).toBeInTheDocument();
  expect(calls.map(({ command }) => command)).toEqual(["world_restore", "recent_list"]);
});
