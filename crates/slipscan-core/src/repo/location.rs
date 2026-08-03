//! Locations: branches, sites and warehouses (Phase 6.1 — the FlowStock fold,
//! foundation).
//!
//! Raw SQL only — validation and audit live in the service layer. There is no
//! reassign-or-refuse guard here the way `repo::member` has one: no inventory
//! table references a location yet, so removal is a plain delete.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::Location;
use crate::error::CoreResult;

fn map_location(row: &Row<'_>) -> rusqlite::Result<Location> {
    Ok(Location {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        name: row.get("name")?,
        kind: col_enum(row, "kind")?,
        code: row.get("code")?,
        address: row.get("address")?,
        is_archived: row.get("is_archived")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, location: &Location) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO locations (id, book_id, name, kind, code, address,
                                is_archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            location.id,
            location.book_id,
            location.name,
            location.kind.as_str(),
            location.code,
            location.address,
            location.is_archived,
            location.created_at,
            location.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Location>> {
    Ok(conn
        .query_row(
            "SELECT * FROM locations WHERE id = ?1",
            params![id],
            map_location,
        )
        .optional()?)
}

/// Every location row for the book, archived included — the input Phase
/// 6.0's multi-location derivation (`crate::profile::resolve`) counts.
/// Deliberately not archived-filtered: a business that archives its second
/// branch has still run two locations, and `multi_location_override` exists
/// precisely for a business that disagrees with what the count implies.
pub fn count(conn: &Connection, book_id: &str) -> CoreResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM locations WHERE book_id = ?1",
        params![book_id],
        |row| row.get(0),
    )?)
}

pub fn list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Location>> {
    let mut stmt =
        conn.prepare("SELECT * FROM locations WHERE book_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![book_id], map_location)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn update(conn: &Connection, location: &Location) -> CoreResult<()> {
    conn.execute(
        "UPDATE locations
         SET name = ?2, kind = ?3, code = ?4, address = ?5, is_archived = ?6,
             updated_at = ?7
         WHERE id = ?1",
        params![
            location.id,
            location.name,
            location.kind.as_str(),
            location.code,
            location.address,
            location.is_archived,
            location.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM locations WHERE id = ?1", params![id])?;
    Ok(n > 0)
}
