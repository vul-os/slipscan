use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{Category, ClassificationCorrection, MappingSource, MerchantMapping};
use crate::error::CoreResult;
use crate::util::{new_id, now_iso};

fn map_category(row: &Row<'_>) -> rusqlite::Result<Category> {
    Ok(Category {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        parent_id: row.get("parent_id")?,
        name: row.get("name")?,
        kind: col_enum(row, "kind")?,
        icon: row.get("icon")?,
        color: row.get("color")?,
        is_system: row.get("is_system")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, category: &Category) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO categories (id, book_id, parent_id, name, kind, icon, color,
                                 is_system, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            category.id,
            category.book_id,
            category.parent_id,
            category.name,
            category.kind.as_str(),
            category.icon,
            category.color,
            category.is_system,
            category.created_at,
            category.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Category>> {
    Ok(conn
        .query_row(
            "SELECT * FROM categories WHERE id = ?1",
            params![id],
            map_category,
        )
        .optional()?)
}

pub fn list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT * FROM categories WHERE book_id = ?1 ORDER BY name, id")?;
    let categories = stmt
        .query_map(params![book_id], map_category)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(categories)
}

fn map_mapping(row: &Row<'_>) -> rusqlite::Result<MerchantMapping> {
    Ok(MerchantMapping {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        merchant_normalized: row.get("merchant_normalized")?,
        category_id: row.get("category_id")?,
        source: col_enum(row, "source")?,
        confidence: row.get("confidence")?,
        applied_count: row.get("applied_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn get_mapping(
    conn: &Connection,
    book_id: &str,
    merchant_normalized: &str,
) -> CoreResult<Option<MerchantMapping>> {
    Ok(conn
        .query_row(
            "SELECT * FROM merchant_mappings
             WHERE book_id = ?1 AND merchant_normalized = ?2",
            params![book_id, merchant_normalized],
            map_mapping,
        )
        .optional()?)
}

/// Insert or replace the mapping for a merchant, bumping `applied_count`.
pub fn upsert_mapping(
    conn: &Connection,
    book_id: &str,
    merchant_normalized: &str,
    category_id: &str,
    source: MappingSource,
    confidence: f64,
) -> CoreResult<()> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO merchant_mappings
             (id, book_id, merchant_normalized, category_id, source, confidence,
              applied_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
         ON CONFLICT (book_id, merchant_normalized) DO UPDATE SET
             category_id = excluded.category_id,
             source = excluded.source,
             confidence = excluded.confidence,
             applied_count = merchant_mappings.applied_count + 1,
             updated_at = excluded.updated_at",
        params![
            new_id(),
            book_id,
            merchant_normalized,
            category_id,
            source.as_str(),
            confidence,
            now,
        ],
    )?;
    Ok(())
}

pub fn insert_correction(
    conn: &Connection,
    correction: &ClassificationCorrection,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO classification_corrections
             (id, book_id, transaction_id, merchant_normalized,
              old_category_id, new_category_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            correction.id,
            correction.book_id,
            correction.transaction_id,
            correction.merchant_normalized,
            correction.old_category_id,
            correction.new_category_id,
            correction.created_at,
        ],
    )?;
    Ok(())
}

pub fn list_corrections(
    conn: &Connection,
    book_id: &str,
) -> CoreResult<Vec<ClassificationCorrection>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM classification_corrections
         WHERE book_id = ?1 ORDER BY created_at DESC, id DESC",
    )?;
    let corrections = stmt
        .query_map(params![book_id], |row| {
            Ok(ClassificationCorrection {
                id: row.get("id")?,
                book_id: row.get("book_id")?,
                transaction_id: row.get("transaction_id")?,
                merchant_normalized: row.get("merchant_normalized")?,
                old_category_id: row.get("old_category_id")?,
                new_category_id: row.get("new_category_id")?,
                created_at: row.get("created_at")?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(corrections)
}
