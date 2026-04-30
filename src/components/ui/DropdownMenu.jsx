import * as DM from "@radix-ui/react-dropdown-menu";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";
import { Check } from "lucide-react";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;

export const DropdownMenuContent = forwardRef(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[180px] overflow-hidden",
          "rounded-md bg-ink-0 shadow-popover p-1",
          "animate-slide-up",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef(
  ({ className, destructive, ...props }, ref) => (
    <DM.Item
      ref={ref}
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 text-sm rounded cursor-pointer select-none",
        "outline-none transition-colors",
        "data-[highlighted]:bg-ink-100 data-[highlighted]:text-ink-900",
        destructive
          ? "text-danger data-[highlighted]:bg-red-50 data-[highlighted]:text-danger"
          : "text-ink-700",
        "data-[disabled]:opacity-50 data-[disabled]:pointer-events-none",
        className,
      )}
      {...props}
    />
  ),
);
DropdownMenuItem.displayName = "DropdownMenuItem";

export const DropdownMenuLabel = forwardRef(
  ({ className, ...props }, ref) => (
    <DM.Label
      ref={ref}
      className={cn("label-eyebrow px-2.5 pt-2 pb-1", className)}
      {...props}
    />
  ),
);
DropdownMenuLabel.displayName = "DropdownMenuLabel";

export const DropdownMenuSeparator = forwardRef(
  ({ className, ...props }, ref) => (
    <DM.Separator ref={ref} className={cn("h-px bg-ink-100 my-1 -mx-1", className)} {...props} />
  ),
);
DropdownMenuSeparator.displayName = "DropdownMenuSeparator";

export const DropdownMenuCheckboxItem = forwardRef(
  ({ className, children, checked, ...props }, ref) => (
    <DM.CheckboxItem
      ref={ref}
      checked={checked}
      className={cn(
        "flex items-center gap-2 pl-7 pr-2.5 py-1.5 text-sm rounded cursor-pointer select-none relative",
        "outline-none transition-colors text-ink-700",
        "data-[highlighted]:bg-ink-100 data-[highlighted]:text-ink-900",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DM.ItemIndicator><Check size={12} /></DM.ItemIndicator>
      </span>
      {children}
    </DM.CheckboxItem>
  ),
);
DropdownMenuCheckboxItem.displayName = "DropdownMenuCheckboxItem";
