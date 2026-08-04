/**
 * Render smoke test over every route in src/routes/.
 *
 * WHAT THIS CATCHES that `npm run check` and `npm run build` do not: runtime
 * blank screens. A rune used before initialisation, a `$derived` that throws
 * on the mock shape, a component renamed out from under an import, a loader
 * whose promise never resolves — all type-check and bundle cleanly and all
 * produce an empty pane at runtime.
 *
 * Each route is mounted for real (Svelte 5 `mount`, jsdom) against the
 * in-memory mock dataset in src/lib/api/mock.ts — `isTauri` is false outside
 * Tauri, so src/lib/api/client.ts serves every call from the mock and no
 * backend, IPC or network is involved.
 *
 * The assertions are deliberately data-derived rather than structural. Every
 * route is checked for strings that can only appear if its loader resolved
 * AND its formatters ran: minor-unit money that has been through fmtMoney,
 * mock merchant/account names, computed totals. A smoke test that only
 * asserted "something rendered" would pass on a skeleton that never resolves,
 * which is exactly the failure worth catching.
 *
 * Time is frozen inside the mock dataset's window (its transactions are dated
 * July 2026) so the month-scoped screens — Dashboard, Budgets, Reports — have
 * data to show no matter when the suite runs. Only `Date` is faked; timers
 * stay real, because settling the routes depends on them.
 *
 * Assertions avoid rendered dates: `posted_at` is a UTC instant and CI runs
 * in UTC while developers do not, so a date string is a timezone trap. The
 * frozen instant (09:00Z on the 20th) is mid-July in every real zone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import App from "../App.svelte";
import { mockApi } from "../lib/api/mock";
import { firstRun, FIRST_RUN_KEY } from "../lib/state/onboarding.svelte";
import { NAV_ITEMS } from "../lib/nav";
import { router, ROUTES, type RouteId } from "../lib/state/router.svelte";
import { NAV_GROUPS } from "../lib/nav";
import Budgets from "../routes/Budgets.svelte";
import Catalogue from "../routes/Catalogue.svelte";
import Contacts from "../routes/Contacts.svelte";
import Dashboard from "../routes/Dashboard.svelte";
import Household from "../routes/Household.svelte";
import Ledger from "../routes/Ledger.svelte";
import Packs from "../routes/Packs.svelte";
import Payments from "../routes/Payments.svelte";
import Receipts from "../routes/Receipts.svelte";
import Reconcile from "../routes/Reconcile.svelte";
import Reports from "../routes/Reports.svelte";
import Stock from "../routes/Stock.svelte";
import Purchasing from "../routes/Purchasing.svelte";
import Sales from "../routes/Sales.svelte";
import Settings from "../routes/Settings.svelte";
import Transactions from "../routes/Transactions.svelte";

/** An instant inside the mock dataset's July 2026 transactions. */
const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

interface RouteCase {
  /** Exact <h1> the screen must render. */
  heading: string;
  /**
   * Strings that only exist once the loader resolved and the formatters ran.
   * Money is checked in its formatted form, which also pins fmtMoney's
   * minor-unit arithmetic (i64 cents in, "R 1,234.56" out).
   */
  anchors: string[];
}

