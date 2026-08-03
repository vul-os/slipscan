-- =============================================================================
-- Migration 0013: purchase orders and goods receipts (Phase 6.4, ROADMAP.md
-- "Inventory & trade" — "Purchase orders and goods receipts, receipts
-- insert-only so partial deliveries recorded at two locations merge by
-- union"). Re-derived from the retired FlowStock product, not ported from it.
--
-- Three tables:
--
--   purchase_orders       the header a business sends to a supplier: who,
--                         where it is expected, when, and the running money
--                         totals. Editable — a PO gets its delivery date
--                         pushed out, its notes corrected, its status moved
--                         along.
--   purchase_order_items  line items against a variant: how many, at what
--                         unit price.
--   po_receipts           **insert-only.** One row per "we received N of
--                         this line" — never a stored counter on the item.
--
-- **Why `po_receipts` is insert-only, and why that is not optional.** A line
-- ordering 100 units can be received in more than one delivery, at more than
-- one location (a supplier drop-shipping a single PO across two warehouses,
-- or two branches independently confirming their own portion while offline
-- from each other), and by more than one device before either has heard from
-- the other. A stored "received_so_far" counter on `purchase_order_items`
-- would let two disconnected receipts race: both read 0, both write 40,
-- and the second write clobbers the first — the exact failure
-- `stock_movements` (migration 0012) exists to rule out for on-hand, restated
-- here for receiving progress. `po_receipts` instead records each receiving
-- event as its own immutable row, triggers below make the alternative
-- impossible at the database level, and a line's received quantity is always
-- `SUM(qty)` over its rows — `repo::purchasing::received_qty_for_item`,
-- computed at query time, never cached. Two receipts recorded anywhere, in
-- any order, converge the moment their rows union: this is `stock_movements`'
-- own discipline, followed exactly rather than reinvented.
--
-- **A receipt is signed, like a movement, not just positive.** `qty` carries
-- `CHECK (qty != 0)` rather than `CHECK (qty > 0)` — the same choice
-- `stock_movements.qty_delta` makes and for the same reason: a warehouse that
-- receives 50 units then discovers on recount that only 47 actually arrived
-- corrects that with a second row of `qty = -3`, never by editing the first
-- row (the triggers refuse that outright) and never by decrementing a
-- counter that a concurrent receipt at another site might be updating at the
-- same instant.
--
-- **Every receipt writes a stock movement, in the same transaction, through
-- `repo::stock` — never a second, parallel record of "how much arrived".**
-- `CoreService::po_receive` calls the same `insert_movement_in_tx` helper
-- `stock_transfer` already shares with `stock_movement_record`, with
-- `kind = 'receipt'`, `ref_kind = 'po_receipt'` and `ref_id` = the new
-- `po_receipts.id`. This is the keystone invariant ROADMAP.md 6.4 names
-- explicitly: on-hand and purchasing read two different tables today (there
-- is still no posting to the accounting ledger — that is 6.6), but they
-- can never disagree about *how much arrived*, because exactly one code path
-- produces both facts inside one SQLite transaction. There is deliberately no
-- reverse pointer (no `stock_movement_id` column on `po_receipts`): the
-- movement is discoverable via `stock_movements_for_ref('po_receipt', id)`,
-- the same lookup `TransferResult`'s two legs already use, so this migration
-- invents no second linking convention.
--
-- **Receiving status (none / partial / complete) is derived, never stored —
-- extending ROADMAP.md Phase 6 decision #4 from stock to purchasing.**
-- Neither `purchase_order_items` nor `purchase_orders` carries a
-- received-quantity or receiving-status column; `CoreService::
-- po_item_receiving_status`/`po_receiving_status` compute it from
-- `SUM(qty)` over `po_receipts` compared against `qty_ordered`, the same
-- shape as `repo::stock::on_hand`.
--
-- **`purchase_orders.status` is the one field in this migration that is
-- stored and hand-maintained rather than derived, and this is where that is
-- said plainly, as asked.** It answers "has a human sent this to the
-- supplier yet, or cancelled it" (`draft` / `ordered` / `cancelled`) — a
-- workflow fact with no receipt row to derive it from. A PO with zero
-- receipts might be freshly created (`draft`) or might have been sent to the
-- supplier a month ago and simply not delivered anything yet (`ordered`);
-- nothing in `po_receipts` distinguishes the two, so nothing in `po_receipts`
-- could ever compute this field. `CoreService::po_set_status` is the only
-- writer, mirroring `document_transition`'s own guarded state machine
-- (migration 0001) rather than letting a general patch touch it.
--
-- **Money**, following migration 0001/0011's convention exactly:
-- `_minor` INTEGER + one paired `currency` TEXT column per row.
-- `purchase_orders.subtotal_minor` is `SUM(purchase_order_items.total_minor)`
-- for that order, recomputed by the service layer whenever a line is added,
-- changed or removed (the header row is a plain LWW register — see the sync
-- section below — so recomputing and writing it back is an ordinary update,
-- not a second source of truth: there is nowhere else `subtotal_minor` could
-- come from). `tax_minor` is entered directly rather than computed from
-- `vat_rates`: nothing here reads a rate table yet, because which of a PO's
-- lines are taxable, and at what rate, is a decision Phase 6.6 (posting to
-- the accounting ledger) has to make together with the chart-of-accounts
-- mapping — computing a number here that 6.6 would immediately have to
-- second-guess is worse than asking for it once. `total_minor =
-- subtotal_minor + tax_minor`, also kept in step by the service layer.
--
-- **FKs, following `stock_movements`' precedent exactly.**
-- `purchase_orders.supplier_id` (-> `contacts`) and `.location_id`
-- (-> `locations`) are both `ON DELETE RESTRICT`: a PO with a supplier or a
-- location is trade history, and deleting either out from under it would
-- leave a PO pointing at nothing. `purchase_order_items.variant_id`
-- (-> `product_variants`) is `RESTRICT` for the same reason `stock_movements.
-- variant_id` is. `purchase_order_items.purchase_order_id` is `CASCADE`
-- (deleting a PO takes its own lines with it), but `po_receipts.
-- purchase_order_item_id` is `RESTRICT` — which means a PO cannot actually be
-- deleted once any of its lines has a receipt: the CASCADE attempt to remove
-- the line is itself blocked by the RESTRICT on `po_receipts`, and SQLite
-- fails the whole statement. That fallout is deliberate, not a bug to work
-- around: a PO with receipts against it is exactly the trade history
-- `stock_movements`' own header comment already refuses to let a variant or
-- location delete out from under.
--
-- **`location_id` is required on both `purchase_orders` and `po_receipts`,
-- and that means using purchasing (like using stock at all — migration
-- 0012 has the identical requirement) needs at least one `locations` row to
-- exist first, regardless of what Phase 6.0's still-unbuilt multi-location
-- UI is showing.** `po_receipts.location_id` is not copied from the parent
-- PO — it is the location *that* receipt actually happened at, which is the
-- whole reason two sites can both receive against one PO line and still
-- converge cleanly: each receipt names its own location, and nothing needs
-- to reconcile which site's receipt is more true. A single-location business
-- typically receives every line at the PO's own `location_id`; the column
-- exists on the receipt, not inherited implicitly, so a multi-site delivery
-- is representable without a schema change later.
--
-- **What this migration does not build.** No posting to `journals`/
-- `journal_lines` — a goods receipt does not yet debit inventory-asset or
-- credit accounts-payable, so Phase 6 remains an inventory app sharing a
-- binary with an accounting one until 6.6 lands, exactly as migration
-- 0012 already says of stock movements alone. No sales orders (6.5). No
-- partial-line cancellation, no PO amendment history beyond ordinary LWW
-- overwrite, and no reassignment guard on `purchase_order_items` beyond the
-- receipt-blocks-delete behaviour above.
-- =============================================================================

CREATE TABLE purchase_orders (
    id                 TEXT PRIMARY KEY,
    book_id            TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    supplier_id        TEXT NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
    location_id        TEXT NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
    po_number          TEXT NOT NULL,
    order_date         TEXT NOT NULL,
    expected_delivery  TEXT,
    -- Hand-maintained workflow state — see the header note on why this is
    -- the one field here that is *not* derived from po_receipts.
    status             TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ordered', 'cancelled')),
    subtotal_minor     INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
    tax_minor          INTEGER NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
    total_minor        INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    currency           TEXT NOT NULL CHECK (length(currency) = 3),
    notes              TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (book_id, po_number)
);

CREATE INDEX purchase_orders_book_idx ON purchase_orders (book_id);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);
CREATE INDEX purchase_orders_location_idx ON purchase_orders (location_id);
-- Backs "open POs" / "cancelled POs" listings, leftmost-prefix on book_id
-- alone also serving the plain per-book listing.
CREATE INDEX purchase_orders_book_status_idx ON purchase_orders (book_id, status);

