-- =============================================================================
-- Migration 3/4: Accounting and bookkeeping
--
-- The financial domain. Same tables serve both personal (Vault22-style)
-- and business (Xero-style) orgs; features layer on top by org kind.
--
--   * tax_rates, accounts (chart of accounts), categories (Vault22-style
--     spending breakdown), tags, contacts (customers/suppliers)
--   * classification_rules (defined before transactions so the rule_id FK
--     on transaction_classifications can be inline)
--   * transfers (defined before transactions so transactions.transfer_id
--     can be inline)
--   * transactions plus model-versioned transaction_classifications
--     (transactions.current_classification_id is denormalized — no FK,
--     since the reverse FK on transaction_classifications.transaction_id
--     enforces existence)
--   * transaction_splits, transaction_tags
--   * recurring_transactions (subscription / standing-order detection)
--   * manual_journals + ledger_entries (double-entry projection)
--   * bank_statements + statement_lines (with reconcile state)
--   * sales_invoices + lines, bills + lines (Xero-style AR / AP)
--   * purchase_orders + lines (PO → bill flow)
--   * credit_notes + lines (sales/purchase credits, refunds)
--   * expense_claims + lines (employee reimbursement workflow)
--   * fixed_assets + depreciation_schedule (capex register)
--   * assets, asset_valuations, liabilities, liability_balances, holdings
--     (22Seven-style net-worth + investment tracking)
--   * bank_feed_connections (Plaid / Yodlee / Truelayer / Salt Edge / manual)
--   * budgets + budget_lines, goals
--   * classification_corrections, merchant_signals
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE transaction_status        AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE transaction_direction     AS ENUM ('debit', 'credit', 'transfer');

CREATE TYPE account_type              AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
CREATE TYPE category_kind             AS ENUM ('income', 'expense', 'transfer');

CREATE TYPE classification_match_type AS ENUM ('merchant_exact', 'merchant_contains', 'merchant_regex');
CREATE TYPE classification_source     AS ENUM ('user', 'rule', 'llm', 'merchant_signal', 'system');

CREATE TYPE ledger_source_type        AS ENUM ('transaction', 'manual_journal', 'opening_balance', 'invoice', 'bill', 'transfer');

CREATE TYPE invoice_status            AS ENUM ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided');
CREATE TYPE bill_status               AS ENUM ('draft', 'awaiting_payment', 'partially_paid', 'paid', 'overdue', 'voided');
CREATE TYPE contact_kind              AS ENUM ('customer', 'supplier', 'both');

CREATE TYPE budget_period             AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');
CREATE TYPE goal_kind                 AS ENUM ('savings', 'debt_payoff', 'spending');
CREATE TYPE goal_status               AS ENUM ('active', 'achieved', 'abandoned');

CREATE TYPE recurring_frequency       AS ENUM ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly');
CREATE TYPE recurring_status          AS ENUM ('active', 'paused', 'cancelled');

-- Net worth (personal — Vault22 / 22Seven parity)
CREATE TYPE asset_kind                AS ENUM ('property', 'vehicle', 'cash', 'investment', 'retirement', 'business', 'collectible', 'other');
CREATE TYPE liability_kind            AS ENUM ('mortgage', 'student_loan', 'credit_card', 'personal_loan', 'auto_loan', 'business_loan', 'other');
CREATE TYPE holding_kind              AS ENUM ('equity', 'etf', 'mutual_fund', 'bond', 'crypto', 'commodity', 'cash', 'other');

-- Xero gaps (business)
CREATE TYPE expense_claim_status      AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'paid', 'voided');
CREATE TYPE purchase_order_status     AS ENUM ('draft', 'submitted', 'approved', 'partially_billed', 'billed', 'cancelled');
CREATE TYPE credit_note_kind          AS ENUM ('sales', 'purchase');
CREATE TYPE credit_note_status        AS ENUM ('draft', 'authorised', 'applied', 'voided');
CREATE TYPE fixed_asset_status        AS ENUM ('draft', 'registered', 'disposed');
CREATE TYPE depreciation_method       AS ENUM ('straight_line', 'declining_balance', 'none');

-- Bank feeds
CREATE TYPE bank_feed_provider        AS ENUM ('plaid', 'yodlee', 'truelayer', 'salt_edge', 'manual');
CREATE TYPE bank_feed_status          AS ENUM ('pending', 'connected', 'reauth_required', 'error', 'disconnected');

-- -----------------------------------------------------------------------------
-- Tax rates and chart of accounts
-- -----------------------------------------------------------------------------

CREATE TABLE tax_rates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    code            TEXT NOT NULL,
    name            TEXT NOT NULL,
    rate            NUMERIC(7, 4) NOT NULL,
    country         CHAR(2),
    region          TEXT,
    is_compound     BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT tax_rates_country_iso CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
    CONSTRAINT tax_rates_rate_range  CHECK (rate >= 0 AND rate <= 100),
    UNIQUE (organization_id, code)
);

