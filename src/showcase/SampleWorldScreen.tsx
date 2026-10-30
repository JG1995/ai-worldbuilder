import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FileTree, type TreeEntry, type TreeNameInput } from "../ui/FileTree";
import type { MenuItem } from "../ui/Menu";
import { NoPageOpen, PageView } from "../ui/PageView";
import { defaultTreeWidth, Shell } from "../ui/Shell";
import { type Tab, TabStrip } from "../ui/TabStrip";
import { type Toast, ToastRegion } from "../ui/Toast";
import { WelcomeScreen } from "../ui/WelcomeScreen";
import { closeTab } from "./ShellSections";
import { ModeSwitch } from "./Showcase";
import {
  largeSampleWorld,
  samplePageParagraphs,
  sampleRecentWorlds,
  sampleSelectedPath,
  sampleTree,
  sampleTreeExpanded,
  sampleWorldName,
} from "./sample-data";

// Every name, label and message here is sample data, and nothing is created or deleted. The build
// guard in vite.config.ts keeps this module out of production builds.

const pagesOf = (entries: TreeEntry[]): TreeEntry[] =>
  entries.flatMap((entry) => (entry.kind === "page" ? [entry] : pagesOf(entry.children ?? [])));

const toTab = (page: TreeEntry): Tab => ({ id: page.path, label: page.name });

const samplePages = pagesOf(sampleTree);
const initialTabs = ["Saltmere", "Þórr", "Tide charts that the harbour guild drew"].flatMap(
  (name) =>
    samplePages
      .filter((page) => page.name.startsWith(name))
      .slice(0, 1)
      .map(toTab),
);

const worldMenu: MenuItem[] = [
  { id: "new-page", label: "New page", shortcut: "Ctrl+N" },
  { id: "close-world", label: "Close world" },
];

// Built on first use, so the screen opens quickly.
let largeWorld: ReturnType<typeof largeSampleWorld> | undefined;

/**
 * The composed sample screen at /showcase.html#sample-world: the shell with the file tree, tab
 * strip, page view and toasts, or the welcome screen. All of its state is local.
 */
