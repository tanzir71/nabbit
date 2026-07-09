import { cn } from "../lib/cn";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

export function Toggle({ checked, onChange, label, description }: ToggleProps) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <span className="grid gap-1">
        <span className="text-sm font-medium">{label}</span>
        {description ? <span className="text-xs leading-5 text-slate-500">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={(event) => {
          event.preventDefault();
          onChange(!checked);
        }}
        className={cn(
          "relative mt-0.5 h-5 w-9 rounded-full transition focus:outline-none focus:ring-2 focus:ring-accent-500",
          checked ? "bg-accent-600" : "bg-slate-300 dark:bg-slate-700",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white transition",
            checked ? "left-4" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}
