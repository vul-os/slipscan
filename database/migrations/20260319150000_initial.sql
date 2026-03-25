-- up

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- UTILITY
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- 1. PROFILES (auth)
-- ============================================================================

CREATE TABLE profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT,
  google_id     TEXT UNIQUE,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 2. WORKSPACES (households, businesses, etc.)
-- ============================================================================

CREATE TYPE workspace_type AS ENUM ('household', 'business');
CREATE TYPE member_role AS ENUM ('owner', 'admin', 'member', 'viewer');

CREATE TABLE workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  type       workspace_type NOT NULL DEFAULT 'household',
  currency   TEXT NOT NULL DEFAULT 'ZAR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role         member_role NOT NULL DEFAULT 'member',
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, profile_id)
);

-- ============================================================================
-- 3. IMAGES (GCS)
-- ============================================================================

CREATE TABLE images (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by  UUID NOT NULL REFERENCES profiles(id),
  bucket       TEXT NOT NULL,
  object_name  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 4. DOCUMENTS & LINE ITEMS
-- ============================================================================

CREATE TYPE document_type AS ENUM ('invoice', 'receipt', 'bank_statement', 'quote');
CREATE TYPE document_status AS ENUM ('pending', 'processing', 'categorized', 'reviewed', 'failed');

CREATE TABLE documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  image_id      UUID REFERENCES images(id),
  type          document_type NOT NULL,
  status        document_status NOT NULL DEFAULT 'pending',
  vendor        TEXT,
  reference     TEXT,
  issued_at     DATE,
  due_at        DATE,
  currency      TEXT NOT NULL DEFAULT 'ZAR',
  exchange_rate NUMERIC(18,8),
  subtotal      NUMERIC(18,2),
  tax           NUMERIC(18,2),
  total         NUMERIC(18,2),
  notes         TEXT,
  raw_text      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER documents_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES categories(id),
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  depth        INT NOT NULL DEFAULT 0,
  color        TEXT,
  icon         TEXT,
  is_system    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE categories IS
  'Hierarchical categories. depth 0=top, 1=sub, 2=sub-sub, 3=item-level. '
  'is_system=true + workspace_id IS NULL = global defaults. Users add custom via workspace_id.';

CREATE UNIQUE INDEX idx_categories_workspace_name ON categories (workspace_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX idx_categories_system_slug ON categories (slug) WHERE is_system = true;
CREATE INDEX idx_categories_parent ON categories (parent_id);
CREATE INDEX idx_categories_workspace ON categories (workspace_id);

CREATE TABLE line_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  description TEXT,
  quantity    NUMERIC(18,4),
  unit_price  NUMERIC(18,2),
  amount      NUMERIC(18,2) NOT NULL,
  category_id UUID REFERENCES categories(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 4b. LINE ITEM LINKS (reconciliation: statement ↔ invoice/receipt)
-- ============================================================================

CREATE TABLE line_item_links (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_line_item_id UUID NOT NULL REFERENCES line_items(id) ON DELETE CASCADE,
  document_id            UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  invoice_line_item_id   UUID REFERENCES line_items(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE line_item_links IS
  'Links a bank statement line item to its source document (invoice/receipt). '
  'If invoice_line_item_id is set, it links to a specific line; otherwise the whole document.';

CREATE INDEX idx_line_item_links_statement ON line_item_links(statement_line_item_id);
CREATE INDEX idx_line_item_links_document ON line_item_links(document_id);
CREATE UNIQUE INDEX uq_line_item_links ON line_item_links(statement_line_item_id, document_id, invoice_line_item_id);

-- ============================================================================
-- 5. EXCHANGE RATES
-- ============================================================================

CREATE TABLE exchange_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency  TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate           NUMERIC(18,8) NOT NULL,
  rate_date      DATE NOT NULL,
  source         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (base_currency, quote_currency, rate_date)
);

CREATE INDEX idx_exchange_rates_date ON exchange_rates (rate_date DESC);

-- ============================================================================
-- 6. CATEGORIZATION QUEUE (LLM jobs)
-- ============================================================================

CREATE TYPE job_status AS ENUM ('queued', 'processing', 'completed', 'failed', 'cancelled');

CREATE TABLE categorization_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status       job_status NOT NULL DEFAULT 'queued',
  priority     INT NOT NULL DEFAULT 0,
  attempts     INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  result       JSONB,
  error        TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_status_priority ON categorization_jobs (status, priority DESC, scheduled_at ASC)
  WHERE status = 'queued';

-- ============================================================================
-- 7. BILLING TIERS (base plans)
-- ============================================================================

CREATE TABLE billing_tiers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE,
  slug               TEXT NOT NULL UNIQUE,
  description        TEXT,
  price_cents        INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  interval           TEXT NOT NULL DEFAULT 'monthly',
  paystack_plan_code TEXT UNIQUE,
  features           JSONB NOT NULL DEFAULT '{}',
  is_active          BOOLEAN NOT NULL DEFAULT true,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_tiers IS
  'Base pricing tiers. price_cents in smallest unit (4999 = R49.99). Free tier has price_cents=0 and no Paystack plan.';

INSERT INTO billing_tiers (name, slug, description, price_cents, sort_order, features)
VALUES
  ('Free',  'free',  'Get started at no cost',        0,     1,
   '{"priority_queue": false, "multi_currency": false, "export_csv": true, "export_pdf": false, "api_access": false}'::JSONB),
  ('Basic', 'basic', 'For growing households',         4999,  2,
   '{"priority_queue": false, "multi_currency": true, "export_csv": true, "export_pdf": true, "api_access": false}'::JSONB),
  ('Pro',   'pro',   'Full power for businesses',      14999, 3,
   '{"priority_queue": true, "multi_currency": true, "export_csv": true, "export_pdf": true, "api_access": true}'::JSONB);

CREATE TRIGGER billing_tiers_updated_at
  BEFORE UPDATE ON billing_tiers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 8. BILLING ADD-ONS (purchasable quota boosts)
-- ============================================================================

CREATE TABLE billing_addons (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  description        TEXT,
  quota_key          TEXT NOT NULL,
  amount             BIGINT NOT NULL,
  price_cents        INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  interval           TEXT NOT NULL DEFAULT 'monthly'
    CHECK (interval IN ('monthly', 'once')),
  paystack_plan_code TEXT UNIQUE,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_addons IS
  'Purchasable add-on packs that boost a specific quota_key by amount. '
  'interval=monthly for recurring, interval=once for permanent.';

INSERT INTO billing_addons (name, slug, description, quota_key, amount, price_cents, interval, sort_order)
VALUES
  ('Extra 50 Scans',            'scans-50',        '+50 document scans per month',
   'scans_monthly',             50,    1999, 'monthly', 1),
  ('Extra 200 Scans',           'scans-200',       '+200 document scans per month',
   'scans_monthly',             200,   4999, 'monthly', 2),
  ('Extra 100 Categorizations', 'categorize-100',  '+100 LLM categorizations per month',
   'categorizations_monthly',   100,   2999, 'monthly', 3),
  ('Extra 500 Categorizations', 'categorize-500',  '+500 LLM categorizations per month',
   'categorizations_monthly',   500,   9999, 'monthly', 4),
  ('Extra 5 GB Storage',        'storage-5gb',     '+5 GB document storage',
   'storage_mb',                5120,  2999, 'once',    5),
  ('Extra 5 Members',           'members-5',       '+5 workspace members',
   'members',                   5,     1999, 'monthly', 6);

CREATE TRIGGER billing_addons_updated_at
  BEFORE UPDATE ON billing_addons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 9. WORKSPACE ADD-ONS (purchased instances per workspace)
-- ============================================================================

CREATE TABLE billing_workspace_addons (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  addon_id                   UUID NOT NULL REFERENCES billing_addons(id) ON DELETE RESTRICT,
  quantity                   INTEGER NOT NULL DEFAULT 1,
  status                     TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'expired')),
  paystack_subscription_code TEXT,
  current_period_start       TIMESTAMPTZ,
  current_period_end         TIMESTAMPTZ,
  cancelled_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_workspace_addons IS
  'Tracks which add-on packs a workspace has purchased. quantity allows buying multiples.';

CREATE INDEX idx_workspace_addons_ws ON billing_workspace_addons(workspace_id);
CREATE INDEX idx_workspace_addons_active ON billing_workspace_addons(workspace_id)
  WHERE status = 'active';

CREATE TRIGGER billing_workspace_addons_updated_at
  BEFORE UPDATE ON billing_workspace_addons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 10. BILLING AUTHORIZATIONS (Paystack card tokens)
-- ============================================================================

CREATE TABLE billing_authorizations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  paystack_authorization_code TEXT NOT NULL UNIQUE,
  paystack_customer_code      TEXT NOT NULL,
  email                       TEXT NOT NULL,
  card_type                   TEXT,
  last4                       TEXT,
  exp_month                   TEXT,
  exp_year                    TEXT,
  bank                        TEXT,
  brand                       TEXT,
  reusable                    BOOLEAN NOT NULL DEFAULT false,
  is_default                  BOOLEAN NOT NULL DEFAULT false,
  is_active                   BOOLEAN NOT NULL DEFAULT true,
  deleted_at                  TIMESTAMPTZ,
  delete_reason               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_authorizations IS 'Paystack card authorizations for recurring charges.';

CREATE INDEX idx_billing_auth_ws ON billing_authorizations(workspace_id);
CREATE INDEX idx_billing_auth_default ON billing_authorizations(workspace_id)
  WHERE is_default = true AND is_active = true AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_billing_auth_single_default ON billing_authorizations(workspace_id)
  WHERE is_default = true AND is_active = true AND deleted_at IS NULL;

CREATE TRIGGER billing_authorizations_updated_at
  BEFORE UPDATE ON billing_authorizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Ensure only one default card per workspace
CREATE OR REPLACE FUNCTION billing_unset_other_default_auths()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_default = true THEN
    UPDATE billing_authorizations
    SET is_default = false
    WHERE workspace_id = NEW.workspace_id
      AND id != NEW.id
      AND is_active = true
      AND deleted_at IS NULL
      AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_auth_default_toggle
  AFTER INSERT OR UPDATE OF is_default ON billing_authorizations
  FOR EACH ROW EXECUTE FUNCTION billing_unset_other_default_auths();

-- ============================================================================
-- 11. BILLING SUBSCRIPTIONS (links workspace to tier)
-- ============================================================================

CREATE TYPE subscription_status AS ENUM ('active', 'past_due', 'cancelled');

CREATE TABLE billing_subscriptions (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tier_id                    UUID NOT NULL REFERENCES billing_tiers(id) ON DELETE RESTRICT,
  authorization_id           UUID REFERENCES billing_authorizations(id) ON DELETE SET NULL,
  status                     subscription_status NOT NULL DEFAULT 'active',
  paystack_subscription_code TEXT UNIQUE,
  paystack_email_token       TEXT,
  current_period_start       TIMESTAMPTZ,
  current_period_end         TIMESTAMPTZ,
  cancel_at_period_end       BOOLEAN NOT NULL DEFAULT false,
  cancelled_at               TIMESTAMPTZ,
  failed_payment_count       INTEGER NOT NULL DEFAULT 0,
  last_payment_failed_at     TIMESTAMPTZ,
  outstanding_amount_cents   INTEGER NOT NULL DEFAULT 0,
  downgraded_at              TIMESTAMPTZ,
  downgrade_reason           TEXT,
  metadata                   JSONB NOT NULL DEFAULT '{}',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_subscriptions IS
  'Links a workspace to a base billing tier. Free tier workspaces get an active subscription with no Paystack code.';
COMMENT ON COLUMN billing_subscriptions.failed_payment_count IS
  'Consecutive failed charge attempts. Reset to 0 on successful payment. At 3 the cron downgrades the plan.';

CREATE INDEX idx_billing_sub_ws ON billing_subscriptions(workspace_id);
CREATE INDEX idx_billing_sub_status ON billing_subscriptions(status);

CREATE TRIGGER billing_subscriptions_updated_at
  BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 12. BILLING INVOICES
-- ============================================================================

CREATE TYPE invoice_status AS ENUM ('issued', 'paid', 'overdue', 'void');

CREATE TABLE billing_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id    UUID REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  invoice_number     TEXT NOT NULL UNIQUE,
  status             invoice_status NOT NULL DEFAULT 'issued',
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  subtotal_cents     INTEGER NOT NULL DEFAULT 0,
  tax_cents          INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL DEFAULT 0,
  due_at             TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  pdf_bucket         TEXT,
  pdf_object_name    TEXT,
  recipient_email    TEXT,
  recipient_name     TEXT,
  workspace_snapshot JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_invoice_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1,
  unit_amount_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents  INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_invoices_ws ON billing_invoices(workspace_id, created_at DESC);
CREATE INDEX idx_billing_invoices_status ON billing_invoices(workspace_id, status);
CREATE INDEX idx_billing_invoice_items_inv ON billing_invoice_items(invoice_id);

CREATE TRIGGER billing_invoices_updated_at
  BEFORE UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 13. BILLING TRANSACTIONS (payment history)
-- ============================================================================

CREATE TYPE transaction_status AS ENUM ('success', 'failed', 'pending');

CREATE TABLE billing_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id    UUID REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  invoice_id         UUID REFERENCES billing_invoices(id) ON DELETE SET NULL,
  addon_instance_id  UUID REFERENCES billing_workspace_addons(id) ON DELETE SET NULL,
  authorization_id   UUID REFERENCES billing_authorizations(id) ON DELETE SET NULL,
  paystack_reference TEXT UNIQUE NOT NULL,
  amount_cents       INTEGER NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  status             transaction_status NOT NULL DEFAULT 'pending',
  charge_type        TEXT NOT NULL DEFAULT 'subscription'
    CHECK (charge_type IN ('subscription', 'addon', 'card_authorization', 'outstanding', 'other')),
  gateway_response   TEXT,
  paid_at            TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_transactions IS
  'Payment records from Paystack for tier subscriptions and add-on purchases.';

CREATE INDEX idx_billing_txn_ws ON billing_transactions(workspace_id);
CREATE INDEX idx_billing_txn_ref ON billing_transactions(paystack_reference);
CREATE INDEX idx_billing_txn_charge_type ON billing_transactions(charge_type);
CREATE INDEX idx_billing_txn_invoice ON billing_transactions(invoice_id) WHERE invoice_id IS NOT NULL;

CREATE TRIGGER billing_transactions_updated_at
  BEFORE UPDATE ON billing_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 14. BILLING PAYMENT ATTEMPTS (audit trail)
-- ============================================================================

CREATE TABLE billing_payment_attempts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id    UUID REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  invoice_id         UUID REFERENCES billing_invoices(id) ON DELETE SET NULL,
  transaction_id     UUID REFERENCES billing_transactions(id) ON DELETE SET NULL,
  authorization_id   UUID REFERENCES billing_authorizations(id) ON DELETE SET NULL,
  source             TEXT NOT NULL DEFAULT 'unknown',
  provider           TEXT NOT NULL DEFAULT 'paystack',
  provider_reference TEXT NOT NULL,
  status             transaction_status NOT NULL,
  charge_type        TEXT NOT NULL DEFAULT 'subscription',
  amount_cents       INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'ZAR',
  failure_reason     TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}',
  attempted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billing_attempts_ws_created
  ON billing_payment_attempts(workspace_id, created_at DESC);
CREATE INDEX idx_billing_attempts_ws_status
  ON billing_payment_attempts(workspace_id, status, created_at DESC);
CREATE UNIQUE INDEX uq_billing_attempts_dedupe
  ON billing_payment_attempts(provider, source, provider_reference, status);

-- ============================================================================
-- 15. QUOTA LIMITS (per tier)
-- ============================================================================

CREATE TABLE quota_limits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id     UUID NOT NULL REFERENCES billing_tiers(id) ON DELETE CASCADE,
  quota_key   TEXT NOT NULL,
  limit_value BIGINT NOT NULL,
  period      TEXT NOT NULL DEFAULT 'monthly'
    CHECK (period IN ('monthly', 'total')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tier_id, quota_key)
);

COMMENT ON TABLE quota_limits IS
  'Base quota limits per billing tier. Add-ons stack on top. '
  'period=monthly resets each billing cycle, period=total is a hard cap.';

CREATE INDEX idx_quota_limits_tier ON quota_limits(tier_id);

-- ============================================================================
-- 16. QUOTA USAGE (consumption per workspace)
-- ============================================================================

CREATE TABLE quota_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  quota_key    TEXT NOT NULL,
  used         BIGINT NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, quota_key, period_start)
);

COMMENT ON TABLE quota_usage IS
  'Tracks current quota consumption per workspace per billing period.';

CREATE INDEX idx_quota_usage_ws ON quota_usage(workspace_id);
CREATE INDEX idx_quota_usage_lookup ON quota_usage(workspace_id, quota_key, period_start);

CREATE TRIGGER quota_usage_updated_at
  BEFORE UPDATE ON quota_usage
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 17. BILLING QUEUE (Cloud Scheduler + Go worker)
-- ============================================================================

CREATE TABLE billing_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_type         TEXT NOT NULL
    CHECK (task_type IN ('subscription_renewal', 'addon_renewal', 'retry_failed_payment', 'downgrade')),
  subscription_id   UUID REFERENCES billing_subscriptions(id) ON DELETE CASCADE,
  addon_instance_id UUID REFERENCES billing_workspace_addons(id) ON DELETE CASCADE,
  run_at            TIMESTAMPTZ NOT NULL,
  cycle_key         TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
  attempt_count     INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 3,
  last_error        TEXT,
  locked_at         TIMESTAMPTZ,
  processed_at      TIMESTAMPTZ,
  payload           JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billing_queue IS
  'Unified queue for billable work. Handles subscription renewals, addon renewals, '
  'failed payment retries, and auto-downgrades. Polled by Cloud Scheduler + Go worker.';

CREATE INDEX idx_billing_queue_status_run
  ON billing_queue(status, run_at);
CREATE INDEX idx_billing_queue_ws
  ON billing_queue(workspace_id, created_at DESC);
CREATE INDEX idx_billing_queue_type
  ON billing_queue(task_type, status, run_at);

CREATE TRIGGER billing_queue_updated_at
  BEFORE UPDATE ON billing_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- 18. SEED QUOTA LIMITS
-- ============================================================================

-- Free
INSERT INTO quota_limits (tier_id, quota_key, limit_value, period)
SELECT id, 'scans_monthly',           20,    'monthly' FROM billing_tiers WHERE slug = 'free'
UNION ALL
SELECT id, 'categorizations_monthly', 20,    'monthly' FROM billing_tiers WHERE slug = 'free'
UNION ALL
SELECT id, 'storage_mb',              500,   'total'   FROM billing_tiers WHERE slug = 'free'
UNION ALL
SELECT id, 'members',                 2,     'total'   FROM billing_tiers WHERE slug = 'free'
UNION ALL
SELECT id, 'documents_monthly',       50,    'monthly' FROM billing_tiers WHERE slug = 'free';

-- Basic
INSERT INTO quota_limits (tier_id, quota_key, limit_value, period)
SELECT id, 'scans_monthly',           200,   'monthly' FROM billing_tiers WHERE slug = 'basic'
UNION ALL
SELECT id, 'categorizations_monthly', 200,   'monthly' FROM billing_tiers WHERE slug = 'basic'
UNION ALL
SELECT id, 'storage_mb',              5120,  'total'   FROM billing_tiers WHERE slug = 'basic'
UNION ALL
SELECT id, 'members',                 10,    'total'   FROM billing_tiers WHERE slug = 'basic'
UNION ALL
SELECT id, 'documents_monthly',       500,   'monthly' FROM billing_tiers WHERE slug = 'basic';

-- Pro
INSERT INTO quota_limits (tier_id, quota_key, limit_value, period)
SELECT id, 'scans_monthly',           1000,  'monthly' FROM billing_tiers WHERE slug = 'pro'
UNION ALL
SELECT id, 'categorizations_monthly', 1000,  'monthly' FROM billing_tiers WHERE slug = 'pro'
UNION ALL
SELECT id, 'storage_mb',              25600, 'total'   FROM billing_tiers WHERE slug = 'pro'
UNION ALL
SELECT id, 'members',                 50,    'total'   FROM billing_tiers WHERE slug = 'pro'
UNION ALL
SELECT id, 'documents_monthly',       5000,  'monthly' FROM billing_tiers WHERE slug = 'pro';

-- ============================================================================
-- 19. SEED DEFAULT CATEGORIES (Vault22-style, 4 levels deep)
--     depth 0 = top, 1 = sub, 2 = sub-sub, 3 = item-level
--     is_system = true, workspace_id = NULL (global defaults)
-- ============================================================================

DO $$
DECLARE
  -- depth 0
  _income UUID; _housing UUID; _transport UUID; _groceries UUID;
  _eating_out UUID; _shopping UUID; _entertainment UUID; _health UUID;
  _education UUID; _financial UUID; _utilities UUID; _personal UUID;
  _business UUID; _transfers UUID; _uncategorized UUID;
  -- depth 1
  _v UUID;
BEGIN

-- ── INCOME ──────────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Income', 'income', 0, true, '#22c55e') RETURNING id INTO _income;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_income, 'Salary & Wages',     'income.salary',      1, true),
  (_income, 'Business Income',    'income.business',    1, true),
  (_income, 'Investment Income',  'income.investment',  1, true),
  (_income, 'Rental Income',      'income.rental',      1, true),
  (_income, 'Government Grants',  'income.grants',      1, true),
  (_income, 'Other Income',       'income.other',       1, true);

-- salary sub-subs
SELECT id INTO _v FROM categories WHERE slug = 'income.salary';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Regular Salary',  'income.salary.regular',    2, true),
  (_v, 'Bonus',           'income.salary.bonus',      2, true),
  (_v, 'Commission',      'income.salary.commission', 2, true),
  (_v, 'Overtime',        'income.salary.overtime',   2, true);

SELECT id INTO _v FROM categories WHERE slug = 'income.investment';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Dividends',      'income.investment.dividends', 2, true),
  (_v, 'Interest',       'income.investment.interest',  2, true),
  (_v, 'Capital Gains',  'income.investment.capgains',  2, true);

-- ── HOUSING ─────────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Housing', 'housing', 0, true, '#8b5cf6') RETURNING id INTO _housing;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_housing, 'Rent',              'housing.rent',        1, true),
  (_housing, 'Mortgage',          'housing.mortgage',    1, true),
  (_housing, 'Rates & Taxes',     'housing.rates',       1, true),
  (_housing, 'Home Insurance',    'housing.insurance',   1, true),
  (_housing, 'Maintenance',       'housing.maintenance', 1, true),
  (_housing, 'Security',          'housing.security',    1, true),
  (_housing, 'Body Corporate',    'housing.bodycorp',    1, true);

SELECT id INTO _v FROM categories WHERE slug = 'housing.maintenance';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Repairs',      'housing.maintenance.repairs',      2, true),
  (_v, 'Renovations',  'housing.maintenance.renovations',  2, true),
  (_v, 'Garden',       'housing.maintenance.garden',       2, true),
  (_v, 'Pest Control', 'housing.maintenance.pest',         2, true);

SELECT id INTO _v FROM categories WHERE slug = 'housing.security';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Armed Response',  'housing.security.armed',    2, true),
  (_v, 'Alarm System',    'housing.security.alarm',    2, true),
  (_v, 'Electric Fence',  'housing.security.fence',    2, true);

-- ── TRANSPORT ───────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Transport', 'transport', 0, true, '#f59e0b') RETURNING id INTO _transport;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_transport, 'Fuel',              'transport.fuel',       1, true),
  (_transport, 'Vehicle Payment',   'transport.payment',    1, true),
  (_transport, 'Vehicle Insurance', 'transport.insurance',  1, true),
  (_transport, 'Maintenance',       'transport.maintenance',1, true),
  (_transport, 'Parking',           'transport.parking',    1, true),
  (_transport, 'Tolls',             'transport.tolls',      1, true),
  (_transport, 'Public Transport',  'transport.public',     1, true),
  (_transport, 'Ride Hailing',      'transport.ridehail',   1, true),
  (_transport, 'License & Registration', 'transport.license', 1, true);

SELECT id INTO _v FROM categories WHERE slug = 'transport.fuel';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Petrol',  'transport.fuel.petrol', 2, true),
  (_v, 'Diesel',  'transport.fuel.diesel', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'transport.maintenance';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Service',  'transport.maintenance.service', 2, true),
  (_v, 'Repairs',  'transport.maintenance.repairs', 2, true),
  (_v, 'Tyres',    'transport.maintenance.tyres',   2, true),
  (_v, 'Car Wash', 'transport.maintenance.wash',    2, true);

SELECT id INTO _v FROM categories WHERE slug = 'transport.public';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Bus',     'transport.public.bus',   2, true),
  (_v, 'Train',   'transport.public.train', 2, true),
  (_v, 'Taxi',    'transport.public.taxi',  2, true),
  (_v, 'Gautrain','transport.public.gautrain', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'transport.tolls';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'E-toll',       'transport.tolls.etoll',   2, true),
  (_v, 'Highway Toll', 'transport.tolls.highway', 2, true);

-- ── GROCERIES (deep: 3 levels for invoice line items) ───────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Groceries', 'groceries', 0, true, '#10b981') RETURNING id INTO _groceries;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_groceries, 'Fresh Produce',    'groceries.produce',    1, true),
  (_groceries, 'Meat & Seafood',   'groceries.meat',       1, true),
  (_groceries, 'Dairy & Eggs',     'groceries.dairy',      1, true),
  (_groceries, 'Bakery',           'groceries.bakery',     1, true),
  (_groceries, 'Pantry',           'groceries.pantry',     1, true),
  (_groceries, 'Frozen',           'groceries.frozen',     1, true),
  (_groceries, 'Beverages',        'groceries.beverages',  1, true),
  (_groceries, 'Snacks',           'groceries.snacks',     1, true),
  (_groceries, 'Household',        'groceries.household',  1, true),
  (_groceries, 'Personal Care',    'groceries.personal',   1, true),
  (_groceries, 'Baby',             'groceries.baby',       1, true),
  (_groceries, 'Pet',              'groceries.pet',        1, true);

-- Fresh Produce → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.produce';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Fruit',       'groceries.produce.fruit',  2, true),
  (_v, 'Vegetables',  'groceries.produce.veg',    2, true),
  (_v, 'Herbs',       'groceries.produce.herbs',  2, true);

-- Fruit → depth 3 (item-level for invoice matching)
SELECT id INTO _v FROM categories WHERE slug = 'groceries.produce.fruit';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Citrus',       'groceries.produce.fruit.citrus',   3, true),
  (_v, 'Berries',      'groceries.produce.fruit.berries',  3, true),
  (_v, 'Stone Fruit',  'groceries.produce.fruit.stone',    3, true),
  (_v, 'Tropical',     'groceries.produce.fruit.tropical', 3, true),
  (_v, 'Apples & Pears','groceries.produce.fruit.pome',    3, true),
  (_v, 'Bananas',      'groceries.produce.fruit.bananas',  3, true);

-- Vegetables → depth 3
SELECT id INTO _v FROM categories WHERE slug = 'groceries.produce.veg';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Leafy Greens',    'groceries.produce.veg.leafy',   3, true),
  (_v, 'Root Vegetables', 'groceries.produce.veg.root',    3, true),
  (_v, 'Tomatoes & Peppers','groceries.produce.veg.tomato',3, true),
  (_v, 'Onions & Garlic', 'groceries.produce.veg.allium',  3, true),
  (_v, 'Squash & Gourds', 'groceries.produce.veg.squash',  3, true),
  (_v, 'Legumes & Beans', 'groceries.produce.veg.legumes', 3, true);

-- Meat & Seafood → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.meat';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Beef',     'groceries.meat.beef',     2, true),
  (_v, 'Chicken',  'groceries.meat.chicken',  2, true),
  (_v, 'Pork',     'groceries.meat.pork',     2, true),
  (_v, 'Lamb',     'groceries.meat.lamb',     2, true),
  (_v, 'Fish',     'groceries.meat.fish',     2, true),
  (_v, 'Seafood',  'groceries.meat.seafood',  2, true),
  (_v, 'Processed','groceries.meat.processed',2, true),
  (_v, 'Boerewors & Braai', 'groceries.meat.braai', 2, true);

