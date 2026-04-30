import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Wordmark } from "@/components/Wordmark";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/cn";

const SCROLL_THRESHOLD = 8;

// Fixed-top header for the landing page. Transparent while sitting over
// the dark hero, then snaps to a frosted ink-950/85 surface as soon as
// the user scrolls — keeps copy readable when content scrolls underneath.
export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const isAuthed = !!useAuthStore((s) => s.accessToken);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SCROLL_THRESHOLD);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed top-0 inset-x-0 z-50",
        "transition-[background-color,backdrop-filter,border-color] duration-200 ease-out-cubic",
        scrolled
          ? "bg-ink-950/85 backdrop-blur-md border-b border-ink-0/10"
          : "bg-transparent border-b border-transparent",
      )}
    >
      <div className="mx-auto max-w-7xl h-16 sm:h-20 px-5 sm:px-8 lg:px-12 flex items-center justify-between gap-4">
        <Link to="/" aria-label="slip/scan home" className="inline-flex shrink-0">
          <Wordmark size="md" tone="dark" />
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          {isAuthed ? (
            <Link
              to="/dashboard"
              className={cn(
                "h-9 sm:h-10 px-4 inline-flex items-center gap-1.5 rounded-md",
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
                className={cn(
                  "h-9 sm:h-10 px-3 sm:px-4 inline-flex items-center",
                  "text-[13px] sm:text-sm font-medium tracking-tight",
                  "text-ink-200 hover:text-ink-0 transition-colors",
                )}
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className={cn(
                  "h-9 sm:h-10 px-4 inline-flex items-center gap-1.5 rounded-md",
                  "bg-accent text-accent-fg text-[13px] sm:text-sm font-medium tracking-tight",
                  "hover:bg-[#D9FF40] active:bg-[#B8EE00] transition-colors shadow-card",
                )}
              >
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
