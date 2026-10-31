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
