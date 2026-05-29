import { Outlet } from "react-router-dom";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { DocsSidebar } from "./DocsSidebar";
import { DocsToc } from "./DocsToc";

/**
 * DocsLayout — public docs shell.
 *
 * Structure:
 *   <LandingHeader />          (fixed top, brand/auth row)
 *   <main content area>
 *     container grid  ─────────────────────────────────────────
 *     | DocsSidebar (16rem) | <Outlet> (1fr) | DocsToc (14rem) |
 *     ─────────────────────────────────────────────────────────
 *   <footer>
 *
 * The 3-col grid collapses on < lg:
 *   sidebar → details/summary disclosure (rendered inside DocsSidebar)
 *   TOC     → hidden entirely
 */
export default function DocsLayout() {
  return (
    <div className="min-h-screen bg-ink-0 text-ink-900 flex flex-col overflow-x-hidden">
      {/* Shared brand / auth header — light variant for white docs surface */}
      <LandingHeader tone="light" />

      {/* pt-20 to clear the fixed header (h-16 sm:h-20 → use the larger) */}
      <div className="pt-20 flex-1">
        <div className="mx-auto max-w-screen-2xl px-6 lg:px-10">
          {/* 3-column grid on lg+; single-column below */}
          <div className="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)_14rem] lg:gap-10 py-10">
            {/* Left: sticky sidebar */}
            <DocsSidebar />

            {/* Centre: page content via Outlet */}
            <div className="min-w-0">
              <Outlet />
            </div>

            {/* Right: sticky TOC */}
            <DocsToc />
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-ink-200 mt-auto">
        <div className="mx-auto max-w-screen-2xl px-6 lg:px-10 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-[13px] text-ink-500">
          <a
            href="https://github.com/slipscan"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center py-2 hover:text-ink-900 transition-colors underline underline-offset-2 decoration-ink-300 hover:decoration-ink-700"
          >
            Edit this page on GitHub
          </a>
          <span>Last updated 2026-05-28</span>
        </div>
      </footer>
    </div>
  );
}
