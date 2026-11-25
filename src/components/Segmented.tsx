import type { CSSProperties } from "react";
import { cn } from "../lib/cn";

interface Segment<T extends string | number> {
  label: string;
  value: T;
}

interface SegmentedProps<T extends string | number> {
  value: T;
  options: Segment<T>[];
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-[repeat(var(--count),minmax(0,1fr))] gap-1 rounded-lg bg-sunken p-1"
      style={{ "--count": options.length } as CSSProperties}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-8 rounded-md px-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action-primary",
            value === option.value
              ? "bg-surface text-primary shadow-sm"
              : "text-secondary hover:text-primary",
          )}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
