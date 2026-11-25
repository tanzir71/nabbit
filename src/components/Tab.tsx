import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";
interface TabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}
export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { selected = false, className, type = "button", children, ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      aria-pressed={selected}
      className={cn("n-tab", selected && "is-selected", className)}
    >
      {children}
    </button>
  );
});
