//! The stock-movement ledger (migration 0012).
//!
//! Raw SQL only — validation (variant/location existence, cross-book
//! scoping, the transfer pairing) lives in the service layer, same as every
//! other module here.
//!
//! **There is no `update` and no `delete` function in this file, and there
//! never will be.** Migration `0012_stock` installs `BEFORE UPDATE`/`BEFORE
//! DELETE` triggers that `RAISE(ABORT)` on this table, so writing one would
//! be dead code that compiles and fails at the first call — the absence is
//! deliberate, not an oversight, exactly like `repo::ledger` has no
//! `journal_update`.
//!
//! On-hand is never stored; every "how much" question in this file is a
//! `SUM(qty_delta)` computed at query time. See the migration header for why.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{ProductVariant, StockMovement};
use crate::error::CoreResult;

fn map_movement(row: &Row<'_>) -> rusqlite::Result<StockMovement> {
    Ok(StockMovement {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        variant_id: row.get("variant_id")?,
        location_id: row.get("location_id")?,
        qty_delta: row.get("qty_delta")?,
        kind: super::col_enum(row, "kind")?,
        ref_kind: row.get("ref_kind")?,
        ref_id: row.get("ref_id")?,
        note: row.get("note")?,
        created_by: row.get("created_by")?,
        created_at: row.get("created_at")?,
    })
}

/// The only write this module offers. Insert-only by construction: the
/// schema refuses everything else.
pub fn insert(conn: &Connection, movement: &StockMovement) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO stock_movements
             (id, book_id, variant_id, location_id, qty_delta, kind, ref_kind,
              ref_id, note, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            movement.id,
            movement.book_id,
            movement.variant_id,
            movement.location_id,
            movement.qty_delta,
            movement.kind.as_str(),
            movement.ref_kind,
            movement.ref_id,
            movement.note,
            movement.created_by,
            movement.created_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<StockMovement>> {
    Ok(conn
        .query_row(
            "SELECT * FROM stock_movements WHERE id = ?1",
            params![id],
            map_movement,
        )
        .optional()?)
}

/// Every movement a variant has ever had, at any location, oldest first — the
/// full history behind a variant's on-hand figure.
pub fn list_for_variant(conn: &Connection, variant_id: &str) -> CoreResult<Vec<StockMovement>> {
    let mut stmt = conn
        .prepare("SELECT * FROM stock_movements WHERE variant_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![variant_id], map_movement)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every movement recorded at a location, any variant — a branch's stock
/// ledger.
pub fn list_for_location(conn: &Connection, location_id: &str) -> CoreResult<Vec<StockMovement>> {
    let mut stmt = conn
        .prepare("SELECT * FROM stock_movements WHERE location_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![location_id], map_movement)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every movement sharing one `(ref_kind, ref_id)` pair — a transfer's two
/// legs, or (once 6.4/6.5 exist) every movement one receipt or sale produced.
pub fn list_for_ref(
    conn: &Connection,
    ref_kind: &str,
    ref_id: &str,
) -> CoreResult<Vec<StockMovement>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM stock_movements WHERE ref_kind = ?1 AND ref_id = ?2
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map(params![ref_kind, ref_id], map_movement)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// On-hand for one variant at one location: `SUM(qty_delta)` over exactly the
/// rows that name both. Zero (never `NULL`) when nothing has moved there yet.
pub fn on_hand(conn: &Connection, variant_id: &str, location_id: &str) -> CoreResult<i64> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(qty_delta), 0) FROM stock_movements
         WHERE variant_id = ?1 AND location_id = ?2",
        params![variant_id, location_id],
        |row| row.get(0),
    )?;
    Ok(total)
}

/// On-hand for one variant, summed across every location it has ever moved
/// at — the "how many do we have, anywhere" figure.
pub fn on_hand_total(conn: &Connection, variant_id: &str) -> CoreResult<i64> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(qty_delta), 0) FROM stock_movements WHERE variant_id = ?1",
        params![variant_id],
        |row| row.get(0),
    )?;
    Ok(total)
}

/// On-hand for one variant, broken down per location — every location that
/// has ever recorded a movement for it, zero-suppressed the same way the
/// ledger itself is (a location that never traded this variant has no row
/// here, not a row reading zero).
pub fn on_hand_by_location(conn: &Connection, variant_id: &str) -> CoreResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT location_id, SUM(qty_delta) FROM stock_movements
         WHERE variant_id = ?1 GROUP BY location_id ORDER BY location_id",
    )?;
    let rows = stmt
        .query_map(params![variant_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_variant(row: &Row<'_>) -> rusqlite::Result<ProductVariant> {
    Ok(ProductVariant {
        id: row.get("id")?,
        product_id: row.get("product_id")?,
        book_id: row.get("book_id")?,
        sku: row.get("sku")?,
        name: row.get("name")?,
        price_minor: row.get("price_minor")?,
        cost_price_minor: row.get("cost_price_minor")?,
        currency: row.get("currency")?,
        reorder_point: row.get("reorder_point")?,
        attributes: row.get("attributes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Every variant in the book whose total on-hand (summed across every
/// location, `LEFT JOIN` so a variant with zero movements still reads as
/// zero rather than being dropped) is at or below its own `reorder_point`.
///
/// `HAVING` rather than a `WHERE` on a subquery: the aggregate is computed
/// once per variant either way, and this is the plain SQL spelling of "group,
/// then filter on the group's own total".
pub fn low_stock(conn: &Connection, book_id: &str) -> CoreResult<Vec<(ProductVariant, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT pv.*, COALESCE(SUM(sm.qty_delta), 0) AS on_hand
         FROM product_variants pv
         LEFT JOIN stock_movements sm ON sm.variant_id = pv.id
         WHERE pv.book_id = ?1
         GROUP BY pv.id
         HAVING on_hand <= pv.reorder_point
         ORDER BY pv.sku, pv.id",
    )?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok((map_variant(row)?, row.get::<_, i64>("on_hand")?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
