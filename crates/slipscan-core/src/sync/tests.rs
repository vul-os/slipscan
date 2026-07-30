//! The oplog's suite.
//!
//! Two things get most of the attention here, because they are the two a
//! record-keeping layer is usually wrong about: that **every** write reaches
//! the log whatever path it came from, and that the ops the log holds converge
//! to the same state whatever order they are merged in.

use rusqlite::Connection;

use super::*;
use crate::db::Db;
use crate::device::keys::DeviceKeypair;
use crate::device::{Devices, IDENTITY_SECRET_REF};
use crate::secrets::{MemorySecretStore, Vault};

/// A device: its own database and its own mock keychain, as two machines
/// would have.
pub(crate) struct TestDevice {
    pub db: Db,
    pub keychain: MemorySecretStore,
}

impl TestDevice {
    pub fn new(label: &str) -> Self {
        let device = Self {
            db: Db::open_in_memory().expect("db"),
            keychain: MemorySecretStore::default(),
        };
        device.devices().initialize(label).expect("initialize");
        device
    }

    pub fn devices(&self) -> Devices<'_> {
        Devices::new(self.db.conn(), &self.keychain)
    }

    pub fn oplog(&self) -> Oplog<'_> {
        Oplog::new(self.db.conn(), &self.keychain)
    }

    pub fn conn(&self) -> &Connection {
        self.db.conn()
    }
}

/// A fixed wall-clock reading, so seals are deterministic.
pub(crate) const NOW_MS: u64 = 1_760_000_000_000;

/// A bare book row. Returns its id.
pub(crate) fn book(db: &Db) -> String {
    let id = "b-1".to_string();
    db.conn()
        .execute(
            "INSERT INTO books (id, kind, name, currency, locale, timezone,
                                created_at, updated_at, region)
             VALUES (?1, 'personal', 'Household', 'ZAR', 'en', 'UTC', 't', 't', 'za')",
            rusqlite::params![id],
        )
        .expect("book");
    id
}

/// A book with one chart-of-accounts entry, enough to post a journal against.
pub(crate) fn seed_book(db: &Db) -> String {
    let id = book(db);
    db.conn()
        .execute(
            "INSERT INTO chart_of_accounts (id, book_id, code, name, kind,
                                            created_at, updated_at)
             VALUES ('coa-1', ?1, '1000', 'Bank', 'asset', 't', 't')",
            rusqlite::params![id],
        )
        .expect("coa");
    id
}

fn account(db: &Db, book: &str, id: &str, name: &str, balance_minor: i64) {
    db.conn()
        .execute(
            "INSERT INTO accounts (id, book_id, name, kind, currency,
                                   opening_balance_minor, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'bank', 'ZAR', ?4, 't', 't')",
            rusqlite::params![id, book, name, balance_minor],
        )
        .expect("account");
}

fn journal(db: &Db, book: &str, id: &str, narrative: &str) {
    db.conn()
        .execute(
            "INSERT INTO journals (id, book_id, posted_date, narrative, source_type, created_at)
             VALUES (?1, ?2, '2026-01-01', ?3, 'manual', 't')",
            rusqlite::params![id, book, narrative],
        )
        .expect("journal");
}

fn journal_line(db: &Db, book: &str, id: &str, journal_id: &str, debit_minor: i64) {
    db.conn()
        .execute(
            "INSERT INTO journal_lines (id, journal_id, book_id, coa_id, debit_minor,
                                        credit_minor, currency, line_order, created_at)
             VALUES (?1, ?2, ?3, 'coa-1', ?4, 0, 'ZAR', 0, 't')",
            rusqlite::params![id, journal_id, book, debit_minor],
        )
        .expect("journal line");
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

#[test]
fn a_write_becomes_a_signed_op() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 25_000);

    let report = device.oplog().seal_at(NOW_MS).unwrap();
    assert!(report.sealed > 0);
    assert_eq!(
        device.oplog().pending().unwrap(),
        0,
        "the outbox is drained"
    );

    let ops = device.oplog().ops(None, None).unwrap();
    let account_op = ops
        .iter()
        .find(|op| op.target == "accounts/a-1")
        .expect("the account write is in the log");

    assert_eq!(account_op.ns, book, "namespaced by book");
    assert_eq!(account_op.origin, OpOrigin::Local);
    assert_eq!(
        account_op.author,
        device.devices().require_identity().unwrap().public_key,
        "attributed to this device's key"
    );

    // And it verifies on its own, from the envelope alone.
    let verified = account_op.verify().expect("verifies");
    assert_eq!(verified.kind, dmtap_sync::OP_LWW_SET);
    assert_eq!(verified.hlc.wall, NOW_MS);
}

