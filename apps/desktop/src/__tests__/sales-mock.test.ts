/**
 * The sales/invoicing mock (src/lib/api/mock.ts) is what a Phase 6.9 screen
 * will be written against before any of it is wired to the real core, so its
 * behaviour is a contract rather than a convenience. The parts asserted here
 * are the ones a screen would silently get wrong if the mock were wrong:
 * numbering, the draft-only guards, and the two derived figures that are
 * deliberately never stored (order totals, and invoice paid/unpaid state).
 *
 * What is asserted is arithmetic and internal agreement, never a literal id or
 * a hardcoded number that would need editing alongside any change and would
 * prove nothing.
 *
 * The mock is honest about what it does NOT model — confirming an order moves
 * no stock, because there is no stock ledger here at all — and that gap is
 * pinned below too, so nobody later reads a green screen as evidence the real
 * confirm/cancel stock path works.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "../lib/api/mock";

const BOOK = "book-sales-test";
const CONTACT = "contact-1";

async function draftWithLine(quantity = 2, unit = 1_500, taxBps = 1_500) {
  const order = await mockApi.sales_order_create({
    book_id: BOOK,
    contact_id: CONTACT,
  });
  await mockApi.sales_order_item_add({
    sales_order_id: order.id,
    description: "Consulting",
    quantity,
    unit_price_minor: unit,
    tax_rate_bps: taxBps,
  });
  return order;
}

async function draftQuoteWithLine(quantity = 2, unit = 1_500, taxBps = 1_500) {
  const quote = await mockApi.quote_create({
    book_id: BOOK,
    contact_id: CONTACT,
  });
  await mockApi.quote_item_add({
    quote_id: quote.id,
    description: "Consulting",
    quantity,
    unit_price_minor: unit,
    tax_rate_bps: taxBps,
  });
  return quote;
}

describe("quote mock", () => {
  it("numbers quotes per book, separately from sales orders", async () => {
    // A book of its own, so this assertion cannot be affected by however
    // many sales orders or quotes other tests in this file already created
    // against the shared BOOK constant.
    const book = "book-quote-numbering";
    const a = await mockApi.quote_create({ book_id: book, contact_id: CONTACT });
    const b = await mockApi.quote_create({ book_id: book, contact_id: CONTACT });
    expect(b.number).toBe(a.number + 1);

    // A sales order created in the same book, right after two quotes, still
    // starts its own series at 1 — the two numbering books do not share a
    // counter.
    const order = await mockApi.sales_order_create({
      book_id: book,
      contact_id: CONTACT,
    });
    expect(order.number).toBe(1);

    const other = await mockApi.quote_create({
      book_id: "book-other-quotes",
      contact_id: CONTACT,
    });
    expect(other.number).toBe(1);
  });

  it("starts as a draft and derives totals from its lines rather than storing them", async () => {
    const quote = await draftQuoteWithLine(2, 1_500, 1_500);
    expect(quote.status).toBe("draft");

    const totals = await mockApi.quote_totals({ id: quote.id });
    expect(totals.subtotal_minor).toBe(3_000);
    expect(totals.tax_minor).toBe(450); // 15% of 3 000
    expect(totals.total_minor).toBe(totals.subtotal_minor + totals.tax_minor);

    await mockApi.quote_item_add({
      quote_id: quote.id,
      description: "Travel",
      quantity: 1,
      unit_price_minor: 1_000,
      tax_rate_bps: 0,
    });
    const after = await mockApi.quote_totals({ id: quote.id });
    expect(after.subtotal_minor).toBe(4_000);
    expect(after.tax_minor).toBe(450);
  });

  it("refuses to edit the quote header or its lines once it is no longer a draft", async () => {
    const quote = await draftQuoteWithLine();
    const edited = await mockApi.quote_update({ id: quote.id, notes: "before" });
    expect(edited.notes).toBe("before");

    await mockApi.quote_send({ id: quote.id });
    await expect(
      mockApi.quote_update({ id: quote.id, notes: "after" }),
    ).rejects.toThrow(/sent quote cannot be edited/);
    expect((await mockApi.quote_get({ id: quote.id })).notes).toBe("before");

    const [line] = await mockApi.quote_items_list({ quote_id: quote.id });
    await expect(
      mockApi.quote_item_update({ id: line.id, quantity: 5 }),
    ).rejects.toThrow(/sent quote cannot be changed/);
    await expect(mockApi.quote_item_remove({ id: line.id })).rejects.toThrow(
      /sent quote cannot be changed/,
    );
    await expect(
      mockApi.quote_item_add({
        quote_id: quote.id,
        description: "Late addition",
        quantity: 1,
        unit_price_minor: 100,
      }),
    ).rejects.toThrow(/sent quote cannot be changed/);
  });

  it("refuses to send a quote with no lines", async () => {
    const empty = await mockApi.quote_create({ book_id: BOOK, contact_id: CONTACT });
    await expect(mockApi.quote_send({ id: empty.id })).rejects.toThrow(/no lines/);
  });

  it("only a draft quote can be deleted; a sent one is declined or left to expire", async () => {
    const quote = await draftQuoteWithLine();
    await mockApi.quote_send({ id: quote.id });
    await expect(mockApi.quote_delete({ id: quote.id })).rejects.toThrow(
      /sent quote cannot be deleted/,
    );

    const declined = await mockApi.quote_decline({ id: quote.id });
    expect(declined.status).toBe("declined");
    expect(declined.declined_at).not.toBeNull();

    // A declined quote can neither be accepted nor expired.
    await expect(mockApi.quote_accept({ id: quote.id })).rejects.toThrow(
      /declined quote cannot be accepted/,
    );
    await expect(mockApi.quote_expire({ id: quote.id })).rejects.toThrow(
      /declined quote cannot expire/,
    );

    const other = await draftQuoteWithLine();
    await mockApi.quote_send({ id: other.id });
    const expired = await mockApi.quote_expire({ id: other.id });
    expect(expired.status).toBe("expired");
    expect(expired.expired_at).not.toBeNull();
  });

  it("accept copies lines into a brand-new DRAFT sales order and leaves the quote's own lines untouched", async () => {
    const quote = await draftQuoteWithLine(3, 2_000, 1_500);
    await mockApi.quote_item_add({
      quote_id: quote.id,
      description: "Setup fee",
      quantity: 1,
      unit_price_minor: 5_000,
      tax_rate_bps: 0,
    });

    // Can't accept before it is sent.
    await expect(mockApi.quote_accept({ id: quote.id })).rejects.toThrow(
      /draft quote cannot be accepted/,
    );

    await mockApi.quote_send({ id: quote.id });
    const order = await mockApi.quote_accept({ id: quote.id });

    expect(order.status).toBe("draft");
    expect(order.contact_id).toBe(CONTACT);
    expect(order.location_id).toBeNull();

    const orderLines = await mockApi.sales_order_items_list({
      sales_order_id: order.id,
    });
    const quoteLines = await mockApi.quote_items_list({ quote_id: quote.id });
    expect(orderLines.map((l) => [l.description, l.quantity, l.unit_price_minor])).toEqual(
      quoteLines.map((l) => [l.description, l.quantity, l.unit_price_minor]),
    );

    const orderTotals = await mockApi.sales_order_totals({ id: order.id });
    const quoteTotals = await mockApi.quote_totals({ id: quote.id });
    expect(orderTotals).toEqual(quoteTotals);

    const accepted = await mockApi.quote_get({ id: quote.id });
    expect(accepted.status).toBe("accepted");
    expect(accepted.converted_sales_order_id).toBe(order.id);

    // Accepting again is refused — the quote is no longer `sent`.
    await expect(mockApi.quote_accept({ id: quote.id })).rejects.toThrow(
      /accepted quote cannot be accepted/,
    );
  });
});

describe("sales order mock", () => {
  it("numbers orders per book with no gap and no reuse", async () => {
    const a = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
    });
    const b = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
    });
    expect(b.number).toBe(a.number + 1);

    // A different book has its own sequence, exactly as core scopes
    // number_sequences by (book_id, series).
    const other = await mockApi.sales_order_create({
      book_id: "book-other",
      contact_id: CONTACT,
    });
    expect(other.number).toBe(1);
  });

  it("starts as a draft and derives totals from its lines rather than storing them", async () => {
    const order = await draftWithLine(2, 1_500, 1_500);
    expect(order.status).toBe("draft");

    const totals = await mockApi.sales_order_totals({ id: order.id });
    expect(totals.subtotal_minor).toBe(3_000);
    expect(totals.tax_minor).toBe(450); // 15% of 3 000
    expect(totals.total_minor).toBe(totals.subtotal_minor + totals.tax_minor);

    // Adding a line changes the derived total with no separate "recalculate"
    // call — the point of not storing it.
    await mockApi.sales_order_item_add({
      sales_order_id: order.id,
      description: "Travel",
      quantity: 1,
      unit_price_minor: 1_000,
      tax_rate_bps: 0,
    });
    const after = await mockApi.sales_order_totals({ id: order.id });
    expect(after.subtotal_minor).toBe(4_000);
    expect(after.tax_minor).toBe(450);
  });

  it("refuses to edit the ORDER HEADER once it is no longer a draft", async () => {
    const order = await draftWithLine();
    // Editable while draft.
    const edited = await mockApi.sales_order_update({
      id: order.id,
      notes: "before",
    });
    expect(edited.notes).toBe("before");

    await mockApi.sales_order_confirm({ id: order.id });
    await expect(
      mockApi.sales_order_update({ id: order.id, notes: "after" }),
    ).rejects.toThrow(/confirmed order cannot be edited/);
    // And nothing was applied on the way to refusing.
    expect((await mockApi.sales_order_get({ id: order.id })).notes).toBe("before");
  });

  it("validates a line edit the way core does, not just its quantity", async () => {
    const order = await draftWithLine();
    const [line] = await mockApi.sales_order_items_list({
      sales_order_id: order.id,
    });

    await expect(
      mockApi.sales_order_item_update({ id: line.id, description: "  " }),
    ).rejects.toThrow(/description must not be empty/);
    await expect(
      mockApi.sales_order_item_update({ id: line.id, unit_price_minor: -1 }),
    ).rejects.toThrow(/must not be negative/);
    await expect(
      mockApi.sales_order_item_update({ id: line.id, tax_rate_bps: 10_001 }),
    ).rejects.toThrow(/basis points/);
    await expect(
      mockApi.sales_order_item_update({ id: line.id, quantity: 0 }),
    ).rejects.toThrow(/quantity must be positive/);

    // A refused edit leaves the line alone.
    const [after] = await mockApi.sales_order_items_list({
      sales_order_id: order.id,
    });
    expect(after.description).toBe(line.description);
    expect(after.unit_price_minor).toBe(line.unit_price_minor);
  });

  it("refuses to edit, delete or confirm anything that is no longer a draft", async () => {
    const order = await draftWithLine();
    await mockApi.sales_order_confirm({ id: order.id });

    await expect(
      mockApi.sales_order_item_add({
        sales_order_id: order.id,
        description: "Late addition",
        quantity: 1,
        unit_price_minor: 100,
      }),
    ).rejects.toThrow(/confirmed order cannot be changed/);
    await expect(
      mockApi.sales_order_delete({ id: order.id }),
    ).rejects.toThrow(/confirmed order cannot be deleted/);
    await expect(
      mockApi.sales_order_confirm({ id: order.id }),
    ).rejects.toThrow(/confirmed order cannot be confirmed/);
  });

  /** Core refuses this and the mock did not — found by comparing the two
   * rather than by either being tested on its own. A stock-tracked line has
   * to leave a location, so confirming without one would mean a movement with
   * nowhere to write it. */
  it("refuses to confirm a stock-tracked order that has no location", async () => {
    const noLocation = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
    });
    await mockApi.sales_order_item_add({
      sales_order_id: noLocation.id,
      variant_id: "variant-1",
      description: "Stock line",
      quantity: 1,
      unit_price_minor: 100,
    });
    await expect(
      mockApi.sales_order_confirm({ id: noLocation.id }),
    ).rejects.toThrow(/no location set/);

    // A free-text line needs no location, so that order confirms fine.
    const serviceOnly = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
    });
    await mockApi.sales_order_item_add({
      sales_order_id: serviceOnly.id,
      description: "Consulting",
      quantity: 1,
      unit_price_minor: 100,
    });
    const confirmed = await mockApi.sales_order_confirm({ id: serviceOnly.id });
    expect(confirmed.status).toBe("confirmed");
  });

  it("refuses to confirm an order with no lines", async () => {
    const empty = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
    });
    await expect(mockApi.sales_order_confirm({ id: empty.id })).rejects.toThrow(
      /no lines/,
    );
  });

  it("clears a nullable field on null and leaves it alone when the key is absent", async () => {
    const order = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
      notes: "first",
    });
    expect(order.notes).toBe("first");

    const untouched = await mockApi.sales_order_update({
      id: order.id,
      order_date: "2026-01-01",
    });
    expect(untouched.notes).toBe("first");

    const cleared = await mockApi.sales_order_update({
      id: order.id,
      notes: null,
    });
    expect(cleared.notes).toBeNull();
  });

  /** The mock deliberately models no stock ledger, the same as the purchasing
   * mock. Pinned so a screen author does not mistake a working confirm here
   * for evidence that the real stock deduction is exercised. */
  it("does not pretend to move stock on confirm", async () => {
    const order = await draftWithLine();
    const confirmed = await mockApi.sales_order_confirm({ id: order.id });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmed_at).not.toBeNull();
    expect(mockApi).not.toHaveProperty("stock_movement_list");
  });
});

