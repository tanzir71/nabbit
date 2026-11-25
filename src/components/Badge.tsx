import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";
interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "signal" | "danger" | "warning";
}
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return <span {...props} className={cn("n-badge", `n-badge--${tone}`, className)} />;
}
