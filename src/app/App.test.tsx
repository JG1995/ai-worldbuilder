import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { mockWorldIpc } from "../features/world/test-ipc";
import { App } from "./App";

it("launches on the welcome screen without calling the core", () => {
  const calls = mockWorldIpc();

  render(<App />);

  expect(screen.getByRole("button", { name: "Open world…" })).toBeInTheDocument();
  expect(screen.getByText("No worlds yet.")).toBeInTheDocument();
  expect(calls).toEqual([]);
});