CREATE INDEX tax_rates_org_active_idx ON tax_rates (organization_id) WHERE is_active;

CREATE TRIGGER tax_rates_set_updated_at
BEFORE UPDATE ON tax_rates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES accounts(id) ON DELETE RESTRICT,
    code            TEXT,
    name            TEXT NOT NULL,
    type            account_type NOT NULL,
    subtype         TEXT,
    currency        CHAR(3) NOT NULL,
    tax_rate_id     UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description     TEXT,
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT accounts_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    UNIQUE (organization_id, code)
);

CREATE INDEX accounts_org_type_idx ON accounts (organization_id, type);
CREATE INDEX accounts_parent_idx   ON accounts (parent_id);

CREATE TRIGGER accounts_set_updated_at
BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_id       UUID REFERENCES categories(id) ON DELETE RESTRICT,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    kind            category_kind NOT NULL,
    icon            TEXT,
    color           TEXT,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, parent_id, name)
);

CREATE INDEX categories_org_kind_idx ON categories (organization_id, kind);
CREATE INDEX categories_parent_idx   ON categories (parent_id);

CREATE TRIGGER categories_set_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);

CREATE TRIGGER tags_set_updated_at
BEFORE UPDATE ON tags
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contacts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind                 contact_kind NOT NULL DEFAULT 'customer',
    name                 TEXT NOT NULL,
    legal_name           TEXT,
    email                CITEXT,
    phone                TEXT,
    tax_number           TEXT,
    payment_terms_days   INTEGER NOT NULL DEFAULT 30,
    default_account_id   UUID REFERENCES accounts(id) ON DELETE SET NULL,
    default_tax_rate_id  UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    currency             CHAR(3),
    address_line1        TEXT,
    address_line2        TEXT,
    city                 TEXT,
    region               TEXT,
    postal_code          TEXT,
    country              CHAR(2),
    notes                TEXT,
    is_archived          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT contacts_currency_iso CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    CONSTRAINT contacts_country_iso  CHECK (country  IS NULL OR country  ~ '^[A-Z]{2}$'),
    CONSTRAINT contacts_payment_terms_nonneg CHECK (payment_terms_days >= 0)
);

CREATE INDEX contacts_org_kind_idx ON contacts (organization_id, kind);
CREATE INDEX contacts_org_name_idx ON contacts (organization_id, name);
CREATE INDEX contacts_email_idx    ON contacts (email);

CREATE TRIGGER contacts_set_updated_at
BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Classification rules (defined before transactions so transaction_classifications
-- can FK to it inline).
-- -----------------------------------------------------------------------------

CREATE TABLE classification_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    match_type      classification_match_type NOT NULL,
    match_value     TEXT NOT NULL,
    category_id     UUID REFERENCES categories(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    source          classification_source NOT NULL DEFAULT 'user',
    confidence      NUMERIC(4, 3) NOT NULL DEFAULT 1.0,
    applied_count   INTEGER NOT NULL DEFAULT 0,
    last_applied_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT classification_rules_confidence_range
        CHECK (confidence >= 0 AND confidence <= 1),
    UNIQUE (organization_id, match_type, match_value)
);

CREATE INDEX classification_rules_org_match_idx
    ON classification_rules (organization_id, match_type, match_value);
CREATE INDEX classification_rules_category_idx
    ON classification_rules (category_id);

CREATE TRIGGER classification_rules_set_updated_at
BEFORE UPDATE ON classification_rules
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Transfers (defined before transactions so transactions.transfer_id can be inline)
-- -----------------------------------------------------------------------------

CREATE TABLE transfers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    from_account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    to_account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    posted_date         DATE NOT NULL,
    amount              NUMERIC(14, 2) NOT NULL,
    currency            CHAR(3) NOT NULL,
    description         TEXT,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT transfers_currency_iso  CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT transfers_distinct      CHECK (from_account_id <> to_account_id),
    CONSTRAINT transfers_amount_pos    CHECK (amount > 0)
);

CREATE INDEX transfers_org_date_idx ON transfers (organization_id, posted_date DESC);

CREATE TRIGGER transfers_set_updated_at
BEFORE UPDATE ON transfers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Transactions
--
-- One row per real-world transaction. `current_classification_id` is a
-- denormalized UUID (no FK — the reverse FK on
-- `transaction_classifications.transaction_id` enforces row existence;
-- the app maintains the pointer).
-- -----------------------------------------------------------------------------

