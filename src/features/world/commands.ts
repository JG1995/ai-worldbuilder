import { invokeCommand } from "../../lib/ipc";
import type { TreeEntry } from "../../ui/FileTree";

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

/** Shows the folder dialog and opens the picked folder; null when the user cancels. */
export const worldOpen = () => invokeCommand<WorldOpened | null>("world_open");

export const worldClose = () => invokeCommand<null>("world_close");

export const worldTree = () => invokeCommand<TreeEntry[]>("world_tree");

/** The TanStack Query key prefix of `world_tree` results; each opening adds its session. */
export const worldTreeKey = ["world_tree"] as const;

/** Reads a page; `path` is relative to the world and includes the `.md` extension. */
export const pageRead = (path: string) => invokeCommand<PageText>("page_read", { path });

/**
 * Saves the editor's text (with `\n` line endings) to a page whose bytes on disk still have
 * `version`, and returns the version of the bytes it now has. Rejects with `conflict` otherwise.
 */
export const pageWrite = (path: string, text: string, version: string) =>
  invokeCommand<{ version: string }>("page_write", { path, text, version });

/**
 * Creates an empty page `{name}.md` in `folder`, or at the world's top level when it is null, and
 * returns its path. Rejects with `invalid_name` or `exists`, whose message names the broken rule.
 */
export const pageCreate = (folder: string | null, name: string) =>
  invokeCommand<{ path: string }>("page_create", { folder, name });

/** Creates an empty folder as `pageCreate` creates a page. */
export const folderCreate = (folder: string | null, name: string) =>
  invokeCommand<{ path: string }>("folder_create", { folder, name });

/** Forgets any location picked before and returns the default one for a new world, to show. */
export const worldNewLocation = () => invokeCommand<{ location: string }>("world_new_location");

/** Shows the folder dialog for the new world's location; null when the user cancels. */
export const worldNewBrowse = () => invokeCommand<{ location: string } | null>("world_new_browse");

/** Creates an empty folder `name` at the new world's location and opens it as the world. */
export const worldCreate = (name: string) => invokeCommand<WorldOpened>("world_create", { name });
