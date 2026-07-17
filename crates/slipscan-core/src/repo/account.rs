use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::Account;
use crate::error::CoreResult;

fn map_account(row: &Row<'_>) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        name: row.get("name")?,
        kind: col_enum(row, "kind")?,
        currency: row.get("currency")?,
        institution: row.get("institution")?,
        account_number_masked: row.get("account_number_masked")?,
        opening_balance_minor: row.get("opening_balance_minor")?,
        is_archived: row.get("is_archived")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, account: &Account) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO accounts (id, book_id, name, kind, currency, institution,
                               account_number_masked, opening_balance_minor,
                               is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            account.id,
            account.book_id,
            account.name,
            account.kind.as_str(),
            account.currency,
            account.institution,
            account.account_number_masked,
            account.opening_balance_minor,
            account.is_archived,
            account.created_at,
            account.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Account>> {
    Ok(conn
        .query_row(
            "SELECT * FROM accounts WHERE id = ?1",
            params![id],
            map_account,
        )
        .optional()?)
}

pub fn list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Account>> {
    let mut stmt =
        conn.prepare("SELECT * FROM accounts WHERE book_id = ?1 ORDER BY created_at, id")?;
    let accounts = stmt
        .query_map(params![book_id], map_account)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(accounts)
}

pub fn update(conn: &Connection, account: &Account) -> CoreResult<()> {
    conn.execute(
        "UPDATE accounts
         SET name = ?2, institution = ?3, account_number_masked = ?4,
             is_archived = ?5, updated_at = ?6
         WHERE id = ?1",
        params![
            account.id,
            account.name,
            account.institution,
            account.account_number_masked,
            account.is_archived,
            account.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])?;
    Ok(n > 0)
}