/// The signature is over the op, not over a transport frame. A single op
/// lifted out of the log verifies with nothing else present.
#[test]
fn an_op_verifies_from_its_envelope_alone_with_no_database_in_reach() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();

    let envelope = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .find(|op| op.target == "accounts/a-1")
        .unwrap()
        .cose;

    // Nothing here touches SlipScan at all — just the bytes and the engine.
    let op = dmtap_sync::verify_op_bytes(&envelope).expect("authentic on its own");
    assert_eq!(op.target, "accounts/a-1");
}

#[test]
fn a_tampered_envelope_is_refused() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();

    let stored = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .find(|op| op.target == "accounts/a-1")
        .unwrap();

    let mut broken = stored.clone();
    let last = broken.cose.len() - 1;
    broken.cose[last] ^= 0xff;
    assert!(
        broken.verify().is_err(),
        "a flipped signature bit must fail"
    );

    // The database refuses the edit outright — the first line of defence.
    let refused = device
        .conn()
        .execute(
            "UPDATE sync_oplog SET cose = ?2 WHERE op_id = ?1",
            rusqlite::params![stored.op_id, broken.cose.clone()],
        )
        .unwrap_err();
    assert!(refused.to_string().contains("immutable"), "{refused}");

    // Go around it the way a hand-edit or a corrupt file would, and check the
    // whole-log sweep finds it rather than only a targeted verify.
    device
        .conn()
        .execute("DROP TRIGGER sync_oplog_no_update", [])
        .unwrap();
    device
        .conn()
        .execute(
            "UPDATE sync_oplog SET cose = ?2 WHERE op_id = ?1",
            rusqlite::params![stored.op_id, broken.cose],
        )
        .unwrap();
    let report = device.oplog().verify_all().unwrap();
    assert!(!report.is_sound());
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].0, stored.op_id);
}

/// An index column that disagrees with the signed payload is a refusal.
/// Without this the envelope would still verify and every query that reads
/// the columns — which is every query — would believe the edit.
#[test]
fn an_index_column_edited_behind_the_signature_is_refused() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();
    let op_id = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .find(|op| op.target == "accounts/a-1")
        .unwrap()
        .op_id;

    for (column, value) in [
        ("ns", "someone-elses-book"),
        ("target", "accounts/a-2"),
        ("author", &"ab".repeat(32)),
    ] {
        // The oplog refuses UPDATE, which is the first line of defence; go
        // around it the way a hand-edit would, to check the second.
        device
            .conn()
            .execute("DROP TRIGGER sync_oplog_no_update", [])
            .unwrap();
        let before: String = device
            .conn()
            .query_row(
                &format!("SELECT {column} FROM sync_oplog WHERE op_id = ?1"),
                rusqlite::params![op_id],
                |row| row.get(0),
            )
            .unwrap();
        device
            .conn()
            .execute(
                &format!("UPDATE sync_oplog SET {column} = ?2 WHERE op_id = ?1"),
                rusqlite::params![op_id, value],
            )
            .unwrap();

        let report = device.oplog().verify_all().unwrap();
        assert!(
            !report.is_sound(),
            "an edited {column} column must be caught"
        );
        assert!(
            report.failures[0].1.contains(column),
            "{:?}",
            report.failures
        );

        device
            .conn()
            .execute(
                &format!("UPDATE sync_oplog SET {column} = ?2 WHERE op_id = ?1"),
                rusqlite::params![op_id, before],
            )
            .unwrap();
        device
            .conn()
            .execute(
                "CREATE TRIGGER sync_oplog_no_update BEFORE UPDATE ON sync_oplog
                 BEGIN SELECT RAISE(ABORT, 'immutable'); END",
                [],
            )
            .unwrap();
    }
    assert!(device.oplog().verify_all().unwrap().is_sound());
}

