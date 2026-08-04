//! Read-only queries backing `CoreService::close_period_check` /
//! `close_period`. Every function here is a plain aggregate — no
//! validation, no mutation; the service layer decides what a count means
//! for closeability.

use rusqlite::{params, Connection};

use crate::domain::ClosePeriodCurrencyBalance;
use crate::error::CoreResult;

/// Per-currency debit/credit totals over every journal line posted on or
/// before `as_of` (inclusive) — the close's own balance check. Joins
/// through `journals` for `posted_date` because `journal_lines` does not
/// carry its own date; every line of one journal shares its parent's date,
/// so this never splits a journal's own balanced pair across the boundary.
pub fn balance_as_of(
    conn: &Connection,
    book_id: &str,
    as_of: &str,
) -> CoreResult<Vec<ClosePeriodCurrencyBalance>> {
    let mut stmt = conn.prepare(
        "SELECT l.currency AS currency,
                COALESCE(SUM(l.debit_minor), 0) AS debit_minor,
                COALESCE(SUM(l.credit_minor), 0) AS credit_minor
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         WHERE l.book_id = ?1 AND j.posted_date <= ?2
         GROUP BY l.currency
         ORDER BY l.currency",
    )?;
    let rows = stmt
        .query_map(params![book_id, as_of], |row| {
            Ok(ClosePeriodCurrencyBalance {
                currency: row.get("currency")?,
                debit_minor: row.get("debit_minor")?,
                credit_minor: row.get("credit_minor")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Uncategorised (non-rejected) transactions posted within an inclusive
/// date range.
pub fn uncategorised_count(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM transactions
         WHERE book_id = ?1 AND category_id IS NULL AND status <> 'rejected'
           AND posted_date >= ?2 AND posted_date <= ?3",
        params![book_id, from_date, to_date],
        |row| row.get(0),
    )?)
}

/// Transactions posted within an inclusive date range with no `auto`- or
/// human-confirmed reconciliation match. A `suggested` match (or a
/// `rejected` one — the specific pairing was declined, not the need to
/// reconcile) still counts as needing a look.
pub fn unreconciled_count(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM transactions t
         WHERE t.book_id = ?1 AND t.status <> 'rejected'
           AND t.posted_date >= ?2 AND t.posted_date <= ?3
           AND NOT EXISTS (
             SELECT 1 FROM recon_matches m
             WHERE m.transaction_id = t.id AND m.state IN ('auto', 'confirmed')
           )",
        params![book_id, from_date, to_date],
        |row| row.get(0),
    )?)
}

/// Draft sales orders dated within an inclusive range.
pub fn draft_sales_order_count(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM sales_orders
         WHERE book_id = ?1 AND status = 'draft'
           AND order_date >= ?2 AND order_date <= ?3",
        params![book_id, from_date, to_date],
        |row| row.get(0),
    )?)
}

/// Invoices due within an inclusive range with zero payments recorded
/// against them — "nothing posted against them", read literally.
pub fn unpaid_invoice_due_count(
    conn: &Connection,
    book_id: &str,
    from_date: &str,
    to_date: &str,
) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM invoices i
         WHERE i.book_id = ?1 AND i.due_date >= ?2 AND i.due_date <= ?3
           AND NOT EXISTS (
             SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id
           )",
        params![book_id, from_date, to_date],
        |row| row.get(0),
    )?)
}
