/**
 * Purchasing mock rules checked against core rather than assumed. Three of the
 * four mocks in this app had at least one guard that core did not share, or
 * lacked one core enforces — none of it visible until the two were compared,
 * because each side was internally consistent and separately tested.
 *
 * Verified against a real database through the CLI before being written here.
 */
import { describe, expect, it } from "vitest";
import { mockApi } from "../lib/api/mock";

const BOOK = "book-purchasing-test";

let poSeq = 0;

async function poWithLine() {
  poSeq += 1;
  const po = await mockApi.po_create({
    book_id: BOOK,
    supplier_id: "supplier-1",
    location_id: "loc-1",
    po_number: `PO-${poSeq}`,
    order_date: "2026-01-05",
    currency: "ZAR",
  });
  const item = await mockApi.po_item_add({
    purchase_order_id: po.id,
    variant_id: "variant-1",
    qty_ordered: 10,
  });
  return { po, item };
}

describe("purchasing mock rules match core", () => {
  it("refuses to edit a line once the order is cancelled", async () => {
    const { po, item } = await poWithLine();
    // Editable while it is still open.
    const bumped = await mockApi.po_item_update({ id: item.id, qty_ordered: 12 });
    expect(bumped.qty_ordered).toBe(12);

    await mockApi.po_set_status({ po_id: po.id, status: "cancelled" });
    await expect(
      mockApi.po_item_update({ id: item.id, qty_ordered: 20 }),
    ).rejects.toThrow(/cancelled purchase order/);
  });

  it("refuses to delete a line that has a receipt against it", async () => {
    const { item } = await poWithLine();
    await mockApi.po_receive({
      purchase_order_item_id: item.id,
      location_id: "loc-1",
      qty: 3,
    });
    await expect(mockApi.po_item_delete({ item_id: item.id })).rejects.toThrow(
      /receipt/,
    );
  });

  it("refuses to shrink an ordered quantity below what has been received", async () => {
    const { item } = await poWithLine();
    await mockApi.po_receive({
      purchase_order_item_id: item.id,
      location_id: "loc-1",
      qty: 6,
    });
    await expect(
      mockApi.po_item_update({ id: item.id, qty_ordered: 4 }),
    ).rejects.toThrow(/already been received/);
    // Down to exactly what arrived is fine.
    const shrunk = await mockApi.po_item_update({ id: item.id, qty_ordered: 6 });
    expect(shrunk.qty_ordered).toBe(6);
  });

  it("derives receiving progress rather than storing it, and a zero receipt is refused", async () => {
    const { item } = await poWithLine();
    expect(await mockApi.po_item_receiving_status({ item_id: item.id })).toBe("none");

    await mockApi.po_receive({
      purchase_order_item_id: item.id,
      location_id: "loc-1",
      qty: 4,
    });
    expect(await mockApi.po_item_receiving_status({ item_id: item.id })).toBe("partial");
    expect(await mockApi.po_item_received_qty({ item_id: item.id })).toBe(4);

    await mockApi.po_receive({
      purchase_order_item_id: item.id,
      location_id: "loc-1",
      qty: 6,
    });
    expect(await mockApi.po_item_receiving_status({ item_id: item.id })).toBe("complete");

    await expect(
      mockApi.po_receive({
        purchase_order_item_id: item.id,
        location_id: "loc-1",
        qty: 0,
      }),
    ).rejects.toThrow(/not be zero/);
  });
});
