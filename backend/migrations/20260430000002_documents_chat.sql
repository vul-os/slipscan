-- =============================================================================
-- Migration 2/4: Documents and conversational layer
--
-- Document ingestion (upload + email) plus the AI extraction trail, then the
-- chat / WhatsApp / dashboards / queries machinery that depends on it.
--
-- Documents come from upload, inbound email, or API. Each document can be
-- run through one or more `ai_models` (foundation) — every run records a
-- `document_extractions` row; `documents.current_extraction_id` is the
-- denormalized pointer to the active one (no FK, since
-- document_extractions.document_id already FKs back; the app keeps the
-- pointer in sync). Reruns against a different model are first-class.
--
-- Chats are conversation threads on web/whatsapp/api. The LLM has tool
-- access to the org's data and can author/edit dashboards and queries.
-- Dashboards (HTML) and queries (SQL) are independently versioned but
-- pinned together via `dashboard_version_queries`, so every dashboard
-- version is reproducible.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

CREATE TYPE document_source          AS ENUM ('upload', 'email', 'api');
CREATE TYPE document_kind            AS ENUM ('slip', 'invoice', 'bank_statement', 'unknown');
CREATE TYPE document_status          AS ENUM ('pending', 'processing', 'extracted', 'failed');
CREATE TYPE inbound_email_status     AS ENUM ('received', 'processed', 'rejected', 'failed');

CREATE TYPE chat_channel             AS ENUM ('web', 'whatsapp', 'api');
CREATE TYPE chat_status              AS ENUM ('active', 'archived');
CREATE TYPE chat_message_role        AS ENUM ('user', 'assistant', 'system', 'tool');
CREATE TYPE whatsapp_session_status  AS ENUM ('pending', 'verified', 'revoked', 'blocked');

CREATE TYPE query_kind               AS ENUM ('sql', 'aggregate');
CREATE TYPE query_run_status         AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- -----------------------------------------------------------------------------
-- Inbound emails (defined first so documents can FK to it inline)
-- -----------------------------------------------------------------------------

CREATE TABLE inbound_emails (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       UUID REFERENCES organizations(id) ON DELETE SET NULL,
    message_id            TEXT NOT NULL UNIQUE,
    from_address          CITEXT NOT NULL,
    recipient_local_part  TEXT NOT NULL,
    recipient_domain      TEXT NOT NULL,
    subject               TEXT,
    received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_by_vm        TEXT,
    raw_storage_url       TEXT,
    size_bytes            BIGINT,
    status                inbound_email_status NOT NULL DEFAULT 'received',
    processed_at          TIMESTAMPTZ,
    error                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inbound_emails_org_received_idx
    ON inbound_emails (organization_id, received_at DESC);
CREATE INDEX inbound_emails_status_idx
    ON inbound_emails (status)
    WHERE status IN ('received', 'failed');

CREATE TRIGGER inbound_emails_set_updated_at
BEFORE UPDATE ON inbound_emails
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Documents
--
-- `current_extraction_id` is a denormalized UUID (no FK). The reverse FK
-- `document_extractions.document_id → documents` already enforces existence
-- at the row level; the app maintains the pointer.
-- -----------------------------------------------------------------------------

CREATE TABLE documents (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    inbound_email_id         UUID REFERENCES inbound_emails(id) ON DELETE SET NULL,
    source                   document_source NOT NULL,
    kind                     document_kind NOT NULL DEFAULT 'unknown',
    storage_url              TEXT NOT NULL,
    mime_type                TEXT,
    size_bytes               BIGINT,
    original_name            TEXT,
    status                   document_status NOT NULL DEFAULT 'pending',
    current_extraction_id    UUID,
    error                    TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX documents_org_created_idx ON documents (organization_id, created_at DESC);
CREATE INDEX documents_org_status_idx  ON documents (organization_id, status);
CREATE INDEX documents_inbound_idx     ON documents (inbound_email_id);

CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Document extractions: one row per (document, model run). `is_current` plus
-- `documents.current_extraction_id` mark the active result. Old rows kept.
CREATE TABLE document_extractions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    ai_run_id       UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    model_id        UUID REFERENCES ai_models(id) ON DELETE SET NULL,
    status          document_status NOT NULL DEFAULT 'pending',
    raw             JSONB,
    extracted       JSONB,
    error           TEXT,
    is_current      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX document_extractions_doc_idx     ON document_extractions (document_id, created_at DESC);
CREATE INDEX document_extractions_org_idx     ON document_extractions (organization_id, created_at DESC);
CREATE INDEX document_extractions_model_idx   ON document_extractions (model_id);
CREATE UNIQUE INDEX document_extractions_current_unique
    ON document_extractions (document_id) WHERE is_current;

CREATE TRIGGER document_extractions_set_updated_at
BEFORE UPDATE ON document_extractions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- WhatsApp sessions, chats, chat messages
-- -----------------------------------------------------------------------------

CREATE TABLE whatsapp_sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id   UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    phone_number      TEXT NOT NULL,
    status            whatsapp_session_status NOT NULL DEFAULT 'pending',
    verification_code TEXT,
    verified_at       TIMESTAMPTZ,
    opted_in_at       TIMESTAMPTZ,
    last_message_at   TIMESTAMPTZ,
    revoked_at        TIMESTAMPTZ,
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, phone_number)
);

