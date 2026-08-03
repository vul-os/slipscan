//! Contacts (customers & suppliers, Xero axis): CRUD and role-scoped listing.
//!
//! Raw SQL only — validation (non-empty name, book scoping, amount bounds)
//! lives in the service layer. See migration `0010_contacts` for why this is
//! one table with a `role` column rather than separate customer/supplier
//! tables.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::Contact;
use crate::error::CoreResult;

fn map_contact(row: &Row<'_>) -> rusqlite::Result<Contact> {
    Ok(Contact {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        role: col_enum(row, "role")?,
        name: row.get("name")?,
        company_name: row.get("company_name")?,
        email: row.get("email")?,
        phone: row.get("phone")?,
        billing_address: row.get("billing_address")?,
        shipping_address: row.get("shipping_address")?,
        tax_number: row.get("tax_number")?,
        payment_terms_days: row.get("payment_terms_days")?,
        credit_limit_minor: row.get("credit_limit_minor")?,
        notes: row.get("notes")?,
        is_active: row.get("is_active")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn insert(conn: &Connection, contact: &Contact) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO contacts (id, book_id, role, name, company_name, email, phone,
                               billing_address, shipping_address, tax_number,
                               payment_terms_days, credit_limit_minor, notes,
                               is_active, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            contact.id,
            contact.book_id,
            contact.role.as_str(),
            contact.name,
            contact.company_name,
            contact.email,
            contact.phone,
            contact.billing_address,
            contact.shipping_address,
            contact.tax_number,
            contact.payment_terms_days,
            contact.credit_limit_minor,
            contact.notes,
            contact.is_active,
            contact.created_at,
            contact.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Contact>> {
    Ok(conn
        .query_row(
            "SELECT * FROM contacts WHERE id = ?1",
            params![id],
            map_contact,
        )
        .optional()?)
}

/// Every contact in the book, either role, alphabetical by name.
pub fn list(conn: &Connection, book_id: &str) -> CoreResult<Vec<Contact>> {
    let mut stmt = conn.prepare("SELECT * FROM contacts WHERE book_id = ?1 ORDER BY name, id")?;
    let rows = stmt
        .query_map(params![book_id], map_contact)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Contacts on the given side of trade — `role` matches exactly, or the
/// contact is marked `both`, since a `both` contact is on every side.
pub fn list_by_role(conn: &Connection, book_id: &str, role: &str) -> CoreResult<Vec<Contact>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM contacts WHERE book_id = ?1 AND (role = ?2 OR role = 'both')
         ORDER BY name, id",
    )?;
    let rows = stmt
        .query_map(params![book_id, role], map_contact)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn update(conn: &Connection, contact: &Contact) -> CoreResult<()> {
    conn.execute(
        "UPDATE contacts
         SET role = ?2, name = ?3, company_name = ?4, email = ?5, phone = ?6,
             billing_address = ?7, shipping_address = ?8, tax_number = ?9,
             payment_terms_days = ?10, credit_limit_minor = ?11, notes = ?12,
             is_active = ?13, updated_at = ?14
         WHERE id = ?1",
        params![
            contact.id,
            contact.role.as_str(),
            contact.name,
            contact.company_name,
            contact.email,
            contact.phone,
            contact.billing_address,
            contact.shipping_address,
            contact.tax_number,
            contact.payment_terms_days,
            contact.credit_limit_minor,
            contact.notes,
            contact.is_active,
            contact.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<bool> {
    let n = conn.execute("DELETE FROM contacts WHERE id = ?1", params![id])?;
    Ok(n > 0)
}
