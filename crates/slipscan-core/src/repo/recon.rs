use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{ReconMatch, ReconState};
use crate::error::CoreResult;

fn map_match(row: &Row<'_>) -> rusqlite::Result<ReconMatch> {
    Ok(ReconMatch {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        transaction_id: row.get("transaction_id")?,
        document_id: row.get("document_id")?,
        journal_id: row.get("journal_id")?,
        state: col_enum(row, "state")?,
        confidence: row.get("confidence")?,
        amount_delta_minor: row.get("amount_delta_minor")?,
        date_delta_days: row.get("date_delta_days")?,
        merchant_score: row.get("merchant_score")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, m: &ReconMatch) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO recon_matches (id, book_id, transaction_id, document_id, journal_id,
                                    state, confidence, amount_delta_minor, date_delta_days,
                                    merchant_score, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            m.id,
            m.book_id,
            m.transaction_id,
            m.document_id,
            m.journal_id,
            m.state.as_str(),
            m.confidence,
            m.amount_delta_minor,
            m.date_delta_days,
            m.merchant_score,
            m.created_at,
            m.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<ReconMatch>> {
    Ok(conn
        .query_row(
            "SELECT * FROM recon_matches WHERE id = ?1",
            params![id],
            map_match,
        )
        .optional()?)
}

pub fn list_by_state(
    conn: &Connection,
    book_id: &str,
    state: ReconState,
) -> CoreResult<Vec<ReconMatch>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM recon_matches WHERE book_id = ?1 AND state = ?2
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id, state.as_str()], map_match)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_state(
    conn: &Connection,
    id: &str,
    state: ReconState,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE recon_matches SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state.as_str(), updated_at],
    )?;
    Ok(())
}

/// Transaction ids in `book_id` that already have a non-rejected match.
pub fn actively_matched_transaction_ids(
    conn: &Connection,
    book_id: &str,
) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT transaction_id FROM recon_matches
         WHERE book_id = ?1 AND state <> 'rejected'",
    )?;
    let ids = stmt
        .query_map(params![book_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Document ids in `book_id` that already have a non-rejected match.
pub fn actively_matched_document_ids(
    conn: &Connection,
    book_id: &str,
) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT document_id FROM recon_matches
         WHERE book_id = ?1 AND state <> 'rejected' AND document_id IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![book_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// (transaction_id, document_id) pairs the user explicitly rejected — these
/// must never be re-suggested.
pub fn rejected_pairs(conn: &Connection, book_id: &str) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT transaction_id, document_id FROM recon_matches
         WHERE book_id = ?1 AND state = 'rejected' AND document_id IS NOT NULL",
    )?;
    let pairs = stmt
        .query_map(params![book_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(pairs)
}