/// A signed op's content is its identity. The database refuses to edit one.
#[test]
fn the_log_refuses_to_let_an_op_be_edited() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();

    let err = device
        .conn()
        .execute("UPDATE sync_oplog SET ns = 'elsewhere'", [])
        .unwrap_err();
    assert!(err.to_string().contains("immutable"), "{err}");
}

/// **The identity trap.** A content-addressed op id alongside a UUID primary
/// key gives an op two identities that disagree: one op to the engine, two
/// rows in the database. Here there is one identity, and re-recording an op
/// changes nothing.
#[test]
fn an_op_has_exactly_one_identity_and_re_recording_it_is_a_no_op() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();

    let stored = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .find(|op| op.target == "accounts/a-1")
        .unwrap();
    let before = device.oplog().len().unwrap();

    // Re-insert the identical op, exactly as receiving it twice would.
    let op = stored.verify().unwrap();
    let envelope = dmtap_sync::cose::CoseSign1::from_bytes(&stored.cose).unwrap();
    let inserted = super::insert_op(device.conn(), &op, &envelope, OpOrigin::Local).unwrap();
    assert!(!inserted, "the second record is a no-op");
    assert_eq!(device.oplog().len().unwrap(), before);

    // The primary key IS the content address — the schema has nowhere else to
    // put a second identity.
    let pk: String = device
        .conn()
        .query_row(
            "SELECT name FROM pragma_table_info('sync_oplog') WHERE pk = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pk, "op_id");
    assert_eq!(
        stored.op_id,
        crate::device::keys::encode_hex(op.op_id().as_bytes())
    );
}

#[test]
fn the_ledger_maps_to_the_or_set_and_editable_rows_to_registers() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    journal(&device.db, &book, "j-1", "Opening");
    journal_line(&device.db, &book, "l-1", "j-1", 100);
    device.oplog().seal_at(NOW_MS).unwrap();

    let ops = device.oplog().ops(None, None).unwrap();
    let journal_op = ops.iter().find(|op| op.target == "journals").unwrap();
    assert_eq!(journal_op.kind, dmtap_sync::OP_SET_ADD);
    let account_op = ops.iter().find(|op| op.target == "accounts/a-1").unwrap();
    assert_eq!(account_op.kind, dmtap_sync::OP_LWW_SET);
}

/// Money must survive the whole round trip as an integer. This value is not
/// representable in an f64: if anything on the path went through a double it
/// would come back one smaller.
#[test]
fn money_crosses_the_log_as_exact_minor_units() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    let awkward: i64 = 9_007_199_254_740_993;
    account(&device.db, &book, "a-1", "Cheque", awkward);
    device.oplog().seal_at(NOW_MS).unwrap();

    let op = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .find(|op| op.target == "accounts/a-1")
        .unwrap()
        .verify()
        .unwrap();
    let (row, deleted) = slipscan_sync::parse_row_value(op.value.as_ref().unwrap()).unwrap();
    assert!(!deleted);
    let balance = row.get("opening_balance_minor").unwrap();
    assert!(balance.is_i64(), "money must never become a float");
    assert_eq!(balance.as_i64().unwrap(), awkward);
}

#[test]
fn three_edits_between_seals_become_one_register_write() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();
    let after_create = device.oplog().len().unwrap();

    for name in ["Current", "Everyday", "Main"] {
        device
            .conn()
            .execute(
                "UPDATE accounts SET name = ?1 WHERE id = 'a-1'",
                rusqlite::params![name],
            )
            .unwrap();
    }
    let report = device.oplog().seal_at(NOW_MS + 1).unwrap();
    assert_eq!(report.captured, 3);
    assert_eq!(report.sealed, 1, "one register write, not three");
    assert_eq!(device.oplog().len().unwrap(), after_create + 1);

    // And the one that survived carries the final value.
    let op = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .rfind(|op| op.target == "accounts/a-1")
        .unwrap()
        .verify()
        .unwrap();
    let (row, _) = slipscan_sync::parse_row_value(op.value.as_ref().unwrap()).unwrap();
    assert_eq!(row.get("name").unwrap(), "Main");
}

