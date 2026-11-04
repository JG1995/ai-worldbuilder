// The Tauri IPC mock for this feature's tests, with the channel messages the core sends while an
// answer runs.
import { mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { vi } from "vitest";
import type { AnswerEvent } from "@/types/api";

type Handler = (args: Record<string, unknown>) => unknown;

type TauriInternals = { runCallback: (id: number, data: unknown) => void };

/**
 * Sends each event on the channel that `assistant_send` received as `onEvent`, in order, as the
 * core does. Call it from the command's handler.
 */
export function answerChannel(args: Record<string, unknown>) {
  const { id } = args.onEvent as { id: number };
  const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals })
    .__TAURI_INTERNALS__;
  let index = 0;
  return (event: AnswerEvent) => internals.runCallback(id, { index: index++, message: event });
}

/**
 * Mocks the core with `assistant_stop` answering at once and `assistant_images` with no images,
 * and with Tauri's events, which `emit` sends; the test supplies `assistant_send`. Returns the calls
 * it receives, in order, without the channel.
 */
export function mockAssistantIpc(overrides: Record<string, Handler>) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = {
    assistant_stop: () => null,
    assistant_images: () => ({ answers: [], regenerations: [] }),
    ...overrides,
  };
  // `isTauri()` reads `globalThis.isTauri`, which the real runtime sets and `mockIPC` does not.
  vi.stubGlobal("isTauri", true);
  mockIPC(
    (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      const { onEvent: _channel, ...sent } = args;
      calls.push({ command, args: sent });
      const handler = handlers[command];
      if (!handler) throw `unexpected command ${command}`;
      return handler(args);
    },
    { shouldMockEvents: true },
  );
  // Stored images get the image scheme's URLs.
  mockConvertFileSrc("linux");
  return calls;
}
