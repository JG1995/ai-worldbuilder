import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";

const focusable =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

type DialogProps = {
  title: string;
  children: ReactNode;
  /** The buttons at the bottom right. */
  actions?: ReactNode;
  /** Called on Escape and by the close button. */
  onCancel: () => void;
  /** The element to focus on open; the first control when absent. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 560px wide instead of a confirmation's 440px, for a dialog that holds a form. */
  wide?: boolean;
  /** Fills the window less the gutter, with its body taking the height the rest leaves. */
  full?: boolean;
  /** Shows a Close button in the title row, which calls `onCancel`. */
  closeButton?: boolean;
};

/**
 * A modal dialog in a portal on the dialog layer, below the toast layer. It is not a native
 * <dialog>: the top layer would cover the toasts. Tab and Shift+Tab cycle inside it, and closing
 * returns focus to the element that was focused when it opened. It is never taller than the
 * window; its body scrolls instead.
 */
export function Dialog({
  title,
  children,
  actions,
  onCancel,
  initialFocus,
  wide = false,
  full = false,
  closeButton = false,
}: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    (initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(focusable))?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [initialFocus]);

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const controls = [...panel.current.querySelectorAll<HTMLElement>(focusable)];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    // A click on the dialog's own content focuses the panel itself.
    if (document.activeElement === edge || document.activeElement === panel.current) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }

  return createPortal(
    // Pressing the backdrop must not move focus out of the dialog.
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only keeps focus in place.
    <div
      onMouseDown={(event) => event.target === event.currentTarget && event.preventDefault()}
      className="fixed inset-0 z-(--z-dialog) flex items-center justify-center bg-backdrop p-4 transition-opacity duration-(--duration-fade) starting:opacity-0"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapFocus}
        className={`flex max-h-full max-w-full flex-col gap-4 rounded-md border border-divider bg-raised p-6 text-text shadow-(--level-2-shadow) ${full ? "h-full w-full" : wide ? "w-[560px]" : "w-[440px]"}`}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="heading-4">
            {title}
          </h2>
          {closeButton && <IconButton icon="close" label="Close" onClick={onCancel} />}
        </div>
        {/* The negative margin and the padding keep the focus ring of a control at the edge visible. */}
        <div
          className={`ui -m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1 ${full ? "flex-1" : ""}`}
        >
          {children}
        </div>
        {actions && <div className="flex flex-wrap justify-end gap-2">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
