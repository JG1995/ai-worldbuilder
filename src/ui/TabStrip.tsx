import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "./Button";
import { MenuButton } from "./Menu";
import { usePopoverPosition } from "./Tooltip";

export type Tab = { id: string; label: string };

type TabStripProps = {
  /** Shown in this order. */
  tabs: Tab[];
  activeId?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** Controls at the strip's left, such as the shell's tree toggle. */
  leading?: ReactNode;
};

const tooltipDelay = 500;

/** The element that holds a tab and its close button. */
function tabElement(list: HTMLElement | null, id: string | undefined) {
  return [...(list?.querySelectorAll<HTMLElement>("[data-tab]") ?? [])].find(
    (element) => element.dataset.tab === id,
  );
}

/** The full label of a truncated tab. It repeats the tab's own name, so it is hidden from AT. */
function LabelTooltip({ anchor }: { anchor: Element }) {
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

/**
 * The open pages above the page region, with manual activation: Left and Right move focus, and
 * Enter, Space or a click report an activate request. Ctrl/Cmd+Tab and Ctrl/Cmd+Shift+Tab report
 * the next and previous tab while the strip is mounted. It holds only focus, overflow and the
 * label tooltip.
 */
export function TabStrip({ tabs, activeId, onActivate, onClose, leading }: TabStripProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const tooltipTimer = useRef<number>(undefined);
  const [focused, setFocused] = useState<string>();
  const [overflowing, setOverflowing] = useState(false);
  const [tooltipAnchor, setTooltipAnchor] = useState<Element | null>(null);
  const has = (id: string | undefined) => tabs.some((tab) => tab.id === id);
  const tabStop = [focused, activeId].find(has) ?? tabs[0]?.id;

  const focusTab = (id: string | undefined) =>
    tabElement(list.current, id)?.querySelector<HTMLElement>('[role="tab"]')?.focus();

  const cycle = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Tab" || !(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    // An open dialog keeps the page behind it unchanged until it closes.
    if (tabs.length === 0 || document.activeElement?.closest('[aria-modal="true"]')) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const step = event.shiftKey ? -1 : 1;
    const next = index === -1 ? 0 : (index + step + tabs.length) % tabs.length;
    onActivate(tabs[next].id);
  });

  useEffect(() => {
    window.addEventListener("keydown", cycle);
    return () => window.removeEventListener("keydown", cycle);
  }, []);

  useEffect(() => {
    const measure = () => {
      const element = scroller.current;
      if (element) setOverflowing(element.scrollWidth > element.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    if (scroller.current) observer.observe(scroller.current);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, []);

  // Keeps the active tab in view, for example after it is chosen from the overflow menu.
  useLayoutEffect(() => {
    const element = scroller.current;
    const tab = tabElement(list.current, activeId);
    if (!element || !tab) return;
    const right = tab.offsetLeft + tab.offsetWidth;
    if (tab.offsetLeft < element.scrollLeft) element.scrollLeft = tab.offsetLeft;
    else if (right > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = right - element.clientWidth;
    }
  }, [activeId]);

  useEffect(() => () => window.clearTimeout(tooltipTimer.current), []);

  function showTooltipLater(label: Element | null) {
    window.clearTimeout(tooltipTimer.current);
    if (!label || label.scrollWidth <= label.clientWidth) {
      setTooltipAnchor(null);
      return;
    }
    tooltipTimer.current = window.setTimeout(() => setTooltipAnchor(label), tooltipDelay);
  }

  function hideTooltip() {
    window.clearTimeout(tooltipTimer.current);
    setTooltipAnchor(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const tab = event.target as HTMLElement;
    if (tab.getAttribute("role") !== "tab") return;
    const id = tab.closest<HTMLElement>("[data-tab]")?.dataset.tab ?? "";
    const index = tabs.findIndex((candidate) => candidate.id === id);
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const step = event.key === "ArrowLeft" ? -1 : 1;
      focusTab(tabs[(index + step + tabs.length) % tabs.length].id);
    } else if (event.key === "Enter" || event.key === " ") {
      onActivate(id);
    } else if (event.key === "Escape" && tooltipAnchor) {
      hideTooltip();
    } else {
      return;
    }
    event.preventDefault();
  }

  return (
    // The bottom line is a border, so Windows contrast themes keep it; positioned tabs paint over it.
    <div className="relative flex h-tab-strip shrink-0 bg-window before:absolute before:inset-x-0 before:bottom-0 before:border-divider before:border-b">
      {leading && <div className="flex shrink-0 items-center px-1">{leading}</div>}
      <div
        ref={scroller}
        // A vertical wheel scrolls the strip sideways; it has no vertical scroll of its own.
        onWheel={(event) => {
          event.currentTarget.scrollLeft += event.deltaY;
        }}
        onScroll={hideTooltip}
        className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        <div
          ref={list}
          role="tablist"
          aria-label="Open pages"
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const tab = event.target.closest<HTMLElement>("[data-tab]");
            if (tab?.dataset.tab) setFocused(tab.dataset.tab);
            if (event.target.getAttribute("role") === "tab") {
              showTooltipLater(event.target.firstElementChild);
            }
          }}
          onBlur={(event) => {
            hideTooltip();
            if (!event.currentTarget.contains(event.relatedTarget)) setFocused(undefined);
          }}
          className="flex h-full w-max"
        >
          {tabs.map((tab, index) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                role="presentation"
                data-tab={tab.id}
                onPointerEnter={(event) =>
                  showTooltipLater(event.currentTarget.querySelector("[data-label]"))
                }
                onPointerLeave={hideTooltip}
                className={`group relative flex h-full max-w-[200px] shrink-0 items-center transition-colors ${
                  active
                    ? "bg-page text-text before:absolute before:inset-x-0 before:top-0 before:border-accent before:border-t-2"
                    : "text-text-muted focus-within:text-text hover:text-text"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={tab.id === tabStop ? 0 : -1}
                  onClick={() => onActivate(tab.id)}
                  onAuxClick={(event) => event.button === 1 && onClose(tab.id)}
                  // A middle press would otherwise start the platform's autoscroll.
                  onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                  className="ui flex h-full min-w-0 items-center pr-8 pl-3 focus-visible:-outline-offset-2"
                >
                  <span data-label className="min-w-0 truncate">
                    {tab.label}
                  </span>
                </button>
                <span className="invisible absolute inset-y-0 right-1 flex items-center group-focus-within:visible group-hover:visible">
                  <IconButton
                    icon="close"
                    label={`Close ${tab.label}`}
                    tabIndex={tab.id === tabStop ? 0 : -1}
                    onClick={() => {
                      // Focus moves to a neighbour instead of dropping to the body.
                      focusTab((tabs[index + 1] ?? tabs[index - 1])?.id);
                      onClose(tab.id);
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {overflowing && (
        <div className="flex shrink-0 items-center px-1">
          <MenuButton
            icon="expand_more"
            label="All tabs"
            items={tabs.map(({ id, label }) => ({ id, label }))}
            onSelect={onActivate}
          />
        </div>
      )}
      {tooltipAnchor && <LabelTooltip anchor={tooltipAnchor} />}
    </div>
  );
}
