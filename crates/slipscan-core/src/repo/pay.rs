//! ShapePay tables: watch codes, webhook endpoints, matches, delivery queue.
//!
//! Raw SQL only — validation, secret handling, matching, and dispatch live in
//! the service layer / `crate::pay`.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{PayDelivery, PayEndpoint, PayMatch, PayWatch};
use crate::error::CoreResult;

// ---------------------------------------------------------------------------
// Watch codes
// ---------------------------------------------------------------------------

fn map_watch(row: &Row<'_>) -> rusqlite::Result<PayWatch> {
    Ok(PayWatch {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        code: row.get("code")?,
        label: row.get("label")?,
        expected_amount_minor: row.get("expected_amount_minor")?,
        expected_currency: row.get("expected_currency")?,
        enabled: row.get("enabled")?,
        created_at: row.get("created_at")?,
    })
}

pub fn insert_watch(conn: &Connection, watch: &PayWatch) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO pay_watch_codes (id, book_id, code, label, expected_amount_minor,
                                      expected_currency, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            watch.id,
            watch.book_id,
            watch.code,
            watch.label,
            watch.expected_amount_minor,
            watch.expected_currency,
            watch.enabled,
            watch.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_watch(conn: &Connection, id: &str) -> CoreResult<Option<PayWatch>> {
    Ok(conn
        .query_row(
            "SELECT * FROM pay_watch_codes WHERE id = ?1",
            params![id],
            map_watch,
        )
        .optional()?)
}

pub fn list_watches(conn: &Connection, book_id: &str) -> CoreResult<Vec<PayWatch>> {
    let mut stmt =
        conn.prepare("SELECT * FROM pay_watch_codes WHERE book_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![book_id], map_watch)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_enabled_watches(conn: &Connection, book_id: &str) -> CoreResult<Vec<PayWatch>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM pay_watch_codes WHERE book_id = ?1 AND enabled = 1
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map(params![book_id], map_watch)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_watch(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM pay_watch_codes WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_watch_enabled(conn: &Connection, id: &str, enabled: bool) -> CoreResult<()> {
    conn.execute(
        "UPDATE pay_watch_codes SET enabled = ?2 WHERE id = ?1",
        params![id, enabled],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

fn map_endpoint(row: &Row<'_>) -> rusqlite::Result<PayEndpoint> {
    Ok(PayEndpoint {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        label: row.get("label")?,
        url: row.get("url")?,
        enabled: row.get("enabled")?,
        created_at: row.get("created_at")?,
    })
}

pub fn insert_endpoint(conn: &Connection, endpoint: &PayEndpoint) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO pay_endpoints (id, book_id, label, url, enabled, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            endpoint.id,
            endpoint.book_id,
            endpoint.label,
            endpoint.url,
            endpoint.enabled,
            endpoint.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_endpoint(conn: &Connection, id: &str) -> CoreResult<Option<PayEndpoint>> {
    Ok(conn
        .query_row(
            "SELECT * FROM pay_endpoints WHERE id = ?1",
            params![id],
            map_endpoint,
        )
        .optional()?)
}

pub fn list_endpoints(conn: &Connection, book_id: &str) -> CoreResult<Vec<PayEndpoint>> {
    let mut stmt =
        conn.prepare("SELECT * FROM pay_endpoints WHERE book_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![book_id], map_endpoint)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_enabled_endpoints(conn: &Connection, book_id: &str) -> CoreResult<Vec<PayEndpoint>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM pay_endpoints WHERE book_id = ?1 AND enabled = 1
         ORDER BY created_at, id",
    )?;
    let rows = stmt
        .query_map(params![book_id], map_endpoint)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_endpoint(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM pay_endpoints WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_endpoint_enabled(conn: &Connection, id: &str, enabled: bool) -> CoreResult<()> {
    conn.execute(
        "UPDATE pay_endpoints SET enabled = ?2 WHERE id = ?1",
        params![id, enabled],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

fn map_match(row: &Row<'_>) -> rusqlite::Result<PayMatch> {
    Ok(PayMatch {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        watch_id: row.get("watch_id")?,
        transaction_id: row.get("transaction_id")?,
        matched_at: row.get("matched_at")?,
    })
}

pub fn insert_match(conn: &Connection, m: &PayMatch) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO pay_matches (id, book_id, watch_id, transaction_id, matched_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![m.id, m.book_id, m.watch_id, m.transaction_id, m.matched_at],
    )?;
    Ok(())
}

pub fn list_matches(conn: &Connection, book_id: &str) -> CoreResult<Vec<PayMatch>> {
    let mut stmt =
        conn.prepare("SELECT * FROM pay_matches WHERE book_id = ?1 ORDER BY matched_at, id")?;
    let rows = stmt
        .query_map(params![book_id], map_match)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Delivery queue
// ---------------------------------------------------------------------------

fn map_delivery(row: &Row<'_>) -> rusqlite::Result<PayDelivery> {
    Ok(PayDelivery {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        endpoint_id: row.get("endpoint_id")?,
        match_id: row.get("match_id")?,
        payload: row.get("payload")?,
        state: col_enum(row, "state")?,
        attempts: row.get("attempts")?,
        next_attempt_at: row.get("next_attempt_at")?,
        last_status: row.get("last_status")?,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert_delivery(conn: &Connection, d: &PayDelivery) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO pay_deliveries (id, book_id, endpoint_id, match_id, payload, state,
                                     attempts, next_attempt_at, last_status, last_error,
                                     created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            d.id,
            d.book_id,
            d.endpoint_id,
            d.match_id,
            d.payload,
            d.state.as_str(),
            d.attempts,
            d.next_attempt_at,
            d.last_status,
            d.last_error,
            d.created_at,
            d.updated_at,
        ],
    )?;
    Ok(())
}

pub fn list_deliveries(conn: &Connection, book_id: &str) -> CoreResult<Vec<PayDelivery>> {
    let mut stmt =
        conn.prepare("SELECT * FROM pay_deliveries WHERE book_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![book_id], map_delivery)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A due delivery joined with the endpoint it must POST to.
#[derive(Debug, Clone)]
pub struct DueDelivery {
    pub delivery: PayDelivery,
    pub endpoint_id: String,
    pub url: String,
}

/// Pending deliveries whose `next_attempt_at` has passed, for **enabled**
/// endpoints only — disabling an endpoint parks its queue without touching
/// the rows.
pub fn list_due(conn: &Connection, now: &str) -> CoreResult<Vec<DueDelivery>> {
    let mut stmt = conn.prepare(
        "SELECT d.*, e.url AS endpoint_url
         FROM pay_deliveries d
         JOIN pay_endpoints e ON e.id = d.endpoint_id
         WHERE d.state = 'pending' AND d.next_attempt_at <= ?1 AND e.enabled = 1
         ORDER BY d.next_attempt_at, d.id",
    )?;
    let rows = stmt
        .query_map(params![now], |row| {
            Ok(DueDelivery {
                delivery: map_delivery(row)?,
                endpoint_id: row.get("endpoint_id")?,
                url: row.get("endpoint_url")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Persist a delivery attempt's outcome (state, attempts, scheduling, and
/// the last status/error observed).
pub fn update_delivery_outcome(conn: &Connection, d: &PayDelivery) -> CoreResult<()> {
    conn.execute(
        "UPDATE pay_deliveries
         SET state = ?2, attempts = ?3, next_attempt_at = ?4, last_status = ?5,
             last_error = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            d.id,
            d.state.as_str(),
            d.attempts,
            d.next_attempt_at,
            d.last_status,
            d.last_error,
            d.updated_at,
        ],
    )?;
    Ok(())
}
