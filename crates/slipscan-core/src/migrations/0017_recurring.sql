-- =============================================================================
-- Migration 0017: repeating invoices and recurring transactions
-- (PARITY.md "Repeating invoices / recurring transactions", scored "Not
-- built": "No schedule, template or generator").
--
-- **Nothing here fires by itself.** There is no scheduler, no daemon, no
-- background timer anywhere in this product (see `crate::db`'s own header:
-- SlipScan is a native app with an embedded SQLite file, not a service with a
-- clock of its own). A schedule becomes *due* — its `next_run_date` reaches
-- today — and stays that way, inert, until a person runs
-- `CoreService::recurring_run_due` from the CLI, an HTTP call, the desktop
-- app, or a cron the user points at `slipscan recurring run`. This is a
-- product decision, not a missing feature: a book left untouched for three
-- months must not wake up and silently invent three months of invoices and
-- transactions the moment someone finally opens it. `recurring_run_due`
-- generates for whatever is due *as of the date it is called*, once, and
-- stops — see that function's own header for exactly what "twice must not
-- double-create" means and how it is enforced.
--
-- **Reuses the existing invoice and transaction paths, verbatim.** This
-- migration adds no new way to create an invoice or a transaction — it adds a
-- template and a clock-free trigger for calling `CoreService::invoice_issue`
-- (migration `0014_sales`) or `CoreService::transaction_create` (migration
-- `0001_init`) with the arguments the template already carries. Numbering,
-- VAT, the revenue/AR journal, the merchant-mapping cascade, the dedupe hash
-- — every rule those two functions already enforce applies unchanged to a
-- schedule-generated invoice or transaction, because it *is* one, made by the
-- same code. See `CoreService::recurring_process_occurrence`'s header for how
-- the transaction and invoice code paths were reshaped (an `_in_tx` inner
-- function, exactly the shape `journal_post`/`post_journal_in_tx` already
-- use) to let a single SQLite transaction cover "generate the record" and
-- "record that this occurrence is done" atomically, without either function
-- growing a second, parallel implementation.
--
-- **Three tables, three different jobs:**
--
--   recurring_schedules /       The editable template and its recurrence
--   recurring_schedule_items    rule — a person keeps adjusting the amount, the
--                               contact, whether it is paused, right up until
--                               they delete it (only ever possible before it
--                               has ever run — see `recurring_schedule_delete`).
--                               Last-writer-wins is exactly what editing your
--                               own schedule on two devices means, the same
--                               call migration 0014 makes for `sales_orders`.
--                               §4.4 LWW registers.
--
--   recurring_runs              One immutable fact per occurrence a schedule
--                               has ever reached, generated or deliberately
--                               skipped. Never edited, never deleted — the
--                               same discipline `po_receipts` (migration
--                               `0013_purchasing`) and `invoices` (migration
--                               `0014_sales`) already apply to their own
--                               facts, enforced here by the identical
--                               `_no_update`/`_no_delete` trigger pair. §4.3
--                               OR-Set.
--
-- **Idempotency is `recurring_runs`, not a re-derivation.** The obvious wrong
-- design is "recompute what's due and generate it" on every call — which
-- double-creates the instant it is called twice for the same date, exactly
-- the failure this feature exists to rule out. Instead, `recurring_run_due`
-- advances `recurring_schedules.occurrences_processed` and
-- `next_run_date`, and inserts one `recurring_runs` row, in the *same*
-- transaction as the invoice/transaction it generates
-- (`CoreService::recurring_process_occurrence`). Ordinary sequential
-- idempotency then falls out for free: call it twice with the same "as of"
-- date and the second call's own due-list query finds nothing, because the
-- first call already advanced `next_run_date` past it. `UNIQUE (schedule_id,
-- occurrence_index)` below is the backstop for the narrower case that
-- guarantee does not cover — two overlapping calls racing inside the window
-- between the first one's read and its commit — turning that race into a
-- loud constraint violation instead of a silent double-post, the same
-- belt-and-suspenders role `UNIQUE (book_id, series, number)` plays for
-- invoice numbering (see migration `0014_sales`'s header for why that one is
-- a backstop and not the whole guarantee either). A schedule generating a
-- *transaction* gets a second, independent backstop for free:
-- `recurring_process_occurrence` passes `provider_txn_id =
-- "recurring:<schedule_id>:<occurrence_index>"`, so `transaction_create`'s
-- own dedupe (migration `0001_init`) refuses a second insert on its own,
-- with no knowledge that a recurring schedule is even involved.
--
-- **The month-end rule — decided, not left to whatever the arithmetic does.**
-- A schedule anchors to the calendar day of its own `start_date` and
-- *reapplies that same day* to every later occurrence's target month,
-- clamping only when the target month is too short to hold it:
-- `crate::recurrence::occurrence_date` is the single function this and every
-- caller goes through, and its own header spells out why. The date a
-- schedule was created on is never allowed to drift downward permanently —
-- a monthly schedule anchored on the 31st reads 31, 28 (or 29), 31, 30, 31,
-- … through a year, not 31, 28, 28, 28, … A yearly schedule anchored on 29
-- February reads 29, 28, 28, 28, 29, … the same way. Each occurrence's date
-- is a pure function of `(start_date, frequency, interval_count,
-- occurrence_index)` — never of the previous occurrence's (possibly
-- clamped) date — which is what keeps the day from ratcheting down and
-- staying down.
--
-- **What is deliberately not here**, named rather than left to be
-- discovered:
--   - No editing `frequency`, `interval_count` or `start_date` after
--     creation (`recurring_schedule_update`'s own doc comment says so): all
--     three feed the occurrence-date arithmetic above, and letting them
--     change mid-series would leave `occurrences_processed`/`next_run_date`
--     describing a cadence that no longer matches what generated the
--     occurrences already on record. Pause the schedule (`status =
--     'paused'`) and create a new one instead — cheap, since nothing here
--     charges for a schedule that never fires.
--   - No catch-up semantics beyond "as of one date". A schedule dormant for
--     six months and then run once materializes every occurrence it missed
--     in between, one `recurring_runs` row and one invoice/transaction each,
--     not a single lump generation — this is a straightforward consequence
--     of `recurring_run_due` looping `recurring_process_occurrence` until a
--     schedule's `next_run_date` is no longer due, not a special case.
--   - No reminder, notification or "you have N schedules due" surfaced
--     anywhere but a read (`recurring_due_list`) a caller has to ask for.
--     Nothing here pushes.
--   - No correction path for a generated invoice from this table — an
--     invoice `recurring_run_due` raised is exactly as permanent as one
--     raised by hand (migration `0014_sales`'s own header on why), and a
--     credit note is that migration's future work, not this one's.
--   - Line items are fixed at `recurring_schedule_create` time and edited
--     through `recurring_schedule_item_add`/`_update`/`_remove` same as a
--     sales order's — but there is no equivalent single-line edit for a
--     `transaction`-kind schedule's amount/merchant/description beyond
--     `recurring_schedule_update`'s ordinary field patch, because a
--     transaction schedule only ever has the one line to begin with.
-- =============================================================================

CREATE TABLE recurring_schedules (
    id                     TEXT PRIMARY KEY,
    book_id                TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- Fixed for the schedule's whole life — see the header note on why this
    -- is not one of `recurring_schedule_update`'s patchable fields.
    kind                   TEXT NOT NULL CHECK (kind IN ('invoice', 'transaction')),
    status                 TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'ended')),
    name                   TEXT NOT NULL,
    -- Recurrence rule. `frequency`/`interval_count`/`start_date` are fixed at
    -- creation for the identical reason `kind` is — see the header.
    frequency              TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
    interval_count         INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
    -- Occurrence 0's date, and the day-of-month/day-of-year every later
    -- occurrence's clamp anchors back to. See `crate::recurrence` for the
    -- arithmetic this drives.
    start_date             TEXT NOT NULL,
    -- Inclusive: an occurrence landing after this date ends the schedule
    -- instead of generating. NULL = no end date.
    end_date               TEXT,
    -- NULL = unbounded. Otherwise the schedule ends once
    -- `occurrences_processed` reaches this count.
    max_occurrences        INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
    -- How many occurrences (generated or skipped) this schedule has already
    -- reached. The next one to process is occurrence index
    -- `occurrences_processed` itself (0-based) — never decremented, and the
    -- only writer is `CoreService::recurring_process_occurrence`.
    occurrences_processed  INTEGER NOT NULL DEFAULT 0 CHECK (occurrences_processed >= 0),
    -- `crate::recurrence::occurrence_date(start_date, frequency,
    -- interval_count, occurrences_processed)`, cached so "what's due" is an
    -- indexed WHERE clause rather than a per-row recomputation, and rewritten
    -- every time `occurrences_processed` advances. Never hand-set.
    next_run_date          TEXT NOT NULL,

    -- Invoice-kind template fields (kind = 'invoice'). Required by
    -- `recurring_schedule_create`/`recurring_process_occurrence` when kind is
    -- 'invoice'; otherwise NULL and unused, the same discriminated-by-kind
    -- shape `sales_order_items.variant_id` uses for "catalogue line or
    -- free-text line".
    contact_id             TEXT REFERENCES contacts (id) ON DELETE RESTRICT,
    series                 TEXT,
    -- Offset in days from an occurrence's date to that invoice's due date.
    -- NULL is treated as 0 (due on the issue date) by the service layer,
    -- matching how `invoice_issue` itself requires a due date but this
    -- template expresses it relatively so it stays correct however far in
    -- the future an occurrence lands.
    due_days               INTEGER CHECK (due_days IS NULL OR due_days >= 0),

    -- Transaction-kind template fields (kind = 'transaction'). Required when
    -- kind is 'transaction'; otherwise NULL and unused.
    account_id             TEXT REFERENCES accounts (id) ON DELETE RESTRICT,
    category_id            TEXT REFERENCES categories (id) ON DELETE SET NULL,
    amount_minor           INTEGER,
    merchant               TEXT,
    description            TEXT,

    -- Shared by both kinds. `currency` NULL defers to the book's own
    -- currency at generation time (re-resolved on every occurrence, not
    -- frozen at creation) — the identical default `invoice_issue` and
    -- `transaction_create` already apply when a caller omits it.
    currency               TEXT CHECK (currency IS NULL OR length(currency) = 3),
    notes                  TEXT,

    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
);