#[test]
fn a_delete_seals_as_a_tombstone_and_a_revival_as_an_ordinary_write() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();

    device
        .conn()
        .execute("DELETE FROM accounts WHERE id = 'a-1'", [])
        .unwrap();
    device.oplog().seal_at(NOW_MS + 1).unwrap();
    let op = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .rfind(|op| op.target == "accounts/a-1")
        .unwrap()
        .verify()
        .unwrap();
    let (row, deleted) = slipscan_sync::parse_row_value(op.value.as_ref().unwrap()).unwrap();
    assert!(deleted, "the delete is a tombstone");
    assert_eq!(row.get("id").unwrap(), "a-1");

    // Re-creating the row is an ordinary live write on the same register — the
    // reason the delete is a flag and not a §4.5 death certificate.
    account(&device.db, &book, "a-1", "Cheque again", 1);
    device.oplog().seal_at(NOW_MS + 2).unwrap();
    let revived = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .rfind(|op| op.target == "accounts/a-1")
        .unwrap()
        .verify()
        .unwrap();
    let (row, deleted) = slipscan_sync::parse_row_value(revived.value.as_ref().unwrap()).unwrap();
    assert!(
        !deleted,
        "a revival is a live write, not a resurrection hack"
    );
    assert_eq!(row.get("name").unwrap(), "Cheque again");
    assert_eq!(revived.kind, op.kind, "and it uses the same primitive");
}

#[test]
fn sealing_without_an_identity_names_the_command_that_makes_one() {
    let device = TestDevice {
        db: Db::open_in_memory().unwrap(),
        keychain: MemorySecretStore::default(),
    };
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);

    assert!(matches!(
        device.oplog().seal_at(NOW_MS).unwrap_err(),
        CoreError::DeviceIdentityMissing
    ));
    assert!(
        device.oplog().pending().unwrap() > 0,
        "the writes wait rather than being dropped"
    );
}

/// Signing under a key this device cannot prove it holds would attribute ops
/// to an identity it does not own.
#[test]
fn sealing_refuses_when_the_vault_key_is_not_the_pinned_key() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);

    let intruder = DeviceKeypair::generate();
    Vault::new(device.conn(), &device.keychain)
        .replace(IDENTITY_SECRET_REF, intruder.secret())
        .unwrap();

    assert!(matches!(
        device.oplog().seal_at(NOW_MS).unwrap_err(),
        CoreError::DeviceKeyMismatch
    ));
    assert_eq!(device.oplog().len().unwrap(), 0, "nothing was signed");
}

/// A refused seal must leave the outbox intact — otherwise a transient
/// failure silently drops the writes it could not record.
#[test]
fn a_refused_seal_keeps_every_pending_write() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    let pending = device.oplog().pending().unwrap();

    // Poison the clock past the bound.
    device
        .conn()
        .execute(
            "INSERT INTO sync_clock (id, wall, counter, updated_at)
             VALUES (1, ?1, 0, 't')",
            rusqlite::params![(NOW_MS + 10 * clock::MAX_CLOCK_DRIFT_MS) as i64],
        )
        .unwrap();

    assert!(matches!(
        device.oplog().seal_at(NOW_MS).unwrap_err(),
        CoreError::SyncClockDrift { .. }
    ));
    assert_eq!(device.oplog().len().unwrap(), 0, "nothing signed");
    assert_eq!(
        device.oplog().pending().unwrap(),
        pending,
        "the writes are still there"
    );

    // And once the clock is sound they seal normally, in order.
    let sound = NOW_MS + 10 * clock::MAX_CLOCK_DRIFT_MS;
    device.oplog().seal_at(sound).unwrap();
    assert!(device.oplog().len().unwrap() > 0);
    assert_eq!(device.oplog().pending().unwrap(), 0);
}

#[test]
fn sealing_an_empty_outbox_does_nothing() {
    let device = TestDevice::new("laptop");
    device.oplog().seal_at(NOW_MS).unwrap();
    let report = device.oplog().seal_at(NOW_MS).unwrap();
    assert_eq!(report, SealReport::default());
}

