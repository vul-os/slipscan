//! Fixed-asset register and depreciation runs (migration 0016).
//!
//! Raw SQL only — validation (schedule arithmetic, status transitions,
//! period ordering) lives in the service layer, same as every other module
//! here.
//!
//! **There is no `depreciation_run_update` and no `depreciation_run_delete`,
//! and there never will be.** Migration `0016_assets` installs `BEFORE
//! UPDATE`/`BEFORE DELETE` triggers on `asset_depreciation_runs` that
//! `RAISE(ABORT)`, exactly the treatment `repo::purchasing` gives
//! `po_receipts` — the absence here is deliberate, not an oversight.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{Asset, AssetDepreciationRun};
use crate::error::CoreResult;

fn map_asset(row: &Row<'_>) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        acquired_date: row.get("acquired_date")?,
        cost_minor: row.get("cost_minor")?,
        residual_minor: row.get("residual_minor")?,
        currency: row.get("currency")?,
        useful_life_months: row.get("useful_life_months")?,
        method: col_enum(row, "method")?,
        reducing_balance_rate_bps: row.get("reducing_balance_rate_bps")?,
        status: col_enum(row, "status")?,
        disposed_date: row.get("disposed_date")?,
        disposal_proceeds_minor: row.get("disposal_proceeds_minor")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_run(row: &Row<'_>) -> rusqlite::Result<AssetDepreciationRun> {
    Ok(AssetDepreciationRun {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        asset_id: row.get("asset_id")?,
        period: row.get("period")?,
        period_index: row.get("period_index")?,
        depreciation_minor: row.get("depreciation_minor")?,
        journal_id: row.get("journal_id")?,
        created_at: row.get("created_at")?,
    })
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

pub fn asset_insert(conn: &Connection, asset: &Asset) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO assets
             (id, book_id, name, description, acquired_date, cost_minor, residual_minor,
              currency, useful_life_months, method, reducing_balance_rate_bps, status,
              disposed_date, disposal_proceeds_minor, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            asset.id,
            asset.book_id,
            asset.name,
            asset.description,
            asset.acquired_date,
            asset.cost_minor,
            asset.residual_minor,
            asset.currency,
            asset.useful_life_months,
            asset.method.as_str(),
            asset.reducing_balance_rate_bps,
            asset.status.as_str(),
            asset.disposed_date,
            asset.disposal_proceeds_minor,
            asset.created_at,
            asset.updated_at,
        ],
    )?;
    Ok(())
}

pub fn asset_get(conn: &Connection, id: &str) -> CoreResult<Option<Asset>> {
    Ok(conn
        .query_row("SELECT * FROM assets WHERE id = ?1", params![id], map_asset)
        .optional()?)
}

/// Every asset in the book, most recently acquired first.
pub fn asset_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Asset>> {
    let mut stmt =
        conn.prepare("SELECT * FROM assets WHERE book_id = ?1 ORDER BY acquired_date DESC, id")?;
    let rows = stmt
        .query_map(params![book_id], map_asset)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn asset_update(conn: &Connection, asset: &Asset) -> CoreResult<()> {
    conn.execute(
        "UPDATE assets
         SET name = ?2, description = ?3, acquired_date = ?4, cost_minor = ?5,
             residual_minor = ?6, currency = ?7, useful_life_months = ?8, method = ?9,
             reducing_balance_rate_bps = ?10, status = ?11, disposed_date = ?12,
             disposal_proceeds_minor = ?13, updated_at = ?14
         WHERE id = ?1",
        params![
            asset.id,
            asset.name,
            asset.description,
            asset.acquired_date,
            asset.cost_minor,
            asset.residual_minor,
            asset.currency,
            asset.useful_life_months,
            asset.method.as_str(),
            asset.reducing_balance_rate_bps,
            asset.status.as_str(),
            asset.disposed_date,
            asset.disposal_proceeds_minor,
            asset.updated_at,
        ],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Depreciation runs — insert-only, like `repo::purchasing::receipt_insert`.
// ---------------------------------------------------------------------------

/// The only write this module offers for `asset_depreciation_runs`.
/// Insert-only by construction: the schema refuses everything else.
pub fn run_insert(conn: &Connection, run: &AssetDepreciationRun) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO asset_depreciation_runs
             (id, book_id, asset_id, period, period_index, depreciation_minor,
              journal_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run.id,
            run.book_id,
            run.asset_id,
            run.period,
            run.period_index,
            run.depreciation_minor,
            run.journal_id,
            run.created_at,
        ],
    )?;
    Ok(())
}

/// Every run recorded against one asset, oldest period first — the full
/// depreciation history behind its accumulated-depreciation figure.
pub fn runs_for_asset(conn: &Connection, asset_id: &str) -> CoreResult<Vec<AssetDepreciationRun>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM asset_depreciation_runs WHERE asset_id = ?1 ORDER BY period_index",
    )?;
    let rows = stmt
        .query_map(params![asset_id], map_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
