use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::Book;
use crate::error::CoreResult;

fn map_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    Ok(Book {
        id: row.get("id")?,
        kind: col_enum(row, "kind")?,
        name: row.get("name")?,
        currency: row.get("currency")?,
        country: row.get("country")?,
        locale: row.get("locale")?,
        timezone: row.get("timezone")?,
        financial_lock_date: row.get("financial_lock_date")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, book: &Book) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO books (id, kind, name, currency, country, locale, timezone,
                            financial_lock_date, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            book.id,
            book.kind.as_str(),
            book.name,
            book.currency,
            book.country,
            book.locale,
            book.timezone,
            book.financial_lock_date,
            book.created_at,
            book.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Book>> {
    Ok(conn
        .query_row("SELECT * FROM books WHERE id = ?1", params![id], map_book)
        .optional()?)
}

/// Set (or clear) the financial lock date: journals may not be posted on or
/// before this date.
pub fn set_lock_date(
    conn: &Connection,
    id: &str,
    lock_date: Option<&str>,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE books SET financial_lock_date = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, lock_date, updated_at],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> CoreResult<Vec<Book>> {
    let mut stmt = conn.prepare("SELECT * FROM books ORDER BY created_at, id")?;
    let books = stmt
        .query_map([], map_book)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(books)
}
