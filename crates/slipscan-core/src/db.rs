//! SQLite connection management and the embedded migration runner.
//!
//! One SQLite file per book-set, user-visible path, WAL mode, foreign keys on.
//! Migrations are numbered SQL files embedded via `include_str!` and tracked
//! in a `schema_migrations` table. No external migration tool.

use crate::error::{CoreError, CoreResult};
use crate::util::now_iso;
use rusqlite::Connection;
use std::path::Path;

/// Embedded, ordered migrations: (version, name, sql).
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "0001_init", include_str!("migrations/0001_init.sql")),
    (
        100,
        "0100_accounting",
        include_str!("migrations/0100_accounting.sql"),
    ),
    (
        101,
        "0101_ledger_hardening",
        include_str!("migrations/0101_ledger_hardening.sql"),
    ),
    (200, "0200_vault", include_str!("migrations/0200_vault.sql")),
    (
        201,
        "0201_regenerable_sources",
        include_str!("migrations/0201_regenerable_sources.sql"),
    ),
];

/// A configured, migrated SQLite database handle.
#[derive(Debug)]
pub struct Db {
    conn: Connection,
}

impl Db {
    /// Open (creating if needed) the database file at `path` and run pending
    /// migrations.
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let conn = Connection::open(path)?;
        Self::from_connection(conn)
    }

    /// In-memory database, mainly for tests.
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> CoreResult<Self> {
        configure(&conn)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Versions applied to this database, in order.
    pub fn applied_migrations(&self) -> CoreResult<Vec<i64>> {
        applied_versions(&self.conn)
    }
}

fn configure(conn: &Connection) -> CoreResult<()> {
    // journal_mode returns a row (the resulting mode); in-memory DBs report
    // "memory", file DBs "wal".
    let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(())
}

fn applied_versions(conn: &Connection) -> CoreResult<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT version FROM schema_migrations ORDER BY version")?;
    let versions = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<i64>, _>>()?;
    Ok(versions)
}

/// Run all pending migrations inside individual transactions.
pub fn migrate(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );",
    )?;
    let applied = applied_versions(conn)?;
    let latest = applied.last().copied().unwrap_or(0);

    for &(version, name, sql) in MIGRATIONS {
        if version <= latest {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql).map_err(|e| CoreError::Migration {
            version,
            message: e.to_string(),
        })?;
        tx.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![version, name, now_iso()],
        )?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_once_and_are_recorded() {
        let db = Db::open_in_memory().expect("open");
        assert_eq!(
            db.applied_migrations().unwrap(),
            vec![1, 100, 101, 200, 201]
        );
        // Re-running is a no-op.
        migrate(db.conn()).expect("re-migrate");
        assert_eq!(
            db.applied_migrations().unwrap(),
            vec![1, 100, 101, 200, 201]
        );
    }

    #[test]
    fn schema_has_expected_tables() {
        let db = Db::open_in_memory().unwrap();
        let mut stmt = db
            .conn()
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in [
            "accounts",
            "audit_log",
            "books",
            "budgets",
            "categories",
            "chart_of_accounts",
            "coa_map",
            "classification_corrections",
            "document_extractions",
            "documents",
            "journal_lines",
            "journals",
            "merchant_mappings",
            "recon_matches",
            "schema_migrations",
            "settings",
            "transactions",
            "vat_rates",
            "vault_keys",
            "vault_secrets",
        ] {
            assert!(tables.iter().any(|t| t == expected), "missing {expected}");
        }
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let db = Db::open_in_memory().unwrap();
        let err = db.conn().execute(
            "INSERT INTO accounts (id, book_id, name, kind, currency, created_at, updated_at)
             VALUES ('a', 'missing-book', 'x', 'bank', 'ZAR', 't', 't')",
            [],
        );
        assert!(err.is_err(), "FK violation must be rejected");
    }
}
