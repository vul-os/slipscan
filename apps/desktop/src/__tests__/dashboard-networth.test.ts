/**
 * Dashboard · net-worth card — the "last 12 months" claim must be true of
 * what the chart actually shows.
 *
 * This is the regression the fix targets: the mock dataset's net-worth
 * history (`networthHistory` in lib/api/mock.ts) starts 2026-02-28, well
 * inside the rolling twelve-month window the Dashboard requests. Before the
 * fix, the chart's axis was drawn from the data's own extent, so — with the
 * suite's frozen clock inside the mock's July 2026 window — the rendered
 * chart spanned only "Feb 28, 2026" to "Jun 30, 2026" (about four months)
 * directly under a header reading "· last 12 months". That is exactly the
 * "label asserting something the thing beneath it does not show" defect
 * class this pass exists to close.
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

// Same frozen instant render-smoke.test.ts uses — inside the mock dataset's
// July 2026 transaction window.
const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

// The mock's own net-worth history starts here — well after the requested
// twelve-month window opens. See lib/api/mock.ts `networthHistory`.
const MOCK_DATA_START = "2026-02-28";

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
});