-- Beef → depth 3
SELECT id INTO _v FROM categories WHERE slug = 'groceries.meat.beef';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Mince',   'groceries.meat.beef.mince',  3, true),
  (_v, 'Steak',   'groceries.meat.beef.steak',  3, true),
  (_v, 'Roast',   'groceries.meat.beef.roast',  3, true),
  (_v, 'Stewing', 'groceries.meat.beef.stew',   3, true);

-- Chicken → depth 3
SELECT id INTO _v FROM categories WHERE slug = 'groceries.meat.chicken';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Whole',    'groceries.meat.chicken.whole',   3, true),
  (_v, 'Breast',   'groceries.meat.chicken.breast',  3, true),
  (_v, 'Thighs & Drumsticks', 'groceries.meat.chicken.pieces', 3, true),
  (_v, 'Wings',    'groceries.meat.chicken.wings',   3, true);

-- Dairy & Eggs → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.dairy';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Milk',     'groceries.dairy.milk',    2, true),
  (_v, 'Cheese',   'groceries.dairy.cheese',  2, true),
  (_v, 'Yoghurt',  'groceries.dairy.yoghurt', 2, true),
  (_v, 'Eggs',     'groceries.dairy.eggs',    2, true),
  (_v, 'Butter & Margarine', 'groceries.dairy.butter', 2, true),
  (_v, 'Cream',    'groceries.dairy.cream',   2, true);

