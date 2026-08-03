//! Product catalogue: categories, products, variants (migration 0820).
//!
//! Raw SQL only — validation (book/category scoping, currency
//! normalization, attribute-JSON shape) lives in the service layer, same as
//! every other module here.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::domain::{Product, ProductCategory, ProductVariant};
use crate::error::CoreResult;

fn map_category(row: &Row<'_>) -> rusqlite::Result<ProductCategory> {
    Ok(ProductCategory {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        name: row.get("name")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_product(row: &Row<'_>) -> rusqlite::Result<Product> {
    Ok(Product {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        product_category_id: row.get("product_category_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_variant(row: &Row<'_>) -> rusqlite::Result<ProductVariant> {
    Ok(ProductVariant {
        id: row.get("id")?,
        product_id: row.get("product_id")?,
        book_id: row.get("book_id")?,
        sku: row.get("sku")?,
        name: row.get("name")?,
        price_minor: row.get("price_minor")?,
        cost_price_minor: row.get("cost_price_minor")?,
        currency: row.get("currency")?,
        reorder_point: row.get("reorder_point")?,
        attributes: row.get("attributes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ---------------------------------------------------------------------------
// Product categories
// ---------------------------------------------------------------------------

pub fn category_insert(conn: &Connection, category: &ProductCategory) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO product_categories (id, book_id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            category.id,
            category.book_id,
            category.name,
            category.created_at,
            category.updated_at,
        ],
    )?;
    Ok(())
}

pub fn category_get(conn: &Connection, id: &str) -> CoreResult<Option<ProductCategory>> {
    Ok(conn
        .query_row(
            "SELECT * FROM product_categories WHERE id = ?1",
            params![id],
            map_category,
        )
        .optional()?)
}

pub fn category_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<ProductCategory>> {
    let mut stmt =
        conn.prepare("SELECT * FROM product_categories WHERE book_id = ?1 ORDER BY name, id")?;
    let rows = stmt
        .query_map(params![book_id], map_category)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn category_update(conn: &Connection, category: &ProductCategory) -> CoreResult<()> {
    conn.execute(
        "UPDATE product_categories SET name = ?2, updated_at = ?3 WHERE id = ?1",
        params![category.id, category.name, category.updated_at],
    )?;
    Ok(())
}

/// Hard delete. `products.product_category_id` is `ON DELETE SET NULL`, so
/// products in this category are detached, not removed.
pub fn category_delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM product_categories WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

pub fn product_insert(conn: &Connection, product: &Product) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO products (id, book_id, product_category_id, name, description,
                               created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            product.id,
            product.book_id,
            product.product_category_id,
            product.name,
            product.description,
            product.created_at,
            product.updated_at,
        ],
    )?;
    Ok(())
}

pub fn product_get(conn: &Connection, id: &str) -> CoreResult<Option<Product>> {
    Ok(conn
        .query_row(
            "SELECT * FROM products WHERE id = ?1",
            params![id],
            map_product,
        )
        .optional()?)
}

pub fn product_list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Product>> {
    let mut stmt = conn.prepare("SELECT * FROM products WHERE book_id = ?1 ORDER BY name, id")?;
    let rows = stmt
        .query_map(params![book_id], map_product)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn product_update(conn: &Connection, product: &Product) -> CoreResult<()> {
    conn.execute(
        "UPDATE products
         SET product_category_id = ?2, name = ?3, description = ?4, updated_at = ?5
         WHERE id = ?1",
        params![
            product.id,
            product.product_category_id,
            product.name,
            product.description,
            product.updated_at,
        ],
    )?;
    Ok(())
}

/// Hard delete. `product_variants.product_id` is `ON DELETE CASCADE`, so a
/// product's variants go with it.
pub fn product_delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM products WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Product variants
// ---------------------------------------------------------------------------

pub fn variant_insert(conn: &Connection, variant: &ProductVariant) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO product_variants (id, product_id, book_id, sku, name, price_minor,
                                       cost_price_minor, currency, reorder_point, attributes,
                                       created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            variant.id,
            variant.product_id,
            variant.book_id,
            variant.sku,
            variant.name,
            variant.price_minor,
            variant.cost_price_minor,
            variant.currency,
            variant.reorder_point,
            variant.attributes,
            variant.created_at,
            variant.updated_at,
        ],
    )?;
    Ok(())
}

pub fn variant_get(conn: &Connection, id: &str) -> CoreResult<Option<ProductVariant>> {
    Ok(conn
        .query_row(
            "SELECT * FROM product_variants WHERE id = ?1",
            params![id],
            map_variant,
        )
        .optional()?)
}

pub fn variant_list_for_product(
    conn: &Connection,
    product_id: &str,
) -> CoreResult<Vec<ProductVariant>> {
    let mut stmt = conn
        .prepare("SELECT * FROM product_variants WHERE product_id = ?1 ORDER BY created_at, id")?;
    let rows = stmt
        .query_map(params![product_id], map_variant)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Every variant in a book, across every product — the SKU-uniqueness scope,
/// and what a catalogue-wide search/listing screen needs.
pub fn variant_list_for_book(conn: &Connection, book_id: &str) -> CoreResult<Vec<ProductVariant>> {
    let mut stmt =
        conn.prepare("SELECT * FROM product_variants WHERE book_id = ?1 ORDER BY sku, id")?;
    let rows = stmt
        .query_map(params![book_id], map_variant)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn variant_update(conn: &Connection, variant: &ProductVariant) -> CoreResult<()> {
    conn.execute(
        "UPDATE product_variants
         SET sku = ?2, name = ?3, price_minor = ?4, cost_price_minor = ?5,
             reorder_point = ?6, attributes = ?7, updated_at = ?8
         WHERE id = ?1",
        params![
            variant.id,
            variant.sku,
            variant.name,
            variant.price_minor,
            variant.cost_price_minor,
            variant.reorder_point,
            variant.attributes,
            variant.updated_at,
        ],
    )?;
    Ok(())
}

pub fn variant_delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM product_variants WHERE id = ?1", params![id])?;
    Ok(())
}
