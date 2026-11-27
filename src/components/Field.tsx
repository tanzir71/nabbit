import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";
interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  description?: string;
  error?: string;
  action?: ReactNode;
  leading?: ReactNode;
}
export function Field({
  label,
  description,
  error,
  action,
  leading,
  className,
  id,
  "aria-describedby": describedBy,
  ...props
}: FieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const helpId = description ? `${inputId}-help` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className="n-field">
      <div className="n-field-label">
        <label htmlFor={inputId}>{label}</label>
        {action}
      </div>
      <div className={leading ? "n-input-with-icon" : "contents"}>
        {leading ? <span className="n-input-leading">{leading}</span> : null}
        <input
          {...props}
          id={inputId}
          className={cn("n-input", className)}
          aria-invalid={error ? true : props["aria-invalid"]}
          aria-describedby={[describedBy, helpId, errorId].filter(Boolean).join(" ") || undefined}
        />
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
