import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { RefObject } from "react";
import { create } from "zustand";
import type { IpcError } from "@/lib/ipc";
import type { Workspace, WorldOpened } from "@/types/api";
import { findAnchor, type LinkAnchor } from "@/ui/editor-links";
import type { TreeNameInput } from "@/ui/FileTree";
import { defaultAssistantWidth, defaultTreeWidth } from "@/ui/Shell";
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
  /** Whether the assistant's side pane is open at 1280px and wider; saved with the workspace. */
  assistantOpen: boolean;
  assistantWidth: number;
  /** Whether the assistant's overlay is open below 1280px; not saved. */
  assistantOverlayOpen: boolean;
  /** The conversation the assistant shows, or null for a new one; saved with the workspace. */
  assistantConversation: number | null;
  /** The tabs that show the reading view; every other tab shows the editing view. Saved. */
  reading: ReadonlySet<string>;
  /**
   * Whether the tree and the assistant are open in the reading layout, which shows while the
   * active tab is a reading tab in place of the saved tree and assistant state. Both are false
   * whenever the reading layout is not showing, so it starts with both closed. Not saved.
   */
  readingTreeOpen: boolean;
  readingAssistantOpen: boolean;
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
  /** The pages with changes from the assistant waiting for review, whose tabs show a dot. */
  reviewPaths: ReadonlySet<string>;
  /** The pages whose tree rows flash once, because an accept from the assistant wrote them. */
  flashedRows: ReadonlySet<string>;
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
   * Opens a page in the active tab, or in a new tab when asked or when no tab is active. A new tab
   * takes the active tab's view, and so does a page that takes the active tab's place; an open
   * page keeps its own. With `at`, its editor takes focus with the cursor at that target; with
   * `focusEditor`, its editor takes focus and an open page keeps its cursor.
   */
  openPage: (
    path: string,
    options: { newTab: boolean; at?: CursorTarget; focusEditor?: boolean },
  ) => void;
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
  /** Closes the name input and opens the new page in a new tab, in the editing view. */
  pageCreated: (path: string) => void;
  /** Closes the name input, and expands and selects the new folder. */
  folderCreated: (path: string) => void;
  /** Forgets that a page was just created, once its editor has taken focus. */
  createdPageShown: () => void;
  setTreeWidth: (width: number) => void;
  setTreeOverlayOpen: (open: boolean) => void;
  setAssistantOpen: (open: boolean) => void;
  setAssistantWidth: (width: number) => void;
  setAssistantOverlayOpen: (open: boolean) => void;
  setAssistantConversation: (conversation: number | null) => void;
  /** Shows the open tab of `path` in the reading view, or in the editing view with false. */
  setView: (path: string, reading: boolean) => void;
  /** Opens or closes the tree in the reading layout; ignored while it is not showing. */
  setReadingTreeOpen: (open: boolean) => void;
  /** Opens or closes the assistant in the reading layout; ignored while it is not showing. */
  setReadingAssistantOpen: (open: boolean) => void;
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
  /** Sets the pages whose tabs show the review dot; ignored once that world is not open. */
  setReviewPaths: (session: number, paths: string[]) => void;
  /** Flashes the tree rows of `paths` once; ignored once that world is not open. */
  flashRows: (session: number, paths: string[]) => void;
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
  assistantOpen: true,
  assistantWidth: defaultAssistantWidth,
  assistantOverlayOpen: false,
  assistantConversation: null,
  reading: new Set<string>(),
  readingTreeOpen: false,
  readingAssistantOpen: false,
  pages: {},
  worldNotices: new Set<WorldNotice>(),
  historyNotRecording: null,
  historyPath: null,
  indexRevision: 0,
  cursorTarget: null,
  toasts: [],
  reviewPaths: new Set<string>(),
  flashedRows: new Set<string>(),
};

/** Numbers toasts, so each has its own id. */
let toastCount = 0;

/**
 * How long after the tabs, their views, the expanded folders, the tree width, the assistant's side
 * pane or the conversation it shows change the workspace saves.
 */
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

/** Whether the reading layout shows: the active tab is a reading tab. */
export function readingLayout({ active, reading }: Pick<WorldStore, "active" | "reading">) {
  return active !== null && reading.has(active);
}

/**
 * Closes the reading layout's sidebars when `next` ends the reading layout, so the next one starts
 * with both closed; a reading layout that goes on keeps them as they are.
 */
function readingSidebars(next: Pick<WorldStore, "active" | "reading">) {
  return readingLayout(next) ? {} : { readingTreeOpen: false, readingAssistantOpen: false };
}

/** `reading` with `path` added or removed. */
function withView(reading: ReadonlySet<string>, path: string, isReading: boolean) {
  if (reading.has(path) === isReading) return reading;
  const next = new Set(reading);
  if (isReading) next.add(path);
  else next.delete(path);
  return next;
}

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

