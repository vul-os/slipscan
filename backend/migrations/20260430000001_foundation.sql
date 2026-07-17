-- =============================================================================
-- Migration 1/4: Foundation
--
-- Multi-tenant identity layer plus the cross-cutting infrastructure that
-- every later migration depends on:
--
--   * extensions, the `set_updated_at` trigger, and the RLS helper functions
--     (`app_current_organization_id`, `app_current_user_id`)
--   * reference data: `currencies`, `fx_rates`, `translations`
--   * users, organizations + per-kind profiles, memberships, invitations
--   * authorization surfaces: `api_tokens`, `oauth_grants`
--   * AI model registry and run log used by documents, transactions, chats,
--     and metering
--
-- Row-level security is enabled on every org-scoped table here. Owner
-- connections (migrations and the current single-role app connection)
-- bypass RLS — to enforce, run the app under a non-owner role and add
-- `ALTER TABLE … FORCE ROW LEVEL SECURITY` for each protected table.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_current_organization_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.organization_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::UUID;
$$ LANGUAGE SQL STABLE;

-- -----------------------------------------------------------------------------
-- Foundation enums
-- -----------------------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_kind') THEN
        CREATE TYPE organization_kind AS ENUM ('personal', 'business');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'membership_role') THEN
        CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'accountant', 'member', 'viewer');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'oauth_provider') THEN
        CREATE TYPE oauth_provider AS ENUM ('gmail', 'outlook', 'paystack', 'xero', 'google_drive');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'api_token_kind') THEN
        CREATE TYPE api_token_kind AS ENUM ('live', 'test', 'restricted');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_model_kind') THEN
        CREATE TYPE ai_model_kind AS ENUM ('ocr', 'extraction', 'classification', 'insights', 'embedding', 'normalization');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_run_status') THEN
        CREATE TYPE ai_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_target_type') THEN
        CREATE TYPE ai_target_type AS ENUM ('document', 'inbound_email', 'transaction', 'insights_query', 'organization');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS currencies (
    code        CHAR(3) PRIMARY KEY,
    name        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    decimals    SMALLINT NOT NULL DEFAULT 2,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT currencies_code_iso CHECK (code ~ '^[A-Z]{3}$'),
    CONSTRAINT currencies_decimals_range CHECK (decimals BETWEEN 0 AND 6)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'currencies_set_updated_at') THEN
        CREATE TRIGGER currencies_set_updated_at
        BEFORE UPDATE ON currencies
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS fx_rates (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base      CHAR(3) NOT NULL,
    quote     CHAR(3) NOT NULL,
    rate      NUMERIC(20, 10) NOT NULL,
    as_of     DATE NOT NULL,
    source    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fx_rates_base_iso  CHECK (base  ~ '^[A-Z]{3}$'),
    CONSTRAINT fx_rates_quote_iso CHECK (quote ~ '^[A-Z]{3}$'),
    CONSTRAINT fx_rates_distinct  CHECK (base <> quote),
    CONSTRAINT fx_rates_positive  CHECK (rate > 0),
    UNIQUE (base, quote, as_of)
);

CREATE INDEX IF NOT EXISTS fx_rates_lookup_idx ON fx_rates (base, quote, as_of DESC);

CREATE TABLE IF NOT EXISTS translations (
    resource_type TEXT NOT NULL,
    resource_id   UUID NOT NULL,
    locale        TEXT NOT NULL,
    field         TEXT NOT NULL,
    value         TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (resource_type, resource_id, locale, field)
);

CREATE INDEX IF NOT EXISTS translations_resource_idx ON translations (resource_type, resource_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'translations_set_updated_at') THEN
        CREATE TRIGGER translations_set_updated_at
        BEFORE UPDATE ON translations
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- API permissions catalogue (system-seeded, global)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_permissions (
    code        TEXT PRIMARY KEY,
    resource    TEXT NOT NULL,
    action      TEXT NOT NULL,
    description TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT api_permissions_code_format
        CHECK (code ~ '^[a-z_][a-z0-9_]*:(read|write|delete|admin)$'),
    CONSTRAINT api_permissions_action_valid
        CHECK (action IN ('read', 'write', 'delete', 'admin'))
);

