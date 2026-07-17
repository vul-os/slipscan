# Screenshots

> **Honest status — read before scrolling.** The images below are **archived captures of the legacy cloud app**, kept only as a record of the visual design direction (electric-lime accent on ink neutrals, Inter for UI, Geist Mono for digits, dark-first). They show cloud-era concepts that **do not exist in this codebase and are not coming back** — workspaces, members, a signed-in user, upload-to-cloud, and an "Ask" chat view (never built in the Rust/Tauri app; not on the roadmap). The shipped desktop app's actual screens are Dashboard, Transactions, Receipts, Budgets, Ledger, Reconcile, Reports, and Settings.
>
> Current-app captures, regenerated automatically (Playwright against a seeded demo book, per the VulOS screenshotter standard), will replace this gallery; until then nothing on this page should be read as the product.

---

## Dashboard (legacy design)

![Dashboard — legacy cloud app](screenshots/dashboard.png)

The legacy home view (shown here in its empty "workspace" state). In the shipped app the Dashboard displays account balances, spend vs budget for the month, category breakdown, locally-computed nudges, and recent activity — all from your local book.

---

## Receipts (legacy design)

![Receipts — legacy cloud app](screenshots/receipts.png)

The shipped Receipts screen lists every captured slip with its extraction status (`pending → extracted → reviewed`), searchable and filterable, with local import only — the legacy "Upload receipt" cloud flow is gone.

---

## Receipt detail (legacy design)

![Receipt detail — legacy cloud app](screenshots/receipt-detail.png)

In the shipped app, an expanded slip shows extracted line items, VAT, discounts, and confidence. Corrections stay local and train your classifier.

---

## Reconcile (legacy design)

![Reconcile — legacy cloud app](screenshots/reconcile.png)

The shipped Reconcile screen scores matches between bank transactions and receipts; confirm or reject with one click, every decision audited.

---

## Ledger (legacy design)

![Ledger — legacy cloud app](screenshots/ledger.png)

The shipped Ledger screen: chart of accounts, balanced manual journals, trial balance — books that never leave your machine.

---

**Next:** [FAQ.md](FAQ.md) — the questions everyone asks, answered straight.
