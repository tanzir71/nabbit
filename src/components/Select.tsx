import { useId, type SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { DesignIcon } from "./DesignIcon";
interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  description?: string;
  error?: string;
}
export function Select({
  label,
  description,
  error,
  className,
  id,
  children,
  "aria-describedby": describedBy,
  ...props
}: SelectProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const helpId = description ? `${inputId}-help` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="n-field">
      <label className="n-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="n-select-wrap">
        <select
          {...props}
          id={inputId}
          className={cn("n-input", "n-select", className)}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={[describedBy, helpId, errorId].filter(Boolean).join(" ") || undefined}
        >
          {children}
        </select>
        <span className="n-select-arrow">
          <DesignIcon name="chevronDown" />
        </span>
      </div>
      {description && (
        <span id={helpId} className="n-help">
          {description}
        </span>
      )}
      {error && (
        <span id={errorId} className="n-field-error">
          {error}
        </span>
      )}
    </div>
  );
}
