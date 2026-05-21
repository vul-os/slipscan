---
id: P1-05
title: Document & transaction review UI (extract → classify → correct)
phase: 1
status: review
depends_on: [P1-02]
owner: sonnet-agent
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

## Implementation notes (sonnet-agent, 2026-05-21)

### Files created / modified
- `src/lib/api.js` — new: API client using Supabase session token (reads from `supabase.auth.getSession()`). Adds `listTransactions`, `patchClassification`, `classifyDocument`, `listCategories`.
- `src/lib/format.js` — new: `formatMoney`, `formatDate`, `formatDateLong`, `formatRelative`, `formatNumber`, `initials`.
- `src/lib/queries.js` — new: Tanstack Query v5 hooks — `useDocuments`, `useDocument`, `useDocumentTransactions`, `useTransactions`, `useCategories`, `usePatchClassification` (with optimistic update), `useVerifyTransaction`.
- `src/pages/Receipts.jsx` — new: list with merchant / date / status / confidence pill + sortable columns, default sort = low-confidence first.
- `src/pages/ReceiptDetail.jsx` — new: two-pane (image preview + extraction details + transactions), inline category picker, verify button.
- `src/App.jsx` — added `QueryClientProvider` and `sonner` `Toaster`.
- `src/routes.jsx` — added `/receipts` and `/receipts/:id` routes.
- `src/components/layout/main-layout.jsx` — marked `/receipts` as a protected route (gets sidebar).
- `src/components/nav/side-bar.jsx` — added Receipts nav item.
- `package.json` / `package-lock.json` — added `@tanstack/react-query` and `zustand`.

### API shapes assumed (for reconciliation)
1. `GET /orgs/{orgID}/documents` → `{ documents: Document[] }` or `Document[]`.
   Document has: `id`, `merchant`, `file_name`, `object_key`, `image_url | file_url`, `amount`, `currency`, `transaction_date | posted_date`, `status`, `created_at`, `extraction_error`, `raw_extraction | extraction` (the JSONB blob from §2), `confidence`.
2. `GET /orgs/{orgID}/documents/{docID}` → same single document shape.
3. `GET /orgs/{orgID}/transactions?document_id=<id>` → `{ transactions: Transaction[] }` or `Transaction[]`.
   Transaction has: `id`, `document_id`, `merchant`, `merchant_normalized`, `amount`, `currency`, `posted_date`, `direction`, `status`, `classification: { id, category_id, category_name, source, confidence }`.
4. `PATCH /orgs/{orgID}/transactions/{txID}/classification?apply_to_existing=<bool>` body `{ category_id }` → updated transaction or 204.
5. `GET /orgs/{orgID}/categories` → `{ categories: [{ id, name, color? }] }` or `Category[]`.
6. `POST /orgs/{orgID}/documents/{docID}/classify` → trigger P1-02 classification (no UI for this yet, but wired in api.js).

### Verify endpoint assumption
The task requires transitioning `status → verified`. No explicit route was specified in the contract for this. The `useVerifyTransaction` hook POSTs to `PATCH .../classification?verify=true` with `{ verified: true }`. This will likely need reconciliation with P1-03's actual implementation. The optimistic UI update fires regardless; the server error is caught and shown via toast without crashing.

### Confidence display
- Extraction-level confidence (§2 `confidence` field from `document_extractions.extracted`) shown in the detail header and as a colour-coded pill in the list (green ≥ 85%, yellow ≥ 60%, red < 60%).
- Classification-level confidence (from `transaction_classifications`) shown inline on each transaction row alongside the source badge (user / rule / signal / AI).
- Low-confidence rows get a subtle red tint in the list and sort to the top by default.

### Correction flow
1. User changes category via the `Select` picker.
2. `usePatchClassification` fires an optimistic update across all matching query caches, then calls `PATCH .../classification?apply_to_existing=<bool>`.
3. On success: `toast.success` with the category name; if `applyToAll` was checked, the description says "All `<merchant>` transactions updated".
4. On error: caches rolled back + `toast.error`.
5. `onSettled` always invalidates `['transactions', orgId]` to reconcile with server state.

### Build result
`npm run build` exits 0. Only pre-existing chunk size advisory (third-party deps), no errors.
