-- =============================================================================
-- Migration 0810: contacts (Xero axis — PARITY.md "Contacts (customers &
-- suppliers)", scored Not built).
--
-- FlowStock (the retired inventory product this table is re-derived from, not
-- ported from) kept two near-identical tables, `customers` and `suppliers`,
-- differing only in a handful of columns. That shape is a trap for a real
-- business: a supplier you also sell surplus stock to, a customer who becomes
-- a wholesale supplier, a landlord who is both — a genuine party doing both
-- sides of trade with the same book. Two tables force that party to be
-- created twice, under two ids, with two copies of its name, tax number and
-- address that drift the moment either one is edited and nobody remembers to
-- edit the other. This is exactly the kind of duplication SlipScan's ledger
-- already refuses elsewhere (one `accounts` table, not `bank_accounts` +
-- `card_accounts`).
--
-- So: one `contacts` table per book, with a `role` column instead of a table
-- choice. `customer`, `supplier`, or `both` — set once, changeable in place
-- when a relationship changes shape, and never duplicated. Aged
-- receivables/payables (PARITY.md's next gap) reads off this `role` rather
-- than off which table a row happens to live in.
--
-- Columns carried over from FlowStock's pair: name, company name, email,
-- phone, billing/shipping address, tax number, payment terms (net days),
-- credit limit, notes, active flag. `credit_limit_minor` is expressed in the
-- book's own `books.currency` — SlipScan has no per-contact currency concept
-- yet, the same limitation `budgets.currency` already documents implicitly by
-- existing at all only alongside a book-scoped amount.
--
-- What this migration does NOT build: invoices, bills, or any posting from a
-- contact into the ledger. A contact is a record to hang a future bill or
-- invoice on (PARITY.md line ~131: "Contacts, then bills, then aged AR/AP —
-- a chain"); this migration is only the first link.
-- =============================================================================

CREATE TABLE contacts (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    -- 'both' is not a shorthand for "unsure" — it is the genuinely common case
    -- this table exists to stop forcing into two rows.
    role                TEXT NOT NULL CHECK (role IN ('customer', 'supplier', 'both')),
    name                TEXT NOT NULL,
    company_name        TEXT,
    email               TEXT,
    phone               TEXT,
    billing_address     TEXT,
    shipping_address    TEXT,
    tax_number          TEXT,
    -- Net payment terms in days (e.g. 30 for "Net 30"). NULL = no term on
    -- record, not "due immediately" — that distinction matters once aging
    -- reports read this column.
    payment_terms_days  INTEGER CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
    -- In the book's base currency (`books.currency`); see the header note.
    credit_limit_minor  INTEGER CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
    notes               TEXT,
    is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX contacts_book_idx ON contacts (book_id);
-- Backs the customer/supplier split views aged AR/AP will need — a role
-- lookup is "role matches, or role is 'both'", never an exact-match-only scan.
CREATE INDEX contacts_book_role_idx ON contacts (book_id, role);

-- -----------------------------------------------------------------------------
-- Sync capture (docs/NODES.md phase 2 — see migration 0700_oplog's header for
-- why this is a trigger rather than a call from the repo layer: a trigger
-- catches every write path, a call site only catches the ones somebody
-- remembered to instrument). `crate::sync::capture::tests` asserts this
-- trigger set matches `slipscan_sync::LWW_TABLES` in both directions, so
-- `contacts` is also added there — an editable, book-scoped, LWW table, the
-- same mapping as `members` and `budgets`.
-- -----------------------------------------------------------------------------

CREATE TRIGGER sync_capture_contacts_ins AFTER INSERT ON contacts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('contacts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_contacts_upd AFTER UPDATE ON contacts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('contacts', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_contacts_del AFTER DELETE ON contacts
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('contacts', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- No backfill needed: `contacts` did not exist before this migration, so
-- there are no pre-existing rows for the outbox to catch up on (contrast
-- migration 0700_oplog, which backfilled tables that already held data).
