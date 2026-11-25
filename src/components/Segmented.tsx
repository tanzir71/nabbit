import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { Tab } from "./Tab";
interface Segment<T extends string | number> {
  label: string;
  value: T;
  icon?: ReactNode;
  disabled?: boolean;
}
interface SegmentedProps<T extends string | number> {
  value: T;
  options: readonly Segment<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: SegmentedProps<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => !disabled && !option.disabled);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!enabled.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = enabled.findIndex((entry) => entry.index === index);
    const target =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabled.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length;
    const next = enabled[target];
    onChange(next.option.value);
    buttons.current[next.index]?.focus();
  }
  if (!options.length) return null;
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("n-segmented", className)}
      style={{ "--count": options.length } as CSSProperties}
    >
      {options.map((option, index) => (
        <Tab
          key={option.value}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          selected={value === option.value}
          disabled={disabled || option.disabled}
          onKeyDown={(event) => navigate(event, index)}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </Tab>
      ))}
    </div>
  );
}
