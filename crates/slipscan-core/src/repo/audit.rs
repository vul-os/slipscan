use rusqlite::{params, Connection, Row};

use crate::domain::AuditEntry;
use crate::error::CoreResult;

fn map_entry(row: &Row<'_>) -> rusqlite::Result<AuditEntry> {
    Ok(AuditEntry {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        entity_type: row.get("entity_type")?,
        entity_id: row.get("entity_id")?,
        action: row.get("action")?,
        before_json: row.get("before_json")?,
        after_json: row.get("after_json")?,
        created_at: row.get("created_at")?,
    })
}

pub fn insert(conn: &Connection, entry: &AuditEntry) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO audit_log (id, book_id, entity_type, entity_id, action,
                                before_json, after_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            entry.id,
            entry.book_id,
            entry.entity_type,
            entry.entity_id,
            entry.action,
            entry.before_json,
            entry.after_json,
            entry.created_at,
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection, book_id: Option<&str>, limit: u32) -> CoreResult<Vec<AuditEntry>> {
    let mut out = Vec::new();
    match book_id {
        Some(book_id) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM audit_log WHERE book_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![book_id, limit], map_entry)?;
            for row in rows {
                out.push(row?);
            }
        }
        None => {
            let mut stmt =
                conn.prepare("SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?1")?;
            let rows = stmt.query_map(params![limit], map_entry)?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    Ok(out)
}
