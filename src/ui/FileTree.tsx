import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";
import { Menu, MenuButton, type MenuItem } from "./Menu";
import { TextInput } from "./TextInput";
import { type Point, type Rect, usePopoverPosition } from "./Tooltip";

export type TreeEntry = {
  path: string;
  name: string;
  kind: "folder" | "page";
  children?: TreeEntry[];
};

/** A request for an inline name input at the top of a folder. */
export type TreeNameInput = {
  /** The folder's path, or null for the world's top level. The caller expands the folder. */
  folder: string | null;
  kind: "folder" | "page";
  error?: string;
};

type FileTreeProps = {
  worldName: string;
  /** The world's entries, shown in this order. */
  entries: TreeEntry[];
  expanded: ReadonlySet<string>;
  selected?: string;
  worldMenuItems: MenuItem[];
  onWorldMenuSelect: (id: string) => void;
  /** The context menu items for an entry, or for the tree's empty space when `target` is null. */
  contextMenuItems: (target: TreeEntry | null) => MenuItem[];
  onContextMenuSelect: (id: string, target: TreeEntry | null) => void;
  /** Shown until the caller removes it. */
  nameInput?: TreeNameInput;
  onOpen: (path: string, options: { newTab: boolean }) => void;
  onToggle: (path: string, expanded: boolean) => void;
  onNewPage: () => void;
  onNewFolder: () => void;
  onNameSubmit: (name: string) => void;
  onNameCancel: () => void;
};

/** A visible entry. `group` is the index of its top-level entry, whose subtree it belongs to. */
type Row = { entry: TreeEntry; level: number; parent: string | null; group: number };

const tooltipDelay = 500;

// Indent: the row's own 8px, then 16px per level.
const indent = (level: number) => 8 + (level - 1) * 16;

/** The rows of the visible entries, in order: only expanded folders show their children. */
function visibleRows(entries: TreeEntry[], expanded: ReadonlySet<string>) {
  const rows: Row[] = [];
  const groups: Row[][] = [];
  const indexOf = new Map<string, number>();
  const visit = (list: TreeEntry[], level: number, parent: string | null) => {
    for (const entry of list) {
      if (level === 1) groups.push([]);
      const row = { entry, level, parent, group: groups.length - 1 };
      indexOf.set(entry.path, rows.length);
      rows.push(row);
      groups[row.group].push(row);
      if (entry.children && expanded.has(entry.path)) visit(entry.children, level + 1, entry.path);
    }
  };
  visit(entries, 1, null);
  return { rows, groups, indexOf };
}

function rowOf(target: EventTarget) {
  return target instanceof Element ? target.closest<HTMLElement>('[role="treeitem"]') : null;
}

type TreeRowProps = {
  entry: TreeEntry;
  level: number;
  expanded: boolean;
  selected: boolean;
  tabbable: boolean;
};

// Memoized and free of callbacks: the tree handles events for every row.
const TreeRow = memo(function TreeRow({
  entry,
  level,
  expanded,
  selected,
  tabbable,
}: TreeRowProps) {
  const folder = entry.kind === "folder";
  const iconColour = selected ? "text-text" : "text-text-muted";

  return (
    <div
      role="treeitem"
      data-path={entry.path}
      aria-level={level}
      aria-expanded={folder ? expanded : undefined}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      style={{ paddingLeft: indent(level) }}
      className={`ui relative flex h-tree-row cursor-default select-none items-center gap-1 pr-2 transition-colors focus-visible:-outline-offset-2 ${
        selected
          ? "bg-selected text-text before:absolute before:inset-y-0 before:left-0 before:border-accent before:border-l-2"
          : "text-text-muted hover:bg-hover hover:text-text"
      }`}
    >
      <span className={`flex w-4 shrink-0 ${iconColour}`}>
        {folder && <Icon name={expanded ? "expand_more" : "chevron_right"} />}
      </span>
      <span className={`flex shrink-0 ${iconColour}`}>
        <Icon name={folder ? (expanded ? "folder_open" : "folder") : "description"} />
      </span>
      <span data-name className="min-w-0 flex-1 truncate">
        {entry.name}
      </span>
    </div>
  );
});

type RowGroupProps = {
  rows: Row[];
  expanded: ReadonlySet<string>;
  /** Passed only to the group that holds them, so the other groups skip rendering. */
  selected?: string;
  tabStop?: string;
  nameInput?: { after: string; node: ReactNode };
};

/**
 * The rows of one top-level entry's subtree. Grouping lets a focus move in a large tree re-render
 * one or two groups instead of every row, and a group's rows never move to another group, so an
 * expand or collapse elsewhere never remounts the focused row.
 */