CREATE TABLE purchase_order_items (
    id                 TEXT PRIMARY KEY,
    purchase_order_id  TEXT NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
    -- Denormalized from purchase_orders.book_id, the same choice migration
    -- 0011 made for product_variants.book_id: needed for a per-book scan and
    -- for this table's own sync-capture trigger's `ns` below.
    book_id            TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    variant_id         TEXT NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
    qty_ordered        INTEGER NOT NULL CHECK (qty_ordered > 0),
    unit_price_minor   INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
    -- qty_ordered * unit_price_minor, kept in step by the service layer
    -- (CoreService::po_item_add/_update) — no CHECK enforces the product
    -- itself, the same trust boundary migration 0011 already gives
    -- product_variants.price_minor/cost_price_minor.
    total_minor        INTEGER NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE INDEX purchase_order_items_po_idx ON purchase_order_items (purchase_order_id);
CREATE INDEX purchase_order_items_variant_idx ON purchase_order_items (variant_id);
CREATE INDEX purchase_order_items_book_idx ON purchase_order_items (book_id);

CREATE TABLE po_receipts (
    id                       TEXT PRIMARY KEY,
    -- Denormalized from purchase_order_items.book_id via the item, the same
    -- reason stock_movements.book_id is denormalized from the variant.
    book_id                  TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    purchase_order_item_id   TEXT NOT NULL REFERENCES purchase_order_items (id) ON DELETE RESTRICT,
    -- The location THIS receipt happened at — see the header note on why
    -- this is not simply inherited from the parent PO.
    location_id              TEXT NOT NULL REFERENCES locations (id) ON DELETE RESTRICT,
    -- Signed, like stock_movements.qty_delta, and for the identical reason:
    -- a correction is a second row, never an edit to this one.
    qty                      INTEGER NOT NULL CHECK (qty != 0),
    note                     TEXT,
    -- Free text, no FK — SlipScan has no user/staff identity yet (see
    -- stock_movements.created_by in migration 0012 for the same limitation,
    -- ROADMAP.md 6.8 is where it gets built).
    received_by              TEXT,
    created_at               TEXT NOT NULL
);

CREATE INDEX po_receipts_item_idx ON po_receipts (purchase_order_item_id);
CREATE INDEX po_receipts_book_idx ON po_receipts (book_id);
CREATE INDEX po_receipts_location_idx ON po_receipts (location_id);

-- A receipt's content is its identity, the same way a stock movement's is
-- (migration 0012) and a posted journal's is (migration 0001): there is no
-- correcting one in place, only recording a second, compensating receipt.
CREATE TRIGGER po_receipts_no_update
BEFORE UPDATE ON po_receipts
BEGIN
    SELECT RAISE(ABORT, 'goods receipts are immutable; record a compensating receipt instead');
END;

CREATE TRIGGER po_receipts_no_delete
BEFORE DELETE ON po_receipts
BEGIN
    SELECT RAISE(ABORT, 'goods receipts are immutable; record a compensating receipt instead');
END;

-- =============================================================================
-- Sync capture. See migration 0008's header for why this is a trigger and not
-- a call from the repo layer.
--
-- purchase_orders and purchase_order_items are ordinary editable rows (a
-- delivery date slips, a line's quantity gets corrected before it ships) —
-- the §4.4 LWW register mapping, added to `slipscan_sync::LWW_TABLES`
-- alongside `contacts` and the catalogue tables. po_receipts is an immutable
-- ledger fact merged by union, exactly like `stock_movements`, and is added
-- to `LEDGER_TABLES` instead — never both, and never neither: `crate::sync::
-- capture::tests` asserts the trigger set installed below agrees with those
-- two lists in both directions.
-- =============================================================================

-- purchase_orders ------------------------------------------------------------
CREATE TRIGGER sync_capture_purchase_orders_ins AFTER INSERT ON purchase_orders
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('purchase_orders', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_purchase_orders_upd AFTER UPDATE ON purchase_orders
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('purchase_orders', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_purchase_orders_del AFTER DELETE ON purchase_orders
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('purchase_orders', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- purchase_order_items ---------------------------------------------------------
CREATE TRIGGER sync_capture_purchase_order_items_ins AFTER INSERT ON purchase_order_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('purchase_order_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_purchase_order_items_upd AFTER UPDATE ON purchase_order_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('purchase_order_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_purchase_order_items_del AFTER DELETE ON purchase_order_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('purchase_order_items', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- po_receipts: insert-only, exactly like stock_movements above it.
CREATE TRIGGER sync_capture_po_receipts_ins AFTER INSERT ON po_receipts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('po_receipts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No backfill needed: none of these three tables existed before this
-- migration, so there are no pre-existing rows for the outbox to catch up on.