const CASES: Record<RouteId, RouteCase & { component: Component }> = {
  dashboard: {
    component: Dashboard as Component,
    // greeting() is time-of-day dependent; the eyebrow and figures are not.
    heading: "",
    anchors: [
      "Personal · ZAR",
      // Net balance = 1_824_540 + 4_550_000 - 732_118 + 42_000 minor units.
      "R 56,844.22",
      "4 accounts",
      "Woolworths",
    ],
  },
  transactions: {
    component: Transactions as Component,
    heading: "Transactions",
    anchors: [
      "30 of 30",
      "WOOLWORTHS 178 CLAREMONT",
      "−R 842.35",
      "Discovery Credit Card",
    ],
  },
  receipts: {
    component: Receipts as Component,
    heading: "Receipts",
    anchors: ["9 results", "sixty60-slip.pdf", "R 637.80", "97%"],
  },
  budgets: {
    component: Budgets as Component,
    heading: "Budgets",
    anchors: ["R 15,300.00", "R 6,401.06", "Groceries", "R 2,106.95 left"],
  },
  household: {
    component: Household as Component,
    heading: "Household",
    anchors: [
      "Alex",
      "Owns FNB Cheque",
      "Settle up · July 2026",
      "Share of category",
    ],
  },
  // Contacts and Catalogue are business-only (`BookProfile.show_contacts` /
  // `show_catalogue`), and the mock's one book is personal — the same book
  // every other case in this table renders against. So the CASES anchors
  // here are deliberately the *refusal* state, not a populated screen: this
  // is what the mock exercises by default, and it is the property that
  // matters most (the route refuses itself rather than merely hoping the
  // sidebar hid its own link). The populated path — add a category, a
  // product, a variant, a contact, edit its role, delete refusals — is
  // covered against a business-book mock in contacts-catalogue.test.ts.
  contacts: {
    component: Contacts as Component,
    heading: "Contacts",
    anchors: [
      "Contacts is for business books",
      "no trading party to track",
      "Open Settings",
    ],
  },
  catalogue: {
    component: Catalogue as Component,
    heading: "Catalogue",
    anchors: [
      "Catalogue is for business books",
      "nothing to sell or stock",
      "Open Settings",
    ],
  },
  ledger: {
    component: Ledger as Component,
    heading: "Ledger",
    anchors: [
      "1000",
      "Bank — FNB Cheque",
      "2200",
      "VAT control",
      "Trial balance",
    ],
  },
  reconcile: {
    component: Reconcile as Component,
    heading: "Reconcile",
    anchors: ["TAKEALOT.COM CPT", "−R 1,249.99", "93%", "Confirm"],
  },
  payments: {
    component: Payments as Component,
    heading: "Payments",
    anchors: [
      "RENT-12B",
      "https://shop.example.co.za/hooks/slipscan",
      "exactly R 4,500.00",
    ],
  },
  packs: {
    component: Packs as Component,
    heading: "Packs",
    anchors: [
      "South African retail merchants",
      "za-retail-base",
      "SlipScan Community",
      // Peer comparison: the read side, rendered from the mock's benchmark
      // sets. The median is a pack constant (485_000 minor ZAR), so this
      // also pins that benchmark money goes through fmtMoney.
      "Peer comparison",
      "ZA household benchmarks · 2026",
      "R 4,850.00",
      "k ≥ 25",
      // The two results that must never be rendered as zeroes.
      "Not compared",
      "not matched",
    ],
  },
  reports: {
    component: Reports as Component,
    heading: "Reports",
    anchors: ["VAT201", "R 90,723.84", "Net refundable", "Trial balance (CSV)"],
  },
  // Stock and Purchasing are business-only (BookProfile.show_catalogue /
  // show_purchasing), and the mock's one book is personal — so the loader
  // that actually resolves here is the gate itself, not a populated table.
  // That gate is real, data-derived behaviour (it reads book.name and
  // profile.show_catalogue/show_purchasing from the mock, not a hardcoded
  // string), which is exactly what this suite is meant to catch drifting.
  stock: {
    component: Stock as Component,
    heading: "Stock",
    anchors: [
      "Stock is a business feature",
      "a stock movement moves a catalogue variant",
      "Open Settings",
    ],
  },
  purchasing: {
    component: Purchasing as Component,
    heading: "Purchasing",
    anchors: [
      "Purchasing is a business feature",
      "a purchase order buys from a supplier contact",
      "Open Settings",
    ],
  },
  // The mock's one book is personal (`kind: "personal"`), so `show_sales`
  // resolves false and this pins the gate, not the trade UI underneath it —
  // see sales.test.ts for the business-book flow (orders, invoices,
  // payments, aged receivables) this default state cannot exercise.
  sales: {
    component: Sales as Component,
    heading: "Sales",
    anchors: [
      "Sales is a business-book feature",
      "Personal is a personal book",
      "Open Settings › General",
    ],
  },
  settings: {
    component: Settings as Component,
    heading: "Settings",
    // Members moved to /household and packs to /packs; what is left is the
    // settings blob and its tabs.
    anchors: [
      "~/SlipScan/personal.slipscan.db",
      "South Africa",
      "Credential vault",
      "No telemetry",
    ],
  },
};

