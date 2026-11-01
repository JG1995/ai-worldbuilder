import { invokeCommand } from "@/lib/ipc";
import type {
  Backlinks,
  Comparison,
  DiffLine,
  HistoryVersion,
  NewEntry,
  NewLocation,
  PageText,
  PageVersion,
  RecentWorld,
  RestoredPage,
  TreeEntry,
  Workspace,
  WorldOpened,
} from "@/types/api";

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
 * `keepMine` is true for Keep mine, which history records as such.
 */
export const pageWrite = (path: string, text: string, version: string, keepMine: boolean) =>
  invokeCommand<PageVersion>("page_write", { path, text, version, keepMine });

/** Compares the page on disk with the editor's text, line by line. */
export const pageCompare = (path: string, text: string) =>
  invokeCommand<Comparison>("page_compare", { path, text });

/**
 * Writes the editor's text back to a page deleted or moved outside the application, recreating its
 * folders, and returns the version of its bytes. Rejects with `conflict` when something is at its
 * path again.
 */
export const pageRestore = (path: string, text: string) =>
  invokeCommand<PageVersion>("page_restore", { path, text });

/**
 * Creates an empty page `{name}.md` in `folder`, or at the world's top level when it is null, and
 * returns its path. Rejects with `invalid_name` or `exists`, whose message names the broken rule.
 */
export const pageCreate = (folder: string | null, name: string) =>
  invokeCommand<NewEntry>("page_create", { folder, name });

/** Creates an empty folder as `pageCreate` creates a page. */
export const folderCreate = (folder: string | null, name: string) =>
  invokeCommand<NewEntry>("folder_create", { folder, name });

/**
 * A page's earlier versions, newest first, without the newest ones equal to the page on disk.
 * Rejects with `io` when the page's history cannot be read.
 */
export const historyList = (path: string) =>
  invokeCommand<HistoryVersion[]>("history_list", { path });

/** Compares a version of a page with the editor's text, line by line. */
export const historyCompare = (path: string, version: string, text: string) =>
  invokeCommand<DiffLine[]>("history_compare", { path, version, text });

/**
 * Writes a version's exact bytes back to its page, whose bytes on disk still have `pageVersion`,
 * and returns the page's new text and version with the change that recorded it, if any. Rejects
 * with `conflict` when the page changed on disk, and `not_found` for a version history lacks.
 */
export const historyRestore = (path: string, version: string, pageVersion: string) =>
  invokeCommand<RestoredPage>("history_restore", { path, version, pageVersion });

/**
 * Undoes a restore, the change `change`, writing back the bytes it replaced. Rejects with
 * `conflict`, whose message names the page, when the page changed since the restore.
 */
export const historyUndo = (change: string) =>
  invokeCommand<RestoredPage>("history_undo", { change });

/**
 * The pages that link to the page at `path`, from the world's page index, or whether the index is
 * still being built or cannot be built.
 */
export const backlinksList = (path: string) => invokeCommand<Backlinks>("backlinks_list", { path });

/**
 * The TanStack Query key prefix of `backlinks_list` results; each adds the session, the page's path
 * and the index revision it was asked at.
 */
export const backlinksKey = ["backlinks_list"] as const;

/** Forgets any location picked before and returns the default one for a new world, to show. */
export const worldNewLocation = () => invokeCommand<NewLocation>("world_new_location");

/** Shows the folder dialog for the new world's location; null when the user cancels. */
export const worldNewBrowse = () => invokeCommand<NewLocation | null>("world_new_browse");

/** Creates an empty folder `name` at the new world's location and opens it as the world. */
export const worldCreate = (name: string) => invokeCommand<WorldOpened>("world_create", { name });

/** The recent worlds, most recently opened first, without the open world. */
export const recentList = () => invokeCommand<RecentWorld[]>("recent_list");

/** The TanStack Query key of `recent_list` results. */
export const recentListKey = ["recent_list"] as const;

/** Removes a world from the recent list; nothing in its folder changes. */
export const recentRemove = (id: string) => invokeCommand<null>("recent_remove", { id });

/** Opens a recent world. Rejects with `world_missing` when its folder is gone. */
export const worldOpenRecent = (id: string) =>
  invokeCommand<WorldOpened>("world_open_recent", { id });

/** Opens the world that was open when the application last closed; null when there is none. */
export const worldRestore = () => invokeCommand<WorldOpened | null>("world_restore");

/** Stores the open world's workspace for its next opening. */
export const workspaceSave = (workspace: Workspace) =>
  invokeCommand<null>("workspace_save", { workspace });

/** Closes the window, once the open world has saved. */
export const appClose = () => invokeCommand<null>("app_close");

/** The core asks the interface to save and then call `appClose`: the user closed the window. */
export const closeRequestedEvent = "app:close-requested";
