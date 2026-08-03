-- =============================================================================
-- Migration 0014: sales orders and invoicing (Phase 6.5, ROADMAP.md "Inventory
-- & trade"). PARITY.md's bluntest line: "there is no invoicing at all — no
-- invoice entity, no numbering, no delivery, no paid/unpaid state". This
-- migration is what closes it.
--
-- **Why 0014 and not 0013.** ROADMAP.md numbers Phase 6's stages 6.1..6.9, and
-- the migrations follow that order 1:1 (0009 = 6.1 locations, 0010 = 6.2
-- contacts, 0011 = 6.3a catalogue, 0012 = 6.3b stock, 0013 = 6.4 purchasing).
-- This file was written concurrently with 0013, on a separate branch, and
-- took 0014 because that number was reserved for it up front rather than
-- picked as "one past the highest I can see" — which is exactly how two
-- branches both end up called 0013. Both landed, contiguous, needing no
-- renumbering at merge time.
--
-- **Two tables, two different mapping decisions, on purpose.** This is the
-- one design choice in this migration worth reading closely, because the
-- obvious shape (one lifecycle, one table) is wrong for exactly the reason
-- ROADMAP.md's Phase 6 header keeps repeating about stock:
--
--   sales_orders / sales_order_items    An editable draft while a person is
--                                       still deciding what is on it — add a
--                                       line, fix a quantity, change the
--                                       customer. `status` moves it through
--                                       draft -> confirmed -> paid, or ->
--                                       cancelled from either of the first
--                                       two. This is a §4.4 LWW register, the
--                                       same family as `contacts` and
--                                       `product_variants`: last-writer-wins
--                                       is exactly what a person means by
--                                       editing their own draft on two
--                                       devices.
--
--   invoices / invoice_items /          Never editable, from the moment they
--   invoice_payments                    exist. An invoice is not created as a
--                                       draft and then issued — `invoice_
--                                       issue` is the only way one comes into
--                                       being, and the row it inserts already
--                                       carries its permanent number. That is
--                                       the sentence in the phase brief worth
--                                       taking literally: "an issued invoice
--                                       with a number is closer to a fact
--                                       than to an editable row." A fact
--                                       does not get corrected in place —
--                                       correcting one is future work (a
--                                       credit note, following the exact
--                                       `journals.reversal_of` pattern
--                                       migration 0001 already uses for a
--                                       posted journal), not an UPDATE
--                                       statement. So these three tables are
--                                       §4.3 OR-Sets — `LEDGER_TABLES`, the
--                                       same family as `journals` and
--                                       `stock_movements` — insert-only, with
--                                       the same `_no_update`/`_no_delete`
--                                       triggers `journals` has. Paid/unpaid/
--                                       partly-paid is *derived* from
--                                       `invoice_payments`, never a stored
--                                       status column on `invoices` — the
--                                       identical discipline migration 0012
--                                       applies to on-hand stock (Decision 4:
--                                       "always derived, never stored"), for
--                                       the identical reason: a cached status
--                                       is the one thing that cannot survive
--                                       two devices recording payments
--                                       against the same invoice while
--                                       disconnected, and a derived SUM
--                                       converges the moment their rows
--                                       union.
--
-- **`number_sequences` is deliberately NOT a replicated table.** It hands out
-- the next integer for a `(book_id, series)` pair, atomically, to whichever
-- caller asks first — but "first" only means anything on *one* SQLite file.
-- Two offline devices each holding this book would each locally believe they
-- are handing out invoice #47, and nothing about replicating this counter
-- fixes that: the moment their `sync_outbox` rows union, both #47s exist,
-- which is precisely the duplicate this migration exists to make impossible.
-- The `UNIQUE (book_id, series, number)` index on `invoices` below is the
-- backstop that turns that scenario into a loud constraint violation instead
-- of a silent collision — but a caught collision is still a collision.
-- **This is a real, open gap**, not an oversight: today nothing carries an
-- operation from one device to another at all (ROADMAP.md Phase 4's
-- transport is still unbuilt, and Phase 6.7 "Sync transport" is still
-- unstarted too), so two devices concurrently issuing invoices against the
-- same book is not a scenario this codebase can reach yet. The guarantee
-- this migration actually delivers — proven under real concurrent access in
-- `crate::service::tests` — is that **one book's numbering has no gap and no
-- duplicate no matter how many threads or processes on the *same machine*
-- race to issue against it**, which is the guarantee available today. A
-- numbering scheme that survives multi-device concurrency (a device-prefixed
-- number space, or a designated numbering authority) is 6.7's problem to
-- solve once a transport exists to make the race real, and is named here so
-- it is not mistaken for solved.
--
-- **What "delivery" means here.** ROADMAP.md's 6.5 line promises "numbering,
-- delivery and paid/unpaid state" alongside invoicing. There is no separate
-- goods-issue-note or packing-slip table: "delivery" is `sales_order_confirm`
-- deducting stock (kind = 'sale', below) — the moment goods actually leave a
-- location. An order is all-or-nothing: confirming deducts every stock line's
-- full quantity in one shot. Partial fulfilment across more than one delivery
-- is not built; a partial shipment today is modelled as two smaller orders.
--
-- **What else is deliberately not here**, stated plainly rather than left to
-- be discovered later:
--   - No quotes/estimates (PARITY.md's next Xero row, blocked behind this one
--     on purpose — a quote converts into an order, which now exists to
--     convert into).
--   - No credit notes or invoice voiding. Once issued, an invoice is
--     permanent; correcting one is future work following the journal
--     reversal pattern noted above.
--   - No per-line currency and no multi-currency invoice: `sales_orders.
--     currency`/`invoices.currency` is one code for the whole document, and
--     every line's `unit_price_minor` is understood to already be in it. A
--     variant's own `currency` (migration 0011) is not cross-checked against
--     the order's — mixing variants priced in different currencies on one
--     order produces a document whose lines do not individually convert,
--     which matches PARITY.md's existing, separately-tracked gap ("no report
--     converts anything").
--   - Quantities are `INTEGER`, matching `stock_movements.qty_delta` exactly
--     — a fractional line (e.g. 2.5 consulting hours) is out of scope; price
--     the line instead of the quantity until this needs revisiting.
--   - No posting to `journals`/`journal_lines`. Confirming an order deducts
--     stock; issuing an invoice or recording a payment touches none of the
--     accounting tables. Phase 6.6 owns turning a confirmed sale into
--     revenue/VAT/COGS journal lines — the hook is named at the call site in
--     `service.rs` rather than guessed at here.
--   - No availability check on confirm: a sale that would take on-hand
--     negative is allowed, matching the stock ledger's existing permissive
--     model (nothing in migration 0012 requires on-hand to stay >= 0 either;
--     a count that finds the shortfall is what an `adjustment` movement is
--     for).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- number_sequences — a local, per-book, per-series counter. See the header
-- above for why this table is deliberately absent from both sync registries:
-- it is device-local bookkeeping, not a fact meant to be shared.
--
-- `next_number` is the value the *next* allocation will hand out; the
-- allocator (`repo::sales::allocate_number`) UPSERTs it up by one and returns
-- the pre-increment value, inside the same transaction as the row the number
-- is stamped onto — so a transaction that rolls back for any other reason
-- also rolls back the increment, which is what makes the sequence gapless
-- rather than merely unique.
-- -----------------------------------------------------------------------------

CREATE TABLE number_sequences (
    book_id     TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    series      TEXT NOT NULL,
    next_number INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (book_id, series)
);

-- -----------------------------------------------------------------------------
-- sales_orders / sales_order_items — the editable draft. See the header above
-- for why these two are §4.4 LWW registers rather than ledger facts.
-- -----------------------------------------------------------------------------

CREATE TABLE sales_orders (
    id           TEXT PRIMARY KEY,
    book_id      TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- A customer with any order history cannot be deleted out from under it —
    -- see the note on `crate::service::CoreService::contact_remove`, updated
    -- in this change to say so. Matches migration 0012's treatment of
    -- `stock_movements.variant_id`/`location_id`.
    contact_id   TEXT NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
    -- Nullable: a purely service/free-text order never touches stock and so
    -- never needs a place. `sales_order_confirm` requires this to be set the
    -- moment the order has even one stock-tracked line — see service.rs.
    -- Also RESTRICT, for the identical reason as `contact_id`: a location a
    -- sale has ever been recorded against (even one still in draft) is trade
    -- history, one more case of migration 0009's own note that its "no
    -- reassignment guard" claim holds only "until this migration" — meaning
    -- whichever migration first gives a location a real reference. This one
    -- does.
    location_id  TEXT REFERENCES locations (id) ON DELETE RESTRICT,
    -- Assigned once, atomically, by `repo::sales::allocate_number` at
    -- creation — see `number_sequences` above. Never reassigned.
    number       INTEGER NOT NULL,
    order_date   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'confirmed', 'paid', 'cancelled')),
    -- The whole document's currency; see the header note on why lines do not
    -- carry their own.
    currency     TEXT NOT NULL CHECK (length(currency) = 3),
    notes        TEXT,
    confirmed_at TEXT,
    cancelled_at TEXT,
    paid_at      TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    UNIQUE (book_id, number)
);

