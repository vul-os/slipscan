-- =============================================================================
-- Migration 0016: fixed-asset register + depreciation (PARITY.md "Fixed
-- assets" — scored Not built; ROADMAP.md Phase 6 Xero-side gap).
--
-- Two tables, on opposite sides of the §4.10 selection test the rest of this
-- schema already uses (see migration 0015's header for the fullest statement
-- of it):
--
--   `assets`                  — a person's own record of what they capitalised
--                                (cost, acquisition date, useful life, method).
--                                Editable right up until depreciation exists
--                                against it (`CoreService::asset_update`
--                                enforces that boundary; nothing here does) —
--                                the same "editing your own draft" shape
--                                `purchase_orders`/`sales_orders` already have.
--                                §4.4 LWW.
--   `asset_depreciation_runs` — one immutable fact per (asset, period)
--                                actually posted to the ledger: this much
--                                depreciation, this journal. Never edited,
--                                never deleted, exactly like `po_receipts`
--                                (migration 0013) and `networth_snapshots`
--                                (migration 0015) — and for the identical
--                                reason: a correction is a new fact (a
--                                reversal of the journal it points at, via
--                                `CoreService::journal_reverse` /
--                                `asset_dispose`'s retroactive cleanup), never
--                                a rewrite of this one. §4.3 OR-Set.
--
-- -----------------------------------------------------------------------------
-- Why a register at all, separate from `chart_of_accounts`
-- -----------------------------------------------------------------------------
--
-- The chart of accounts already has a place for a capitalised cost to sit
-- (business seeds carry "1500 Office Equipment" / "1510 Computer Equipment"),
-- and that entry is what an ordinary transaction/document posting already
-- debits at purchase time — this migration does not touch that leg and never
-- posts an acquisition journal. What the GL cannot do on its own is know a
-- *schedule*: how much of one specific asset's cost is used up by which
-- month, under which method. `assets` is that sub-ledger — the fact "this
-- printer cost 4500 minor units, bought 2026-01-14, seven-year life,
-- straight-line" — and `asset_depreciation_runs` is the record of the
-- schedule actually being run, period by period, each run backed by exactly
-- one posted journal (**DR** depreciation expense "6250", **CR** accumulated
-- depreciation "1600" — both already present in every business chart-of-
-- accounts seed in `region.rs`, which is why this migration adds no new
-- chart-of-accounts codes of its own).
--
-- -----------------------------------------------------------------------------
-- Depreciation methods (`assets.method`) — the only two, deliberately
-- -----------------------------------------------------------------------------
--
-- `straight_line`     — `(cost - residual) / useful_life_months` per period,
--                        computed as a cumulative target so the schedule sums
--                        to exactly `cost - residual` with no drift (see
--                        `CoreService::depreciation_run`'s doc comment for the
--                        exact integer formula).
-- `reducing_balance`  — `reducing_balance_rate_bps` applied to opening net
--                        book value each period, floored, and clamped so net
--                        book value never drops below `residual`. The rate is
--                        a **per-period** (monthly) rate, not an annual one —
--                        there is no compounding conversion here, which keeps
--                        every step exact-integer. `reducing_balance_rate_bps`
--                        is required exactly when the method is
--                        `reducing_balance` (the CHECK below ties the two
--                        together) and forbidden otherwise.
--
-- No other method exists and none should be added without a matching CHECK
-- and a matching arm in `CoreService::depreciation_run`'s schedule function —
-- see that function for why (revaluation and a tax-vs-book split are
-- explicitly out of scope for this migration, ROADMAP.md Phase 6).
--
-- -----------------------------------------------------------------------------
-- `assets` columns
-- -----------------------------------------------------------------------------
--
--   cost_minor, residual_minor   `i64` minor units, never floats — the
--                                 workspace-wide convention. `residual_minor
--                                 <= cost_minor` (a residual above cost would
--                                 make the depreciable base negative).
--   currency                     The asset's own currency; not required to
--                                 match the book's, same latitude
--                                 `accounts.currency` already has.
--   useful_life_months           Bounds the schedule for both methods: the
--                                 straight-line divisor, and the period at
--                                 which reducing-balance is forced down to
--                                 exactly `residual_minor` regardless of what
--                                 the rate alone would have produced that
--                                 period (see `depreciation_run`).
--   status / disposed_date /
--   disposal_proceeds_minor      Set together, once, by `CoreService::
--                                 asset_dispose`. `disposed_date` is required
--                                 exactly when `status = 'disposed'` (CHECK
--                                 below) — there is no "disposed with no
--                                 date" state to model around.
-- -----------------------------------------------------------------------------

CREATE TABLE assets (
    id                        TEXT PRIMARY KEY,
    book_id                   TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name                      TEXT NOT NULL,
    description               TEXT,
    acquired_date             TEXT NOT NULL,
    cost_minor                INTEGER NOT NULL CHECK (cost_minor > 0),
    residual_minor            INTEGER NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
    currency                  TEXT NOT NULL CHECK (length(currency) = 3),
    useful_life_months        INTEGER NOT NULL CHECK (useful_life_months > 0),
    method                    TEXT NOT NULL
        CHECK (method IN ('straight_line', 'reducing_balance')),
    reducing_balance_rate_bps INTEGER
        CHECK (reducing_balance_rate_bps IS NULL
               OR (reducing_balance_rate_bps > 0 AND reducing_balance_rate_bps <= 10000)),
    status                    TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disposed')),
    disposed_date             TEXT,
    disposal_proceeds_minor   INTEGER,
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    CHECK (residual_minor <= cost_minor),
    CHECK ((method = 'reducing_balance') = (reducing_balance_rate_bps IS NOT NULL)),
    CHECK ((status = 'disposed') = (disposed_date IS NOT NULL))
);

CREATE INDEX assets_book_status_idx ON assets (book_id, status);

-- Sync capture: full LWW (insert/update/delete), the same three-trigger shape
-- as `accounts`/`chart_of_accounts` above — see this migration's header for
-- why `assets` sits in `slipscan_sync::LWW_TABLES` and not `LEDGER_TABLES`.
CREATE TRIGGER sync_capture_assets_ins AFTER INSERT ON assets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('assets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_assets_upd AFTER UPDATE ON assets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('assets', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_assets_del AFTER DELETE ON assets
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('assets', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- -----------------------------------------------------------------------------
-- `asset_depreciation_runs`: one row per successfully posted period.
--
-- `period` is `YYYY-MM`, the same shape and CHECK `budgets.month` already
-- uses. `period_index` is the 1-based count of periods since acquisition
-- (month of acquisition = 1) — stored rather than re-derived so "how many
-- periods has this asset been run for" and "what's the next expected period"
-- are an indexed lookup, not date arithmetic over every row on every read.
-- Both `(asset_id, period)` and `(asset_id, period_index)` are unique: this
-- is what makes a period idempotent to run twice at the database level, on
-- top of (not instead of) `journals`' own per-`(source_type, source_id)`
-- dedup that `CoreService::post_journal_in_tx` already enforces — see
-- `CoreService::depreciation_run`'s doc comment for how the two guards
-- compose (the row is inserted, referencing its journal, only after the
-- journal itself posted, so a UNIQUE violation here can only mean a genuine
-- second attempt at the same period, never a half-posted one).
--
-- `journal_id` is `NOT NULL` — unlike `po_receipts`/`invoice_payments`, whose
-- journal is optional (no chart of accounts yet), a depreciation run row is
-- only ever inserted *after* its journal posted; when there is no chart of
-- accounts to post into, `depreciation_run` posts nothing at all — no run
-- row either, so a later run (once the book has a chart of accounts) can
-- still post that period cleanly. See migration 0001's `journals` header and
-- `CoreService::post_revenue_ar_journal` for the same "graceful nothing"
-- posture this mirrors.
-- -----------------------------------------------------------------------------

CREATE TABLE asset_depreciation_runs (
    id                 TEXT PRIMARY KEY,
    book_id            TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    asset_id           TEXT NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    period             TEXT NOT NULL
        CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    period_index       INTEGER NOT NULL CHECK (period_index > 0),
    depreciation_minor INTEGER NOT NULL CHECK (depreciation_minor > 0),
    journal_id         TEXT NOT NULL REFERENCES journals (id) ON DELETE CASCADE,
    created_at         TEXT NOT NULL,
    UNIQUE (asset_id, period),
    UNIQUE (asset_id, period_index)
);

CREATE INDEX asset_depreciation_runs_asset_idx
    ON asset_depreciation_runs (asset_id, period_index);

-- Immutable, exactly like `po_receipts` (migration 0013) and
-- `networth_snapshots` (migration 0015) — a run that turns out to be wrong is
-- corrected by reversing the journal it points at (see `CoreService::
-- asset_dispose`), never by editing or deleting this row.
CREATE TRIGGER asset_depreciation_runs_no_update
BEFORE UPDATE ON asset_depreciation_runs
BEGIN
    SELECT RAISE(ABORT, 'depreciation runs are immutable; reverse the journal instead');
END;

CREATE TRIGGER asset_depreciation_runs_no_delete
BEFORE DELETE ON asset_depreciation_runs
BEGIN
    SELECT RAISE(ABORT, 'depreciation runs are immutable; reverse the journal instead');
END;

-- Sync capture: INSERT only, for the same reason as `networth_snapshots`
-- above — the two triggers just installed make an UPDATE/DELETE capture
-- trigger unreachable code. `asset_depreciation_runs` is added to
-- `slipscan_sync::LEDGER_TABLES` (crates/slipscan-sync/src/lib.rs), not
-- `LWW_TABLES`: two devices that each ran depreciation for the same asset and
-- period while disconnected must converge by keeping both facts (the
-- `UNIQUE (asset_id, period)` constraint means at most one of them actually
-- committed locally before syncing — the union is exactly one row either
-- way), never by one silently overwriting the other.
CREATE TRIGGER sync_capture_asset_depreciation_runs_ins
AFTER INSERT ON asset_depreciation_runs
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('asset_depreciation_runs', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
