-- =============================================================================
-- Migration 3/4: Accounting and bookkeeping
--
-- The financial domain. Same tables serve both personal (Vault22-style)
-- and business (Xero-style) orgs; features layer on top by org kind.
--
--   * tax_rates, accounts (chart of accounts), categories, tags, contacts
--   * classification_rules, transfers
--   * transactions + transaction_classifications, transaction_splits,
--     transaction_tags
--   * recurring_transactions
--   * manual_journals + ledger_entries (double-entry projection)
--   * bank_statements + statement_lines (with reconcile state)
--   * sales_invoices + lines, bills + lines (Xero-style AR / AP)
--   * budgets + budget_lines, goals
--   * classification_corrections, merchant_signals
--   * net-worth: assets, asset_valuations, liabilities, liability_balances,
--     holdings
--   * expense_claims + lines
--   * purchase_orders + lines
--   * credit_notes + lines
--   * fixed_assets + depreciation_schedule
--   * bank_feed_connections (Plaid / Yodlee / Truelayer / Salt Edge / manual)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_status') THEN
        CREATE TYPE transaction_status AS ENUM ('pending', 'verified', 'rejected');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'transaction_direction') THEN
        CREATE TYPE transaction_direction AS ENUM ('debit', 'credit', 'transfer');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_type') THEN
        CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'category_kind') THEN
        CREATE TYPE category_kind AS ENUM ('income', 'expense', 'transfer');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'classification_match_type') THEN
        CREATE TYPE classification_match_type AS ENUM ('merchant_exact', 'merchant_contains', 'merchant_regex');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'classification_source') THEN
        CREATE TYPE classification_source AS ENUM ('user', 'rule', 'llm', 'merchant_signal', 'system');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ledger_source_type') THEN
        CREATE TYPE ledger_source_type AS ENUM ('transaction', 'manual_journal', 'opening_balance', 'invoice', 'bill', 'transfer');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
        CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bill_status') THEN
        CREATE TYPE bill_status AS ENUM ('draft', 'awaiting_payment', 'partially_paid', 'paid', 'overdue', 'voided');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'contact_kind') THEN
        CREATE TYPE contact_kind AS ENUM ('customer', 'supplier', 'both');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'budget_period') THEN
        CREATE TYPE budget_period AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'goal_kind') THEN
        CREATE TYPE goal_kind AS ENUM ('savings', 'debt_payoff', 'spending');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'goal_status') THEN
        CREATE TYPE goal_status AS ENUM ('active', 'achieved', 'abandoned');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recurring_frequency') THEN
        CREATE TYPE recurring_frequency AS ENUM ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recurring_status') THEN
        CREATE TYPE recurring_status AS ENUM ('active', 'paused', 'cancelled');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'asset_kind') THEN
        CREATE TYPE asset_kind AS ENUM ('property', 'vehicle', 'cash', 'investment', 'retirement', 'business', 'collectible', 'other');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'liability_kind') THEN
        CREATE TYPE liability_kind AS ENUM ('mortgage', 'student_loan', 'credit_card', 'personal_loan', 'auto_loan', 'business_loan', 'other');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'holding_kind') THEN
        CREATE TYPE holding_kind AS ENUM ('equity', 'etf', 'mutual_fund', 'bond', 'crypto', 'commodity', 'cash', 'other');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'expense_claim_status') THEN
        CREATE TYPE expense_claim_status AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'paid', 'voided');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'purchase_order_status') THEN
        CREATE TYPE purchase_order_status AS ENUM ('draft', 'submitted', 'approved', 'partially_billed', 'billed', 'cancelled');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'credit_note_kind') THEN
        CREATE TYPE credit_note_kind AS ENUM ('sales', 'purchase');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'credit_note_status') THEN
        CREATE TYPE credit_note_status AS ENUM ('draft', 'authorised', 'applied', 'voided');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fixed_asset_status') THEN
        CREATE TYPE fixed_asset_status AS ENUM ('draft', 'registered', 'disposed');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'depreciation_method') THEN
        CREATE TYPE depreciation_method AS ENUM ('straight_line', 'declining_balance', 'none');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bank_feed_provider') THEN
        CREATE TYPE bank_feed_provider AS ENUM ('plaid', 'yodlee', 'truelayer', 'salt_edge', 'manual');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'bank_feed_status') THEN
        CREATE TYPE bank_feed_status AS ENUM ('pending', 'connected', 'reauth_required', 'error', 'disconnected');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Tax rates and chart of accounts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tax_rates (
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

CREATE INDEX IF NOT EXISTS tax_rates_org_active_idx ON tax_rates (organization_id) WHERE is_active;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tax_rates_set_updated_at') THEN
        CREATE TRIGGER tax_rates_set_updated_at
        BEFORE UPDATE ON tax_rates
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS accounts (
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

CREATE INDEX IF NOT EXISTS accounts_org_type_idx ON accounts (organization_id, type);
CREATE INDEX IF NOT EXISTS accounts_parent_idx   ON accounts (parent_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'accounts_set_updated_at') THEN
        CREATE TRIGGER accounts_set_updated_at
        BEFORE UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS categories (
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

CREATE INDEX IF NOT EXISTS categories_org_kind_idx ON categories (organization_id, kind);
CREATE INDEX IF NOT EXISTS categories_parent_idx   ON categories (parent_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'categories_set_updated_at') THEN
        CREATE TRIGGER categories_set_updated_at
        BEFORE UPDATE ON categories
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS tags (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    color           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, name)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tags_set_updated_at') THEN
        CREATE TRIGGER tags_set_updated_at
        BEFORE UPDATE ON tags
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS contacts (
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

CREATE INDEX IF NOT EXISTS contacts_org_kind_idx ON contacts (organization_id, kind);
CREATE INDEX IF NOT EXISTS contacts_org_name_idx ON contacts (organization_id, name);
CREATE INDEX IF NOT EXISTS contacts_email_idx    ON contacts (email);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'contacts_set_updated_at') THEN
        CREATE TRIGGER contacts_set_updated_at
        BEFORE UPDATE ON contacts
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Classification rules
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS classification_rules (
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

CREATE INDEX IF NOT EXISTS classification_rules_org_match_idx
    ON classification_rules (organization_id, match_type, match_value);
CREATE INDEX IF NOT EXISTS classification_rules_category_idx
    ON classification_rules (category_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'classification_rules_set_updated_at') THEN
        CREATE TRIGGER classification_rules_set_updated_at
        BEFORE UPDATE ON classification_rules
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Transfers (defined before transactions so transactions.transfer_id can be inline)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transfers (
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

CREATE INDEX IF NOT EXISTS transfers_org_date_idx ON transfers (organization_id, posted_date DESC);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'transfers_set_updated_at') THEN
        CREATE TRIGGER transfers_set_updated_at
        BEFORE UPDATE ON transfers
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Transactions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transactions (
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

CREATE INDEX IF NOT EXISTS transactions_org_date_idx
    ON transactions (organization_id, posted_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS transactions_org_status_idx
    ON transactions (organization_id, status);
CREATE INDEX IF NOT EXISTS transactions_org_category_idx
    ON transactions (organization_id, category_id);
CREATE INDEX IF NOT EXISTS transactions_org_account_idx
    ON transactions (organization_id, account_id);
CREATE INDEX IF NOT EXISTS transactions_org_contact_idx
    ON transactions (organization_id, contact_id);
CREATE INDEX IF NOT EXISTS transactions_document_idx
    ON transactions (document_id);
CREATE INDEX IF NOT EXISTS transactions_transfer_idx
    ON transactions (transfer_id);
CREATE INDEX IF NOT EXISTS transactions_merchant_trgm_idx
    ON transactions USING gin (merchant_normalized gin_trgm_ops);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'transactions_set_updated_at') THEN
        CREATE TRIGGER transactions_set_updated_at
        BEFORE UPDATE ON transactions
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS transaction_classifications (
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

CREATE INDEX IF NOT EXISTS transaction_classifications_tx_idx
    ON transaction_classifications (transaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transaction_classifications_org_idx
    ON transaction_classifications (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transaction_classifications_model_idx
    ON transaction_classifications (model_id);
CREATE UNIQUE INDEX IF NOT EXISTS transaction_classifications_current_unique
    ON transaction_classifications (transaction_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS transaction_splits (
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

CREATE INDEX IF NOT EXISTS transaction_splits_tx_idx  ON transaction_splits (transaction_id);
CREATE INDEX IF NOT EXISTS transaction_splits_org_idx ON transaction_splits (organization_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'transaction_splits_set_updated_at') THEN
        CREATE TRIGGER transaction_splits_set_updated_at
        BEFORE UPDATE ON transaction_splits
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS transaction_tags (
    transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id          UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (transaction_id, tag_id)
);

CREATE INDEX IF NOT EXISTS transaction_tags_tag_idx ON transaction_tags (tag_id);
CREATE INDEX IF NOT EXISTS transaction_tags_org_idx ON transaction_tags (organization_id);

-- -----------------------------------------------------------------------------
-- Recurring transactions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recurring_transactions (
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

CREATE INDEX IF NOT EXISTS recurring_transactions_org_idx
    ON recurring_transactions (organization_id, status);
CREATE INDEX IF NOT EXISTS recurring_transactions_next_idx
    ON recurring_transactions (organization_id, next_expected_date)
    WHERE status = 'active';

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'recurring_transactions_set_updated_at') THEN
        CREATE TRIGGER recurring_transactions_set_updated_at
        BEFORE UPDATE ON recurring_transactions
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Manual journals and ledger entries
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS manual_journals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    posted_date     DATE NOT NULL,
    narrative       TEXT,
    reference       TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS manual_journals_org_date_idx
    ON manual_journals (organization_id, posted_date DESC);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'manual_journals_set_updated_at') THEN
        CREATE TRIGGER manual_journals_set_updated_at
        BEFORE UPDATE ON manual_journals
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS ledger_entries (
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

CREATE INDEX IF NOT EXISTS ledger_entries_org_account_date_idx
    ON ledger_entries (organization_id, account_id, posted_date);
CREATE INDEX IF NOT EXISTS ledger_entries_source_idx
    ON ledger_entries (source_type, source_id);
CREATE INDEX IF NOT EXISTS ledger_entries_org_date_idx
    ON ledger_entries (organization_id, posted_date);

-- -----------------------------------------------------------------------------
-- Bank statements
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_statements (
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

CREATE INDEX IF NOT EXISTS bank_statements_org_period_idx
    ON bank_statements (organization_id, period_end DESC NULLS LAST);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bank_statements_set_updated_at') THEN
        CREATE TRIGGER bank_statements_set_updated_at
        BEFORE UPDATE ON bank_statements
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS statement_lines (
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

CREATE INDEX IF NOT EXISTS statement_lines_statement_idx ON statement_lines (statement_id);
CREATE INDEX IF NOT EXISTS statement_lines_org_date_idx  ON statement_lines (organization_id, line_date);
CREATE INDEX IF NOT EXISTS statement_lines_unmatched_idx
    ON statement_lines (organization_id)
    WHERE transaction_id IS NULL;
CREATE INDEX IF NOT EXISTS statement_lines_unreconciled_idx
    ON statement_lines (organization_id)
    WHERE NOT is_reconciled;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'statement_lines_set_updated_at') THEN
        CREATE TRIGGER statement_lines_set_updated_at
        BEFORE UPDATE ON statement_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Sales invoices and bills (Xero-style AR / AP)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales_invoices (
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

CREATE INDEX IF NOT EXISTS sales_invoices_org_status_idx ON sales_invoices (organization_id, status);
CREATE INDEX IF NOT EXISTS sales_invoices_org_due_idx    ON sales_invoices (organization_id, due_date);
CREATE INDEX IF NOT EXISTS sales_invoices_contact_idx    ON sales_invoices (contact_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sales_invoices_set_updated_at') THEN
        CREATE TRIGGER sales_invoices_set_updated_at
        BEFORE UPDATE ON sales_invoices
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
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

CREATE INDEX IF NOT EXISTS sales_invoice_lines_invoice_idx ON sales_invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS sales_invoice_lines_org_idx     ON sales_invoice_lines (organization_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sales_invoice_lines_set_updated_at') THEN
        CREATE TRIGGER sales_invoice_lines_set_updated_at
        BEFORE UPDATE ON sales_invoice_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS bills (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    contact_id           UUID REFERENCES contacts(id) ON DELETE RESTRICT,
    document_id          UUID REFERENCES documents(id) ON DELETE SET NULL,
    bill_number          TEXT,
    reference            TEXT,
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

CREATE INDEX IF NOT EXISTS bills_org_status_idx ON bills (organization_id, status);
CREATE INDEX IF NOT EXISTS bills_org_due_idx    ON bills (organization_id, due_date);
CREATE INDEX IF NOT EXISTS bills_contact_idx    ON bills (contact_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bills_set_updated_at') THEN
        CREATE TRIGGER bills_set_updated_at
        BEFORE UPDATE ON bills
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS bill_lines (
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

CREATE INDEX IF NOT EXISTS bill_lines_bill_idx ON bill_lines (bill_id);
CREATE INDEX IF NOT EXISTS bill_lines_org_idx  ON bill_lines (organization_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bill_lines_set_updated_at') THEN
        CREATE TRIGGER bill_lines_set_updated_at
        BEFORE UPDATE ON bill_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Budgets and goals
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS budgets (
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

CREATE INDEX IF NOT EXISTS budgets_org_active_idx ON budgets (organization_id) WHERE is_active;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'budgets_set_updated_at') THEN
        CREATE TRIGGER budgets_set_updated_at
        BEFORE UPDATE ON budgets
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS budget_lines (
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

CREATE INDEX IF NOT EXISTS budget_lines_org_idx ON budget_lines (organization_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'budget_lines_set_updated_at') THEN
        CREATE TRIGGER budget_lines_set_updated_at
        BEFORE UPDATE ON budget_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS goals (
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

CREATE INDEX IF NOT EXISTS goals_org_status_idx ON goals (organization_id, status);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'goals_set_updated_at') THEN
        CREATE TRIGGER goals_set_updated_at
        BEFORE UPDATE ON goals
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Classification corrections and global merchant signals
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS classification_corrections (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    transaction_id        UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    merchant_normalized   TEXT,
    old_category_id       UUID REFERENCES categories(id) ON DELETE SET NULL,
    new_category_id       UUID REFERENCES categories(id) ON DELETE SET NULL,
    old_source            classification_source,
    old_classification_id UUID REFERENCES transaction_classifications(id) ON DELETE SET NULL,
    new_classification_id UUID REFERENCES transaction_classifications(id) ON DELETE SET NULL,
    corrected_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS classification_corrections_org_idx
    ON classification_corrections (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS classification_corrections_merchant_idx
    ON classification_corrections (merchant_normalized);

CREATE TABLE IF NOT EXISTS merchant_signals (
    merchant_normalized  TEXT NOT NULL,
    category_label       TEXT NOT NULL,
    vote_count           INTEGER NOT NULL DEFAULT 0,
    last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (merchant_normalized, category_label)
);

CREATE INDEX IF NOT EXISTS merchant_signals_merchant_idx
    ON merchant_signals (merchant_normalized, vote_count DESC);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'merchant_signals_set_updated_at') THEN
        CREATE TRIGGER merchant_signals_set_updated_at
        BEFORE UPDATE ON merchant_signals
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Net worth: assets, asset_valuations, liabilities, liability_balances, holdings
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS assets (
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

CREATE INDEX IF NOT EXISTS assets_org_kind_idx ON assets (organization_id, kind);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'assets_set_updated_at') THEN
        CREATE TRIGGER assets_set_updated_at
        BEFORE UPDATE ON assets
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS asset_valuations (
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

CREATE INDEX IF NOT EXISTS asset_valuations_org_idx ON asset_valuations (organization_id, as_of DESC);

CREATE TABLE IF NOT EXISTS liabilities (
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

CREATE INDEX IF NOT EXISTS liabilities_org_kind_idx ON liabilities (organization_id, kind);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'liabilities_set_updated_at') THEN
        CREATE TRIGGER liabilities_set_updated_at
        BEFORE UPDATE ON liabilities
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS liability_balances (
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

CREATE INDEX IF NOT EXISTS liability_balances_org_idx ON liability_balances (organization_id, as_of DESC);

CREATE TABLE IF NOT EXISTS holdings (
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

CREATE INDEX IF NOT EXISTS holdings_org_kind_idx ON holdings (organization_id, kind);
CREATE INDEX IF NOT EXISTS holdings_symbol_idx   ON holdings (symbol);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'holdings_set_updated_at') THEN
        CREATE TRIGGER holdings_set_updated_at
        BEFORE UPDATE ON holdings
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Expense claims
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS expense_claims (
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

CREATE INDEX IF NOT EXISTS expense_claims_org_status_idx   ON expense_claims (organization_id, status);
CREATE INDEX IF NOT EXISTS expense_claims_submitted_by_idx ON expense_claims (submitted_by);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'expense_claims_set_updated_at') THEN
        CREATE TRIGGER expense_claims_set_updated_at
        BEFORE UPDATE ON expense_claims
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS expense_claim_lines (
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

CREATE INDEX IF NOT EXISTS expense_claim_lines_claim_idx ON expense_claim_lines (expense_claim_id, line_order);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'expense_claim_lines_set_updated_at') THEN
        CREATE TRIGGER expense_claim_lines_set_updated_at
        BEFORE UPDATE ON expense_claim_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Purchase orders → bills
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS purchase_orders (
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

CREATE INDEX IF NOT EXISTS purchase_orders_org_status_idx ON purchase_orders (organization_id, status);
CREATE INDEX IF NOT EXISTS purchase_orders_contact_idx    ON purchase_orders (contact_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'purchase_orders_set_updated_at') THEN
        CREATE TRIGGER purchase_orders_set_updated_at
        BEFORE UPDATE ON purchase_orders
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS purchase_order_lines (
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

CREATE INDEX IF NOT EXISTS purchase_order_lines_po_idx ON purchase_order_lines (purchase_order_id, line_order);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'purchase_order_lines_set_updated_at') THEN
        CREATE TRIGGER purchase_order_lines_set_updated_at
        BEFORE UPDATE ON purchase_order_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- A PO can be billed across multiple bills, so the link lives on the bill.
ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bills_purchase_order_idx ON bills (purchase_order_id);

-- -----------------------------------------------------------------------------
-- Credit notes
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS credit_notes (
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
    CONSTRAINT credit_notes_kind_target CHECK (
        (kind = 'sales'    AND bill_id IS NULL) OR
        (kind = 'purchase' AND sales_invoice_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS credit_notes_org_status_idx ON credit_notes (organization_id, status);
CREATE INDEX IF NOT EXISTS credit_notes_contact_idx    ON credit_notes (contact_id);
CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx    ON credit_notes (sales_invoice_id);
CREATE INDEX IF NOT EXISTS credit_notes_bill_idx       ON credit_notes (bill_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'credit_notes_set_updated_at') THEN
        CREATE TRIGGER credit_notes_set_updated_at
        BEFORE UPDATE ON credit_notes
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS credit_note_lines (
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

CREATE INDEX IF NOT EXISTS credit_note_lines_cn_idx ON credit_note_lines (credit_note_id, line_order);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'credit_note_lines_set_updated_at') THEN
        CREATE TRIGGER credit_note_lines_set_updated_at
        BEFORE UPDATE ON credit_note_lines
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Fixed assets register + depreciation schedule
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fixed_assets (
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

CREATE INDEX IF NOT EXISTS fixed_assets_org_status_idx ON fixed_assets (organization_id, status);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'fixed_assets_set_updated_at') THEN
        CREATE TRIGGER fixed_assets_set_updated_at
        BEFORE UPDATE ON fixed_assets
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation_schedule (
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

CREATE INDEX IF NOT EXISTS fixed_asset_dep_schedule_fa_idx ON fixed_asset_depreciation_schedule (fixed_asset_id, period_end);

-- -----------------------------------------------------------------------------
-- Bank feed connections (Plaid / Yodlee / Truelayer / Salt Edge / manual)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_feed_connections (
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

CREATE INDEX IF NOT EXISTS bank_feed_connections_org_idx     ON bank_feed_connections (organization_id, status);
CREATE INDEX IF NOT EXISTS bank_feed_connections_account_idx ON bank_feed_connections (account_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'bank_feed_connections_set_updated_at') THEN
        CREATE TRIGGER bank_feed_connections_set_updated_at
        BEFORE UPDATE ON bank_feed_connections
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- Track the source of each statement so reconciliation can dedupe across
-- email-in / upload / live feed.
ALTER TABLE bank_statements
    ADD COLUMN IF NOT EXISTS bank_feed_connection_id UUID REFERENCES bank_feed_connections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bank_statements_feed_idx ON bank_statements (bank_feed_connection_id);

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
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE tablename = t AND policyname = t || '_org_isolation'
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON %I '
                'USING (organization_id = app_current_organization_id()) '
                'WITH CHECK (organization_id = app_current_organization_id())',
                t || '_org_isolation', t
            );
        END IF;
    END LOOP;
END $$;
