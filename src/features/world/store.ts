import type { EditorState } from "@codemirror/state";
import { create } from "zustand";
import { defaultTreeWidth } from "../../ui/Shell";
import type { WorldOpened } from "./commands";

/** One open page. A ready page keeps its editor state, so switching tabs keeps cursor and undo. */
export type PageStatus =
  | { status: "loading" }
  | { status: "ready"; version: string; editor: EditorState }
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
  opened: (world: WorldOpened) => void;
  closed: () => void;
  /** Opens a page in the active tab, or in a new tab when asked or when no tab is active. */
  openPage: (path: string, options: { newTab: boolean }) => void;
  activate: (path: string) => void;
  closeTab: (path: string) => void;
  toggleFolder: (path: string, open: boolean) => void;
  setTreeWidth: (width: number) => void;
  setTreeOverlayOpen: (open: boolean) => void;
  /** Records a page's state; ignored once the page is no longer open. */
  setPage: (path: string, status: PageStatus) => void;
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

function without(pages: WorldStore["pages"], path: string) {
  const { [path]: _removed, ...rest } = pages;
  return rest;
}

const loading: PageStatus = { status: "loading" };

export const useWorldStore = create<WorldStore>()((set, get) => ({
  ...closedWorld,

  opened: ({ name, session, workspace }) =>
    set({
      ...closedWorld,
      world: { name, session },
      tabs: workspace.tabs,
      active: workspace.active,
      expanded: withAncestors(new Set(workspace.expanded), workspace.active),
      treeWidth: workspace.treeWidth,
      pages: Object.fromEntries(workspace.tabs.map((path) => [path, loading])),
    }),

  closed: () => set(closedWorld),

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

  setPage: (path, status) =>
    set(({ tabs, pages }) => (tabs.includes(path) ? { pages: { ...pages, [path]: status } } : {})),
}));