export function SampleWorldScreen() {
  const [large, setLarge] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(sampleTreeExpanded));
  const [tabs, setTabs] = useState(initialTabs);
  const [activeId, setActiveId] = useState<string | undefined>(sampleSelectedPath);
  const [treeWidth, setTreeWidth] = useState(defaultTreeWidth);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [nameInput, setNameInput] = useState<TreeNameInput>();
  const [toDelete, setToDelete] = useState<TreeEntry>();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastCount = useRef(0);
  const toastTimer = useRef<number>(undefined);
  const entries = large ? (largeWorld?.tree ?? []) : sampleTree;
  const pages = useMemo(() => pagesOf(entries), [entries]);
  const activeTab = tabs.find((tab) => tab.id === activeId);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  function pushToast(message: string, action?: string) {
    const id = String(toastCount.current++);
    setToasts((current) => [...current, { id, message, action }]);
  }

  function dismissToast(id: string) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function chooseLarge(next: boolean) {
    largeWorld ??= largeSampleWorld();
    setLarge(next);
    setExpanded(new Set(next ? largeWorld.folderPaths : sampleTreeExpanded));
    setNameInput(undefined);
  }

  function openPage(path: string, newTab: boolean) {
    const page = pages.find((entry) => entry.path === path);
    if (!page) return;
    setTabs((current) =>
      current.some((tab) => tab.id === path) ? current : [...current, toTab(page)],
    );
    if (newTab) return;
    setActiveId(path);
    setOverlayOpen(false);
  }

  function closePage(id: string) {
    const next = closeTab(tabs, activeId, id);
    setTabs(next.tabs);
    setActiveId(next.activeId);
  }

  function toggleFolder(path: string, open: boolean) {
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  // From the page region, the input must show in the tree, which is a closed overlay below 960px.
  function askForPageName() {
    setNameInput({ kind: "page", folder: null });
    setOverlayOpen(true);
  }

  function submitName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameInput({ kind: "page", folder: null, error: "Enter a name for the page." });
      return;
    }
    setNameInput(undefined);
    pushToast(`Sample only: no page "${trimmed}" was created`);
  }

  function contextMenuItems(target: TreeEntry | null): MenuItem[] {
    if (!target) return [worldMenu[0]];
    if (target.kind === "folder") {
      return [{ id: "toggle", label: expanded.has(target.path) ? "Collapse" : "Expand" }];
    }
    return [
      { id: "open-new-tab", label: "Open in new tab", shortcut: "Ctrl+click" },
      { id: "delete", label: "Delete…", shortcut: "Delete", destructive: true },
    ];
  }

  function onContextMenuSelect(id: string, target: TreeEntry | null) {
    if (id === "new-page") setNameInput({ kind: "page", folder: null });
    else if (!target) return;
    else if (id === "toggle") toggleFolder(target.path, !expanded.has(target.path));
    else if (id === "open-new-tab") openPage(target.path, true);
    else if (id === "delete") setToDelete(target);
  }

  function confirmDelete() {
    if (!toDelete) return;
    if (tabs.some((tab) => tab.id === toDelete.path)) closePage(toDelete.path);
    pushToast(`Deleted "${toDelete.name}"`, "Undo");
    setToDelete(undefined);
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-divider border-b bg-window px-4 py-2">
        <h1 className="ui-strong">Sample world screen</h1>
        <span className="label-caps text-text-muted">Sample data</span>
        <label className="ui flex items-center gap-2">
          <input
            type="checkbox"
            checked={large}
            onChange={(change) => chooseLarge(change.currentTarget.checked)}
            className="accent-accent"
          />
          Large sample world
        </label>
        <label className="ui flex items-center gap-2">
          <input
            type="checkbox"
            checked={welcome}
            onChange={(change) => setWelcome(change.currentTarget.checked)}
            className="accent-accent"
          />
          Welcome screen
        </label>
        <Button
          variant="secondary"
          disabled={large}
          onClick={() =>
            setTabs((current) => [
              ...current,
              ...samplePages
                .filter((page) => !current.some((tab) => tab.id === page.path))
                .map(toTab),
            ])
          }
        >
          Open every page
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            window.clearTimeout(toastTimer.current);
            toastTimer.current = window.setTimeout(
              () => pushToast("Sample toast, pushed after 2 seconds"),
              2000,
            );
          }}
        >
          Push a toast in 2 seconds
        </Button>
        <ModeSwitch />
        <a href="#showcase" className="ui ml-auto text-accent underline">
          Back to the showcase
        </a>
      </header>
      <div className="min-h-0 flex-1">
        {welcome ? (
          <WelcomeScreen
            recentWorlds={sampleRecentWorlds}
            onOpenWorld={() => setWelcome(false)}
            onNewWorld={() => setWelcome(false)}
            onChooseRecent={() => setWelcome(false)}
            onRemoveRecent={() => {}}
          />
        ) : (
          <Shell
            treeWidth={treeWidth}
            onTreeWidthChange={setTreeWidth}
            treeOverlayOpen={overlayOpen}
            onTreeOverlayOpenChange={setOverlayOpen}
            tree={
              <FileTree
                worldName={large ? "Large sample world" : sampleWorldName}
                entries={entries}
                expanded={expanded}
                selected={activeId}
                worldMenuItems={worldMenu}
                onWorldMenuSelect={(id) => {
                  if (id === "new-page") setNameInput({ kind: "page", folder: null });
                  else setWelcome(true);
                }}
                contextMenuItems={contextMenuItems}
                onContextMenuSelect={onContextMenuSelect}
                nameInput={nameInput}
                onOpen={(path, { newTab }) => openPage(path, newTab)}
                onToggle={toggleFolder}
                onNewPage={() => setNameInput({ kind: "page", folder: null })}
                onNewFolder={() => pushToast("Sample only: folders are not created here")}
                onNameSubmit={submitName}
                onNameCancel={() => setNameInput(undefined)}
              />
            }
            tabStrip={(treeToggle) => (
              <TabStrip
                tabs={tabs}
                activeId={activeId}
                onActivate={setActiveId}
                onClose={closePage}
                leading={treeToggle}
              />
            )}
            page={
              activeTab ? (
                <PageView key={activeTab.id} title={activeTab.label}>
                  <p className="label-caps text-text-muted">Sample page text</p>
                  {samplePageParagraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </PageView>
              ) : (
                <NoPageOpen onNewPage={askForPageName} />
              )
            }
            toasts={
              <ToastRegion toasts={toasts} onDismiss={dismissToast} onAction={dismissToast} />
            }
          />
        )}
      </div>
      {toDelete && (
        <Dialog
          title={`Delete "${toDelete.name}"?`}
          onCancel={() => setToDelete(undefined)}
          actions={
            <>
              <Button variant="secondary" onClick={() => setToDelete(undefined)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmDelete}>
                Delete
              </Button>
            </>
          }
        >
          This is sample data: nothing is deleted.
        </Dialog>
      )}
    </div>
  );
}
