import { Channel, convertFileSrc, type InvokeArgs, invoke, isTauri } from "@tauri-apps/api/core";
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
    // A fixture is a value, or a function of the arguments that may throw like the core.
    const fixture = await previewFixture(name);
    try {
      return (typeof fixture === "function" ? await fixture(args) : fixture) as T;
    } catch (rejection) {
      throw toIpcError(rejection);
    }
  }

  throw unavailable(name);
}

/**
 * Calls a Rust command that sends events while it runs: each message on the channel it receives as
 * `onEvent` goes to `onEvent`, in the order sent. Resolves with the command's result; every
 * rejection is an `IpcError`. In the browser preview, the command's fixture is a function of the
 * arguments and `onEvent`.
 */
export async function invokeStreaming<T, E>(
  name: string,
  args: Record<string, unknown>,
  onEvent: (event: E) => void,
): Promise<T> {
  if (isTauri()) {
    try {
      return await invoke<T>(name, { ...args, onEvent: new Channel<E>(onEvent) });
    } catch (rejection) {
      throw toIpcError(rejection);
    }
  }

  if (import.meta.env.DEV) {
    const fixture = (await previewFixture(name)) as (
      args: Record<string, unknown>,
      onEvent: (event: E) => void,
    ) => Promise<T>;
    try {
      return await fixture(args, onEvent);
    } catch (rejection) {
      throw toIpcError(rejection);
    }
  }

  throw unavailable(name);
}

/** The browser preview's fixtures, once loaded. Development builds only. */
let previewModule: typeof import("./preview-fixtures") | undefined;

/**
 * The URL of the image at `path` in the world opened as `session`, whose file has `stamp`: in
 * Tauri, the core's `grimoire-image` scheme, with the stamp in the query so that a changed image
 * gets a new URL; in the browser preview, its sample image, which exists once the preview has
 * resolved the page's images.
 */
export function imageUrl(session: number, path: string, stamp: string) {
  if (isTauri()) {
    const url = convertFileSrc(`${session}/${path}`, "grimoire-image");
    return `${url}?v=${encodeURIComponent(stamp)}`;
  }
  return previewModule?.previewImageUrl(path) ?? "";
}

/**
 * The URL of the image `id` that the assistant generated in the world opened as `session`: in
 * Tauri, the core's `grimoire-image` scheme under `stored/`, which `convertFileSrc` encodes as one
 * path segment; in the browser preview, the preview's generated image. A stored image's bytes
 * never change, so its URL needs no stamp.
 */
export function storedImageUrl(session: number, id: number) {
  if (isTauri()) return convertFileSrc(`stored/${session}/${id}`, "grimoire-image");
  return previewModule?.previewStoredImageUrl(id) ?? "";
}

/** The browser preview's fixture for `name`. Development builds only. */
async function previewFixture(name: string) {
  previewModule = await import("./preview-fixtures");
  const { previewFixtures } = previewModule;
  if (!Object.hasOwn(previewFixtures, name)) {
    throw new IpcError("ipc", `The browser preview has no sample data for command "${name}".`);
  }
  return previewFixtures[name];
}

const unavailable = (name: string) =>
  new IpcError("ipc", `Command "${name}" is only available in the Grimoire.md app.`);

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
