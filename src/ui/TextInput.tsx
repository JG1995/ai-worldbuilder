import { type ComponentProps, useId } from "react";
import { Icon } from "./Icon";

const sizes = { regular: "h-control", compact: "h-control-compact" };

type TextInputProps = Omit<ComponentProps<"input">, "className" | "size" | "aria-label"> & {
  label: string;
  /** Uses `label` as the accessible name without showing it. */
  hideLabel?: boolean;
  size?: keyof typeof sizes;
  /** Marks the input invalid and shows this message below it as its description. */
  error?: string;
};

export function TextInput({
  label,
  hideLabel = false,
  size = "regular",
  error,
  id,
  type = "text",
  ...props
}: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1">
      {!hideLabel && (
        <label htmlFor={inputId} className="ui text-text">
          {label}
        </label>
      )}
      <input
        {...props}
        id={inputId}
        type={type}
        aria-label={hideLabel ? label : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`ui min-w-0 rounded-sm border bg-input px-2 text-text transition-colors placeholder:text-text-muted disabled:text-text-disabled ${sizes[size]} ${error ? "border-error" : "border-outline focus:border-accent"}`}
      />
      {error && (
        <p id={errorId} className="ui-small flex items-center gap-1 text-error">
          <Icon name="error" />
          {error}
        </p>
      )}
    </div>
  );
}
