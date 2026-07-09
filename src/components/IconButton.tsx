import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
}

export function IconButton({ label, children, className, active, ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-50",
        active && "bg-accent-50 text-accent-700 dark:bg-accent-950 dark:text-accent-100",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
