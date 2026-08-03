//! Reading captured writes back out of the outbox, and turning a live row into
//! the JSON payload an op carries.
//!
//! The capture itself is SQL — migration `0700_oplog` installs a trigger set
//! per replicated table — and the reasoning for that choice is in the
//! migration's header. This module is the Rust half: it drains the outbox,
//! collapses redundant entries, and reflects each row's current contents.
//!
//! # Why the row is read here rather than captured in the trigger
//!
//! A trigger that built the payload would have to name every column. That is a
//! second copy of the schema, and the first `ALTER TABLE ... ADD COLUMN` makes
//! the two disagree — silently, because the trigger still fires and the op
//! still signs; it just stops replicating the new column. Reading `SELECT *`
//! at seal time has no second copy to drift from.
//!
//! The cost is that the payload is the row as it stands when sealed, not as it
//! stood when written. For a §4.4 register that is not a loss: the register's
//! value is "the row", and two writes between seals collapse to the later one,
//! which is exactly what last-writer-wins would have done with both.

use rusqlite::{types::Value as SqlValue, Connection};
use serde_json::{Map, Value};

use crate::error::{CoreError, CoreResult};

/// One captured write awaiting a signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    pub seq: i64,
    pub table: String,
    pub row_id: String,
    /// The book id — the SYNC.md §7 namespace this op belongs to.
    pub ns: String,
    pub deleted: bool,
}

