import { forwardRef } from "react";
import * as RadixLabel from "@radix-ui/react-label";
import { cn } from "@/lib/cn";

export const Label = forwardRef(
  ({ className, ...props }, ref) => (
    <RadixLabel.Root
      ref={ref}
      className={cn(
        "label-eyebrow block",
        className,
      )}
      {...props}
    />
  ),
);
Label.displayName = "Label";
