//! Recurring schedules (migration 0017, PARITY.md "Repeating invoices /
//! recurring transactions").
//!
//! Raw SQL only — validation, the recurrence arithmetic and the actual
//! invoice/transaction generation live in the service layer, same as every
//! other module here. `recurring_schedule*`/`recurring_schedule_item*`
//! functions read/write/UPDATE freely (an editable template); `run_*`
//! functions only ever INSERT (an immutable fact) — there is no `run_update`
//! or `run_delete` here for the identical reason `repo::sales` has no
//! `invoice_update`: the schema's own triggers would refuse it.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{RecurringRun, RecurringSchedule, RecurringScheduleItem};
use crate::error::CoreResult;

use super::col_enum;

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

fn map_schedule(row: &Row<'_>) -> rusqlite::Result<RecurringSchedule> {
    Ok(RecurringSchedule {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        kind: col_enum(row, "kind")?,
        status: col_enum(row, "status")?,
        name: row.get("name")?,
        frequency: col_enum(row, "frequency")?,
        interval_count: row.get("interval_count")?,
        start_date: row.get("start_date")?,
        end_date: row.get("end_date")?,
        max_occurrences: row.get("max_occurrences")?,
        occurrences_processed: row.get("occurrences_processed")?,
        next_run_date: row.get("next_run_date")?,
        contact_id: row.get("contact_id")?,
        series: row.get("series")?,
        due_days: row.get("due_days")?,
        account_id: row.get("account_id")?,
        category_id: row.get("category_id")?,
        amount_minor: row.get("amount_minor")?,
        merchant: row.get("merchant")?,
        description: row.get("description")?,
        currency: row.get("currency")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn schedule_insert(conn: &Connection, s: &RecurringSchedule) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO recurring_schedules
             (id, book_id, kind, status, name, frequency, interval_count, start_date,
              end_date, max_occurrences, occurrences_processed, next_run_date,
              contact_id, series, due_days, account_id, category_id, amount_minor,
              merchant, description, currency, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                 ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        params![
            s.id,
            s.book_id,
            s.kind.as_str(),
            s.status.as_str(),
            s.name,
            s.frequency.as_str(),
            s.interval_count,
            s.start_date,
            s.end_date,
            s.max_occurrences,
            s.occurrences_processed,
            s.next_run_date,
            s.contact_id,
            s.series,
            s.due_days,
            s.account_id,
            s.category_id,
            s.amount_minor,
            s.merchant,
            s.description,
            s.currency,
            s.notes,
            s.created_at,
            s.updated_at,
        ],
    )?;
    Ok(())
}

pub fn schedule_get(conn: &Connection, id: &str) -> CoreResult<Option<RecurringSchedule>> {
    Ok(conn
        .query_row(
            "SELECT * FROM recurring_schedules WHERE id = ?1",
            params![id],
            map_schedule,
        )
        .optional()?)
}

/// Every schedule in the book, most recently created first.
pub fn schedule_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<RecurringSchedule>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM recurring_schedules WHERE book_id = ?1 ORDER BY created_at DESC, id",
    )?;
    let rows = stmt
        .query_map(params![book_id], map_schedule)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every `active` schedule whose `next_run_date` has arrived (`<= as_of`),
/// earliest-due first. Backs `recurring_due_list`/`recurring_run_due`.
pub fn schedule_list_due(
    conn: &Connection,
    book_id: &str,
    as_of: &str,
) -> CoreResult<Vec<RecurringSchedule>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM recurring_schedules
         WHERE book_id = ?1 AND status = 'active' AND next_run_date <= ?2
         ORDER BY next_run_date, id",
    )?;
    let rows = stmt
        .query_map(params![book_id, as_of], map_schedule)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Full-row update. Covers a template edit, a pause/resume status flip, and
/// `recurring_process_occurrence` advancing `occurrences_processed`/
/// `next_run_date`/`status` — the service layer decides which fields
/// actually changed and hands back the whole row either way, the same
/// pattern `repo::sales::order_update` uses.
pub fn schedule_update(conn: &Connection, s: &RecurringSchedule) -> CoreResult<()> {
    conn.execute(
        "UPDATE recurring_schedules
         SET status = ?2, name = ?3, end_date = ?4, max_occurrences = ?5,
             occurrences_processed = ?6, next_run_date = ?7, contact_id = ?8,
             series = ?9, due_days = ?10, account_id = ?11, category_id = ?12,
             amount_minor = ?13, merchant = ?14, description = ?15, currency = ?16,
             notes = ?17, updated_at = ?18
         WHERE id = ?1",
        params![
            s.id,
            s.status.as_str(),
            s.name,
            s.end_date,
            s.max_occurrences,
            s.occurrences_processed,
            s.next_run_date,
            s.contact_id,
            s.series,
            s.due_days,
            s.account_id,
            s.category_id,
            s.amount_minor,
            s.merchant,
            s.description,
            s.currency,
            s.notes,
            s.updated_at,
        ],
    )?;
    Ok(())
}