CREATE UNIQUE INDEX whatsapp_sessions_phone_active
    ON whatsapp_sessions (phone_number)
    WHERE status = 'verified';

CREATE INDEX whatsapp_sessions_org_idx ON whatsapp_sessions (organization_id);

CREATE TRIGGER whatsapp_sessions_set_updated_at
BEFORE UPDATE ON whatsapp_sessions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE chats (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    channel             chat_channel NOT NULL DEFAULT 'web',
    title               TEXT,
    status              chat_status NOT NULL DEFAULT 'active',
    started_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    whatsapp_session_id UUID REFERENCES whatsapp_sessions(id) ON DELETE SET NULL,
    last_message_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chats_org_recent_idx
    ON chats (organization_id, last_message_at DESC NULLS LAST);
CREATE INDEX chats_org_status_idx
    ON chats (organization_id, status);
CREATE INDEX chats_user_idx
    ON chats (started_by_user_id, last_message_at DESC NULLS LAST);

CREATE TRIGGER chats_set_updated_at
BEFORE UPDATE ON chats
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE chat_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id             UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role                chat_message_role NOT NULL,
    content             TEXT,
    content_blocks      JSONB,
    tool_calls          JSONB,
    tool_results        JSONB,
    ai_run_id           UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    sender_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    sender_phone        TEXT,
    whatsapp_message_id TEXT,
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX chat_messages_chat_idx
    ON chat_messages (chat_id, created_at);
CREATE INDEX chat_messages_org_created_idx
    ON chat_messages (organization_id, created_at DESC);
CREATE UNIQUE INDEX chat_messages_whatsapp_unique
    ON chat_messages (whatsapp_message_id)
    WHERE whatsapp_message_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Queries (saved + versioned)
--
-- A `query` is a named, parameterised, read-only data source. Each save
-- creates an immutable `query_version` row. The Go runtime is responsible
-- for safe execution: SELECT-only, RLS-scoped, statement timeout, row cap.
-- `current_version_id` is a denormalized UUID (no FK, the reverse FK on
-- `query_versions.query_id` already enforces existence).
-- -----------------------------------------------------------------------------

CREATE TABLE queries (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug                 TEXT NOT NULL,
    name                 TEXT NOT NULL,
    description          TEXT,
    kind                 query_kind NOT NULL DEFAULT 'sql',
    current_version_id   UUID,
    is_archived          BOOLEAN NOT NULL DEFAULT FALSE,
    created_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug)
);

CREATE INDEX queries_org_idx ON queries (organization_id) WHERE NOT is_archived;

CREATE TRIGGER queries_set_updated_at
BEFORE UPDATE ON queries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE query_versions (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_id                 UUID NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
    organization_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_version_id        UUID REFERENCES query_versions(id) ON DELETE SET NULL,
    version_number           INTEGER NOT NULL,
    sql_text                 TEXT,
    params_schema            JSONB NOT NULL DEFAULT '{}'::jsonb,
    result_schema            JSONB,
    safe_validated_at        TIMESTAMPTZ,
    safety_notes             TEXT,
    change_summary           TEXT,
    created_by_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_chat_id       UUID REFERENCES chats(id) ON DELETE SET NULL,
    created_by_chat_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    created_by_ai_run_id     UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (query_id, version_number)
);

