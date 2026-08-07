/**
 * Dashboard · net-worth card — the "last 12 months" claim must be true of
 * what the chart actually shows.
 *
 * This is the regression the fix targets: the chart's axis was once drawn
 * from the data's own extent, so — with the suite's frozen clock inside the
 * mock's July 2026 window — the rendered chart spanned only a few months
 * directly under a header reading "· last 12 months". That is exactly the
 * "label asserting something the thing beneath it does not show" defect
 * class this pass exists to close.
 *
 * Fixing the axis exposed the other half of the same problem, which the last
 * two cases below now pin. Drawing the honest twelve-month axis under five
 * months of mock data left the left 60% of the card empty, and the mock's
 * final row was dated after the frozen clock, so the range filter dropped it
 * and the chart's end-cap disagreed with the stat tile directly above it.
 * Both were defects in the fixture, not the component — but a hero
 * screenshot cannot tell the difference, and neither can a reader.
 *
 * The assertion below is deliberately NOT "the string 'last 12 months'
 * appears" — that passes whether or not the axis agrees with it, which is
 * the bug. It mounts the real Dashboard against the real mock data path
 * (same as render-smoke.test.ts) and checks the axis dates the chart
 * actually drew are the *requested* window — computed independently via the
 * same `shiftMonth`/`localMonth`/`localDate` helpers Dashboard.svelte uses —
 * not the mock's shorter data extent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import Dashboard from "../routes/Dashboard.svelte";
import { fmtDate, localDate, localMonth, shiftMonth } from "../lib/util/format";
import { DEMO_TODAY, accounts, networthHistory } from "../lib/api/mock";

// Same frozen instant render-smoke.test.ts uses — inside the mock dataset's
// July 2026 transaction window.
const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

// The mock's own net-worth history starts here — the first month-end inside
// the requested twelve-month window, which opens on the 1st. See
// lib/api/mock.ts `networthHistory`.
const MOCK_DATA_START = "2025-08-31";

function render(component: Component): { target: HTMLElement; dispose: () => void } {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target });
  return {
    target,
    dispose: () => {
      void unmount(instance);
      target.remove();
    },
  };
}

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
  throw new Error("dashboard never settled");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("dashboard · net worth card", () => {
  it("claims 12 months only where the chart's own axis shows 12 months", async () => {
    // Computed exactly as Dashboard.svelte computes networthFrom/networthTo,
    // independently of the component under test.
    const requestedFrom = `${shiftMonth(localMonth(), -11)}-01`;
    const requestedTo = localDate();

    const { target, dispose } = render(Dashboard as Component);
    try {
      await settle(target);

      expect(target.textContent).toContain("last 12 months");

      const svg = target.querySelector('.card svg[role="img"]');
      expect(svg, "no net-worth chart rendered").not.toBeNull();

      const axisTexts = [...svg!.querySelectorAll("text")].map((t) => t.textContent);
      // The axis is drawn to the requested window…
      expect(axisTexts).toContain(fmtDate(requestedFrom));
      expect(axisTexts).toContain(fmtDate(requestedTo));
      // …not silently rescaled to the mock's shorter data extent.
      expect(axisTexts).not.toContain(fmtDate(MOCK_DATA_START));

      // And the chart's accessible name tells the true story too: this mock
      // book's data does not reach back the full twelve months, so a screen
      // reader is not handed a bare, unqualified "12 months" claim either.
      const ariaLabel = svg!.getAttribute("aria-label") ?? "";
      expect(ariaLabel).toContain("on record from");
      expect(ariaLabel).toContain(fmtDate(MOCK_DATA_START));
    } finally {
      dispose();
    }
  }, 20_000);

  // The axis being honest is only half of it. A twelve-month axis holding
  // five months of line is a correct chart of a threadbare fixture, and it
  // reads as a broken one — which is how it shipped into hero.png.
  it("draws a line across the whole window, not a stub at the right edge", () => {
    const from = `${shiftMonth(localMonth(), -11)}-01`;
    const to = localDate();
    const visible = networthHistory.filter((p) => p.date >= from && p.date <= to);

    expect(visible.length, "no net-worth points inside the requested window").toBeGreaterThan(0);

    // Where the first and last drawn points sit along the axis, 0..1. The
    // failing version started at 0.60; anything past a tenth of the way in
    // leaves a visible dead zone under a "last 12 months" header.
    const span = Date.parse(to) - Date.parse(from);
    const at = (d: string) => (Date.parse(d) - Date.parse(from)) / span;

    expect(at(visible[0]!.date)).toBeLessThan(0.1);
    expect(at(visible[visible.length - 1]!.date)).toBeGreaterThan(0.95);
    // Enough points that the line reads as a trend rather than a couple of
    // segments — one per month of the window, give or take the ends.
    expect(visible.length).toBeGreaterThanOrEqual(11);
  });

  // The old final row matched `accounts` exactly, but was dated after the
  // demo's own "today", so it was filtered out and never drawn. The chart
  // ended on the previous month showing R55,160.00 while the tile above it
  // read R56,844.22. Matching the fixture is not enough — it has to be the
  // row that actually renders.
  it("ends on the balances the stat tile above it shows", () => {
    const to = localDate();
    const visible = networthHistory.filter((p) => p.date <= to);
    const drawn = visible[visible.length - 1]!;

    const total = (xs: number[]) => xs.reduce((s, v) => s + v, 0);
    const fromAccounts = total(accounts.map((a) => a.balance_minor));

    expect(drawn.totals).toHaveLength(accounts.length);
    expect(total(drawn.totals)).toBe(fromAccounts);
    expect(drawn.date).toBe(DEMO_TODAY);
  });
});
