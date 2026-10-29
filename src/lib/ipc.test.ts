import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it, vi } from "vitest";
import { invokeCommand } from "./ipc";

function mockTauri(handler: Parameters<typeof mockIPC>[0]) {
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC(handler);
}

describe("invokeCommand inside Tauri", () => {
  it("resolves with the command's result", async () => {
    mockTauri((command, args) => ({ command, args }));

    await expect(invokeCommand("app_info", { probe: 1 })).resolves.toEqual({
      command: "app_info",
      args: { probe: 1 },
    });
  });

  it("passes a { kind, message } rejection through", async () => {
    mockTauri(() => {
      throw { kind: "internal", message: "An unexpected internal error occurred." };
    });

    await expect(invokeCommand("app_info")).rejects.toMatchObject({
      kind: "internal",
      message: "An unexpected internal error occurred.",
    });
  });

  it.each([
    ["a string", "command app_info not found", "command app_info not found"],
    ["an object without kind", { message: 42 }, '{"message":42}'],
  ])("turns %s rejection into an ipc error", async (_label, rejection, message) => {
    mockTauri(() => {
      throw rejection;
    });

    await expect(invokeCommand("app_info")).rejects.toMatchObject({ kind: "ipc", message });
  });
});

describe("invokeCommand in the browser preview", () => {
  it("resolves a command from the preview fixtures", async () => {
    await expect(invokeCommand("app_info")).resolves.toEqual({
      name: "Grimoire.md",
      version: "0.0.0-preview.sample-data",
    });
  });

  it("rejects a command without a fixture, naming the command", async () => {
    await expect(invokeCommand("world_open")).rejects.toMatchObject({
      kind: "ipc",
      message: expect.stringContaining("world_open"),
    });
  });
});
