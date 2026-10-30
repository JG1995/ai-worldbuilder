import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "./Button";

const toastDuration = 6000;
const maxToasts = 3;

export type Toast = {
  id: string;
  message: string;
  /** The label of the toast's single action, such as "Undo". */
  action?: string;
};

type ToastRegionProps = {
  /** Oldest first. */
  toasts: Toast[];
  onDismiss: (id: string) => void;
  onAction?: (id: string) => void;
  /** Positions the region; it sits on the toast layer, above dialogs and their backdrop. */
  className?: string;
};

/**
 * The polite live region that shows the newest three toasts. Each toast reports its dismissal
 * after 6 seconds without the pointer over it or focus inside it. Older toasts beyond three are
 * reported dismissed at once.
 */
export function ToastRegion({ toasts, onDismiss, onAction, className = "" }: ToastRegionProps) {
  const dismissOverflow = useEffectEvent((overflow: Toast[]) => {
    for (const toast of overflow) onDismiss(toast.id);
  });

  useEffect(() => {
    if (toasts.length > maxToasts) dismissOverflow(toasts.slice(0, -maxToasts));
  }, [toasts]);

  return (
    <div role="status" aria-live="polite" className={`z-(--z-toast) ${className}`}>
      <ul className="flex flex-col items-start gap-2">
        {toasts.slice(-maxToasts).map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} onAction={onAction} />
        ))}
      </ul>
    </div>
  );
}

type ToastItemProps = {
  toast: Toast;
  onDismiss: (id: string) => void;
  onAction?: (id: string) => void;
};

function ToastItem({ toast, onDismiss, onAction }: ToastItemProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dismiss = useEffectEvent(() => onDismiss(toast.id));

  // Restarts the full duration whenever both the pointer and focus have left.
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(dismiss, toastDuration);
    return () => window.clearTimeout(timer);
  }, [hovered, focused]);

  return (
    <li
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      className={`ui flex min-h-10 max-w-[400px] items-center gap-3 rounded-md border border-divider bg-raised py-1 pl-3 text-text shadow-(--level-2-shadow) ${toast.action ? "pr-1" : "pr-3"}`}
    >
      <span className="py-1">{toast.message}</span>
      {toast.action && (
        <Button variant="ghost" onClick={() => onAction?.(toast.id)}>
          {toast.action}
        </Button>
      )}
    </li>
  );
}