/** Uncaught runtime failures observed while a component is mounted. */
let fatal: string[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;

function onError(e: ErrorEvent) {
  fatal.push(`window.error: ${e.message}`);
}
function onRejection(e: PromiseRejectionEvent) {
  fatal.push(`unhandledrejection: ${String(e.reason)}`);
}

beforeEach(() => {
  fatal = [];
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
    fatal.push(`console.error: ${args.map(String).join(" ")}`);
  });
});

afterEach(() => {
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  consoleError.mockRestore();
  vi.useRealTimers();
  document.body.innerHTML = "";
  window.location.hash = "";
});

/**
 * Drive the event loop until the screen stops changing.
 *
 * Screens load through `{#await}` chains (swrLoad → api → mock), so settling
 * takes an unknown number of macrotask turns. Waiting for the DOM to hold
 * still for three consecutive turns with no `aria-busy` skeleton left is the
 * observable definition of "finished loading"; a loader that never resolves
 * hits the cap and fails the test rather than passing on a skeleton.
 */
async function settle(target: HTMLElement): Promise<void> {
  let previous = "";
  let stable = 0;
  for (let turn = 0; turn < 250; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const busy = target.querySelector('[aria-busy="true"]') !== null;
    const text = target.textContent ?? "";
    stable = !busy && text.length > 0 && text === previous ? stable + 1 : 0;
    previous = text;
    if (stable >= 3) return;
  }
  throw new Error(
    `route never settled after 250 turns ` +
      `(aria-busy present: ${target.querySelector('[aria-busy="true"]') !== null})`,
  );
}

/**
 * Collapse every run of whitespace to one plain space.
 *
 * `Intl.NumberFormat` puts U+00A0 between the currency symbol and the digits
 * ("R 54,623.84"), and the markup wraps lines freely. Comparing against
 * literals typed with ordinary spaces would otherwise fail for reasons that
 * have nothing to do with the app being broken.
 */
function text(target: HTMLElement): string {
  return (target.textContent ?? "").replace(/\s+/g, " ").trim();
}

function render(component: Component): {
  target: HTMLElement;
  dispose: () => void;
} {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target });
  return {
    target,
    dispose: () => {
      unmount(instance);
      target.remove();
    },
  };
}

