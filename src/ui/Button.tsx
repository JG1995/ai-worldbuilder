import type { ComponentProps } from "react";
import { Icon, type IconName } from "./Icon";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

// Hover and pressed colours apply to enabled buttons only. Pressed reuses existing fills: secondary
// and ghost take `selected`, and primary shows its base fill again. DESIGN.md defines no hover
// colour for destructive buttons, so they keep their fill. Every button has a 1px border, transparent
// unless the variant draws one, so Windows contrast themes still paint each button's boundary.
const ghost =
  "border-transparent text-text-muted enabled:hover:bg-hover enabled:hover:text-text enabled:active:bg-selected";

const variants: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-accent text-on-accent enabled:hover:bg-accent-hover enabled:active:bg-accent",
  secondary: "border-outline text-text enabled:hover:bg-hover enabled:active:bg-selected",
  ghost,
  destructive: "border-transparent bg-error text-on-status",
};

type ButtonProps = Omit<ComponentProps<"button">, "className"> & {
  variant: ButtonVariant;
  /** Shows "Working…" in place of the label and ignores activation until it ends. */
  loading?: boolean;
};

export function Button({
  variant,
  loading = false,
  type = "button",
  onClick,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-busy={loading || undefined}
      onClick={(event) => {
        if (loading) event.preventDefault();
        else onClick?.(event);
      }}
      className={`ui-strong relative inline-flex h-control shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-sm border px-3 transition-colors disabled:text-text-disabled ${variants[variant]}`}
    >
      {/* The hidden label keeps the button's width while "Working…" shows over it. */}
      <span
        aria-hidden={loading || undefined}
        className={`inline-flex items-center gap-2 ${loading ? "invisible" : ""}`}
      >
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">Working…</span>
      )}
    </button>
  );
}

type IconButtonProps = Omit<ComponentProps<"button">, "className" | "children" | "aria-label"> & {
  icon: IconName;
  /** The accessible name and the tooltip text. */
  label: string;
  shortcut?: string;
};

/** A 28px square ghost button whose tooltip names its action and shortcut. */
export function IconButton({ icon, label, shortcut, type = "button", ...props }: IconButtonProps) {
  return (
    <Tooltip text={label} shortcut={shortcut}>
      {(describedBy) => (
        <button
          {...props}
          type={type}
          aria-label={label}
          aria-describedby={describedBy}
          className={`inline-flex size-control-compact shrink-0 items-center justify-center rounded-sm border transition-colors disabled:text-text-disabled ${ghost}`}
        >
          <Icon name={icon} />
        </button>
      )}
    </Tooltip>
  );
}
