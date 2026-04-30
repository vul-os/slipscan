BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TYPE membership_role AS ENUM ('admin', 'member');

CREATE TABLE users (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email             CITEXT NOT NULL UNIQUE,
    password_hash     TEXT NOT NULL,
    full_name         TEXT,
    avatar_url        TEXT,
    email_verified_at TIMESTAMPTZ,
    last_login_at     TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT organizations_slug_format
        CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
);

CREATE TRIGGER organizations_set_updated_at
BEFORE UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX invitations_pending_unique
    ON invitations (organization_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invitations_email_idx ON invitations (email);
CREATE INDEX invitations_org_idx   ON invitations (organization_id);

CREATE TRIGGER invitations_set_updated_at
BEFORE UPDATE ON invitations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