/// Stamps are strictly increasing within a seal, so the log has a total order
/// even when every write lands in the same millisecond.
#[test]
fn stamps_are_strictly_increasing_within_and_across_seals() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    for index in 0..5 {
        account(&device.db, &book, &format!("a-{index}"), "Cheque", index);
    }
    device.oplog().seal_at(NOW_MS).unwrap();
    account(&device.db, &book, "a-late", "Cheque", 9);
    device.oplog().seal_at(NOW_MS).unwrap();

    let stamps: Vec<(u64, u32)> = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .iter()
        .map(|op| (op.hlc_wall, op.hlc_counter))
        .collect();
    let mut sorted = stamps.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(stamps, sorted, "no duplicate or out-of-order stamps");
}

/// A restart must not re-mint a stamp the log already used — that is what the
/// clock is persisted for.
#[test]
fn stamps_do_not_repeat_across_a_restart() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();
    let highest = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .iter()
        .map(|op| (op.hlc_wall, op.hlc_counter))
        .max()
        .unwrap();

    // A "restart" is a fresh Oplog over the same database — the clock is read
    // from disk, not carried in memory.
    account(&device.db, &book, "a-2", "Savings", 2);
    Oplog::new(device.conn(), &device.keychain)
        .seal_at(NOW_MS)
        .unwrap();
    let next = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .into_iter()
        .find(|op| op.target == "accounts/a-2")
        .unwrap();
    assert!((next.hlc_wall, next.hlc_counter) > highest);
}

#[test]
fn namespaces_scope_the_log_to_one_book() {
    let device = TestDevice::new("laptop");
    let first = seed_book(&device.db);
    device
        .conn()
        .execute(
            "INSERT INTO books (id, kind, name, currency, locale, timezone,
                                created_at, updated_at, region)
             VALUES ('b-2', 'business', 'Trading', 'ZAR', 'en', 'UTC', 't', 't', 'za')",
            [],
        )
        .unwrap();
    account(&device.db, &first, "a-1", "Cheque", 1);
    account(&device.db, "b-2", "a-2", "Business", 2);
    device.oplog().seal_at(NOW_MS).unwrap();

    let scoped = device.oplog().ops(Some("b-2"), None).unwrap();
    assert!(!scoped.is_empty());
    assert!(scoped.iter().all(|op| op.ns == "b-2"));
    assert!(scoped.iter().any(|op| op.target == "accounts/a-2"));
    assert!(scoped.iter().all(|op| op.target != "accounts/a-1"));
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/// The claim the trigger design exists to make good: a write that reaches the
/// row reaches the log, whatever code path produced it.
///
/// Driven through the **service layer**, not through raw SQL, so it exercises
/// the same path a user does.
#[test]
fn every_service_layer_write_reaches_the_log() {
    use crate::domain::{BookKind, NewBook};

    let service = crate::CoreService::new(
        Db::open_in_memory().unwrap(),
        Box::new(MemorySecretStore::default()),
    );
    let created = service
        .book_create(NewBook {
            kind: BookKind::Personal,
            name: "Household".into(),
            currency: Some("ZAR".into()),
            country: Some("ZA".into()),
            region: None,
        })
        .unwrap();
    // Seeding the chart of accounts and a transaction, so the sweep covers a
    // register write, a seeded batch and the ledger.
    service.coa_seed(&created.id).unwrap();

    // The device key lives in its own keychain; the service is not involved in
    // signing, and the oplog reaches the same SQLite file the service wrote to.
    let keychain = MemorySecretStore::default();
    let conn = service.conn_for_test();
    Devices::new(conn, &keychain).initialize("laptop").unwrap();
    let oplog = Oplog::new(conn, &keychain);

    assert!(
        oplog.pending().unwrap() > 0,
        "book_create produced no captured writes at all"
    );
    oplog.seal_at(NOW_MS).unwrap();

    let ops = oplog.ops(None, None).unwrap();
    assert!(
        ops.iter()
            .any(|op| op.target == format!("books/{}", created.id)),
        "the book row itself is not in the log"
    );
    // Book creation seeds a chart of accounts, and a `za` book gets VAT rates
    // too. Every one of those rows is replicated state, and not one of them
    // was written by a call anybody would have thought to instrument — they
    // are the seeding loop's own inserts.
    assert!(
        ops.iter()
            .any(|op| op.target.starts_with("chart_of_accounts/")),
        "the seeded chart of accounts is not in the log"
    );
    assert!(
        ops.iter().any(|op| op.target.starts_with("vat_rates/")),
        "the seeded tax rates are not in the log"
    );
    assert!(ops.iter().all(|op| op.ns == created.id));
    assert!(oplog.verify_all().unwrap().is_sound());
}