-- Bakery → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.bakery';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Bread',     'groceries.bakery.bread',     2, true),
  (_v, 'Rolls & Buns', 'groceries.bakery.rolls',  2, true),
  (_v, 'Pastries',  'groceries.bakery.pastries',  2, true),
  (_v, 'Cakes',     'groceries.bakery.cakes',     2, true);

-- Pantry → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.pantry';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Canned Goods',  'groceries.pantry.canned',   2, true),
  (_v, 'Pasta & Rice',  'groceries.pantry.grains',   2, true),
  (_v, 'Spices & Seasoning','groceries.pantry.spices',2, true),
  (_v, 'Oils & Vinegar','groceries.pantry.oils',      2, true),
  (_v, 'Sauces & Condiments','groceries.pantry.sauces',2, true),
  (_v, 'Baking',        'groceries.pantry.baking',    2, true),
  (_v, 'Cereal & Oats', 'groceries.pantry.cereal',   2, true),
  (_v, 'Sugar & Sweeteners','groceries.pantry.sugar', 2, true);

-- Frozen → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.frozen';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Frozen Meals',  'groceries.frozen.meals',  2, true),
  (_v, 'Frozen Veg',    'groceries.frozen.veg',    2, true),
  (_v, 'Frozen Meat',   'groceries.frozen.meat',   2, true),
  (_v, 'Ice Cream',     'groceries.frozen.icecream',2, true),
  (_v, 'Frozen Chips',  'groceries.frozen.chips',  2, true);

