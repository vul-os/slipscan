---
id: P1-05
title: Document & transaction review UI (extract → classify → correct)
phase: 1
status: todo
depends_on: [P1-02]
owner: unassigned
---

## Goal
Front-end surface where a user sees an ingested document, its extracted
fields/line-items, and the classification per transaction — and can correct the
category in one click (firing the P1-03 learning loop). Show confidence so users
trust (and verify) low-confidence items first.

## Context
Frontend pages `Receipts.jsx` and `ReceiptDetail.jsx` already exist as the
starting point. Backend extraction (P1-01) and classification (P1-02) + the
correction endpoint (P1-03) provide the data and the mutation.

## Existing assets
- `src/pages/Receipts.jsx`, `src/pages/ReceiptDetail.jsx`, `UploadDialog.jsx`.
- `src/lib/api.js`, `src/lib/queries.js` (Tanstack Query), `src/components/ui/*`
  (Card, Badge, Dialog, DropdownMenu, Select, etc.), `StatusPill.jsx`.
- Backend: documents list/get, extraction data, classification PATCH (P1-03).

## Scope
**In:** receipts list with status + confidence badges; detail view showing the
document image alongside extracted fields + line-items + per-transaction
classification; an inline category picker that calls the PATCH endpoint and
optimistically updates; a "review queue" filter (low-confidence / unverified first);
a verify/confirm action.
**Out:** reporting/dashboards (P2-04); bulk-edit beyond single recategorize;
mobile-specific layout polish.

## Implementation
1. **List** (`Receipts.jsx`): columns for merchant, date, total, status, and a
   confidence pill; filter/sort by status + confidence; default sort surfaces
   low-confidence/unverified first.
2. **Detail** (`ReceiptDetail.jsx`): two-pane — document preview + structured
   extraction; each transaction row shows its category with a `Select`/popover
   picker (org's categories) and a confidence indicator.
3. **Correction:** picker change → Tanstack mutation to
   `PATCH …/transactions/{id}/classification`; optimistic update + toast
   (`sonner`); offer "apply to all from this merchant" using P1-03's
   `apply_to_existing`.
4. **Verify:** a confirm action transitions transaction status to `verified`.
5. Query keys + invalidation in `src/lib/queries.js`; loading via `Skeleton`.

## Acceptance criteria
- [ ] Receipts list shows status + confidence and can sort low-confidence first.
- [ ] Detail view renders the document image next to extracted fields/line-items.
- [ ] Changing a transaction's category persists via the API and the change is
      reflected without a full reload (optimistic + invalidation).
- [ ] "Apply to all from this merchant" works and reflects the backfill.
- [ ] `npm run build` is clean; no console errors on the happy path.

## Tests
- Component/interaction tests for the category picker mutation (mock API) if a
  test setup exists; otherwise document a manual test script and verify with the
  `verify` skill against a running dev backend.

## Notes
Confidence is the trust surface — show it prominently. The "correct once, applies
everywhere" flow is the moment users feel the learning loop; make it satisfying.
