#!/usr/bin/env node
/**
 * Real-app screenshotter (VULOS-PRODUCT-STANDARD).
 *
 * Captures every route of the shipped Svelte frontend running under plain
 * `vite dev` — the browser build uses the in-memory mock dataset
 * (src/lib/api/mock.ts), so no backend is needed. Writes PNGs to
 * docs/screenshots/ (standard location; hero.png = dashboard.png) and
 * mirrors them into assets/screens/ for README/site references.
 *
 * Usage:  npm run screenshot          (starts vite itself on :1420)
 *         npm run dev  # elsewhere    (script reuses the running server)
 *
 * The `?screenshot=1` query param hides the sidebar "mock" badge
 * (see src/lib/components/Sidebar.svelte).
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");
const OUT_DIRS = [
  join(repoRoot, "docs", "screenshots"),
  join(repoRoot, "assets", "screens"),
];
const BASE = "http://localhost:1420";
const VIEWPORT = { width: 1440, height: 900 };

/** Routes registered in src/App.svelte, captured in dark (brand-first) theme. */
const ROUTES = [
  "dashboard",
  "transactions",
  "receipts",
  "budgets",
  "ledger",
  "reconcile",
  "reports",
  "settings",
];

async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(deadlineMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite dev server did not become ready on ${BASE}`);
}

/** Navigate, then wait for fonts + all loaders to settle before capture. */
async function openRoute(page, route) {
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

function save(page, name) {
  return page
    .screenshot({ path: join(OUT_DIRS[0], `${name}.png`) })
    .then(() => console.log(`  ✓ ${name}.png`));
}

async function main() {
  let vite = null;
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

  for (const dir of OUT_DIRS) mkdirSync(dir, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const themeName of ["dark", "light"]) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: themeName === "dark" ? "dark" : "light",
      });
      // Force the theme deterministically (src/lib/theme.svelte.ts reads
      // this key; index.html applies the class before first paint).
      await context.addInitScript(
        (t) => localStorage.setItem("slipscan.theme", t),
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
          // Expand the first receipt that has an extraction (confidence
          // column not "—") for the detail shot.
          const row = page
            .locator('tbody tr[role="button"]', {
              hasNot: page.locator("td:last-child", { hasText: "—" }),
            })
            .first();
          await row.click();
          await page.waitForSelector('tr[aria-expanded="true"]');
          await page.waitForTimeout(250);
          await save(page, "receipt-detail");
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (vite) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {
        vite.kill("SIGTERM");
      }
    }
  }

  // hero.png is the dashboard, per the product standard.
  copyFileSync(
    join(OUT_DIRS[0], "dashboard.png"),
    join(OUT_DIRS[0], "hero.png"),
  );
  console.log("  ✓ hero.png (copy of dashboard.png)");

  // Mirror everything into assets/screens/ (same filenames).
  const names = [...ROUTES, "receipt-detail", "dashboard-light"];
  for (const name of names) {
    copyFileSync(
      join(OUT_DIRS[0], `${name}.png`),
      join(OUT_DIRS[1], `${name}.png`),
    );
  }
  console.log(`Mirrored ${names.length} screenshots into assets/screens/`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