-- Beverages → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.beverages';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Water',          'groceries.beverages.water',   2, true),
  (_v, 'Juice',          'groceries.beverages.juice',   2, true),
  (_v, 'Soft Drinks',    'groceries.beverages.soda',    2, true),
  (_v, 'Coffee & Tea',   'groceries.beverages.coffee',  2, true),
  (_v, 'Energy Drinks',  'groceries.beverages.energy',  2, true),
  (_v, 'Alcohol',        'groceries.beverages.alcohol', 2, true);

-- Alcohol → depth 3
SELECT id INTO _v FROM categories WHERE slug = 'groceries.beverages.alcohol';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Beer',     'groceries.beverages.alcohol.beer',    3, true),
  (_v, 'Wine',     'groceries.beverages.alcohol.wine',    3, true),
  (_v, 'Spirits',  'groceries.beverages.alcohol.spirits', 3, true),
  (_v, 'Ciders',   'groceries.beverages.alcohol.ciders',  3, true);

-- Snacks → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.snacks';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Chips & Crisps', 'groceries.snacks.chips',     2, true),
  (_v, 'Biscuits',       'groceries.snacks.biscuits',   2, true),
  (_v, 'Chocolate & Sweets','groceries.snacks.sweets',  2, true),
  (_v, 'Nuts & Dried Fruit','groceries.snacks.nuts',    2, true),
  (_v, 'Popcorn',        'groceries.snacks.popcorn',    2, true);

