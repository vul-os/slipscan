use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreResult;

#[derive(Debug, Clone)]
pub struct SettingRow {
    pub key: String,
    pub value: String,
    /// Keychain entry name when the value is a secret; the DB never stores
    /// the secret itself.
    pub secret_ref: Option<String>,
    pub updated_at: String,
}

pub fn upsert(
    conn: &Connection,
    key: &str,
    value: &str,
    secret_ref: Option<&str>,
    updated_at: &str,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, secret_ref, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET
             value = excluded.value,
             secret_ref = excluded.secret_ref,
             updated_at = excluded.updated_at",
        params![key, value, secret_ref, updated_at],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, key: &str) -> CoreResult<Option<SettingRow>> {
    Ok(conn
        .query_row(
            "SELECT key, value, secret_ref, updated_at FROM settings WHERE key = ?1",
            params![key],
            |row| {
                Ok(SettingRow {
                    key: row.get("key")?,
                    value: row.get("value")?,
                    secret_ref: row.get("secret_ref")?,
                    updated_at: row.get("updated_at")?,
                })
            },
        )
        .optional()?)
}