describe("route render smoke", () => {
  it("covers every registered route", () => {
    // Guards against a route being added to the router without a case here —
    // otherwise this suite silently stops covering the app as it grows.
    expect(Object.keys(CASES).sort()).toEqual([...ROUTES].sort());
  });

  /**
   * Every jump chord must reach a different screen.
   *
   * Two agents adding to the rail in parallel both picked "U" — catalogue and
   * purchasing — and nothing caught it, because nothing asserted it. A
   * duplicate makes one of the two destinations unreachable by keyboard while
   * looking perfectly correct in the sidebar, which is the kind of defect that
   * survives review indefinitely.
   */
  it("gives every destination its own jump key", () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    const byKey = new Map<string, string[]>();
    for (const item of items) {
      byKey.set(item.key, [...(byKey.get(item.key) ?? []), item.route]);
    }
    const clashes = [...byKey.entries()].filter(([, routes]) => routes.length > 1);
    expect(
      clashes.map(([key, routes]) => `${key}: ${routes.join(", ")}`),
      "two destinations share a jump chord",
    ).toEqual([]);

    // "G" is the chord's own trigger; pairing it with itself reads as a typo.
    expect(items.map((i) => i.key)).not.toContain("G");
  });

  for (const route of ROUTES) {
    const { component, heading, anchors } = CASES[route];

    it(`${route} renders real data with no runtime errors`, async () => {
      const { target, dispose } = render(component);
      try {
        await settle(target);
        const rendered = text(target);

        expect(fatal, `runtime errors on /${route}: ${fatal.join(" | ")}`)
          .toEqual([]);

        const h1 = target.querySelector("h1");
        expect(h1, `/${route} rendered no <h1>`).not.toBeNull();
        if (heading) expect(h1?.textContent?.trim()).toBe(heading);

        expect(
          target.querySelectorAll('[aria-busy="true"]').length,
          `/${route} left a skeleton on screen`,
        ).toBe(0);

        for (const anchor of anchors) {
          expect(rendered, `/${route} is missing ${JSON.stringify(anchor)}`)
            .toContain(anchor);
        }
      } finally {
        dispose();
      }
    }, 20_000);
  }
});

/** The one button whose visible text — or accessible name, for the icon-only
 * ones — matches `label`. Going through the accessible name is deliberate:
 * a control the keyboard and a screen reader cannot name is not reachable,
 * and this fails rather than reaching past it. */
function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].filter((b) =>
    (b.getAttribute("aria-label") ?? b.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .includes(label),
  );
  if (found.length !== 1)
    throw new Error(
      `expected exactly one button containing ${JSON.stringify(label)}, found ${found.length}`,
    );
  return found[0]!;
}

/**
 * Seeding built-in packs: an explicit action, never a default.
 *
 * `pack_install_seeds` shipped on every surface with no screen calling it.
 * These pin the two properties that make surfacing it correct rather than
 * merely present — the user sees which region they are taking on before they
 * accept, and re-running is a no-op that says so instead of claiming work.
 *
 * NOTE: the mock dataset is module state, so this mutates it for anything
 * that runs after it. It is placed last for that reason.
 */
describe("packs · built-in seeds", () => {
  it("is an opt-in choice that shows the region, and is idempotent", async () => {
    const { target, dispose } = render(Packs as Component);
    try {
      await settle(target);

      // Nothing has been seeded on arrival: it is a choice, not a default.
      expect(text(target)).not.toContain("South Africa — Personal Finance");

      button(target, "Built-in seeds").click();
      await settle(target);

      // The decision is made with this book's own region profile in view.
      const panel = text(target);
      expect(panel).toContain("Install the built-in seed packs");
      expect(panel).toContain("South Africa · ZAR");

      button(target, "Install the built-in seeds").click();
      await settle(target);

      const after = text(target);
      // Every seed reports the region it targets — including the global one.
      expect(after).toContain("South Africa — Personal Finance");
      expect(after).toContain("South Africa — Small Business & VAT");
      expect(after).toContain("International Starter");
      expect(after).toContain("global");
      // And they are now listed as installed packs, not just announced.
      expect(after).toContain("za-personal");
      expect(fatal, `runtime errors while seeding: ${fatal.join(" | ")}`).toEqual([]);

      // Re-running writes nothing and says so, rather than reporting work it
      // did not do. This is what "idempotent" has to look like in the UI.
      button(target, "Built-in seeds").click();
      await settle(target);
      button(target, "Install the built-in seeds").click();
      await settle(target);
      expect(text(target)).toContain(
        "Every built-in seed was already installed at its current version",
      );
    } finally {
      dispose();
    }
  }, 30_000);
});

/**
 * Peer comparison: the read side of benchmark packs.
 *
 * The two failure modes worth a test are the ones a lazy screen turns into
 * zeroes — a pack in a currency this book does not use (no FX conversion is
 * applied, ever) and a taxonomy key nothing maps to. Both must read as what
 * they are.
 */
