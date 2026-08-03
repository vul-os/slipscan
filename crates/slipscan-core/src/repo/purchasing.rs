//! Purchase orders, their line items, and goods receipts (migration 0013).
//!
//! Raw SQL only — validation (supplier/location/variant scoping, status
//! transitions, recomputing a header's money totals from its lines) lives in
//! the service layer, same as every other module here.
//!
//! **There is no `receipt_update` and no `receipt_delete`, and there never
//! will be.** Migration `0013_purchasing` installs `BEFORE UPDATE`/
//! `BEFORE DELETE` triggers on `po_receipts` that `RAISE(ABORT)`, exactly the
//! treatment `repo::stock` gives `stock_movements` — the absence here is
//! deliberate, not an oversight.
//!
//! On-hand-style figures (a line's received quantity, a line's or a whole
//! PO's receiving status) are never stored; every "how much has arrived"
//! question here is `SUM(qty)` over `po_receipts`, computed at query time.
//! See the migration header for why.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{PoReceipt, PurchaseOrder, PurchaseOrderItem};
use crate::error::CoreResult;

fn map_po(row: &Row<'_>) -> rusqlite::Result<PurchaseOrder> {
    Ok(PurchaseOrder {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        supplier_id: row.get("supplier_id")?,
        location_id: row.get("location_id")?,
        po_number: row.get("po_number")?,
        order_date: row.get("order_date")?,
        expected_delivery: row.get("expected_delivery")?,
        status: col_enum(row, "status")?,
        subtotal_minor: row.get("subtotal_minor")?,
        tax_minor: row.get("tax_minor")?,
        total_minor: row.get("total_minor")?,
        currency: row.get("currency")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_item(row: &Row<'_>) -> rusqlite::Result<PurchaseOrderItem> {
    Ok(PurchaseOrderItem {
        id: row.get("id")?,
        purchase_order_id: row.get("purchase_order_id")?,
        book_id: row.get("book_id")?,
        variant_id: row.get("variant_id")?,
        qty_ordered: row.get("qty_ordered")?,
        unit_price_minor: row.get("unit_price_minor")?,
        total_minor: row.get("total_minor")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_receipt(row: &Row<'_>) -> rusqlite::Result<PoReceipt> {
    Ok(PoReceipt {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        purchase_order_item_id: row.get("purchase_order_item_id")?,
        location_id: row.get("location_id")?,
        qty: row.get("qty")?,
        note: row.get("note")?,
        received_by: row.get("received_by")?,
        created_at: row.get("created_at")?,
    })
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

pub fn po_insert(conn: &Connection, po: &PurchaseOrder) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO purchase_orders
             (id, book_id, supplier_id, location_id, po_number, order_date,
              expected_delivery, status, subtotal_minor, tax_minor, total_minor,
              currency, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            po.id,
            po.book_id,
            po.supplier_id,
            po.location_id,
            po.po_number,
            po.order_date,
            po.expected_delivery,
            po.status.as_str(),
            po.subtotal_minor,
            po.tax_minor,
            po.total_minor,
            po.currency,
            po.notes,
            po.created_at,
            po.updated_at,
        ],
    )?;
    Ok(())
}

pub fn po_get(conn: &Connection, id: &str) -> CoreResult<Option<PurchaseOrder>> {
    Ok(conn
        .query_row(
            "SELECT * FROM purchase_orders WHERE id = ?1",
            params![id],
            map_po,
        )
        .optional()?)
}

/// Every PO in the book, most recently ordered first.
pub fn po_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<PurchaseOrder>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM purchase_orders WHERE book_id = ?1 ORDER BY order_date DESC, id",
    )?;
    let rows = stmt
        .query_map(params![book_id], map_po)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn po_update(conn: &Connection, po: &PurchaseOrder) -> CoreResult<()> {
    conn.execute(
        "UPDATE purchase_orders
         SET supplier_id = ?2, location_id = ?3, po_number = ?4, order_date = ?5,
             expected_delivery = ?6, status = ?7, subtotal_minor = ?8, tax_minor = ?9,
             total_minor = ?10, notes = ?11, updated_at = ?12
         WHERE id = ?1",
        params![
            po.id,
            po.supplier_id,
            po.location_id,
            po.po_number,
            po.order_date,
            po.expected_delivery,
            po.status.as_str(),
            po.subtotal_minor,
            po.tax_minor,
            po.total_minor,
            po.notes,
            po.updated_at,
        ],
    )?;
    Ok(())
}

/// Hard delete. `purchase_order_items.purchase_order_id` is `ON DELETE
/// CASCADE`, so a PO's own lines go with it — unless one of those lines has
/// a receipt, in which case `po_receipts.purchase_order_item_id`'s `RESTRICT`
/// fails the whole statement (see the migration header).
pub fn po_delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM purchase_orders WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Purchase order items
// ---------------------------------------------------------------------------

pub fn item_insert(conn: &Connection, item: &PurchaseOrderItem) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO purchase_order_items
             (id, purchase_order_id, book_id, variant_id, qty_ordered,
              unit_price_minor, total_minor, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            item.id,
            item.purchase_order_id,
            item.book_id,
            item.variant_id,
            item.qty_ordered,
            item.unit_price_minor,
            item.total_minor,
            item.created_at,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn item_get(conn: &Connection, id: &str) -> CoreResult<Option<PurchaseOrderItem>> {
    Ok(conn
        .query_row(
            "SELECT * FROM purchase_order_items WHERE id = ?1",
            params![id],
            map_item,
        )
        .optional()?)
}

/// A PO's own lines, in the order they were added.
pub fn item_list_for_po(
    conn: &Connection,
    purchase_order_id: &str,
) -> CoreResult<Vec<PurchaseOrderItem>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM purchase_order_items WHERE purchase_order_id = ?1
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map(params![purchase_order_id], map_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn item_update(conn: &Connection, item: &PurchaseOrderItem) -> CoreResult<()> {
    conn.execute(
        "UPDATE purchase_order_items
         SET qty_ordered = ?2, unit_price_minor = ?3, total_minor = ?4, updated_at = ?5
         WHERE id = ?1",
        params![
            item.id,
            item.qty_ordered,
            item.unit_price_minor,
            item.total_minor,
            item.updated_at,
        ],
    )?;
    Ok(())
}

/// Hard delete. Fails at the database level (an ordinary constraint error,
/// not a friendly `CoreError` today — nobody has hit it as a caller yet, the
/// same posture migration 0012 documents for `stock_movements`' own FKs) if
/// this line has any `po_receipts` against it.
pub fn item_delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM purchase_order_items WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Goods receipts — insert-only, like `repo::stock`.
// ---------------------------------------------------------------------------

/// The only write this module offers for `po_receipts`. Insert-only by
/// construction: the schema refuses everything else.
pub fn receipt_insert(conn: &Connection, receipt: &PoReceipt) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO po_receipts
             (id, book_id, purchase_order_item_id, location_id, qty, note,
              received_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            receipt.id,
            receipt.book_id,
            receipt.purchase_order_item_id,
            receipt.location_id,
            receipt.qty,
            receipt.note,
            receipt.received_by,
            receipt.created_at,
        ],
    )?;
    Ok(())
}

pub fn receipt_get(conn: &Connection, id: &str) -> CoreResult<Option<PoReceipt>> {
    Ok(conn
        .query_row(
            "SELECT * FROM po_receipts WHERE id = ?1",
            params![id],
            map_receipt,
        )
        .optional()?)
}

/// Every receipt recorded against one line, oldest first — the full history
/// behind that line's received-quantity figure.
pub fn receipts_for_item(conn: &Connection, item_id: &str) -> CoreResult<Vec<PoReceipt>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM po_receipts WHERE purchase_order_item_id = ?1
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map(params![item_id], map_receipt)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every receipt recorded against any of a PO's lines, oldest first — a PO's
/// full receiving history in one call, without the caller fanning out over
/// `receipts_for_item` per line.
pub fn receipts_for_po(conn: &Connection, purchase_order_id: &str) -> CoreResult<Vec<PoReceipt>> {
    let mut stmt = conn.prepare(
        "SELECT r.* FROM po_receipts r
         JOIN purchase_order_items i ON i.id = r.purchase_order_item_id
         WHERE i.purchase_order_id = ?1
         ORDER BY r.created_at, r.id",
    )?;
    let rows = stmt
        .query_map(params![purchase_order_id], map_receipt)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A line's received quantity: `SUM(qty)` over exactly its own receipts.
/// Zero (never `NULL`) when nothing has been received against it yet —
/// the same treatment `repo::stock::on_hand` gives a variant/location pair
/// with no movements.
pub fn received_qty_for_item(conn: &Connection, item_id: &str) -> CoreResult<i64> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(qty), 0) FROM po_receipts WHERE purchase_order_item_id = ?1",
        params![item_id],
        |row| row.get(0),
    )?;
    Ok(total)
}
