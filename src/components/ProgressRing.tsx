import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";
interface ProgressRingProps extends HTMLAttributes<HTMLSpanElement> {
  value: number;
  label: string;
  size?: number;
}
export function ProgressRing({ value, label, size = 20, className, ...props }: ProgressRingProps) {
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  // Outer radius 10, inner 7: the specified 70% inner radius at every size.
  return (
    <span
      {...props}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className={cn("n-progress-ring", className)}
      style={{ ...props.style, width: size, height: size }}
    >
      <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--island-track)" strokeWidth="3" />
        <circle
          cx="10"
          cy="10"
          r="8.5"
          fill="none"
          stroke="var(--signal-base)"
          strokeWidth="3"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - progress}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </span>
  );
}
