import { cva } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeStyles = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tracking-tight",
  {
    variants: {
      tone: {
        neutral: "bg-ink-100 text-ink-700 ring-1 ring-inset ring-ink-200",
        accent:  "bg-accent-muted text-ink-900 ring-1 ring-inset ring-accent-ring/30",
        success: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
        warning: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
        danger:  "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({ className, tone, dot, children, ...props }) {
  return (
    <span className={cn(badgeStyles({ tone }), className)} {...props}>
      {dot && <DotForTone tone={tone ?? "neutral"} />}
      {children}
    </span>
  );
}

function DotForTone({ tone }) {
  const cls =
    tone === "success" ? "bg-emerald-500"
    : tone === "warning" ? "bg-amber-500"
    : tone === "danger" ? "bg-red-500"
    : tone === "accent" ? "bg-accent-ring"
    : "bg-ink-400";
  return <span className={cn("h-1.5 w-1.5 rounded-full", cls)} />;
}
