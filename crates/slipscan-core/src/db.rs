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
///
/// SlipScan has never shipped, so there is no deployed database whose
/// `schema_migrations` history has to be honoured — this is a single baseline
/// schema split across files by subsystem, not a chain of patches applied to
/// each other over time. Every table is created once, in its final shape,
/// with its own indexes and triggers beside it.
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "0001_init", include_str!("migrations/0001_init.sql")),
    (
        2,
        "0002_accounting",
        include_str!("migrations/0002_accounting.sql"),
    ),
    (3, "0003_vault", include_str!("migrations/0003_vault.sql")),
    (4, "0004_fx", include_str!("migrations/0004_fx.sql")),
    (
        5,
        "0005_shapepay",
        include_str!("migrations/0005_shapepay.sql"),
    ),
    (
        6,
        "0006_members",
        include_str!("migrations/0006_members.sql"),
    ),
    (
        7,
        "0007_devices",
        include_str!("migrations/0007_devices.sql"),
    ),
    (8, "0008_oplog", include_str!("migrations/0008_oplog.sql")),
    (
        9,
        "0009_locations",
        include_str!("migrations/0009_locations.sql"),
    ),
    (
        10,
        "0010_contacts",
        include_str!("migrations/0010_contacts.sql"),
    ),
    (
        11,
        "0011_catalogue",
        include_str!("migrations/0011_catalogue.sql"),
    ),
    (12, "0012_stock", include_str!("migrations/0012_stock.sql")),
    (
        13,
        "0013_purchasing",
        include_str!("migrations/0013_purchasing.sql"),
    ),
    // 13, 14 and 15 were written concurrently on separate branches, each
    // holding a number reserved up front rather than picking "one past the
    // highest I can see" — which is why all three land contiguous here
    // instead of colliding on 13. Each file's own header explains its
    // feature; the numbering needed no reconciliation at merge time, which
    // was the point of assigning it first.
    (14, "0014_sales", include_str!("migrations/0014_sales.sql")),
    (
        15,
        "0015_networth",
        include_str!("migrations/0015_networth.sql"),
    ),
    (
        16,
        "0016_assets",
        include_str!("migrations/0016_assets.sql"),
    ),
    // 16 was reserved and held by the concurrent fixed-asset-register branch
    // (see its comment above) while this file was in flight — the same
    // "reserve the number up front" convention 13/14/15's own comment
    // describes, applied across branches rather than within one. This file
    // takes 17 rather than "one past the highest applied here" so the two do
    // not collide at merge time either.
    (
        17,
        "0017_recurring",
        include_str!("migrations/0017_recurring.sql"),
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
    ///
    /// The busy timeout is set here, before `configure`/`migrate` run, not
    /// left to the caller (`CoreService::open` used to set it only after
    /// this returned). A real file can genuinely be opened by more than one
    /// thread or process at once — the migration runner's own `CREATE TABLE
    /// IF NOT EXISTS schema_migrations` is itself a write, in autocommit
    /// mode, before any transaction exists to hold a lock across — so two
    /// callers racing to open the same file for the first time need the
    /// timeout in effect for that write too, not only for the application
    /// code that opens afterward. Migration `0017_recurring` growing the
    /// schema enough to widen that open-time race from "never observed" to
    /// "reliably fails" (`invoice_numbering_has_no_gap_or_duplicate_under_
    /// concurrent_issue`, 8 threads opening the same fresh file) is what
    /// surfaced this; the fix is general, not specific to that migration.
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
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
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
        );
        // Re-running is a no-op.
        migrate(db.conn()).expect("re-migrate");
        assert_eq!(
            db.applied_migrations().unwrap(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
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
            "asset_depreciation_runs",
            "assets",
            "audit_log",
            "books",
            "budgets",
            "categories",
            "chart_of_accounts",
            "coa_map",
            "classification_corrections",
            "contacts",
            "document_extractions",
            "documents",
            "fx_rates",
            "invoice_items",
            "invoice_payments",
            "invoices",
            "journal_lines",
            "journals",
            "members",
            "merchant_mappings",
            "number_sequences",
            "networth_snapshots",
            "pay_deliveries",
            "pay_endpoints",
            "pay_matches",
            "pay_watch_codes",
            "po_receipts",
            "purchase_order_items",
            "purchase_orders",
            "recon_matches",
            "recurring_runs",
            "recurring_schedule_items",
            "recurring_schedules",
            "sales_order_items",
            "sales_orders",
            "schema_migrations",
            "settings",
            "stock_movements",
            "transaction_splits",
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

    /// Every table, column, type, constraint, index, trigger and view a fresh
    /// database produces, sorted by (type, name) and rendered as literal
    /// `CREATE ...` SQL straight from `sqlite_master`.
    ///
    /// This is the exact text captured at
    /// `crates/slipscan-core/tests/schema_baseline.sql` before the migration
    /// files were folded from a patch chain (0001, 0100, 0101, 0200, 0201,
    /// 0300, 0301, 0400, 0500, 0600, 0700, 0800, 0810, 0820 — several of them
    /// pure `ALTER TABLE`/`DROP INDEX` patches to tables an earlier file
    /// created) into today's baseline (0001..0011, one `CREATE TABLE` per
    /// table, in its final shape, with its own indexes and triggers beside
    /// it). Comparing raw `sqlite_master.sql` text — not a hand-rolled
    /// projection of "the columns that matter" — is deliberate: a
    /// projection only catches drift in the fields somebody thought to
    /// project.
    fn dump_schema(db: &Db) -> String {
        let mut stmt = db
            .conn()
            .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
            .unwrap();
        let rows: Vec<(String, String, Option<String>)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut out = String::new();
        for (ty, name, sql) in rows {
            out.push_str(&format!("-- {ty} {name}\n{};\n\n", sql.unwrap_or_default()));
        }
        out
    }

    /// **The gate this whole migration layout exists to satisfy.** Folding
    /// the patch chain into a baseline must not change the schema it
    /// produces by so much as a byte — same tables, same columns in the same
    /// order, same constraints, same indexes, same triggers. If this test
    /// goes red, the fold changed the schema, which was never the ask.
    #[test]
    fn schema_matches_the_pre_fold_baseline_byte_for_byte() {
        let db = Db::open_in_memory().unwrap();
        let actual = dump_schema(&db);
        let expected = include_str!("../tests/schema_baseline.sql");
        assert_eq!(
            actual, expected,
            "the generated schema no longer matches tests/schema_baseline.sql \
             byte-for-byte — a migration changed structure rather than just \
             moving where a table/column/trigger is declared"
        );
    }
}