CREATE INDEX query_versions_query_idx ON query_versions (query_id, version_number DESC);
CREATE INDEX query_versions_org_idx   ON query_versions (organization_id, created_at DESC);

CREATE TABLE query_runs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_version_id   UUID NOT NULL REFERENCES query_versions(id) ON DELETE CASCADE,
    organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    chat_id            UUID REFERENCES chats(id) ON DELETE SET NULL,
    chat_message_id    UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    triggered_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    params             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status             query_run_status NOT NULL DEFAULT 'queued',
    rows_returned      INTEGER,
    duration_ms        INTEGER,
    result_preview     JSONB,
    error              TEXT,
    started_at         TIMESTAMPTZ,
    finished_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX query_runs_org_created_idx ON query_runs (organization_id, created_at DESC);
CREATE INDEX query_runs_version_idx     ON query_runs (query_version_id, created_at DESC);
CREATE INDEX query_runs_chat_idx        ON query_runs (chat_id);

-- -----------------------------------------------------------------------------
-- Dashboards (HTML + linked queries, versioned together)
--
-- `current_version_id` is denormalized (no FK — reverse FK on
-- `dashboard_versions.dashboard_id` enforces existence).
-- -----------------------------------------------------------------------------

CREATE TABLE dashboards (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug               TEXT NOT NULL,
    name               TEXT NOT NULL,
    description        TEXT,
    current_version_id UUID,
    is_archived        BOOLEAN NOT NULL DEFAULT FALSE,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, slug)
);

CREATE INDEX dashboards_org_idx ON dashboards (organization_id) WHERE NOT is_archived;

CREATE TRIGGER dashboards_set_updated_at
BEFORE UPDATE ON dashboards
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE dashboard_versions (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id               UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    organization_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    parent_version_id          UUID REFERENCES dashboard_versions(id) ON DELETE SET NULL,
    version_number             INTEGER NOT NULL,
    html                       TEXT NOT NULL,
    layout                     JSONB NOT NULL DEFAULT '{}'::jsonb,
    change_summary             TEXT,
    created_by_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_chat_id         UUID REFERENCES chats(id) ON DELETE SET NULL,
    created_by_chat_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    created_by_ai_run_id       UUID REFERENCES ai_runs(id) ON DELETE SET NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dashboard_id, version_number)
);

CREATE INDEX dashboard_versions_dashboard_idx
    ON dashboard_versions (dashboard_id, version_number DESC);
CREATE INDEX dashboard_versions_org_idx
    ON dashboard_versions (organization_id, created_at DESC);

-- Pin specific query versions to specific dashboard versions, by binding key.
CREATE TABLE dashboard_version_queries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_version_id UUID NOT NULL REFERENCES dashboard_versions(id) ON DELETE CASCADE,
    query_version_id    UUID NOT NULL REFERENCES query_versions(id) ON DELETE RESTRICT,
    organization_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    binding_key         TEXT NOT NULL,
    default_params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (dashboard_version_id, binding_key)
);

CREATE INDEX dashboard_version_queries_qv_idx
    ON dashboard_version_queries (query_version_id);
CREATE INDEX dashboard_version_queries_org_idx
    ON dashboard_version_queries (organization_id);

-- -----------------------------------------------------------------------------
-- RLS for documents and conversational tables
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
    docs_chat_tables TEXT[] := ARRAY[
        'documents',
        'inbound_emails',
        'document_extractions',
        'whatsapp_sessions',
        'chats',
        'chat_messages',
        'queries',
        'query_versions',
        'query_runs',
        'dashboards',
        'dashboard_versions',
        'dashboard_version_queries'
    ];
BEGIN
    FOREACH t IN ARRAY docs_chat_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I '
            'USING (organization_id = app_current_organization_id()) '
            'WITH CHECK (organization_id = app_current_organization_id())',
            t || '_org_isolation', t
        );
    END LOOP;
END $$;
