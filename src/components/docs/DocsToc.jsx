import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { cn } from "@/lib/cn";

/**
 * DocsToc — sticky right-rail table of contents.
 *
 * On mount (and on route change) it scans `main h2[id], main h3[id]`,
 * builds a flat heading list, and uses IntersectionObserver to highlight
 * whichever heading is currently in view.
 *
 * Hidden entirely below lg breakpoint (per B.3).
 */
export function DocsToc() {
  const { pathname } = useLocation();
  const [headings, setHeadings] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const observerRef = useRef(null);

  useEffect(() => {
    // Small delay so the Outlet content has rendered.
    const timer = setTimeout(() => {
      const nodes = Array.from(
        document.querySelectorAll("main h2[id], main h3[id]"),
      );
      setHeadings(
        nodes.map((el) => ({
          id:    el.id,
          text:  el.textContent.replace(/#\s*$/, "").trim(),
          level: el.tagName === "H2" ? 2 : 3,
        })),
      );

      // Disconnect previous observer before creating a new one.
      if (observerRef.current) observerRef.current.disconnect();

      if (nodes.length === 0) return;

      const observer = new IntersectionObserver(
        (entries) => {
          // Pick the first entry that is intersecting.
          const visible = entries.filter((e) => e.isIntersecting);
          if (visible.length > 0) {
            setActiveId(visible[0].target.id);
          }
        },
        { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
      );

      nodes.forEach((n) => observer.observe(n));
      observerRef.current = observer;
    }, 50);

    return () => {
      clearTimeout(timer);
      if (observerRef.current) observerRef.current.disconnect();
    };
  }, [pathname]);

  if (headings.length === 0) return null;

  return (
    <aside className="hidden lg:block w-56 shrink-0 sticky top-20 self-start">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-ink-500 mb-3">
        On this page
      </p>
      <ul className="space-y-0.5">
        {headings.map(({ id, text, level }) => (
          <li key={id}>
            <a
              href={`#${id}`}
              className={cn(
                "block py-0.5 text-[12px] transition-colors",
                level === 3 ? "pl-3 text-ink-400 hover:text-ink-900" : "text-ink-500 hover:text-ink-900",
                activeId === id && "text-ink-900 font-medium",
              )}
            >
              {text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