CREATE INDEX recurring_schedules_book_idx ON recurring_schedules (book_id);
-- Backs `recurring_due_list`/`recurring_run_due`: every active schedule due
-- as of a date, in one indexed scan.
CREATE INDEX recurring_schedules_due_idx ON recurring_schedules (book_id, status, next_run_date);
CREATE INDEX recurring_schedules_contact_idx
    ON recurring_schedules (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX recurring_schedules_account_idx
    ON recurring_schedules (account_id) WHERE account_id IS NOT NULL;

CREATE TABLE recurring_schedule_items (
    id                TEXT PRIMARY KEY,
    schedule_id       TEXT NOT NULL REFERENCES recurring_schedules (id) ON DELETE CASCADE,
    -- Denormalized from recurring_schedules.book_id, the same choice
    -- migration 0014 makes for sales_order_items.book_id.
    book_id           TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    variant_id        TEXT REFERENCES product_variants (id) ON DELETE RESTRICT,
    description       TEXT NOT NULL,
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    tax_rate_bps      INTEGER NOT NULL DEFAULT 0
        CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
    line_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE INDEX recurring_schedule_items_schedule_idx ON recurring_schedule_items (schedule_id);
CREATE INDEX recurring_schedule_items_book_idx ON recurring_schedule_items (book_id);
CREATE INDEX recurring_schedule_items_variant_idx
    ON recurring_schedule_items (variant_id) WHERE variant_id IS NOT NULL;

-- One immutable fact per occurrence a schedule has ever reached. See the
-- header for why this, and not re-derivation, is what makes running due
-- schedules twice safe.
CREATE TABLE recurring_runs (
    id                TEXT PRIMARY KEY,
    schedule_id       TEXT NOT NULL REFERENCES recurring_schedules (id) ON DELETE CASCADE,
    book_id           TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- 0-based, matching recurring_schedules.occurrences_processed.
    occurrence_index  INTEGER NOT NULL CHECK (occurrence_index >= 0),
    occurrence_date   TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('generated', 'skipped')),
    -- Set together, or both NULL for a skipped occurrence.
    generated_table   TEXT CHECK (generated_table IS NULL OR generated_table IN ('invoices', 'transactions')),
    generated_id      TEXT,
    created_at        TEXT NOT NULL,
    -- The backstop described in the header: a second attempt at the same
    -- occurrence fails loudly here rather than existing side by side.
    UNIQUE (schedule_id, occurrence_index)
);

CREATE INDEX recurring_runs_schedule_idx ON recurring_runs (schedule_id);
CREATE INDEX recurring_runs_book_idx ON recurring_runs (book_id);

CREATE TRIGGER recurring_runs_no_update
BEFORE UPDATE ON recurring_runs
BEGIN
    SELECT RAISE(ABORT, 'a recurring run is an immutable fact; record a compensating action instead');
END;

CREATE TRIGGER recurring_runs_no_delete
BEFORE DELETE ON recurring_runs
BEGIN
    SELECT RAISE(ABORT, 'a recurring run is an immutable fact; record a compensating action instead');
END;

-- -----------------------------------------------------------------------------
-- Sync capture. See migration 0008's header for why this is a trigger and not
-- a call from the repo layer, and migration 0014's header for the exact same
-- split applied there: `recurring_schedules`/`recurring_schedule_items` get
-- the full INSERT/UPDATE/DELETE set (§4.4 LWW); `recurring_runs` gets
-- INSERT-only (§4.3 OR-Set — its own `_no_update`/`_no_delete` triggers above
-- make an UPDATE/DELETE capture trigger unreachable code, exactly like
-- `invoices`). `crates/slipscan-sync/src/lib.rs`'s `LWW_TABLES` gains
-- `recurring_schedules` and `recurring_schedule_items`, and `LEDGER_TABLES`
-- gains `recurring_runs`, in the same change as this migration —
-- `crate::sync::capture::tests` (this crate) and `slipscan_sync::tests`
-- assert both agree in both directions.
-- -----------------------------------------------------------------------------

CREATE TRIGGER sync_capture_recurring_schedules_ins AFTER INSERT ON recurring_schedules
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_schedules', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_recurring_schedules_upd AFTER UPDATE ON recurring_schedules
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_schedules', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_recurring_schedules_del AFTER DELETE ON recurring_schedules
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_schedules', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_recurring_schedule_items_ins AFTER INSERT ON recurring_schedule_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_schedule_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_recurring_schedule_items_upd AFTER UPDATE ON recurring_schedule_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_schedule_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_recurring_schedule_items_del AFTER DELETE ON recurring_schedule_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_schedule_items', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_recurring_runs_ins AFTER INSERT ON recurring_runs
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('recurring_runs', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No backfill needed: none of this migration's tables existed before it, so
-- there are no pre-existing rows for any outbox to catch up on.