CREATE TABLE transactions (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    document_id                   UUID REFERENCES documents(id) ON DELETE SET NULL,
    document_extraction_id        UUID REFERENCES document_extractions(id) ON DELETE SET NULL,
    account_id                    UUID REFERENCES accounts(id) ON DELETE RESTRICT,
    category_id                   UUID REFERENCES categories(id) ON DELETE SET NULL,
    contact_id                    UUID REFERENCES contacts(id) ON DELETE SET NULL,
    tax_rate_id                   UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    transfer_id                   UUID REFERENCES transfers(id) ON DELETE SET NULL,
    uploaded_by                   UUID REFERENCES users(id) ON DELETE SET NULL,
    posted_date                   DATE,
    direction                     transaction_direction NOT NULL DEFAULT 'debit',
    merchant                      TEXT,
    merchant_normalized           TEXT,
    description                   TEXT,
    amount                        NUMERIC(14, 2),
    currency                      CHAR(3),
    fx_rate                       NUMERIC(20, 10),
    base_amount                   NUMERIC(14, 2),
    base_currency                 CHAR(3),
    tax                           NUMERIC(14, 2),
    payment_method                TEXT,
    notes                         TEXT,
    status                        transaction_status NOT NULL DEFAULT 'pending',
    current_classification_id     UUID,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT transactions_currency_iso
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    CONSTRAINT transactions_base_currency_iso
        CHECK (base_currency IS NULL OR base_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT transactions_tax_nonneg
        CHECK (tax IS NULL OR tax >= 0)
);

CREATE INDEX transactions_org_date_idx
    ON transactions (organization_id, posted_date DESC NULLS LAST);
CREATE INDEX transactions_org_status_idx
    ON transactions (organization_id, status);
CREATE INDEX transactions_org_category_idx
    ON transactions (organization_id, category_id);
CREATE INDEX transactions_org_account_idx
    ON transactions (organization_id, account_id);
CREATE INDEX transactions_org_contact_idx
    ON transactions (organization_id, contact_id);
CREATE INDEX transactions_document_idx
    ON transactions (document_id);
CREATE INDEX transactions_transfer_idx
    ON transactions (transfer_id);
CREATE INDEX transactions_merchant_trgm_idx
    ON transactions USING gin (merchant_normalized gin_trgm_ops);

CREATE TRIGGER transactions_set_updated_at
BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Transaction classifications (model-versioned). `is_current` plus
-- `transactions.current_classification_id` mark the canonical assignment.
CREATE TABLE transaction_classifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id      UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    ai_run_id           UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    model_id            UUID REFERENCES ai_models(id) ON DELETE SET NULL,
    rule_id             UUID REFERENCES classification_rules(id) ON DELETE SET NULL,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    account_id          UUID REFERENCES accounts(id) ON DELETE SET NULL,
    source              classification_source NOT NULL,
    confidence          NUMERIC(4, 3),
    reasoning           TEXT,
    suggested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    is_current          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT transaction_classifications_confidence_range
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX transaction_classifications_tx_idx
    ON transaction_classifications (transaction_id, created_at DESC);
CREATE INDEX transaction_classifications_org_idx
    ON transaction_classifications (organization_id, created_at DESC);
CREATE INDEX transaction_classifications_model_idx
    ON transaction_classifications (model_id);
CREATE UNIQUE INDEX transaction_classifications_current_unique
    ON transaction_classifications (transaction_id) WHERE is_current;

-- Splits: one transaction allocated across multiple categories.
CREATE TABLE transaction_splits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    tax_rate_id     UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description     TEXT,
    amount          NUMERIC(14, 2) NOT NULL,
    line_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX transaction_splits_tx_idx ON transaction_splits (transaction_id);
CREATE INDEX transaction_splits_org_idx ON transaction_splits (organization_id);

CREATE TRIGGER transaction_splits_set_updated_at
BEFORE UPDATE ON transaction_splits
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE transaction_tags (
    transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (transaction_id, tag_id)
);

CREATE INDEX transaction_tags_tag_idx ON transaction_tags (tag_id);
CREATE INDEX transaction_tags_org_idx ON transaction_tags (organization_id);

-- -----------------------------------------------------------------------------
-- Recurring transactions (subscription / standing-order detection)
-- -----------------------------------------------------------------------------

CREATE TABLE recurring_transactions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    merchant_normalized  TEXT NOT NULL,
    category_id          UUID REFERENCES categories(id) ON DELETE SET NULL,
    account_id           UUID REFERENCES accounts(id) ON DELETE SET NULL,
    expected_amount      NUMERIC(14, 2),
    amount_variance      NUMERIC(14, 2),
    currency             CHAR(3),
    frequency            recurring_frequency NOT NULL,
    next_expected_date   DATE,
    last_seen_at         TIMESTAMPTZ,
    occurrence_count     INTEGER NOT NULL DEFAULT 0,
    status               recurring_status NOT NULL DEFAULT 'active',
    detected_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT recurring_transactions_currency_iso
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX recurring_transactions_org_idx
    ON recurring_transactions (organization_id, status);
CREATE INDEX recurring_transactions_next_idx
    ON recurring_transactions (organization_id, next_expected_date)
    WHERE status = 'active';

CREATE TRIGGER recurring_transactions_set_updated_at
BEFORE UPDATE ON recurring_transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Manual journals and ledger entries
-- -----------------------------------------------------------------------------

CREATE TABLE manual_journals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    posted_date     DATE NOT NULL,
    narrative       TEXT,
    reference       TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX manual_journals_org_date_idx
    ON manual_journals (organization_id, posted_date DESC);

CREATE TRIGGER manual_journals_set_updated_at
BEFORE UPDATE ON manual_journals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ledger_entries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    source_type     ledger_source_type NOT NULL,
    source_id       UUID NOT NULL,
    posted_date     DATE NOT NULL,
    debit           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    credit          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    currency        CHAR(3) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ledger_entries_currency_iso
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT ledger_entries_one_side
        CHECK ((debit = 0 AND credit > 0) OR (credit = 0 AND debit > 0)),
    CONSTRAINT ledger_entries_nonneg
        CHECK (debit >= 0 AND credit >= 0)
);

