-- =============================================================================
-- Migration 4/4: Billing, metering, wallet, and platform ops
--
--   * Subscriptions: plans + tier prices, subscriptions per org, Paystack
--     customer/subscription/invoice codes, payment_methods, paystack_events
--   * Quotas: per-plan and per-org overrides for every billable metric
--   * Metering: usage_events (granular, source of truth) feeding usage_charges
--     (period roll-ups), settled either to subscription_invoices or wallet
--   * Wallet: prepaid balance per org with topups, immutable ledger, and
--     auto-topup config — for paying overages and beyond-subscription usage
--   * Platform ops: notifications, audit_log
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
        CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'paused', 'incomplete');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_invoice_status') THEN
        CREATE TYPE subscription_invoice_status AS ENUM ('pending', 'paid', 'failed', 'refunded', 'voided');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_interval') THEN
        CREATE TYPE billing_interval AS ENUM ('monthly', 'quarterly', 'annually');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_ledger_kind') THEN
        CREATE TYPE wallet_ledger_kind AS ENUM (
            'topup',
            'topup_reversal',
            'usage_charge',
            'subscription_charge',
            'refund',
            'promo_credit',
            'manual_adjustment'
        );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_topup_status') THEN
        CREATE TYPE wallet_topup_status AS ENUM ('pending', 'succeeded', 'failed', 'reversed');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_kind') THEN
        CREATE TYPE notification_kind AS ENUM ('alert', 'info', 'reminder', 'system');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Plans (billing tiers)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    interval      billing_interval NOT NULL,
    trial_days    INTEGER NOT NULL DEFAULT 0,
    features      JSONB NOT NULL DEFAULT '{}'::jsonb,
    limits        JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_public     BOOLEAN NOT NULL DEFAULT TRUE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT plans_trial_nonneg CHECK (trial_days >= 0)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'plans_set_updated_at') THEN
        CREATE TRIGGER plans_set_updated_at
        BEFORE UPDATE ON plans
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS plan_prices (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id             UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    currency            CHAR(3) NOT NULL,
    amount_cents        BIGINT NOT NULL,
    paystack_plan_code  TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT plan_prices_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT plan_prices_nonneg       CHECK (amount_cents >= 0),
    UNIQUE (plan_id, currency)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'plan_prices_set_updated_at') THEN
        CREATE TRIGGER plan_prices_set_updated_at
        BEFORE UPDATE ON plan_prices
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS plan_quotas (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id                  UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    metric                   TEXT NOT NULL,
    unit                     TEXT NOT NULL,
    included_quantity        NUMERIC(20, 6) NOT NULL DEFAULT 0,
    overage_unit_price_cents BIGINT,
    overage_block_size       NUMERIC(20, 6) NOT NULL DEFAULT 1,
    currency                 CHAR(3) NOT NULL,
    notes                    TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT plan_quotas_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT plan_quotas_included_nonneg CHECK (included_quantity >= 0),
    CONSTRAINT plan_quotas_block_pos CHECK (overage_block_size > 0),
    CONSTRAINT plan_quotas_overage_nonneg
        CHECK (overage_unit_price_cents IS NULL OR overage_unit_price_cents >= 0),
    UNIQUE (plan_id, metric)
);

CREATE INDEX IF NOT EXISTS plan_quotas_plan_idx ON plan_quotas (plan_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'plan_quotas_set_updated_at') THEN
        CREATE TRIGGER plan_quotas_set_updated_at
        BEFORE UPDATE ON plan_quotas
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Subscriptions (Paystack-backed)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
    id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id                      UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    plan_price_id                UUID REFERENCES plan_prices(id) ON DELETE RESTRICT,
    status                       subscription_status NOT NULL DEFAULT 'trialing',
    paystack_customer_code       TEXT,
    paystack_subscription_code   TEXT UNIQUE,
    paystack_email_token         TEXT,
    trial_ends_at                TIMESTAMPTZ,
    current_period_start         TIMESTAMPTZ,
    current_period_end           TIMESTAMPTZ,
    cancel_at                    TIMESTAMPTZ,
    cancelled_at                 TIMESTAMPTZ,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_active_per_org
    ON subscriptions (organization_id)
    WHERE status IN ('trialing', 'active', 'past_due', 'paused');