-- Household → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.household';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Cleaning',       'groceries.household.cleaning',  2, true),
  (_v, 'Laundry',        'groceries.household.laundry',   2, true),
  (_v, 'Paper Products', 'groceries.household.paper',     2, true),
  (_v, 'Kitchen Supplies','groceries.household.kitchen',  2, true),
  (_v, 'Bin Bags & Wrap','groceries.household.bags',      2, true);

-- Personal Care → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.personal';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Toiletries',  'groceries.personal.toiletries', 2, true),
  (_v, 'Skincare',    'groceries.personal.skincare',   2, true),
  (_v, 'Haircare',    'groceries.personal.haircare',   2, true),
  (_v, 'Oral Care',   'groceries.personal.oral',       2, true),
  (_v, 'Feminine',    'groceries.personal.feminine',   2, true),
  (_v, 'Deodorant',   'groceries.personal.deodorant',  2, true);

-- Baby → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.baby';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Nappies & Wipes', 'groceries.baby.nappies',  2, true),
  (_v, 'Formula',         'groceries.baby.formula',   2, true),
  (_v, 'Baby Food',       'groceries.baby.food',      2, true),
  (_v, 'Baby Care',       'groceries.baby.care',      2, true);

-- Pet → depth 2
SELECT id INTO _v FROM categories WHERE slug = 'groceries.pet';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Dog Food',    'groceries.pet.dog',     2, true),
  (_v, 'Cat Food',    'groceries.pet.cat',     2, true),
  (_v, 'Pet Treats',  'groceries.pet.treats',  2, true),
  (_v, 'Pet Supplies','groceries.pet.supplies',2, true);

