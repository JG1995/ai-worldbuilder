// The shapes the Rust core sends and takes. ts-rs generates them from the Rust types into
// ./generated/ when the Rust tests run (`pnpm bindings`); never edit those files by hand.

export type { Backlink } from "./generated/Backlink";
export type { Backlinks } from "./generated/Backlinks";
export type { Comparison } from "./generated/Comparison";
export type { DiffLine } from "./generated/DiffLine";
export type { EditorLink } from "./generated/EditorLink";
export type { EditorLinks } from "./generated/EditorLinks";
export type { EntryKind } from "./generated/EntryKind";
export type { ErrorKind } from "./generated/ErrorKind";
export type { HistoryVersion } from "./generated/HistoryVersion";
export type { LineKind } from "./generated/LineKind";
export type { LinkedPage } from "./generated/LinkedPage";
export type { LinkState } from "./generated/LinkState";
export type { LinkSuggestion } from "./generated/LinkSuggestion";
export type { LinkSuggestions } from "./generated/LinkSuggestions";
export type { NewEntry } from "./generated/NewEntry";
export type { NewLocation } from "./generated/NewLocation";
export type { PageText } from "./generated/PageText";
export type { PageVersion } from "./generated/PageVersion";
export type { RecentWorld } from "./generated/RecentWorld";
export type { RestoredPage } from "./generated/RestoredPage";
export type { TreeEntry } from "./generated/TreeEntry";
export type { VersionKind } from "./generated/VersionKind";
export type { Workspace } from "./generated/Workspace";
export type { WorldOpened } from "./generated/WorldOpened";

/**
 * The watcher's, the world history's and the page index's events, by the name each is sent under. Each carries the
 * session of the opening it belongs to, so events from a world that is no longer open can be told
 * apart. Kept by hand: the core's `WorldEvent` is one untagged enum, and only `WorldEvent::name` in
 * `world/watch.rs` holds the names.
 */
export type WorldEvents = {
  /** Entries were created, removed or renamed (`tree`), or the pages at `pages` changed on disk. */
  "world:changed": { session: number; tree: boolean; pages: string[] };
  /** The world's folder is gone. */
  "world:missing": { session: number };
  /** The watcher could not start or stopped working. */
  "world:watch-failed": { session: number; message: string };
  /** The world's changes are not being recorded in its history, for the reason in `message`. */
  "world:history-not-recording": { session: number; message: string };
  /** The world's changes are being recorded again. */
  "world:history-recording": { session: number };
  /** The world's history database was damaged, so it was set aside and a new one started. */
  "world:history-set-aside": { session: number };
  /** The page index was built, or what it holds changed. */
  "world:index-changed": { session: number };
  /** The page index cannot be built, because the world cannot be listed, for the reason given. */
  "world:index-failed": { session: number; message: string };
};
