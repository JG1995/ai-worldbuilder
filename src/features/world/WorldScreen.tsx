import { useQuery } from "@tanstack/react-query";
import { FileTree, type TreeEntry } from "../../ui/FileTree";
import type { MenuItem } from "../../ui/Menu";
import { Notice } from "../../ui/Notice";
import { NoPageOpen } from "../../ui/PageView";
import { Shell } from "../../ui/Shell";
import { TabStrip } from "../../ui/TabStrip";
import { worldTree, worldTreeKey } from "./commands";
import { PageTab } from "./PageTab";
import { pageNameOf, useWorldStore } from "./store";

const worldMenuItems: MenuItem[] = [
  { id: "open-world", label: "Open world…" },
  { id: "close-world", label: "Close world" },
];

// New page and New folder arrive with world creation; until then their controls do nothing.
const notYet = () => {};

type WorldScreenProps = {
  /** The open world's session, which keys its tree. */
  session: number;
  worldName: string;
  onOpenWorld: () => void;
  onCloseWorld: () => void;
};

/** The open world: the file tree, the tab strip and the active page. */
export function WorldScreen({ session, worldName, onOpenWorld, onCloseWorld }: WorldScreenProps) {
  const tabs = useWorldStore((store) => store.tabs);
  const active = useWorldStore((store) => store.active);
  const expanded = useWorldStore((store) => store.expanded);
  const treeWidth = useWorldStore((store) => store.treeWidth);
  const treeOverlayOpen = useWorldStore((store) => store.treeOverlayOpen);
  const { openPage, activate, closeTab, toggleFolder, setTreeWidth, setTreeOverlayOpen } =
    useWorldStore.getState();
  const tree = useQuery({ queryKey: [...worldTreeKey, session], queryFn: worldTree });

  function contextMenuItems(target: TreeEntry | null): MenuItem[] {
    if (!target) {
      return [
        { id: "new-page", label: "New page", disabled: true },
        { id: "new-folder", label: "New folder", disabled: true },
      ];
    }
    if (target.kind === "folder") {
      return [{ id: "toggle", label: expanded.has(target.path) ? "Collapse" : "Expand" }];
    }
    return [{ id: "open-new-tab", label: "Open in new tab", shortcut: "Ctrl+click" }];
  }

  function onContextMenuSelect(id: string, target: TreeEntry | null) {
    if (!target) return;
    if (id === "toggle") toggleFolder(target.path, !expanded.has(target.path));
    else if (id === "open-new-tab") openPage(target.path, { newTab: true });
  }

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
            selected={active ?? undefined}
            worldMenuItems={worldMenuItems}
            onWorldMenuSelect={(id) => (id === "open-world" ? onOpenWorld() : onCloseWorld())}
            contextMenuItems={contextMenuItems}
            onContextMenuSelect={onContextMenuSelect}
            onOpen={(path, { newTab }) => {
              openPage(path, { newTab });
              setTreeOverlayOpen(false);
            }}
            onToggle={toggleFolder}
            onNewPage={notYet}
            onNewFolder={notYet}
            onNameSubmit={notYet}
            onNameCancel={notYet}
          />
        )
      }
      tabStrip={(treeToggle) => (
        <TabStrip
          tabs={tabs.map((path) => ({ id: path, label: pageNameOf(path) }))}
          activeId={active ?? undefined}
          onActivate={activate}
          onClose={closeTab}
          leading={treeToggle}
        />
      )}
      page={
        <div className="flex h-full flex-col">
          {tree.isError && (
            <Notice status="error">The world's pages cannot be listed: {tree.error.message}</Notice>
          )}
          <div className="min-h-0 flex-1">
            {active ? <PageTab key={active} path={active} /> : <NoPageOpen onNewPage={notYet} />}
          </div>
        </div>
      }
    />
  );
}