CREATE INDEX ledger_entries_org_account_date_idx
    ON ledger_entries (organization_id, account_id, posted_date);
CREATE INDEX ledger_entries_source_idx
    ON ledger_entries (source_type, source_id);
CREATE INDEX ledger_entries_org_date_idx
    ON ledger_entries (organization_id, posted_date);

-- -----------------------------------------------------------------------------
-- Bank statements
-- -----------------------------------------------------------------------------

CREATE TABLE bank_statements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    document_id     UUID REFERENCES documents(id) ON DELETE SET NULL,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    period_start    DATE,
    period_end      DATE,
    opening_balance NUMERIC(14, 2),
    closing_balance NUMERIC(14, 2),
    currency        CHAR(3),
    status          document_status NOT NULL DEFAULT 'pending',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bank_statements_currency_iso
        CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX bank_statements_org_period_idx
    ON bank_statements (organization_id, period_end DESC NULLS LAST);

CREATE TRIGGER bank_statements_set_updated_at
BEFORE UPDATE ON bank_statements
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE statement_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement_id    UUID NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
    line_date       DATE,
    description     TEXT,
    amount          NUMERIC(14, 2),
    balance         NUMERIC(14, 2),
    raw             JSONB,
    is_reconciled   BOOLEAN NOT NULL DEFAULT FALSE,
    reconciled_at   TIMESTAMPTZ,
    reconciled_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX statement_lines_statement_idx ON statement_lines (statement_id);
CREATE INDEX statement_lines_org_date_idx  ON statement_lines (organization_id, line_date);
CREATE INDEX statement_lines_unmatched_idx
    ON statement_lines (organization_id)
    WHERE transaction_id IS NULL;
CREATE INDEX statement_lines_unreconciled_idx
    ON statement_lines (organization_id)
    WHERE NOT is_reconciled;

CREATE TRIGGER statement_lines_set_updated_at
BEFORE UPDATE ON statement_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Sales invoices and bills (Xero-style AR / AP)
-- -----------------------------------------------------------------------------

CREATE TABLE sales_invoices (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id           UUID REFERENCES contacts(id) ON DELETE RESTRICT,
    invoice_number       TEXT,
    reference            TEXT,
    status               invoice_status NOT NULL DEFAULT 'draft',
    issue_date           DATE,
    due_date             DATE,
    currency             CHAR(3) NOT NULL,
    fx_rate              NUMERIC(20, 10),
    subtotal             NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_total            NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total                NUMERIC(14, 2) NOT NULL DEFAULT 0,
    amount_paid          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    notes                TEXT,
    sent_at              TIMESTAMPTZ,
    paid_at              TIMESTAMPTZ,
    voided_at            TIMESTAMPTZ,
    hosted_url           TEXT,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sales_invoices_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    UNIQUE (organization_id, invoice_number)
);

CREATE INDEX sales_invoices_org_status_idx ON sales_invoices (organization_id, status);
CREATE INDEX sales_invoices_org_due_idx    ON sales_invoices (organization_id, due_date);
CREATE INDEX sales_invoices_contact_idx    ON sales_invoices (contact_id);

CREATE TRIGGER sales_invoices_set_updated_at
BEFORE UPDATE ON sales_invoices
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sales_invoice_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id          UUID NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id          UUID REFERENCES accounts(id) ON DELETE SET NULL,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    tax_rate_id         UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description         TEXT,
    quantity            NUMERIC(14, 4) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(14, 4) NOT NULL DEFAULT 0,
    amount              NUMERIC(14, 2) NOT NULL DEFAULT 0,
    line_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sales_invoice_lines_invoice_idx ON sales_invoice_lines (invoice_id);
CREATE INDEX sales_invoice_lines_org_idx     ON sales_invoice_lines (organization_id);