/// Hard delete. The service layer only ever calls this on a schedule that
/// has never run — nothing here re-checks that, the same trust boundary
/// `repo::sales::order_delete` places on its caller.
pub fn schedule_delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM recurring_schedules WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

// ---------------------------------------------------------------------------
// Schedule items (Invoice-kind template lines)
// ---------------------------------------------------------------------------

fn map_item(row: &Row<'_>) -> rusqlite::Result<RecurringScheduleItem> {
    Ok(RecurringScheduleItem {
        id: row.get("id")?,
        schedule_id: row.get("schedule_id")?,
        book_id: row.get("book_id")?,
        variant_id: row.get("variant_id")?,
        description: row.get("description")?,
        quantity: row.get("quantity")?,
        unit_price_minor: row.get("unit_price_minor")?,
        tax_rate_bps: row.get("tax_rate_bps")?,
        line_order: row.get("line_order")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn item_insert(conn: &Connection, item: &RecurringScheduleItem) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO recurring_schedule_items
             (id, schedule_id, book_id, variant_id, description, quantity,
              unit_price_minor, tax_rate_bps, line_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            item.id,
            item.schedule_id,
            item.book_id,
            item.variant_id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.line_order,
            item.created_at,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn item_get(conn: &Connection, id: &str) -> CoreResult<Option<RecurringScheduleItem>> {
    Ok(conn
        .query_row(
            "SELECT * FROM recurring_schedule_items WHERE id = ?1",
            params![id],
            map_item,
        )
        .optional()?)
}

/// Every line on a schedule, in the order they were added.
pub fn item_list(conn: &Connection, schedule_id: &str) -> CoreResult<Vec<RecurringScheduleItem>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM recurring_schedule_items WHERE schedule_id = ?1
         ORDER BY line_order, created_at, id",
    )?;
    let rows = stmt
        .query_map(params![schedule_id], map_item)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn item_update(conn: &Connection, item: &RecurringScheduleItem) -> CoreResult<()> {
    conn.execute(
        "UPDATE recurring_schedule_items
         SET description = ?2, quantity = ?3, unit_price_minor = ?4,
             tax_rate_bps = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            item.id,
            item.description,
            item.quantity,
            item.unit_price_minor,
            item.tax_rate_bps,
            item.updated_at,
        ],
    )?;
    Ok(())
}

pub fn item_delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute(
        "DELETE FROM recurring_schedule_items WHERE id = ?1",
        params![id],
    )?;
    Ok(n > 0)
}

// ---------------------------------------------------------------------------
// Runs — insert-only. See this module's own header and the migration's.
// ---------------------------------------------------------------------------

fn map_run(row: &Row<'_>) -> rusqlite::Result<RecurringRun> {
    Ok(RecurringRun {
        id: row.get("id")?,
        schedule_id: row.get("schedule_id")?,
        book_id: row.get("book_id")?,
        occurrence_index: row.get("occurrence_index")?,
        occurrence_date: row.get("occurrence_date")?,
        outcome: col_enum(row, "outcome")?,
        generated_table: row.get("generated_table")?,
        generated_id: row.get("generated_id")?,
        created_at: row.get("created_at")?,
    })
}

pub fn run_insert(conn: &Connection, run: &RecurringRun) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO recurring_runs
             (id, schedule_id, book_id, occurrence_index, occurrence_date, outcome,
              generated_table, generated_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            run.id,
            run.schedule_id,
            run.book_id,
            run.occurrence_index,
            run.occurrence_date,
            run.outcome.as_str(),
            run.generated_table,
            run.generated_id,
            run.created_at,
        ],
    )?;
    Ok(())
}

/// Whether `schedule_id` already has a run recorded for `occurrence_index` —
/// the read-side half of the belt-and-suspenders idempotency check; `UNIQUE
/// (schedule_id, occurrence_index)` is the half that still holds even if a
/// caller skipped this check.
pub fn run_exists(conn: &Connection, schedule_id: &str, occurrence_index: i64) -> CoreResult<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM recurring_runs WHERE schedule_id = ?1 AND occurrence_index = ?2)",
        params![schedule_id, occurrence_index],
        |row| row.get(0),
    )?;
    Ok(exists)
}

/// Every run recorded against a schedule, earliest occurrence first.
pub fn run_list(conn: &Connection, schedule_id: &str) -> CoreResult<Vec<RecurringRun>> {
    let mut stmt = conn
        .prepare("SELECT * FROM recurring_runs WHERE schedule_id = ?1 ORDER BY occurrence_index")?;
    let rows = stmt
        .query_map(params![schedule_id], map_run)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
