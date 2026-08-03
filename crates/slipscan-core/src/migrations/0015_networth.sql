-- =============================================================================
-- Migration 0015: net-worth snapshots (PARITY.md gap #4, "Net worth over
-- time" — the Vault22 / 22seven headline number).
--
-- Everything SlipScan could say about net worth before this file was a
-- *current* figure, computed on the fly from `accounts.opening_balance_minor`
-- plus a sum of transactions — desktop-only, and nowhere stored. There was no
-- series: no way to plot how net worth moved, because nothing ever wrote down
-- what it was yesterday. This migration is that record.
--
-- -----------------------------------------------------------------------------
-- Why a ledger, not a stored "current balance" column
-- -----------------------------------------------------------------------------
--
-- `on_hand` on `product_variants` (migration 0012) was rejected for exactly
-- this reason, and the reasoning transfers unchanged: a stored total is the
-- thing that cannot survive two devices writing while disconnected, and it
-- throws away history the moment a new value overwrites the old one. A
-- balance snapshot is a **fact about a date** — "account A held N minor units
-- of currency C as of the end of 2026-03-14" — and a fact does not get
-- edited when it turns out to be stale; a *later* fact is recorded, and both
-- stay true of the moments they each describe. So this is `stock_movements`'
-- shape again: insert-only, immutable, one row per fact, with its own UUID
-- v7 `id` so two independently-recorded facts for the same account and date
-- (two offline devices both snapshotting, or a captured row alongside a
-- backfilled one) are two rows, not a collision.
--
-- **Insert-only, exactly like `journals`/`journal_lines` (migration 0001) and
-- `stock_movements` (migration 0012), and for the identical reason.** A
-- snapshot that turns out to be wrong is corrected by recording a better one,
-- never by rewriting the row already on record. `networth_snapshots_no_
-- update`/`_no_delete` below make SQLite refuse the alternative outright, the
-- same guarantee those two tables already give their own rows.
--
-- **No `UNIQUE (account_id, as_of_date)`.** That would be the natural
-- instinct — surely there is only one "true" balance per account per day —
-- but it would be the LWW instinct in a table that is deliberately an OR-Set
-- (see `slipscan_sync`'s module docs on the §4.10 selection test, and its
-- `LEDGER_TABLES` doc comment for why this table is there and not
-- `LWW_TABLES`). Two devices that each captured or backfilled the same
-- account's balance for the same date while disconnected must converge by
-- keeping **both** facts once they sync, the same way two branches recording
-- stock movements for the same day converge by union rather than one
-- overwriting the other. `repo::networth::series` (the read side) already
-- has to pick the freshest fact for a given `(account, as_of_date)` out of
-- however many exist — a unique index would just make the database do that
-- picking wrong, by refusing the second fact outright instead of keeping it.
--
-- -----------------------------------------------------------------------------
-- Columns
-- -----------------------------------------------------------------------------
--
--   account_id      `ON DELETE RESTRICT`, same posture as `transactions.
--                    account_id`: net-worth history is financial history,
--                    and deleting the account out from under it would leave
--                    snapshots that resolve to nothing. `account_delete`
--                    already refuses while transactions reference the
--                    account; this refuses independently even for an
--                    account with a snapshot but (hypothetically) no
--                    transactions left.
--   as_of_date       `YYYY-MM-DD`. The balance is "as of the end of this
--                    day" — it includes every transaction posted on it.
--                    Not a foreign key and not indexed against anything;
--                    it is a plain date, the same convention `transactions.
--                    posted_date` and every report's date range already use.
--   balance_minor    Signed `i64` minor units — a liability account
--                    legitimately reads negative, same as
--                    `accounts.opening_balance_minor`.
--   currency         The account's **own** currency, not the book's. A
--                    snapshot never converts anything; conversion to the
--                    book's currency happens at read time
--                    (`CoreService::networth_series`), using whatever
--                    exchange-rate machinery is configured *then* — see
--                    that function's doc comment for the honest limit this
--                    runs into (the FX cache holds no history, so a 2024
--                    balance converts at today's rate, not 2024's).
--   source           `captured` — recorded at (approximately) the moment it
--                    describes, via `networth_capture`. `backfilled` —
--                    reconstructed after the fact from the transaction
--                    ledger, via `networth_backfill`, so a book that has
--                    never called `networth_capture` before today still gets
--                    a real chart instead of a single point. Both are
--                    equally valid facts; the column exists so a reader can
--                    tell a live recording from a reconstruction, never so
--                    one is preferred over the other at query time.
-- =============================================================================

CREATE TABLE networth_snapshots (
    id            TEXT PRIMARY KEY,
    book_id       TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    account_id    TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
    as_of_date    TEXT NOT NULL,
    balance_minor INTEGER NOT NULL,
    currency      TEXT NOT NULL CHECK (length(currency) = 3),
    source        TEXT NOT NULL CHECK (source IN ('captured', 'backfilled')),
    created_at    TEXT NOT NULL
);

-- Serves `repo::networth::series`'s "every distinct date the book has a
-- snapshot on, within a range" scan.
CREATE INDEX networth_snapshots_book_date_idx
    ON networth_snapshots (book_id, as_of_date);
-- Serves the per-account "latest snapshot at or before this date" lookup
-- `series` joins against, and `dates_for_account`/`get_for_account_date`,
-- which `networth_backfill`/`networth_capture` use to stay idempotent.
CREATE INDEX networth_snapshots_account_date_idx
    ON networth_snapshots (account_id, as_of_date);

-- A snapshot's content is its identity, the same way a stock movement's is
-- (migration 0012) and a posted journal's is (migration 0001): there is no
-- such thing as correcting one in place, only recording a second snapshot
-- that supersedes it for reads.
CREATE TRIGGER networth_snapshots_no_update
BEFORE UPDATE ON networth_snapshots
BEGIN
    SELECT RAISE(ABORT, 'net-worth snapshots are immutable; record a new snapshot instead');
END;

CREATE TRIGGER networth_snapshots_no_delete
BEFORE DELETE ON networth_snapshots
BEGIN
    SELECT RAISE(ABORT, 'net-worth snapshots are immutable; record a new snapshot instead');
END;

-- -----------------------------------------------------------------------------
-- Sync capture: INSERT only, for the same reason as `stock_movements` above —
-- the two triggers just installed make an UPDATE/DELETE capture trigger
-- unreachable code. `networth_snapshots` is added to `slipscan_sync::
-- LEDGER_TABLES` (crates/slipscan-sync/src/lib.rs), not `LWW_TABLES`: it is
-- an immutable fact merged by union (§4.3 OR-Set), exactly like
-- `journals`/`journal_lines`/`stock_movements`, and for the identical
-- reason — two devices that each recorded a snapshot for the same account
-- and date while disconnected must converge by keeping both, never by one
-- overwriting the other. Every row carries its own UUID v7 `id`, which is
-- what makes that union safe (see `slipscan-sync`'s module docs on the "two
-- facts that serialize alike" trap it already hit once).
-- `crate::sync::capture::tests::every_mapped_table_has_capture_triggers_and_
-- no_others_do` and `lww_tables_capture_all_three_verbs_and_ledger_tables_
-- only_insert` both assert this table's trigger set agrees with that list.
-- -----------------------------------------------------------------------------

CREATE TRIGGER sync_capture_networth_snapshots_ins AFTER INSERT ON networth_snapshots
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('networth_snapshots', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No backfill needed for the outbox itself: `networth_snapshots` did not
-- exist before this migration, so there are no pre-existing rows for it to
-- catch up on.
