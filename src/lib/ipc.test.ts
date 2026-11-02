import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it, vi } from "vitest";
import { invokeCommand, invokeStreaming, listenEvent } from "./ipc";

vi.mock("./preview-fixtures", () => ({
  previewFixtures: {
    sample_value: { answer: 42 },
    sample_echo: (args: unknown) => ({ received: args }),
    sample_failure: () => {
      throw { kind: "not_found", message: "The page or folder does not exist." };
    },
    sample_stream: async (args: unknown, onEvent: (event: unknown) => void) => {
      onEvent("first");
      await Promise.resolve();
      onEvent("second");
      return { received: args };
    },
  },
}));

function mockTauri(handler: Parameters<typeof mockIPC>[0]) {
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC(handler, { shouldMockEvents: true });
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

/** Sends `messages` on the channel a command received as `onEvent`, as the core does. */
function sendOnChannel(channel: unknown, messages: unknown[]) {
  const { id } = channel as { id: number };
  const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback: RunCallback } })
    .__TAURI_INTERNALS__;
  messages.forEach((message, index) => {
    internals.runCallback(id, { index, message });
  });
}
type RunCallback = (id: number, data: unknown) => void;

describe("invokeStreaming", () => {
  it("passes a channel as onEvent inside Tauri, delivers its messages in order and resolves with the result", async () => {
    mockTauri((command, args) => {
      const { onEvent, ...rest } = args as { onEvent: unknown };
      sendOnChannel(onEvent, ["first", "second"]);
      return { command, args: rest };
    });
    const events: unknown[] = [];

    await expect(
      invokeStreaming("assistant_send", { text: "Hello" }, (event) => events.push(event)),
    ).resolves.toEqual({ command: "assistant_send", args: { text: "Hello" } });
    expect(events).toEqual(["first", "second"]);
  });

  it("turns a rejection inside Tauri into an IpcError", async () => {
    mockTauri(() => {
      throw { kind: "conflict", message: "An answer is already running." };
    });

    await expect(invokeStreaming("assistant_send", {}, () => {})).rejects.toMatchObject({
      name: "IpcError",
      kind: "conflict",
    });
  });

  it("calls a preview fixture with the arguments and the event handler", async () => {
    const events: unknown[] = [];

    await expect(
      invokeStreaming("sample_stream", { text: "Hello" }, (event) => events.push(event)),
    ).resolves.toEqual({ received: { text: "Hello" } });
    expect(events).toEqual(["first", "second"]);
  });
});

describe("listenEvent", () => {
  it("passes each event's payload to the handler until it stops listening", async () => {
    mockTauri(() => null);
    const handler = vi.fn();

    const unlisten = listenEvent("world:changed", handler);
    await vi.waitFor(async () => {
      await emit("world:changed", { session: 1 });
      expect(handler).toHaveBeenCalled();
    });
    unlisten();
    await emit("world:changed", { session: 2 });

    expect(handler.mock.calls).toEqual([[{ session: 1 }]]);
  });

  it("never calls the handler when it stops before listening has started", async () => {
    mockTauri(() => null);
    const handler = vi.fn();
    const later = vi.fn();

    listenEvent("world:changed", handler)();
    const unlisten = listenEvent("world:changed", later);
    await vi.waitFor(async () => {
      await emit("world:changed", { session: 1 });
      expect(later).toHaveBeenCalled();
    });
    unlisten();

    expect(handler).not.toHaveBeenCalled();
  });
});
