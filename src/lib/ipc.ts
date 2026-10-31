import { type InvokeArgs, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ErrorKind } from "@/types/api";

/** A failed command, in the `{ kind, message }` shape the Rust core returns. */
export class IpcError extends Error {
  constructor(
    /** The core's error kind, or `ipc` when the call never reached the core. */
    readonly kind: ErrorKind | "ipc",
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
 * Calls `handler` with the payload of each event `name` the Rust core sends, until the returned
 * function is called. Outside Tauri no event ever arrives, so it listens to nothing.
 */
export function listenEvent<T>(name: string, handler: (payload: T) => void): () => void {
  if (!isTauri()) return () => {};
  let stopped = false;
  let unlisten: (() => void) | undefined;
  // Tauri starts listening asynchronously, so a stop that comes first stops it once it has.
  void listen<T>(name, (event) => {
    if (!stopped) handler(event.payload);
  }).then((stop) => {
    if (stopped) stop();
    else unlisten = stop;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
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
    // The core serializes its `ErrorKind`, which `ErrorKind` in src/types/api.ts mirrors.
    return new IpcError(rejection.kind as ErrorKind, rejection.message);
  }
  const message =
    typeof rejection === "string" ? rejection : (JSON.stringify(rejection) ?? String(rejection));
  return new IpcError("ipc", message);
}
