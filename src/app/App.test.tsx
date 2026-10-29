import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";

function mockAppInfo(handler: () => unknown) {
  vi.stubGlobal("isTauri", true);
  mockIPC((command) => {
    if (command !== "app_info") throw `unexpected command ${command}`;
    return handler();
  });
}

it("shows the product name and the version the Rust core reports", async () => {
  mockAppInfo(() => ({ name: "Grimoire.md", version: "1.2.3" }));

  render(<App />);

  expect(screen.getByRole("heading", { name: "Grimoire.md" })).toBeInTheDocument();
  expect(await screen.findByText("Version 1.2.3")).toBeInTheDocument();
});

it("shows the error state with the message when the version command fails", async () => {
  mockAppInfo(() => {
    throw { kind: "internal", message: "An unexpected internal error occurred." };
  });

  render(<App />);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The version could not be read: An unexpected internal error occurred.",
  );
});
