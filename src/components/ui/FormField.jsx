import { useId } from "react";
import { Label } from "./Label";
import { cn } from "@/lib/cn";

// Bundles label + control + hint/error in one consistent layout. Hand back
// the id so the caller's input gets it via htmlFor — important for a11y.
export function FormField({ label, hint, error, required, className, children }) {
  const id = useId();
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id}>
          {label}
          {required && <span className="text-danger ml-0.5">*</span>}
        </Label>
        {hint && !error && <span className="text-[11px] text-ink-400">{hint}</span>}
      </div>
      {children(id)}
      {error && <p className="text-[12px] text-danger animate-fade-in">{error}</p>}
    </div>
  );
}
