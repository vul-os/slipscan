//! SlipScan's replicated state, expressed in the shared DMTAP Sync algebra
//! (`substrate/SYNC.md` capability ③).
//!
//! # What this crate is, and is not
//!
//! It is the **mapping**: it turns a SlipScan row change into a substrate op,
//! and turns a stream of substrate ops back into rows. The algebra itself —
//! which write wins, how two replicas converge — lives in `dmtap-sync` and is
//! not reimplemented here. That is the entire point of adopting a shared
//! engine, and re-deriving any of it locally would forfeit it.
//!
//! It is **not** transport, storage or identity. SlipScan keeps its own SQLite
//! file, its own data folder and its own OS-keychain vault; nothing here opens
//! a socket or touches the filesystem.
//!
//! SlipScan is a native Rust product, so `dmtap-sync` is an ordinary crate
//! dependency. The Go and JavaScript surfaces reach the same compiled core
//! through a WASM ABI and pay for the runtime that requires — FlowStock's
//! binary grew 3.58 MiB, almost all of it the WASM compiler rather than the
//! engine. This crate pays none of that.
//!
//! # The mapping, and why each primitive was chosen
//!
//! `SYNC.md` §4.10 requires an implementation to document, per modelled
//! object, which primitive it chose and its answer to the selection test. The
//! obligation is not ceremony: choosing §4.5 where §4.4 belongs is silent,
//! permanent, converged data loss, and choosing §4.4 where §4.5 belongs is a
//! resurrection bug. SlipScan models two kinds of thing.
//!
//! ## Editable rows → §4.4 LWW register ([`Kind::LwwSet`])
//!
//! Books, accounts, categories, transactions, transaction splits, merchant
//! mappings, budgets, members, locations, contacts, the chart of accounts, its
//! entity map, the VAT-rate table, and the product catalogue (product
//! categories, products, product variants) — the full list is [`LWW_TABLES`].
//!
//! ```text
//! target  "<table>/<row-id>"      field "row"
//! value   tstr, "v" + canonical JSON of the row       (live)
//!         tstr, "x" + canonical JSON of {"id": "…"}   (deleted)
//! ```
//!
//! A **live** write carries the whole row. A **tombstone** carries identity
//! only, because that is all a tombstone needs and all the producer still has:
//! the delete is observed after the row is gone (see `slipscan-core`'s
//! `sync::capture` — the outbox records that a row died, and the row itself is
//! no longer there to read). Reviving the row is an ordinary live write
//! carrying full content again, so nothing is lost by not embalming it.
//!
//! These are rows a person edits: recategorising a transaction, renaming an
//! account, moving a budget limit. Last-writer-wins is what a user means by
//! editing the same row on two devices, so §4.4 is the faithful mapping.
//!
//! The delete flag is deliberately **not** a §4.5 death certificate. The
//! selection test — *is there any user action that restores this thing, using
//! the same ordinary operation that created it?* — is answered yes: SlipScan
//! deletes a category or an account by flag and re-creates it with the same
//! ordinary write. Modelling that as a certificate that dominates every later
//! write would leave a re-created account invisible on every replica, with no
//! error anywhere. §4.1.1 prescribes exactly this discriminated-value shape for
//! a state `ext-value` cannot spell, since it has no null.
//!
//! One register per row rather than per column, because that is what SlipScan's
//! repo layer does: an update writes the whole row. §4.1.1 places granularity
//! in the address space, so per-column concurrency is available later by making
//! `field` the column name — deliberately not taken here, because it would be a
//! behaviour change rather than a faithful mapping.
//!
//! ## Posted journals and their lines → §4.3 OR-Set ([`Kind::SetAdd`])
//!
//! ```text
//! target  "journals" / "journal_lines"
//! value   tstr, "v" + canonical JSON of the row including its id
//! ```
//!
//! SlipScan's ledger is immutable by construction: a posted journal is never
//! edited, and a correction is a **reversal** — a new journal carrying
//! `reversal_of`. That is not merely a convention in the repo layer; migration
//! `0101_ledger_hardening` installs `BEFORE UPDATE` and `BEFORE DELETE`
//! triggers on both tables that `RAISE(ABORT)`, so SQLite itself refuses. A
//! replication path cannot mutate a posted journal even by mistake, because the
//! statement never reaches the row.
//!
//! No set-remove is ever minted, so this is an OR-Set with no removes, which is
//! a grow-only set whose merge is plain union. The mapping is therefore an
//! identity on SlipScan's existing behaviour rather than a new one that has to
//! be re-validated against the books. [`op_for_write`] refuses a ledger delete
//! rather than mapping it onto anything.
//!
//! ### §4.3 identifies an element BY ITS VALUE
//!
//! That is the trap that cost a sibling product a stock movement: two
//! genuinely distinct facts that happened to serialize identically collapsed
//! into one under union, and a −2 became a −1. It does not bite here, and the
//! reason is worth stating rather than assuming — every ledger row carries its
//! own UUID v7 `id` inside the payload, minted once at creation. Two distinct
//! journal lines with the same account, amount, description and order still
//! differ in `id`, so the union keeps both. [`tests::two_ledger_rows_alike_in_
//! everything_but_id_both_survive_the_union`] holds that, because the property
//! that matters is "distinct facts survive", not "the payload has an id field".
//!
//! Adding a table to [`LEDGER_TABLES`] whose rows have no unique id would
//! reintroduce the trap, which is the other reason the table set is data
//! rather than a naming convention.
//!
//! A PN-counter (§4.6) would be the wrong reach even though balances are sums:
//! §4.6 is for a scalar whose history need not be retained, and it would
//! converge on the right total while discarding the journal. Double-entry
//! accounting is the history.
//!
//! # Money never becomes a float
//!
//! §4.1 excludes floats from `ext-value` entirely. For a product carrying
//! `REAL` money columns that is an obstacle — FlowStock had to push its rows
//! through an opaque canonical payload for exactly this reason.
//!
//! SlipScan has the opposite problem, which is to say none: **money is `i64`
//! minor units** in every column that holds it (`amount_minor`,
//! `debit_minor`, `credit_minor`, `share_minor`, `opening_balance_minor`, …)
//! and floats are banned from money math throughout. A minor-unit integer
//! crosses the wire inside the row payload as a JSON integer and comes back
//! bit-identical: exact by construction, with no rounding step anywhere to get
//! wrong. The substrate's no-float rule costs SlipScan nothing.
//!
//! [`decimal_value`] exists for the one place SlipScan holds a non-integer
//! *rate* rather than an amount — an FX rate — and encodes it as its canonical
//! text form, which is exact and round-trips through `parse`. It is never a
//! money amount.
//!
//! # Feature-gated
//!
//! Everything below is behind the `sync-dmtap` feature, **default-on** since
//! the engine was published to crates.io. It was default-off only while
//! `dmtap-sync` was a git dependency, which cargo fetches during resolution
//! regardless of which features are active; a registry dependency resolves
//! from the committed `Cargo.lock` with no network at all, which is what let
//! this crate rejoin the workspace.
//!
//! The gate is written per item rather than as a crate-level
//! `#![cfg(feature = "sync-dmtap")]`, and that is deliberate: a crate-level
//! gate strips *every* item in this file when the feature is off, including a
//! test, so `--no-default-features` would compile an empty crate, run zero
//! tests and print `test result: ok`. Per-item gating leaves room for the
//! `feature_gate` guard below, which fails that run and says what was not
//! checked. The library itself is still empty and dependency-free without the
//! feature — the guard is `cfg(test)`-only and links nothing.

