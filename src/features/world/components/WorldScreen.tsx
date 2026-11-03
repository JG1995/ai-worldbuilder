import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { IpcError } from "@/lib/ipc";
import type { RecentWorld, TreeEntry, WrittenPage } from "@/types/api";
import { Button, IconButton } from "@/ui/Button";
import type { LinkAnchor } from "@/ui/editor-links";
import { FileTree, type TreeNameInput } from "@/ui/FileTree";
import type { MenuItem } from "@/ui/Menu";
import { Notice } from "@/ui/Notice";
import { NoPageOpen } from "@/ui/PageView";
import { TabStrip } from "@/ui/TabStrip";
import { ToastRegion } from "@/ui/Toast";
import { folderCreate, pageCreate, worldTree, worldTreeKey } from "../api/commands";
import { createFromLink } from "../logic/links";
import { type CursorTarget, readingLayout, useWorldStore } from "../stores/world-store";
import { pageNameOf } from "../utils/paths";
import { PageTab, pageEditor, switchKeepingTopLine } from "./PageTab";

const newPageShortcut = "Ctrl+N";
const newFolderShortcut = "Ctrl+Shift+N";
const historyShortcut = "Ctrl+Shift+H";
const searchShortcut = "Ctrl+O";
const settingsShortcut = "Ctrl+,";
const viewShortcut = "Ctrl+E";

/** World menu items for recent worlds carry the world's id after this prefix. */
const recentItemPrefix = "recent:";

const worldActionItems: MenuItem[] = [
  { id: "open-world", label: "Open world…" },
  { id: "new-world", label: "New world…" },
  { id: "close-world", label: "Close world" },
];

const newEntryItems: MenuItem[] = [
  { id: "new-page", label: "New page", shortcut: newPageShortcut },
  { id: "new-folder", label: "New folder", shortcut: newFolderShortcut },
];

/** Whether `entries` or their folders hold the page at `path`. */
function treeHasPage(entries: TreeEntry[], path: string): boolean {
  return entries.some((entry) =>
    entry.kind === "page" ? entry.path === path : treeHasPage(entry.children ?? [], path),
  );
}

/**
 * What the quick open dialog gets from the world's screen. `openPage` opens a page by the tab rules
 * of the tree, saving the page it replaces first, with focus in its editor; `pageCreated` opens a
 * page just created in a new tab; `close` hides the dialog.
 */
export type QuickOpenPorts = {
  session: number;
  activePage: string | null;
  indexRevision: number;
  openPage: (path: string, options: { newTab: boolean; at?: CursorTarget }) => void;
  pageCreated: (path: string) => void;
  refreshTree: () => void;
  showWorldMissing: () => void;
  close: () => void;
};

/**
 * What the assistant gets from the world's screen. `openPage` opens a page by the tab rules of the
 * tree, with the cursor at `at` if given; `flushActive` resolves once the active page's pending
 * edits have saved or failed to; `hasPage` answers from the loaded tree.
 */
export type AssistantPorts = {
  session: number;
  activePage: string | null;
  indexRevision: number;
  openPage: (path: string, options: { newTab: boolean; at?: LinkAnchor }) => void;
  flushActive: () => Promise<void>;
  hasPage: (path: string) => boolean;
  /**
   * Saves the pending edits of the open pages among `paths`, and resolves once each has saved or
   * failed to: false when any could not be saved, so the caller writes nothing.
   */
  flushPages: (paths: string[]) => Promise<boolean>;
  /**
   * Takes in pages a core write wrote: each open page's editor takes the written text by its
   * saver's rules, and the tree refreshes; with `flash`, which only an accept sets, the pages'
   * rows then flash once.
   */
  pagesWritten: (pages: WrittenPage[], options: { flash: boolean }) => Promise<void>;
  /**
   * Takes in pages a core write deleted: each one's tab closes unless it holds unsaved text, which
   * stays with the missing-page notice, and the tree refreshes.
   */
  pagesDeleted: (paths: string[]) => Promise<void>;
  /** Shows a toast in this world, with an action such as Undo when `action` is given. */
  showToast: (message: string, action?: { label: string; run: () => void }) => void;
  /** Marks the tabs of `paths` as having changes waiting for review. */
  setReviewPaths: (paths: string[]) => void;
};

