import type { InputHTMLAttributes, ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  description?: string;
  action?: ReactNode;
}

export function Field({ label, description, action, className, ...props }: FieldProps) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-secondary">
        {label}
        {action}
      </span>
      <input
        className={`h-9 rounded-md border border-subtle bg-surface px-3 text-sm outline-none transition focus:border-strong focus:ring-2 focus:ring-action-primary/20    ${className ?? ""}`}
        {...props}
      />
      {description ? <span className="text-xs leading-5 text-secondary">{description}</span> : null}
    </label>
  );
}
