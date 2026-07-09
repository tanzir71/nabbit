import type { InputHTMLAttributes, ReactNode } from "react";

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  description?: string;
  action?: ReactNode;
}

export function Field({ label, description, action, className, ...props }: FieldProps) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
        {action}
      </span>
      <input
        className={`h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-accent-500 focus:ring-2 focus:ring-accent-100 dark:border-slate-800 dark:bg-slate-950 dark:focus:ring-accent-950 ${className ?? ""}`}
        {...props}
      />
      {description ? <span className="text-xs leading-5 text-slate-500">{description}</span> : null}
    </label>
  );
}
