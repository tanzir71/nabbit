import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium transition focus:outline-none focus:ring-2 focus:ring-action-primary focus:ring-offset-2 focus:ring-offset-surface disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" && "bg-action-primary text-action-on-primary hover:opacity-90",
        variant === "secondary" && "border border-subtle bg-surface text-primary hover:bg-sunken",
        variant === "ghost" && "text-secondary hover:bg-sunken hover:text-primary",
        variant === "danger" && "bg-danger-soft text-danger-base hover:opacity-90",
        size === "sm" && "h-8 px-2.5 text-xs",
        size === "md" && "h-9 px-3 text-sm",
        size === "icon" && "size-8",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
