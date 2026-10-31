import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import { create } from "zustand";
import type { TreeNameInput } from "../../ui/FileTree";
import { defaultTreeWidth } from "../../ui/Shell";
import type { Toast } from "../../ui/Toast";
import { type Workspace, type WorldOpened, workspaceSave } from "./commands";
import type { PageSaver, SaveNotice, SaveResult } from "./saving";

/**
 * One open page. A ready page keeps its editor state, so switching tabs keeps cursor and undo, and
 * the saver of its edits with the notice the saver last reported. The tab that reads the page
 * gives it `view`, which holds the running editor while the tab shows it; that editor's state is
 * newer than `editor`, which is its state when the tab last stopped showing it.
 */
export type PageStatus =
  | { status: "loading" }
  | {
      status: "ready";
      editor: EditorState;
      view?: RefObject<EditorView | null>;
      saver: PageSaver;
      notice: SaveNotice | null;
    }
  | { status: "not_utf8" }
  | { status: "read_error"; message: string };

/** What the open world shows above the page region, about the world as a whole. */
export type WorldNotice = "missing" | "watch_failed";

type WorldStore = {
  world: { name: string; session: number } | null;
  /** Open pages' paths, in tab order. */
  tabs: string[];
  /** The active tab's path; the tree selects its row unless a folder is selected. */
  active: string | null;
  /**
   * A folder the user toggled or created, which the tree selects in place of the active page's
   * row until another page becomes active.
   */
  selectedFolder: string | null;
  /** The tree's inline name input for a new page or folder, while it is open. */
  nameInput: TreeNameInput | null;
  /** A page just created, whose editor takes focus when it first shows. */
  createdPage: string | null;
  expanded: ReadonlySet<string>;
  treeWidth: number;
  treeOverlayOpen: boolean;
  pages: Readonly<Record<string, PageStatus>>;
  worldNotices: ReadonlySet<WorldNotice>;
  /** Oldest first. */
  toasts: Toast[];
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
  /** Expands or collapses a folder, and selects it. */
  toggleFolder: (path: string, open: boolean) => void;
  /**
   * The folder a new page or folder goes in: the right-clicked folder, then the selected folder,
   * then the folder that holds the active page, then the world's top level (null).
   */
  newEntryFolder: (rightClicked?: string) => string | null;
  /** Opens the name input in `folder`, which expands with the folders above it. */
  startNaming: (kind: TreeNameInput["kind"], folder: string | null) => void;
  setNameError: (error: string) => void;
  cancelNaming: () => void;
  /** Closes the name input and opens the new page in a new tab. */
  pageCreated: (path: string) => void;
  /** Closes the name input, and expands and selects the new folder. */
  folderCreated: (path: string) => void;
  /** Forgets that a page was just created, once its editor has taken focus. */
  createdPageShown: () => void;
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
  /** Shows a world-level notice until the world closes; ignored once that world is not open. */
  showWorldNotice: (session: number, notice: WorldNotice) => void;
  showToast: (session: number, message: string) => void;
  dismissToast: (id: string) => void;
  /** Saves an open page's edits now. A page without an editor has none. */
  flush: (path: string) => Promise<SaveResult>;
  /** Stops every page's autosave, and returns the function that resumes it. */
  holdSaving: () => () => void;
};

const closedWorld = {
  world: null,
  tabs: [],
  active: null,
  selectedFolder: null,
  nameInput: null,
  createdPage: null,
  expanded: new Set<string>(),
  treeWidth: defaultTreeWidth,
  treeOverlayOpen: false,
  pages: {},
  worldNotices: new Set<WorldNotice>(),
  toasts: [],
};

/** Numbers toasts, so each has its own id. */
let toastCount = 0;

/** How long after the tabs, the expanded folders or the tree width change the workspace saves. */
export const workspaceSaveDelay = 500;

/** The page name shown for a path: its last segment without the `.md` extension. */
export function pageNameOf(path: string) {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
}

/** The folder that holds `path`, or null at the world's top level. */
function parentOf(path: string) {
  const end = path.lastIndexOf("/");
  return end === -1 ? null : path.slice(0, end);
}

/** `expanded` with every folder above `path` added. */
function withAncestors(expanded: ReadonlySet<string>, path: string | null) {
  const segments = path?.split("/") ?? [];
  const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  if (ancestors.every((folder) => expanded.has(folder))) return expanded;
  return new Set([...expanded, ...ancestors]);
}

