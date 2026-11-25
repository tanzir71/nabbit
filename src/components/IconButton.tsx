import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  active?: boolean;
  size?: 28 | 32;
  variant?: "ghost" | "subtle" | "island";
}

export function IconButton({
  label,
  children,
  className,
  active,
  size = 32,
  variant = "ghost",
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      aria-pressed={active ?? props["aria-pressed"]}
      title={label}
      className={cn(
        "n-icon-button",
        `n-icon-button--${variant}`,
        size === 28 && "n-icon-button--small",
        active && "is-active",
        className,
      )}
    >
      {children}
    </button>
  );
}
