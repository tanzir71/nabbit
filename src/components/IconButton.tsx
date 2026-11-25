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
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-secondary transition hover:bg-sunken hover:text-primary focus:outline-none focus:ring-2 focus:ring-action-primary",
        active && "bg-raised text-primary",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
