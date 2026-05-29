import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { Wordmark } from "@/components/Wordmark";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/cn";

const SCROLL_THRESHOLD = 8;

// Fixed-top header for the landing page. Transparent while sitting over
// the dark hero, then snaps to a frosted ink-950/85 surface as soon as
// the user scrolls — keeps copy readable when content scrolls underneath.
// `tone="light"` is for pages without a dark hero (e.g. /docs) — header is
// opaque white from the start and brand/links read against a light surface.
export function LandingHeader({ tone = "dark" }) {
  const [scrolled, setScrolled] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isAuthed = !!useAuthStore((s) => s.accessToken);
  const light = tone === "light";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close drawer on route change / escape
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setDrawerOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const navLinkClass = cn(
    "h-10 px-3 sm:px-4 inline-flex items-center",
    "text-[13px] sm:text-sm font-medium tracking-tight transition-colors",
    light
      ? "text-ink-600 hover:text-ink-900"
      : "text-ink-200 hover:text-ink-0",
  );

  return (
    <header
      className={cn(
        "fixed top-0 inset-x-0 z-50",
        "transition-[background-color,backdrop-filter,border-color] duration-200 ease-out-cubic",
        light
          ? "bg-ink-0/90 backdrop-blur-md border-b border-ink-200"
          : scrolled
            ? "bg-ink-950/85 backdrop-blur-md border-b border-ink-0/10"
            : "bg-transparent border-b border-transparent",
      )}
    >
      <div className="mx-auto max-w-7xl h-16 sm:h-20 px-5 sm:px-8 lg:px-12 flex items-center justify-between gap-4">
        <Link to="/" aria-label="slip/scan home" className="inline-flex shrink-0 items-center h-10">
          <Wordmark size="md" tone={light ? "light" : "dark"} />
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          {/* Desktop nav links — hidden below sm */}
          <Link to="/docs" className={cn(navLinkClass, "hidden sm:inline-flex")}>
            Docs
          </Link>
          <Link to="/#pricing" className={cn(navLinkClass, "hidden sm:inline-flex")}>
            Pricing
          </Link>

          {isAuthed ? (
            <Link
              to="/dashboard"
              className={cn(
                "h-10 px-4 inline-flex items-center gap-1.5 rounded-md",
                "bg-accent text-accent-fg text-[13px] sm:text-sm font-medium tracking-tight",
                "hover:bg-[#D9FF40] active:bg-[#B8EE00] transition-colors shadow-card",
              )}
            >
              Open dashboard
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className={cn(navLinkClass, "hidden sm:inline-flex")}
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className={cn(
                  "hidden sm:inline-flex",
                  "h-10 px-4 items-center gap-1.5 rounded-md",
                  "bg-accent text-accent-fg text-[13px] sm:text-sm font-medium tracking-tight",
                  "hover:bg-[#D9FF40] active:bg-[#B8EE00] transition-colors shadow-card",
                )}
              >
                Get started
              </Link>
            </>
          )}

          {/* Hamburger — visible only below sm */}
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            aria-expanded={drawerOpen}
            className={cn(
              "sm:hidden inline-flex items-center justify-center w-10 h-10 rounded-md transition-colors",
              light
                ? "text-ink-600 hover:text-ink-900 hover:bg-ink-100"
                : "text-ink-200 hover:text-ink-0 hover:bg-ink-0/10",
            )}
          >
            {drawerOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      <div
        className={cn(
          "sm:hidden absolute top-full inset-x-0 z-40",
          "transition-transform duration-200 ease-out-cubic",
          drawerOpen ? "translate-y-0" : "-translate-y-[110%]",
          light
            ? "bg-ink-0/95 backdrop-blur-md border-b border-ink-200"
            : "bg-ink-950/95 backdrop-blur-md border-b border-ink-0/10",
        )}
        aria-hidden={!drawerOpen}
      >
        <nav className="flex flex-col px-5 py-4 gap-1">
          <Link
            to="/docs"
            onClick={() => setDrawerOpen(false)}
            className={cn(
              "h-11 px-3 inline-flex items-center text-sm font-medium tracking-tight rounded-md transition-colors",
              light
                ? "text-ink-600 hover:text-ink-900 hover:bg-ink-100"
                : "text-ink-200 hover:text-ink-0 hover:bg-ink-0/8",
            )}
          >
            Docs
          </Link>
          <Link
            to="/#pricing"
            onClick={() => setDrawerOpen(false)}
            className={cn(
              "h-11 px-3 inline-flex items-center text-sm font-medium tracking-tight rounded-md transition-colors",
              light
                ? "text-ink-600 hover:text-ink-900 hover:bg-ink-100"
                : "text-ink-200 hover:text-ink-0 hover:bg-ink-0/8",
            )}
          >
            Pricing
          </Link>

          {isAuthed ? (
            <Link
              to="/dashboard"
              onClick={() => setDrawerOpen(false)}
              className={cn(
                "mt-2 h-11 px-3 inline-flex items-center justify-center rounded-md text-sm font-medium tracking-tight",
                "bg-accent text-accent-fg hover:bg-[#D9FF40] transition-colors shadow-card",
              )}
            >
              Open dashboard
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                onClick={() => setDrawerOpen(false)}
                className={cn(
                  "h-11 px-3 inline-flex items-center text-sm font-medium tracking-tight rounded-md transition-colors",
                  light
                    ? "text-ink-600 hover:text-ink-900 hover:bg-ink-100"
                    : "text-ink-200 hover:text-ink-0 hover:bg-ink-0/8",
                )}
              >
                Sign in
              </Link>
              <Link
                to="/register"
                onClick={() => setDrawerOpen(false)}
                className={cn(
                  "mt-2 h-11 px-3 inline-flex items-center justify-center rounded-md text-sm font-medium tracking-tight",
                  "bg-accent text-accent-fg hover:bg-[#D9FF40] transition-colors shadow-card",
                )}
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
