/**
 * Date-range presets, as data.
 *
 * Every reporting screen wants the same six ranges, and three screens
 * hand-rolling "last three months" is three chances to disagree about
 * whether that means 90 days or three calendar months. It means three
 * calendar months, starting on the 1st — the same convention the month-
 * scoped screens already use (`localMonth`, `monthEnd`, `shiftMonth`).
 *
 * All dates are `YYYY-MM-DD` in the user's **local** zone, matching
 * `localDate()`; the API's `from`/`to` are inclusive.
 */

import { localDate, localMonth, monthEnd, shiftMonth } from "./format";

export interface DateRange {
  /** Inclusive start, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive end, `YYYY-MM-DD`. */
  to: string;
}

export type PresetId =
  | "this-month"
  | "last-month"
  | "last-3-months"
  | "last-12-months"
  | "year-to-date"
  | "last-year";

export interface Preset {
  id: PresetId;
  label: string;
  range: DateRange;
}

/** First day of a `YYYY-MM` month. */
function monthStart(month: string): string {
  return `${month}-01`;
}

/**
 * The preset list for a given "today". Pass `now` in tests; the default
 * reads the real clock through `localDate`/`localMonth`, which are local-zone
 * correct (a UTC `toISOString().slice(0, 10)` is not).
 */
export function datePresets(now = new Date()): Preset[] {
  const today = localDate(now);
  const month = localMonth(now);
  const previous = shiftMonth(month, -1);
  const year = now.getFullYear();

  return [
    {
      id: "this-month",
      label: "This month",
      range: { from: monthStart(month), to: today },
    },
    {
      id: "last-month",
      label: "Last month",
      range: { from: monthStart(previous), to: monthEnd(previous) },
    },
    {
      id: "last-3-months",
      label: "Last 3 months",
      range: { from: monthStart(shiftMonth(month, -2)), to: today },
    },
    {
      id: "last-12-months",
      label: "Last 12 months",
      range: { from: monthStart(shiftMonth(month, -11)), to: today },
    },
    {
      id: "year-to-date",
      label: "Year to date",
      range: { from: `${year}-01-01`, to: today },
    },
    {
      id: "last-year",
      label: `${year - 1}`,
      range: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
    },
  ];
}

/** Which preset a range *is*, or null when the user has typed their own. */
export function matchPreset(range: DateRange, now = new Date()): PresetId | null {
  const hit = datePresets(now).find(
    (p) => p.range.from === range.from && p.range.to === range.to,
  );
  return hit?.id ?? null;
}

/** `YYYY-MM-DD`, and nothing else — `<input type="date">` can be typed into. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Why a range is unusable, or null when it is fine. Returning the reason
 * (rather than a boolean) is what lets the picker say it out loud instead of
 * silently refusing to update.
 */
export function rangeError(range: DateRange): string | null {
  if (!isIsoDate(range.from)) return "Start date is not a real date.";
  if (!isIsoDate(range.to)) return "End date is not a real date.";
  if (range.from > range.to) return "The start date is after the end date.";
  return null;
}

/** Inclusive day count, for "31 days" style captions. */
export function rangeDays(range: DateRange): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}