CREATE INDEX IF NOT EXISTS subscriptions_org_idx     ON subscriptions (organization_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx  ON subscriptions (status);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'subscriptions_set_updated_at') THEN
        CREATE TRIGGER subscriptions_set_updated_at
        BEFORE UPDATE ON subscriptions
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS payment_methods (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id               UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    paystack_authorization_code   TEXT NOT NULL,
    paystack_signature            TEXT,
    bin                           TEXT,
    last4                         TEXT,
    brand                         TEXT,
    bank                          TEXT,
    exp_month                     SMALLINT,
    exp_year                      SMALLINT,
    channel                       TEXT,
    is_default                    BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at                    TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, paystack_authorization_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_default_unique
    ON payment_methods (organization_id)
    WHERE is_default AND revoked_at IS NULL;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_methods_set_updated_at') THEN
        CREATE TRIGGER payment_methods_set_updated_at
        BEFORE UPDATE ON payment_methods
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS subscription_invoices (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id          UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    paystack_invoice_code    TEXT UNIQUE,
    paystack_reference       TEXT,
    period_start             TIMESTAMPTZ,
    period_end               TIMESTAMPTZ,
    amount_cents             BIGINT NOT NULL,
    currency                 CHAR(3) NOT NULL,
    status                   subscription_invoice_status NOT NULL DEFAULT 'pending',
    paid_at                  TIMESTAMPTZ,
    hosted_invoice_url       TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT subscription_invoices_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS subscription_invoices_org_idx ON subscription_invoices (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_invoices_sub_idx ON subscription_invoices (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS subscription_invoices_unpaid_idx
    ON subscription_invoices (organization_id)
    WHERE status IN ('pending', 'failed');

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'subscription_invoices_set_updated_at') THEN
        CREATE TRIGGER subscription_invoices_set_updated_at
        BEFORE UPDATE ON subscription_invoices
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS paystack_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    paystack_event  TEXT NOT NULL,
    paystack_id     TEXT,
    payload         JSONB NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    error           TEXT
);

CREATE INDEX IF NOT EXISTS paystack_events_received_idx ON paystack_events (received_at DESC);
CREATE INDEX IF NOT EXISTS paystack_events_unprocessed_idx
    ON paystack_events (received_at)
    WHERE processed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paystack_events_dedupe_idx
    ON paystack_events (paystack_event, paystack_id)
    WHERE paystack_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_counters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    metric          TEXT NOT NULL,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    count           BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, metric, period_start)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'usage_counters_set_updated_at') THEN
        CREATE TRIGGER usage_counters_set_updated_at
        BEFORE UPDATE ON usage_counters
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Per-org quota overrides
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_quotas (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    metric                   TEXT NOT NULL,
    unit                     TEXT NOT NULL,
    included_quantity        NUMERIC(20, 6) NOT NULL DEFAULT 0,
    overage_unit_price_cents BIGINT,
    overage_block_size       NUMERIC(20, 6) NOT NULL DEFAULT 1,
    currency                 CHAR(3) NOT NULL,
    valid_from               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until              TIMESTAMPTZ,
    notes                    TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organization_quotas_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT organization_quotas_included_nonneg CHECK (included_quantity >= 0),
    CONSTRAINT organization_quotas_block_pos CHECK (overage_block_size > 0),
    UNIQUE (organization_id, metric)
);