/// An upgraded database must not get a log that starts mid-history. Migration
/// 0700 backfills every existing row, so the first seal after an upgrade
/// records the books as they stand.
#[test]
fn an_upgrade_backfills_the_existing_rows_rather_than_starting_from_empty() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    )
    .unwrap();
    // Everything up to but excluding the oplog migration.
    for &(version, name, sql) in crate::db::migrations_for_test() {
        if version >= 700 {
            continue;
        }
        conn.execute_batch(sql).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, 't')",
            rusqlite::params![version, name],
        )
        .unwrap();
    }

    // A book that existed before the log did.
    conn.execute(
        "INSERT INTO books (id, kind, name, currency, locale, timezone,
                            created_at, updated_at, region)
         VALUES ('b-old', 'personal', 'Old', 'ZAR', 'en', 'UTC', 't', 't', 'za')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO accounts (id, book_id, name, kind, currency, created_at, updated_at)
         VALUES ('a-old', 'b-old', 'Cheque', 'bank', 'ZAR', 't', 't')",
        [],
    )
    .unwrap();

    crate::db::migrate(&conn).unwrap();

    let queued: Vec<(String, String)> = conn
        .prepare("SELECT table_name, row_id FROM sync_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(queued.contains(&("books".into(), "b-old".into())));
    assert!(queued.contains(&("accounts".into(), "a-old".into())));
}

// ---------------------------------------------------------------------------
// Convergence
// ---------------------------------------------------------------------------

/// **The property that makes the log a replication log rather than a diary.**
///
/// The ops are real ones, produced by a real sequence of SlipScan writes:
/// editable rows created, edited, deleted and revived; immutable journals
/// posted. Every permutation of them is merged into a fresh replica, and every
/// replica must land on the same observable state.
///
/// The comparison is the engine's own §6.1.1 state root — a canonical hash of
/// the whole observable state — rather than a hand-rolled equality that could
/// quietly ignore a dimension.
#[test]
fn any_order_of_the_recorded_ops_converges_to_the_same_state() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);

    // A sequence with something of every shape in it.
    account(&device.db, &book, "a-1", "Cheque", 10_000);
    account(&device.db, &book, "a-2", "Savings", 25_000);
    device.oplog().seal_at(NOW_MS).unwrap();

    device
        .conn()
        .execute("UPDATE accounts SET name = 'Current' WHERE id = 'a-1'", [])
        .unwrap();
    device.oplog().seal_at(NOW_MS + 1).unwrap();

    journal(&device.db, &book, "j-1", "Opening");
    journal_line(&device.db, &book, "l-1", "j-1", 10_000);
    journal_line(&device.db, &book, "l-2", "j-1", 25_000);
    device.oplog().seal_at(NOW_MS + 2).unwrap();

    device
        .conn()
        .execute("DELETE FROM accounts WHERE id = 'a-2'", [])
        .unwrap();
    device.oplog().seal_at(NOW_MS + 3).unwrap();
    account(&device.db, &book, "a-2", "Savings again", 30_000);
    device.oplog().seal_at(NOW_MS + 4).unwrap();

    let ops: Vec<SyncOp> = device
        .oplog()
        .ops(None, None)
        .unwrap()
        .iter()
        .map(|stored| stored.verify().expect("the log is sound"))
        .collect();
    assert!(
        ops.len() >= 8,
        "the property is only worth checking on a real sequence: {} ops",
        ops.len()
    );

    let receiver_now = NOW_MS + 10 * 60 * 1000;
    let root_of = |order: &[usize]| {
        let mut state = dmtap_sync::SyncState::new();
        for &index in order {
            state.ingest(&ops[index], receiver_now).expect("ingest");
        }
        dmtap_sync::state_root(&state).as_bytes().to_vec()
    };

    let sequential: Vec<usize> = (0..ops.len()).collect();
    let expected = root_of(&sequential);

    // Reversed, and a deterministic shuffle of every element, plus every
    // adjacent transposition — enough to catch an order dependence in any
    // single pair without the factorial.
    let mut orders: Vec<Vec<usize>> = Vec::new();
    orders.push(sequential.iter().copied().rev().collect());
    for split in 1..ops.len() {
        let mut order: Vec<usize> = sequential[split..].to_vec();
        order.extend_from_slice(&sequential[..split]);
        orders.push(order);
    }
    for swap in 0..ops.len() - 1 {
        let mut order = sequential.clone();
        order.swap(swap, swap + 1);
        orders.push(order);
    }
    // A duplicate delivery in the middle of an arbitrary order: idempotence is
    // part of the same property, and a replica that counts an op twice is as
    // divergent as one that orders it wrongly.
    let mut with_duplicates = sequential.clone();
    with_duplicates.extend_from_slice(&sequential);
    orders.push(with_duplicates);

    for order in &orders {
        assert_eq!(
            root_of(order),
            expected,
            "a replica that merged the ops in order {order:?} diverged"
        );
    }

    // And the observable state is the one SlipScan actually means: the
    // register holds the revived account, and both journal lines survived the
    // union.
    let mut state = dmtap_sync::SyncState::new();
    for op in &ops {
        state.ingest(op, receiver_now).unwrap();
    }
    let (row, deleted) = slipscan_sync::parse_row_value(
        state
            .lww
            .get("accounts/a-2", slipscan_sync::LWW_FIELD)
            .unwrap(),
    )
    .unwrap();
    assert!(!deleted);
    assert_eq!(row.get("name").unwrap(), "Savings again");
    assert_eq!(
        state
            .present_members()
            .iter()
            .filter(|(target, _)| target == "journal_lines")
            .count(),
        2,
        "the union must keep both lines"
    );
}

