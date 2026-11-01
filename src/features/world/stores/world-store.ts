import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import { create } from "zustand";
import type { IpcError } from "@/lib/ipc";
import type { Workspace, WorldOpened } from "@/types/api";
import { findAnchor, type LinkAnchor } from "@/ui/editor-links";
import type { TreeNameInput } from "@/ui/FileTree";
import { defaultTreeWidth } from "@/ui/Shell";
import type { Toast } from "@/ui/Toast";
import { workspaceSave } from "../api/commands";
import type { PageSaver, SaveNotice, SaveResult } from "../logic/saving";
import { parentOf } from "../utils/paths";

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

/** A page shown without an editor, because the core cannot read it. */
export function unreadablePage({ kind, message }: IpcError): PageStatus {
  return kind === "not_utf8" ? { status: "not_utf8" } : { status: "read_error", message };
}

/**
 * What the open world shows above the page region, about the world as a whole, until it closes.
 * `history_set_aside`: the world's damaged history was set aside and a new one started.
 */
export type WorldNotice = "missing" | "watch_failed" | "history_set_aside";

/** A toast, with what its action does when it has one. */
export type WorldToast = Toast & { onAction?: () => void };

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
  /**
   * A page whose editor takes focus when it first shows: one just created, or one switched to
   * while focus was in another page's editor.
   */
  createdPage: string | null;
  expanded: ReadonlySet<string>;
  treeWidth: number;
  treeOverlayOpen: boolean;
  pages: Readonly<Record<string, PageStatus>>;
  worldNotices: ReadonlySet<WorldNotice>;
  /** Why the world's changes are not being recorded in its history, while they are not. */
  historyNotRecording: string | null;
  /** The path of the active page while its History view shows in place of its editor. */
  historyPath: string | null;
  /**
   * Counts the open world's page index changes, so what is asked of the index is asked again
   * when it changes.
   */
  indexRevision: number;
  /**
   * Where the cursor goes in the page at `path`, which is still being read; the page's tab takes
   * it when it creates the page's editor state.
   */
  cursorTarget: { path: string; at: CursorTarget } | null;
  /** Oldest first. */
  toasts: WorldToast[];
  /**
   * True from the start of a world change until it ends: the pages save, then the folder dialog
   * shows. Nothing in the world can be edited or opened meanwhile, because the change drops every
   * page's editor, and the folder dialog does not stop input to the window on every platform.
   */
  changingWorld: boolean;
  opened: (world: WorldOpened) => void;
  closed: () => void;
  setChangingWorld: (changing: boolean) => void;
  /**
   * Opens a page in the active tab, or in a new tab when asked or when no tab is active. With
   * `at`, its editor takes focus with the cursor at that target.
   */
  openPage: (path: string, options: { newTab: boolean; at?: CursorTarget }) => void;
  /** Takes the cursor target of the page at `path`, if it has one, so it applies once. */
  takeCursorTarget: (path: string) => CursorTarget | null;
  /** Counts a change of the page index of the world `session`; ignored once it is not open. */
  indexChanged: (session: number) => void;
  /** Makes a page the active tab; with `focusEditor`, its editor takes focus when it shows. */
  activate: (path: string, options?: { focusEditor?: boolean }) => void;
  closeTab: (path: string) => void;
  /** Shows the History view of `path` while it is the active page, or hides it with null. */
  showHistory: (path: string | null) => void;
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
  /** Shows why changes are not being recorded, or hides it with null once they are again. */
  setHistoryNotRecording: (session: number, reason: string | null) => void;
  /** Shows a toast, with an action such as Undo when `action` is given. */
  showToast: (
    session: number,
    message: string,
    action?: { label: string; run: () => void },
  ) => void;
  dismissToast: (id: string) => void;
  /** Dismisses a toast and runs its action. */
  runToastAction: (id: string) => void;
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
  historyNotRecording: null,
  historyPath: null,
  indexRevision: 0,
  cursorTarget: null,
  toasts: [],
};

/** Numbers toasts, so each has its own id. */
let toastCount = 0;

