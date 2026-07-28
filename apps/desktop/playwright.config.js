// Playwright end-to-end configuration.
//
// The plumbing mirrors scripts/screenshot.mjs, which already boots vite on
// :1420 and walks every route: same port (the Tauri dev convention, pinned by
// vite.config.ts and src-tauri/tauri.conf.json devUrl), same reliance on the
// browser build falling back to the in-memory mock dataset so no backend,
// database or network is involved.
//
// Specs live under src/__tests__/e2e/ next to the jsdom suite. The two are
// complementary, not redundant: vitest mounts components directly and is what
// runs on every push; these drive the real bundle in a real browser, so they
// also cover the hash router, the Vite build graph and layout/CSS-dependent
// behaviour that jsdom cannot see.
//
// Browsers are not vendored — run `npx playwright install chromium` once.

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.VITE_PORT ?? 1420);

export default defineConfig({
  testDir: "./src/__tests__/e2e",
  testMatch: "**/*.spec.js",

  timeout: 30_000,
  // A cold vite dev server compiles on first request; the first navigation is
  // the slow one.
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  forbidOnly: !!process.env.CI,

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // strictPort is set in vite.config.ts, so this either binds :1420 or fails
    // loudly rather than drifting to another port behind our back.
    command: "npm run dev",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
