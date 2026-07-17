-- Migration: 20260529000001_billing_model_picker
-- Adds active_extraction_model_id to organizations so each org can choose
-- which Gemini model is used for extraction.
-- Also seeds the three Gemini extraction model rows so the picker has options
-- on day one.  Run once against the Neon dev DB before deploying the billing
-- endpoints.

-- 1. Add column (nullable — existing orgs fall back to the is_default row).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS active_extraction_model_id UUID
    REFERENCES ai_models(id) ON DELETE SET NULL;

-- 2. Ensure the three extraction model rows exist.
--    provider+model_id+kind is the unique key (from existing ensureAIModel upsert).
INSERT INTO ai_models (provider, model_id, display_name, kind, is_default, is_active)
VALUES
  ('google', 'gemini-2.5-flash',      'Gemini 2.5 Flash',      'extraction', true,  true),
  ('google', 'gemini-2.5-pro',        'Gemini 2.5 Pro',        'extraction', false, true),
  ('google', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'extraction', false, true)
ON CONFLICT (provider, model_id, kind) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      is_active    = EXCLUDED.is_active;