/// Fails a bare `cargo test` on this crate, on purpose.
///
/// The whole mapping and its suite are behind `sync-dmtap`, so without the
/// feature there is nothing to test — and a test runner that reports success
/// for having verified nothing is worse than one that reports failure. This
/// module is the loud skip: it names the suite that did not run and the exact
/// command that runs it.
///
/// CI passes the feature, so this never fires there; it fires for a developer
/// who typed the short command and would otherwise have believed it.
#[cfg(all(test, not(feature = "sync-dmtap")))]
mod feature_gate {
    /// Not a broken build — a refused false green. See the module docs.
    #[test]
    fn dmtap_mapping_suite_did_not_run() {
        panic!(
            "\n\
             slipscan-sync was tested WITHOUT the `sync-dmtap` feature, so nothing was\n\
             verified: the whole mapping and the whole suite in src/lib.rs are gated on it.\n\
             \n\
             Not run: every test in `mod tests` — the primitive selection per table, the\n\
             ledger-delete refusal, the unmapped-table refusal, the OR-Set element-identity\n\
             property, the tombstone round trip, and the canonical-JSON guarantees.\n\
             \n\
             The feature is ON by default. Reaching this means --no-default-features was\n\
             passed. Run the suite with:\n\
             \x20 cargo test -p slipscan-sync\n"
        );
    }
}

