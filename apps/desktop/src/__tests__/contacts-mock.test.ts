/**
 * Contact guards, found missing by `npm run mock-guards:check` — core refuses
 * negative payment terms and a negative credit limit on both add and update,
 * and the mock enforced only the empty-name rule. That gate exists because
 * five other mocks had already diverged the same way; this pair was found
 * within a minute of it running for the first time.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "../lib/api/mock";

const BOOK = "book-contacts-test";

describe("contact mock guards match core", () => {
  it("refuses an empty name, negative terms and a negative credit limit on add", async () => {
    await expect(
      mockApi.contact_add({ book_id: BOOK, role: "customer", name: "   " }),
    ).rejects.toThrow(/name must not be empty/);

    await expect(
      mockApi.contact_add({
        book_id: BOOK,
        role: "customer",
        name: "Acme",
        payment_terms_days: -1,
      }),
    ).rejects.toThrow(/payment terms/);

    await expect(
      mockApi.contact_add({
        book_id: BOOK,
        role: "customer",
        name: "Acme",
        credit_limit_minor: -100,
      }),
    ).rejects.toThrow(/credit limit/);

    // Zero is explicitly allowed for both — "zero or more days".
    const ok = await mockApi.contact_add({
      book_id: BOOK,
      role: "customer",
      name: "Acme",
      payment_terms_days: 0,
      credit_limit_minor: 0,
    });
    expect(ok.payment_terms_days).toBe(0);
    expect(ok.credit_limit_minor).toBe(0);
  });

  it("applies the same rules on update, and null still clears", async () => {
    const c = await mockApi.contact_add({
      book_id: BOOK,
      role: "both",
      name: "Wholesale",
      payment_terms_days: 30,
    });

    await expect(
      mockApi.contact_update({ id: c.id, payment_terms_days: -5 }),
    ).rejects.toThrow(/payment terms/);
    await expect(
      mockApi.contact_update({ id: c.id, credit_limit_minor: -5 }),
    ).rejects.toThrow(/credit limit/);

    // A refused update must not have half-applied.
    expect((await mockApi.contact_get({ id: c.id })).payment_terms_days).toBe(30);

    // null clears rather than being read as a negative-number check.
    const cleared = await mockApi.contact_update({
      id: c.id,
      payment_terms_days: null,
    });
    expect(cleared.payment_terms_days).toBeNull();
  });

  it("keeps a `both` contact on the customer and supplier lists", async () => {
    const book = "book-contacts-roles";
    await mockApi.contact_add({ book_id: book, role: "both", name: "Both Co" });
    await mockApi.contact_add({ book_id: book, role: "customer", name: "Buyer" });
    await mockApi.contact_add({ book_id: book, role: "supplier", name: "Seller" });

    const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();
    expect(names(await mockApi.contact_list_customers({ book_id: book }))).toEqual([
      "Both Co",
      "Buyer",
    ]);
    expect(names(await mockApi.contact_list_suppliers({ book_id: book }))).toEqual([
      "Both Co",
      "Seller",
    ]);
  });
});
