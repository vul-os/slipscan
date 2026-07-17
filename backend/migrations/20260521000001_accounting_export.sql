-- =============================================================================
-- Migration P2-05: Accounting export mapping table
--
-- Stores the idempotent external-ID mapping between our records and records
-- in third-party accounting systems (Xero, QuickBooks, etc.).
-- Allows re-push to update rather than duplicate.
--
-- Per-record sync status and errors are surfaced via the `sync_error` and
-- `last_synced_at` columns so the UI can show per-record sync health.
-- =============================================================================

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'accounting_provider') THEN
        CREATE TYPE accounting_provider AS ENUM ('xero', 'quickbooks');
    END IF;
END $$;

-- Maps our internal records (contact, transaction, bill) to their counterparts
-- in an external accounting system. One row per (org, provider, local record).
CREATE TABLE IF NOT EXISTS accounting_export_mappings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider            accounting_provider NOT NULL,
    -- The type of local record: 'contact' | 'transaction' | 'bill'
    local_type          TEXT NOT NULL,
    local_id            UUID NOT NULL,
    -- The ID assigned by the external provider after first push.
    external_id         TEXT NOT NULL,
    -- ISO-8601 timestamp of the last successful sync to the external system.
    last_synced_at      TIMESTAMPTZ,
    -- Non-null when the last push attempt failed; cleared on success.
    sync_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Enforce one mapping per (org, provider, local record) — re-push updates.
    UNIQUE (organization_id, provider, local_type, local_id),
    CONSTRAINT accounting_export_mappings_local_type_check
        CHECK (local_type IN ('contact', 'transaction', 'bill'))
);

CREATE INDEX IF NOT EXISTS accounting_export_mappings_org_provider_idx
    ON accounting_export_mappings (organization_id, provider);
CREATE INDEX IF NOT EXISTS accounting_export_mappings_local_idx
    ON accounting_export_mappings (local_type, local_id);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'accounting_export_mappings_set_updated_at') THEN
        CREATE TRIGGER accounting_export_mappings_set_updated_at
        BEFORE UPDATE ON accounting_export_mappings
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- RLS: scoped to the owning org.
ALTER TABLE accounting_export_mappings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'accounting_export_mappings'
          AND policyname = 'accounting_export_mappings_org_isolation'
    ) THEN
        CREATE POLICY accounting_export_mappings_org_isolation
            ON accounting_export_mappings
            USING (organization_id = app_current_organization_id())
            WITH CHECK (organization_id = app_current_organization_id());
    END IF;
END $$;
