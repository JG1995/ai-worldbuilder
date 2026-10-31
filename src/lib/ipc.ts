import { type InvokeArgs, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A failed command, in the `{ kind, message }` shape the Rust core returns. */
export class IpcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

/** Calls a Rust command. Every rejection is an `IpcError`. */
export async function invokeCommand<T>(name: string, args?: InvokeArgs): Promise<T> {
  if (isTauri()) {
    try {
      return await invoke<T>(name, args);
    } catch (rejection) {
      throw toIpcError(rejection);
    }
  }

  if (import.meta.env.DEV) {
    const { previewFixtures } = await import("./preview-fixtures");
    if (!Object.hasOwn(previewFixtures, name)) {
      throw new IpcError("ipc", `The browser preview has no sample data for command "${name}".`);
    }
    // A fixture is a value, or a function of the arguments that may throw like the core.
    const fixture = previewFixtures[name];
    try {
      return (typeof fixture === "function" ? await fixture(args) : fixture) as T;
    } catch (rejection) {
      throw toIpcError(rejection);
    }
  }

  throw new IpcError("ipc", `Command "${name}" is only available in the Grimoire.md app.`);
}

/**
 * Calls `handler` with the payload of each event `name` the Rust core sends, and resolves to the
 * function that stops listening. Outside Tauri no event ever arrives, so it listens to nothing.
 */
export async function listenEvent<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const unlisten = await listen<T>(name, (event) => handler(event.payload));
  return () => void unlisten();
}

function toIpcError(rejection: unknown): IpcError {
  if (
    typeof rejection === "object" &&
    rejection !== null &&
    "kind" in rejection &&
    "message" in rejection &&
    typeof rejection.kind === "string" &&
    typeof rejection.message === "string"
  ) {
    return new IpcError(rejection.kind, rejection.message);
  }
  const message =
    typeof rejection === "string" ? rejection : (JSON.stringify(rejection) ?? String(rejection));
  return new IpcError("ipc", message);
}
