import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef } from "react";
import type { IpcError } from "../../lib/ipc";
import { FileTree, type TreeEntry, type TreeNameInput } from "../../ui/FileTree";
import type { MenuItem } from "../../ui/Menu";
import { Notice } from "../../ui/Notice";
import { NoPageOpen } from "../../ui/PageView";
import { Shell } from "../../ui/Shell";
import { TabStrip } from "../../ui/TabStrip";
import { folderCreate, pageCreate, worldTree, worldTreeKey } from "./commands";
import { useSaveConfirmation } from "./FailedSaveDialog";
import { PageTab } from "./PageTab";
import { pageNameOf, useWorldStore } from "./store";

const newPageShortcut = "Ctrl+N";
const newFolderShortcut = "Ctrl+Shift+N";

const worldMenuItems: MenuItem[] = [
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
  onOpenWorld: () => void;
  onNewWorld: () => void;
  onCloseWorld: () => void;
};

/**
 * The open world: the file tree, the tab strip and the active page. A page that stops being shown
 * saves at once; a page that closes saves first, with the failed-save dialog when it cannot.
 */
export function WorldScreen({
  session,
  worldName,
  onOpenWorld,
  onNewWorld,
  onCloseWorld,
}: WorldScreenProps) {
  const tabs = useWorldStore((store) => store.tabs);
  const active = useWorldStore((store) => store.active);
  const selectedFolder = useWorldStore((store) => store.selectedFolder);
  const nameInput = useWorldStore((store) => store.nameInput);
  const expanded = useWorldStore((store) => store.expanded);
  const treeWidth = useWorldStore((store) => store.treeWidth);
  const treeOverlayOpen = useWorldStore((store) => store.treeOverlayOpen);
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
  } = useWorldStore.getState();
  const queryClient = useQueryClient();
  const treeKey = [...worldTreeKey, session];
  const tree = useQuery({ queryKey: treeKey, queryFn: worldTree });
  const { confirmSaved, failedSaveDialog } = useSaveConfirmation();
  /** Where focus was when the name input opened, to return it there when the input closes. */
  const focusBeforeNaming = useRef<Element | null>(null);
  const creating = useRef(false);

  /** Saves the active page, without a dialog, when `path` is about to take its place. */
  function flushActiveBefore(path: string) {
    const previous = useWorldStore.getState().active;
    if (previous !== null && previous !== path) void flush(previous);
  }

  function activateTab(path: string) {
    flushActiveBefore(path);
    activate(path);
  }

  async function closeTabSaved(path: string) {
    if (await confirmSaved(path)) closeTab(path);
  }

  /** Opens a page from the tree. Replacing the active tab's page closes that page, saving first. */
  async function openFromTree(path: string, { newTab }: { newTab: boolean }): Promise<void> {
    const { tabs, active } = useWorldStore.getState();
    if (newTab || active === null || tabs.includes(path)) {
      flushActiveBefore(path);
    } else if (!(await confirmSaved(active))) {
      return;
    } else if (useWorldStore.getState().active !== active) {
      // Another tab became active during the save, and it has not been saved: start over for it.
      return openFromTree(path, { newTab });
    }
    openPage(path, { newTab });
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
   * at once, Ctrl/Cmd+N starts a new page and Ctrl/Cmd+Shift+N a new folder.
   */
  const shortcuts = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== "s" && key !== "n") return;
    // Ctrl+N would otherwise open a browser window, so it is cancelled even where it does nothing.
    if (key === "n") event.preventDefault();
    const { changingWorld, active } = useWorldStore.getState();
    if (changingWorld || document.activeElement?.closest('[aria-modal="true"]')) return;
    event.preventDefault();
    if (key === "n") startNew(event.shiftKey ? "folder" : "page");
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
    return [{ id: "open-new-tab", label: "Open in new tab", shortcut: "Ctrl+click" }];
  }

  function onContextMenuSelect(id: string, target: TreeEntry | null) {
    const folder = target?.kind === "folder" ? target.path : undefined;
    if (id === "new-page") startNew("page", folder);
    else if (id === "new-folder") startNew("folder", folder);
    else if (id === "toggle" && target) toggleFolder(target.path, !expanded.has(target.path));
    else if (id === "open-new-tab" && target) void openFromTree(target.path, { newTab: true });
  }

  function onWorldMenuSelect(id: string) {
    if (id === "open-world") onOpenWorld();
    else if (id === "new-world") onNewWorld();
    else onCloseWorld();
  }

  const closePage = (path: string) => void closeTabSaved(path);

  return (
    <>
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
        page={
          <div className="flex h-full flex-col">
            {tree.isError && (
              <Notice status="error">
                The world's pages cannot be listed: {tree.error.message}
              </Notice>
            )}
            <div className="min-h-0 flex-1">
              {active ? (
                <PageTab key={active} path={active} session={session} onClose={closePage} />
              ) : (
                <NoPageOpen onNewPage={() => startNew("page")} />
              )}
            </div>
          </div>
        }
      />
      {failedSaveDialog}
    </>
  );
}