CREATE INDEX IF NOT EXISTS api_permissions_resource_idx ON api_permissions (resource);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'api_permissions_set_updated_at') THEN
        CREATE TRIGGER api_permissions_set_updated_at
        BEFORE UPDATE ON api_permissions
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email             CITEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    full_name         TEXT,
    avatar_url        TEXT,
    locale            TEXT NOT NULL DEFAULT 'en',
    timezone          TEXT,
    email_verified_at TIMESTAMPTZ,
    last_login_at     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_set_updated_at') THEN
        CREATE TRIGGER users_set_updated_at
        BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Organizations and per-kind profiles
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                organization_kind NOT NULL,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL UNIQUE,
    rx_local_part       TEXT NOT NULL UNIQUE,
    country             CHAR(2),
    currency            CHAR(3) NOT NULL DEFAULT 'ZAR',
    locale              TEXT NOT NULL DEFAULT 'en',
    timezone            TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
    financial_lock_date DATE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organizations_slug_format
        CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
    CONSTRAINT organizations_rx_format
        CHECK (rx_local_part ~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$'),
    CONSTRAINT organizations_currency_iso
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT organizations_country_iso
        CHECK (country IS NULL OR country ~ '^[A-Z]{2}$')
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'organizations_set_updated_at') THEN
        CREATE TRIGGER organizations_set_updated_at
        BEFORE UPDATE ON organizations
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS personal_profiles (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    full_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'personal_profiles_set_updated_at') THEN
        CREATE TRIGGER personal_profiles_set_updated_at
        BEFORE UPDATE ON personal_profiles
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS business_profiles (
    organization_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    legal_name               TEXT NOT NULL,
    registration_number      TEXT,
    tax_number               TEXT,
    industry                 TEXT,
    website                  TEXT,
    address_line1            TEXT,
    address_line2            TEXT,
    city                     TEXT,
    region                   TEXT,
    postal_code              TEXT,
    fiscal_year_start_month  SMALLINT NOT NULL DEFAULT 3,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT business_profiles_fiscal_month
        CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'business_profiles_set_updated_at') THEN
        CREATE TRIGGER business_profiles_set_updated_at
        BEFORE UPDATE ON business_profiles
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- Profile rows must match their org's kind.
CREATE OR REPLACE FUNCTION enforce_profile_kind() RETURNS TRIGGER AS $$
DECLARE
    expected organization_kind;
    org_kind organization_kind;
BEGIN
    expected := TG_ARGV[0]::organization_kind;
    SELECT kind INTO org_kind FROM organizations WHERE id = NEW.organization_id;
    IF org_kind IS NULL THEN
        RAISE EXCEPTION 'organization % does not exist', NEW.organization_id;
    END IF;
    IF org_kind <> expected THEN
        RAISE EXCEPTION 'profile kind % does not match organization kind %', expected, org_kind;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'personal_profiles_enforce_kind') THEN
        CREATE TRIGGER personal_profiles_enforce_kind
        BEFORE INSERT OR UPDATE ON personal_profiles
        FOR EACH ROW EXECUTE FUNCTION enforce_profile_kind('personal');
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'business_profiles_enforce_kind') THEN
        CREATE TRIGGER business_profiles_enforce_kind
        BEFORE INSERT OR UPDATE ON business_profiles
        FOR EACH ROW EXECUTE FUNCTION enforce_profile_kind('business');
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Memberships and invitations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memberships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            membership_role NOT NULL DEFAULT 'member',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_org_idx  ON memberships (organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_owner_unique ON memberships (organization_id) WHERE role = 'owner';

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memberships_set_updated_at') THEN
        CREATE TRIGGER memberships_set_updated_at
        BEFORE UPDATE ON memberships
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email           CITEXT NOT NULL,
    role            membership_role NOT NULL DEFAULT 'member',
    token_hash      TEXT NOT NULL UNIQUE,
    invited_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_at     TIMESTAMPTZ,
    accepted_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT invitations_no_owner_role CHECK (role <> 'owner')
);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_unique
    ON invitations (organization_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (email);
CREATE INDEX IF NOT EXISTS invitations_org_idx   ON invitations (organization_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invitations_set_updated_at') THEN
        CREATE TRIGGER invitations_set_updated_at
        BEFORE UPDATE ON invitations
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Authorizations: programmatic API tokens, OAuth grants for connected apps
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_tokens (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    name                  TEXT NOT NULL,
    kind                  api_token_kind NOT NULL DEFAULT 'live',
    token_hash            TEXT NOT NULL UNIQUE,
    token_prefix          TEXT NOT NULL,
    scopes                JSONB NOT NULL DEFAULT '[]'::jsonb,
    allowed_ip_cidrs      TEXT[],
    rate_limit_per_minute INTEGER,
    last_used_at          TIMESTAMPTZ,
    last_used_ip          INET,
    expires_at            TIMESTAMPTZ,
    revoked_at            TIMESTAMPTZ,
    revoked_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT api_tokens_scopes_array
        CHECK (jsonb_typeof(scopes) = 'array'),
    CONSTRAINT api_tokens_rate_limit_pos
        CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0)
);

CREATE INDEX IF NOT EXISTS api_tokens_org_idx       ON api_tokens (organization_id);
CREATE INDEX IF NOT EXISTS api_tokens_active_idx    ON api_tokens (organization_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_tokens_prefix_idx    ON api_tokens (token_prefix);
CREATE INDEX IF NOT EXISTS api_tokens_kind_idx      ON api_tokens (organization_id, kind) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS api_tokens_scopes_gin    ON api_tokens USING gin (scopes);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'api_tokens_set_updated_at') THEN
        CREATE TRIGGER api_tokens_set_updated_at
        BEFORE UPDATE ON api_tokens
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS oauth_grants (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
    provider                oauth_provider NOT NULL,
    account_email           CITEXT,
    access_token_encrypted  BYTEA,
    refresh_token_encrypted BYTEA,
    token_type              TEXT,
    scopes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    expires_at              TIMESTAMPTZ,
    revoked_at              TIMESTAMPTZ,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, provider, account_email)
);

