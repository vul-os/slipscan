#!/usr/bin/env node
/**
 * QA screenshotter — every route at three widths in both themes.
 * Writes to a scratch dir passed via QA_OUT (or ./qa-shots).
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.QA_OUT || join(appDir, "qa-shots");
const BASE = "http://localhost:1420";
const WIDTHS = [760, 1100, 1520];
const HEIGHT = 960;
const ROUTES = [
  "dashboard", "transactions", "receipts", "budgets", "ledger",
  "reconcile", "payments", "reports", "settings",
];

async function serverUp() {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}
async function waitForServer(deadlineMs = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (await serverUp()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`vite dev did not start on ${BASE}`);
}

async function openRoute(page, route) {
  await page.goto(`${BASE}/?screenshot=1#/${route}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
  );
  await page.waitForTimeout(500);
}

async function main() {
  let vite = null;
  if (await serverUp()) {
    console.log(`Reusing dev server at ${BASE}`);
  } else {
    console.log("Starting vite dev server…");
    vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], {
      cwd: appDir, stdio: "ignore", detached: true,
    });
    await waitForServer();
  }
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const themeName of ["dark", "light"]) {
      for (const width of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width, height: HEIGHT },
          deviceScaleFactor: 1,
          colorScheme: themeName,
        });
        await context.addInitScript(
          (t) => localStorage.setItem("slipscan.theme", t), themeName,
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
          await page.screenshot({ path: join(OUT, `focus__${width}__${themeName}.png`) });
          console.log(`  ✓ focus__${width}__${themeName}.png`);
        }
        // Receipt detail expansion (full theme only).
        if (width === 1520) {
          await openRoute(page, "receipts");
          try {
            const row = page.locator('tbody tr[role="button"]').first();
            await row.click({ timeout: 3000 });
            await page.waitForSelector('tr[aria-expanded="true"]', { timeout: 3000 });
            await page.waitForTimeout(300);
            await page.screenshot({ path: join(OUT, `receipt-detail__${width}__${themeName}.png`) });
            console.log(`  ✓ receipt-detail__${width}__${themeName}.png`);
          } catch (e) { console.log("  (receipt-detail skipped)", e.message); }
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    if (vite) {
      try { process.kill(-vite.pid, "SIGTERM"); } catch { vite.kill("SIGTERM"); }
    }
  }
  console.log("Done ->", OUT);
}
main().catch((err) => { console.error(err); process.exit(1); });
