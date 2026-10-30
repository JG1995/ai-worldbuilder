import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
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
const keyboardStep = 16;

const wideQuery = "(min-width: 960px)";
const focusable =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

const clampWidth = (width: number) => Math.min(maxTreeWidth, Math.max(minTreeWidth, width));

function subscribeToWidth(onChange: () => void) {
  const query = window.matchMedia(wideQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const isWide = () => window.matchMedia(wideQuery).matches;

type ShellProps = {
  /** The tree pane's content, such as a `FileTree`. */
  tree: ReactNode;
  /** Renders the tab strip. Below 960px, `treeToggle` is the button that opens the tree overlay. */
  tabStrip: (treeToggle: ReactNode) => ReactNode;
  /** The page region below the tab strip. */
  page: ReactNode;
  /** A `ToastRegion`, placed at the bottom left of the page region on the toast layer. */
  toasts?: ReactNode;
  /** In pixels; limited to 200 to 420. */
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
  /** Whether the tree overlay is open below 960px. The shell asks to close it at 960px and wider. */
  treeOverlayOpen: boolean;
  onTreeOverlayOpenChange: (open: boolean) => void;
};

/**
 * The application layout: the tree pane beside the page column at 960px and wider, and an overlay
 * over the left of the page region below that. F6 and Shift+F6 move focus between the panes. The
 * tree pane stays mounted in both layouts, so crossing 960px keeps the tree's focus and state.
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
}: ShellProps) {
  const paneId = useId();
  const root = useRef<HTMLDivElement>(null);
  const treePane = useRef<HTMLElement>(null);
  const pageColumn = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const lastFocused = useRef(new Map<Element, HTMLElement>());
  const drag = useRef<{ x: number; width: number } | null>(null);
  const wide = useSyncExternalStore(subscribeToWidth, isWide);
  const overlayOpen = !wide && treeOverlayOpen;
  const treeVisible = wide || overlayOpen;
  const wasTreeVisible = useRef(treeVisible);
  const width = clampWidth(treeWidth);
  const setOverlayOpen = useEffectEvent(onTreeOverlayOpenChange);

  // Widening turns an open overlay into the side pane, so narrowing again leaves it closed.
  useEffect(() => {
    if (wide && treeOverlayOpen) setOverlayOpen(false);
  }, [wide, treeOverlayOpen]);

  // Hiding the tree with focus inside it would drop focus on the body, so it moves to the toggle.
  useLayoutEffect(() => {
    const focusWasInTree = treePane.current?.contains(document.activeElement);
    if (wasTreeVisible.current && !treeVisible && focusWasInTree) toggle.current?.focus();
    wasTreeVisible.current = treeVisible;
  }, [treeVisible]);

  useEffect(() => {
    if (!overlayOpen) return;
    // A cancelled Escape was handled inside, such as by a name input, a menu or a dialog.
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape closes a visible tooltip first; the next one closes the overlay.
      if (document.querySelector('[role="tooltip"]:not([hidden])')) return;
      setOverlayOpen(false);
    };
    // A press that an open menu cancelled only closes that menu.
    const closeOnOutsidePress = (event: globalThis.PointerEvent) => {
      const target = event.target as Element;
      if (event.defaultPrevented || treePane.current?.contains(target)) return;
      if (toggle.current?.contains(target)) return;
      // A press on something that takes no focus would leave focus on the body, not the toggle.
      if (!target.closest(focusable)) event.preventDefault();
      setOverlayOpen(false);
    };
    const shell = root.current;
    document.addEventListener("keydown", closeOnEscape);
    shell?.addEventListener("pointerdown", closeOnOutsidePress);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      shell?.removeEventListener("pointerdown", closeOnOutsidePress);
    };
  }, [overlayOpen]);

  // F6 and Shift+F6 cycle the visible panes, to the last focused element in each.
  const movePaneFocus = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "F6" || event.ctrlKey || event.altKey || event.metaKey) return;
    // An open dialog or menu keeps focus until it closes.
    if (document.activeElement?.closest('[aria-modal="true"], [role="menu"]')) return;
    const panes = [treeVisible ? treePane.current : null, pageColumn.current].filter(
      (pane): pane is HTMLElement => pane !== null,
    );
    const current = panes.findIndex((pane) => pane.contains(document.activeElement));
    const step = event.shiftKey ? -1 : 1;
    const next =
      current === -1 ? (event.shiftKey ? panes.length - 1 : 0) : current + step + panes.length;
    const pane = panes[next % panes.length];
    if (!pane) return;
    event.preventDefault();
    const remembered = lastFocused.current.get(pane);
    const target = remembered?.isConnected
      ? remembered
      : pane.querySelector<HTMLElement>(focusable);
    target?.focus();
  });

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      for (const pane of [treePane.current, pageColumn.current]) {
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

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
  }

  function dragTo(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = clampWidth(drag.current.width + event.clientX - drag.current.x);
    if (next !== width) onTreeWidthChange(next);
  }

  function resizeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowLeft: -keyboardStep, ArrowRight: keyboardStep };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const next = clampWidth(width + steps[event.key]);
    if (next !== width) onTreeWidthChange(next);
  }

  const treeToggle = !wide && (
    <IconButton
      ref={toggle}
      icon="menu"
      label="File tree"
      aria-expanded={overlayOpen}
      aria-controls={paneId}
      onClick={() => onTreeOverlayOpenChange(!overlayOpen)}
    />
  );

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
        {/* biome-ignore lint/a11y/useSemanticElements: a focusable window splitter; <hr> cannot take focus or a value. */}
        <div
          role="separator"
          aria-label="File tree width"
          aria-orientation="vertical"
          aria-valuenow={width}
          aria-valuemin={minTreeWidth}
          aria-valuemax={maxTreeWidth}
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
          className="absolute inset-y-0 right-0 w-1 cursor-col-resize transition-colors hover:bg-outline focus-visible:outline-offset-0 active:bg-outline"
        />
      </aside>
      <div ref={pageColumn} className="relative flex min-w-0 flex-1 flex-col">
        {tabStrip(treeToggle || null)}
        <main className="min-h-0 flex-1">{page}</main>
        {/* Its own stacking context on the toast layer, so toasts stay above dialogs. */}
        <div className="absolute bottom-4 left-4 z-(--z-toast)">{toasts}</div>
      </div>
    </div>
  );
}
