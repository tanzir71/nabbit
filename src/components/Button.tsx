import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "icon";
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("n-button", `n-button--${variant}`, `n-button--${size}`, className)}
      {...props}
    >
      {children}
    </button>
  );
}
