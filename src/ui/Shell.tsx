import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { IconButton } from "./Button";

export const minTreeWidth = 200;
export const maxTreeWidth = 420;
export const defaultTreeWidth = 264;
export const minAssistantWidth = 300;
export const maxAssistantWidth = 560;
export const defaultAssistantWidth = 360;
/** From this window width the assistant sits beside the page; below it, it is an overlay. */
export const assistantSideQuery = "(min-width: 1280px)";
const keyboardStep = 16;

const wideQuery = "(min-width: 960px)";
const focusable =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

const clamp = (width: number, min: number, max: number) => Math.min(max, Math.max(min, width));

/** The first control of a pane's content, leaving out the pane's own resizable edge. */
const firstControl = (pane: HTMLElement) =>
  [...pane.querySelectorAll<HTMLElement>(focusable)].find(
    (element) => element.getAttribute("role") !== "separator",
  );

/** Focuses the first control in the page region, or `fallback` while it has none. */
function focusPage(region: HTMLElement | null, fallback: HTMLElement | null) {
  ((region && firstControl(region)) ?? fallback)?.focus();
}

/** Whether the window matches `query`, and a subscription to its changes. */
function mediaQuery(query: string) {
  return {
    subscribe(onChange: () => void) {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    matches: () => window.matchMedia(query).matches,
  };
}

const treeSide = mediaQuery(wideQuery);
const assistantSide = mediaQuery(assistantSideQuery);

type ShellProps = {
  /** The tree pane's content, such as a `FileTree`. */
  tree: ReactNode;
  /**
   * Renders the tab strip. Below 960px, and at every width while the tree is collapsed,
   * `treeToggle` is the button that opens the tree; with an `assistant`, `assistantToggle` is the
   * Assistant button for the strip's right end.
   */
  tabStrip: (treeToggle: ReactNode, assistantToggle: ReactNode) => ReactNode;
  /** The page region below the tab strip. */
  page: ReactNode;
  /** A `ToastRegion`, placed at the bottom left of the page region on the toast layer. */
  toasts?: ReactNode;
  /** In pixels; limited to 200 to 420. */
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
  /**
   * Whether the tree overlay is open below 960px. The shell asks to close it at 960px and wider,
   * unless the tree is collapsed.
   */
  treeOverlayOpen: boolean;
  onTreeOverlayOpenChange: (open: boolean) => void;
  /**
   * Hides the tree at every width until `treeOverlayOpen` opens it: beside the page column at
   * 960px and wider, as an overlay below. The tab strip shows the tree button at every width.
   * Off by default.
   */
  treeCollapsed?: boolean;
  /** The assistant pane's content, such as an `AssistantPane`. Without it, there is no pane. */
  assistant?: ReactNode;
  /** Whether the assistant's side pane is open at 1280px and wider. */
  assistantOpen?: boolean;
  onAssistantOpenChange?: (open: boolean) => void;
  /** In pixels; limited to 300 to 560. */
  assistantWidth?: number;
  onAssistantWidthChange?: (width: number) => void;
  /**
   * Whether the assistant overlay is open below 1280px. The shell asks to close it when wider,
   * unless the assistant is collapsed.
   */
  assistantOverlayOpen?: boolean;
  onAssistantOverlayOpenChange?: (open: boolean) => void;
  /**
   * Hides the assistant at every width until `assistantOverlayOpen` opens it: beside the page
   * column at 1280px and wider, as an overlay below. `assistantOpen` is left as it is meanwhile.
   * Off by default.
   */
  assistantCollapsed?: boolean;
};

/**
 * The application layout: the tree pane beside the page column at 960px and wider, and an overlay
 * over the left of the page region below that. With an `assistant`, its pane sits beside the page
 * column at 1280px and wider, and is an overlay over the right of the page region below that. F6
 * and Shift+F6 move focus between the panes. Both panes stay mounted in both layouts, and while
 * closed, so crossing a breakpoint or closing a pane keeps its content's focus and state. A pane
 * that collapses with focus inside moves focus to the page.
 */
export function Shell({
  tree,
  tabStrip,
  page,
  toasts,
  treeWidth,
  onTreeWidthChange,
  treeOverlayOpen,
  onTreeOverlayOpenChange,
  treeCollapsed = false,
  assistant,
  assistantOpen = false,
  onAssistantOpenChange,
  assistantWidth = defaultAssistantWidth,
  onAssistantWidthChange,
  assistantOverlayOpen = false,
  onAssistantOverlayOpenChange,
  assistantCollapsed = false,
}: ShellProps) {
  const paneId = useId();
  const assistantId = useId();
  const root = useRef<HTMLDivElement>(null);
  const treePane = useRef<HTMLElement>(null);
  const pageColumn = useRef<HTMLDivElement>(null);
  const pageRegion = useRef<HTMLElement>(null);
  const assistantPane = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const assistantButton = useRef<HTMLButtonElement>(null);
  const lastFocused = useRef(new Map<Element, HTMLElement>());
  const wide = useSyncExternalStore(treeSide.subscribe, treeSide.matches);
  const overlayOpen = !wide && treeOverlayOpen;
  const treeVisible = treeCollapsed ? treeOverlayOpen : wide || overlayOpen;
  const shownTree = useRef({ visible: treeVisible, collapsed: treeCollapsed });
  const width = clamp(treeWidth, minTreeWidth, maxTreeWidth);
  const setOverlayOpen = useEffectEvent(onTreeOverlayOpenChange);

  const hasAssistant = assistant != null;
  const assistantWide = useSyncExternalStore(assistantSide.subscribe, assistantSide.matches);
  const assistantOverlay = hasAssistant && !assistantWide && assistantOverlayOpen;
  const assistantVisible =
    hasAssistant &&
    (assistantCollapsed ? assistantOverlayOpen : assistantWide ? assistantOpen : assistantOverlay);
  const shownAssistant = useRef({
    visible: assistantVisible,
    wide: assistantWide,
    present: hasAssistant,
    collapsed: assistantCollapsed,
  });
  const setAssistantOverlayOpen = useEffectEvent((open: boolean) =>
    onAssistantOverlayOpenChange?.(open),
  );

  // Widening turns an open overlay into the side pane, so narrowing again leaves it closed. A
  // collapsed tree stays open across the breakpoint instead.
  useEffect(() => {
    if (wide && treeOverlayOpen && !treeCollapsed) setOverlayOpen(false);
  }, [wide, treeOverlayOpen, treeCollapsed]);

  // Widening shows the assistant's side pane as it was, so narrowing again leaves the overlay closed.
  useEffect(() => {
    if (assistantWide && assistantOverlayOpen && !assistantCollapsed) {
      setAssistantOverlayOpen(false);
    }
  }, [assistantWide, assistantOverlayOpen, assistantCollapsed]);

  // Hiding the tree with focus inside it would drop focus on the body, so it moves to the toggle,
  // or to the page when the tree collapses.
  useLayoutEffect(() => {
    const shown = shownTree.current;
    shownTree.current = { visible: treeVisible, collapsed: treeCollapsed };
    const focusWasInTree = treePane.current?.contains(document.activeElement);
    if (!shown.visible || treeVisible || !focusWasInTree) return;
    const collapsing = treeCollapsed && !shown.collapsed;
    if (collapsing) focusPage(pageRegion.current, toggle.current);
    else toggle.current?.focus();
  }, [treeVisible, treeCollapsed]);

  // The user opened the assistant when it shows in the same layout it was hidden in, with the
  // pane already there: not when a world opens, AI is switched on, a breakpoint is crossed or the
  // assistant stops being collapsed. Opening moves focus into it, and hiding it with focus inside
  // moves focus to its button, or to the page when the assistant collapses.
  useLayoutEffect(() => {
    const shown = shownAssistant.current;
    shownAssistant.current = {
      visible: assistantVisible,
      wide: assistantWide,
      present: hasAssistant,
      collapsed: assistantCollapsed,
    };
    const pane = assistantPane.current;
    if (!pane) return;
    if (shown.visible && !assistantVisible && pane.contains(document.activeElement)) {
      const collapsing = assistantCollapsed && !shown.collapsed;
      if (collapsing) focusPage(pageRegion.current, assistantButton.current);
      else assistantButton.current?.focus();
    } else if (
      !shown.visible &&
      assistantVisible &&
      shown.present &&
      shown.wide === assistantWide &&
      shown.collapsed === assistantCollapsed
    ) {
      const target =
        pane.querySelector<HTMLElement>("[data-initial-focus]") ?? firstControl(pane) ?? pane;
      target.focus();
    }
  }, [assistantVisible, assistantWide, hasAssistant, assistantCollapsed]);

  useOverlayDismissal(overlayOpen, root, treePane, toggle, () => setOverlayOpen(false));
  useOverlayDismissal(assistantOverlay, root, assistantPane, assistantButton, () =>
    setAssistantOverlayOpen(false),
  );

  // F6 and Shift+F6 cycle the visible panes, to the last focused element in each.
  const movePaneFocus = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "F6" || event.ctrlKey || event.altKey || event.metaKey) return;
    // An open dialog or menu keeps focus until it closes.
    if (document.activeElement?.closest('[aria-modal="true"], [role="menu"]')) return;
    const panes = [
      treeVisible ? treePane.current : null,
      pageColumn.current,
      assistantVisible ? assistantPane.current : null,
    ].filter((pane): pane is HTMLElement => pane !== null);
    const current = panes.findIndex((pane) => pane.contains(document.activeElement));
    const step = event.shiftKey ? -1 : 1;
    const next =
      current === -1 ? (event.shiftKey ? panes.length - 1 : 0) : current + step + panes.length;
    const pane = panes[next % panes.length];
    if (!pane) return;
    event.preventDefault();
    const remembered = lastFocused.current.get(pane);
    const target = remembered?.isConnected ? remembered : firstControl(pane);
    // The assistant pane itself takes focus when its content has no control.
    (target ?? pane).focus();
  });

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      for (const pane of [treePane.current, pageColumn.current, assistantPane.current]) {
        if (pane?.contains(element)) lastFocused.current.set(pane, element);
      }
    };
    window.addEventListener("keydown", movePaneFocus);
    document.addEventListener("focusin", remember);
    return () => {
      window.removeEventListener("keydown", movePaneFocus);
      document.removeEventListener("focusin", remember);
    };
  }, []);

  function toggleAssistant() {
    if (assistantWide && !assistantCollapsed) onAssistantOpenChange?.(!assistantOpen);
    else onAssistantOverlayOpenChange?.(!assistantOverlayOpen);
  }

  const treeToggle = (!wide || treeCollapsed) && (
    <IconButton
      ref={toggle}
      icon="menu"
      label="File tree"
      aria-expanded={treeVisible}
      aria-controls={paneId}
      onClick={() => onTreeOverlayOpenChange(!treeVisible)}
    />
  );

  const assistantToggle = hasAssistant && (
    <IconButton
      ref={assistantButton}
      icon="chat"
      label="Assistant"
      shortcut="Ctrl+Shift+A"
      aria-expanded={assistantVisible}
      aria-controls={assistantId}
      onClick={toggleAssistant}
    />
  );

  const assistantPaneWidth = clamp(assistantWidth, minAssistantWidth, maxAssistantWidth);

  return (
    <div ref={root} className="relative flex h-full min-h-0">
      {/* The overlay's slide ends with no translate, so fixed tooltips inside place correctly. */}
      <aside
        ref={treePane}
        id={paneId}
        aria-label="File tree"
        hidden={!treeVisible}
        style={{ width }}
        className={`flex min-h-0 shrink-0 flex-col bg-window ${
          wide
            ? "relative"
            : "absolute top-tab-strip bottom-0 left-0 z-(--z-overlay) border-divider border-r shadow-(--level-2-shadow) transition-transform duration-(--duration-slide) ease-out starting:-translate-x-full"
        }`}
      >
        {tree}
        <PaneEdge
          label="File tree width"
          edge="right"
          width={width}
          min={minTreeWidth}
          max={maxTreeWidth}
          onChange={onTreeWidthChange}
        />
      </aside>
      <div ref={pageColumn} className="relative flex min-w-0 flex-1 flex-col">
        {tabStrip(treeToggle || null, assistantToggle || null)}
        <main ref={pageRegion} className="min-h-0 flex-1">
          {page}
        </main>
        {/* Its own stacking context on the toast layer, so toasts stay above dialogs. */}
        <div className="absolute bottom-4 left-4 z-(--z-toast)">{toasts}</div>
      </div>
      {hasAssistant && (
        <aside
          ref={assistantPane}
          id={assistantId}
          aria-label="Assistant"
          tabIndex={-1}
          hidden={!assistantVisible}
          style={{ width: assistantPaneWidth }}
          className={`flex min-h-0 shrink-0 flex-col border-divider border-l bg-page focus-visible:-outline-offset-2 ${
            assistantWide
              ? "relative"
              : "absolute top-tab-strip right-0 bottom-0 z-(--z-overlay) shadow-(--level-2-shadow) transition-transform duration-(--duration-slide) ease-out starting:translate-x-full"
          }`}
        >
          {assistant}
          <PaneEdge
            label="Assistant width"
            edge="left"
            width={assistantPaneWidth}
            min={minAssistantWidth}
            max={maxAssistantWidth}
            onChange={(next) => onAssistantWidthChange?.(next)}
          />
        </aside>
      )}
    </div>
  );
}

