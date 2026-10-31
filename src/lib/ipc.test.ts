import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it, vi } from "vitest";
import { invokeCommand } from "./ipc";

vi.mock("./preview-fixtures", () => ({
  previewFixtures: {
    sample_value: { answer: 42 },
    sample_echo: (args: unknown) => ({ received: args }),
    sample_failure: () => {
      throw { kind: "not_found", message: "The page or folder does not exist." };
    },
  },
}));

function mockTauri(handler: Parameters<typeof mockIPC>[0]) {
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC(handler);
}

describe("invokeCommand inside Tauri", () => {
  it("resolves with the command's result", async () => {
    mockTauri((command, args) => ({ command, args }));

    await expect(invokeCommand("page_read", { path: "Index.md" })).resolves.toEqual({
      command: "page_read",
      args: { path: "Index.md" },
    });
  });

  it("passes a { kind, message } rejection through", async () => {
    mockTauri(() => {
      throw { kind: "internal", message: "An unexpected internal error occurred." };
    });

    await expect(invokeCommand("world_tree")).rejects.toMatchObject({
      kind: "internal",
      message: "An unexpected internal error occurred.",
    });
  });

  it.each([
    ["a string", "command world_tree not found", "command world_tree not found"],
    ["an object without kind", { message: 42 }, '{"message":42}'],
  ])("turns %s rejection into an ipc error", async (_label, rejection, message) => {
    mockTauri(() => {
      throw rejection;
    });

    await expect(invokeCommand("world_tree")).rejects.toMatchObject({ kind: "ipc", message });
  });
});

describe("invokeCommand in the browser preview", () => {
  it("resolves a command from a value fixture", async () => {
    await expect(invokeCommand("sample_value")).resolves.toEqual({ answer: 42 });
  });

  it("calls a function fixture with the command's arguments", async () => {
    await expect(invokeCommand("sample_echo", { path: "Index.md" })).resolves.toEqual({
      received: { path: "Index.md" },
    });
  });

  it("turns a { kind, message } thrown by a function fixture into an IpcError", async () => {
    await expect(invokeCommand("sample_failure")).rejects.toMatchObject({
      name: "IpcError",
      kind: "not_found",
      message: "The page or folder does not exist.",
    });
  });

  it("rejects a command without a fixture, naming the command", async () => {
    await expect(invokeCommand("world_create")).rejects.toMatchObject({
      kind: "ipc",
      message: expect.stringContaining("world_create"),
    });
  });
});
