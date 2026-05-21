import { cn } from "@/lib/cn";

// Empty states should feel intentional — short copy, generous space,
// optional action. Used on receipts list, members list, etc.
export function EmptyState({ icon, title, description, action, className }) {
  return (
    <div className={cn(
      "flex flex-col items-center justify-center text-center px-6 py-16",
      className,
    )}>
      {icon && (
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-ink-100 text-ink-500">
          {icon}
        </div>
      )}
      <h3 className="text-base font-medium tracking-tight text-ink-900">{title}</h3>
      {description && <p className="mt-1.5 text-sm text-ink-500 max-w-sm">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
