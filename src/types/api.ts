// The shapes the Rust core sends and takes. Each type matches a Rust type of the same name in
// `src-tauri/src/`, and the two are kept in step by hand.

/** The `kind` of a failed command: the core's `ErrorKind`, in snake_case. */
export type ErrorKind =
  | "internal"
  | "no_world"
  | "invalid_path"
  | "not_found"
  | "not_utf8"
  | "world_missing"
  | "io"
  | "conflict"
  | "invalid_name"
  | "exists";

/** The tabs, expanded folders and tree width a world opens with. Paths are relative to the world. */
export type Workspace = {
  tabs: string[];
  active: string | null;
  expanded: string[];
  treeWidth: number;
};

export type WorldOpened = {
  name: string;
  /** Increases with every open, so one opening can be told from the next. */
  session: number;
  workspace: Workspace;
};

export type PageText = {
  /** With `\n` line endings and no byte-order mark. */
  text: string;
  /** An opaque token for the page's bytes on disk. */
  version: string;
};

/** One line of a page on disk compared with the editor's text. */
export type DiffLine = {
  /** `added`: only in the editor's text; `removed`: only on disk. */
  kind: "same" | "added" | "removed";
  text: string;
};

/** A page or folder in the world's tree. */
export type TreeEntry = {
  /** Relative to the world, with `/` separators. A page's path keeps its `.md` extension. */
  path: string;
  /** A page's name drops the extension. */
  name: string;
  kind: "folder" | "page";
  /** A folder's entries; absent for a page. */
  children?: TreeEntry[];
};

/** A world in the recent list. */
export type RecentWorld = {
  id: string;
  name: string;
  path: string;
  /** No folder exists at `path` any more. */
  missing: boolean;
};

/**
 * The watcher's events. Each carries the session of the opening it belongs to, so events from a
 * world that is no longer open can be told apart.
 */
export type WorldEvents = {
  /** Entries were created, removed or renamed (`tree`), or the pages at `pages` changed on disk. */
  "world:changed": { session: number; tree: boolean; pages: string[] };
  /** The world's folder is gone. */
  "world:missing": { session: number };
  /** The watcher could not start or stopped working. */
  "world:watch-failed": { session: number; message: string };
};
