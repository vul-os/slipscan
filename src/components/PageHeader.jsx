import { cn } from "@/lib/cn";

// Editorial page header: small eyebrow, large display title, optional
// description, action area on the right. Used at the top of every screen.
export function PageHeader({ eyebrow, title, description, actions, className }) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-6 pb-8", className)}>
      <div className="min-w-0">
        {eyebrow && <p className="label-eyebrow mb-2">{eyebrow}</p>}
        <h1 className="text-display-lg text-ink-900">{title}</h1>
        {description && <p className="mt-2 text-sm text-ink-500 max-w-xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
