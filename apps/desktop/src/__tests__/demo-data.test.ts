/**
 * The demo dataset (src/lib/api/mock.ts) is not just a fixture any more —
 * it is what the screenshot gallery and the landing page show, so an
 * incoherent seed is a public claim that the product is broken.
 *
 * Two such claims shipped and are pinned shut here:
 *
 *   - A payment watch labelled "Garden flat rent" reported R123.84, because
 *     the seed pointed it at an interest-capitalisation credit that happened
 *     to sit at a hardcoded index.
 *   - Every household member contributed R0.00 for the month on screen,
 *     because the only salary seed was dated the month before.
 *
 * What is asserted below is arithmetic and internal agreement, never a
 * literal figure: a test that hardcoded R7 500 would have to be edited
 * alongside any seed change and would prove nothing about coherence.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "../lib/api/mock";

/** The instant the gallery is captured at (apps/desktop/scripts/screenshot.mjs). */
const CAPTURE_DATE = "2026-07-16";
const MONTH = CAPTURE_DATE.slice(0, 7);
const FROM = `${MONTH}-01`;
const TO = `${MONTH}-31`;

async function bookId(): Promise<string> {
  const [book] = await mockApi.book_list();
  return book!.id;
}

describe("demo dataset: what the gallery shows", () => {
  it("dates nothing after the instant the gallery is captured at", async () => {
    // A seed in the future is invisible on every month-scoped screen, which
    // is indistinguishable from a broken feature in a screenshot.
    const txns = await mockApi.transaction_list({ book_id: await bookId() });
    expect(txns.length).toBeGreaterThan(0);
    for (const t of txns) {
      expect(
        t.posted_at.slice(0, 10) <= CAPTURE_DATE,
        `${t.description} is dated ${t.posted_at.slice(0, 10)}, after the capture clock`,
      ).toBe(true);
    }
  });

  it("gives every household member something to contribute this month", async () => {
    const id = await bookId();
    const members = await mockApi.member_list({ book_id: id });
    const contribution = await mockApi.report_member_contribution({
      book_id: id,
      from: FROM,
      to: TO,
    });
    expect(members.length).toBeGreaterThan(1);
    for (const m of members) {
      const row = contribution.find((r) => r.member_id === m.id);
      expect(
        row?.total_minor ?? 0,
        `${m.label} contributes nothing in ${MONTH}`,
      ).toBeGreaterThan(0);
    }
  });

  it("settles up to figures that actually reconcile", async () => {
    const id = await bookId();
    const period = { book_id: id, from: FROM, to: TO };
    const [settle, expense, contribution] = await Promise.all([
      mockApi.report_settle_up(period),
      mockApi.report_member_expense(period),
      mockApi.report_member_contribution(period),
    ]);

    // Every row's own arithmetic, and every row agreeing with the two
    // rollups the same screen renders beside it.
    for (const row of settle) {
      expect(row.net_minor).toBe(row.contributions_minor - row.expenses_minor);
      expect(row.contributions_minor).toBe(
        contribution.find((r) => r.member_id === row.member_id)?.total_minor ?? 0,
      );
      expect(row.expenses_minor).toBe(
        expense.find((r) => r.member_id === row.member_id)?.total_minor ?? 0,
      );
    }

    // Nothing is attributed twice or dropped: the settle-up columns total
    // the rollups exactly.
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
    expect(sum(settle.map((r) => r.contributions_minor))).toBe(
      sum(contribution.map((r) => r.total_minor)),
    );
    expect(sum(settle.map((r) => r.expenses_minor))).toBe(
      sum(expense.map((r) => r.total_minor)),
    );

    // Integer minor units end to end — never a float that rounds on screen.
    for (const row of settle) {
      expect(Number.isInteger(row.contributions_minor)).toBe(true);
      expect(Number.isInteger(row.expenses_minor)).toBe(true);
      expect(Number.isInteger(row.net_minor)).toBe(true);
    }
  });

  it("splits a transaction into shares that sum to it exactly", async () => {
    const id = await bookId();
    const txns = await mockApi.transaction_list({ book_id: id });
    for (const t of txns) {
      const shares = await mockApi.transaction_splits_list({
        transaction_id: t.id,
      });
      if (shares.length === 0) continue;
      expect(shares.reduce((s, x) => s + x.share_minor, 0)).toBe(
        Math.abs(t.amount_minor),
      );
    }
  });

  it("matches every payment watch to a credit that carries its reference", async () => {
    const id = await bookId();
    const [watches, matches, txns] = await Promise.all([
      mockApi.pay_watch_list({ book_id: id }),
      mockApi.pay_match_list({ book_id: id }),
      mockApi.transaction_list({ book_id: id }),
    ]);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const watch = watches.find((w) => w.id === match.watch_id);
      const tx = txns.find((t) => t.id === match.transaction_id);
      expect(watch, "match points at a watch that does not exist").toBeDefined();
      expect(tx, "match points at a transaction that does not exist").toBeDefined();

      // Core matches whole tokens on inbound transactions only.
      expect(tx!.amount_minor).toBeGreaterThan(0);
      expect(
        tx!.description.toUpperCase().split(/[^A-Z0-9-]+/),
        `${watch!.code} matched "${tx!.description}", which does not carry that reference`,
      ).toContain(watch!.code.toUpperCase());

      // A watch narrowed to an exact amount must have matched that amount.
      if (watch!.expected_amount_minor !== null) {
        expect(tx!.amount_minor).toBe(watch!.expected_amount_minor);
        expect(tx!.currency).toBe(watch!.expected_currency);
      }
    }
  });

  it("says the same thing about the current month everywhere", async () => {
    const id = await bookId();
    const [series, spending, txns] = await Promise.all([
      mockApi.report_income_expense({ book_id: id }),
      mockApi.report_spending({ book_id: id, from: FROM, to: TO }),
      mockApi.transaction_list({ book_id: id }),
    ]);
    const row = series.months.find((m) => m.month === MONTH);
    expect(row, `no ${MONTH} row in the income/expense series`).toBeDefined();

    // The month-to-date bar is the seeded rows, not an invented figure.
    expect(row!.expense_minor).toBe(spending.total_spent_minor);
    expect(row!.income_minor).toBe(
      txns
        .filter((t) => t.posted_at.startsWith(MONTH) && t.amount_minor > 0)
        .reduce((s, t) => s + t.amount_minor, 0),
    );
    expect(row!.income_minor).toBeGreaterThan(0);
  });

  it("keeps every delivery payload agreeing with the match it describes", async () => {
    const id = await bookId();
    const [matches, deliveries, txns] = await Promise.all([
      mockApi.pay_match_list({ book_id: id }),
      mockApi.pay_delivery_list({ book_id: id }),
      mockApi.transaction_list({ book_id: id }),
    ]);
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      const match = matches.find((m) => m.id === d.match_id);
      expect(match).toBeDefined();
      const tx = txns.find((t) => t.id === match!.transaction_id)!;
      const payload = JSON.parse(d.payload) as {
        amount_minor: number;
        currency: string;
        posted_date: string;
      };
      expect(payload.amount_minor).toBe(tx.amount_minor);
      expect(payload.currency).toBe(tx.currency);
      expect(payload.posted_date).toBe(tx.posted_at.slice(0, 10));
    }
  });
});