/**
 * What the world's screen hands to its layout: the tree, the tab strip, the page region and the
 * toasts, with the tree pane's width and overlay state, the assistant pane's open state, width
 * and overlay state, the assistant's ports, the conversation it shows, and whether a world change
 * runs. In the reading layout both panes are collapsed, and their overlay states are the reading
 * layout's own.
 */
export type WorldScreenParts = {
  tree: ReactNode;
  /**
   * Renders the tab strip; `treeToggle` is the button that opens the tree overlay, and
   * `assistantToggle` the Assistant button at the strip's right end.
   */
  tabStrip: (treeToggle: ReactNode, assistantToggle: ReactNode) => ReactNode;
  page: ReactNode;
  toasts: ReactNode;
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
  treeOverlayOpen: boolean;
  onTreeOverlayOpenChange: (open: boolean) => void;
  treeCollapsed: boolean;
  assistantOpen: boolean;
  onAssistantOpenChange: (open: boolean) => void;
  assistantWidth: number;
  onAssistantWidthChange: (width: number) => void;
  assistantOverlayOpen: boolean;
  onAssistantOverlayOpenChange: (open: boolean) => void;
  assistantCollapsed: boolean;
  assistantPorts: AssistantPorts;
  /** The conversation the assistant showed last in this world, or null for a new one. */
  assistantConversation: number | null;
  onAssistantConversationChange: (conversation: number | null) => void;
  changingWorld: boolean;
};

type WorldScreenProps = {
  /** The open world's session, which keys its tree and its pages' results. */
  session: number;
  worldName: string;
  /** The recent worlds without the open one, which the world menu lists first. */
  recentWorlds: RecentWorld[];
  onOpenRecent: (id: string) => void;
  onOpenWorld: () => void;
  onNewWorld: () => void;
  onCloseWorld: () => void;
  /** Saves a page, asking with the failed-save dialog while it cannot; false on Cancel. */
  confirmSaved: (path: string) => Promise<boolean>;
  /** Renders the quick open dialog; without it, Ctrl/Cmd+O and K and the Search button do nothing. */
  quickOpen?: (ports: QuickOpenPorts) => ReactNode;
  /** Opens Settings; without it, the world menu has no Settings… item. */
  onOpenSettings?: () => void;
  /** Lays out the screen's parts. */
  layout: (parts: WorldScreenParts) => ReactNode;
  /** Whether AI is on, which the History view's labels follow. */
  ai: boolean;
};

/**
 * The open world: the file tree, the tab strip and the active page. A page that stops being shown
 * saves at once; a page that closes saves first, with the failed-save dialog when it cannot.
 */
