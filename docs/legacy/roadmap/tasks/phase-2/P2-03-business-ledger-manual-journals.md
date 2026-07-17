---
id: P2-03
title: Business — ledger, chart of accounts & manual journals
phase: 2
status: review
depends_on: [P2-01]
owner: sonnet-agent
---

## Goal
For business orgs, deliver the Xero-style core: a chart of accounts, a
double-entry general ledger fed by classified transactions, manual journal
entries, and contacts (customers/suppliers). This is the business-side product
and the foundation for reporting (P2-04) and Xero export (P2-05).

## Context
The schema already models this fully: `accounts`, `ledger_entries`,
`manual_journals`, `contacts`, `tax_rates`, plus invoices/bills. This task builds
the store/handler/UI to make the ledger real and ensures classified transactions
post to it correctly (double-entry).

## Existing assets
- Tables: `accounts` (`account_type`), `ledger_entries` (`ledger_source_type`),
  `manual_journals`, `tax_rates`, `contacts` (`contact_kind`), `transactions`,
  `transaction_classifications`, `transaction_splits` (`…0003_accounting.sql`).
- P1-02 default chart-of-accounts seed for business orgs.

## Scope
**In:** chart-of-accounts CRUD; posting classified transactions to
`ledger_entries` as balanced double-entry; manual journal CRUD (must balance);
contacts CRUD; a ledger/account-transactions view; trial-balance query.
**Out:** invoices/bills lifecycle (separate follow-up; tables exist), bank feeds
(P3), tax filing. Reporting views are P2-04.

## Implementation
1. Accounts: CRUD on `accounts`; enforce `account_type`; protect seeded system
   accounts from deletion.
2. **Posting:** when a business transaction is classified/verified, generate
   balanced `ledger_entries` (debit/credit) referencing the account from the
   classification (and a default counter-account, e.g. bank/clearing). Reverse on
   re-classification. Use `ledger_source_type='transaction'`.
3. Manual journals: CRUD on `manual_journals` + `ledger_entries`
   (`ledger_source_type='manual_journal'`); reject unbalanced entries
   (Σdebits = Σcredits).
4. Contacts: CRUD on `contacts`; link to transactions where known.
5. Queries: account ledger (entries for an account over a period), trial balance
   (all accounts' debit/credit totals; must net to zero).
6. UI (business-gated): chart of accounts, manual-journal entry form, account
   ledger drill-down, trial balance.

## Acceptance criteria
- [ ] A verified business transaction posts balanced `ledger_entries`; trial
      balance nets to zero.
- [ ] Re-classifying a transaction reverses the old posting and writes the new one.
- [ ] Manual journals reject unbalanced input and post when balanced.
- [ ] Contacts CRUD works and links to transactions.
- [ ] Account ledger + trial-balance endpoints return correct figures; UI renders
      them (business-gated); `go build` + `npm run build` clean.

## Tests
- Backend: double-entry balance invariant (posting + reversal), trial-balance =
  zero, manual-journal balance enforcement.
- Frontend: manual walkthrough of journal entry + ledger drill-down.

## Notes
Double-entry correctness is non-negotiable — every code path that writes
`ledger_entries` must balance or fail. This is the integrity backbone for P2-04
reports and P2-05 Xero export.

---
**Implementation summary (sonnet-agent, 2026-05-21)**

New package `backend/internal/ledger` (store.go + handlers.go + ledger_test.go).

**Store layer** (`ledger.Store`):
- Chart-of-accounts CRUD: `ListAccounts`, `GetAccount`, `CreateAccount`, `UpdateAccount` (blocks name/code changes on `is_system` accounts), `DeleteAccount` (blocks on `is_system`).
- Double-entry posting: `PostTransaction` — on a `verified` transaction with a classification account, deletes any prior entries and writes two balanced `ledger_entries` rows (DR expense / CR bank for debits; DR bank / CR income for credits). Counter-account resolves via code `090` (Bank Accounts) with fallback to first asset account.
- `ReverseTransaction` — removes all `source_type='transaction'` entries for a given transaction.
- Manual journal CRUD: `CreateManualJournal` validates Σdebit=Σcredit (returns `ErrUnbalanced`/`ErrNoLines`/`ErrInvalidAmount`) then writes `manual_journals` + `ledger_entries` atomically; `GetManualJournal` (with lines), `ListManualJournals`, `DeleteManualJournal` (cascades entries).
- Contacts CRUD: `CreateContact`, `GetContact`, `ListContacts`, `UpdateContact`, `DeleteContact`.
- Queries: `AccountLedger` (entries for one account, optional date range), `TrialBalance` (all accounts' DR/CR totals; well-formed ledger nets to zero).

**Routes added (all `authedMember`, grouped `// P2-03`)**:
```
GET/POST        /orgs/{orgID}/accounts
GET/PATCH/DELETE /orgs/{orgID}/accounts/{accountID}
GET             /orgs/{orgID}/accounts/{accountID}/ledger
GET             /orgs/{orgID}/trial-balance
POST            /orgs/{orgID}/transactions/{txID}/post
GET/POST        /orgs/{orgID}/journals
GET/DELETE      /orgs/{orgID}/journals/{journalID}
GET/POST        /orgs/{orgID}/contacts
GET/PATCH/DELETE /orgs/{orgID}/contacts/{contactID}
```

**Tests** (15/15 pass, `go test ./internal/ledger/... -v`):
- `validateJournalLines`: balanced, unbalanced, too-few-lines, both-sides-set, neither-set, multiline, floating-point epsilon.
- Double-entry balance invariant: expense posting, income posting, reversal-then-repost nets to zero.
- `TestTrialBalanceNetToZero`: grand Σdebit = Σcredit across multiple balanced journals.
- `TestManualJournalBalanceEnforcement`: table-driven (5 sub-cases).
- `TestAccountLedgerDateRange`: inclusive date-range filter logic.

`go build ./... && go vet ./...` clean.
