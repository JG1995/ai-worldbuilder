import type { EditorState } from "@codemirror/state";
import { create } from "zustand";
import { defaultTreeWidth } from "../../ui/Shell";
import type { WorldOpened } from "./commands";
import type { PageSaver, SaveNotice, SaveResult } from "./saving";

/**
 * One open page. A ready page keeps its editor state, so switching tabs keeps cursor and undo, and
 * the saver of its edits with the notice the saver last reported.
 */
export type PageStatus =
  | { status: "loading" }
  | { status: "ready"; editor: EditorState; saver: PageSaver; notice: SaveNotice | null }
  | { status: "not_utf8" }
  | { status: "read_error"; message: string };

type WorldStore = {
  world: { name: string; session: number } | null;
  /** Open pages' paths, in tab order. */
  tabs: string[];
  /** The active tab's path; the tree selects its row. */
  active: string | null;
  expanded: ReadonlySet<string>;
  treeWidth: number;
  treeOverlayOpen: boolean;
  pages: Readonly<Record<string, PageStatus>>;
  /**
   * True from the start of a world change until it ends: the pages save, then the folder dialog
   * shows. Nothing in the world can be edited or opened meanwhile, because the change drops every
   * page's editor, and the folder dialog does not stop input to the window on every platform.
   */
  changingWorld: boolean;
  opened: (world: WorldOpened) => void;
  closed: () => void;
  setChangingWorld: (changing: boolean) => void;
  /** Opens a page in the active tab, or in a new tab when asked or when no tab is active. */
  openPage: (path: string, options: { newTab: boolean }) => void;
  activate: (path: string) => void;
  closeTab: (path: string) => void;
  toggleFolder: (path: string, open: boolean) => void;
  setTreeWidth: (width: number) => void;
  setTreeOverlayOpen: (open: boolean) => void;
  /**
   * The setters below take the world session the page was opened in, and are ignored once that
   * world or the page is no longer open, so nothing from one world reaches another.
   */
  setPage: (session: number, path: string, status: PageStatus) => void;
  /** Keeps a ready page's editor state, for example when its tab stops showing it. */
  setEditor: (session: number, path: string, editor: EditorState) => void;
  setNotice: (session: number, path: string, notice: SaveNotice | null) => void;
  /** Saves an open page's edits now. A page without an editor has none. */
  flush: (path: string) => Promise<SaveResult>;
  /** Stops every page's autosave, and returns the function that resumes it. */
  holdSaving: () => () => void;
};

const closedWorld = {
  world: null,
  tabs: [],
  active: null,
  expanded: new Set<string>(),
  treeWidth: defaultTreeWidth,
  treeOverlayOpen: false,
  pages: {},
};

/** The page name shown for a path: its last segment without the `.md` extension. */
export function pageNameOf(path: string) {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

/** `expanded` with every folder above `path` added. */
function withAncestors(expanded: ReadonlySet<string>, path: string | null) {
  const segments = path?.split("/") ?? [];
  const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  if (ancestors.every((folder) => expanded.has(folder))) return expanded;
  return new Set([...expanded, ...ancestors]);
}

/** `pages` without `path`, whose saver stops: the page has saved or the user discarded its edits. */
function without(pages: WorldStore["pages"], path: string) {
  const { [path]: removed, ...rest } = pages;
  if (removed?.status === "ready") removed.saver.dispose();
  return rest;
}

function savers(pages: WorldStore["pages"]) {
  return Object.values(pages).flatMap((page) => (page.status === "ready" ? [page.saver] : []));
}

const loading: PageStatus = { status: "loading" };

export const useWorldStore = create<WorldStore>()((set, get) => ({
  ...closedWorld,
  changingWorld: false,

  opened: ({ name, session, workspace }) => {
    for (const saver of savers(get().pages)) saver.dispose();
    set({
      ...closedWorld,
      world: { name, session },
      tabs: workspace.tabs,
      active: workspace.active,
      expanded: withAncestors(new Set(workspace.expanded), workspace.active),
      treeWidth: workspace.treeWidth,
      pages: Object.fromEntries(workspace.tabs.map((path) => [path, loading])),
    });
  },

  closed: () => {
    for (const saver of savers(get().pages)) saver.dispose();
    set(closedWorld);
  },

  setChangingWorld: (changingWorld) => set({ changingWorld }),

  openPage: (path, { newTab }) => {
    const { tabs, active, pages, activate } = get();
    if (!tabs.includes(path)) {
      if (newTab || active === null) {
        set({ tabs: [...tabs, path], pages: { ...pages, [path]: loading } });
      } else {
        set({
          tabs: tabs.map((tab) => (tab === active ? path : tab)),
          pages: { ...without(pages, active), [path]: loading },
        });
      }
    }
    activate(path);
  },

  activate: (path) =>
    set(({ expanded }) => ({ active: path, expanded: withAncestors(expanded, path) })),

  closeTab: (path) =>
    set(({ tabs, active, pages, expanded }) => {
      const index = tabs.indexOf(path);
      if (index === -1) return {};
      const rest = tabs.filter((tab) => tab !== path);
      const next = path === active ? (rest[index] ?? rest[index - 1] ?? null) : active;
      return {
        tabs: rest,
        active: next,
        expanded: withAncestors(expanded, next),
        pages: without(pages, path),
      };
    }),

  toggleFolder: (path, open) =>
    set(({ expanded }) => {
      const next = new Set(expanded);
      if (open) next.add(path);
      else next.delete(path);
      return { expanded: next };
    }),

  setTreeWidth: (treeWidth) => set({ treeWidth }),

  setTreeOverlayOpen: (treeOverlayOpen) => set({ treeOverlayOpen }),

  setPage: (session, path, status) =>
    set(({ world, tabs, pages }) =>
      world?.session === session && tabs.includes(path)
        ? { pages: { ...pages, [path]: status } }
        : {},
    ),

  setEditor: (session, path, editor) => {
    const page = get().pages[path];
    if (page?.status === "ready") get().setPage(session, path, { ...page, editor });
  },

  setNotice: (session, path, notice) => {
    const page = get().pages[path];
    if (page?.status === "ready") get().setPage(session, path, { ...page, notice });
  },

  flush: (path) => {
    const page = get().pages[path];
    return page?.status === "ready" ? page.saver.flush() : Promise.resolve({ kind: "clean" });
  },

  holdSaving: () => {
    const held = savers(get().pages);
    for (const saver of held) saver.hold();
    return () => {
      for (const saver of held) saver.release();
    };
  },
}));
