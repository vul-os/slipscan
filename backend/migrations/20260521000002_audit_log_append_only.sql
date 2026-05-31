-- P4-03: Enforce append-only semantics on audit_log.
--
-- The audit_log table was created in 20260430000004_billing.sql.
-- This migration makes it tamper-evident by:
--
--   1. Adding PostgreSQL RULES that silently suppress UPDATE and DELETE on
--      audit_log so no application code or accidental query can rewrite
--      history. Using rules (not triggers) means the suppression happens at
--      the rewrite-rule level before the executor runs — cheaper and simpler
--      than a trigger that raises an exception.
--
--   2. Adding a comment on the table documenting the policy for future
--      engineers.

-- Suppress any UPDATE attempt on audit_log — silently do nothing.
CREATE OR REPLACE RULE no_update_audit_log AS
    ON UPDATE TO audit_log
    DO INSTEAD NOTHING;

-- Suppress any DELETE attempt on audit_log — silently do nothing.
CREATE OR REPLACE RULE no_delete_audit_log AS
    ON DELETE TO audit_log
    DO INSTEAD NOTHING;

COMMENT ON TABLE audit_log IS
    'Append-only audit trail (P4-03). UPDATE and DELETE are suppressed via '
    'pg rules (no_update_audit_log, no_delete_audit_log). Do not drop these '
    'rules. To purge entries under a legal-hold policy, disable the rules '
    'temporarily in a controlled, logged maintenance window with DBA approval.';
