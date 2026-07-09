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
      aria-label={label}
      className="grid grid-cols-[repeat(var(--count),minmax(0,1fr))] gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900"
      style={{ "--count": options.length } as CSSProperties}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "min-h-8 rounded-md px-2 text-xs font-medium transition",
            value === option.value
              ? "bg-white text-slate-950 shadow-sm dark:bg-slate-800 dark:text-white"
              : "text-slate-500 hover:text-slate-950 dark:hover:text-white",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