#[cfg(feature = "sync-dmtap")]
use dmtap_sync::{Hlc, SVal, SyncOp, OP_LWW_SET, OP_SET_ADD};
#[cfg(feature = "sync-dmtap")]
use rust_decimal::Decimal;

/// The substrate op kinds this mapping emits.
///
/// Read from `dmtap-sync` rather than hard-coded, because `SYNC.md`'s own
/// adoption notes say never to hard-code the discriminators.
#[cfg(feature = "sync-dmtap")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// §4.4 last-writer-wins register — an editable row.
    LwwSet,
    /// §4.3 OR-Set add — an immutable ledger fact.
    SetAdd,
}

#[cfg(feature = "sync-dmtap")]
impl Kind {
    /// The wire discriminator for this kind.
    pub fn code(self) -> u8 {
        match self {
            Kind::LwwSet => OP_LWW_SET,
            Kind::SetAdd => OP_SET_ADD,
        }
    }
}

/// The single register per editable row. Named rather than empty so the address
/// space stays open for a later per-column split (§4.1.1).
#[cfg(feature = "sync-dmtap")]
pub const LWW_FIELD: &str = "row";

/// The §4.1.1 address of an editable row's register.
///
/// One function rather than a `format!` at each site, because the producer and
/// any future consumer must agree on it byte-for-byte: two spellings of the
/// same row's address are two registers, and neither ever sees the other's
/// writes.
#[cfg(feature = "sync-dmtap")]
pub fn lww_target(table: &str, id: &str) -> String {
    format!("{table}/{id}")
}

/// Split a [`lww_target`] back into `(table, row-id)`.
///
/// Row ids are UUID v7 and contain no `/`, so the first separator is the only
/// one. Returns `None` for an address that is not of this shape rather than
/// guessing at a table name.
#[cfg(feature = "sync-dmtap")]
pub fn parse_lww_target(target: &str) -> Option<(&str, &str)> {
    let (table, id) = target.split_once('/')?;
    if table.is_empty() || id.is_empty() {
        return None;
    }
    Some((table, id))
}

/// Tables whose rows are immutable ledger facts, merged by union.
///
/// Kept as data rather than as a predicate on the table name so that adding a
/// table is a deliberate act with a matching mapping decision, not something a
/// naming convention can do by accident. Every row in every one of these
/// tables carries a unique `id` in its payload — see the §4.3 note in the
/// module docs for why that is load-bearing rather than incidental.
#[cfg(feature = "sync-dmtap")]
pub const LEDGER_TABLES: &[&str] = &["journals", "journal_lines"];

