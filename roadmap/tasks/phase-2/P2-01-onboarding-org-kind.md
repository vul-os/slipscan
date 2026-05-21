---
id: P2-01
title: Onboarding by org kind (personal vs business)
phase: 2
status: review
depends_on: [P1-02]
owner: unassigned
---

## Goal
At registration the user chooses **personal** or **business**; the flow collects
the right profile (personal = name; business = legal name, reg number, tax/VAT
number, industry, country) and creates the org with its kind. This is the fork
that drives every downstream difference (categories, ledger, reporting).

## Context
The backend already supports this: `org.Store.Create` takes `Kind` +
`PersonalProfile`/`BusinessProfile` and seeds slug + `rx_local_part`. The
frontend `Onboarding.jsx` + `Register.jsx` exist but need the kind-aware fields.
Default category seeding (P1-02) keys off org kind.

## Existing assets
- `org.Store.Create` (`internal/org/store.go`), `organization_kind` enum,
  `personal_profiles` / `business_profiles` tables.
- `src/pages/Register.jsx`, `src/pages/Onboarding.jsx`, `src/stores/org.js`,
  `FormField.jsx`, `react-hook-form` + `zod`.
- Auth register handler in `internal/auth/handlers.go` (already calls org create).

## Scope
**In:** UI step to pick kind; conditional profile form per kind with validation;
wire to the register/org-create payload; show the assigned `rx_local_part`
inbound email address post-onboarding; allow editing business profile later in
Settings.
**Out:** the spending breakdown / ledger themselves (P2-02/P2-03); slug rename
(can be a small follow-up; note if deferred).

## Implementation
1. Onboarding step 1: choose Personal or Business (clear copy on the difference).
2. Step 2 — conditional fields:
   - Personal: full name.
   - Business: legal name (required), registration number, tax/VAT number,
     industry, website, country (ISO-2). Mirror `BusinessProfile` fields.
3. `zod` schemas per kind; submit maps to the org-create/register request shape
   the backend expects.
4. Confirmation screen: show the org's inbound email `slug@RX_DOMAIN` and a
   "forward your slips here" hint (ties to P0-01).
5. Settings: business profile is editable (add a `PATCH` org-profile endpoint if
   missing; keep `slug`/`rx_local_part` rename out of scope unless trivial).

## Acceptance criteria
- [ ] Registering as personal creates a `personal` org with a `personal_profiles`
      row; as business creates a `business` org with a `business_profiles` row.
- [ ] Business validation requires legal name; optional fields persist when given.
- [ ] Post-onboarding the user sees their inbound email address.
- [ ] Default categories/accounts (P1-02 seed) match the chosen kind.
- [ ] `npm run build` clean; form validation errors are clear.

## Tests
- Backend: `org.Store.Create` already testable — add cases for both kinds if
  missing. Frontend: zod schema unit tests; manual onboarding walkthrough.

## Notes
The kind is effectively immutable post-creation in the data model — make the
choice deliberate in the UI. This task is the gate for the two-product split in P2.
