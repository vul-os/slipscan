-- =============================================================================
-- Migration 0016: stock posts to the ledger (Phase 6.6, ROADMAP.md "Inventory
-- & trade" — the keystone, and the one piece neither codebase this fold
-- re-derives from had). A goods receipt now debits inventory-asset and
-- credits accounts-payable; a confirmed sale posts cost-of-goods-sold,
-- revenue and VAT against the existing chart of accounts — see
-- `CoreService::post_po_receipt_journal`, `::post_sales_confirm_journals`,
-- `::reverse_sales_confirm_journals` and `::post_invoice_payment_journal` in
-- `service.rs` for the postings themselves; this migration only widens the
-- one constraint that stood in their way.
--
-- **The one schema change this stage needs.** Every journal migration 0001
-- ever generates carries a `source_type`, and that column's CHECK constraint
-- — `IN ('manual', 'transaction', 'document', 'opening_balance')` — has no
-- room for the four new automatic sources this stage adds: a goods receipt,
-- a confirmed sale's cost/inventory leg, its revenue/AR/VAT leg, and an
-- invoice payment (`JournalSourceType::PoReceipt` / `SalesCogs` /
-- `SalesRevenue` / `InvoicePayment` in `domain.rs`). `journal_generate_for_
-- transaction`/`_for_document` already prove the pattern this stage reuses
-- exactly: one net-live generated journal per (`source_type`, `source_id`),
-- enforced in `post_journal_in_tx`, so `po_receive`/`sales_order_confirm`/
-- `invoice_payment_record` can never double-post no matter how many times
-- they are (mistakenly) retried against the same receipt/order/payment id.
--
-- **Why a confirmed sale is two journals, not one four-line entry.**
-- ROADMAP.md 6.6 names this explicitly: "two paired postings" — cost/
-- inventory and revenue/AR/VAT are recorded as two independent journals
-- sharing one `source_id` (the sales order) but distinct `source_type`s.
-- Splitting them is what lets `sales_order_cancel` reverse either leg on its
-- own (a book with Inventory/COGS seeded but no Revenue/AR account, or vice
-- versa, still gets a coherent partial posting rather than an all-or-nothing
-- one) and is what keeps `journal_reverse`'s "at most one reversal per
-- journal" invariant meaningful for each leg independently.
--
-- **Why this is a table rebuild, not an `ALTER TABLE ADD CONSTRAINT`.**
-- SQLite has no such statement — a CHECK constraint can only be changed by
-- recreating the table. Both `journals_no_update`/`journals_no_delete` (the
-- immutability triggers) and the `journals_source_idx`/`journals_reversal_of_
-- unique` indexes are dropped along with the old table and recreated
-- immediately after, so nothing about immutability or the source-lookup
-- guarantee is weakened even momentarily. `foreign_keys` stays ON throughout
-- (the migration runner cannot toggle it mid-transaction — the pragma is a
-- documented no-op once a transaction is already open): SQLite does not walk
-- child-table rows on `DROP TABLE` of the parent, only on row-level
-- INSERT/UPDATE/DELETE, and `journal_lines.journal_id`/`recon_matches.
-- journal_id` resolve `REFERENCES journals (id)` by name at DML time — not
-- at the FK clause's own creation time — so both continue to enforce
-- correctly against the rebuilt table with no `sql` text of theirs to fix up.
-- SlipScan has never shipped (`db.rs`'s own header), so there is no deployed
-- database whose existing `journals` rows this needs to preserve in
-- production, but the copy step below is written as if there were, because a
-- developer's local file already might.
-- =============================================================================

CREATE TABLE journals_0016_new (
    id          TEXT PRIMARY KEY,
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    posted_date TEXT NOT NULL,
    narrative   TEXT,
    reference   TEXT,
    source_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (source_type IN (
            'manual', 'transaction', 'document', 'opening_balance',
            'po_receipt', 'sales_cogs', 'sales_revenue', 'invoice_payment'
        )),
    source_id   TEXT,
    created_at  TEXT NOT NULL,
    reversal_of TEXT REFERENCES journals (id)
);

INSERT INTO journals_0016_new
    (id, book_id, posted_date, narrative, reference, source_type, source_id,
     created_at, reversal_of)
SELECT id, book_id, posted_date, narrative, reference, source_type, source_id,
       created_at, reversal_of
FROM journals;

DROP TABLE journals;

ALTER TABLE journals_0016_new RENAME TO journals;

CREATE INDEX journals_book_date_idx ON journals (book_id, posted_date DESC);
CREATE UNIQUE INDEX journals_reversal_of_unique
    ON journals (reversal_of) WHERE reversal_of IS NOT NULL;
CREATE INDEX journals_source_idx
    ON journals (book_id, source_type, source_id)
    WHERE source_id IS NOT NULL;

CREATE TRIGGER journals_no_update
BEFORE UPDATE ON journals
BEGIN
    SELECT RAISE(ABORT, 'posted journals are immutable; post a reversal instead');
END;

CREATE TRIGGER journals_no_delete
BEFORE DELETE ON journals
BEGIN
    SELECT RAISE(ABORT, 'posted journals are immutable; post a reversal instead');
END;

-- Sync capture: INSERT only, restated exactly as migration 0001 has it (the
-- rebuild above dropped the original trigger along with the table it lived
-- on).
CREATE TRIGGER sync_capture_journals_ins AFTER INSERT ON journals
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('journals', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No outbox backfill: this migration renames and reconstrains a table, it
-- does not create one — any pre-existing journals rows already have their
-- own INSERT captured from whenever they were first written, and the rebuild
-- above runs with `sync_control.applying` in whatever state it was already
-- in, same as every other statement in this transaction.
