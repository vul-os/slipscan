import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const Input = forwardRef(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-10 w-full px-3 py-2",
        "rounded-md bg-ink-0 border border-ink-200 text-sm text-ink-900",
        "placeholder:text-ink-400",
        "transition-colors duration-150 ease-out-cubic",
        "hover:border-ink-300",
        "focus:border-ink-900 focus:outline-none focus:ring-0",
        "focus-visible:shadow-focus",
        "disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-400",
        "tnum",
        invalid && "border-danger focus:border-danger",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
