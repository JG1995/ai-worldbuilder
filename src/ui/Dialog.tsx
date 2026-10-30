import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";

const focusable =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

type DialogProps = {
  title: string;
  children: ReactNode;
  /** The buttons at the bottom right. */
  actions: ReactNode;
  /** Called on Escape. */
  onCancel: () => void;
  /** The element to focus on open; the first control when absent. */
  initialFocus?: RefObject<HTMLElement | null>;
};

/**
 * A modal dialog in a portal on the dialog layer, below the toast layer. It is not a native
 * <dialog>: the top layer would cover the toasts. Tab and Shift+Tab cycle inside it, and closing
 * returns focus to the element that was focused when it opened.
 */
export function Dialog({ title, children, actions, onCancel, initialFocus }: DialogProps) {
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
        className="flex w-[440px] max-w-full flex-col gap-4 rounded-md border border-divider bg-raised p-6 text-text shadow-(--level-2-shadow)"
      >
        <h2 id={titleId} className="heading-4">
          {title}
        </h2>
        <div className="ui flex flex-col gap-4">{children}</div>
        <div className="flex flex-wrap justify-end gap-2">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