/// Tables whose rows are editable and merge last-writer-wins.
///
/// Also data, and for a sharper reason than [`LEDGER_TABLES`]: [`kind_for`]
/// used to answer "LWW" for *any* string, so a typo'd or brand-new table name
/// silently acquired a mapping nobody chose. Both lists are now closed, and an
/// unlisted table is a [`MapError::UnmappedTable`] refusal.
///
/// `slipscan-core`'s migration `0700_oplog` installs one capture trigger set
/// per table named here, and its `sync::capture::tests` assert the two agree
/// in both directions — a table in this list with no trigger, or a trigger for
/// a table not in this list, fails the suite.
#[cfg(feature = "sync-dmtap")]
pub const LWW_TABLES: &[&str] = &[
    "books",
    "accounts",
    "categories",
    "transactions",
    "transaction_splits",
    "merchant_mappings",
    "budgets",
    "members",
    "locations",
    "chart_of_accounts",
    "coa_map",
    "vat_rates",
    "contacts",
    "product_categories",
    "products",
    "product_variants",
];

/// Whether `table` is an immutable ledger, and so maps to the OR-Set.
#[cfg(feature = "sync-dmtap")]
pub fn is_ledger(table: &str) -> bool {
    LEDGER_TABLES.contains(&table)
}

/// Whether `table` replicates at all.
#[cfg(feature = "sync-dmtap")]
pub fn is_replicated(table: &str) -> bool {
    is_ledger(table) || LWW_TABLES.contains(&table)
}

/// Every replicated table, ledger tables last.
#[cfg(feature = "sync-dmtap")]
pub fn replicated_tables() -> Vec<&'static str> {
    LWW_TABLES
        .iter()
        .chain(LEDGER_TABLES.iter())
        .copied()
        .collect()
}

/// The primitive `table` maps to, or a refusal.
///
/// **Fails closed on an unknown table.** The previous signature was infallible
/// and answered [`Kind::LwwSet`] for anything it did not recognise, which is
/// the worst possible default: a ledger table whose name was misspelled at a
/// call site would have been mapped to a register, and a register overwrites
/// where a set unions. Silent, permanent, converged data loss — exactly what
/// §4.10's selection test exists to prevent.
#[cfg(feature = "sync-dmtap")]
pub fn kind_for(table: &str) -> Result<Kind, MapError> {
    if is_ledger(table) {
        Ok(Kind::SetAdd)
    } else if LWW_TABLES.contains(&table) {
        Ok(Kind::LwwSet)
    } else {
        Err(MapError::UnmappedTable(table.to_owned()))
    }
}

#[cfg(feature = "sync-dmtap")]
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MapError {
    /// A ledger table has no concept of deletion; a correction is a reversal.
    #[error("{0} is an immutable ledger: correct it with a reversal, never a delete")]
    LedgerDelete(String),
    /// Row payloads must be JSON objects so the id can be carried inside them.
    #[error("row payload must be a JSON object, got {0}")]
    NotAnObject(&'static str),
    /// The table has no mapping decision recorded, so it has no primitive.
    /// Never guessed at — see [`kind_for`].
    #[error(
        "{0} has no sync mapping: add it to LWW_TABLES or LEDGER_TABLES with a \
         §4.10 selection-test answer, or leave it device-local"
    )]
    UnmappedTable(String),
}

/// A decimal as an exact `ext-value`.
///
/// Text, not a float: §4.1 has no float, and SlipScan has no float in money
/// either, so this loses nothing. `Decimal`'s `to_string` is exact and
/// round-trips through `parse`.
#[cfg(feature = "sync-dmtap")]
pub fn decimal_value(d: Decimal) -> SVal {
    SVal::Text(d.to_string())
}

/// Canonical JSON for a row payload: object keys sorted, no insignificant
/// whitespace.
///
/// §4.1.1 permits an opaque payload but places the canonicalisation obligation
/// on the producer — two replicas that encode the same row differently would
/// compare as different values and never converge. `serde_json::Value`'s map is
/// a `BTreeMap` under the `preserve_order`-off default, so serialisation is
/// already key-sorted; this function exists to make that a stated guarantee
/// rather than an inherited accident, and to reject non-objects.
#[cfg(feature = "sync-dmtap")]
pub fn canonical_json(row: &serde_json::Value) -> Result<String, MapError> {
    match row {
        serde_json::Value::Object(_) => Ok(row.to_string()),
        serde_json::Value::Null => Err(MapError::NotAnObject("null")),
        serde_json::Value::Array(_) => Err(MapError::NotAnObject("array")),
        _ => Err(MapError::NotAnObject("scalar")),
    }
}

