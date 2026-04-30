BEGIN;

ALTER TABLE transactions
    ADD COLUMN tax            NUMERIC(14, 2),
    ADD COLUMN payment_method TEXT;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_tax_nonneg CHECK (tax IS NULL OR tax >= 0);

COMMIT;