describe("packs · peer comparison", () => {
  it("names what it could not compare instead of showing zeroes", async () => {
    const { target, dispose } = render(Packs as Component);
    try {
      await settle(target);
      const rendered = text(target);

      // A real comparison, with money through fmtMoney and the k-floor shown.
      expect(rendered).toContain("groceries");
      expect(rendered).toContain("R 4,850.00");
      expect(rendered).toContain("k ≥ 25");

      // Currency mismatch: reported, never converted, never zeroed.
      expect(rendered).toContain("Not compared");
      expect(rendered).toContain(
        "pack is in EUR and this book is in ZAR — no conversion is applied",
      );

      // Keys the pack publishes that nothing maps to are named, not dropped.
      expect(rendered).toContain("not matched");
      expect(rendered).toContain("insurance");
      expect(rendered).toContain("education");

      // A cohort median of zero yields no ratio rather than Infinity.
      expect(rendered).toContain("cohort median is 0");

      expect(fatal, `runtime errors on peer comparison: ${fatal.join(" | ")}`)
        .toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("steps months, and a month the pack does not cover is not a zero", async () => {
    const { target, dispose } = render(Packs as Component);
    try {
      await settle(target);
      expect(text(target)).toContain("July 2026");

      button(target, "Previous month").click();
      await settle(target);
      expect(text(target)).toContain("June 2026");
      expect(text(target)).toContain("R 4,850.00");

      // Step out of the year the pack covers: "publishes no statistics" is a
      // different answer from "you spent nothing", and must render as such.
      for (let i = 0; i < 7; i++) {
        button(target, "Next month").click();
        await settle(target);
      }
      const rendered = text(target);
      expect(rendered).toContain("January 2027");
      expect(rendered).toContain("publishes no statistics for January 2027");
      // The currency mismatch is decided before the period is, so it still
      // reports as not-compared rather than as an empty month.
      expect(rendered).toContain("Not compared");

      expect(fatal, `runtime errors stepping months: ${fatal.join(" | ")}`)
        .toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

/**
 * Devices: identity and pairing, which shipped reachable only from the CLI and
 * the HTTP surface.
 *
 * The load-bearing assertion is not that the screen renders — it is that the
 * screen says **nothing syncs**. Identity and pairing are real and a "paired"
 * row with a green dot is exactly what a person reads as "my data is on both
 * machines", so the disclaimer is the feature here, and dropping it is a
 * one-line edit no type-check would notice.
 */
describe("settings · devices", () => {
  it("renders this device's identity and key-name, and says nothing syncs", async () => {
    const { target, dispose } = render(Settings as Component);
    try {
      await settle(target);
      button(target, "Devices").click();
      await settle(target);
      const rendered = text(target);

      // The disclaimer, in as many words.
      expect(rendered).toContain("Nothing syncs between devices yet");
      expect(rendered).toContain("no replication log, no transport");

      // This device: label, the nine-word key-name, and the hex id.
      expect(rendered).toContain("Alex's laptop");
      expect(rendered).toContain("This device's key-name");
      const identity = await mockApi.device_status();
      expect(identity).not.toBeNull();
      expect(rendered).toContain(identity!.keyname);
      expect(rendered).toContain(identity!.public_key);

      // The key-name's job is stated where it is shown; a fingerprint nobody
      // compares protects nobody.
      expect(rendered).toContain("is the authentication");

      // No accounts, said plainly — this is the thing people assume exists.
      expect(rendered).toContain("no email, no password, no username, no login");

      // Peers, tombstone included. `last_seen_at` is always null because
      // nothing connects, so the screen has to disclaim it rather than render
      // an absence that reads as "offline".
      expect(rendered).toContain("home server");
      expect(rendered).toContain("old phone");
      expect(rendered).toContain("revoked");
      expect(rendered).toContain("never when a device was last seen");
      expect(rendered).not.toMatch(/\bonline\b|\boffline\b/i);

      expect(fatal, `runtime errors on the devices tab: ${fatal.join(" | ")}`)
        .toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

describe("app shell", () => {
  it("mounts the sidebar and swaps screens when a nav link is clicked", async () => {
    const { target, dispose } = render(App as Component);
    try {
      await settle(target);
      expect(fatal, `runtime errors in the shell: ${fatal.join(" | ")}`)
        .toEqual([]);

      // Every route the mock's book can actually show is reachable from the
      // chrome, and the sidebar marks exactly one link as current. The mock's
      // one book is personal, so `NAV_ITEMS` entries gated behind a
      // `BookProfile` flag (Contacts, Catalogue — Sidebar.svelte filters on
      // `item.requires`) are correctly absent here; ROUTES itself still names
      // every route that exists, gated or not (pinned by the "covers every
      // registered route" case above).
      const visibleRoutes = NAV_ITEMS.filter((item) => !item.requires).map(
        (item) => item.route,
      );
      const links = [...target.querySelectorAll<HTMLAnchorElement>("nav a")];
      expect(links.map((a) => a.getAttribute("href"))).toEqual(
        visibleRoutes.map((r) => `#/${r}`),
      );
      expect(
        links.filter((a) => a.getAttribute("aria-current") === "page").length,
      ).toBe(1);

      // Default route is the dashboard, rendered with mock data.
      expect(text(target)).toContain("Personal · ZAR");

      // Click the real anchor: href → hashchange → router → keyed remount.
      // Exercises the whole navigation path, not just the router object.
      // Looked up by href rather than a ROUTES index — gating can leave
      // fewer links in the rail than ROUTES has entries.
      const ledgerLink = links.find((a) => a.getAttribute("href") === "#/ledger")!;
      ledgerLink.click();
      await settle(target);

      expect(window.location.hash).toBe("#/ledger");
      expect(router.current).toBe("ledger");
      expect(target.querySelector("h1")?.textContent?.trim()).toBe("Ledger");
      expect(text(target)).toContain("Bank — FNB Cheque");
      // The dashboard's screen was swapped out, not stacked underneath.
      expect(text(target)).not.toContain("Net balance");

      links.find((a) => a.getAttribute("href") === "#/dashboard")!.click();
      await settle(target);
      expect(text(target)).toContain("R 56,844.22");
      expect(fatal, `runtime errors after navigation: ${fatal.join(" | ")}`)
        .toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

/**
 * Shell chrome added alongside the screens: the command palette's trigger,
 * the skip link, and the landmarks a keyboard user navigates by.
 *
 * The palette's own behaviour is covered in depth by palette.test.ts; what
 * belongs *here* is that the shell still wires it up, and that adding two
 * overlays to App.svelte did not cost the app its landmarks or its skip
 * link — regressions that no route test would notice.
 */
describe("app shell · chrome", () => {
  it("exposes one landmark per region, each with a name", async () => {
    const { target, dispose } = render(App as Component);
    try {
      await settle(target);

      const aside = target.querySelector("aside")!;
      expect(aside.getAttribute("aria-label")).toBe("Primary");
      // Two navs would make "next landmark" ambiguous; there is exactly one.
      const navs = [...target.querySelectorAll("nav")];
      expect(navs).toHaveLength(1);
      expect(navs[0]!.getAttribute("aria-label")).toBe("Sections");

      const main = target.querySelector("main")!;
      expect(main.id).toBe("main");
      // -1, not 0: the skip link focuses it programmatically, but it must
      // not sit in the tab order itself.
      expect(main.tabIndex).toBe(-1);
      expect(fatal, `runtime errors: ${fatal.join(" | ")}`).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  it("leads with a skip link that actually moves focus to the content", async () => {
    const { target, dispose } = render(App as Component);
    try {
      await settle(target);

      // First focusable in DOM order — a skip link the user has to tab to
      // three times is not a skip link.
      const focusable = target.querySelector<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      )!;
      expect(focusable.className).toContain("skip-link");
      expect(focusable.textContent?.trim()).toBe("Skip to content");

      focusable.click();
      flushSync();
      expect(document.activeElement).toBe(target.querySelector("main"));
      expect(fatal, `runtime errors: ${fatal.join(" | ")}`).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  it("offers the command palette from the rail, naming its shortcut", async () => {
    const { target, dispose } = render(App as Component);
    try {
      await settle(target);

      const trigger = target.querySelector<HTMLButtonElement>(
        "#palette-trigger",
      )!;
      expect(trigger, "the rail no longer offers the palette").not.toBeNull();
      // The chord is announced, not just drawn as a decorative chip.
      expect(trigger.getAttribute("aria-keyshortcuts")).toContain("K");
      expect(trigger.getAttribute("aria-label")).toMatch(/search|jump/i);

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      trigger.click();
      flushSync();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      // Clean up: the palette is a module singleton shared with other suites.
      document
        .querySelector<HTMLElement>(".scrim-hit")!
        .click();
      flushSync();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(fatal, `runtime errors: ${fatal.join(" | ")}`).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  /**
   * The regression this whole area exists for.
   *
   * First-run setup was complete, typed and unit-tested, and no user could
   * reach it: the desktop backend seeded a book at startup, so `book_list`
   * was never empty and the gate below never opened. Asserting the flow is
   * *built* would have passed throughout. These two assert it is *reached* —
   * once by the shell on an empty install, and once on demand afterwards,
   * because the shell only ever offers it once.
   */
  it("greets an install with no book by opening setup", async () => {
    const empty = vi.spyOn(mockApi, "book_list").mockResolvedValue([]);
    try {
      const { target, dispose } = render(App as Component);
      try {
        await settle(target);
        expect(
          text(target),
          "a fresh install did not reach first-run setup",
        ).toContain("Set up SlipScan");
        expect(fatal, `runtime errors: ${fatal.join(" | ")}`).toEqual([]);
      } finally {
        dispose();
      }
    } finally {
      empty.mockRestore();
      // Module singleton shared with the suites below.
      firstRun.open = false;
      localStorage.removeItem(FIRST_RUN_KEY);
    }
  }, 30_000);

  it("lets the palette bring setup back once a book exists", async () => {
    // No mocking here: the dataset has a book, exactly like a real install
    // after setup — the state in which the flow used to be unreachable.
    const { target, dispose } = render(App as Component);
    try {
      await settle(target);
      expect(text(target)).not.toContain("Set up SlipScan");

      // Driven through the shipped keyboard shell and the palette's own
      // ranking, not by calling `firstRun.reopen()` — the point is that a
      // person can get there.
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
      );
      flushSync();
      const input = document.querySelector<HTMLInputElement>("#palette-input");
      expect(input, "the palette did not open").not.toBeNull();

      input!.value = "new book";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      const top = document.querySelector('[role="option"]');
      expect(top?.textContent).toContain("Set up a new book");

      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      flushSync();
      await settle(target);

      expect(
        text(target),
        "the palette command did not reach first-run setup",
      ).toContain("Set up SlipScan");
      expect(fatal, `runtime errors: ${fatal.join(" | ")}`).toEqual([]);
    } finally {
      firstRun.open = false;
      localStorage.removeItem(FIRST_RUN_KEY);
      dispose();
    }
  }, 30_000);

  it("does not greet an existing install with first-run setup", async () => {
    // The mock dataset has a book, which is the whole gate: setup appears
    // only when book_list comes back empty.
    const { target, dispose } = render(App as Component);
    try {
      await settle(target);
      expect(text(target)).not.toContain("Set up SlipScan");
      expect(
        [...document.querySelectorAll('[role="dialog"]')].map((d) =>
          d.getAttribute("aria-labelledby"),
        ),
      ).toEqual([]);
      expect(fatal, `runtime errors: ${fatal.join(" | ")}`).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});