CREATE INDEX IF NOT EXISTS oauth_grants_org_provider_idx ON oauth_grants (organization_id, provider);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'oauth_grants_set_updated_at') THEN
        CREATE TRIGGER oauth_grants_set_updated_at
        BEFORE UPDATE ON oauth_grants
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- AI models and run log
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_models (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider      TEXT NOT NULL,
    model_id      TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    kind          ai_model_kind NOT NULL,
    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    retired_at    TIMESTAMPTZ,
    config        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, model_id, kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_models_default_per_kind_idx
    ON ai_models (kind)
    WHERE is_default AND is_active;

CREATE INDEX IF NOT EXISTS ai_models_kind_active_idx ON ai_models (kind, is_active);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ai_models_set_updated_at') THEN
        CREATE TRIGGER ai_models_set_updated_at
        BEFORE UPDATE ON ai_models
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS ai_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID,
    model_id        UUID NOT NULL REFERENCES ai_models(id) ON DELETE RESTRICT,
    target_type     ai_target_type NOT NULL,
    target_id       UUID,
    status          ai_run_status NOT NULL DEFAULT 'queued',
    triggered_by    UUID,
    input_tokens    BIGINT,
    output_tokens   BIGINT,
    latency_ms      INTEGER,
    cost_usd        NUMERIC(12, 6),
    request_payload JSONB,
    response_payload JSONB,
    error           TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_runs_org_created_idx    ON ai_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_target_idx         ON ai_runs (target_type, target_id);
CREATE INDEX IF NOT EXISTS ai_runs_model_idx          ON ai_runs (model_id);
CREATE INDEX IF NOT EXISTS ai_runs_status_idx         ON ai_runs (status) WHERE status IN ('queued', 'running', 'failed');

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ai_runs_set_updated_at') THEN
        CREATE TRIGGER ai_runs_set_updated_at
        BEFORE UPDATE ON ai_runs
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- RLS for foundation tables
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
    org_scoped TEXT[] := ARRAY[
        'personal_profiles',
        'business_profiles',
        'invitations',
        'api_tokens',
        'oauth_grants'
    ];
BEGIN
    FOREACH t IN ARRAY org_scoped LOOP
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

-- Organizations: visible when current org matches OR when current user is a member.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'organizations' AND policyname = 'organizations_access'
    ) THEN
        CREATE POLICY organizations_access ON organizations
            USING (
                id = app_current_organization_id()
                OR id IN (
                    SELECT organization_id FROM memberships
                    WHERE user_id = app_current_user_id()
                )
            )
            WITH CHECK (id = app_current_organization_id());
    END IF;
END $$;

-- Memberships: visible when current org matches OR row belongs to current user.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'memberships' AND policyname = 'memberships_access'
    ) THEN
        CREATE POLICY memberships_access ON memberships
            USING (
                organization_id = app_current_organization_id()
                OR user_id = app_current_user_id()
            )
            WITH CHECK (organization_id = app_current_organization_id());
    END IF;
END $$;

-- ai_runs: optional org_id (system-wide runs allowed).
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'ai_runs' AND policyname = 'ai_runs_access'
    ) THEN
        CREATE POLICY ai_runs_access ON ai_runs
            USING (
                organization_id IS NULL
                OR organization_id = app_current_organization_id()
            )
            WITH CHECK (
                organization_id IS NULL
                OR organization_id = app_current_organization_id()
            );
    END IF;
END $$;
