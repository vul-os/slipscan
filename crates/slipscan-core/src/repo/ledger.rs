use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{CoaAccount, CoaMapEntity, CoaMapEntry, Journal, JournalLine, VatRate};
use crate::error::CoreResult;

fn map_coa(row: &Row<'_>) -> rusqlite::Result<CoaAccount> {
    Ok(CoaAccount {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        code: row.get("code")?,
        name: row.get("name")?,
        kind: col_enum(row, "kind")?,
        description: row.get("description")?,
        is_archived: row.get("is_archived")?,
        is_system: row.get("is_system")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_journal(row: &Row<'_>) -> rusqlite::Result<Journal> {
    Ok(Journal {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        posted_date: row.get("posted_date")?,
        narrative: row.get("narrative")?,
        reference: row.get("reference")?,
        source_type: col_enum(row, "source_type")?,
        source_id: row.get("source_id")?,
        created_at: row.get("created_at")?,
    })
}

fn map_line(row: &Row<'_>) -> rusqlite::Result<JournalLine> {
    let vat_role: Option<String> = row.get("vat_role")?;
    let vat_role = match vat_role {
        None => None,
        Some(raw) => Some(raw.parse().map_err(|e: crate::error::CoreError| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?),
    };
    Ok(JournalLine {
        id: row.get("id")?,
        journal_id: row.get("journal_id")?,
        book_id: row.get("book_id")?,
        coa_id: row.get("coa_id")?,
        debit_minor: row.get("debit_minor")?,
        credit_minor: row.get("credit_minor")?,
        currency: row.get("currency")?,
        description: row.get("description")?,
        line_order: row.get("line_order")?,
        vat_rate_id: row.get("vat_rate_id")?,
        vat_role,
        created_at: row.get("created_at")?,
    })
}

pub fn insert_coa(conn: &Connection, coa: &CoaAccount) -> CoreResult<bool> {
    let n = conn.execute(
        "INSERT INTO chart_of_accounts (id, book_id, code, name, kind, description,
                                        is_archived, is_system, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (book_id, code) DO NOTHING",
        params![
            coa.id,
            coa.book_id,
            coa.code,
            coa.name,
            coa.kind.as_str(),
            coa.description,
            coa.is_archived,
            coa.is_system,
            coa.created_at,
            coa.updated_at,
        ],
    )?;
    Ok(n > 0)
}

pub fn get_coa(conn: &Connection, id: &str) -> CoreResult<Option<CoaAccount>> {
    Ok(conn
        .query_row(
            "SELECT * FROM chart_of_accounts WHERE id = ?1",
            params![id],
            map_coa,
        )
        .optional()?)
}

pub fn list_coa(conn: &Connection, book_id: &str) -> CoreResult<Vec<CoaAccount>> {
    let mut stmt =
        conn.prepare("SELECT * FROM chart_of_accounts WHERE book_id = ?1 ORDER BY code")?;
    let rows = stmt
        .query_map(params![book_id], map_coa)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn insert_journal(conn: &Connection, journal: &Journal) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO journals (id, book_id, posted_date, narrative, reference,
                               source_type, source_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            journal.id,
            journal.book_id,
            journal.posted_date,
            journal.narrative,
            journal.reference,
            journal.source_type.as_str(),
            journal.source_id,
            journal.created_at,
        ],
    )?;
    Ok(())
}

pub fn get_journal(conn: &Connection, id: &str) -> CoreResult<Option<Journal>> {
    Ok(conn
        .query_row(
            "SELECT * FROM journals WHERE id = ?1",
            params![id],
            map_journal,
        )
        .optional()?)
}

pub fn insert_line(conn: &Connection, line: &JournalLine) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO journal_lines (id, journal_id, book_id, coa_id, debit_minor,
                                    credit_minor, currency, description, line_order,
                                    vat_rate_id, vat_role, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            line.id,
            line.journal_id,
            line.book_id,
            line.coa_id,
            line.debit_minor,
            line.credit_minor,
            line.currency,
            line.description,
            line.line_order,
            line.vat_rate_id,
            line.vat_role.map(|r| r.as_str()),
            line.created_at,
        ],
    )?;
    Ok(())
}

/// Journal id previously generated from a given source, if any.
pub fn find_journal_by_source(
    conn: &Connection,
    book_id: &str,
    source_type: &str,
    source_id: &str,
) -> CoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM journals
             WHERE book_id = ?1 AND source_type = ?2 AND source_id = ?3",
            params![book_id, source_type, source_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn get_coa_by_code(
    conn: &Connection,
    book_id: &str,
    code: &str,
) -> CoreResult<Option<CoaAccount>> {
    Ok(conn
        .query_row(
            "SELECT * FROM chart_of_accounts WHERE book_id = ?1 AND code = ?2",
            params![book_id, code],
            map_coa,
        )
        .optional()?)
}

pub fn lines_for_journal(conn: &Connection, journal_id: &str) -> CoreResult<Vec<JournalLine>> {
    let mut stmt =
        conn.prepare("SELECT * FROM journal_lines WHERE journal_id = ?1 ORDER BY line_order")?;
    let rows = stmt
        .query_map(params![journal_id], map_line)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_coa_map(row: &Row<'_>) -> rusqlite::Result<CoaMapEntry> {
    Ok(CoaMapEntry {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        entity_type: col_enum(row, "entity_type")?,
        entity_id: row.get("entity_id")?,
        coa_id: row.get("coa_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Insert or replace the CoA mapping for an entity, returning the stored row.
pub fn upsert_coa_map(
    conn: &Connection,
    entry: &CoaMapEntry,
) -> CoreResult<CoaMapEntry> {
    conn.execute(
        "INSERT INTO coa_map (id, book_id, entity_type, entity_id, coa_id,
                              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (book_id, entity_type, entity_id)
         DO UPDATE SET coa_id = excluded.coa_id, updated_at = excluded.updated_at",
        params![
            entry.id,
            entry.book_id,
            entry.entity_type.as_str(),
            entry.entity_id,
            entry.coa_id,
            entry.created_at,
            entry.updated_at,
        ],
    )?;
    Ok(conn.query_row(
        "SELECT * FROM coa_map WHERE book_id = ?1 AND entity_type = ?2 AND entity_id = ?3",
        params![entry.book_id, entry.entity_type.as_str(), entry.entity_id],
        map_coa_map,
    )?)
}

pub fn get_coa_map(
    conn: &Connection,
    book_id: &str,
    entity_type: CoaMapEntity,
    entity_id: &str,
) -> CoreResult<Option<CoaMapEntry>> {
    Ok(conn
        .query_row(
            "SELECT * FROM coa_map WHERE book_id = ?1 AND entity_type = ?2 AND entity_id = ?3",
            params![book_id, entity_type.as_str(), entity_id],
            map_coa_map,
        )
        .optional()?)
}

pub fn list_coa_map(conn: &Connection, book_id: &str) -> CoreResult<Vec<CoaMapEntry>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM coa_map WHERE book_id = ?1 ORDER BY entity_type, entity_id",
    )?;
    let rows = stmt
        .query_map(params![book_id], map_coa_map)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn insert_vat_rate(conn: &Connection, rate: &VatRate) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO vat_rates (id, book_id, code, name, rate_bps, country,
                                is_active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (book_id, code) DO NOTHING",
        params![
            rate.id,
            rate.book_id,
            rate.code,
            rate.name,
            rate.rate_bps,
            rate.country,
            rate.is_active,
            rate.created_at,
            rate.updated_at,
        ],
    )?;
    Ok(())
}

pub fn list_vat_rates(conn: &Connection, book_id: &str) -> CoreResult<Vec<VatRate>> {
    let mut stmt = conn.prepare("SELECT * FROM vat_rates WHERE book_id = ?1 ORDER BY code")?;
    let rows = stmt
        .query_map(params![book_id], |row| {
            Ok(VatRate {
                id: row.get("id")?,
                book_id: row.get("book_id")?,
                code: row.get("code")?,
                name: row.get("name")?,
                rate_bps: row.get("rate_bps")?,
                country: row.get("country")?,
                is_active: row.get("is_active")?,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