/** `expanded` with `folder` and every folder above it added. */
function withFolder(expanded: ReadonlySet<string>, folder: string | null) {
  const next = withAncestors(expanded, folder);
  if (folder === null || next.has(folder)) return next;
  return new Set([...next, folder]);
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
    set(({ expanded, createdPage }) => ({
      active: path,
      selectedFolder: null,
      // A created page left before its editor showed no longer takes focus when it shows.
      createdPage: createdPage === path ? createdPage : null,
      expanded: withAncestors(expanded, path),
    })),

  closeTab: (path) =>
    set(({ tabs, active, pages, expanded, selectedFolder }) => {
      const index = tabs.indexOf(path);
      if (index === -1) return {};
      const rest = tabs.filter((tab) => tab !== path);
      const next = path === active ? (rest[index] ?? rest[index - 1] ?? null) : active;
      return {
        tabs: rest,
        active: next,
        selectedFolder: next === active ? selectedFolder : null,
        expanded: withAncestors(expanded, next),
        pages: without(pages, path),
      };
    }),

  toggleFolder: (path, open) =>
    set(({ expanded }) => {
      const next = new Set(expanded);
      if (open) next.add(path);
      else next.delete(path);
      return { expanded: next, selectedFolder: path };
    }),

  newEntryFolder: (rightClicked) => {
    const { selectedFolder, active } = get();
    return rightClicked ?? selectedFolder ?? (active === null ? null : parentOf(active));
  },

  startNaming: (kind, folder) =>
    set(({ expanded }) => ({
      nameInput: { kind, folder },
      expanded: withFolder(expanded, folder),
    })),

  setNameError: (error) =>
    set(({ nameInput }) => (nameInput ? { nameInput: { ...nameInput, error } } : {})),

  cancelNaming: () => set({ nameInput: null }),

  pageCreated: (path) => {
    set({ nameInput: null, createdPage: path });
    get().openPage(path, { newTab: true });
  },

  folderCreated: (path) =>
    set(({ expanded }) => ({
      nameInput: null,
      selectedFolder: path,
      expanded: withFolder(expanded, path),
    })),

  createdPageShown: () => set({ createdPage: null }),

  // A drag on a scaled display gives a fractional width, and the core keeps whole pixels.
  setTreeWidth: (treeWidth) => set({ treeWidth: Math.round(treeWidth) }),

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

  showWorldNotice: (session, notice) =>
    set(({ world, worldNotices }) =>
      world?.session === session && !worldNotices.has(notice)
        ? { worldNotices: new Set([...worldNotices, notice]) }
        : {},
    ),

  showToast: (session, message) =>
    set(({ world, toasts }) =>
      world?.session === session
        ? { toasts: [...toasts, { id: `toast-${++toastCount}`, message }] }
        : {},
    ),

  dismissToast: (id) =>
    set(({ toasts }) => ({ toasts: toasts.filter((toast) => toast.id !== id) })),

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

let workspaceTimer: ReturnType<typeof setTimeout> | undefined;
/** The latest workspace save; each one starts after the one before has settled. */
let workspaceSaving: Promise<void> = Promise.resolve();

function cancelWorkspaceSave() {
  clearTimeout(workspaceTimer);
  workspaceTimer = undefined;
}

/**
 * Saves the open world's workspace now, instead of after the delay, and resolves once it and every
 * save before it have settled, so none can reach the core after the world changes. A workspace
 * that cannot be saved only means the world's next opening shows an older one, so a failure
 * changes nothing.
 */
export function saveWorkspace(): Promise<void> {
  cancelWorkspaceSave();
  const { world, tabs, active, expanded, treeWidth } = useWorldStore.getState();
  if (world) {
    const workspace: Workspace = { tabs, active, expanded: [...expanded], treeWidth };
    workspaceSaving = workspaceSaving.then(() =>
      workspaceSave(workspace).then(
        () => {},
        () => {},
      ),
    );
  }
  return workspaceSaving;
}

// The workspace saves a moment after the user changes it. Opening or closing a world is no such
// change, and nothing is scheduled while the world changes: that change saves the workspace first,
// and a save scheduled during it could reach the core after it has opened the next world.
useWorldStore.subscribe((state, previous) => {
  if (state.world === null || state.world !== previous.world) {
    cancelWorkspaceSave();
    return;
  }
  const changed =
    state.tabs !== previous.tabs ||
    state.active !== previous.active ||
    state.expanded !== previous.expanded ||
    state.treeWidth !== previous.treeWidth;
  if (!changed || state.changingWorld) return;
  cancelWorkspaceSave();
  workspaceTimer = setTimeout(() => void saveWorkspace(), workspaceSaveDelay);
});