/** How long after the tabs, the expanded folders or the tree width change the workspace saves. */
export const workspaceSaveDelay = 500;

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

/**
 * Where a page's cursor goes when it opens: an offset into its text in UTF-16 code units, as a
 * backlink gives it, or a heading or block, as a followed link names it.
 */
export type CursorTarget = number | LinkAnchor;

/** Where `target` is in `state`'s text, or null when it names a heading or block not there. */
export function cursorOffset(state: EditorState, target: CursorTarget) {
  return typeof target === "number"
    ? Math.min(target, state.doc.length)
    : findAnchor(state, target);
}

/**
 * Puts the cursor of the open page at `path` at `target`: in its running editor while its tab
 * shows it, in the editor state its tab will show when it is ready, and otherwise as the cursor
 * target that the page's editor state is created with. A heading or block the page does not have
 * leaves an open page's cursor where it was.
 */
function placeCursor(path: string, target: CursorTarget) {
  const page = useWorldStore.getState().pages[path];
  if (page?.status !== "ready") {
    useWorldStore.setState({ cursorTarget: { path, at: target } });
    return;
  }
  const view = page.view?.current;
  if (view) {
    const at = cursorOffset(view.state, target);
    if (at !== null) view.dispatch({ selection: { anchor: at } });
    view.focus();
    return;
  }
  const at = cursorOffset(page.editor, target);
  if (at === null) return;
  const editor = page.editor.update({ selection: { anchor: at } }).state;
  useWorldStore.setState(({ pages }) => ({ pages: { ...pages, [path]: { ...page, editor } } }));
}

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

  openPage: (path, { newTab, at }) => {
    const { tabs, active, pages, activate } = get();
    set({ cursorTarget: null });
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
    if (at !== undefined) placeCursor(path, at);
    activate(path, { focusEditor: at !== undefined });
  },

  takeCursorTarget: (path) => {
    const { cursorTarget } = get();
    if (cursorTarget?.path !== path) return null;
    set({ cursorTarget: null });
    return cursorTarget.at;
  },

  indexChanged: (session) =>
    set(({ world, indexRevision }) =>
      world?.session === session ? { indexRevision: indexRevision + 1 } : {},
    ),

  activate: (path, { focusEditor = false } = {}) =>
    set(({ expanded, createdPage, historyPath }) => ({
      active: path,
      historyPath: historyPath === path ? historyPath : null,
      selectedFolder: null,
      // A created page left before its editor showed no longer takes focus when it shows.
      createdPage: focusEditor || createdPage === path ? path : null,
      expanded: withAncestors(expanded, path),
    })),

  closeTab: (path) =>
    set(({ tabs, active, pages, expanded, selectedFolder, historyPath }) => {
      const index = tabs.indexOf(path);
      if (index === -1) return {};
      const rest = tabs.filter((tab) => tab !== path);
      const next = path === active ? (rest[index] ?? rest[index - 1] ?? null) : active;
      return {
        tabs: rest,
        active: next,
        selectedFolder: next === active ? selectedFolder : null,
        historyPath: next === historyPath ? historyPath : null,
        expanded: withAncestors(expanded, next),
        pages: without(pages, path),
      };
    }),

  showHistory: (path) =>
    set(({ active }) => (path === null || path === active ? { historyPath: path } : {})),

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

  setHistoryNotRecording: (session, historyNotRecording) =>
    set(({ world }) => (world?.session === session ? { historyNotRecording } : {})),

  showToast: (session, message, action) =>
    set(({ world, toasts }) => {
      if (world?.session !== session) return {};
      const id = `toast-${++toastCount}`;
      const toast: WorldToast = action
        ? { id, message, action: action.label, onAction: action.run }
        : { id, message };
      return { toasts: [...toasts, toast] };
    }),

  dismissToast: (id) =>
    set(({ toasts }) => ({ toasts: toasts.filter((toast) => toast.id !== id) })),

  runToastAction: (id) => {
    const toast = get().toasts.find((candidate) => candidate.id === id);
    get().dismissToast(id);
    toast?.onAction?.();
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
