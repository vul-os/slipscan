import * as RadixTooltip from "@radix-ui/react-tooltip";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const TooltipProvider = RadixTooltip.Provider;
export const Tooltip = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export const TooltipContent = forwardRef(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 px-2 py-1 rounded text-[12px] font-medium tracking-tight",
          "bg-ink-900 text-ink-0 shadow-popover",
          "animate-fade-in",
          className,
        )}
        {...props}
      />
    </RadixTooltip.Portal>
  ),
);
TooltipContent.displayName = "TooltipContent";
