use rusqlite::types::ToSql;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{Transaction, TransactionFilter};
use crate::error::CoreResult;

fn map_transaction(row: &Row<'_>) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        account_id: row.get("account_id")?,
        category_id: row.get("category_id")?,
        document_id: row.get("document_id")?,
        source: col_enum(row, "source")?,
        provider_txn_id: row.get("provider_txn_id")?,
        dedupe_hash: row.get("dedupe_hash")?,
        posted_date: row.get("posted_date")?,
        amount_minor: row.get("amount_minor")?,
        currency: row.get("currency")?,
        merchant: row.get("merchant")?,
        merchant_normalized: row.get("merchant_normalized")?,
        description: row.get("description")?,
        notes: row.get("notes")?,
        status: col_enum(row, "status")?,
        attributed_member_id: row.get("attributed_member_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, txn: &Transaction) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO transactions (id, book_id, account_id, category_id, document_id,
                                   source, provider_txn_id, dedupe_hash, posted_date,
                                   amount_minor, currency, merchant, merchant_normalized,
                                   description, notes, status, attributed_member_id,
                                   created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 ?18, ?19)",
        params![
            txn.id,
            txn.book_id,
            txn.account_id,
            txn.category_id,
            txn.document_id,
            txn.source.as_str(),
            txn.provider_txn_id,
            txn.dedupe_hash,
            txn.posted_date,
            txn.amount_minor,
            txn.currency,
            txn.merchant,
            txn.merchant_normalized,
            txn.description,
            txn.notes,
            txn.status.as_str(),
            txn.attributed_member_id,
            txn.created_at,
            txn.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Transaction>> {
    Ok(conn
        .query_row(
            "SELECT * FROM transactions WHERE id = ?1",
            params![id],
            map_transaction,
        )
        .optional()?)
}

/// Existing transaction id for dedupe checks, by provider txn id.
pub fn find_by_provider_txn_id(
    conn: &Connection,
    account_id: &str,
    provider_txn_id: &str,
) -> CoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM transactions WHERE account_id = ?1 AND provider_txn_id = ?2",
            params![account_id, provider_txn_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Existing transaction id for dedupe checks, by content hash.
pub fn find_by_dedupe_hash(
    conn: &Connection,
    account_id: &str,
    dedupe_hash: &str,
) -> CoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM transactions WHERE account_id = ?1 AND dedupe_hash = ?2",
            params![account_id, dedupe_hash],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn list(
    conn: &Connection,
    book_id: &str,
    filter: &TransactionFilter,
) -> CoreResult<Vec<Transaction>> {
    let mut sql = String::from("SELECT * FROM transactions WHERE book_id = ?");
    let mut args: Vec<Box<dyn ToSql>> = vec![Box::new(book_id.to_string())];

    if let Some(account_id) = &filter.account_id {
        sql.push_str(" AND account_id = ?");
        args.push(Box::new(account_id.clone()));
    }
    if let Some(category_id) = &filter.category_id {
        sql.push_str(" AND category_id = ?");
        args.push(Box::new(category_id.clone()));
    }
    if let Some(status) = filter.status {
        sql.push_str(" AND status = ?");
        args.push(Box::new(status.as_str()));
    }
    if let Some(from) = &filter.from_date {
        sql.push_str(" AND posted_date >= ?");
        args.push(Box::new(from.clone()));
    }
    if let Some(to) = &filter.to_date {
        sql.push_str(" AND posted_date <= ?");
        args.push(Box::new(to.clone()));
    }
    sql.push_str(" ORDER BY posted_date DESC, id DESC");
    if let Some(limit) = filter.limit {
        sql.push_str(" LIMIT ?");
        args.push(Box::new(i64::from(limit)));
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(
            params_from_iter(args.iter().map(|a| a.as_ref())),
            map_transaction,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_category(
    conn: &Connection,
    id: &str,
    category_id: Option<&str>,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE transactions SET category_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, category_id, updated_at],
    )?;
    Ok(())
}

/// Set (or clear) who actually incurred this transaction. Metadata only —
/// never touches amount/currency/category, so it cannot affect the ledger.
pub fn set_attribution(
    conn: &Connection,
    id: &str,
    member_id: Option<&str>,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE transactions SET attributed_member_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, member_id, updated_at],
    )?;
    Ok(())
}