-- ── EATING OUT ──────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Eating Out', 'eating-out', 0, true, '#ef4444') RETURNING id INTO _eating_out;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_eating_out, 'Restaurants',       'eating-out.restaurants',  1, true),
  (_eating_out, 'Fast Food',         'eating-out.fastfood',     1, true),
  (_eating_out, 'Coffee Shops',      'eating-out.coffee',       1, true),
  (_eating_out, 'Bars & Pubs',       'eating-out.bars',         1, true),
  (_eating_out, 'Takeaway & Delivery','eating-out.takeaway',    1, true);

-- ── SHOPPING ────────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Shopping', 'shopping', 0, true, '#ec4899') RETURNING id INTO _shopping;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_shopping, 'Clothing',        'shopping.clothing',     1, true),
  (_shopping, 'Electronics',     'shopping.electronics',  1, true),
  (_shopping, 'Furniture',       'shopping.furniture',    1, true),
  (_shopping, 'Appliances',      'shopping.appliances',   1, true),
  (_shopping, 'Online Shopping', 'shopping.online',       1, true),
  (_shopping, 'Hardware & DIY',  'shopping.hardware',     1, true);

SELECT id INTO _v FROM categories WHERE slug = 'shopping.clothing';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Men',       'shopping.clothing.men',      2, true),
  (_v, 'Women',     'shopping.clothing.women',    2, true),
  (_v, 'Children',  'shopping.clothing.children', 2, true),
  (_v, 'Shoes',     'shopping.clothing.shoes',    2, true),
  (_v, 'Accessories','shopping.clothing.accessories', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'shopping.electronics';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Phones',       'shopping.electronics.phones',       2, true),
  (_v, 'Computers',    'shopping.electronics.computers',    2, true),
  (_v, 'Accessories',  'shopping.electronics.accessories',  2, true),
  (_v, 'Audio & Video','shopping.electronics.av',           2, true);

-- ── ENTERTAINMENT ───────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Entertainment', 'entertainment', 0, true, '#6366f1') RETURNING id INTO _entertainment;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_entertainment, 'Streaming',          'entertainment.streaming',  1, true),
  (_entertainment, 'Movies & Theatre',   'entertainment.movies',     1, true),
  (_entertainment, 'Events & Concerts',  'entertainment.events',     1, true),
  (_entertainment, 'Sports & Activities','entertainment.sports',     1, true),
  (_entertainment, 'Gaming',            'entertainment.gaming',      1, true),
  (_entertainment, 'Books & Magazines', 'entertainment.books',       1, true),
  (_entertainment, 'Hobbies',           'entertainment.hobbies',     1, true),
  (_entertainment, 'Holiday & Travel',  'entertainment.travel',      1, true);

SELECT id INTO _v FROM categories WHERE slug = 'entertainment.streaming';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Video Streaming',  'entertainment.streaming.video',  2, true),
  (_v, 'Music Streaming',  'entertainment.streaming.music',  2, true),
  (_v, 'Gaming Subs',      'entertainment.streaming.gaming', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'entertainment.travel';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Flights',        'entertainment.travel.flights',  2, true),
  (_v, 'Accommodation',  'entertainment.travel.accom',    2, true),
  (_v, 'Car Hire',        'entertainment.travel.carhire', 2, true),
  (_v, 'Activities',      'entertainment.travel.activities', 2, true);

-- ── HEALTH & WELLNESS ───────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Health & Wellness', 'health', 0, true, '#14b8a6') RETURNING id INTO _health;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_health, 'Medical',         'health.medical',    1, true),
  (_health, 'Pharmacy',        'health.pharmacy',   1, true),
  (_health, 'Dental',          'health.dental',     1, true),
  (_health, 'Optical',         'health.optical',    1, true),
  (_health, 'Fitness',         'health.fitness',    1, true),
  (_health, 'Mental Health',   'health.mental',     1, true),
  (_health, 'Medical Aid',     'health.medicalaid', 1, true);

SELECT id INTO _v FROM categories WHERE slug = 'health.medical';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'GP / Doctor',   'health.medical.gp',         2, true),
  (_v, 'Specialist',    'health.medical.specialist',  2, true),
  (_v, 'Hospital',      'health.medical.hospital',    2, true),
  (_v, 'Emergency',     'health.medical.emergency',   2, true);

SELECT id INTO _v FROM categories WHERE slug = 'health.pharmacy';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Prescription',  'health.pharmacy.prescription', 2, true),
  (_v, 'Over the Counter','health.pharmacy.otc',        2, true),
  (_v, 'Supplements',   'health.pharmacy.supplements',  2, true);

SELECT id INTO _v FROM categories WHERE slug = 'health.fitness';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Gym Membership', 'health.fitness.gym',       2, true),
  (_v, 'Classes',        'health.fitness.classes',   2, true),
  (_v, 'Equipment',      'health.fitness.equipment', 2, true);

-- ── EDUCATION ───────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Education', 'education', 0, true, '#0ea5e9') RETURNING id INTO _education;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_education, 'School Fees',       'education.school',    1, true),
  (_education, 'University',        'education.university',1, true),
  (_education, 'Books & Supplies',  'education.supplies',  1, true),
  (_education, 'Courses & Training','education.courses',   1, true),
  (_education, 'Childcare',         'education.childcare', 1, true);

SELECT id INTO _v FROM categories WHERE slug = 'education.school';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Tuition',         'education.school.tuition',   2, true),
  (_v, 'Uniforms',        'education.school.uniforms',  2, true),
  (_v, 'Extracurricular', 'education.school.extra',     2, true),
  (_v, 'Transport',       'education.school.transport', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'education.childcare';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Crèche',       'education.childcare.creche',     2, true),
  (_v, 'After School',  'education.childcare.afterschool',2, true),
  (_v, 'Au Pair / Nanny','education.childcare.nanny',    2, true);

-- ── FINANCIAL ───────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Financial', 'financial', 0, true, '#64748b') RETURNING id INTO _financial;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_financial, 'Bank Fees',      'financial.bankfees',    1, true),
  (_financial, 'Insurance',      'financial.insurance',   1, true),
  (_financial, 'Investments',    'financial.investments',  1, true),
  (_financial, 'Tax',            'financial.tax',          1, true),
  (_financial, 'Debt Repayment', 'financial.debt',         1, true),
  (_financial, 'Savings',        'financial.savings',      1, true);

SELECT id INTO _v FROM categories WHERE slug = 'financial.bankfees';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Account Fees',      'financial.bankfees.account',  2, true),
  (_v, 'Card Fees',         'financial.bankfees.card',     2, true),
  (_v, 'Transaction Fees',  'financial.bankfees.txn',      2, true),
  (_v, 'ATM Fees',          'financial.bankfees.atm',      2, true);

SELECT id INTO _v FROM categories WHERE slug = 'financial.insurance';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Life Insurance',     'financial.insurance.life',     2, true),
  (_v, 'Funeral Cover',      'financial.insurance.funeral',  2, true),
  (_v, 'Short-term',         'financial.insurance.shortterm',2, true),
  (_v, 'Income Protection',  'financial.insurance.income',   2, true);

SELECT id INTO _v FROM categories WHERE slug = 'financial.investments';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Retirement / RA',  'financial.investments.retirement', 2, true),
  (_v, 'Unit Trusts',      'financial.investments.unittrsts',  2, true),
  (_v, 'Stocks & ETFs',    'financial.investments.stocks',     2, true),
  (_v, 'Tax-Free Savings', 'financial.investments.tfsa',       2, true);

SELECT id INTO _v FROM categories WHERE slug = 'financial.debt';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Credit Card',    'financial.debt.creditcard',  2, true),
  (_v, 'Personal Loan',  'financial.debt.personal',    2, true),
  (_v, 'Student Loan',   'financial.debt.student',     2, true),
  (_v, 'Store Account',  'financial.debt.store',       2, true);

SELECT id INTO _v FROM categories WHERE slug = 'financial.tax';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Income Tax (PAYE)', 'financial.tax.paye',  2, true),
  (_v, 'VAT',               'financial.tax.vat',   2, true),
  (_v, 'Provisional Tax',   'financial.tax.provisional', 2, true),
  (_v, 'Tax Refund',        'financial.tax.refund',2, true);

-- ── UTILITIES ───────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Utilities', 'utilities', 0, true, '#f97316') RETURNING id INTO _utilities;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_utilities, 'Electricity',       'utilities.electricity',  1, true),
  (_utilities, 'Water',             'utilities.water',        1, true),
  (_utilities, 'Internet & WiFi',   'utilities.internet',     1, true),
  (_utilities, 'Mobile Phone',      'utilities.mobile',       1, true),
  (_utilities, 'Gas',               'utilities.gas',          1, true),
  (_utilities, 'Waste Removal',     'utilities.waste',        1, true);

SELECT id INTO _v FROM categories WHERE slug = 'utilities.electricity';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Prepaid',   'utilities.electricity.prepaid',  2, true),
  (_v, 'Post-paid', 'utilities.electricity.postpaid', 2, true),
  (_v, 'Solar',     'utilities.electricity.solar',    2, true);

SELECT id INTO _v FROM categories WHERE slug = 'utilities.mobile';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Contract',  'utilities.mobile.contract', 2, true),
  (_v, 'Prepaid',   'utilities.mobile.prepaid',  2, true),
  (_v, 'Data',      'utilities.mobile.data',     2, true);

-- ── PERSONAL ────────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Personal', 'personal', 0, true, '#d946ef') RETURNING id INTO _personal;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_personal, 'Gifts',          'personal.gifts',        1, true),
  (_personal, 'Donations',      'personal.donations',    1, true),
  (_personal, 'Subscriptions',  'personal.subscriptions',1, true),
  (_personal, 'Hair & Beauty',  'personal.beauty',       1, true),
  (_personal, 'Laundry & Dry Cleaning', 'personal.laundry', 1, true);

SELECT id INTO _v FROM categories WHERE slug = 'personal.donations';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Charity',      'personal.donations.charity', 2, true),
  (_v, 'Church / Tithe','personal.donations.church', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'personal.gifts';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Birthdays',  'personal.gifts.birthday',  2, true),
  (_v, 'Holidays',   'personal.gifts.holiday',   2, true),
  (_v, 'Weddings',   'personal.gifts.wedding',   2, true);

-- ── BUSINESS EXPENSES ───────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Business Expenses', 'business', 0, true, '#0891b2') RETURNING id INTO _business;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_business, 'Office Supplies',       'business.office',       1, true),
  (_business, 'Software & SaaS',       'business.software',     1, true),
  (_business, 'Professional Services', 'business.professional', 1, true),
  (_business, 'Marketing',             'business.marketing',    1, true),
  (_business, 'Business Travel',       'business.travel',       1, true),
  (_business, 'Communication',         'business.communication',1, true),
  (_business, 'Equipment',             'business.equipment',    1, true),
  (_business, 'Staff Costs',           'business.staff',        1, true),
  (_business, 'Rent & Premises',       'business.rent',         1, true);

SELECT id INTO _v FROM categories WHERE slug = 'business.professional';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Legal',       'business.professional.legal',      2, true),
  (_v, 'Accounting',  'business.professional.accounting', 2, true),
  (_v, 'Consulting',  'business.professional.consulting', 2, true);

SELECT id INTO _v FROM categories WHERE slug = 'business.staff';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Salaries',   'business.staff.salaries',  2, true),
  (_v, 'UIF & SDL',  'business.staff.uif',       2, true),
  (_v, 'Training',   'business.staff.training',  2, true);

SELECT id INTO _v FROM categories WHERE slug = 'business.travel';
INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_v, 'Flights',        'business.travel.flights',  2, true),
  (_v, 'Accommodation',  'business.travel.accom',    2, true),
  (_v, 'Car Hire',       'business.travel.carhire',  2, true),
  (_v, 'Meals',          'business.travel.meals',    2, true);

-- ── TRANSFERS ───────────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Transfers', 'transfers', 0, true, '#78716c') RETURNING id INTO _transfers;

INSERT INTO categories (parent_id, name, slug, depth, is_system) VALUES
  (_transfers, 'Between Own Accounts','transfers.own',           1, true),
  (_transfers, 'To Other People',     'transfers.people',        1, true),
  (_transfers, 'International',       'transfers.international', 1, true);

-- ── UNCATEGORIZED ───────────────────────────────────────────────────────────
INSERT INTO categories (name, slug, depth, is_system, color) VALUES
  ('Uncategorized', 'uncategorized', 0, true, '#a1a1aa') RETURNING id INTO _uncategorized;

END;
$$;

-- down
-- (no database exists yet — this is the initial migration)