CREATE INDEX sales_orders_book_idx ON sales_orders (book_id);
CREATE INDEX sales_orders_book_status_idx ON sales_orders (book_id, status);
CREATE INDEX sales_orders_contact_idx ON sales_orders (contact_id);
CREATE INDEX sales_orders_location_idx
    ON sales_orders (location_id) WHERE location_id IS NOT NULL;

CREATE TABLE sales_order_items (
    id                TEXT PRIMARY KEY,
    sales_order_id    TEXT NOT NULL REFERENCES sales_orders (id) ON DELETE CASCADE,
    -- Denormalized from sales_orders.book_id, the same choice migration 0011
    -- made for product_variants.book_id: per-book scoping and this table's
    -- own sync `ns` both need it directly rather than through a join.
    book_id           TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- NULL = a free-text/service line, never touched by stock. Set = a
    -- catalogue line; `sales_order_confirm` deducts stock for every line that
    -- has one. RESTRICT: a variant that has ever appeared on an order (even
    -- a cancelled one — the line itself is never deleted) is trade history.
    variant_id        TEXT REFERENCES product_variants (id) ON DELETE RESTRICT,
    -- What the line says it is, captured at add-time. For a catalogue line
    -- this defaults from the variant's own name (service layer) but is
    -- stored here regardless, so a later rename of the variant does not
    -- silently reword an order line that already went out — the identical
    -- reasoning journal_lines.description already gets a free pass on.
    description       TEXT NOT NULL,
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    -- Basis points, same convention as vat_rates.rate_bps — a snapshot of
    -- whatever rate applied when the line was added, not a live FK to
    -- vat_rates: a rate that changes next quarter must not reword a line
    -- already sitting on someone's order.
    tax_rate_bps      INTEGER NOT NULL DEFAULT 0
        CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
    line_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE INDEX sales_order_items_order_idx ON sales_order_items (sales_order_id);
CREATE INDEX sales_order_items_book_idx ON sales_order_items (book_id);
CREATE INDEX sales_order_items_variant_idx
    ON sales_order_items (variant_id) WHERE variant_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- invoices / invoice_items / invoice_payments — the immutable fact. See the
-- header above for why these three are §4.3 OR-Sets rather than editable
-- rows, and for why there is no `status` column on `invoices` at all: paid/
-- unpaid/partly-paid is always `SUM(invoice_payments.amount_minor)` compared
-- against the sum of `invoice_items`, computed at query time in
-- `repo::sales`, never stored.
-- -----------------------------------------------------------------------------

CREATE TABLE invoices (
    id             TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    contact_id     TEXT NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
    -- Optional: `invoice_issue` accepts either a confirmed/paid sales order
    -- to copy line items from, or a standalone set of items with no order at
    -- all (a retainer, a one-off service bill). ON DELETE SET NULL rather
    -- than RESTRICT: an issued invoice is a permanent fact regardless of
    -- what becomes of the order that spawned it, and `sales_orders` has no
    -- delete path once confirmed/paid in any case (`sales_order_delete` is
    -- draft-only) — this is defensive, not load-bearing.
    sales_order_id TEXT REFERENCES sales_orders (id) ON DELETE SET NULL,
    -- A numbering book, not a document type: 'invoice' is the only series
    -- this migration's own service functions ever write, but the column is
    -- free text (like stock_movements.ref_kind) so a future credit-note or
    -- per-location numbering book has somewhere to live without a schema
    -- change.
    series         TEXT NOT NULL DEFAULT 'invoice',
    number         INTEGER NOT NULL,
    issue_date     TEXT NOT NULL,
    due_date       TEXT NOT NULL,
    currency       TEXT NOT NULL CHECK (length(currency) = 3),
    notes          TEXT,
    created_at     TEXT NOT NULL,
    -- The structural half of "no gap, no duplicate": even if
    -- `repo::sales::allocate_number` ever had a bug, two invoices sharing a
    -- number in the same book/series fail loudly here rather than existing
    -- side by side. Belt and suspenders, the same pairing migration 0001
    -- gives journal balance (a service-layer check *and* a CHECK constraint).
    UNIQUE (book_id, series, number)
);

CREATE INDEX invoices_book_idx ON invoices (book_id);
CREATE INDEX invoices_contact_idx ON invoices (contact_id);
CREATE INDEX invoices_sales_order_idx
    ON invoices (sales_order_id) WHERE sales_order_id IS NOT NULL;
-- Backs aged receivables: every unpaid invoice, oldest due date first.
CREATE INDEX invoices_book_due_idx ON invoices (book_id, due_date);

CREATE TRIGGER invoices_no_update
BEFORE UPDATE ON invoices
BEGIN
    SELECT RAISE(ABORT, 'issued invoices are immutable; a correction is a credit note, not an edit');
END;

CREATE TRIGGER invoices_no_delete
BEFORE DELETE ON invoices
BEGIN
    SELECT RAISE(ABORT, 'issued invoices are immutable; a correction is a credit note, not an edit');
END;

-- Sync capture: INSERT only. `invoices_no_update`/`_no_delete` above make an
-- UPDATE/DELETE capture trigger unreachable code, exactly like `journals`.
CREATE TRIGGER sync_capture_invoices_ins AFTER INSERT ON invoices
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('invoices', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TABLE invoice_items (
    id               TEXT PRIMARY KEY,
    invoice_id       TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    book_id          TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    variant_id       TEXT REFERENCES product_variants (id) ON DELETE RESTRICT,
    description      TEXT NOT NULL,
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),
    tax_rate_bps     INTEGER NOT NULL DEFAULT 0
        CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
    line_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
);

CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id);
CREATE INDEX invoice_items_book_idx ON invoice_items (book_id);