/// Every outbox entry, oldest first.
pub fn drain_list(conn: &Connection) -> CoreResult<Vec<Captured>> {
    let mut stmt =
        conn.prepare("SELECT seq, table_name, row_id, ns, deleted FROM sync_outbox ORDER BY seq")?;
    let rows = stmt.query_map([], |row| {
        Ok(Captured {
            seq: row.get(0)?,
            table: row.get(1)?,
            row_id: row.get(2)?,
            ns: row.get(3)?,
            deleted: row.get::<_, i64>(4)? != 0,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(CoreError::from)
}

/// Collapse redundant captures: for each `(table, row-id)`, keep the **last**
/// entry.
///
/// A row edited three times between two seals is one register write, not
/// three. Sealing all three would be correct but wasteful — three signed ops
/// where the first two are already superseded by the third, permanently, on
/// every replica that ever receives them.
///
/// Order is preserved by the surviving entry's own sequence number, so the
/// stamps still follow the order the writes actually happened in.
///
/// This is only sound because the payload is read at seal time (see the module
/// docs): the surviving entry's row read yields the final state, so nothing
/// the collapsed entries would have carried is lost. Ledger tables are
/// insert-only and can never produce two entries for one row, so they are
/// untouched by this in practice.
pub fn coalesce(mut entries: Vec<Captured>) -> Vec<Captured> {
    entries.sort_by_key(|entry| entry.seq);
    let mut kept: Vec<Captured> = Vec::with_capacity(entries.len());
    for entry in entries.into_iter().rev() {
        if kept
            .iter()
            .any(|k| k.table == entry.table && k.row_id == entry.row_id)
        {
            continue;
        }
        kept.push(entry);
    }
    kept.reverse();
    kept
}

/// Read a row as a JSON object, or `None` if it is gone.
///
/// `table` must be one the mapping recognises. That is not a formality: the
/// name is interpolated into SQL, and the only thing making that safe is that
/// it comes from `slipscan_sync`'s closed table registry rather than from a
/// row, a request or a user. The check is here, at the interpolation, rather
/// than trusted to every caller.
pub fn read_row(conn: &Connection, table: &str, id: &str) -> CoreResult<Option<Value>> {
    if !slipscan_sync::is_replicated(table) {
        return Err(CoreError::Validation(format!(
            "{table} is not a replicated table; refusing to read it into an op"
        )));
    }
    let sql = format!("SELECT * FROM \"{table}\" WHERE id = ?1");
    let mut stmt = conn.prepare(&sql)?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    let mut rows = stmt.query(rusqlite::params![id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let mut object = Map::with_capacity(columns.len());
    for (index, column) in columns.iter().enumerate() {
        let value: SqlValue = row.get(index)?;
        object.insert(column.clone(), sql_to_json(table, column, value)?);
    }
    Ok(Some(Value::Object(object)))
}

/// The payload of a tombstone: identity, and nothing else.
///
/// The row is already gone by the time a delete is sealed, so there is nothing
/// else to carry. Nor is anything lost by that: reviving a deleted row is an
/// ordinary live write that carries full content again (see `slipscan-sync`'s
/// §4.4 note on why a delete is a flag and not a §4.5 death certificate).
pub fn tombstone(id: &str) -> Value {
    let mut object = Map::with_capacity(1);
    object.insert("id".to_string(), Value::String(id.to_string()));
    Value::Object(object)
}

/// One SQLite cell as JSON, failing closed on anything that cannot cross the
/// wire exactly.
fn sql_to_json(table: &str, column: &str, value: SqlValue) -> CoreResult<Value> {
    Ok(match value {
        SqlValue::Null => Value::Null,
        // Money is `i64` minor units everywhere in SlipScan, and this is the
        // arm it travels through: an integer in, the same integer out, with no
        // float on the path to round it.
        SqlValue::Integer(int) => Value::Number(int.into()),
        SqlValue::Real(real) => serde_json::Number::from_f64(real)
            .map(Value::Number)
            .ok_or_else(|| {
                // NaN and the infinities have no JSON spelling. A money column
                // could never hold one — SlipScan has no float money — but a
                // ratio column could, and encoding it as `null` would replicate
                // a different number than the one stored.
                CoreError::Validation(format!(
                    "{table}.{column} holds a non-finite number, which has no exact \
                     encoding; refusing to replicate it as something else"
                ))
            })?,
        SqlValue::Text(text) => Value::String(text),
        // No replicated table has a BLOB column today, and this refusal is how
        // it stays true: adding one fails at the first seal with the column
        // named, rather than replicating rows with the column quietly dropped
        // or base64'd into a shape the other side does not expect.
        SqlValue::Blob(_) => {
            return Err(CoreError::Validation(format!(
                "{table}.{column} is a BLOB; replicating binary columns needs a mapping \
                 decision that has not been made"
            )))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::sync::tests::{book, seed_book};

    /// **The structural guarantee, in both directions.**
    ///
    /// A behaviour test ("writing an account produces an outbox row") keeps
    /// passing when somebody adds a twelfth replicated table and forgets its
    /// triggers. So the trigger set and the mapping registry are compared as
    /// *sets*: a mapped table with no triggers, or triggers for a table nobody
    /// mapped, fails here.
    #[test]
    fn every_mapped_table_has_capture_triggers_and_no_others_do() {
        let db = Db::open_in_memory().unwrap();
        let mut stmt = db
            .conn()
            .prepare(
                "SELECT name, tbl_name FROM sqlite_master
                 WHERE type = 'trigger' AND name LIKE 'sync\\_capture\\_%' ESCAPE '\\'
                 ORDER BY name",
            )
            .unwrap();
        let triggers: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        assert!(
            triggers.len() > 20,
            "the scan is broken, not the schema: {} triggers seen",
            triggers.len()
        );

        let mut tabled: Vec<String> = triggers.iter().map(|(_, t)| t.clone()).collect();
        tabled.sort();
        tabled.dedup();

        let mut mapped: Vec<String> = slipscan_sync::replicated_tables()
            .into_iter()
            .map(str::to_owned)
            .collect();
        mapped.sort();

        assert_eq!(
            tabled, mapped,
            "the capture triggers and the sync mapping disagree — a table is \
             replicated with nothing recording its writes, or recorded with no \
             mapping decision behind it"
        );
    }

    /// An editable table needs all three verbs. A ledger table needs exactly
    /// one, because migration 0101 makes the other two impossible — and the
    /// suite must notice if that ever stops being true.
    #[test]
    fn lww_tables_capture_all_three_verbs_and_ledger_tables_only_insert() {
        let db = Db::open_in_memory().unwrap();
        let triggers = |table: &str| -> Vec<String> {
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type = 'trigger' AND tbl_name = ?1
                       AND name LIKE 'sync\\_capture\\_%' ESCAPE '\\'
                     ORDER BY name",
                )
                .unwrap();
            stmt.query_map(rusqlite::params![table], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };

        for table in slipscan_sync::LWW_TABLES {
            let names = triggers(table);
            assert_eq!(names.len(), 3, "{table} triggers: {names:?}");
            for verb in ["_ins", "_upd", "_del"] {
                assert!(
                    names.iter().any(|n| n.ends_with(verb)),
                    "{table} has no {verb} capture trigger"
                );
            }
        }

        for table in slipscan_sync::LEDGER_TABLES {
            let names = triggers(table);
            assert_eq!(
                names,
                vec![format!("sync_capture_{table}_ins")],
                "a ledger table captures inserts only; corrections are reversals"
            );
        }
    }

    /// The other half of the immutability contract: the reason a ledger table
    /// needs no update/delete capture is that SQLite refuses the statement.
    /// Asserted here rather than assumed, because this module's trigger set is
    /// only correct while it holds.
    #[test]
    fn a_posted_journal_cannot_be_updated_or_deleted_at_all() {
        let db = Db::open_in_memory().unwrap();
        let book = seed_book(&db);
        let coa: String = db
            .conn()
            .query_row(
                "SELECT id FROM chart_of_accounts WHERE book_id = ?1 LIMIT 1",
                rusqlite::params![book],
                |row| row.get(0),
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO journals (id, book_id, posted_date, narrative, source_type, created_at)
                 VALUES ('j-1', ?1, '2026-01-01', 'Opening', 'manual', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO journal_lines (id, journal_id, book_id, coa_id, debit_minor,
                                            credit_minor, currency, line_order, created_at)
                 VALUES ('l-1', 'j-1', ?1, ?2, 100, 0, 'ZAR', 0, 't')",
                rusqlite::params![book, coa],
            )
            .unwrap();

        for sql in [
            "UPDATE journals SET narrative = 'edited' WHERE id = 'j-1'",
            "DELETE FROM journals WHERE id = 'j-1'",
            "UPDATE journal_lines SET debit_minor = 1 WHERE id = 'l-1'",
            "DELETE FROM journal_lines WHERE id = 'l-1'",
        ] {
            let err = db.conn().execute(sql, []).unwrap_err();
            assert!(
                err.to_string().contains("immutable"),
                "`{sql}` must be refused by the database itself, got {err}"
            );
        }
    }

    #[test]
    fn an_ordinary_write_lands_in_the_outbox_with_its_namespace() {
        let db = Db::open_in_memory().unwrap();
        let book = seed_book(&db);
        db.conn()
            .execute(
                "INSERT INTO accounts (id, book_id, name, kind, currency, created_at, updated_at)
                 VALUES ('a-1', ?1, 'Cheque', 'bank', 'ZAR', 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();

        let captured = drain_list(db.conn()).unwrap();
        let account = captured
            .iter()
            .find(|c| c.table == "accounts")
            .expect("the write was captured");
        assert_eq!(account.row_id, "a-1");
        assert_eq!(account.ns, book, "the namespace is the book id");
        assert!(!account.deleted);
    }

    /// Migration 0820's three catalogue tables, exercised directly against
    /// their triggers (raw SQL, not the service layer) so this test would
    /// fail even if a future service-layer bug happened to route writes
    /// around `repo::catalogue`. Insert, update and delete are each checked
    /// to land in the outbox, for every one of the three tables — the
    /// specific risk this migration named in its own header: a table that
    /// compiles and passes ordinary CRUD tests while its capture triggers
    /// are missing or misnamed, and so never replicates at all.
    #[test]
    fn catalogue_tables_capture_insert_update_and_delete() {
        let db = Db::open_in_memory().unwrap();
        let book = seed_book(&db);

        // -- product_categories --------------------------------------------
        db.conn()
            .execute(
                "INSERT INTO product_categories (id, book_id, name, created_at, updated_at)
                 VALUES ('pc-1', ?1, 'Beverages', 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE product_categories SET name = 'Drinks' WHERE id = 'pc-1'",
                [],
            )
            .unwrap();
        db.conn()
            .execute("DELETE FROM product_categories WHERE id = 'pc-1'", [])
            .unwrap();

        // -- products ---------------------------------------------------------
        db.conn()
            .execute(
                "INSERT INTO products (id, book_id, name, created_at, updated_at)
                 VALUES ('p-1', ?1, 'Cola 330ml', 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE products SET name = 'Cola 500ml' WHERE id = 'p-1'",
                [],
            )
            .unwrap();
        db.conn()
            .execute("DELETE FROM products WHERE id = 'p-1'", [])
            .unwrap();

        // -- product_variants ---------------------------------------------------
        // Re-insert the parent product: the delete above cascaded away the
        // one from the previous block, and a variant needs a live parent.
        db.conn()
            .execute(
                "INSERT INTO products (id, book_id, name, created_at, updated_at)
                 VALUES ('p-2', ?1, 'Cola', 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO product_variants
                     (id, product_id, book_id, sku, name, price_minor, cost_price_minor,
                      currency, reorder_point, created_at, updated_at)
                 VALUES ('v-1', 'p-2', ?1, 'COLA-330', '330ml can', 1500, 900, 'ZAR', 24, 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        db.conn()
            .execute(
                "UPDATE product_variants SET price_minor = 1600 WHERE id = 'v-1'",
                [],
            )
            .unwrap();
        db.conn()
            .execute("DELETE FROM product_variants WHERE id = 'v-1'", [])
            .unwrap();

        let captured = drain_list(db.conn()).unwrap();
        for (table, row_id) in [
            ("product_categories", "pc-1"),
            ("products", "p-1"),
            ("product_variants", "v-1"),
        ] {
            let rows: Vec<&Captured> = captured
                .iter()
                .filter(|c| c.table == table && c.row_id == row_id)
                .collect();
            assert_eq!(
                rows.len(),
                3,
                "{table}/{row_id}: expected an insert, update and delete capture, got {rows:?}"
            );
            assert_eq!(
                rows.iter().filter(|c| !c.deleted).count(),
                2,
                "{table}/{row_id}: the insert and the update should both be live captures"
            );
            assert_eq!(
                rows.iter().filter(|c| c.deleted).count(),
                1,
                "{table}/{row_id}: the delete should be a tombstone capture"
            );
            assert!(
                rows.iter().all(|c| c.ns == book),
                "{table}/{row_id}: namespace must be the book id"
            );
        }
    }

    /// A `books` row is its own namespace — it has no `book_id` column to take
    /// one from.
    #[test]
    fn a_book_row_is_its_own_namespace() {
        let db = Db::open_in_memory().unwrap();
        let book = book(&db);
        let captured = drain_list(db.conn()).unwrap();
        let row = captured.iter().find(|c| c.table == "books").unwrap();
        assert_eq!(row.row_id, book);
        assert_eq!(row.ns, book);
    }

    /// A cascade is still a write. Deleting a book takes its accounts with it,
    /// and every one of those deletions must be recorded — this is exactly the
    /// path a recorder called from the repo layer would have missed, because
    /// no repo function runs.
    #[test]
    fn a_cascading_delete_is_captured_even_though_no_rust_ran() {
        let db = Db::open_in_memory().unwrap();
        let book = seed_book(&db);
        db.conn()
            .execute(
                "INSERT INTO accounts (id, book_id, name, kind, currency, created_at, updated_at)
                 VALUES ('a-1', ?1, 'Cheque', 'bank', 'ZAR', 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        db.conn().execute("DELETE FROM sync_outbox", []).unwrap();

        db.conn()
            .execute("DELETE FROM books WHERE id = ?1", rusqlite::params![book])
            .unwrap();

        let captured = drain_list(db.conn()).unwrap();
        assert!(
            captured
                .iter()
                .any(|c| c.table == "accounts" && c.row_id == "a-1" && c.deleted),
            "the cascaded account delete was not captured: {captured:#?}"
        );
        assert!(
            captured.iter().any(|c| c.table == "books" && c.deleted),
            "the book delete was not captured"
        );
    }

    /// The apply-path seam. Nothing sets this flag today; the mechanism is
    /// exercised so that when the apply path does set it, it is not the first
    /// time anyone has found out whether it works.
    #[test]
    fn suppression_stops_capture() {
        let db = Db::open_in_memory().unwrap();
        let book = seed_book(&db);
        db.conn()
            .execute("UPDATE sync_control SET applying = 1 WHERE id = 1", [])
            .unwrap();
        db.conn().execute("DELETE FROM sync_outbox", []).unwrap();

        db.conn()
            .execute(
                "INSERT INTO accounts (id, book_id, name, kind, currency, created_at, updated_at)
                 VALUES ('a-1', ?1, 'Cheque', 'bank', 'ZAR', 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();
        assert!(drain_list(db.conn()).unwrap().is_empty());

        db.conn()
            .execute("UPDATE sync_control SET applying = 0 WHERE id = 1", [])
            .unwrap();
        db.conn()
            .execute("UPDATE accounts SET name = 'Savings' WHERE id = 'a-1'", [])
            .unwrap();
        assert_eq!(drain_list(db.conn()).unwrap().len(), 1);
    }

    #[test]
    fn coalescing_keeps_the_last_entry_per_row_in_write_order() {
        let entry = |seq, table: &str, id: &str, deleted| Captured {
            seq,
            table: table.into(),
            row_id: id.into(),
            ns: "b".into(),
            deleted,
        };
        let collapsed = coalesce(vec![
            entry(1, "accounts", "a", false),
            entry(2, "categories", "c", false),
            entry(3, "accounts", "a", false),
            entry(4, "accounts", "b", false),
            entry(5, "categories", "c", true),
        ]);
        assert_eq!(
            collapsed
                .iter()
                .map(|c| (c.seq, c.deleted))
                .collect::<Vec<_>>(),
            vec![(3, false), (4, false), (5, true)],
            "one entry per row, in the order of the surviving write"
        );
    }

    /// Same row id in two different tables is two different rows.
    #[test]
    fn coalescing_keys_on_the_table_as_well_as_the_row() {
        let collapsed = coalesce(vec![
            Captured {
                seq: 1,
                table: "accounts".into(),
                row_id: "x".into(),
                ns: "b".into(),
                deleted: false,
            },
            Captured {
                seq: 2,
                table: "categories".into(),
                row_id: "x".into(),
                ns: "b".into(),
                deleted: false,
            },
        ]);
        assert_eq!(collapsed.len(), 2);
    }

    #[test]
    fn a_row_reads_back_as_a_json_object_with_money_still_an_integer() {
        let db = Db::open_in_memory().unwrap();
        let book = seed_book(&db);
        db.conn()
            .execute(
                "INSERT INTO accounts (id, book_id, name, kind, currency,
                                       opening_balance_minor, created_at, updated_at)
                 VALUES ('a-1', ?1, 'Cheque', 'bank', 'ZAR', 9007199254740993, 't', 't')",
                rusqlite::params![book],
            )
            .unwrap();

        let row = read_row(db.conn(), "accounts", "a-1").unwrap().unwrap();
        let balance = row.get("opening_balance_minor").unwrap();
        assert!(balance.is_i64(), "money must not become a float");
        assert_eq!(balance.as_i64().unwrap(), 9_007_199_254_740_993);
        assert_eq!(row.get("institution").unwrap(), &Value::Null);
        assert!(read_row(db.conn(), "accounts", "missing")
            .unwrap()
            .is_none());
    }

    /// The table name is interpolated into SQL, so it is checked against the
    /// closed registry at the point of interpolation.
    #[test]
    fn reading_an_unmapped_table_is_refused() {
        let db = Db::open_in_memory().unwrap();
        for table in ["audit_log", "documents", "accounts\"; DROP TABLE books--"] {
            assert!(read_row(db.conn(), table, "x").is_err(), "{table}");
        }
    }

    #[test]
    fn a_blob_column_is_refused_rather_than_silently_dropped() {
        // `vault_secrets` is not replicated, so this reaches the conversion
        // through the primitive directly rather than through `read_row`.
        let err = sql_to_json("accounts", "blobby", SqlValue::Blob(vec![1, 2, 3])).unwrap_err();
        assert!(err.to_string().contains("BLOB"), "{err}");
    }

    #[test]
    fn a_non_finite_number_is_refused() {
        assert!(sql_to_json("t", "c", SqlValue::Real(f64::NAN)).is_err());
        assert!(sql_to_json("t", "c", SqlValue::Real(f64::INFINITY)).is_err());
        assert!(sql_to_json("t", "c", SqlValue::Real(0.25)).is_ok());
    }

    #[test]
    fn a_tombstone_carries_identity_and_nothing_else() {
        let payload = tombstone("a-1");
        assert_eq!(payload, serde_json::json!({"id": "a-1"}));
    }
}
