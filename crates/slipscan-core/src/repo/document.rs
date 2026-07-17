use rusqlite::{params, Connection, OptionalExtension, Row};

use super::col_enum;
use crate::domain::{Document, DocumentExtraction, DocumentStatus};
use crate::error::CoreResult;

fn map_document(row: &Row<'_>) -> rusqlite::Result<Document> {
    Ok(Document {
        id: row.get("id")?,
        book_id: row.get("book_id")?,
        source: col_enum(row, "source")?,
        kind: col_enum(row, "kind")?,
        file_path: row.get("file_path")?,
        mime_type: row.get("mime_type")?,
        size_bytes: row.get("size_bytes")?,
        original_name: row.get("original_name")?,
        sha256: row.get("sha256")?,
        status: col_enum(row, "status")?,
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn map_extraction(row: &Row<'_>) -> rusqlite::Result<DocumentExtraction> {
    Ok(DocumentExtraction {
        id: row.get("id")?,
        document_id: row.get("document_id")?,
        book_id: row.get("book_id")?,
        provider: row.get("provider")?,
        model: row.get("model")?,
        status: col_enum(row, "status")?,
        payload: row.get("payload")?,
        error: row.get("error")?,
        is_current: row.get("is_current")?,
        created_at: row.get("created_at")?,
    })
}

pub fn insert(conn: &Connection, document: &Document) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO documents (id, book_id, source, kind, file_path, mime_type,
                                size_bytes, original_name, sha256, status, error,
                                created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            document.id,
            document.book_id,
            document.source.as_str(),
            document.kind.as_str(),
            document.file_path,
            document.mime_type,
            document.size_bytes,
            document.original_name,
            document.sha256,
            document.status.as_str(),
            document.error,
            document.created_at,
            document.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Document>> {
    Ok(conn
        .query_row(
            "SELECT * FROM documents WHERE id = ?1",
            params![id],
            map_document,
        )
        .optional()?)
}

pub fn find_by_sha256(
    conn: &Connection,
    book_id: &str,
    sha256: &str,
) -> CoreResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM documents WHERE book_id = ?1 AND sha256 = ?2",
            params![book_id, sha256],
            |row| row.get(0),
        )
        .optional()?)
}

pub fn list(
    conn: &Connection,
    book_id: &str,
    status: Option<DocumentStatus>,
) -> CoreResult<Vec<Document>> {
    let mut out = Vec::new();
    match status {
        Some(status) => {
            let mut stmt = conn.prepare(
                "SELECT * FROM documents WHERE book_id = ?1 AND status = ?2
                 ORDER BY created_at DESC, id DESC",
            )?;
            let rows = stmt.query_map(params![book_id, status.as_str()], map_document)?;
            for row in rows {
                out.push(row?);
            }
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT * FROM documents WHERE book_id = ?1
                 ORDER BY created_at DESC, id DESC",
            )?;
            let rows = stmt.query_map(params![book_id], map_document)?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    Ok(out)
}

pub fn set_status(
    conn: &Connection,
    id: &str,
    status: DocumentStatus,
    error: Option<&str>,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE documents SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status.as_str(), error, updated_at],
    )?;
    Ok(())
}

pub fn insert_extraction(conn: &Connection, extraction: &DocumentExtraction) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO document_extractions (id, document_id, book_id, provider, model,
                                           status, payload, error, is_current, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            extraction.id,
            extraction.document_id,
            extraction.book_id,
            extraction.provider,
            extraction.model,
            extraction.status.as_str(),
            extraction.payload,
            extraction.error,
            extraction.is_current,
            extraction.created_at,
        ],
    )?;
    Ok(())
}

pub fn clear_current_extraction(conn: &Connection, document_id: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE document_extractions SET is_current = 0 WHERE document_id = ?1",
        params![document_id],
    )?;
    Ok(())
}

pub fn current_extraction(
    conn: &Connection,
    document_id: &str,
) -> CoreResult<Option<DocumentExtraction>> {
    Ok(conn
        .query_row(
            "SELECT * FROM document_extractions
             WHERE document_id = ?1 AND is_current = 1",
            params![document_id],
            map_extraction,
        )
        .optional()?)
}
