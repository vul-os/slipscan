# Phase 1 frontend + Phase 2 onboarding — integration contract

The shared layer (api client, query hooks, formatters, routing) is **already
committed on the base branch**. Each agent owns ONE page file and only *reads*
the shared layer — do NOT edit `src/lib/*` or routing/store files (that's what
collided last time). This is what makes parallel frontend agents safe.

## Shared layer — already done (import, don't edit)

- **`src/lib/api.js`** — JWT api client (token from `useAuthStore`, auto-refresh).
  Phase 1 methods: `triggerExtract(orgId,docId)`, `classifyDocument(orgId,docId)`,
  `listTransactions(orgId,{limit,offset})`, `listCategories(orgId)`,
  `patchClassification(orgId,txId,{categoryId,accountId},{applyToExisting})`.
  Plus existing `listDocuments`, `getDocument`, `uploadDocument`, `register`,
  `createOrg`, etc.
- **`src/lib/queries.js`** — TanStack hooks: `useDocuments(orgId)`,
  `useDocument(orgId,docId)`, `useTransactions(orgId)` (returns array, each item
  has inline classification), `useCategories(orgId)`, `useClassifyDocument(orgId)`,
  `useTriggerExtract(orgId)`, `usePatchClassification(orgId)` (optimistic; vars
  `{txId, categoryId, categoryName?, accountId?, applyToExisting?}`).
- **`src/lib/format.js`** — `formatMoney`, `formatDate`, `formatConfidence(0..1)`,
  `confidenceLevel(0..1) → "high"|"medium"|"low"|"unknown"` (high≥.85, med≥.60).
- **Active org id**: `useOrgStore().activeOrgId`. **Auth**: `useAuthStore()`.
- **Routing** (`src/routes/AppRoutes.jsx`) already maps `/receipts`,
  `/receipts/:id`, `/onboarding`, `/settings` to the page files below. Don't edit it.
- UI primitives: `src/components/ui/*` (Card, Badge, Dialog, DropdownMenu,
  Select, Skeleton, Button, Input, Label), `StatusPill`, `sonner` toasts.

## Backend shapes (real, from the Go handlers)

- `GET /orgs/{orgID}/transactions` → `{ transactions: [ {id, document_id,
  merchant, merchant_normalized, description, amount, currency, posted_date,
  direction, status, classification_source, classification_confidence,
  category_id, category_name} ] }`. **No server-side document filter yet** —
  filter client-side on `document_id` for the detail view.
- `GET /orgs/{orgID}/categories` → `{ categories: [ {id, parent_id, name, kind,
  icon, color} ] }`.
- `GET /orgs/{orgID}/documents` / `…/documents/{docID}` → existing document shape;
  the extraction blob is on the document (`extraction`/`raw_extraction`) per
  PHASE1-CONTRACT §2 (kind, merchant, total, currency, confidence, line_items…).
- `POST …/documents/{docID}/extract` and `…/classify` return updated data.
- `PATCH …/transactions/{txID}/classification?apply_to_existing=` body
  `{category_id}` → `{correction_id, classification_id, rule_promoted, rule_id?,
  backfill?}`.
- There is **no verify endpoint** — skip a "verified" action for now, or wire it
  later; do not invent one.

## Page ownership (one agent each — only edit your file)

| Agent | Owns (edit only this) | Reads |
|---|---|---|
| FE-1 Receipts list | `src/pages/Receipts.jsx` (+ may add a Receipts link to `src/components/Sidebar.jsx`) | useDocuments, useTransactions, format |
| FE-2 Receipt detail | `src/pages/ReceiptDetail.jsx` | useDocument, useTransactions (filter by document_id), useCategories, usePatchClassification, useClassifyDocument, useTriggerExtract |
| FE-3 Onboarding (P2-01) | `src/pages/Onboarding.jsx`, `src/pages/Register.jsx` | api.register/createOrg |
| FE-4 Settings | `src/pages/Settings.jsx` | useOrgs (show org.rx_local_part inbound email), org profile |
| FE-5 Tests | `vitest.config.js`/test files under `src/**/__tests__`, `package.json` devDeps | everything (mock api) |

Rule: never edit `src/lib/*`, `src/routes/AppRoutes.jsx`, `src/main.jsx`, or
another agent's page. `npm run build` MUST pass. Match Tailwind + Radix style.