CREATE INDEX IF NOT EXISTS organization_quotas_org_idx ON organization_quotas (organization_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organization_quotas_set_updated_at') THEN
        CREATE TRIGGER organization_quotas_set_updated_at
        BEFORE UPDATE ON organization_quotas
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Billing wallet
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_wallets (
    id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id               UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    currency                      CHAR(3) NOT NULL,
    balance_cents                 BIGINT NOT NULL DEFAULT 0,
    low_balance_threshold_cents   BIGINT,
    auto_topup_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
    auto_topup_threshold_cents    BIGINT,
    auto_topup_amount_cents       BIGINT,
    auto_topup_payment_method_id  UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT billing_wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_wallets_set_updated_at') THEN
        CREATE TRIGGER billing_wallets_set_updated_at
        BEFORE UPDATE ON billing_wallets
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS wallet_topups (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id           UUID NOT NULL REFERENCES billing_wallets(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    amount_cents        BIGINT NOT NULL,
    currency            CHAR(3) NOT NULL,
    paystack_reference  TEXT UNIQUE,
    payment_method_id   UUID REFERENCES payment_methods(id) ON DELETE SET NULL,
    status              wallet_topup_status NOT NULL DEFAULT 'pending',
    initiated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    is_auto             BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at             TIMESTAMPTZ,
    failed_at           TIMESTAMPTZ,
    error               TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT wallet_topups_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wallet_topups_amount_pos   CHECK (amount_cents > 0)
);

CREATE INDEX IF NOT EXISTS wallet_topups_wallet_idx  ON wallet_topups (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_topups_org_idx     ON wallet_topups (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_topups_pending_idx ON wallet_topups (status) WHERE status = 'pending';

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'wallet_topups_set_updated_at') THEN
        CREATE TRIGGER wallet_topups_set_updated_at
        BEFORE UPDATE ON wallet_topups
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- Immutable signed ledger for the wallet.
CREATE TABLE IF NOT EXISTS wallet_ledger (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id               UUID NOT NULL REFERENCES billing_wallets(id) ON DELETE RESTRICT,
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind                    wallet_ledger_kind NOT NULL,
    amount_cents            BIGINT NOT NULL,
    balance_after_cents     BIGINT NOT NULL,
    currency                CHAR(3) NOT NULL,
    description             TEXT,
    wallet_topup_id         UUID REFERENCES wallet_topups(id) ON DELETE SET NULL,
    usage_charge_id         UUID,
    subscription_invoice_id UUID REFERENCES subscription_invoices(id) ON DELETE SET NULL,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT wallet_ledger_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT wallet_ledger_amount_nonzero CHECK (amount_cents <> 0)
);

CREATE INDEX IF NOT EXISTS wallet_ledger_wallet_idx ON wallet_ledger (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_ledger_org_idx    ON wallet_ledger (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_ledger_kind_idx   ON wallet_ledger (organization_id, kind, created_at DESC);

-- Usage charges: roll-up of usage_events into bill lines.
CREATE TABLE IF NOT EXISTS usage_charges (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_invoice_id  UUID REFERENCES subscription_invoices(id) ON DELETE SET NULL,
    wallet_ledger_id         UUID REFERENCES wallet_ledger(id) ON DELETE SET NULL,
    metric                   TEXT NOT NULL,
    unit                     TEXT NOT NULL,
    period_start             TIMESTAMPTZ NOT NULL,
    period_end               TIMESTAMPTZ NOT NULL,
    included_quantity        NUMERIC(20, 6) NOT NULL DEFAULT 0,
    used_quantity            NUMERIC(20, 6) NOT NULL,
    billable_quantity        NUMERIC(20, 6) NOT NULL,
    unit_price_cents         BIGINT NOT NULL,
    amount_cents             BIGINT NOT NULL,
    currency                 CHAR(3) NOT NULL,
    settled_at               TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT usage_charges_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT usage_charges_quantities_nonneg
        CHECK (used_quantity >= 0 AND billable_quantity >= 0 AND included_quantity >= 0),
    CONSTRAINT usage_charges_amount_nonneg CHECK (amount_cents >= 0),
    CONSTRAINT usage_charges_period_order CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS usage_charges_org_period_idx
    ON usage_charges (organization_id, period_end DESC);
CREATE INDEX IF NOT EXISTS usage_charges_unsettled_idx
    ON usage_charges (organization_id, metric)
    WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS usage_charges_invoice_idx
    ON usage_charges (subscription_invoice_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'usage_charges_set_updated_at') THEN
        CREATE TRIGGER usage_charges_set_updated_at
        BEFORE UPDATE ON usage_charges
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Usage events: granular log, source of truth for billing
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    metric              TEXT NOT NULL,
    quantity            NUMERIC(20, 6) NOT NULL,
    unit                TEXT NOT NULL,
    ai_run_id           UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    model_id            UUID REFERENCES ai_models(id) ON DELETE SET NULL,
    document_id         UUID REFERENCES documents(id) ON DELETE SET NULL,
    chat_message_id     UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    query_run_id        UUID REFERENCES query_runs(id) ON DELETE SET NULL,
    actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    billed_charge_id    UUID REFERENCES usage_charges(id) ON DELETE SET NULL,
    cost_amount         NUMERIC(20, 8),
    cost_currency       CHAR(3),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT usage_events_cost_currency_iso
        CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS usage_events_org_metric_time_idx
    ON usage_events (organization_id, metric, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_unbilled_idx
    ON usage_events (organization_id, metric, occurred_at)
    WHERE billed_charge_id IS NULL;
CREATE INDEX IF NOT EXISTS usage_events_model_idx
    ON usage_events (model_id, occurred_at DESC);

-- -----------------------------------------------------------------------------
-- Notifications and audit log
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    kind            notification_kind NOT NULL DEFAULT 'info',
    title           TEXT NOT NULL,
    body            TEXT,
    link            TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
    ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_org_idx
    ON notifications (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_token_id  UUID REFERENCES api_tokens(id) ON DELETE SET NULL,
    entity_type     TEXT NOT NULL,
    entity_id       UUID,
    action          TEXT NOT NULL,
    before          JSONB,
    after           JSONB,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_org_created_idx ON audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx      ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx       ON audit_log (actor_user_id);

-- -----------------------------------------------------------------------------
-- RLS for billing and ops tables
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
    billing_tables TEXT[] := ARRAY[
        'subscriptions',
        'payment_methods',
        'subscription_invoices',
        'usage_counters',
        'organization_quotas',
        'usage_events',
        'billing_wallets',
        'wallet_topups',
        'wallet_ledger',
        'usage_charges',
        'notifications'
    ];
BEGIN
    FOREACH t IN ARRAY billing_tables LOOP
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

-- audit_log and paystack_events: nullable org_id.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'audit_log' AND policyname = 'audit_log_access'
    ) THEN
        CREATE POLICY audit_log_access ON audit_log
            USING (
                organization_id IS NULL
                OR organization_id = app_current_organization_id()
            );
    END IF;
END $$;

ALTER TABLE paystack_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'paystack_events' AND policyname = 'paystack_events_access'
    ) THEN
        CREATE POLICY paystack_events_access ON paystack_events
            USING (
                organization_id IS NULL
                OR organization_id = app_current_organization_id()
            );
    END IF;
END $$;
