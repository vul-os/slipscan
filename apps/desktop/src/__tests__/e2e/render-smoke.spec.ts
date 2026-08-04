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

import { expect, test, type Page } from "@playwright/test";

/** Mirrors ROUTES in src/lib/router.svelte.ts. */
const ROUTES: Array<[route: string, anchor: string]> = [
  ["dashboard", "R 56,844.22"],
  ["transactions", "WOOLWORTHS 178 CLAREMONT"],
  ["receipts", "sixty60-slip.pdf"],
  ["budgets", "R 15,300.00"],
  ["household", "Alex"],
  ["ledger", "Bank — FNB Cheque"],
  ["reconcile", "TAKEALOT.COM CPT"],
  ["payments", "RENT-12B"],
  ["reports", "Net refundable"],
  // Business-only (their BookProfile.show_* flag); the mock's one book is
  // personal, so the anchor is the gate itself. Every one of these is still
  // reachable by hash — the gate is what renders, which is exactly the
  // behaviour worth smoke-testing.
  ["contacts", "Contacts is for business books"],
  ["catalogue", "Catalogue is for business books"],
  ["stock", "Stock is a business feature"],
  ["purchasing", "Purchasing is a business feature"],
  // The mock's one book is personal, so `show_sales` is false and this
  // route renders the business-book gate, not the trade UI — the flow that
  // needs a business book lives in the jsdom suite (sales.test.ts).
  ["sales", "Sales is a business-book feature"],
  ["packs", "South African retail merchants"],
  ["settings", "~/SlipScan/personal.slipscan.db"],
];

/** Headings, where they are not simply the route name title-cased. */
const HEADINGS: Record<string, string | null> = { dashboard: null };

/**
 * The mock dataset's transactions are dated July 2026, so the month-scoped
 * screens need "now" to sit inside that window to have anything to show.
 * Timers keep running; only Date is pinned.
 */
const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

/** Collapse whitespace: Intl puts U+00A0 inside formatted money. */
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Attach error collectors and return the arrays they fill. */
function watchForErrors(page: Page): {
  pageErrors: string[];
  consoleErrors: string[];
} {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

/** Navigate and wait until every skeleton has been replaced by real data. */
async function open(page: Page, route: string): Promise<void> {
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

// The fetch half of packs. Driven in a real browser because the whole point
// is the sequence a user walks: no source at all -> add one -> read it ->
// meet a signer this machine has never seen -> accept that fingerprint on
// purpose -> install. Every one of those steps is a claim the product makes
// about privacy or trust, so every one of them is asserted here.
test("fetching a pack from a source is a sequence of explicit decisions", async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = watchForErrors(page);
  await open(page, "packs");
  const main = page.locator("main");

  // 1. The default state, and the promise it keeps: nothing configured, so
  //    nothing is being contacted.
  await expect(main).toContainText("SlipScan fetches packs only from sources you have added");
  await page.getByRole("button", { name: "Sources" }).click();
  await expect(main).toContainText("No sources configured");
  await expect(main).toContainText("making no outbound request about packs at all");

  // 2. A source is a place, not an authority — and adding one contacts
  //    nothing.
  await page.getByLabel("Name").fill("stick");
  await page.getByLabel("Source URI").fill("folder:/Volumes/USB/packs");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(main).toContainText("folder / USB");
  await expect(main).toContainText("local only");
  await expect(main).toContainText("never read");

  // 3. Reading installs nothing, and shows what each pack would do.
  await page.getByRole("button", { name: "Read" }).click();
  await expect(main).toContainText("stick offered");
  await expect(main).toContainText("Nothing has been installed");
  await expect(main).toContainText("Worldwide grocery chains");

  // A file that does not verify is reported as such rather than dropped —
  // and it does not hide the rest of the catalogue.
  await expect(main).toContainText("not verified");
  await expect(main).toContainText("signature verification failed");

  // A pack from a signer already trusted here needs no further ceremony…
  await expect(main).toContainText("trusted as SlipScan Community");
  // …and one from a signer this machine has never seen is called that.
  await expect(main).toContainText("never seen here");

  // 4. Arriving is not accepting. The install button for the unknown signer
  //    is inert until the fingerprint is ticked off.
  const accept = page.getByRole("button", { name: "Accept signer & install" });
  await expect(accept).toBeDisabled();
  await expect(main).toContainText("I have compared");
  await page.getByRole("checkbox").first().check();
  await expect(accept).toBeEnabled();

  // 5. And then it installs, through the same verify -> trust -> pin path a
  //    hand-picked file takes.
  await accept.click();
  await expect(main).toContainText("Installed Worldwide grocery chains 2.0.0");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
  expect(consoleErrors, consoleErrors.join(" | ")).toHaveLength(0);
});

// The refusal the pin exists for, on the screen where a user would meet it:
// a source offering "a newer version" of a pack id under a different key.
test("a source cannot take over a pack id with a new key", async ({ page }) => {
  const { pageErrors } = watchForErrors(page);
  await open(page, "packs");
  const main = page.locator("main");

  await page.getByRole("button", { name: "Sources" }).click();
  await page.getByLabel("Name").fill("team");
  await page.getByLabel("Source URI").fill("folder:/srv/packs");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Read" }).click();
  await expect(main).toContainText("team offered");

  // za-benchmarks-2026 is installed at 0.3.1 and the source offers 0.2.0:
  // backwards, which is refused rather than quietly skipped.
  await expect(main).toContainText("refused");
  await expect(main).toContainText("downgrades are rejected");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
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

  // Every route the CURRENT BOOK can use has a sidebar link, in router order.
  //
  // Not every registered route: the five Trade destinations carry a
  // `requires` profile flag and the demo book is personal, so the rail
  // genuinely does not render them. They remain reachable by hash — this
  // spec navigates to each one above and asserts its gate — so the right
  // assertion is "the rail shows what this book can do", not "the rail shows
  // everything that exists".
  const BUSINESS_ONLY = new Set([
    "contacts",
    "catalogue",
    "stock",
    "purchasing",
    "sales",
  ]);
  const hrefs = await page
    .locator('nav[aria-label="Sections"] a')
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toEqual(
    ROUTES.filter(([r]) => !BUSINESS_ONLY.has(r)).map(([r]) => `#/${r}`),
  );

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