CREATE TRIGGER invoice_items_no_update
BEFORE UPDATE ON invoice_items
BEGIN
    SELECT RAISE(ABORT, 'issued invoice lines are immutable; a correction is a credit note, not an edit');
END;

CREATE TRIGGER invoice_items_no_delete
BEFORE DELETE ON invoice_items
BEGIN
    SELECT RAISE(ABORT, 'issued invoice lines are immutable; a correction is a credit note, not an edit');
END;

CREATE TRIGGER sync_capture_invoice_items_ins AFTER INSERT ON invoice_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('invoice_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- One immutable fact per payment applied against an invoice. Paid/unpaid/
-- partly-paid is `SUM(amount_minor)` for an invoice compared against its
-- items' total — see `repo::sales::invoice_totals`. Two devices recording
-- different payments against the same invoice while disconnected converge by
-- union, the same way two branches' stock movements do.
CREATE TABLE invoice_payments (
    id           TEXT PRIMARY KEY,
    invoice_id   TEXT NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    book_id      TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    paid_at      TEXT NOT NULL,
    -- Free text ("cash", "eft", "card", a reference number) — SlipScan has no
    -- payment-method taxonomy yet, the same "store verbatim" treatment
    -- `stock_movements.note` gets.
    method       TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX invoice_payments_invoice_idx ON invoice_payments (invoice_id);
CREATE INDEX invoice_payments_book_idx ON invoice_payments (book_id);

CREATE TRIGGER invoice_payments_no_update
BEFORE UPDATE ON invoice_payments
BEGIN
    SELECT RAISE(ABORT, 'recorded payments are immutable; record a refund or correction as a new fact');
END;

CREATE TRIGGER invoice_payments_no_delete
BEFORE DELETE ON invoice_payments
BEGIN
    SELECT RAISE(ABORT, 'recorded payments are immutable; record a refund or correction as a new fact');
END;

CREATE TRIGGER sync_capture_invoice_payments_ins AFTER INSERT ON invoice_payments
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('invoice_payments', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- -----------------------------------------------------------------------------
-- Sync capture for the two LWW tables. See migration 0008's header for why
-- this is a trigger and not a call from the repo layer.
-- `crates/slipscan-sync/src/lib.rs`'s `LWW_TABLES` gains `sales_orders` and
-- `sales_order_items` in the same change as this migration, and
-- `crate::sync::capture::tests` assert the two agree in both directions.
-- -----------------------------------------------------------------------------

CREATE TRIGGER sync_capture_sales_orders_ins AFTER INSERT ON sales_orders
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('sales_orders', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_sales_orders_upd AFTER UPDATE ON sales_orders
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('sales_orders', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_sales_orders_del AFTER DELETE ON sales_orders
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('sales_orders', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_sales_order_items_ins AFTER INSERT ON sales_order_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('sales_order_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_sales_order_items_upd AFTER UPDATE ON sales_order_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('sales_order_items', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_sales_order_items_del AFTER DELETE ON sales_order_items
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('sales_order_items', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No backfill needed: none of this migration's tables existed before it, so
-- there are no pre-existing rows for any outbox to catch up on.
