import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import { flushSync } from "react-dom";
import type { IpcError } from "@/lib/ipc";
import type { RecentWorld, TreeEntry } from "@/types/api";
import { Button } from "@/ui/Button";
import { FileTree, type TreeNameInput } from "@/ui/FileTree";
import type { MenuItem } from "@/ui/Menu";
import { Notice } from "@/ui/Notice";
import { NoPageOpen } from "@/ui/PageView";
import { Shell } from "@/ui/Shell";
import { TabStrip } from "@/ui/TabStrip";
import { ToastRegion } from "@/ui/Toast";
import { folderCreate, pageCreate, worldTree, worldTreeKey } from "../api/commands";
import { createFromLink } from "../logic/links";
import { type CursorTarget, useWorldStore } from "../stores/world-store";
import { pageNameOf } from "../utils/paths";
import { PageTab } from "./PageTab";

const newPageShortcut = "Ctrl+N";
const newFolderShortcut = "Ctrl+Shift+N";
const historyShortcut = "Ctrl+Shift+H";

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
}: WorldScreenProps) {
  const tabs = useWorldStore((store) => store.tabs);
  const active = useWorldStore((store) => store.active);
  const selectedFolder = useWorldStore((store) => store.selectedFolder);
  const nameInput = useWorldStore((store) => store.nameInput);
  const expanded = useWorldStore((store) => store.expanded);
  const treeWidth = useWorldStore((store) => store.treeWidth);
  const treeOverlayOpen = useWorldStore((store) => store.treeOverlayOpen);
  const worldNotices = useWorldStore((store) => store.worldNotices);
  const historyNotRecording = useWorldStore((store) => store.historyNotRecording);
  const toasts = useWorldStore((store) => store.toasts);
  const {
    openPage,
    activate,
    closeTab,
    toggleFolder,
    setTreeWidth,
    setTreeOverlayOpen,
    flush,
    newEntryFolder,
    startNaming,
    setNameError,
    cancelNaming,
    pageCreated,
    folderCreated,
    showWorldNotice,
    showHistory,
    dismissToast,
    runToastAction,
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
    options: { newTab: boolean; at?: CursorTarget },
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

  /** Opens a page from the tree in the current tab, as a click does, then shows its history. */
  async function openHistory(path: string) {
    await openFromTree(path, { newTab: false });
    showHistory(path);
  }

  /**
   * Opens the name input for a new page or folder in its target folder. From the page region
   * below 960px it opens the tree overlay; at 960px and wider the shell closes the overlay again.
   */
  function startNew(kind: TreeNameInput["kind"], rightClickedFolder?: string) {
    if (!useWorldStore.getState().nameInput) focusBeforeNaming.current = document.activeElement;
    startNaming(kind, newEntryFolder(rightClickedFolder));
    setTreeOverlayOpen(true);
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
   * at once, Ctrl/Cmd+N starts a new page, Ctrl/Cmd+Shift+N a new folder, and Ctrl/Cmd+Shift+H
   * shows the active page's history.
   */
  const shortcuts = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
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
  ];

  function onWorldMenuSelect(id: string) {
    if (id.startsWith(recentItemPrefix)) onOpenRecent(id.slice(recentItemPrefix.length));
    else if (id === "open-world") onOpenWorld();
    else if (id === "new-world") onNewWorld();
    else onCloseWorld();
  }

  const closePage = (path: string) => void closeTabSaved(path);

  return (
    <Shell
      treeWidth={treeWidth}
      onTreeWidthChange={setTreeWidth}
      treeOverlayOpen={treeOverlayOpen}
      onTreeOverlayOpenChange={setTreeOverlayOpen}
      tree={
        // Until the first listing arrives, an empty pane, not the empty-world message.
        tree.isPending ? (
          <div className="h-full bg-window" />
        ) : (
          <FileTree
            worldName={worldName}
            entries={tree.data ?? []}
            expanded={expanded}
            selected={selectedFolder ?? active ?? undefined}
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
            onNewPage={() => startNew("page")}
            onNewFolder={() => startNew("folder")}
            newPageShortcut={newPageShortcut}
            newFolderShortcut={newFolderShortcut}
            onNameSubmit={(name) => void submitName(name)}
            onNameCancel={cancelNew}
          />
        )
      }
      tabStrip={(treeToggle) => (
        <TabStrip
          tabs={tabs.map((path) => ({ id: path, label: pageNameOf(path) }))}
          activeId={active ?? undefined}
          onActivate={activateTab}
          onClose={closePage}
          leading={treeToggle}
        />
      )}
      toasts={<ToastRegion toasts={toasts} onDismiss={dismissToast} onAction={runToastAction} />}
      page={
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
            <Notice status="error">The world's pages cannot be listed: {tree.error.message}</Notice>
          )}
          <div className="min-h-0 flex-1">
            {active ? (
              <PageTab
                key={active}
                path={active}
                session={session}
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
      }
    />
  );
}
