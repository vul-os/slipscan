/**
 * Money / decimal arithmetic. Postgres NUMERIC arrives as a string from the
 * Neon driver; NEVER coerce to a JS number (float precision loss). All money
 * math goes through decimal.js. This is the #1 correctness invariant of the
 * port — ledger balance, reports, reconciliation all depend on it.
 */
import Decimal from "decimal.js";

// Banker-safe config: enough precision for currency math.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

export type Numeric = string | number | Decimal;

export function dec(v: Numeric | null | undefined): Decimal {
  if (v === null || v === undefined || v === "") return new Decimal(0);
  return new Decimal(v);
}

export const add = (a: Numeric, b: Numeric) => dec(a).plus(dec(b));
export const sub = (a: Numeric, b: Numeric) => dec(a).minus(dec(b));
export const mul = (a: Numeric, b: Numeric) => dec(a).times(dec(b));
export const cmp = (a: Numeric, b: Numeric) => dec(a).comparedTo(dec(b)); // -1|0|1
export const isZero = (a: Numeric) => dec(a).isZero();

/** Canonical 2dp string for currency amounts (DB/JSON). */
export function money(v: Numeric): string {
  return dec(v).toFixed(2);
}

/** Sum a list of amounts. */
export function sum(values: Numeric[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(dec(v)), new Decimal(0));
}

export { Decimal };