CREATE TRIGGER sales_invoice_lines_set_updated_at
BEFORE UPDATE ON sales_invoice_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bills (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id           UUID REFERENCES contacts(id) ON DELETE RESTRICT,
    document_id          UUID REFERENCES documents(id) ON DELETE SET NULL,
    bill_number          TEXT,
    reference             TEXT,
    status               bill_status NOT NULL DEFAULT 'draft',
    issue_date           DATE,
    due_date             DATE,
    currency             CHAR(3) NOT NULL,
    fx_rate              NUMERIC(20, 10),
    subtotal             NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_total            NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total                NUMERIC(14, 2) NOT NULL DEFAULT 0,
    amount_paid          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    notes                TEXT,
    paid_at              TIMESTAMPTZ,
    voided_at            TIMESTAMPTZ,
    created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bills_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX bills_org_status_idx ON bills (organization_id, status);
CREATE INDEX bills_org_due_idx    ON bills (organization_id, due_date);
CREATE INDEX bills_contact_idx    ON bills (contact_id);

CREATE TRIGGER bills_set_updated_at
BEFORE UPDATE ON bills
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bill_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id             UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id          UUID REFERENCES accounts(id) ON DELETE SET NULL,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    tax_rate_id         UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description         TEXT,
    quantity            NUMERIC(14, 4) NOT NULL DEFAULT 1,
    unit_price          NUMERIC(14, 4) NOT NULL DEFAULT 0,
    amount              NUMERIC(14, 2) NOT NULL DEFAULT 0,
    line_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX bill_lines_bill_idx ON bill_lines (bill_id);
CREATE INDEX bill_lines_org_idx  ON bill_lines (organization_id);

CREATE TRIGGER bill_lines_set_updated_at
BEFORE UPDATE ON bill_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Budgets and goals (Vault22-style)
-- -----------------------------------------------------------------------------

CREATE TABLE budgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    period          budget_period NOT NULL,
    start_date      DATE NOT NULL,
    end_date        DATE,
    currency        CHAR(3) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT budgets_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX budgets_org_active_idx ON budgets (organization_id) WHERE is_active;

CREATE TRIGGER budgets_set_updated_at
BEFORE UPDATE ON budgets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE budget_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    budget_id       UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES categories(id) ON DELETE CASCADE,
    amount          NUMERIC(14, 2) NOT NULL,
    rollover        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (budget_id, category_id)
);

CREATE INDEX budget_lines_org_idx ON budget_lines (organization_id);

CREATE TRIGGER budget_lines_set_updated_at
BEFORE UPDATE ON budget_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE goals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    kind            goal_kind NOT NULL,
    target_amount   NUMERIC(14, 2) NOT NULL,
    current_amount  NUMERIC(14, 2) NOT NULL DEFAULT 0,
    target_date     DATE,
    currency        CHAR(3) NOT NULL,
    status          goal_status NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT goals_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX goals_org_status_idx ON goals (organization_id, status);

CREATE TRIGGER goals_set_updated_at
BEFORE UPDATE ON goals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Classification corrections and global merchant signals
-- -----------------------------------------------------------------------------

