/**
 * NetWorthChart — the axis must show the window that was actually requested,
 * not merely the extent of the points that came back.
 *
 * Context: the Dashboard asks for a rolling twelve-month window and labels
 * the card "· last 12 months". Before this fix, the chart's x-axis was drawn
 * from `points[0]`..`points[last]` — the *data's* extent — so a book with a
 * few months of history rendered a chart whose own axis contradicted the
 * header sitting right above it (e.g. "Feb 28, 2026" to "Jun 30, 2026" under
 * a "last 12 months" claim). These tests pin the fix: the axis spans
 * `rangeFrom`..`rangeTo` regardless of how much of that window has data, a
 * y-axis reference exists so the shape reads as an amount, and the SVG's
 * accessible name flags it when the data on record starts later than the
 * requested window — so a short book reads as short, honestly, to a screen
 * reader too.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount, type Component } from "svelte";
import NetWorthChart from "../lib/components/NetWorthChart.svelte";
import type { NetWorthPoint } from "../lib/api/types";
import { fmtDate, fmtMoney } from "../lib/util/format";

let mounted: Array<() => void> = [];

function render(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(NetWorthChart as Component, { target, props });
  mounted.push(() => {
    void unmount(instance);
    target.remove();
  });
  return target;
}

afterEach(() => {
  for (const dispose of mounted.reverse()) dispose();
  mounted = [];
  document.body.innerHTML = "";
});

function point(date: string, totalMinor: number): NetWorthPoint {
  return {
    as_of_date: date,
    by_account: [],
    currency: "ZAR",
    total_minor: totalMinor,
    unconverted: [],
  };
}

describe("NetWorthChart · axis reflects the requested window", () => {
  it("draws the axis endpoints from rangeFrom/rangeTo, not the shorter data extent", () => {
    // A book with four months of history inside a rolling twelve-month
    // request — the exact shape reported against the real Dashboard mock.
    const points = [
      point("2026-02-28", 1_180_000),
      point("2026-03-31", 1_340_000),
      point("2026-04-30", 1_510_000),
      point("2026-06-30", 1_705_000),
    ];
    const rangeFrom = "2025-08-01";
    const rangeTo = "2026-07-20";

    const target = render({ points, currency: "ZAR", rangeFrom, rangeTo });

    const texts = [...target.querySelectorAll("svg text")].map(
      (t) => t.textContent,
    );
    // The requested window's own dates are on the axis…
    expect(texts).toContain(fmtDate(rangeFrom));
    expect(texts).toContain(fmtDate(rangeTo));
    // …not the data's own (shorter) first/last dates.
    expect(texts).not.toContain(fmtDate(points[0]!.as_of_date));
    expect(texts).not.toContain(fmtDate(points[points.length - 1]!.as_of_date));
  });

  it("states the true coverage in the accessible name when data starts after the window opens", () => {
    const points = [point("2026-02-28", 1_180_000), point("2026-06-30", 1_705_000)];
    const rangeFrom = "2025-08-01";
    const rangeTo = "2026-07-20";

    const target = render({ points, currency: "ZAR", rangeFrom, rangeTo });
    const svg = target.querySelector("svg")!;
    const label = svg.getAttribute("aria-label") ?? "";

    // Names the requested window…
    expect(label).toContain(fmtDate(rangeFrom));
    expect(label).toContain(fmtDate(rangeTo));
    // …and — because the data does not cover the whole window — the actual
    // start of what is on record, so the claim is never bare.
    expect(label).toContain("on record from");
    expect(label).toContain(fmtDate(points[0]!.as_of_date));
    expect(label).toContain(fmtMoney(points[points.length - 1]!.total_minor, "ZAR"));
  });

  it("does not claim partial coverage when the data actually spans the whole window", () => {
    const rangeFrom = "2026-01-01";
    const rangeTo = "2026-01-31";
    const points = [point(rangeFrom, 100_000), point(rangeTo, 120_000)];

    const target = render({ points, currency: "ZAR", rangeFrom, rangeTo });
    const svg = target.querySelector("svg")!;
    expect(svg.getAttribute("aria-label") ?? "").not.toContain("on record from");
  });

  it("renders a y-axis reference — a zero baseline and the series peak — not a bare shape", () => {
    const points = [point("2026-01-01", 500_000), point("2026-02-01", 800_000)];
    const target = render({
      points,
      currency: "ZAR",
      rangeFrom: "2026-01-01",
      rangeTo: "2026-02-01",
    });

    const texts = [...target.querySelectorAll("svg text")].map(
      (t) => t.textContent,
    );
    expect(texts).toContain("0");
    // The series peak (800_000 minor) is labelled with a real formatted
    // money value, not a padded/rounded domain ceiling.
    expect(texts).toContain(fmtMoney(800_000, "ZAR"));
  });

  it("is short — a shape you can see at a glance, not a ~500px hero visual", () => {
    const points = [point("2026-01-01", 500_000), point("2026-02-01", 800_000)];
    const target = render({
      points,
      currency: "ZAR",
      rangeFrom: "2026-01-01",
      rangeTo: "2026-02-01",
    });
    const svg = target.querySelector("svg")!;
    const viewBox = svg.getAttribute("viewBox")!.split(/\s+/).map(Number);
    const [, , w, h] = viewBox;
    // A wide, short aspect ratio — well short of the old 640×220 (~2.9:1)
    // that rendered at roughly 500px tall on a full-width card.
    expect(w! / h!).toBeGreaterThan(4);
    expect(h!).toBeLessThanOrEqual(160);
  });
});
