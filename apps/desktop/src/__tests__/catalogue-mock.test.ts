/**
 * The catalogue mock's delete rules are the ones easiest to get backwards, and
 * I got both backwards writing them: `product_delete` refused whenever the
 * product had any variant (a guard core does not have), and
 * `product_variant_delete` had no guard at all (one core does have).
 *
 * The schema is the authority and it is not what you would guess:
 *
 *   product_variants.product_id  -> products      ON DELETE **CASCADE**
 *   stock_movements.variant_id   -> variants      ON DELETE **RESTRICT**
 *   {sales_order,invoice,purchase_order}_items.variant_id  ON DELETE RESTRICT
 *
 * So deleting a product takes its variants with it — unless one of them has
 * been traded, at which point the whole thing is refused. A screen written
 * against a mock that says otherwise is wrong in the real app and right in
 * the browser, which is the worst way to be wrong.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "../lib/api/mock";

const BOOK = "book-catalogue-test";

async function productWithVariant(sku: string) {
  const product = await mockApi.product_create({ book_id: BOOK, name: `P-${sku}` });
  const variant = await mockApi.product_variant_add({
    product_id: product.id,
    sku,
    name: `V-${sku}`,
    currency: "ZAR",
  });
  return { product, variant };
}

describe("stock mock guards match core", () => {
  it("refuses a zero movement, and a ref_id with no ref_kind", async () => {
    const product = await mockApi.product_create({ book_id: BOOK, name: "P-stock" });
    const variant = await mockApi.product_variant_add({
      product_id: product.id,
      sku: "SKU-STOCK",
      name: "V",
      currency: "ZAR",
    });

    await expect(
      mockApi.stock_movement_record({
        variant_id: variant.id,
        location_id: "loc-1",
        qty_delta: 0,
        kind: "adjustment",
      }),
    ).rejects.toThrow(/not be zero/);

    // A pointer with nothing saying what it points at.
    await expect(
      mockApi.stock_movement_record({
        variant_id: variant.id,
        location_id: "loc-1",
        qty_delta: 5,
        kind: "receipt",
        ref_id: "some-doc",
      }),
    ).rejects.toThrow(/ref_kind/);

    // With both, it is accepted.
    const ok = await mockApi.stock_movement_record({
      variant_id: variant.id,
      location_id: "loc-1",
      qty_delta: 5,
      kind: "receipt",
      ref_kind: "po_receipt",
      ref_id: "some-doc",
    });
    expect(ok.qty_delta).toBe(5);
  });

  it("a transfer conserves the total and refuses a same-location move", async () => {
    const product = await mockApi.product_create({ book_id: BOOK, name: "P-xfer" });
    const variant = await mockApi.product_variant_add({
      product_id: product.id,
      sku: "SKU-XFER",
      name: "V",
      currency: "ZAR",
    });
    await mockApi.stock_movement_record({
      variant_id: variant.id,
      location_id: "loc-a",
      qty_delta: 10,
      kind: "receipt",
    });

    await expect(
      mockApi.stock_transfer({
        variant_id: variant.id,
        from_location_id: "loc-a",
        to_location_id: "loc-a",
        qty: 3,
      }),
    ).rejects.toThrow(/different locations/);

    const before = await mockApi.stock_on_hand_total({ variant_id: variant.id });
    const moved = await mockApi.stock_transfer({
      variant_id: variant.id,
      from_location_id: "loc-a",
      to_location_id: "loc-b",
      qty: 4,
    });
    expect(moved.out.qty_delta + moved.in_.qty_delta).toBe(0);
    expect(await mockApi.stock_on_hand_total({ variant_id: variant.id })).toBe(before);
    expect(
      await mockApi.stock_on_hand({ variant_id: variant.id, location_id: "loc-b" }),
    ).toBe(4);
  });
});

describe("catalogue mock delete rules", () => {
  it("deleting a product CASCADES to its variants when none has been traded", async () => {
    const { product, variant } = await productWithVariant("CASCADE-1");
    await mockApi.product_delete({ id: product.id });

    await expect(mockApi.product_get({ id: product.id })).rejects.toThrow();
    await expect(
      mockApi.product_variant_get({ id: variant.id }),
    ).rejects.toThrow(/no product variant/);
  });

  it("refuses to delete a product once one of its variants has been traded", async () => {
    const { product, variant } = await productWithVariant("RESTRICT-1");
    await mockApi.stock_movement_record({
      variant_id: variant.id,
      location_id: "loc-1",
      qty_delta: 3,
      kind: "receipt",
    });

    await expect(mockApi.product_delete({ id: product.id })).rejects.toThrow(
      /cannot be deleted/,
    );
    // And nothing was half-deleted on the way to refusing.
    expect((await mockApi.product_get({ id: product.id })).id).toBe(product.id);
    expect((await mockApi.product_variant_get({ id: variant.id })).id).toBe(variant.id);
  });

  it("refuses to delete a traded variant, and allows an untraded one", async () => {
    const { variant: traded } = await productWithVariant("RESTRICT-2");
    await mockApi.stock_movement_record({
      variant_id: traded.id,
      location_id: "loc-1",
      qty_delta: 1,
      kind: "receipt",
    });
    await expect(
      mockApi.product_variant_delete({ id: traded.id }),
    ).rejects.toThrow(/cannot be deleted/);

    const { variant: free } = await productWithVariant("FREE-1");
    await expect(
      mockApi.product_variant_delete({ id: free.id }),
    ).resolves.toBeNull();
  });

  it("an order line counts as trade history, not just a stock movement", async () => {
    const { product, variant } = await productWithVariant("RESTRICT-3");
    const order = await mockApi.sales_order_create({
      book_id: BOOK,
      contact_id: "contact-x",
    });
    await mockApi.sales_order_item_add({
      sales_order_id: order.id,
      variant_id: variant.id,
      description: "line",
      quantity: 1,
      unit_price_minor: 100,
    });

    await expect(
      mockApi.product_variant_delete({ id: variant.id }),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(mockApi.product_delete({ id: product.id })).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it("deleting a category leaves its products, uncategorised", async () => {
    const cat = await mockApi.product_category_create({
      book_id: BOOK,
      name: "Temp",
    });
    const product = await mockApi.product_create({
      book_id: BOOK,
      name: "Categorised",
      product_category_id: cat.id,
    });
    expect(product.product_category_id).toBe(cat.id);

    // ON DELETE SET NULL, not CASCADE — the product survives.
    await mockApi.product_category_delete({ id: cat.id });
    const after = await mockApi.product_get({ id: product.id });
    expect(after.product_category_id).toBeNull();
  });
});
