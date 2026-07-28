// Browser-level render smoke over every route.
//
// The jsdom suite (src/__tests__/render-smoke.test.ts) mounts components in
// isolation. This one loads the real bundle in a real browser, so it covers
// what that cannot: the hash router, the Vite module graph, and any code that
// only runs against a genuine layout engine.
//
// No backend: outside Tauri, src/lib/api/client.ts serves every call from the
// in-memory mock dataset (src/lib/api/mock.ts) — the same property
// scripts/screenshot.mjs relies on.
//
// Failure modes this catches that `npm run build` does not: an uncaught
// exception that blanks the pane, a loader that never resolves and leaves the
// skeletons up forever, a route dropped from the router, money that stops
// going through fmtMoney.

import { expect, test } from "@playwright/test";

/** Mirrors ROUTES in src/lib/router.svelte.ts. */
const ROUTES = [
  ["dashboard", "R 56,844.22"],
  ["transactions", "WOOLWORTHS 178 CLAREMONT"],
  ["receipts", "sixty60-slip.pdf"],
  ["budgets", "R 15,300.00"],
  ["household", "Alex"],
  ["ledger", "Bank — FNB Cheque"],
  ["reconcile", "TAKEALOT.COM CPT"],
  ["payments", "RENT-12B"],
  ["reports", "Net refundable"],
  ["packs", "South African retail merchants"],
  ["settings", "~/SlipScan/personal.slipscan.db"],
];

/** Headings, where they are not simply the route name title-cased. */
const HEADINGS = { dashboard: null };

/**
 * The mock dataset's transactions are dated July 2026, so the month-scoped
 * screens need "now" to sit inside that window to have anything to show.
 * Timers keep running; only Date is pinned.
 */
const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

/** Collapse whitespace: Intl puts U+00A0 inside formatted money. */
const flat = (s) => s.replace(/\s+/g, " ").trim();

/** Attach error collectors and return the arrays they fill. */
function watchForErrors(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

/** Navigate and wait until every skeleton has been replaced by real data. */
async function open(page, route) {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(`/#/${route}`, { waitUntil: "domcontentloaded" });
  // Skeleton loaders mark themselves aria-busy (see Skeleton.svelte); the
  // same signal scripts/screenshot.mjs waits on before capturing.
  await page
    .waitForFunction(
      () => document.querySelectorAll('[aria-busy="true"]').length === 0,
      null,
      { timeout: 15_000 },
    )
    .catch(() => {
      throw new Error(`/${route} never finished loading (skeletons remain)`);
    });
}

for (const [route, anchor] of ROUTES) {
  test(`${route} renders real data with no runtime errors`, async ({ page }) => {
    const { pageErrors, consoleErrors } = watchForErrors(page);

    await open(page, route);

    const heading =
      HEADINGS[route] === undefined
        ? route[0].toUpperCase() + route.slice(1)
        : HEADINGS[route];
    if (heading) await expect(page.locator("h1")).toHaveText(heading);
    else await expect(page.locator("h1")).not.toBeEmpty();

    expect(flat(await page.locator("main").innerText())).toContain(anchor);

    expect(
      pageErrors,
      `uncaught exception on /${route}: ${pageErrors.join(" | ")}`,
    ).toHaveLength(0);
    expect(
      consoleErrors,
      `console error on /${route}: ${consoleErrors.join(" | ")}`,
    ).toHaveLength(0);
  });
}

// Packs grew two user actions that previously existed only on the CLI and
// HTTP: seeding a book's starting taxonomy, and comparing a month against an
// installed benchmark pack. Both are checked in a real browser because both
// are interactive — the jsdom suite mounts the component, this drives it.
test("seeding built-in packs is an explicit, region-visible choice", async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = watchForErrors(page);
  await open(page, "packs");

  // Not installed on arrival: which taxonomy a book starts from is a
  // decision, and nothing makes it silently.
  await expect(page.locator("main")).not.toContainText(
    "South Africa — Personal Finance",
  );

  await page.getByRole("button", { name: "Built-in seeds" }).click();
  const panel = page.locator("main");
  await expect(panel).toContainText("Install the built-in seed packs");
  // The book's own region profile is on screen while the choice is made.
  await expect(panel).toContainText("South Africa · ZAR");

  await page.getByRole("button", { name: "Install the built-in seeds" }).click();
  await expect(panel).toContainText("South Africa — Personal Finance");
  await expect(panel).toContainText("International Starter");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
  expect(consoleErrors, consoleErrors.join(" | ")).toHaveLength(0);
});

test("peer comparison names what it could not compare", async ({ page }) => {
  const { pageErrors, consoleErrors } = watchForErrors(page);
  await open(page, "packs");
  const main = page.locator("main");

  // A real local comparison, money through fmtMoney.
  await expect(main).toContainText("Peer comparison");
  expect(flat(await main.innerText())).toContain("R 4,850.00");

  // The two results a lazy screen would render as zeroes. A benchmark that
  // is silently zero is a lie, so both have to read as what they are.
  await expect(main).toContainText("Not compared");
  await expect(main).toContainText("no conversion is applied");
  await expect(main).toContainText("not matched");

  // Month stepping re-queries rather than re-rendering stale figures.
  await page.getByRole("button", { name: "Previous month" }).click();
  await expect(main).toContainText("June 2026");

  // And the screen never claims the private half exists.
  await expect(main).toContainText("Contributing your own figures is not implemented");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
  expect(consoleErrors, consoleErrors.join(" | ")).toHaveLength(0);
});

test("the sidebar navigates and the keyboard shortcut jumps sections", async ({
  page,
}) => {
  const { pageErrors } = watchForErrors(page);
  await open(page, "dashboard");

  // Every registered route has a sidebar link, in router order.
  const hrefs = await page
    .locator('nav[aria-label="Sections"] a')
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(ROUTES.map(([r]) => `#/${r}`));

  await page.locator('nav[aria-label="Sections"] a[href="#/ledger"]').click();
  await expect(page.locator("h1")).toHaveText("Ledger");
  expect(page.url()).toContain("#/ledger");

  // `G` then `T` is the documented jump to Transactions (App.svelte gotoKeys).
  await page.locator("#main").click();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.locator("h1")).toHaveText("Transactions");
  expect(page.url()).toContain("#/transactions");

  // An unknown hash falls back to the dashboard rather than a blank pane.
  await page.goto("/#/not-a-route", { waitUntil: "domcontentloaded" });
  await expect(page.locator('nav[aria-label="Sections"] a[aria-current="page"]'))
    .toHaveAttribute("href", "#/dashboard");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
});

test("the browser build is honest that it is showing mock data", async ({
  page,
}) => {
  // Outside Tauri every call is mock-served; the shell says so rather than
  // passing fabricated numbers off as real. If this badge disappears, the
  // screenshots and the dev shell start lying.
  await open(page, "dashboard");
  await expect(page.getByTitle("Browser dev — mock data")).toBeVisible();
});
