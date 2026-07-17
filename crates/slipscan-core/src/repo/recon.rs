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

/// Open (auto-matched or suggested, unconfirmed) matches, newest first.
pub fn list_open(conn: &Connection, book_id: &str) -> CoreResult<Vec<ReconMatch>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM recon_matches
         WHERE book_id = ?1 AND state IN ('auto', 'suggested')
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt
        .query_map(params![book_id], map_match)?
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
pub fn actively_matched_document_ids(conn: &Connection, book_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT document_id FROM recon_matches
         WHERE book_id = ?1 AND state <> 'rejected' AND document_id IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![book_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Journal ids in `book_id` that already have a non-rejected match.
pub fn actively_matched_journal_ids(conn: &Connection, book_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT journal_id FROM recon_matches
         WHERE book_id = ?1 AND state <> 'rejected' AND journal_id IS NOT NULL",
    )?;
    let ids = stmt
        .query_map(params![book_id], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// A candidate ledger entry for bank reconciliation: a manual journal's line
/// hitting an asset (bank-side) account. Carries the line's chart-of-accounts
/// id so the matcher can require the line to sit on the statement's *own*
/// bank account (not any asset account like VAT input or inventory).
#[derive(Debug, Clone)]
pub struct BankSideJournalLine {
    pub journal_id: String,
    pub coa_id: String,
    pub posted_date: String,
    pub narrative: Option<String>,
    pub debit_minor: i64,
    pub credit_minor: i64,
    pub currency: String,
}

/// Manual journals' lines on asset accounts — the ledger side of bank
/// reconciliation (statement line ↔ posted journal).
///
/// Excludes journals that *are* reversals and journals whose ledger effect is
/// currently *net-cancelled* by reversal: a reversed journal pair nets to
/// zero in the ledger, so matching a real bank movement against it would
/// leave the movement unexplained. Net-cancellation is parity over the
/// (linear — a journal can be reversed at most once) reversal chain: J
/// reversed → cancelled; that reversal itself reversed (the only undo path
/// under reversal-not-edit) → J is live again and must be matchable.
pub fn bank_side_journal_lines(
    conn: &Connection,
    book_id: &str,
) -> CoreResult<Vec<BankSideJournalLine>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE reversal_chain(root, id) AS (
             SELECT j2.id, j2.id FROM journals j2
              WHERE j2.book_id = ?1 AND j2.reversal_of IS NULL
             UNION ALL
             SELECT c.root, r.id FROM journals r
              JOIN reversal_chain c ON r.reversal_of = c.id
         ),
         net_cancelled(id) AS (
             SELECT root FROM reversal_chain
              GROUP BY root HAVING (COUNT(*) - 1) % 2 = 1
         )
         SELECT j.id AS journal_id, l.coa_id AS coa_id,
                j.posted_date AS posted_date,
                j.narrative AS narrative, l.debit_minor AS debit_minor,
                l.credit_minor AS credit_minor, l.currency AS currency
         FROM journals j
         JOIN journal_lines l ON l.journal_id = j.id
         JOIN chart_of_accounts a ON a.id = l.coa_id
         WHERE j.book_id = ?1 AND j.source_type = 'manual'
           AND j.reversal_of IS NULL AND a.kind = 'asset'
           AND j.id NOT IN (SELECT id FROM net_cancelled)",
    )?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(BankSideJournalLine {
                journal_id: row.get("journal_id")?,
                coa_id: row.get("coa_id")?,
                posted_date: row.get("posted_date")?,
                narrative: row.get("narrative")?,
                debit_minor: row.get("debit_minor")?,
                credit_minor: row.get("credit_minor")?,
                currency: row.get("currency")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// (transaction_id, document_id) pairs the user explicitly rejected — these
/// must never be re-suggested.
pub fn rejected_document_pairs(
    conn: &Connection,
    book_id: &str,
) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT transaction_id, document_id FROM recon_matches
         WHERE book_id = ?1 AND state = 'rejected' AND document_id IS NOT NULL",
    )?;
    let pairs = stmt
        .query_map(params![book_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(pairs)
}

/// (transaction_id, journal_id) pairs the user explicitly rejected — these
/// must never be re-suggested either.
pub fn rejected_journal_pairs(
    conn: &Connection,
    book_id: &str,
) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT transaction_id, journal_id FROM recon_matches
         WHERE book_id = ?1 AND state = 'rejected' AND journal_id IS NOT NULL",
    )?;
    let pairs = stmt
        .query_map(params![book_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(pairs)
}
