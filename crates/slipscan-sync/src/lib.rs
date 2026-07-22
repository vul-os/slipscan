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
//! Accounts, categories, budgets, members, merchant mappings and transactions.
//!
//! ```text
//! target  "<table>/<row-id>"      field "row"
//! value   tstr, "v" + canonical JSON of the row  (live)
//!         tstr, "x" + canonical JSON of the row  (deleted)
//! ```
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
//! `reversal_of`. The repo layer contains no `UPDATE` against either table.
//!
//! No set-remove is ever minted, so this is an OR-Set with no removes, which is
//! a grow-only set whose merge is plain union. The mapping is therefore an
//! identity on SlipScan's existing behaviour rather than a new one that has to
//! be re-validated against the books.
//!
//! A PN-counter (§4.6) would be the wrong reach even though balances are sums:
//! §4.6 is for a scalar whose history need not be retained, and it would
//! converge on the right total while discarding the journal. Double-entry
//! accounting is the history.
//!
//! # Money never becomes a float
//!
//! §4.1 excludes floats from `ext-value` entirely. For a product carrying
//! `REAL` columns that is an obstacle — FlowStock had to push its rows through
//! an opaque canonical payload for exactly this reason.
//!
//! SlipScan has the opposite problem, which is to say none: money is
//! `rust_decimal::Decimal` throughout and floats are already banned from money
//! math. [`decimal_value`] encodes a decimal as its canonical text form, which
//! is exact, and the substrate's no-float rule costs SlipScan nothing.
//!
//! # Feature-gated
//!
//! Everything below is behind the `sync-dmtap` feature, default-off. With it
//! off this crate compiles to an empty, dependency-free no-op — it is
//! `exclude`d from the root workspace precisely so that pulling in nothing
//! here doesn't require touching `envoir` at all (see the root `Cargo.toml`
//! and this crate's `Cargo.toml` for why `optional` alone isn't sufficient).
//! Enable with `--features sync-dmtap` when building this crate on its own.

#![cfg(feature = "sync-dmtap")]

use dmtap_sync::{Hlc, SVal, SyncOp, OP_LWW_SET, OP_SET_ADD};
use rust_decimal::Decimal;

/// The substrate op kinds this mapping emits.
///
/// Read from `dmtap-sync` rather than hard-coded, because `SYNC.md`'s own
/// adoption notes say never to hard-code the discriminators.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// §4.4 last-writer-wins register — an editable row.
    LwwSet,
    /// §4.3 OR-Set add — an immutable ledger fact.
    SetAdd,
}

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
pub const LWW_FIELD: &str = "row";

/// Tables whose rows are immutable ledger facts, merged by union.
///
/// Kept as data rather than as a predicate on the table name so that adding a
/// table is a deliberate act with a matching mapping decision, not something a
/// naming convention can do by accident.
pub const LEDGER_TABLES: &[&str] = &["journals", "journal_lines"];

/// Whether `table` is an immutable ledger, and so maps to the OR-Set.
pub fn is_ledger(table: &str) -> bool {
    LEDGER_TABLES.contains(&table)
}

/// The primitive `table` maps to.
pub fn kind_for(table: &str) -> Kind {
    if is_ledger(table) {
        Kind::SetAdd
    } else {
        Kind::LwwSet
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MapError {
    /// A ledger table has no concept of deletion; a correction is a reversal.
    #[error("{0} is an immutable ledger: correct it with a reversal, never a delete")]
    LedgerDelete(String),
    /// Row payloads must be JSON objects so the id can be carried inside them.
    #[error("row payload must be a JSON object, got {0}")]
    NotAnObject(&'static str),
}

/// A decimal as an exact `ext-value`.
///
/// Text, not a float: §4.1 has no float, and SlipScan has no float in money
/// either, so this loses nothing. `Decimal`'s `to_string` is exact and
/// round-trips through `parse`.
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
pub fn canonical_json(row: &serde_json::Value) -> Result<String, MapError> {
    match row {
        serde_json::Value::Object(_) => Ok(row.to_string()),
        serde_json::Value::Null => Err(MapError::NotAnObject("null")),
        serde_json::Value::Array(_) => Err(MapError::NotAnObject("array")),
        _ => Err(MapError::NotAnObject("scalar")),
    }
}

/// The discriminated LWW payload: `"v"` live, `"x"` deleted (§4.1.1).
fn row_value(row: &serde_json::Value, deleted: bool) -> Result<SVal, MapError> {
    let tag = if deleted { "x" } else { "v" };
    Ok(SVal::Text(format!("{tag}{}", canonical_json(row)?)))
}

/// Mint the op for a write to `table`/`id`.
///
/// An editable row becomes an LWW register write; a ledger row becomes a
/// set-add. Deleting a ledger row is refused rather than silently mapped, so a
/// caller that tries gets an error instead of a converged hole in the books.
pub fn op_for_write(
    ns: &str,
    table: &str,
    id: &str,
    row: &serde_json::Value,
    deleted: bool,
    hlc: Hlc,
) -> Result<SyncOp, MapError> {
    match kind_for(table) {
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
            target: format!("{table}/{id}"),
            field: Some(LWW_FIELD.to_owned()),
            value: Some(row_value(row, deleted)?),
            hlc,
            observed: None,
            reference: None,
        }),
    }
}

/// Read a LWW register payload back into `(row, deleted)`.
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

#[cfg(test)]
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
}
