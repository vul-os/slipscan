---
id: P4-03
title: Compliance & audit trail
phase: 4
status: todo
depends_on: [P2-03]
owner: unassigned
---

## Goal
Earn the trust incumbents have: a tamper-evident audit trail of every financial
mutation, data export/erasure (POPIA/GDPR), role-scoped access enforcement, and
the groundwork for a SOC2 path. Required to go upmarket and to land accountants.

## Context
Financial users need to answer "who changed this and when". The schema already
records `created_by`/timestamps widely and has an `ai_runs` trail; this task adds
a first-class, queryable audit log and the data-rights tooling.

## Existing assets
- Widespread `created_by` + `created_at`/`updated_at` + `set_updated_at` trigger.
- `classification_corrections` (already an audit of category changes), `ai_runs`.
- RLS helpers (`app_current_organization_id`, `app_current_user_id`) in foundation.

## Scope
**In:** an append-only `audit_log` (new migration) capturing actor, org, action,
entity, before/after for sensitive mutations (transactions, ledger entries,
journals, classifications, integrations, membership/role changes); an audit view
+ export per org; a POPIA/GDPR data export + erasure flow; verify role-scoped
access across endpoints; document a SOC2 readiness checklist.
**Out:** an external SOC2 audit itself; full e-signature/legal-hold; field-level
encryption beyond what storage already provides.

## Implementation
1. New migration: `audit_log` (append-only; actor_user_id, organization_id,
   action, entity_type, entity_id, before JSONB, after JSONB, created_at). No
   updates/deletes (enforce via grants/trigger).
2. Write audit entries from sensitive mutation paths (ledger postings, manual
   journals, classification changes, integration connect/disconnect, role changes).
   Centralize via a small `internal/audit` helper.
3. Audit API + UI: per-org, filterable by entity/actor/date; export CSV/JSON.
4. Data rights: `export` (full org data dump) + `erasure` (right-to-be-forgotten
   with legal-retention caveats documented) endpoints, admin-gated.
5. Access review: audit every handler for correct `RequireMember/Admin` scoping;
   add tests asserting cross-org denial. Write a SOC2-readiness doc.

## Acceptance criteria
- [ ] Sensitive mutations write an `audit_log` row with actor + before/after; the
      log cannot be updated or deleted via the app.
- [ ] Per-org audit view is queryable/filterable and exportable.
- [ ] Data export returns a complete org dump; erasure removes/anonymizes per
      policy with retention caveats documented.
- [ ] Tests prove cross-org access is denied on every protected endpoint.
- [ ] `go build` + `npm run build` clean.

## Tests
- Backend: audit-write coverage on each sensitive path; append-only enforcement;
  cross-org access-denial matrix; export completeness.
- Manual: erasure flow walkthrough.

## Notes
Append-only integrity is the point — make it impossible to quietly rewrite
history through the app. This unblocks upmarket/enterprise and accountant trust.
