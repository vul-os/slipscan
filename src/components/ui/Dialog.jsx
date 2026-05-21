import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DialogContent = forwardRef(
  ({ className, children, hideClose, ...props }, ref) => (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-[2px] animate-fade-in" />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          "fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          "w-[min(92vw,520px)] max-h-[90vh] overflow-auto",
          "rounded-lg bg-ink-0 shadow-popover animate-slide-up",
          "focus:outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <RadixDialog.Close
            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded text-ink-400 hover:text-ink-700 hover:bg-ink-100 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  ),
);
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }) {
  return <div className={cn("px-6 pt-6 pb-4", className)} {...props} />;
}

export function DialogBody({ className, ...props }) {
  return <div className={cn("px-6 pb-2", className)} {...props} />;
}

export function DialogFooter({ className, ...props }) {
  return <div className={cn("px-6 py-4 flex items-center justify-end gap-2 border-t border-ink-100 mt-2", className)} {...props} />;
}

export const DialogTitle = forwardRef(
  ({ className, ...props }, ref) => (
    <RadixDialog.Title
      ref={ref}
      className={cn("text-lg font-medium tracking-tight text-ink-900", className)}
      {...props}
    />
  ),
);
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = forwardRef(
  ({ className, ...props }, ref) => (
    <RadixDialog.Description
      ref={ref}
      className={cn("text-sm text-ink-500 mt-1", className)}
      {...props}
    />
  ),
);
DialogDescription.displayName = "DialogDescription";