describe("invoice mock", () => {
  it("copies the lines of the order it was issued from", async () => {
    const order = await draftWithLine(3, 1_000, 0);
    await mockApi.sales_order_confirm({ id: order.id });

    const invoice = await mockApi.invoice_issue({
      book_id: BOOK,
      sales_order_id: order.id,
      due_date: "2026-12-31",
    });
    expect(invoice.contact_id).toBe(CONTACT);
    expect(invoice.sales_order_id).toBe(order.id);

    const lines = await mockApi.invoice_items_list({ invoice_id: invoice.id });
    const orderLines = await mockApi.sales_order_items_list({
      sales_order_id: order.id,
    });
    expect(lines.map((l) => [l.description, l.quantity, l.unit_price_minor])).toEqual(
      orderLines.map((l) => [l.description, l.quantity, l.unit_price_minor]),
    );
  });

  /** Core carries eleven guards on `invoice_issue`; the mock had two. These
   * are the ones it can actually model — found by `npm run mock-guards:check`
   * flagging the gap, not by either side being tested alone. */
  it("refuses to invoice a draft order, a backwards due date, or a bad line", async () => {
    const draft = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: CONTACT,
    });
    await mockApi.sales_order_item_add({
      sales_order_id: draft.id,
      description: "Work",
      quantity: 1,
      unit_price_minor: 100,
    });
    // An invoice is a fact about a sale that happened; a draft has not.
    await expect(
      mockApi.invoice_issue({
        book_id: BOOK,
        sales_order_id: draft.id,
        due_date: "2026-12-31",
      }),
    ).rejects.toThrow(/not confirmed or paid/);

    // Confirm it and the same call succeeds.
    await mockApi.sales_order_confirm({ id: draft.id });
    const ok = await mockApi.invoice_issue({
      book_id: BOOK,
      sales_order_id: draft.id,
      due_date: "2026-12-31",
    });
    expect(ok.number).toBeGreaterThan(0);

    await expect(
      mockApi.invoice_issue({
        book_id: BOOK,
        contact_id: CONTACT,
        issue_date: "2026-06-01",
        due_date: "2026-05-01",
        items: [{ description: "x", quantity: 1, unit_price_minor: 1 }],
      }),
    ).rejects.toThrow(/due date must not be before/);

    await expect(
      mockApi.invoice_issue({
        book_id: BOOK,
        contact_id: CONTACT,
        due_date: "2026-12-31",
        series: "   ",
        items: [{ description: "x", quantity: 1, unit_price_minor: 1 }],
      }),
    ).rejects.toThrow(/series must not be empty/);

    for (const [bad, pattern] of [
      [{ description: "x", quantity: 0, unit_price_minor: 1 }, /quantity must be positive/],
      [{ description: "x", quantity: 1, unit_price_minor: -1 }, /must not be negative/],
      [
        { description: "x", quantity: 1, unit_price_minor: 1, tax_rate_bps: 10_001 },
        /basis points/,
      ],
    ] as const) {
      await expect(
        mockApi.invoice_issue({
          book_id: BOOK,
          contact_id: CONTACT,
          due_date: "2026-12-31",
          items: [bad],
        }),
      ).rejects.toThrow(pattern);
    }
  });

  it("refuses to issue an invoice with nothing on it", async () => {
    await expect(
      mockApi.invoice_issue({ book_id: BOOK, contact_id: CONTACT, due_date: "2026-12-31" }),
    ).rejects.toThrow(/at least one line/);
  });

  it("derives paid/unpaid from the payments rather than storing a flag", async () => {
    const invoice = await mockApi.invoice_issue({
      book_id: BOOK,
      contact_id: CONTACT,
      due_date: "2026-12-31",
      items: [
        { description: "Work", quantity: 1, unit_price_minor: 10_000, tax_rate_bps: 0 },
      ],
    });
    // There is no status column on the invoice itself — that is the point.
    expect(invoice).not.toHaveProperty("status");

    let totals = await mockApi.invoice_totals({ id: invoice.id });
    expect(totals.status).toBe("unpaid");
    expect(totals.due_minor).toBe(10_000);

    await mockApi.invoice_payment_record({
      invoice_id: invoice.id,
      amount_minor: 4_000,
    });
    totals = await mockApi.invoice_totals({ id: invoice.id });
    expect(totals.status).toBe("partly_paid");
    expect(totals.paid_minor).toBe(4_000);
    expect(totals.due_minor).toBe(6_000);

    await mockApi.invoice_payment_record({
      invoice_id: invoice.id,
      amount_minor: 6_000,
    });
    totals = await mockApi.invoice_totals({ id: invoice.id });
    expect(totals.status).toBe("paid");
    expect(totals.due_minor).toBe(0);

    // Two payments recorded independently both survive — the union behaviour
    // the immutable payments table exists for.
    const payments = await mockApi.invoice_payments_list({ invoice_id: invoice.id });
    expect(payments).toHaveLength(2);
  });

  it("buckets outstanding invoices by age and drops settled ones", async () => {
    const book = "book-aged";
    const overdue = await mockApi.invoice_issue({
      book_id: book,
      contact_id: "c-late",
      issue_date: "2025-12-01",
      due_date: "2026-01-01",
      items: [{ description: "Old", quantity: 1, unit_price_minor: 5_000 }],
    });
    const notYetDue = await mockApi.invoice_issue({
      book_id: book,
      contact_id: "c-current",
      issue_date: "2026-01-15",
      due_date: "2026-06-30",
      items: [{ description: "New", quantity: 1, unit_price_minor: 2_000 }],
    });

    // As of a date 45 days past the first invoice's due date.
    let aged = await mockApi.report_aged_receivables({
      book_id: book,
      as_of: "2026-02-15",
    });
    const late = aged.rows.find((r) => r.contact_id === "c-late");
    const current = aged.rows.find((r) => r.contact_id === "c-current");
    expect(late?.buckets.overdue_31_60_minor).toBe(5_000);
    expect(late?.buckets.current_minor).toBe(0);
    expect(current?.buckets.current_minor).toBe(2_000);
    expect(aged.totals.total_minor).toBe(7_000);

    // Settle one: it leaves the report entirely rather than showing as zero.
    await mockApi.invoice_payment_record({
      invoice_id: overdue.id,
      amount_minor: 5_000,
    });
    aged = await mockApi.report_aged_receivables({
      book_id: book,
      as_of: "2026-02-15",
    });
    expect(aged.rows.find((r) => r.contact_id === "c-late")).toBeUndefined();
    expect(aged.totals.total_minor).toBe(2_000);
    expect(notYetDue.number).toBeGreaterThan(0);
  });
});
