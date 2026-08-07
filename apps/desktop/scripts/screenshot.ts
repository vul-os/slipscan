#!/usr/bin/env node
/**
 * Real-app screenshotter (VULOS-PRODUCT-STANDARD).
 *
 * Captures every route of the shipped Svelte frontend running under plain
 * `vite dev` — the browser build uses the in-memory mock dataset
 * (src/lib/api/mock.ts), so no backend is needed. Writes PNGs to
 * docs/screenshots/ (standard location; hero.png = dashboard.png), then
 * hands off to scripts/sync-screenshots.ts to mirror them into
 * assets/screens/ and site/screenshots/.
 *
 * Usage:  npm run screenshot          (starts vite itself on :1420)
 *         npm run dev  # elsewhere    (script reuses the running server)
 *
 * The `?screenshot=1` query param hides the sidebar "mock" badge
 * (see src/lib/components/Sidebar.svelte).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { readRoutes } from "./routes.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");
// The gallery is written here and mirrored outward by sync-screenshots.ts.
// This script deliberately does not copy anywhere else: a second, hand-kept
// mirror list is exactly how site/screenshots/ drifted before.
const OUT_DIR = join(repoRoot, "docs", "screenshots");
const BASE = "http://localhost:1420";
const VIEWPORT = { width: 1440, height: 900 };

// The demo book is a South African personal book in ZAR, so it is rendered in
// its own timezone. See the newContext call for why these are pinned at all.
const LOCALE_TZ = "Africa/Johannesburg";
// Mid-morning on the seeds' most recent transaction date, so the greeting
// reads "Good morning" and every month-scoped screen opens on July 2026 —
// the month the demo data actually covers.
const CAPTURE_TIME = "2026-07-16T09:30:00+02:00";

/** Every route, in sidebar order, captured in the dark (brand-first) theme. */
const ROUTES = readRoutes();

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(deadlineMs = 30_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite dev server did not become ready on ${BASE}`);
}

/** Navigate, then wait for fonts + all loaders to settle before capture. */
async function openRoute(page: Page, route: string): Promise<void> {
  await page.goto(`${BASE}/?screenshot=1#/${route}`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  // Skeleton loaders mark themselves aria-busy; wait until none remain.
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
  );
  // Let entry transitions (animate-slide-up) finish.
  await page.waitForTimeout(400);
  // The mock dataset reports its version as "0.1.0-mock"; the real app
  // reports plain semver. Show the real form in captures.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let n; (n = walker.nextNode()); ) {
      if (n.nodeValue?.includes("-mock"))
        n.nodeValue = n.nodeValue.replace("-mock", "");
    }
  });
}

function save(page: Page, name: string): Promise<void> {
  return page
    .screenshot({ path: join(OUT_DIR, `${name}.png`) })
    .then(() => console.log(`  ✓ ${name}.png`));
}

async function main(): Promise<void> {
  let vite: ChildProcess | null = null;
  if (await serverUp()) {
    console.log(`Reusing dev server at ${BASE}`);
  } else {
    console.log("Starting vite dev server…");
    vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
      cwd: appDir,
      stdio: "ignore",
      detached: true,
    });
    await waitForServer();
  }

  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Capturing ${ROUTES.length} routes: ${ROUTES.join(", ")}`);

  const browser = await chromium.launch();
  try {
    for (const themeName of ["dark", "light"] as const) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: themeName === "dark" ? "dark" : "light",
        // lib/format.ts builds every Intl formatter with `undefined` locale,
        // so dates and money render in whatever the host machine happens to
        // be set to. Pin both: these two values are what the committed
        // gallery was rendered with, and without them the same command
        // produces a different gallery on a differently-configured machine.
        // The timezone is load-bearing, not cosmetic — `fmtDate` parses the
        // seeds' date-only strings as UTC midnight, so at a negative offset
        // every date in every capture slides back a day.
        locale: "en-US",
        timezoneId: LOCALE_TZ,
      });
      // Freeze the clock. The dashboard greeting is time-of-day dependent
      // and the seeds are hardcoded to July 2026, so an unpinned run says
      // "Good evening" or "Working late" depending on when it happened, and
      // from August 2026 would open on an empty month and capture a gallery
      // of empty states. setFixedTime (not install) leaves timers running,
      // which the transition waits below still need.
      await context.clock.setFixedTime(new Date(CAPTURE_TIME));
      // Force the theme deterministically (src/lib/theme.svelte.ts reads
      // this key; index.html applies the class before first paint).
      await context.addInitScript(
        (t: string) => localStorage.setItem("slipscan.theme", t),
        themeName,
      );
      const page = await context.newPage();

      if (themeName === "light") {
        // Light theme: dashboard only.
        await openRoute(page, "dashboard");
        await save(page, "dashboard-light");
        await context.close();
        continue;
      }

      for (const route of ROUTES) {
        await openRoute(page, route);
        await save(page, route);

        if (route === "receipts") {
          // Expand one slip for the detail shot. The expander is the button
          // in the first cell (the row itself is not the control), and it
          // carries aria-expanded — that attribute is the settle signal.
          //
          // Prefer the Checkers Sixty60 slip: it is the one seed with line
          // items, a slip-level discount and a reconcile match all at once,
          // so the panel shows every part of the detail view rather than a
          // single lonely row. Any extracted slip will do if it is renamed.
          const preferred = page.locator("tbody tr", {
            has: page.getByText("Checkers Sixty60", { exact: true }),
          });
          const anyExtracted = page.locator("tbody tr", {
            has: page.locator("button[aria-expanded]"),
            hasNot: page.locator("td:last-child", { hasText: "—" }),
          });
          const row = ((await preferred.count()) ? preferred : anyExtracted)
            .first()
            .locator("button[aria-expanded]");
          await row.click();
          await page.waitForSelector('button[aria-expanded="true"]');
          // The panel opens with a reveal transition; let it finish.
          await page.waitForTimeout(450);
          await save(page, "receipt-detail");
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (vite) {
      try {
        process.kill(-vite.pid!, "SIGTERM");
      } catch {
        vite.kill("SIGTERM");
      }
    }
  }

  // hero.png is the dashboard, per the product standard.
  copyFileSync(join(OUT_DIR, "dashboard.png"), join(OUT_DIR, "hero.png"));
  console.log("  ✓ hero.png (copy of dashboard.png)");

  // Mirror outward. sync-screenshots.ts owns which directories exist and
  // which files each one skips (site/ drops hero.png), so it is the only
  // thing that copies — this script just tells it there is new work.
  const sync = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "sync-screenshots.ts")],
    { stdio: "inherit" },
  );
  if (sync.status !== 0) {
    throw new Error(`sync-screenshots exited ${sync.status}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