/**
 * Closes an open overlay on Escape, unless something inside handled it or a tooltip shows, and on
 * a press anywhere in the shell outside the overlay and its toggle.
 */
function useOverlayDismissal(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  pane: RefObject<HTMLElement | null>,
  toggle: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const onClose = useEffectEvent(close);

  useEffect(() => {
    if (!open) return;
    // A cancelled Escape was handled inside, such as by a name input, a menu or a dialog.
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape closes a visible tooltip first; the next one closes the overlay.
      if (document.querySelector('[role="tooltip"]:not([hidden])')) return;
      onClose();
    };
    // A press that an open menu cancelled only closes that menu.
    const closeOnOutsidePress = (event: globalThis.PointerEvent) => {
      const target = event.target as Element;
      if (event.defaultPrevented || pane.current?.contains(target)) return;
      if (toggle.current?.contains(target)) return;
      // A press on something that takes no focus would leave focus on the body, not the toggle.
      if (!target.closest(focusable)) event.preventDefault();
      onClose();
    };
    const shell = root.current;
    document.addEventListener("keydown", closeOnEscape);
    shell?.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      shell?.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [open, root, pane, toggle]);
}

/**
 * A pane's resizable edge: a focusable window splitter that a pointer drags and Left and Right
 * move in 16px steps, within `min` to `max`.
 */
function PaneEdge({
  label,
  edge,
  width,
  min,
  max,
  onChange,
}: {
  label: string;
  /** The pane's side the edge is on; moving it away from the pane widens the pane. */
  edge: "left" | "right";
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const outward = edge === "right" ? 1 : -1;

  function change(next: number) {
    const limited = clamp(next, min, max);
    if (limited !== width) onChange(limited);
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
  }

  function dragTo(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    change(drag.current.width + outward * (event.clientX - drag.current.x));
  }

  function resizeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowLeft: -keyboardStep, ArrowRight: keyboardStep };
    if (!(event.key in steps)) return;
    event.preventDefault();
    change(width + outward * steps[event.key]);
  }

  return (
    // Its transparent border becomes a visible line in Windows contrast themes.
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter; <hr> cannot take focus or a value.
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={dragTo}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={resizeByKey}
      className={`absolute inset-y-0 w-1 cursor-col-resize border-transparent transition-colors hover:bg-outline focus-visible:outline-offset-0 active:bg-outline ${
        edge === "right" ? "right-0 border-r" : "left-0 border-l"
      }`}
    />
  );
}
