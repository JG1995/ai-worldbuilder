import { type ComponentProps, type ReactNode, useId } from "react";
import { Icon } from "./Icon";

const sizes = { regular: "h-control", compact: "h-control-compact" };

type TextInputProps = Omit<ComponentProps<"input">, "className" | "size" | "aria-label"> & {
  label: string;
  /** Uses `label` as the accessible name without showing it. */
  hideLabel?: boolean;
  size?: keyof typeof sizes;
  /** Marks the input invalid and shows this message below it as its description. */
  error?: string;
  /** A hint or note below the input, after any error, which also describes it. */
  description?: ReactNode;
  /** A control beside the input, such as a Show/Hide button. */
  action?: ReactNode;
};

export function TextInput({
  label,
  hideLabel = false,
  size = "regular",
  error,
  description,
  action,
  id,
  type = "text",
  ...props
}: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const descriptionId = `${inputId}-description`;
  const describedBy = [error && errorId, description && descriptionId].filter(Boolean).join(" ");

  const input = (
    <input
      {...props}
      id={inputId}
      type={type}
      aria-label={hideLabel ? label : undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy || undefined}
      className={`ui min-w-0 rounded-sm border bg-input px-2 text-text transition-colors placeholder:text-text-muted disabled:text-text-disabled ${sizes[size]} ${error ? "border-error" : "border-outline focus:border-accent"} ${action ? "flex-1" : ""}`}
    />
  );

  return (
    <div className="flex flex-col gap-1">
      {!hideLabel && (
        <label htmlFor={inputId} className="ui text-text">
          {label}
        </label>
      )}
      {action ? (
        <div className="flex items-center gap-2">
          {input}
          {action}
        </div>
      ) : (
        input
      )}
      {error && (
        <p id={errorId} className="ui-small flex items-center gap-1 text-error">
          <Icon name="error" />
          {error}
        </p>
      )}
      {description && (
        <div id={descriptionId} className="ui-small flex flex-col gap-1 text-text-muted">
          {description}
        </div>
      )}
    </div>
  );
}
