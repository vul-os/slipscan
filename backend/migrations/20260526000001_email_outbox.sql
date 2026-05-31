-- =============================================================================
-- Email outbox — durable send queue backed by Postgres.
--
-- The outbox pattern ensures every transactional email is persisted before the
-- HTTP response is returned to the caller. A background worker polls
-- email_outbox for due rows, delivers them via Amazon SES, and marks them sent
-- (or schedules a retry on transient failures up to max_attempts).
--
-- email_suppressions holds hard-bounce / complaint / manual suppression records
-- so the worker never attempts to send to a known-bad address. The SES bounce
-- webhook (a later phase) will insert rows here automatically.
--
-- citext extension is already enabled by the foundation migration.
-- =============================================================================

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'email_status') THEN
        CREATE TYPE email_status AS ENUM ('pending', 'sending', 'sent', 'failed', 'dead');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS email_outbox (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    to_address          CITEXT NOT NULL,
    from_address        TEXT NOT NULL,
    subject             TEXT NOT NULL,
    html_body           TEXT,
    text_body           TEXT,
    email_kind          TEXT NOT NULL,
    organization_id     UUID REFERENCES organizations(id) ON DELETE SET NULL,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key     TEXT UNIQUE,
    status              email_status NOT NULL DEFAULT 'pending',
    attempts            INT NOT NULL DEFAULT 0,
    max_attempts        INT NOT NULL DEFAULT 6,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error          TEXT,
    provider_message_id TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at             TIMESTAMPTZ
);

-- Partial index covering only the rows the worker polls.
CREATE INDEX IF NOT EXISTS email_outbox_due_idx
    ON email_outbox (next_attempt_at)
    WHERE status IN ('pending', 'failed');

-- Keep updated_at current on every write.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'set_email_outbox_updated_at') THEN
        CREATE TRIGGER set_email_outbox_updated_at
            BEFORE UPDATE ON email_outbox
            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    END IF;
END $$;

-- Hard-bounce / complaint / manual suppression list.
-- Rows here prevent the worker from attempting delivery to the address.
CREATE TABLE IF NOT EXISTS email_suppressions (
    address    CITEXT PRIMARY KEY,
    reason     TEXT NOT NULL,   -- 'bounce' | 'complaint' | 'manual'
    detail     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
