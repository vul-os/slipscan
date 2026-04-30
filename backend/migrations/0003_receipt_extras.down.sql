BEGIN;

ALTER TABLE transactions
    DROP CONSTRAINT IF EXISTS transactions_tax_nonneg;

ALTER TABLE transactions
    DROP COLUMN IF EXISTS payment_method,
    DROP COLUMN IF EXISTS tax;

COMMIT;
