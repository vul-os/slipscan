use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{Book, BookKind};
use crate::error::CoreResult;

fn map_book(row: &Row<'_>) -> rusqlite::Result<Book> {
    Ok(Book {
        id: row.get("id")?,
        kind: col_enum(row, "kind")?,
        name: row.get("name")?,
        currency: row.get("currency")?,
        country: row.get("country")?,
        region: row.get("region")?,
        locale: row.get("locale")?,
        timezone: row.get("timezone")?,
        financial_lock_date: row.get("financial_lock_date")?,
        multi_location_override: row
            .get::<_, Option<i64>>("multi_location_override")?
            .map(|v| v != 0),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, book: &Book) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO books (id, kind, name, currency, country, region, locale, timezone,
                            financial_lock_date, multi_location_override, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            book.id,
            book.kind.as_str(),
            book.name,
            book.currency,
            book.country,
            book.region,
            book.locale,
            book.timezone,
            book.financial_lock_date,
            book.multi_location_override.map(|b| b as i64),
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

/// Change a book's kind (Phase 6 decision #1: display, not schema — no row
/// in `locations`/`contacts`/`product_categories`/`products`/
/// `product_variants` is touched either direction).
pub fn set_kind(conn: &Connection, id: &str, kind: BookKind, updated_at: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE books SET kind = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, kind.as_str(), updated_at],
    )?;
    Ok(())
}

/// Pin (`Some`) or clear back to derived (`None`) the multi-location
/// override (Phase 6 decision #3).
pub fn set_multi_location_override(
    conn: &Connection,
    id: &str,
    over: Option<bool>,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE books SET multi_location_override = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, over.map(|b| b as i64), updated_at],
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
