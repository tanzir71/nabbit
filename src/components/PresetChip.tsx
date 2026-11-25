import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";
interface PresetChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
  surface?: "light" | "island";
  meta?: ReactNode;
}
export function PresetChip({
  selected = false,
  surface = "light",
  meta,
  className,
  type = "button",
  children,
  ...props
}: PresetChipProps) {
  return (
    <button
      {...props}
      type={type}
      aria-pressed={selected}
      className={cn("n-preset", `n-preset--${surface}`, selected && "is-selected", className)}
    >
      <span>{children}</span>
      {meta != null && <span className="n-preset-meta">{meta}</span>}
    </button>
  );
}