CREATE TABLE classification_corrections (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    transaction_id       UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    merchant_normalized  TEXT,
    old_category_id      UUID REFERENCES categories(id) ON DELETE SET NULL,
    new_category_id      UUID REFERENCES categories(id) ON DELETE SET NULL,
    old_source           classification_source,
    old_classification_id UUID REFERENCES transaction_classifications(id) ON DELETE SET NULL,
    new_classification_id UUID REFERENCES transaction_classifications(id) ON DELETE SET NULL,
    corrected_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX classification_corrections_org_idx
    ON classification_corrections (organization_id, created_at DESC);
CREATE INDEX classification_corrections_merchant_idx
    ON classification_corrections (merchant_normalized);

-- Cross-tenant aggregated signal. No org/user references.
CREATE TABLE merchant_signals (
    merchant_normalized  TEXT NOT NULL,
    category_label       TEXT NOT NULL,
    vote_count           INTEGER NOT NULL DEFAULT 0,
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (merchant_normalized, category_label)
);

CREATE INDEX merchant_signals_merchant_idx
    ON merchant_signals (merchant_normalized, vote_count DESC);

CREATE TRIGGER merchant_signals_set_updated_at
BEFORE UPDATE ON merchant_signals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Net worth: assets, asset_valuations, liabilities, liability_balances, holdings
--
-- These are the 22Seven / Vault22-style parity additions. `assets` and
-- `liabilities` are the user-facing rows (one per house, mortgage, retirement
-- account, etc.); the *_valuations / *_balances tables hold the time series so
-- the net-worth chart can be drawn without overwriting the headline value on
-- every refresh.
-- -----------------------------------------------------------------------------

CREATE TABLE assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    kind            asset_kind NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    currency        CHAR(3) NOT NULL DEFAULT 'ZAR',
    current_value   NUMERIC(14, 2),
    purchased_at    DATE,
    purchase_value  NUMERIC(14, 2),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT assets_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX assets_org_kind_idx ON assets (organization_id, kind);

CREATE TRIGGER assets_set_updated_at
BEFORE UPDATE ON assets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE asset_valuations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id        UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    as_of           DATE NOT NULL,
    value           NUMERIC(14, 2) NOT NULL,
    currency        CHAR(3) NOT NULL,
    source          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (asset_id, as_of),
    CONSTRAINT asset_valuations_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX asset_valuations_org_idx ON asset_valuations (organization_id, as_of DESC);

CREATE TABLE liabilities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id          UUID REFERENCES accounts(id) ON DELETE SET NULL,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    kind                liability_kind NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    currency            CHAR(3) NOT NULL DEFAULT 'ZAR',
    original_principal  NUMERIC(14, 2),
    current_balance     NUMERIC(14, 2),
    interest_rate       NUMERIC(7, 4),
    minimum_payment     NUMERIC(14, 2),
    payment_frequency   recurring_frequency,
    started_at          DATE,
    matures_at          DATE,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_archived         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT liabilities_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX liabilities_org_kind_idx ON liabilities (organization_id, kind);

CREATE TRIGGER liabilities_set_updated_at
BEFORE UPDATE ON liabilities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE liability_balances (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    liability_id    UUID NOT NULL REFERENCES liabilities(id) ON DELETE CASCADE,
    as_of           DATE NOT NULL,
    balance         NUMERIC(14, 2) NOT NULL,
    currency        CHAR(3) NOT NULL,
    interest_paid   NUMERIC(14, 2),
    principal_paid  NUMERIC(14, 2),
    source          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (liability_id, as_of),
    CONSTRAINT liability_balances_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX liability_balances_org_idx ON liability_balances (organization_id, as_of DESC);

CREATE TABLE holdings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    asset_id        UUID REFERENCES assets(id) ON DELETE SET NULL,
    kind            holding_kind NOT NULL,
    symbol          TEXT,
    isin            TEXT,
    name            TEXT NOT NULL,
    quantity        NUMERIC(20, 8) NOT NULL,
    cost_basis      NUMERIC(14, 2),
    cost_currency   CHAR(3),
    current_price   NUMERIC(20, 8),
    price_currency  CHAR(3),
    last_priced_at  TIMESTAMPTZ,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_archived     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT holdings_cost_currency_iso  CHECK (cost_currency  IS NULL OR cost_currency  ~ '^[A-Z]{3}$'),
    CONSTRAINT holdings_price_currency_iso CHECK (price_currency IS NULL OR price_currency ~ '^[A-Z]{3}$')
);
CREATE INDEX holdings_org_kind_idx ON holdings (organization_id, kind);
CREATE INDEX holdings_symbol_idx   ON holdings (symbol);

CREATE TRIGGER holdings_set_updated_at
BEFORE UPDATE ON holdings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Expense claims (employee reimbursement)
--
-- Each line links to the underlying transaction (the receipt) so the OCR'd
-- amount + tax flow through without re-typing.
-- -----------------------------------------------------------------------------

CREATE TABLE expense_claims (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    submitted_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    paid_by_account_id  UUID REFERENCES accounts(id) ON DELETE SET NULL,
    reference           TEXT,
    title               TEXT NOT NULL,
    status              expense_claim_status NOT NULL DEFAULT 'draft',
    currency            CHAR(3) NOT NULL,
    fx_rate             NUMERIC(20, 10),
    subtotal            NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_total           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total               NUMERIC(14, 2) NOT NULL DEFAULT 0,
    submitted_at        TIMESTAMPTZ,
    approved_at         TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT expense_claims_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX expense_claims_org_status_idx   ON expense_claims (organization_id, status);
CREATE INDEX expense_claims_submitted_by_idx ON expense_claims (submitted_by);

CREATE TRIGGER expense_claims_set_updated_at
BEFORE UPDATE ON expense_claims
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE expense_claim_lines (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_claim_id    UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    transaction_id      UUID REFERENCES transactions(id) ON DELETE SET NULL,
    document_id         UUID REFERENCES documents(id) ON DELETE SET NULL,
    account_id          UUID REFERENCES accounts(id) ON DELETE SET NULL,
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    tax_rate_id         UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description         TEXT,
    amount              NUMERIC(14, 2) NOT NULL,
    tax                 NUMERIC(14, 2) NOT NULL DEFAULT 0,
    line_order          INT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX expense_claim_lines_claim_idx ON expense_claim_lines (expense_claim_id, line_order);

CREATE TRIGGER expense_claim_lines_set_updated_at
BEFORE UPDATE ON expense_claim_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Purchase orders → bills
-- -----------------------------------------------------------------------------

CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id      UUID REFERENCES contacts(id) ON DELETE SET NULL,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    po_number       TEXT NOT NULL,
    reference       TEXT,
    status          purchase_order_status NOT NULL DEFAULT 'draft',
    issue_date      DATE,
    delivery_date   DATE,
    currency        CHAR(3) NOT NULL,
    fx_rate         NUMERIC(20, 10),
    subtotal        NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_total       NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, po_number),
    CONSTRAINT purchase_orders_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX purchase_orders_org_status_idx ON purchase_orders (organization_id, status);
CREATE INDEX purchase_orders_contact_idx    ON purchase_orders (contact_id);

CREATE TRIGGER purchase_orders_set_updated_at
BEFORE UPDATE ON purchase_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_order_lines (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id        UUID REFERENCES accounts(id) ON DELETE SET NULL,
    category_id       UUID REFERENCES categories(id) ON DELETE SET NULL,
    tax_rate_id       UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description       TEXT,
    quantity          NUMERIC(14, 4) NOT NULL DEFAULT 1,
    unit_price        NUMERIC(14, 4) NOT NULL DEFAULT 0,
    amount            NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax               NUMERIC(14, 2) NOT NULL DEFAULT 0,
    line_order        INT NOT NULL DEFAULT 0,
    quantity_billed   NUMERIC(14, 4) NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (purchase_order_id, line_order);

CREATE TRIGGER purchase_order_lines_set_updated_at
BEFORE UPDATE ON purchase_order_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A PO can be billed across multiple bills, so the link lives on the bill.
ALTER TABLE bills
    ADD COLUMN purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX bills_purchase_order_idx ON bills (purchase_order_id);

-- -----------------------------------------------------------------------------
-- Credit notes (sales = vs invoice; purchase = vs bill)
-- -----------------------------------------------------------------------------

CREATE TABLE credit_notes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id         UUID REFERENCES contacts(id) ON DELETE SET NULL,
    sales_invoice_id   UUID REFERENCES sales_invoices(id) ON DELETE SET NULL,
    bill_id            UUID REFERENCES bills(id) ON DELETE SET NULL,
    created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    kind               credit_note_kind NOT NULL,
    status             credit_note_status NOT NULL DEFAULT 'draft',
    credit_note_number TEXT NOT NULL,
    reference          TEXT,
    issue_date         DATE,
    currency           CHAR(3) NOT NULL,
    fx_rate            NUMERIC(20, 10),
    subtotal           NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_total          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total              NUMERIC(14, 2) NOT NULL DEFAULT 0,
    amount_applied     NUMERIC(14, 2) NOT NULL DEFAULT 0,
    notes              TEXT,
    voided_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, credit_note_number),
    CONSTRAINT credit_notes_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    -- A sales credit attaches to an invoice (or nothing); a purchase credit
    -- attaches to a bill (or nothing). Don't allow crossed kinds.
    CONSTRAINT credit_notes_kind_target CHECK (
        (kind = 'sales'    AND bill_id IS NULL) OR
        (kind = 'purchase' AND sales_invoice_id IS NULL)
    )
);
CREATE INDEX credit_notes_org_status_idx ON credit_notes (organization_id, status);
CREATE INDEX credit_notes_contact_idx    ON credit_notes (contact_id);
CREATE INDEX credit_notes_invoice_idx    ON credit_notes (sales_invoice_id);
CREATE INDEX credit_notes_bill_idx       ON credit_notes (bill_id);

CREATE TRIGGER credit_notes_set_updated_at
BEFORE UPDATE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE credit_note_lines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_note_id  UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id      UUID REFERENCES accounts(id) ON DELETE SET NULL,
    category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
    tax_rate_id     UUID REFERENCES tax_rates(id) ON DELETE SET NULL,
    description     TEXT,
    quantity        NUMERIC(14, 4) NOT NULL DEFAULT 1,
    unit_price      NUMERIC(14, 4) NOT NULL DEFAULT 0,
    amount          NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax             NUMERIC(14, 2) NOT NULL DEFAULT 0,
    line_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX credit_note_lines_cn_idx ON credit_note_lines (credit_note_id, line_order);

CREATE TRIGGER credit_note_lines_set_updated_at
BEFORE UPDATE ON credit_note_lines
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Fixed assets register + depreciation schedule
--
-- Schedule rows are pre-computed when the asset is registered; a periodic
-- journal job posts the matching ledger_entries on each period_end and stamps
-- posted_at + posted_journal_id.
-- -----------------------------------------------------------------------------

CREATE TABLE fixed_assets (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_id           UUID REFERENCES assets(id) ON DELETE SET NULL,
    bill_id            UUID REFERENCES bills(id) ON DELETE SET NULL,
    asset_account_id   UUID REFERENCES accounts(id) ON DELETE SET NULL,
    expense_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    name               TEXT NOT NULL,
    asset_number       TEXT,
    serial_number      TEXT,
    description        TEXT,
    status             fixed_asset_status NOT NULL DEFAULT 'draft',
    purchase_date      DATE,
    purchase_price     NUMERIC(14, 2),
    currency           CHAR(3) NOT NULL,
    salvage_value      NUMERIC(14, 2) NOT NULL DEFAULT 0,
    useful_life_months INT,
    method             depreciation_method NOT NULL DEFAULT 'straight_line',
    accumulated_dep    NUMERIC(14, 2) NOT NULL DEFAULT 0,
    depreciation_start DATE,
    disposed_at        DATE,
    disposed_amount    NUMERIC(14, 2),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, asset_number),
    CONSTRAINT fixed_assets_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT fixed_assets_useful_life  CHECK (useful_life_months IS NULL OR useful_life_months > 0)
);
CREATE INDEX fixed_assets_org_status_idx ON fixed_assets (organization_id, status);

