import { type Ref, useId } from "react";

type ToggleProps = {
  /** The visible label and the switch's accessible name. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Explains what the switch does, below the label. */
  description?: string;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * A switch with its label, its On/Off state text and an optional description. The track is a
 * rectangle with an `outline` border, filled with `accent` while on. The thumb has a 1px border,
 * transparent, so Windows contrast themes, which repaint both fills, still paint the thumb.
 */
export function Toggle({ label, checked, onChange, description, ref }: ToggleProps) {
  const switchId = useId();
  const descriptionId = `${switchId}-description`;

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={switchId} className="ui-strong text-text">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="ui-small text-text-muted">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span aria-hidden="true" className="ui text-text">
          {checked ? "On" : "Off"}
        </span>
        <button
          ref={ref}
          id={switchId}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-describedby={description ? descriptionId : undefined}
          onClick={() => onChange(!checked)}
          className={`flex h-5 w-9 items-center rounded-sm border p-0.5 transition-colors ${checked ? "border-accent bg-accent" : "border-outline"}`}
        >
          <span
            className={`size-3.5 rounded-sm border border-transparent transition-transform ${checked ? "translate-x-4 bg-on-accent" : "bg-text-muted"}`}
          />
        </button>
      </div>
    </div>
  );
}
