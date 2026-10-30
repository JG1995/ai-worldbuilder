import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const showDelay = 500;
const viewportMargin = 8;
const anchorGap = 4;

type Box = { width: number; height: number };
type Rect = { left: number; right: number; top: number; bottom: number };
export type Point = { x: number; y: number };

/**
 * The top-left corner for a popover of `size` next to `anchor`: below it, or above it when it does
 * not fit below, aligned to the anchor's start or centre and kept inside the viewport.
 */
export function placeInViewport(
  size: Box,
  anchor: Rect,
  align: "start" | "center",
  viewport: Box = { width: window.innerWidth, height: window.innerHeight },
) {
  const x = align === "start" ? anchor.left : (anchor.left + anchor.right - size.width) / 2;
  const left = Math.max(viewportMargin, Math.min(x, viewport.width - size.width - viewportMargin));
  const below = anchor.bottom + anchorGap;
  const fitsBelow = below + size.height + viewportMargin <= viewport.height;
  const top = fitsBelow ? below : Math.max(viewportMargin, anchor.top - anchorGap - size.height);
  return { left, top };
}

function rectOf(anchor: Element | Point): Rect {
  if (anchor instanceof Element) return anchor.getBoundingClientRect();
  return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
}

/**
 * The fixed-position style that places `popover` at `anchor`. It measures after every render,
 * before paint, so the popover never shows at the wrong place.
 */
export function usePopoverPosition(
  popover: RefObject<HTMLElement | null>,
  anchor: Element | Point | null,
  align: "start" | "center",
): CSSProperties {
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!popover.current || !anchor) return;
    const next = placeInViewport(popover.current.getBoundingClientRect(), rectOf(anchor), align);
    setPosition((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  });
  return { position: "fixed", ...position };
}

type TooltipProps = {
  text: string;
  shortcut?: string;
  /** Renders the trigger. Pass `describedBy` to its `aria-describedby`. */
  children: (describedBy: string) => ReactNode;
};

/**
 * A tooltip for the element that `children` renders. It shows after a short delay on hover and
 * on focus, and closes on pointer leave, blur or Escape. Its text stays in the document while
 * hidden, so the trigger's description is always available to assistive technology.
 */
export function Tooltip({ text, shortcut, children }: TooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>(undefined);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const position = usePopoverPosition(tooltip, anchor, "center");

  function show() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setAnchor(trigger.current?.firstElementChild ?? null),
      showDelay,
    );
  }

  function hide() {
    window.clearTimeout(timer.current);
    setAnchor(null);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A scroll would leave the fixed tooltip behind its trigger, so it closes too.
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("scroll", close, true);
    };
  }, [anchor]);

  return (
    // `contents` keeps the wrapper out of layout; it only collects the trigger's events.
    // biome-ignore lint/a11y/noStaticElementInteractions: the trigger inside is the interactive element.
    <span
      ref={trigger}
      className="contents"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children(id)}
      <span
        ref={tooltip}
        id={id}
        role="tooltip"
        hidden={!anchor}
        style={anchor ? position : undefined}
        className="ui-small pointer-events-none z-(--z-menu) max-w-80 rounded-md border border-divider bg-raised px-2 py-1 text-text shadow-(--level-2-shadow)"
      >
        {text}
        {shortcut && " "}
        {shortcut && <span className="text-text-muted">{shortcut}</span>}
      </span>
    </span>
  );
}
