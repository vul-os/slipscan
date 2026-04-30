import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/cn";

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap select-none " +
  "font-medium tracking-tight transition-colors duration-150 ease-out-cubic " +
  "disabled:pointer-events-none disabled:opacity-50 " +
  "focus-visible:outline-none",
  {
    variants: {
      variant: {
        primary:
          "bg-ink-950 text-ink-0 hover:bg-ink-800 active:bg-ink-900 " +
          "shadow-card",
        accent:
          "bg-accent text-accent-fg hover:bg-[#D9FF40] active:bg-[#B8EE00] " +
          "shadow-card",
        secondary:
          "bg-ink-0 text-ink-900 border border-ink-200 " +
          "hover:bg-ink-50 active:bg-ink-100",
        ghost:
          "bg-transparent text-ink-700 hover:bg-ink-100 active:bg-ink-200",
        destructive:
          "bg-danger text-ink-0 hover:bg-[#B91C1C] active:bg-[#991B1B]",
        link:
          "bg-transparent text-ink-900 underline underline-offset-4 " +
          "decoration-ink-300 hover:decoration-ink-700 hover:text-ink-950 px-0 h-auto",
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded",
        md: "h-10 px-4 text-sm rounded-md",
        lg: "h-12 px-6 text-base rounded-md",
        icon: "h-9 w-9 rounded",
        "icon-sm": "h-7 w-7 rounded",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export const Button = forwardRef(
  ({ className, variant, size, asChild, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonStyles({ variant, size }), className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? <Spinner /> : children}
      </Comp>
    );
  },
);
Button.displayName = "Button";

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="animate-spin">
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      <path d="M7 1.5 A 5.5 5.5 0 0 1 12.5 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