/// The discriminated LWW payload: `"v"` live, `"x"` deleted (§4.1.1).
#[cfg(feature = "sync-dmtap")]
fn row_value(row: &serde_json::Value, deleted: bool) -> Result<SVal, MapError> {
    let tag = if deleted { "x" } else { "v" };
    Ok(SVal::Text(format!("{tag}{}", canonical_json(row)?)))
}

/// Mint the op for a write to `table`/`id`.
///
/// An editable row becomes an LWW register write; a ledger row becomes a
/// set-add. Deleting a ledger row is refused rather than silently mapped, so a
/// caller that tries gets an error instead of a converged hole in the books.
#[cfg(feature = "sync-dmtap")]
pub fn op_for_write(
    ns: &str,
    table: &str,
    id: &str,
    row: &serde_json::Value,
    deleted: bool,
    hlc: Hlc,
) -> Result<SyncOp, MapError> {
    match kind_for(table)? {
        Kind::SetAdd => {
            if deleted {
                return Err(MapError::LedgerDelete(table.to_owned()));
            }
            Ok(SyncOp {
                kind: Kind::SetAdd.code(),
                ns: ns.to_owned(),
                target: table.to_owned(),
                field: None,
                value: Some(row_value(row, false)?),
                hlc,
                observed: None,
                reference: None,
            })
        }
        Kind::LwwSet => Ok(SyncOp {
            kind: Kind::LwwSet.code(),
            ns: ns.to_owned(),
            target: lww_target(table, id),
            field: Some(LWW_FIELD.to_owned()),
            value: Some(row_value(row, deleted)?),
            hlc,
            observed: None,
            reference: None,
        }),
    }
}

/// Read a LWW register payload back into `(row, deleted)`.
#[cfg(feature = "sync-dmtap")]
pub fn parse_row_value(v: &SVal) -> Option<(serde_json::Value, bool)> {
    let SVal::Text(s) = v else { return None };
    let (tag, body) = s.split_at_checked(1)?;
    let deleted = match tag {
        "v" => false,
        "x" => true,
        _ => return None,
    };
    serde_json::from_str(body).ok().map(|row| (row, deleted))
}

/// The real suite. Gated with the mapping it tests — the `feature_gate` module
/// above is what stops its absence from reading as success.
#[cfg(all(test, feature = "sync-dmtap"))]
mod tests {
    use super::*;

    fn hlc(wall: u64, author: u8) -> Hlc {
        Hlc {
            wall,
            counter: 0,
            author: vec![author; 32],
        }
    }

