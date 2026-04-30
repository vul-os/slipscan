BEGIN;

CREATE TYPE transaction_status AS ENUM ('pending', 'verified', 'rejected');

CREATE TABLE transactions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    document_url     TEXT,
    merchant         TEXT,
    amount           NUMERIC(14, 2),
    currency         CHAR(3),
    transaction_date DATE,
    category         TEXT,
    raw_extraction   JSONB,
    notes            TEXT,
    status           transaction_status NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT transactions_currency_iso CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    CONSTRAINT transactions_amount_nonneg CHECK (amount IS NULL OR amount >= 0)
);

CREATE INDEX transactions_org_date_idx
    ON transactions (organization_id, transaction_date DESC NULLS LAST);
CREATE INDEX transactions_org_status_idx
    ON transactions (organization_id, status);
CREATE INDEX transactions_uploaded_by_idx
    ON transactions (uploaded_by);

CREATE TRIGGER transactions_set_updated_at
BEFORE UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
