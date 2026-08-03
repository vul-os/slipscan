-- =============================================================================
-- Migration 0011: product catalogue (Phase 6.3a, ROADMAP.md "Inventory &
-- trade").
--
-- Three tables, all additive: a book with none of them behaves exactly as
-- before.
--
--   product_categories  a grouping for products, per book.
--   products             a sellable/stockable thing: name, description,
--                        optional category.
--   product_variants     the unit that actually has a SKU, a price and a
--                        stock level: belongs to a product, carries pricing,
--                        cost, reorder point and free-form attributes.
--
-- **Naming, deliberately not "categories".** This schema already has a
-- `categories` table (migration 0001) for classifying *transactions* —
-- income/expense/transfer, hierarchical, feeding budgets and reports. A
-- product category is a different concept living in a different part of the
-- domain: it groups catalogue items, not money movements, and has no kind,
-- no hierarchy and nothing to do with the chart of accounts. Calling it
-- `product_categories` (table) and `product_category_id` (the FK column on
-- `products`) means a query or a migration that mixes the two is wrong at a
-- glance — `products.category_id = categories.id` would type-check and
-- return nonsense, `products.product_category_id = categories.id` would not
-- even parse against the intended join.
--
-- **What is deliberately not here.** No stock-on-hand column anywhere in
-- this file. FlowStock's own mistake (and the reason ROADMAP.md 6.3 insists
-- on it) was letting a stored counter and reality drift apart across
-- disconnected branches; on-hand is always `SUM(qty_delta)` over an
-- append-only stock-movement ledger, which is a later stage and depends on
-- the `locations` table (6.1, landing separately). A variant here has no
-- location and no quantity — just the catalogue facts that do not change
-- when stock moves. There is also no `is_archived`/soft-delete flag: this
-- stage does not yet have a caller that needs one (nothing references a
-- variant yet), and adding it speculatively would be a column nobody
-- exercises. A later stage that needs to retire a variant without breaking
-- historical references can add it then.
--
-- **Money.** Matches migration 0001's convention exactly: `_minor` INTEGER
-- + a paired ISO-4217 `currency` TEXT column, the same shape as
-- `accounts.opening_balance_minor`/`currency` and
-- `budgets.amount_minor`/`currency`. `price_minor` and `cost_price_minor`
-- share one `currency` column (both prices for the same variant are quoted
-- in the same currency), the same way `journal_lines.debit_minor` and
-- `credit_minor` share one `currency`.
--
-- `product_variants.book_id` is denormalized off `products.book_id` rather
-- than reached through a join, the same choice migration 0006 made for
-- `transaction_splits.book_id`: it is what per-book SKU uniqueness needs to
-- enforce directly, and it is what the sync capture trigger below needs for
-- its `ns`.
-- =============================================================================

CREATE TABLE product_categories (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (book_id, name)
);

CREATE INDEX product_categories_book_idx ON product_categories (book_id);

CREATE TABLE products (
    id                  TEXT PRIMARY KEY,
    book_id             TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    product_category_id TEXT REFERENCES product_categories (id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX products_book_idx ON products (book_id);
CREATE INDEX products_category_idx ON products (product_category_id);

CREATE TABLE product_variants (
    id               TEXT PRIMARY KEY,
    product_id       TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
    -- Denormalized from products.book_id — see the header note.
    book_id          TEXT NOT NULL REFERENCES books (id) ON DELETE CASCADE,
    sku              TEXT NOT NULL,
    name             TEXT NOT NULL,
    price_minor      INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
    cost_price_minor INTEGER NOT NULL DEFAULT 0 CHECK (cost_price_minor >= 0),
    currency         TEXT NOT NULL CHECK (length(currency) = 3),
    reorder_point    INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
    -- Free-form JSON object ("size", "colour", …), never interpreted by
    -- this crate — the same "store verbatim, never parse" treatment
    -- migration 0001 gives document_extractions.payload. NULL = no
    -- attributes recorded, distinct from an empty object.
    attributes       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (book_id, sku)
);

CREATE INDEX product_variants_product_idx ON product_variants (product_id);
CREATE INDEX product_variants_book_idx ON product_variants (book_id);

-- =============================================================================
-- Sync capture. See migration 0008's header for why this is a trigger and
-- not a call from the repo layer.
--
-- All three tables are ordinary editable rows (a name gets renamed, a price
-- gets corrected) — the §4.4 LWW register mapping, the same family as
-- `accounts`/`categories`/`members`. None of them is a ledger fact, so none
-- belongs in `LEDGER_TABLES`. `crates/slipscan-sync/src/lib.rs`'s
-- `LWW_TABLES` list is updated in the same change as this migration, and
-- `slipscan-core`'s `sync::capture::tests` assert the two agree in both
-- directions — a table with triggers here but no entry there (or the
-- reverse) fails that suite.
-- =============================================================================

-- product_categories -----------------------------------------------------
CREATE TRIGGER sync_capture_product_categories_ins AFTER INSERT ON product_categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_product_categories_upd AFTER UPDATE ON product_categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_categories', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_product_categories_del AFTER DELETE ON product_categories
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_categories', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- products -----------------------------------------------------------------
CREATE TRIGGER sync_capture_products_ins AFTER INSERT ON products
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('products', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_products_upd AFTER UPDATE ON products
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('products', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_products_del AFTER DELETE ON products
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('products', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- product_variants -----------------------------------------------------------
CREATE TRIGGER sync_capture_product_variants_ins AFTER INSERT ON product_variants
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_variants', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_product_variants_upd AFTER UPDATE ON product_variants
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_variants', NEW.id, NEW.book_id, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER sync_capture_product_variants_del AFTER DELETE ON product_variants
WHEN (SELECT applying FROM sync_control WHERE id = 1) = 0
BEGIN
    INSERT INTO sync_outbox (table_name, row_id, ns, deleted, captured_at)
    VALUES ('product_variants', OLD.id, OLD.book_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
