-- Migration: 20260529000003_paystack_billing
-- Adds Paystack subscription columns to organizations.
-- Apply manually: psql $DATABASE_URL -f this_file.sql
-- Or via Neon console SQL editor.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan                      TEXT        NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS paystack_customer_code    TEXT,
  ADD COLUMN IF NOT EXISTS paystack_subscription_code TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status       TEXT        NOT NULL DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS subscription_renews_at    TIMESTAMPTZ;

-- Optional: add a check constraint so plan values stay valid.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organizations_plan_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_plan_check
      CHECK (plan IN ('free', 'team', 'business'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'organizations_subscription_status_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_subscription_status_check
      CHECK (subscription_status IN ('inactive', 'active', 'past_due', 'cancelled', 'paused'));
  END IF;
END
$$;