describe("demo dataset: creating the first book", () => {
  it("takes region and currency from the region-profile data", async () => {
    const regions = await mockApi.region_list();
    const profile = regions.find((r) => r.default_currency)!;
    const before = (await mockApi.book_list()).length;

    const created = await mockApi.book_create({
      name: "Second book",
      kind: "personal",
      region: profile.id,
    });
    expect(created.region).toBe(profile.id);
    expect(created.region_name).toBe(profile.display_name);
    expect(created.tax_report_name).toBe(profile.tax_report_name);
    expect(created.currency).toBe(profile.default_currency);
    expect(await mockApi.book_list()).toHaveLength(before + 1);
  });

  it("refuses a region profile nobody serves, rather than downgrading it", async () => {
    await expect(
      mockApi.book_create({ name: "Nowhere", kind: "personal", region: "atlantis" }),
    ).rejects.toThrow(/atlantis/);
  });

  it("falls back to the generic profile, never to a jurisdiction", async () => {
    const created = await mockApi.book_create({
      name: "Unspecified",
      kind: "business",
      currency: "usd",
    });
    const generic = (await mockApi.region_list()).find((r) => r.country === null)!;
    expect(created.region).toBe(generic.id);
    expect(created.currency).toBe("USD");
  });

  it("will not create a nameless book", async () => {
    await expect(
      mockApi.book_create({ name: "   ", kind: "personal" }),
    ).rejects.toThrow(/name/i);
  });
});