/**
 * Focuses the editor of the page at `path` while its tab shows it, which focuses itself only as it
 * mounts; any other page's editor takes focus when it first shows.
 */
function focusRunningEditor(path: string) {
  const page = useWorldStore.getState().pages[path];
  if (page?.status === "ready") page.view?.current?.focus();
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
      assistantOpen: workspace.assistantOpen,
      assistantWidth: workspace.assistantWidth,
      assistantConversation: workspace.assistantConversation,
      reading: new Set(workspace.reading),
      pages: Object.fromEntries(workspace.tabs.map((path) => [path, loading])),
    });
  },

  closed: () => {
    for (const saver of savers(get().pages)) saver.dispose();
    set(closedWorld);
  },

  setChangingWorld: (changingWorld) => set({ changingWorld }),

  openPage: (path, { newTab, at, focusEditor = false }) => {
    const { tabs, active, pages, reading, activate } = get();
    set({ cursorTarget: null });
    if (!tabs.includes(path)) {
      const activeReads = active !== null && reading.has(active);
      if (newTab || active === null) {
        set({
          tabs: [...tabs, path],
          pages: { ...pages, [path]: loading },
          reading: withView(reading, path, activeReads),
        });
      } else {
        set({
          tabs: tabs.map((tab) => (tab === active ? path : tab)),
          pages: { ...without(pages, active), [path]: loading },
          reading: withView(withView(reading, active, false), path, activeReads),
        });
      }
    }
    if (at !== undefined) placeCursor(path, at);
    else if (focusEditor) focusRunningEditor(path);
    activate(path, { focusEditor: focusEditor || at !== undefined });
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
    set(({ expanded, createdPage, historyPath, reading }) => ({
      ...readingSidebars({ active: path, reading }),
      active: path,
      historyPath: historyPath === path ? historyPath : null,
      selectedFolder: null,
      // A created page left before its editor showed no longer takes focus when it shows.
      createdPage: focusEditor || createdPage === path ? path : null,
      expanded: withAncestors(expanded, path),
    })),

  closeTab: (path) =>
    set(({ tabs, active, pages, expanded, selectedFolder, historyPath, reading }) => {
      const index = tabs.indexOf(path);
      if (index === -1) return {};
      const rest = tabs.filter((tab) => tab !== path);
      const next = path === active ? (rest[index] ?? rest[index - 1] ?? null) : active;
      const kept = withView(reading, path, false);
      return {
        ...readingSidebars({ active: next, reading: kept }),
        tabs: rest,
        reading: kept,
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
    get().setView(path, false);
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

  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),

  setAssistantWidth: (assistantWidth) => set({ assistantWidth: Math.round(assistantWidth) }),

  setAssistantOverlayOpen: (assistantOverlayOpen) => set({ assistantOverlayOpen }),

  setAssistantConversation: (assistantConversation) => set({ assistantConversation }),

  setView: (path, isReading) =>
    set(({ tabs, active, reading }) => {
      if (!tabs.includes(path)) return {};
      const next = withView(reading, path, isReading);
      return { reading: next, ...readingSidebars({ active, reading: next }) };
    }),

  setReadingTreeOpen: (readingTreeOpen) =>
    set((state) => (readingLayout(state) ? { readingTreeOpen } : {})),

  setReadingAssistantOpen: (readingAssistantOpen) =>
    set((state) => (readingLayout(state) ? { readingAssistantOpen } : {})),

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

  setReviewPaths: (session, paths) =>
    set(({ world, reviewPaths }) => {
      if (world?.session !== session) return {};
      const next = new Set(paths);
      // The same pages again change nothing, so the tabs do not render again.
      const same = next.size === reviewPaths.size && paths.every((path) => reviewPaths.has(path));
      return same ? {} : { reviewPaths: next };
    }),

  // A new set each time, so the same rows flash again after a later accept.
  flashRows: (session, paths) =>
    set(({ world }) => (world?.session === session ? { flashedRows: new Set(paths) } : {})),

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
  const {
    world,
    tabs,
    active,
    expanded,
    treeWidth,
    assistantOpen,
    assistantWidth,
    assistantConversation,
    reading,
  } = useWorldStore.getState();
  if (world) {
    const workspace: Workspace = {
      tabs,
      active,
      expanded: [...expanded],
      treeWidth,
      assistantOpen,
      assistantWidth,
      assistantConversation,
      reading: tabs.filter((tab) => reading.has(tab)),
    };
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
    state.treeWidth !== previous.treeWidth ||
    state.assistantOpen !== previous.assistantOpen ||
    state.assistantWidth !== previous.assistantWidth ||
    state.assistantConversation !== previous.assistantConversation ||
    state.reading !== previous.reading;
  if (!changed || state.changingWorld) return;
  cancelWorkspaceSave();
  workspaceTimer = setTimeout(() => void saveWorkspace(), workspaceSaveDelay);
});
