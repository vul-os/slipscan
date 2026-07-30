-- =============================================================================
-- Migration 0700: the signed operation log (docs/NODES.md phase 2).
--
-- Migration 0600 gave this device an identity and let it pin peers. It stored
-- IDENTITY ONLY: pairing two devices proved who they were and then did nothing
-- at all, because there was no record of what had changed and nothing to carry
-- it. This migration builds the first half of the missing middle — the record.
--
-- **There is still no transport.** Nothing in this file, and nothing in
-- `slipscan-core::sync`, opens a socket, resolves a name or makes an outbound
-- call. What lands here is a local, append-only, individually-signed log of
-- every replicable write this device makes, plus the clock that orders it.
-- Carrying it to another device is phase 3.
--
-- -----------------------------------------------------------------------------
-- Why capture happens in SQLite triggers rather than in Rust
-- -----------------------------------------------------------------------------
--
-- The alternative was to call an oplog recorder from each of the ~39 write
-- functions in `crate::repo`. That is a completeness claim resting on nobody
-- ever adding a fortieth. A trigger is not a claim: a write that reaches the
-- row reaches the trigger, whatever code path it came from — service layer,
-- migration, an `ON DELETE CASCADE` two tables away, or a future importer
-- nobody has written yet.
--
-- The triggers record only WHICH row changed, never its content. The content
-- is read back, whole, when the entry is sealed into a signed op (see
-- `crate::sync::seal`). That is deliberate: a trigger carrying a column list
-- drifts silently the first time somebody runs `ALTER TABLE ... ADD COLUMN`,
-- and the drift is invisible because the trigger still fires and the op still
-- signs — it just quietly stops replicating the new column. Reflecting the
-- schema at seal time cannot drift, because there is no second copy of it.
--
-- -----------------------------------------------------------------------------
-- What replicates, and what deliberately does not
-- -----------------------------------------------------------------------------
--
-- The table set is `slipscan_sync::LWW_TABLES` and `LEDGER_TABLES`, and the
-- §4.10 selection-test answer for each lives in that crate's module docs.
-- `crate::sync::capture::tests` asserts that this file's triggers and those
-- lists agree in BOTH directions, and that every other table in the schema is
-- on the explicit not-replicated list below. Adding a table to SlipScan
-- without deciding how it syncs therefore fails the suite; it cannot quietly
-- default to either answer.
--
-- Not replicated, on purpose:
--
--   documents, document_extractions  File-backed. The row is a pointer into
--                                    the movable data folder; replicating the
--                                    pointer without the bytes would land a
--                                    broken reference on the peer. Needs blob
--                                    transport, which does not exist.
--   recon_matches                    References documents; follows them.
--   classification_corrections       A local learning log, not shared state.
--   fx_rates                         A regenerable cache with an upstream.
--   pay_*                            Per-device delivery endpoints and their
--                                    retry state. Two devices delivering the
--                                    same webhook is a bug, not convergence.
--   audit_log                        This device's record of what THIS device
--                                    did. Already append-only, and merging two
--                                    devices' audit logs would misattribute.
--   settings                         Device-local preferences; keyed by name
--                                    with no book scope and no row id.
--   vault_keys, vault_secrets        Key material, wrapped to a KEK that never
--                                    leaves this machine's keychain.
--   device_*                         Identity and pins. A peer's opinion of
--                                    who to trust is exactly what must not
--                                    replicate.
--   schema_migrations, sync_*        Local bookkeeping, including this file's.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The local clock (SYNC.md §3).
-- -----------------------------------------------------------------------------
--
-- One row, ever. Persisted because an HLC's whole job is to be monotonic, and
-- a clock that resets to zero on restart mints stamps that sort before ops
-- this device has already published — the same write would then lose to its
-- own predecessor.
--
-- `wall` is milliseconds since the Unix epoch. It is NOT read as a wall clock:
-- the engine's `Hlc::tick` takes the larger of it and the system clock, so a
-- system clock that jumps backwards cannot drag the log backwards with it.
CREATE TABLE sync_clock (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    wall       INTEGER NOT NULL,
    counter    INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- Capture suppression.
-- -----------------------------------------------------------------------------
--
-- One row, ever; `applying` is 0 in normal operation.
--
-- Every capture trigger below is guarded on this flag being 0. It exists for
-- the phase that applies a peer's ops to local rows: those writes are already
-- IN the log (they arrived as ops), and re-capturing them would mint a second,
-- locally-authored op for the same fact and echo it back to the sender.
--
-- **No shipped code sets it today** — there is no apply path yet, because
-- there is no transport. It is here rather than in a later migration because
-- adding it later means editing all 35 triggers below, and a migration that
-- rewrites triggers is a much worse thing to review than one that creates
-- them. `crate::sync::capture::tests::suppression_stops_capture` exercises the
-- mechanism directly so it is not merely asserted to work.
CREATE TABLE sync_control (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    applying INTEGER NOT NULL DEFAULT 0 CHECK (applying IN (0, 1))
);

INSERT INTO sync_control (id, applying) VALUES (1, 0);

-- -----------------------------------------------------------------------------
-- The outbox: local writes awaiting a signature.
-- -----------------------------------------------------------------------------
--
-- Staging, not history. A row lives here from the moment a trigger sees the
-- write until `crate::sync::seal` turns it into a signed op, and is deleted in
-- the same transaction that inserts the op — so a crash mid-seal leaves the
-- entry unsealed and it is picked up next time, never lost and never
-- double-signed under two different stamps.
--
-- `ns` is the book id: SYNC.md §7 namespaces, so a device can subscribe to one
-- book without being handed the others. For the `books` table itself it is the
-- book's own id.
CREATE TABLE sync_outbox (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name  TEXT NOT NULL,
    row_id      TEXT NOT NULL,
    ns          TEXT NOT NULL,
    -- 1 for a DELETE. The row is already gone by the time this is sealed,
    -- which is why a tombstone op carries identity only.
    deleted     INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    captured_at TEXT NOT NULL
);

CREATE INDEX sync_outbox_row_idx ON sync_outbox (table_name, row_id, seq);

-- -----------------------------------------------------------------------------
-- The oplog: signed operations. Append-only.
-- -----------------------------------------------------------------------------
--
-- `op_id` is the SYNC.md §4.1 content address of the operation — lowercase hex
-- of the DS-tagged hash of its deterministic CBOR — and it is the PRIMARY KEY.
--
-- That is a deliberate answer to a failure a sibling product hit: a
-- content-addressed op id alongside a UUID primary key gives an op TWO
-- identities that disagree. The engine deduplicates on the content address, so
-- it sees one op; the database deduplicates on the UUID, so it stores two rows
-- for it. Here there is exactly one identity, and re-recording an op is an
-- `ON CONFLICT DO NOTHING` that changes nothing.
--
-- `cose` is the authoritative record: the full RFC 9052 `COSE_Sign1` envelope,
-- EdDSA over the frozen `Sig_structure` with the DS-tag in `external_aad`. The
-- other columns are a decoded INDEX over it, never a substitute for it —
-- `crate::sync::verify` re-derives every one of them from the envelope and
-- refuses on any disagreement, so a hand-edited row cannot make the log say
-- something the signature does not.
--
-- Each op is signed on its own, which is the point: a replicated change is
-- verified by its own signature under its own author's key, not trusted for
-- having arrived over an authenticated connection.
CREATE TABLE sync_oplog (
    op_id       TEXT PRIMARY KEY,
    ns          TEXT NOT NULL,
    -- The engine's op-kind discriminator, read from `dmtap_sync` and never
    -- hard-coded on the Rust side.
    kind        INTEGER NOT NULL,
    target      TEXT NOT NULL,
    -- Lowercase hex ed25519 public key: the author's device id, and the same
    -- value carried inside the signed payload's HLC.
    author      TEXT NOT NULL,
    hlc_wall    INTEGER NOT NULL,
    hlc_counter INTEGER NOT NULL,
    cose        BLOB NOT NULL,
    -- 'local' if this device authored it, 'remote' if it arrived from a peer.
    -- Only 'local' is ever written today; nothing arrives from anywhere yet.
    origin      TEXT NOT NULL CHECK (origin IN ('local', 'remote')),
    recorded_at TEXT NOT NULL
);

-- Total order for replay and for the range scans a reconciliation walk needs.
-- `op_id` breaks ties so the order is total rather than merely mostly-total:
-- two authors can mint the same (wall, counter).
CREATE INDEX sync_oplog_order_idx ON sync_oplog (hlc_wall, hlc_counter, op_id);
-- Per-author high-water marks (§5.1 version vector).
CREATE INDEX sync_oplog_author_idx ON sync_oplog (author, hlc_wall, hlc_counter);
-- Sparse, per-namespace scoping (§7).
CREATE INDEX sync_oplog_ns_idx ON sync_oplog (ns, hlc_wall, hlc_counter);

-- An op's content is its identity and its signature covers it, so there is no
-- such thing as editing one: the result would be a row whose op_id and
-- signature both describe something else. Blocked in the database, the same
-- way migration 0101 blocks edits to a posted journal.
--
-- DELETE is deliberately left open. History is prunable at a §6.2 stability
-- cut, and `sync reset` must be able to clear the log outright.
CREATE TRIGGER sync_oplog_no_update
BEFORE UPDATE ON sync_oplog
BEGIN
    SELECT RAISE(ABORT, 'a signed op is immutable; its content is its identity');
END;

-- =============================================================================
-- Capture triggers.
--
-- Three per LWW table (insert / update / delete), one per ledger table.
--
-- The ledger tables get an INSERT trigger ONLY, and that is not an oversight:
-- migration 0101 installs BEFORE UPDATE and BEFORE DELETE triggers on
-- `journals` and `journal_lines` that `RAISE(ABORT)`. A posted journal is
-- corrected by a reversal, never an edit. An AFTER UPDATE capture trigger on
-- either table would be unreachable code, and writing one would suggest the
-- statement it captures is possible.
-- =============================================================================

-- books ----------------------------------------------------------------------
-- The namespace of a book row is the book's own id.
CREATE TRIGGER sync_capture_books_ins AFTER INSERT ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', NEW.id, NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_books_upd AFTER UPDATE ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', NEW.id, NEW.id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_books_del AFTER DELETE ON books
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('books', OLD.id, OLD.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- accounts -------------------------------------------------------------------
CREATE TRIGGER sync_capture_accounts_ins AFTER INSERT ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_accounts_upd AFTER UPDATE ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_accounts_del AFTER DELETE ON accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('accounts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- categories -----------------------------------------------------------------
CREATE TRIGGER sync_capture_categories_ins AFTER INSERT ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_categories_upd AFTER UPDATE ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_categories_del AFTER DELETE ON categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('categories', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- transactions ---------------------------------------------------------------
CREATE TRIGGER sync_capture_transactions_ins AFTER INSERT ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transactions_upd AFTER UPDATE ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transactions_del AFTER DELETE ON transactions
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transactions', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- transaction_splits ---------------------------------------------------------
CREATE TRIGGER sync_capture_transaction_splits_ins AFTER INSERT ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transaction_splits_upd AFTER UPDATE ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_transaction_splits_del AFTER DELETE ON transaction_splits
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('transaction_splits', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- merchant_mappings ----------------------------------------------------------
CREATE TRIGGER sync_capture_merchant_mappings_ins AFTER INSERT ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_merchant_mappings_upd AFTER UPDATE ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_merchant_mappings_del AFTER DELETE ON merchant_mappings
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('merchant_mappings', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- budgets --------------------------------------------------------------------
CREATE TRIGGER sync_capture_budgets_ins AFTER INSERT ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_budgets_upd AFTER UPDATE ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_budgets_del AFTER DELETE ON budgets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('budgets', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- members --------------------------------------------------------------------
CREATE TRIGGER sync_capture_members_ins AFTER INSERT ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_members_upd AFTER UPDATE ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_members_del AFTER DELETE ON members
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('members', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- chart_of_accounts ----------------------------------------------------------
CREATE TRIGGER sync_capture_chart_of_accounts_ins AFTER INSERT ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_chart_of_accounts_upd AFTER UPDATE ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_chart_of_accounts_del AFTER DELETE ON chart_of_accounts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('chart_of_accounts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- coa_map --------------------------------------------------------------------
CREATE TRIGGER sync_capture_coa_map_ins AFTER INSERT ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_coa_map_upd AFTER UPDATE ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_coa_map_del AFTER DELETE ON coa_map
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('coa_map', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- vat_rates ------------------------------------------------------------------
CREATE TRIGGER sync_capture_vat_rates_ins AFTER INSERT ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_vat_rates_upd AFTER UPDATE ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_vat_rates_del AFTER DELETE ON vat_rates
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('vat_rates', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- journals -------------------------------------------------------------------
-- INSERT only: migration 0101 aborts every UPDATE and DELETE on this table.
CREATE TRIGGER sync_capture_journals_ins AFTER INSERT ON journals
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journals', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- journal_lines --------------------------------------------------------------
-- INSERT only, for the same reason.
CREATE TRIGGER sync_capture_journal_lines_ins AFTER INSERT ON journal_lines
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journal_lines', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- =============================================================================
-- Backfill.
--
-- The triggers above record writes from here on. On a database that already
-- has books in it, that would leave a log holding only what happened after the
-- upgrade — and a log that begins mid-history is not a record of the books,
-- it is a record of a Tuesday.
--
-- So every existing row is queued as if it had just been written. The entries
-- seal into ordinary live register writes and set-adds at the next
-- `slipscan sync seal`, which is exactly what a replica joining later needs to
-- receive. On a fresh install every one of these selects returns nothing and
-- the backfill costs a table scan of empty tables.
--
-- Ordered to match the mapping registry so the log's first stamps run in a
-- sensible dependency order (books before their accounts, journals before
-- their lines). Nothing depends on that ordering for correctness — the merge
-- is order-independent, which is the property the convergence test holds — but
-- a log a human can read is worth the `ORDER BY`.
-- =============================================================================

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'books', id, id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM books ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'accounts', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM accounts ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'categories', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM categories ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'transactions', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM transactions ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'transaction_splits', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM transaction_splits ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'merchant_mappings', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM merchant_mappings ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'budgets', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM budgets ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'members', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM members ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'chart_of_accounts', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM chart_of_accounts ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'coa_map', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM coa_map ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'vat_rates', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM vat_rates ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'journals', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM journals ORDER BY id;

INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
SELECT 'journal_lines', id, book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM journal_lines ORDER BY id;