CREATE TRIGGER fixed_assets_set_updated_at
BEFORE UPDATE ON fixed_assets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fixed_asset_depreciation_schedule (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    fixed_asset_id    UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    period_start      DATE NOT NULL,
    period_end        DATE NOT NULL,
    amount            NUMERIC(14, 2) NOT NULL,
    accumulated_after NUMERIC(14, 2) NOT NULL,
    book_value_after  NUMERIC(14, 2) NOT NULL,
    posted_at         TIMESTAMPTZ,
    posted_journal_id UUID REFERENCES manual_journals(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fixed_asset_id, period_end)
);
CREATE INDEX fixed_asset_dep_schedule_fa_idx ON fixed_asset_depreciation_schedule (fixed_asset_id, period_end);

-- -----------------------------------------------------------------------------
-- Bank feed connections (Plaid / Yodlee / Truelayer / Salt Edge / manual)
--
-- Persistent state for a live aggregation link. Encrypted tokens live here so
-- a feed is rotated/revoked independently from any user OAuth grant. Each row
-- represents one connected institution-account pair on the provider side; a
-- single user-facing GL `account_id` may be populated by it.
-- -----------------------------------------------------------------------------

CREATE TABLE bank_feed_connections (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    account_id              UUID REFERENCES accounts(id) ON DELETE SET NULL,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    provider                bank_feed_provider NOT NULL,
    provider_item_id        TEXT,
    provider_account_id     TEXT,
    institution_name        TEXT,
    institution_id          TEXT,
    mask                    TEXT,
    access_token_encrypted  TEXT,
    refresh_token_encrypted TEXT,
    cursor                  TEXT,
    status                  bank_feed_status NOT NULL DEFAULT 'pending',
    error_code              TEXT,
    error_message           TEXT,
    last_synced_at          TIMESTAMPTZ,
    consent_expires_at      TIMESTAMPTZ,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_item_id, provider_account_id)
);
CREATE INDEX bank_feed_connections_org_idx     ON bank_feed_connections (organization_id, status);
CREATE INDEX bank_feed_connections_account_idx ON bank_feed_connections (account_id);

