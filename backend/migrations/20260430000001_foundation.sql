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

CREATE TYPE organization_kind AS ENUM ('personal', 'business');
CREATE TYPE membership_role   AS ENUM ('owner', 'admin', 'accountant', 'member', 'viewer');
CREATE TYPE oauth_provider    AS ENUM ('gmail', 'outlook', 'paystack', 'xero', 'google_drive');
CREATE TYPE api_token_kind    AS ENUM ('live', 'test', 'restricted');

CREATE TYPE ai_model_kind     AS ENUM ('ocr', 'extraction', 'classification', 'insights', 'embedding', 'normalization');
CREATE TYPE ai_run_status     AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE ai_target_type    AS ENUM ('document', 'inbound_email', 'transaction', 'insights_query', 'organization');

-- -----------------------------------------------------------------------------
-- Reference data
-- -----------------------------------------------------------------------------

CREATE TABLE currencies (
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

CREATE TRIGGER currencies_set_updated_at
BEFORE UPDATE ON currencies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE fx_rates (
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

CREATE INDEX fx_rates_lookup_idx ON fx_rates (base, quote, as_of DESC);

CREATE TABLE translations (
    resource_type TEXT NOT NULL,
    resource_id   UUID NOT NULL,
    locale        TEXT NOT NULL,
    field         TEXT NOT NULL,
    value         TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (resource_type, resource_id, locale, field)
);

CREATE INDEX translations_resource_idx ON translations (resource_type, resource_id);

CREATE TRIGGER translations_set_updated_at
BEFORE UPDATE ON translations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- API permissions catalogue (system-seeded, global)
--
-- Defines every scope an API token can hold. Codes are `<resource>:<action>`
-- where action is read / write / delete / admin. The app validates that
-- every code in `api_tokens.scopes` exists here. Examples:
--   transactions:read   documents:write   billing:admin   chats:write
-- -----------------------------------------------------------------------------

CREATE TABLE api_permissions (
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

CREATE INDEX api_permissions_resource_idx ON api_permissions (resource);

CREATE TRIGGER api_permissions_set_updated_at
BEFORE UPDATE ON api_permissions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------

CREATE TABLE users (
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

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Organizations and per-kind profiles
-- -----------------------------------------------------------------------------

CREATE TABLE organizations (
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

CREATE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE personal_profiles (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    full_name       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER personal_profiles_set_updated_at
BEFORE UPDATE ON personal_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_profiles (
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

CREATE TRIGGER business_profiles_set_updated_at
BEFORE UPDATE ON business_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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

CREATE TRIGGER personal_profiles_enforce_kind
BEFORE INSERT OR UPDATE ON personal_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_profile_kind('personal');

CREATE TRIGGER business_profiles_enforce_kind
BEFORE INSERT OR UPDATE ON business_profiles
FOR EACH ROW EXECUTE FUNCTION enforce_profile_kind('business');

-- -----------------------------------------------------------------------------
-- Memberships and invitations
--
-- Roles map to Xero/22Seven access tiers:
--   owner       — single per org. Billing, deletion, ownership transfer.
--   admin       — manage members + org settings. No billing.
--   accountant  — full financial ops, manual journals, lock-date overrides.
--   member      — day-to-day: upload, edit transactions, run reports.
--   viewer      — read-only.
-- -----------------------------------------------------------------------------

CREATE TABLE memberships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            membership_role NOT NULL DEFAULT 'member',
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_org_idx  ON memberships (organization_id);
CREATE UNIQUE INDEX memberships_owner_unique ON memberships (organization_id) WHERE role = 'owner';

CREATE TRIGGER memberships_set_updated_at
BEFORE UPDATE ON memberships
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invitations (
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

CREATE UNIQUE INDEX invitations_pending_unique
    ON invitations (organization_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invitations_email_idx ON invitations (email);
CREATE INDEX invitations_org_idx   ON invitations (organization_id);

CREATE TRIGGER invitations_set_updated_at
BEFORE UPDATE ON invitations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Authorizations: programmatic API tokens, OAuth grants for connected apps
-- -----------------------------------------------------------------------------

-- API tokens: per-org credentials with explicit scope grants. The `scopes`
-- JSONB column is an array of permission codes from `api_permissions`; the
-- app rejects any code not present in the catalogue. `kind` separates real
-- credentials from sandbox (`test`) and from narrow-purpose tokens
-- (`restricted`, used for one-off integrations with a tightly limited
-- scope set). `allowed_ip_cidrs` and `rate_limit_per_minute` are optional
-- per-token overrides — the app falls back to plan defaults when null.
CREATE TABLE api_tokens (
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

CREATE INDEX api_tokens_org_idx       ON api_tokens (organization_id);
CREATE INDEX api_tokens_active_idx    ON api_tokens (organization_id) WHERE revoked_at IS NULL;
CREATE INDEX api_tokens_prefix_idx    ON api_tokens (token_prefix);
CREATE INDEX api_tokens_kind_idx      ON api_tokens (organization_id, kind) WHERE revoked_at IS NULL;
CREATE INDEX api_tokens_scopes_gin    ON api_tokens USING gin (scopes);

CREATE TRIGGER api_tokens_set_updated_at
BEFORE UPDATE ON api_tokens
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE oauth_grants (
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

CREATE INDEX oauth_grants_org_provider_idx ON oauth_grants (organization_id, provider);

CREATE TRIGGER oauth_grants_set_updated_at
BEFORE UPDATE ON oauth_grants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- AI models and run log
--
-- `ai_models` is a global registry. `ai_runs` records every model invocation.
-- Reruns against a different model insert a new ai_run pointing at the same
-- target — old rows are preserved.
-- -----------------------------------------------------------------------------

CREATE TABLE ai_models (
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

CREATE UNIQUE INDEX ai_models_default_per_kind_idx
    ON ai_models (kind)
    WHERE is_default AND is_active;

CREATE INDEX ai_models_kind_active_idx ON ai_models (kind, is_active);

CREATE TRIGGER ai_models_set_updated_at
BEFORE UPDATE ON ai_models
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ai_runs (
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

CREATE INDEX ai_runs_org_created_idx    ON ai_runs (organization_id, created_at DESC);
CREATE INDEX ai_runs_target_idx         ON ai_runs (target_type, target_id);
CREATE INDEX ai_runs_model_idx          ON ai_runs (model_id);
CREATE INDEX ai_runs_status_idx         ON ai_runs (status) WHERE status IN ('queued', 'running', 'failed');

CREATE TRIGGER ai_runs_set_updated_at
BEFORE UPDATE ON ai_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
        EXECUTE format(
            'CREATE POLICY %I ON %I '
            'USING (organization_id = app_current_organization_id()) '
            'WITH CHECK (organization_id = app_current_organization_id())',
            t || '_org_isolation', t
        );
    END LOOP;
END $$;

-- Organizations: visible when current org matches OR when current user is a
-- member (so "list my orgs" still works).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_access ON organizations
    USING (
        id = app_current_organization_id()
        OR id IN (
            SELECT organization_id FROM memberships
            WHERE user_id = app_current_user_id()
        )
    )
    WITH CHECK (id = app_current_organization_id());

-- Memberships: visible when current org matches OR row belongs to current
-- user (lets a user list their own memberships across orgs).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_access ON memberships
    USING (
        organization_id = app_current_organization_id()
        OR user_id = app_current_user_id()
    )
    WITH CHECK (organization_id = app_current_organization_id());

-- ai_runs: optional org_id (system-wide runs allowed). Filter when present.
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_runs_access ON ai_runs
    USING (
        organization_id IS NULL
        OR organization_id = app_current_organization_id()
    )
    WITH CHECK (
        organization_id IS NULL
        OR organization_id = app_current_organization_id()
    );