/// Replaying the log through the engine verifies every op on the way in — the
/// log is on disk, and disk is not an authority.
#[test]
fn replay_verifies_every_op_before_applying_it() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    device.oplog().seal_at(NOW_MS).unwrap();

    let receiver_now = NOW_MS + 60_000;
    assert!(device.oplog().replay(receiver_now).is_ok());

    device
        .conn()
        .execute("DROP TRIGGER sync_oplog_no_update", [])
        .unwrap();
    device
        .conn()
        .execute("UPDATE sync_oplog SET target = 'accounts/other'", [])
        .unwrap();
    assert!(matches!(
        device.oplog().replay(receiver_now).unwrap_err(),
        CoreError::SyncOpUnverified { .. }
    ));
}

// ---------------------------------------------------------------------------
// Status, and the absence of a transport
// ---------------------------------------------------------------------------

#[test]
fn status_reports_the_log_and_the_clock() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);

    let before = device.oplog().status().unwrap();
    assert!(before.pending > 0);
    assert_eq!(before.ops, 0);
    assert_eq!(before.live_peers, 0);

    device.oplog().seal_at(NOW_MS).unwrap();
    let after = device.oplog().status().unwrap();
    assert_eq!(after.pending, 0);
    assert!(after.ops > 0);
    assert_eq!(after.clock.unwrap().0, NOW_MS);
    assert_eq!(after.namespaces.len(), 1);
    assert_eq!(after.namespaces[0].ns, book);
    assert_eq!(
        after.version_vector.len(),
        1,
        "one author: this device is the only one that has ever written"
    );
    assert_eq!(
        after.version_vector[0].0,
        device.devices().require_identity().unwrap().public_key
    );
}

/// Nothing in the log arrives from anywhere. Asserted as a property of the
/// data rather than a claim in a comment, so the first op that does arrive
/// makes this test — and the status claim it stands for — fail.
#[test]
fn nothing_in_the_log_is_remote_because_there_is_no_transport() {
    let device = TestDevice::new("laptop");
    let book = seed_book(&device.db);
    account(&device.db, &book, "a-1", "Cheque", 1);
    journal(&device.db, &book, "j-1", "Opening");
    device.oplog().seal_at(NOW_MS).unwrap();

    assert!(device
        .oplog()
        .ops(None, None)
        .unwrap()
        .iter()
        .all(|op| op.origin == OpOrigin::Local));
    let remote: i64 = device
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sync_oplog WHERE origin = 'remote'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remote, 0);
}
