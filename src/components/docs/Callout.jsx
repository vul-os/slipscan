import { Info, Sparkles, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

const VARIANTS = {
  info: {
    wrapper: "border-blue-200 bg-blue-50 text-blue-900",
    icon:    "text-blue-500",
    Icon:    Info,
  },
  tip: {
    wrapper: "border-accent/40 bg-accent/10 text-ink-900",
    icon:    "text-accent-ring",
    Icon:    Sparkles,
  },
  warn: {
    wrapper: "border-amber-200 bg-amber-50 text-amber-900",
    icon:    "text-amber-500",
    Icon:    AlertTriangle,
  },
};

/**
 * Callout — contextual notice block.
 * @param {"info"|"tip"|"warn"} variant
 */
export function Callout({ variant = "info", children, className }) {
  const { wrapper, icon, Icon } = VARIANTS[variant] ?? VARIANTS.info;
  return (
    <div className={cn("flex gap-3 p-4 rounded-md border my-6", wrapper, className)}>
      <Icon size={20} className={cn("shrink-0 mt-0.5", icon)} aria-hidden />
      <div className="text-[14px] leading-[1.6] [&_a]:underline [&_a]:underline-offset-2">
        {children}
      </div>
    </div>
  );
}