const RowGroup = memo(function RowGroup({
  rows,
  expanded,
  selected,
  tabStop,
  nameInput,
}: RowGroupProps) {
  const items: ReactNode[] = rows.map(({ entry, level }) => (
    <TreeRow
      key={entry.path}
      entry={entry}
      level={level}
      expanded={expanded.has(entry.path)}
      selected={entry.path === selected}
      tabbable={entry.path === tabStop}
    />
  ));
  if (nameInput) {
    items.splice(
      rows.findIndex((row) => row.entry.path === nameInput.after) + 1,
      0,
      nameInput.node,
    );
  }
  return items;
});

/** The name input that a caller asks for. It reports Enter and Escape and stays until removed. */
function NameInput({
  request,
  level,
  onSubmit,
  onCancel,
}: {
  request: TreeNameInput;
  level: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  return (
    <div className="py-0.5 pr-2" style={{ paddingLeft: indent(level) }}>
      <TextInput
        ref={input}
        label={request.kind === "folder" ? "New folder name" : "New page name"}
        hideLabel
        size="compact"
        error={request.error}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
    </div>
  );
}

/** The full name of a truncated row, shared by every row. It repeats the row's own name. */
function NameTooltip({ anchor }: { anchor: Element }) {
  const tooltip = useRef<HTMLDivElement>(null);
  const position = usePopoverPosition(tooltip, anchor, "start");

  return (
    <div
      ref={tooltip}
      aria-hidden="true"
      style={position}
      className="ui-small pointer-events-none z-(--z-menu) max-w-80 break-words rounded-md border border-divider bg-raised px-2 py-1 text-text shadow-(--level-2-shadow)"
    >
      {anchor.textContent}
    </div>
  );
}

type ContextMenuState = { at: Point | Rect; target: TreeEntry | null };

/**
 * The world's file tree: a header with the world name and actions, then the visible entries as a
 * tree with roving focus. It reports every request to its caller and holds only focus, the open
 * menu and the name tooltip.
 */
export function FileTree({
  worldName,
  entries,
  expanded,
  selected,
  worldMenuItems,
  onWorldMenuSelect,
  contextMenuItems,
  onContextMenuSelect,
  nameInput,
  onOpen,
  onToggle,
  onNewPage,
  onNewFolder,
  onNameSubmit,
  onNameCancel,
}: FileTreeProps) {
  const tree = useRef<HTMLDivElement>(null);
  const tooltipTimer = useRef<number>(undefined);
  const [focused, setFocused] = useState<string>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [tooltipAnchor, setTooltipAnchor] = useState<Element | null>(null);
  const { rows, groups, indexOf } = useMemo(
    () => visibleRows(entries, expanded),
    [entries, expanded],
  );

  // The tab stop is the last focused row while it is visible, else the selected row, else the first.
  const tabStop =
    [focused, selected].find((path) => path !== undefined && indexOf.has(path)) ??
    rows[0]?.entry.path;

  useEffect(() => () => window.clearTimeout(tooltipTimer.current), []);

  // Any scroll would leave the fixed tooltip behind its row, so it closes.
  useEffect(() => {
    if (!tooltipAnchor) return;
    const close = () => setTooltipAnchor(null);
    document.addEventListener("scroll", close, true);
    return () => document.removeEventListener("scroll", close, true);
  }, [tooltipAnchor]);

  function focusRow(index: number) {
    tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[index]?.focus();
  }

  function activate(entry: TreeEntry, newTab: boolean) {
    if (entry.kind === "page") onOpen(entry.path, { newTab });
    else onToggle(entry.path, !expanded.has(entry.path));
  }

  function showTooltipLater(row: HTMLElement) {
    window.clearTimeout(tooltipTimer.current);
    const name = row.querySelector("[data-name]");
    if (!name || name.scrollWidth <= name.clientWidth) {
      setTooltipAnchor(null);
      return;
    }
    tooltipTimer.current = window.setTimeout(() => setTooltipAnchor(name), tooltipDelay);
  }

  function hideTooltip() {
    window.clearTimeout(tooltipTimer.current);
    setTooltipAnchor(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const row = event.target as HTMLElement;
    if (row.getAttribute("role") !== "treeitem") return;
    const index = indexOf.get(row.dataset.path ?? "");
    if (index === undefined) return;
    const { entry, parent } = rows[index];
    const isOpenFolder = entry.kind === "folder" && expanded.has(entry.path);

    // Escape only closes the name tooltip; a parent such as an overlay may still act on it.
    if (event.key === "Escape") hideTooltip();
    const key = event.shiftKey && event.key === "F10" ? "ContextMenu" : event.key;
    switch (key) {
      case "ArrowDown":
        focusRow(Math.min(index + 1, rows.length - 1));
        break;
      case "ArrowUp":
        focusRow(Math.max(index - 1, 0));
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (entry.kind === "folder" && !isOpenFolder) onToggle(entry.path, true);
        else if (isOpenFolder && rows[index + 1]?.parent === entry.path) focusRow(index + 1);
        break;
      case "ArrowLeft":
        if (isOpenFolder) onToggle(entry.path, false);
        else if (parent !== null) focusRow(indexOf.get(parent) ?? index);
        break;
      case "Enter":
        activate(entry, false);
        break;
      case "ContextMenu": {
        hideTooltip();
        // The row's rectangle, not the row itself, so a press on the row closes the menu.
        setContextMenu({ at: row.getBoundingClientRect(), target: entry });
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  function entryAt(target: EventTarget) {
    const index = indexOf.get(rowOf(target)?.dataset.path ?? "");
    return index === undefined ? undefined : rows[index].entry;
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    const entry = entryAt(event.target);
    if (entry) activate(entry, event.ctrlKey || event.metaKey);
  }

  function onAuxClick(event: MouseEvent<HTMLDivElement>) {
    const entry = entryAt(event.target);
    if (event.button === 1 && entry?.kind === "page") onOpen(entry.path, { newTab: true });
  }

  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    // The name input keeps the platform's own text menu.
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    hideTooltip();
    setContextMenu({
      at: { x: event.clientX, y: event.clientY },
      target: entryAt(event.target) ?? null,
    });
  }

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const row = rowOf(event.target);
    if (row !== event.target || !row.dataset.path) return;
    setFocused(row.dataset.path);
    showTooltipLater(row);
  }

  function onPointerOver(event: PointerEvent<HTMLDivElement>) {
    const row = rowOf(event.target);
    if (!row) hideTooltip();
    else if (!row.contains(event.relatedTarget as Node | null)) showTooltipLater(row);
  }

  const rowAt = (path: string | undefined) =>
    path === undefined ? undefined : rows[indexOf.get(path) ?? -1];
  const selectedGroup = rowAt(selected)?.group;
  const tabStopGroup = rowAt(tabStop)?.group;
  // A name input for the top level, or for a folder that is not visible, goes at the very top.
  const inputFolder = rowAt(nameInput?.folder ?? undefined);
  const nameInputNode = nameInput && (
    <NameInput
      key="name-input"
      request={nameInput}
      level={inputFolder ? inputFolder.level + 1 : 1}
      onSubmit={onNameSubmit}
      onCancel={onNameCancel}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-window">
      <div className="flex h-tab-strip shrink-0 items-center gap-1 pr-1 pl-3">
        <h2 className="world-name min-w-0 flex-1 truncate text-text">{worldName}</h2>
        <IconButton icon="note_add" label="New page" onClick={onNewPage} />
        <IconButton icon="create_new_folder" label="New folder" onClick={onNewFolder} />
        <MenuButton
          icon="more_horiz"
          label="World menu"
          items={worldMenuItems}
          onSelect={onWorldMenuSelect}
        />
      </div>
      {/* The context menu renders outside this body, so its keys never reach the tree's handler. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the right-click target for the empty space; Shift+F10 on a row covers the keyboard. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        onContextMenu={onContextMenu}
      >
        {rows.length > 0 || nameInputNode ? (
          <div
            ref={tree}
            role="tree"
            aria-label={worldName}
            className="pb-2"
            onKeyDown={onKeyDown}
            onClick={onClick}
            onAuxClick={onAuxClick}
            // A middle press would otherwise start the platform's autoscroll.
            onMouseDown={(event) => event.button === 1 && event.preventDefault()}
            onFocus={onFocus}
            onBlur={hideTooltip}
            onPointerOver={onPointerOver}
            onPointerLeave={hideTooltip}
          >
            {!inputFolder && nameInputNode}
            {groups.map((group, index) => (
              <RowGroup
                key={group[0].entry.path}
                rows={group}
                expanded={expanded}
                selected={index === selectedGroup ? selected : undefined}
                tabStop={index === tabStopGroup ? tabStop : undefined}
                nameInput={
                  inputFolder?.group === index && nameInputNode
                    ? { after: inputFolder.entry.path, node: nameInputNode }
                    : undefined
                }
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 px-3 py-2">
            <p className="ui text-text-muted">This world has no pages yet.</p>
            <Button variant="ghost" onClick={onNewPage}>
              New page
            </Button>
          </div>
        )}
      </div>
      {tooltipAnchor && <NameTooltip anchor={tooltipAnchor} />}
      {contextMenu && (
        <Menu
          label={contextMenu.target?.name ?? worldName}
          items={contextMenuItems(contextMenu.target)}
          at={contextMenu.at}
          onSelect={(id) => onContextMenuSelect(id, contextMenu.target)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
