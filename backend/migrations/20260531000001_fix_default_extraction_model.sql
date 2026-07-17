-- Migration: 20260531000001_fix_default_extraction_model
-- The 20260529 model-picker seed used `ON CONFLICT DO UPDATE` that did NOT touch
-- is_default. Where ensureAIModel() had already inserted gemini-2.5-flash with
-- is_default=false, the intended default was never applied — leaving ZERO default
-- extraction models. resolveOrgModelName() then silently relies on its hardcoded
-- literal fallback, and the billing model picker shows no default.
--
-- Restore a single, explicit default. Idempotent: safe to re-run.
UPDATE ai_models SET is_default = false WHERE kind = 'extraction';
UPDATE ai_models SET is_default = true
  WHERE kind = 'extraction' AND model_id = 'gemini-2.5-flash';