CREATE TRIGGER bank_feed_connections_set_updated_at
BEFORE UPDATE ON bank_feed_connections
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Track the source of each statement so reconciliation can dedupe across
-- email-in / upload / live feed.
ALTER TABLE bank_statements
    ADD COLUMN bank_feed_connection_id UUID REFERENCES bank_feed_connections(id) ON DELETE SET NULL;
CREATE INDEX bank_statements_feed_idx ON bank_statements (bank_feed_connection_id);

-- -----------------------------------------------------------------------------
-- RLS for accounting tables
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
    accounting_tables TEXT[] := ARRAY[
        'tax_rates',
        'accounts',
        'categories',
        'tags',
        'contacts',
        'classification_rules',
        'transfers',
        'transactions',
        'transaction_classifications',
        'transaction_splits',
        'transaction_tags',
        'recurring_transactions',
        'manual_journals',
        'ledger_entries',
        'bank_statements',
        'statement_lines',
        'sales_invoices',
        'sales_invoice_lines',
        'bills',
        'bill_lines',
        'budgets',
        'budget_lines',
        'goals',
        'classification_corrections',
        'assets',
        'asset_valuations',
        'liabilities',
        'liability_balances',
        'holdings',
        'expense_claims',
        'expense_claim_lines',
        'purchase_orders',
        'purchase_order_lines',
        'credit_notes',
        'credit_note_lines',
        'fixed_assets',
        'fixed_asset_depreciation_schedule',
        'bank_feed_connections'
    ];
BEGIN
    FOREACH t IN ARRAY accounting_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I '
            'USING (organization_id = app_current_organization_id()) '
            'WITH CHECK (organization_id = app_current_organization_id())',
            t || '_org_isolation', t
        );
    END LOOP;
END $$;
