import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/cn";
import { DOCS_NAV, EXISTING_PATHS } from "./navConfig";

/**
 * DocsSidebar — sticky left-rail navigation for the docs site.
 *
 * Active item: border-l-2 border-accent + bg-ink-50 + font-medium text-ink-900.
 * Disabled items (not yet built): greyed out, no Link wrapper, cursor-not-allowed.
 *
 * Mobile: renders as a <details> disclosure at the top of the page.
 */
export function DocsSidebar() {
  const { pathname } = useLocation();

  const navContent = (
    <nav aria-label="Docs navigation">
      {DOCS_NAV.map(({ group, items }) => (
        <div key={group}>
          <p className="label-eyebrow text-ink-500 mt-6 mb-2 text-[11px] font-semibold uppercase tracking-widest px-3">
            {group}
          </p>
          <ul>
            {items.map(({ title, path }) => {
              const exists = EXISTING_PATHS.has(path);
              // Normalise: /docs/features matches items starting with /docs/features
              // but for exact active matching we compare the full pathname.
              const isActive = pathname === path;

              if (!exists) {
                return (
                  <li key={path}>
                    <span
                      title="Coming soon"
                      className="block px-3 py-2 lg:py-1.5 text-[13px] rounded text-ink-400 cursor-not-allowed select-none"
                    >
                      {title}
                    </span>
                  </li>
                );
              }

              return (
                <li key={path}>
                  <Link
                    to={path}
                    className={cn(
                      "block px-3 py-2 lg:py-1.5 text-[13px] rounded transition-colors",
                      isActive
                        ? "border-l-2 border-accent text-ink-900 font-medium bg-ink-50 pl-[calc(0.75rem-2px)]"
                        : "text-ink-600 hover:bg-ink-100 hover:text-ink-900",
                    )}
                  >
                    {title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* Mobile: details/summary disclosure */}
      <details className="lg:hidden mb-6 border border-ink-200 rounded-md">
        <summary className="px-4 py-3 text-[13px] font-medium text-ink-700 cursor-pointer select-none list-none flex items-center justify-between">
          Browse docs
          <span className="text-ink-400" aria-hidden>▾</span>
        </summary>
        <div className="border-t border-ink-200 px-2 pb-3">
          {navContent}
        </div>
      </details>

      {/* Desktop: full sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 sticky top-20 self-start max-h-[calc(100vh-5rem)] overflow-y-auto">
        {navContent}
      </aside>
    </>
  );
}
