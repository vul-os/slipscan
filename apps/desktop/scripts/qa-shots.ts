#!/usr/bin/env node
/**
 * QA screenshotter — every route at three widths in both themes.
 *
 * This is the responsive/accessibility sweep, not the gallery: it exists to
 * be looked through by a human before a UI change lands, and it covers two
 * things the published gallery (scripts/screenshot.ts, a single 1440px dark
 * shot per route) structurally cannot.
 *
 *   - The `rail` breakpoint. The sidebar collapses to an icon rail below
 *     ~900px, so 760 sits under it and 1100/1520 above — the one capture that
 *     proves the collapse still works in both directions.
 *   - Focus rings. A keyboard-reachability regression is invisible in every
 *     other artifact this repo produces.
 *
 * Run it with `npm run qa:shots`. Output is disposable and goes to a temp
 * directory (override with QA_OUT); nothing here is committed, which is why
 * it writes outside the repo rather than to a path someone has to remember
 * not to `git add`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { readRoutes } from "./routes.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.QA_OUT || join(tmpdir(), "slipscan-qa-shots");
const BASE = "http://localhost:1420";
const WIDTHS = [760, 1100, 1520] as const;
const HEIGHT = 960;
// Same authority as the gallery — see scripts/routes.ts. This list used to
// be inline here too, and was missing `household` and `packs`.
const ROUTES = readRoutes();
// The sweep is compared run-to-run by eye, so it is pinned exactly as the
// gallery is: an unpinned clock changes the dashboard greeting and, after
// July 2026, empties every month-scoped screen. See screenshot.ts.
const LOCALE_TZ = "Africa/Johannesburg";
const CAPTURE_TIME = "2026-07-16T09:30:00+02:00";

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
async function waitForServer(deadlineMs = 40_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite dev did not start on ${BASE}`);
}

async function openRoute(page: Page, route: string): Promise<void> {
  await page.goto(`${BASE}/?screenshot=1#/${route}`, {
    waitUntil: "networkidle",
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
  );
  await page.waitForTimeout(500);
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
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const themeName of ["dark", "light"] as const) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width, height: HEIGHT },
          deviceScaleFactor: 1,
          colorScheme: themeName,
          locale: "en-US",
          timezoneId: LOCALE_TZ,
        });
        await context.clock.setFixedTime(new Date(CAPTURE_TIME));
        await context.addInitScript(
          (t: string) => localStorage.setItem("slipscan.theme", t),
          themeName,
        );
        const page = await context.newPage();
        for (const route of ROUTES) {
          await openRoute(page, route);
          const name = `${route}__${width}__${themeName}`;
          await page.screenshot({ path: join(OUT, `${name}.png`) });
          console.log(`  ✓ ${name}.png`);
        }
        // Focus-ring capture: tab into the UI (skip-link -> ...).
        if (width === 1100) {
          await openRoute(page, "settings");
          await page.keyboard.press("Tab"); // skip link
          await page.keyboard.press("Tab"); // first real control
          await page.keyboard.press("Tab");
          await page.waitForTimeout(200);
          await page.screenshot({
            path: join(OUT, `focus__${width}__${themeName}.png`),
          });
          console.log(`  ✓ focus__${width}__${themeName}.png`);
        }
        // Receipt detail expansion (full theme only).
        if (width === 1520) {
          await openRoute(page, "receipts");
          try {
            // The expander is the button in the row's first cell, not the
            // row — see the matching note in screenshot.ts.
            const row = page.locator("tbody button[aria-expanded]").first();
            await row.click({ timeout: 3000 });
            await page.waitForSelector('button[aria-expanded="true"]', {
              timeout: 3000,
            });
            await page.waitForTimeout(450);
            await page.screenshot({
              path: join(OUT, `receipt-detail__${width}__${themeName}.png`),
            });
            console.log(`  ✓ receipt-detail__${width}__${themeName}.png`);
          } catch (e) {
            console.log(
              "  (receipt-detail skipped)",
              e instanceof Error ? e.message : String(e),
            );
          }
        }
        await context.close();
      }
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
  console.log("Done ->", OUT);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