export function WorldScreen({
  session,
  worldName,
  recentWorlds,
  onOpenRecent,
  onOpenWorld,
  onNewWorld,
  onCloseWorld,
  confirmSaved,
  quickOpen,
  onOpenSettings,
  layout,
  ai,
}: WorldScreenProps) {
  const tabs = useWorldStore((store) => store.tabs);
  const active = useWorldStore((store) => store.active);
  const selectedFolder = useWorldStore((store) => store.selectedFolder);
  const nameInput = useWorldStore((store) => store.nameInput);
  const expanded = useWorldStore((store) => store.expanded);
  const treeWidth = useWorldStore((store) => store.treeWidth);
  const treeOverlayOpen = useWorldStore((store) => store.treeOverlayOpen);
  const assistantOpen = useWorldStore((store) => store.assistantOpen);
  const assistantWidth = useWorldStore((store) => store.assistantWidth);
  const assistantOverlayOpen = useWorldStore((store) => store.assistantOverlayOpen);
  const assistantConversation = useWorldStore((store) => store.assistantConversation);
  const reading = useWorldStore((store) => store.reading);
  const inReadingLayout = useWorldStore(readingLayout);
  const readingTreeOpen = useWorldStore((store) => store.readingTreeOpen);
  const readingAssistantOpen = useWorldStore((store) => store.readingAssistantOpen);
  const activeReady = useWorldStore(
    (store) => store.active !== null && store.pages[store.active]?.status === "ready",
  );
  const showingHistory = useWorldStore((store) => store.historyPath !== null);
  const worldNotices = useWorldStore((store) => store.worldNotices);
  const historyNotRecording = useWorldStore((store) => store.historyNotRecording);
  const toasts = useWorldStore((store) => store.toasts);
  const reviewPaths = useWorldStore((store) => store.reviewPaths);
  const flashedRows = useWorldStore((store) => store.flashedRows);
  const indexRevision = useWorldStore((store) => store.indexRevision);
  const changingWorld = useWorldStore((store) => store.changingWorld);
  const [searching, setSearching] = useState(false);
  const [comparing, setComparing] = useState(false);
  // A world change closes quick open; nothing from it reaches the next world.
  if (searching && changingWorld) setSearching(false);
  const {
    openPage,
    activate,
    closeTab,
    toggleFolder,
    setTreeWidth,
    setTreeOverlayOpen,
    setAssistantOpen,
    setAssistantWidth,
    setAssistantOverlayOpen,
    setAssistantConversation,
    setView,
    setReadingTreeOpen,
    setReadingAssistantOpen,
    flush,
    newEntryFolder,
    startNaming,
    setNameError,
    cancelNaming,
    pageCreated,
    folderCreated,
    showWorldNotice,
    showHistory,
    showToast,
    dismissToast,
    runToastAction,
    setReviewPaths,
    flashRows,
  } = useWorldStore.getState();
  const queryClient = useQueryClient();
  const treeKey = [...worldTreeKey, session];
  const tree = useQuery({ queryKey: treeKey, queryFn: worldTree });
  const worldMissing = (tree.error as IpcError | null)?.kind === "world_missing";

  useEffect(() => {
    if (worldMissing) showWorldNotice(session, "missing");
  }, [worldMissing, session, showWorldNotice]);
  /** Where focus was when the name input opened, to return it there when the input closes. */
  const focusBeforeNaming = useRef<Element | null>(null);
  const creating = useRef(false);

  /** Saves the active page, without a dialog, when `path` is about to take its place. */
  function flushActiveBefore(path: string) {
    const previous = useWorldStore.getState().active;
    if (previous !== null && previous !== path) void flush(previous);
  }

  function activateTab(path: string) {
    // Ctrl/Cmd+Tab in the editor switches pages; focus then moves to the new page's editor.
    const fromEditor = document.activeElement?.closest(".page-editor") != null;
    flushActiveBefore(path);
    activate(path, { focusEditor: fromEditor });
  }

  async function closeTabSaved(path: string) {
    if (await confirmSaved(path)) closeTab(path);
  }

  /**
   * Closes the active page from its own notice, saving first unless the text is discarded. Focus
   * then moves to the tab that takes its place, as after the tab strip's close button.
   */
  async function closeFromPage(path: string, { save }: { save: boolean }) {
    if (save && !(await confirmSaved(path))) return;
    flushSync(() => closeTab(path));
    document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }

  /**
   * Opens a page from the tree, or from a backlink or a followed link with the cursor at `at`.
   * Replacing the active tab's page closes that page, saving first.
   */
  async function openFromTree(
    path: string,
    options: { newTab: boolean; at?: CursorTarget; focusEditor?: boolean },
  ): Promise<void> {
    const { tabs, active } = useWorldStore.getState();
    if (options.newTab || active === null || tabs.includes(path)) {
      flushActiveBefore(path);
    } else if (!(await confirmSaved(active))) {
      return;
    } else if (useWorldStore.getState().active !== active) {
      // Another tab became active during the save, and it has not been saved: start over for it.
      return openFromTree(path, options);
    }
    openPage(path, options);
  }

  /** Opens quick open, once the active page's pending edits are saving. */
  function openQuickOpen() {
    const { active } = useWorldStore.getState();
    if (active !== null) void flush(active);
    setSearching(true);
  }

  /** Opens a page just created from quick open in a new tab, once the tree lists it. */
  async function quickOpenCreated(path: string) {
    await queryClient.invalidateQueries({ queryKey: treeKey });
    if (useWorldStore.getState().world?.session !== session) return;
    setTreeOverlayOpen(false);
    flushActiveBefore(path);
    pageCreated(path);
  }

  const quickOpenPorts: QuickOpenPorts = {
    session,
    activePage: active,
    indexRevision,
    openPage: (path, { newTab, at }) => {
      setTreeOverlayOpen(false);
      void openFromTree(path, { newTab, at, focusEditor: true });
    },
    pageCreated: (path) => void quickOpenCreated(path),
    refreshTree: () => void queryClient.invalidateQueries({ queryKey: treeKey }),
    showWorldMissing: () => showWorldNotice(session, "missing"),
    close: () => setSearching(false),
  };

  /** Saves the open pages among `paths`; false when any of them could not be saved. */
  async function flushPages(paths: string[]) {
    const results = await Promise.all(paths.map((path) => flush(path)));
    return results.every(({ kind }) => kind === "saved" || kind === "clean");
  }

  /** Puts written pages in their open tabs, then refreshes the tree and flashes their rows. */
  async function pagesWritten(pages: WrittenPage[], { flash }: { flash: boolean }) {
    await Promise.all(
      pages.map(async ({ path, text, version }) => {
        const page = useWorldStore.getState().pages[path];
        if (page?.status === "ready") {
          await page.saver.adoptWritten({ text, version }, pageEditor(session, path));
        }
      }),
    );
    // The watcher leaves the application's own writes out, so the tree is refreshed here, and
    // new pages' rows can flash only once it lists them.
    await queryClient.invalidateQueries({ queryKey: treeKey });
    if (!flash) return;
    flashRows(
      session,
      pages.map((page) => page.path),
    );
  }

  /** Closes the tabs of deleted pages that hold no unsaved text, then refreshes the tree. */
  async function pagesDeleted(paths: string[]) {
    await Promise.all(
      paths.map(async (path) => {
        const page = useWorldStore.getState().pages[path];
        if (page === undefined) return;
        if (page.status === "ready" && !(await page.saver.pageDeleted())) return;
        // Unless the tab closed or opened the page again meanwhile.
        if (useWorldStore.getState().pages[path] === page) closeTab(path);
      }),
    );
    await queryClient.invalidateQueries({ queryKey: treeKey });
  }

  const assistantPorts: AssistantPorts = {
    session,
    activePage: active,
    indexRevision,
    openPage: (path, { newTab, at }) => void openFromTree(path, { newTab, at }),
    flushActive: async () => {
      const { active } = useWorldStore.getState();
      if (active !== null) await flush(active);
    },
    // Until the tree has loaded, every page counts as there.
    hasPage: (path) => tree.data === undefined || treeHasPage(tree.data, path),
    flushPages,
    pagesWritten,
    pagesDeleted,
    showToast: (message, action) => showToast(session, message, action),
    setReviewPaths: (paths) => setReviewPaths(session, paths),
  };

  /** Opens a page from the tree in the current tab, as a click does, then shows its history. */
  async function openHistory(path: string) {
    await openFromTree(path, { newTab: false });
    showHistory(path);
  }

  /**
   * Opens the name input for a new page or folder in its target folder. From the page region
   * below 960px it opens the tree overlay; at 960px and wider the shell closes the overlay again.
   * In the reading layout it opens the collapsed tree.
   */
  function startNew(kind: TreeNameInput["kind"], rightClickedFolder?: string) {
    if (!useWorldStore.getState().nameInput) focusBeforeNaming.current = document.activeElement;
    startNaming(kind, newEntryFolder(rightClickedFolder));
    if (readingLayout(useWorldStore.getState())) setReadingTreeOpen(true);
    else setTreeOverlayOpen(true);
  }

  /**
   * The views can switch while a page tab shows its page's text: not during a world change, with
   * no page tab, while the page has no text to show, or while its History view or Compare shows.
   */
  const viewSwitchable = !changingWorld && activeReady && !showingHistory && !comparing;

  /**
   * Switches the active page tab to the other view, keeping the line at the top of the page.
   * With `focusPage`, the page keeps the focus it had.
   */
  function switchView({ focusPage }: { focusPage: boolean }) {
    const { active, pages, reading } = useWorldStore.getState();
    const page = active === null ? undefined : pages[active];
    const view = page?.status === "ready" ? page.view?.current : null;
    if (active === null || !view) return;
    switchKeepingTopLine(view, () => flushSync(() => setView(active, !reading.has(active))), {
      focus: focusPage,
    });
  }

  function returnFocusFromNaming() {
    const previous = focusBeforeNaming.current;
    focusBeforeNaming.current = null;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }

  function cancelNew() {
    returnFocusFromNaming();
    cancelNaming();
  }

  /** Asks the core to create the entry. Its errors keep the input open with their message. */
  async function submitName(name: string) {
    const request = useWorldStore.getState().nameInput;
    if (!request || creating.current) return;
    creating.current = true;
    try {
      const create = request.kind === "page" ? pageCreate : folderCreate;
      const { path } = await create(request.folder, name);
      await queryClient.invalidateQueries({ queryKey: treeKey });
      if (useWorldStore.getState().world?.session !== session) return;
      if (request.kind === "page") {
        focusBeforeNaming.current = null;
        flushActiveBefore(path);
        pageCreated(path);
        setTreeOverlayOpen(false);
      } else {
        returnFocusFromNaming();
        folderCreated(path);
      }
    } catch (error) {
      setNameError((error as IpcError).message);
    } finally {
      creating.current = false;
    }
  }

  /**
   * Window shortcuts, wherever focus is outside a modal dialog: Ctrl/Cmd+S saves the active page
   * at once, Ctrl/Cmd+N starts a new page, Ctrl/Cmd+Shift+N a new folder, Ctrl/Cmd+Shift+H shows
   * the active page's history, Ctrl/Cmd+E switches its view, and Ctrl/Cmd+O and Ctrl/Cmd+K open
   * quick open when there is one.
   */
  const shortcuts = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "e" && !event.shiftKey) {
      // Ctrl+E would otherwise go to a browser's search, so it is cancelled even where it does
      // nothing.
      event.preventDefault();
      if (!viewSwitchable || document.activeElement?.closest('[aria-modal="true"]')) return;
      const focusPage = document.activeElement?.closest("main") != null;
      switchView({ focusPage });
      return;
    }
    if (quickOpen && (key === "o" || key === "k") && !event.shiftKey) {
      // Ctrl+O would otherwise open a file, and Ctrl+K go to the browser's search, so both are
      // cancelled even where they open nothing.
      event.preventDefault();
      const { changingWorld } = useWorldStore.getState();
      if (!changingWorld && !document.activeElement?.closest('[aria-modal="true"]')) {
        openQuickOpen();
      }
      return;
    }
    const history = key === "h" && event.shiftKey;
    if (key !== "s" && key !== "n" && !history) return;
    // Ctrl+N would otherwise open a browser window, and Ctrl+Shift+H a browser's history, so
    // both are cancelled even where they do nothing.
    if (key === "n" || history) event.preventDefault();
    const { changingWorld, active } = useWorldStore.getState();
    if (changingWorld || document.activeElement?.closest('[aria-modal="true"]')) return;
    event.preventDefault();
    if (key === "n") startNew(event.shiftKey ? "folder" : "page");
    else if (active !== null && history) showHistory(active);
    else if (active !== null) void flush(active);
  });

  useEffect(() => {
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, []);

  function contextMenuItems(target: TreeEntry | null): MenuItem[] {
    if (!target) return newEntryItems;
    if (target.kind === "folder") {
      return [
        { id: "toggle", label: expanded.has(target.path) ? "Collapse" : "Expand" },
        ...newEntryItems,
      ];
    }
    return [
      { id: "open-new-tab", label: "Open in new tab", shortcut: "Ctrl+click" },
      { id: "history", label: "History", shortcut: historyShortcut },
    ];
  }

  function onContextMenuSelect(id: string, target: TreeEntry | null) {
    const folder = target?.kind === "folder" ? target.path : undefined;
    if (id === "new-page") startNew("page", folder);
    else if (id === "new-folder") startNew("folder", folder);
    else if (id === "toggle" && target) toggleFolder(target.path, !expanded.has(target.path));
    else if (id === "open-new-tab" && target) void openFromTree(target.path, { newTab: true });
    else if (id === "history" && target) void openHistory(target.path);
  }

  const worldMenuItems: MenuItem[] = [
    ...recentWorlds.map((world) => ({ id: `${recentItemPrefix}${world.id}`, label: world.name })),
    ...worldActionItems,
    ...(onOpenSettings ? [{ id: "settings", label: "Settings…", shortcut: settingsShortcut }] : []),
  ];

  function onWorldMenuSelect(id: string) {
    if (id.startsWith(recentItemPrefix)) onOpenRecent(id.slice(recentItemPrefix.length));
    else if (id === "open-world") onOpenWorld();
    else if (id === "new-world") onNewWorld();
    else if (id === "settings") onOpenSettings?.();
    else onCloseWorld();
  }

  const closePage = (path: string) => void closeTabSaved(path);

  return (
    <>
      {layout({
        treeWidth,
        onTreeWidthChange: setTreeWidth,
        treeOverlayOpen: inReadingLayout ? readingTreeOpen : treeOverlayOpen,
        onTreeOverlayOpenChange: inReadingLayout ? setReadingTreeOpen : setTreeOverlayOpen,
        treeCollapsed: inReadingLayout,
        assistantOpen,
        onAssistantOpenChange: setAssistantOpen,
        assistantWidth,
        onAssistantWidthChange: setAssistantWidth,
        assistantOverlayOpen: inReadingLayout ? readingAssistantOpen : assistantOverlayOpen,
        onAssistantOverlayOpenChange: inReadingLayout
          ? setReadingAssistantOpen
          : setAssistantOverlayOpen,
        assistantCollapsed: inReadingLayout,
        assistantPorts,
        assistantConversation,
        onAssistantConversationChange: setAssistantConversation,
        changingWorld,
        tree:
          // Until the first listing arrives, an empty pane, not the empty-world message.
          tree.isPending ? (
            <div className="h-full bg-window" />
          ) : (
            <FileTree
              worldName={worldName}
              entries={tree.data ?? []}
              expanded={expanded}
              selected={selectedFolder ?? active ?? undefined}
              flashed={flashedRows}
              worldMenuItems={worldMenuItems}
              onWorldMenuSelect={onWorldMenuSelect}
              contextMenuItems={contextMenuItems}
              onContextMenuSelect={onContextMenuSelect}
              nameInput={nameInput ?? undefined}
              onOpen={(path, { newTab }) => {
                setTreeOverlayOpen(false);
                void openFromTree(path, { newTab });
              }}
              onToggle={toggleFolder}
              onSearch={quickOpen && openQuickOpen}
              searchShortcut={quickOpen && searchShortcut}
              onNewPage={() => startNew("page")}
              onNewFolder={() => startNew("folder")}
              newPageShortcut={newPageShortcut}
              newFolderShortcut={newFolderShortcut}
              onNameSubmit={(name) => void submitName(name)}
              onNameCancel={cancelNew}
            />
          ),
        tabStrip: (treeToggle, assistantToggle) => (
          <TabStrip
            tabs={tabs.map((path) => ({
              id: path,
              label: pageNameOf(path),
              pending: reviewPaths.has(path),
            }))}
            activeId={active ?? undefined}
            onActivate={activateTab}
            onClose={closePage}
            leading={treeToggle}
            trailing={
              <>
                <IconButton
                  icon={inReadingLayout ? "edit" : "menu_book"}
                  label={inReadingLayout ? "Editing view" : "Reading view"}
                  shortcut={viewShortcut}
                  disabled={!viewSwitchable}
                  onClick={() => switchView({ focusPage: false })}
                />
                {assistantToggle}
              </>
            }
          />
        ),
        toasts: <ToastRegion toasts={toasts} onDismiss={dismissToast} onAction={runToastAction} />,
        page: (
          <div className="flex h-full flex-col">
            {worldNotices.has("missing") && (
              <Notice
                status="error"
                actions={
                  <Button variant="secondary" onClick={onCloseWorld}>
                    Close world
                  </Button>
                }
              >
                The world's folder cannot be found.
              </Notice>
            )}
            {worldNotices.has("watch_failed") && (
              <Notice status="warning">
                Outside changes may not appear until the world is reopened.
              </Notice>
            )}
            {historyNotRecording !== null && (
              <Notice status="warning">
                Changes to this world are not being recorded in history and cannot be undone.{" "}
                {historyNotRecording}
              </Notice>
            )}
            {worldNotices.has("history_set_aside") && (
              <Notice status="warning">
                This world's earlier history could not be read and was set aside. New changes are
                recorded.
              </Notice>
            )}
            {tree.isError && !worldMissing && (
              <Notice status="error">
                The world's pages cannot be listed: {tree.error.message}
              </Notice>
            )}
            <div className="min-h-0 flex-1">
              {active ? (
                <PageTab
                  key={active}
                  path={active}
                  session={session}
                  ai={ai}
                  reading={reading.has(active)}
                  onComparingChange={setComparing}
                  onClose={(path) => void closeFromPage(path, { save: true })}
                  onDiscard={(path) => void closeFromPage(path, { save: false })}
                  onOpenPage={(path, options) => void openFromTree(path, options)}
                  onCreateLink={(from, link) =>
                    void createFromLink(session, from, link, {
                      refreshTree: () => queryClient.invalidateQueries({ queryKey: treeKey }),
                      open: (path, at) => void openFromTree(path, { newTab: true, at }),
                    })
                  }
                />
              ) : (
                <NoPageOpen onNewPage={() => startNew("page")} />
              )}
            </div>
          </div>
        ),
      })}
      {searching && quickOpen?.(quickOpenPorts)}
    </>
  );
}
