import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const Card = forwardRef(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("bg-ink-0 rounded-lg shadow-card", className)}
      {...props}
    />
  ),
);
Card.displayName = "Card";

export const CardHeader = forwardRef(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("px-5 pt-5 pb-4 border-b border-ink-100", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

export const CardBody = forwardRef(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-5", className)} {...props} />
  ),
);
CardBody.displayName = "CardBody";

export const CardTitle = forwardRef(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("text-base font-medium tracking-tight text-ink-900", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

export const CardSubtitle = forwardRef(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("text-sm text-ink-500 mt-0.5", className)} {...props} />
  ),
);
CardSubtitle.displayName = "CardSubtitle";
