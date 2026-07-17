use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{Budget, BudgetStatus};
use crate::error::CoreResult;
use crate::util::{new_id, now_iso};

fn map_budget(row: &Row<'_>) -> rusqlite::Result<Budget> {
    Ok(Budget {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        category_id: row.get("category_id")?,
        month: row.get("month")?,
        amount_minor: row.get("amount_minor")?,
        currency: row.get("currency")?,
        rollover: row.get("rollover")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert(
    conn: &Connection,
    book_id: &str,
    category_id: &str,
    month: &str,
    amount_minor: i64,
    currency: &str,
    rollover: bool,
) -> CoreResult<Budget> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO budgets (id, book_id, category_id, month, amount_minor,
                              currency, rollover, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT (book_id, category_id, month) DO UPDATE SET
             amount_minor = excluded.amount_minor,
             currency = excluded.currency,
             rollover = excluded.rollover,
             updated_at = excluded.updated_at",
        params![
            new_id(),
            book_id,
            category_id,
            month,
            amount_minor,
            currency,
            rollover,
            now,
        ],
    )?;
    let budget = conn.query_row(
        "SELECT * FROM budgets WHERE book_id = ?1 AND category_id = ?2 AND month = ?3",
        params![book_id, category_id, month],
        map_budget,
    )?;
    Ok(budget)
}

pub fn get(
    conn: &Connection,
    book_id: &str,
    category_id: &str,
    month: &str,
) -> CoreResult<Option<Budget>> {
    Ok(conn
        .query_row(
            "SELECT * FROM budgets WHERE book_id = ?1 AND category_id = ?2 AND month = ?3",
            params![book_id, category_id, month],
            map_budget,
        )
        .optional()?)
}

pub fn list(conn: &Connection, book_id: &str, month: &str) -> CoreResult<Vec<Budget>> {
    let mut stmt =
        conn.prepare("SELECT * FROM budgets WHERE book_id = ?1 AND month = ?2 ORDER BY id")?;
    let budgets = stmt
        .query_map(params![book_id, month], map_budget)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(budgets)
}

/// Budget vs. actual spend for every budgeted category in `month`.
/// Spend counts negative (outflow) transaction amounts against the category.
pub fn status(conn: &Connection, book_id: &str, month: &str) -> CoreResult<Vec<BudgetStatus>> {
    let mut stmt = conn.prepare(
        "SELECT b.category_id, b.month, b.amount_minor, b.currency,
                COALESCE((
                    SELECT -SUM(t.amount_minor) FROM transactions t
                    WHERE t.book_id = b.book_id
                      AND t.category_id = b.category_id
                      AND t.amount_minor < 0
                      AND substr(t.posted_date, 1, 7) = b.month
                      AND t.status <> 'rejected'
                ), 0) AS spent_minor
         FROM budgets b
         WHERE b.book_id = ?1 AND b.month = ?2
         ORDER BY b.category_id",
    )?;
    let rows = stmt
        .query_map(params![book_id, month], |row| {
            let budget_minor: i64 = row.get("amount_minor")?;
            let spent_minor: i64 = row.get("spent_minor")?;
            Ok(BudgetStatus {
                category_id: row.get("category_id")?,
                month: row.get("month")?,
                budget_minor,
                spent_minor,
                remaining_minor: budget_minor - spent_minor,
                currency: row.get("currency")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
