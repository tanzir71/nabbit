import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <kbd {...props} className={cn("n-kbd", className)} />;
}