    fn row(json: &str) -> serde_json::Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn editable_rows_are_lww_registers() {
        let op = op_for_write(
            "book-1",
            "accounts",
            "acc-1",
            &row(r#"{"name":"Cheque","kind":"bank"}"#),
            false,
            hlc(10, 1),
        )
        .unwrap();
        assert_eq!(op.kind, OP_LWW_SET);
        assert_eq!(op.target, "accounts/acc-1");
        assert_eq!(op.field.as_deref(), Some(LWW_FIELD));
    }

    #[test]
    fn ledger_rows_are_set_adds_keyed_by_table() {
        let op = op_for_write(
            "book-1",
            "journals",
            "j-1",
            &row(r#"{"id":"j-1","narrative":"Opening"}"#),
            false,
            hlc(10, 1),
        )
        .unwrap();
        assert_eq!(op.kind, OP_SET_ADD);
        // The OR-Set's target is the collection; the row's identity lives in
        // the element, which is why the payload must carry its own id.
        assert_eq!(op.target, "journals");
        assert!(op.field.is_none());
    }

    /// The ledger has no delete. A correction is a reversal journal, so a
    /// caller asking to delete one is confused and is told so, rather than
    /// having the request mapped onto something that converges.
    #[test]
    fn deleting_a_ledger_row_is_refused() {
        let err = op_for_write(
            "book-1",
            "journals",
            "j-1",
            &row(r#"{"id":"j-1"}"#),
            true,
            hlc(10, 1),
        )
        .unwrap_err();
        assert_eq!(err, MapError::LedgerDelete("journals".into()));
    }

    /// A delete must stay an ordinary write, so that re-creating the row is an
    /// ordinary write too. If this ever became a §4.5 death certificate, the
    /// re-created row would be invisible on every replica.
    #[test]
    fn a_deleted_row_round_trips_and_can_be_revived() {
        let r = row(r#"{"name":"Groceries"}"#);
        let del = op_for_write("b", "categories", "c-1", &r, true, hlc(10, 1)).unwrap();
        let (back, deleted) = parse_row_value(del.value.as_ref().unwrap()).unwrap();
        assert!(deleted);
        assert_eq!(back, r);

        let live = op_for_write("b", "categories", "c-1", &r, false, hlc(11, 1)).unwrap();
        let (_, deleted) = parse_row_value(live.value.as_ref().unwrap()).unwrap();
        assert!(!deleted, "revival must be an ordinary live write");
        assert_eq!(live.kind, del.kind, "revival uses the same primitive");
    }

    /// Money is exact. §4.1 has no float and neither does SlipScan.
    #[test]
    fn decimals_encode_exactly() {
        let d: Decimal = "1234.5600".parse().unwrap();
        let SVal::Text(s) = decimal_value(d) else {
            panic!("decimal must encode as text, never a float")
        };
        assert_eq!(s, "1234.5600");
        assert_eq!(s.parse::<Decimal>().unwrap(), d);
    }

    #[test]
    fn canonical_json_rejects_non_objects() {
        assert!(canonical_json(&row(r#"{"a":1}"#)).is_ok());
        assert_eq!(
            canonical_json(&serde_json::Value::Null).unwrap_err(),
            MapError::NotAnObject("null")
        );
    }

    /// Two replicas encoding the same row must produce byte-identical values,
    /// or the LWW comparison is meaningless.
    #[test]
    fn canonical_json_is_key_order_independent() {
        let a = canonical_json(&row(r#"{"b":2,"a":1}"#)).unwrap();
        let b = canonical_json(&row(r#"{"a":1,"b":2}"#)).unwrap();
        assert_eq!(a, b);
    }

    /// **The trap this programme has already hit.** §4.3 identifies a set
    /// element by its value, so two genuinely distinct facts that serialize
    /// identically merge into one — a sibling product turned a −2 into a −1
    /// exactly this way.
    ///
    /// SlipScan's ledger rows carry their own UUID v7 `id`, so two lines alike
    /// in every accounting respect still differ. This test holds *that*, not
    /// the weaker "the payload happens to contain an id".
    #[test]
    fn two_ledger_rows_alike_in_everything_but_id_both_survive_the_union() {
        // The same amount, account, description and order, posted twice — a
        // real double charge that must not be silently deduplicated.
        let make = |id: &str, hlc_wall: u64| {
            op_for_write(
                "book-1",
                "journal_lines",
                id,
                &row(&format!(
                    r#"{{"id":"{id}","journal_id":"j-1","coa_id":"c-1",
                        "debit_minor":250,"credit_minor":0,"currency":"ZAR",
                        "description":"Coffee","line_order":0}}"#
                )),
                false,
                hlc(hlc_wall, 1),
            )
            .unwrap()
        };
        let first = make("0190a1b2-0000-7000-8000-000000000001", 10);
        let second = make("0190a1b2-0000-7000-8000-000000000002", 11);

        assert_eq!(first.target, second.target, "same OR-Set target");
        assert_ne!(
            first.value, second.value,
            "two distinct movements must be two distinct elements, or the union \
             collapses them and the books lose one"
        );

        // And the union really does keep two, checked through the engine
        // rather than by eyeballing the values.
        let mut state = dmtap_sync::SyncState::new();
        let now = 20_000;
        state.ingest(&first, now).unwrap();
        state.ingest(&second, now).unwrap();
        assert_eq!(state.present_members().len(), 2);
    }

    /// The same op ingested twice is one element, not two. The other half of
    /// the property above: distinct facts survive, identical ones do not
    /// multiply.
    #[test]
    fn the_same_ledger_op_twice_is_one_element() {
        let op = op_for_write(
            "book-1",
            "journals",
            "j-1",
            &row(r#"{"id":"j-1","narrative":"Opening"}"#),
            false,
            hlc(10, 1),
        )
        .unwrap();
        let mut state = dmtap_sync::SyncState::new();
        assert!(state.ingest(&op, 20_000).unwrap(), "newly applied");
        assert!(
            !state.ingest(&op, 20_000).unwrap(),
            "a duplicate is a no-op"
        );
        assert_eq!(state.present_members().len(), 1);
    }

    /// An unmapped table is refused, never defaulted. Mapping a ledger table
    /// onto a register would overwrite where a union belongs, so a table name
    /// nobody made a decision about must not acquire one by falling through.
    #[test]
    fn an_unmapped_table_is_refused_rather_than_defaulted_to_lww() {
        for unknown in ["documents", "audit_log", "transactionss", ""] {
            assert_eq!(
                kind_for(unknown).unwrap_err(),
                MapError::UnmappedTable(unknown.to_owned()),
                "{unknown:?} must have no primitive"
            );
            assert!(op_for_write("b", unknown, "x", &row("{}"), false, hlc(1, 1)).is_err());
            assert!(!is_replicated(unknown));
        }
    }

    #[test]
    fn every_listed_table_has_exactly_one_primitive() {
        for table in replicated_tables() {
            let kind = kind_for(table).expect("a listed table has a primitive");
            assert_eq!(
                kind == Kind::SetAdd,
                is_ledger(table),
                "{table} disagrees with is_ledger"
            );
            assert!(is_replicated(table));
        }
        // No table may be in both lists — the two primitives are mutually
        // exclusive, and a table in both would resolve by list order.
        for table in LEDGER_TABLES {
            assert!(
                !LWW_TABLES.contains(table),
                "{table} is in both mapping lists"
            );
        }
        assert_eq!(
            replicated_tables().len(),
            LWW_TABLES.len() + LEDGER_TABLES.len()
        );
    }

    /// The address is produced in one place and parsed in one place. A row id
    /// is a UUID v7, so the first `/` is the separator.
    #[test]
    fn lww_targets_round_trip() {
        let target = lww_target("transactions", "0190a1b2-0000-7000-8000-000000000001");
        assert_eq!(
            parse_lww_target(&target),
            Some(("transactions", "0190a1b2-0000-7000-8000-000000000001"))
        );
        assert_eq!(parse_lww_target("no-separator"), None);
        assert_eq!(parse_lww_target("/no-table"), None);
        assert_eq!(parse_lww_target("no-id/"), None);
    }

    /// Money is `i64` minor units and crosses the wire as a JSON integer
    /// inside the row payload — exact in, exact out, with no float anywhere on
    /// the path and no rounding step to get wrong.
    #[test]
    fn minor_units_cross_the_wire_exactly() {
        // A value that cannot be represented in an f64 without loss: if
        // anything on this path went through a double, it would come back
        // 9007199254740993 → 9007199254740992.
        let awkward: i64 = 9_007_199_254_740_993;
        let op = op_for_write(
            "book-1",
            "transactions",
            "t-1",
            &row(&format!(r#"{{"id":"t-1","amount_minor":{awkward}}}"#)),
            false,
            hlc(10, 1),
        )
        .unwrap();
        let (back, _) = parse_row_value(op.value.as_ref().unwrap()).unwrap();
        let amount = back.get("amount_minor").unwrap();
        assert!(amount.is_i64(), "money must stay an integer, never a float");
        assert_eq!(amount.as_i64().unwrap(), awkward);
    }
}
