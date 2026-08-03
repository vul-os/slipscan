//! The net-worth snapshot ledger (migration 0015).
//!
//! Raw SQL only — validation and orchestration (which accounts to snapshot,
//! how backfill walks the transaction ledger, currency conversion) live in
//! the service layer, same as every other module here.
//!
//! **There is no `update` and no `delete` function in this file, and there
//! never will be.** Migration `0015_networth` installs `BEFORE UPDATE`/
//! `BEFORE DELETE` triggers that `RAISE(ABORT)` on this table, so writing one
//! would be dead code that compiles and fails at the first call — the same
//! posture `repo::stock` documents for `stock_movements` and for the
//! identical reason.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::NetWorthSnapshot;
use crate::error::CoreResult;

fn map_snapshot(row: &Row<'_>) -> rusqlite::Result<NetWorthSnapshot> {
    Ok(NetWorthSnapshot {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        account_id: row.get("account_id")?,
        as_of_date: row.get("as_of_date")?,
        balance_minor: row.get("balance_minor")?,
        currency: row.get("currency")?,
        source: col_enum(row, "source")?,
        created_at: row.get("created_at")?,
    })
}

/// The only write this module offers. Insert-only by construction: the
/// schema refuses everything else.
pub fn insert(conn: &Connection, snapshot: &NetWorthSnapshot) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO networth_snapshots
             (id, book_id, account_id, as_of_date, balance_minor, currency, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            snapshot.id,
            snapshot.book_id,
            snapshot.account_id,
            snapshot.as_of_date,
            snapshot.balance_minor,
            snapshot.currency,
            snapshot.source.as_str(),
            snapshot.created_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<NetWorthSnapshot>> {
    Ok(conn
        .query_row(
            "SELECT * FROM networth_snapshots WHERE id = ?1",
            params![id],
            map_snapshot,
        )
        .optional()?)
}

/// The most recent snapshot (any source) already on record for this exact
/// `(account, date)` — the freshest by `created_at`, ties broken by `id`
/// (UUID v7, so time-ordered). Used by `networth_capture` to stay idempotent:
/// a date already covered is returned as-is rather than re-inserted.
pub fn get_for_account_date(
    conn: &Connection,
    account_id: &str,
    as_of_date: &str,
) -> CoreResult<Option<NetWorthSnapshot>> {
    Ok(conn
        .query_row(
            "SELECT * FROM networth_snapshots
             WHERE account_id = ?1 AND as_of_date = ?2
             ORDER BY created_at DESC, id DESC
             LIMIT 1",
            params![account_id, as_of_date],
            map_snapshot,
        )
        .optional()?)
}

/// Every `as_of_date` this account already has at least one snapshot for,
/// any source. `networth_backfill` skips dates in this set so a re-run only
/// ever fills gaps — it never duplicates a date already covered, captured or
/// backfilled.
pub fn dates_for_account(conn: &Connection, account_id: &str) -> CoreResult<HashSet<String>> {
    let mut stmt =
        conn.prepare("SELECT DISTINCT as_of_date FROM networth_snapshots WHERE account_id = ?1")?;
    let dates = stmt
        .query_map(params![account_id], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(dates)
}

/// One account's balance, in its own currency, computed from the ledger
/// rather than stored: opening balance plus every one of the account's own
/// transactions posted on or before `as_of_date`, excluding rejected ones and
/// any transaction in a different currency (the same two exclusions the
/// desktop's own current-balance calculation applies, and the same "sums
/// never mix currencies" rule every report in `repo::report` follows).
///
/// This is the read `networth_capture` snapshots at whatever date it is
/// called with, and it is also the read `networth_backfill`'s current-total
/// starting point comes from (`as_of_date` = today).
pub fn balance_as_of(
    conn: &Connection,
    account_id: &str,
    currency: &str,
    opening_balance_minor: i64,
    as_of_date: &str,
) -> CoreResult<i64> {
    let sum: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_minor), 0) FROM transactions
         WHERE account_id = ?1 AND currency = ?2 AND status <> 'rejected'
           AND posted_date <= ?3",
        params![account_id, currency, as_of_date],
        |row| row.get(0),
    )?;
    Ok(opening_balance_minor + sum)
}

/// One account's own-currency transaction activity, grouped and summed by
/// `posted_date`, oldest first — the day-by-day deltas `networth_backfill`
/// walks backward from the account's current total. Rejected transactions
/// and any transaction in a different currency are excluded, same as
/// [`balance_as_of`]. A day with no transactions produces no row: there is
/// nothing to walk back over for it.
pub fn own_currency_deltas_by_date(
    conn: &Connection,
    account_id: &str,
    currency: &str,
) -> CoreResult<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT posted_date, SUM(amount_minor) FROM transactions
         WHERE account_id = ?1 AND currency = ?2 AND status <> 'rejected'
         GROUP BY posted_date
         ORDER BY posted_date ASC",
    )?;
    let rows = stmt
        .query_map(params![account_id, currency], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// One row of a coalesced net-worth series: at `point_date`, `account_id`
/// held `balance_minor` of `currency` — the most recent snapshot at or
/// before that date (last-known-value carried forward).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesRow {
    pub point_date: String,
    pub account_id: String,
    pub currency: String,
    pub balance_minor: i64,
}

/// A book's net-worth series over `[from_date, to_date]`, flattened to one
/// row per `(point date, account)`.
///
/// A "point date" is any date in range that the book actually has *some*
/// snapshot on — the series does not synthesize a point at `from_date` or
/// `to_date` if nothing changed there; call `CoreService::networth_capture`
/// explicitly at a boundary date if a chart needs one. For every point date,
/// every account that has *any* snapshot at or before it contributes its
/// most recent one — an account snapshotted only before `from_date` still
/// carries its last known balance into every later point, exactly like an
/// account whose balance has not changed needs no new row to still count.
///
/// Implemented as one JOIN + window function rather than a correlated
/// subquery per candidate row: `ROW_NUMBER()` partitioned by
/// `(point_date, account_id)` and ordered by recency picks the single
/// freshest snapshot per partition, and the outer query keeps only rank 1.
pub fn series(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<Vec<SeriesRow>> {
    let mut stmt = conn.prepare(
        "WITH points AS (
             SELECT DISTINCT as_of_date FROM networth_snapshots
             WHERE book_id = ?1 AND as_of_date BETWEEN ?2 AND ?3
         ),
         ranked AS (
             SELECT p.as_of_date AS point_date, s.account_id, s.currency, s.balance_minor,
                    ROW_NUMBER() OVER (
                        PARTITION BY p.as_of_date, s.account_id
                        ORDER BY s.as_of_date DESC, s.created_at DESC, s.id DESC
                    ) AS rn
             FROM points p
             JOIN networth_snapshots s
               ON s.book_id = ?1 AND s.as_of_date <= p.as_of_date
         )
         SELECT point_date, account_id, currency, balance_minor
         FROM ranked
         WHERE rn = 1
         ORDER BY point_date, account_id",
    )?;
    let rows = stmt
        .query_map(params![book_id, from_date, to_date], |row| {
            Ok(SeriesRow {
                point_date: row.get("point_date")?,
                account_id: row.get("account_id")?,
                currency: row.get("currency")?,
                balance_minor: row.get("balance_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
