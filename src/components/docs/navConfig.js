// Docs site navigation structure.
// EXISTING_PATHS: the 8 routes actually registered in AppRoutes.jsx.
// Nav items whose path is NOT in this set are rendered as disabled stubs in
// DocsSidebar — they appear in the sidebar but are greyed out (no <Link>).
export const EXISTING_PATHS = new Set([
  "/docs",
  "/docs/quickstart",
  "/docs/concepts",
  "/docs/features",
  "/docs/integrations",
  "/docs/faq",
  "/docs/security",
  "/docs/changelog",
]);

export const DOCS_NAV = [
  {
    group: "GETTING STARTED",
    items: [
      { title: "Introduction",    path: "/docs" },
      { title: "Quickstart",      path: "/docs/quickstart" },
      { title: "Concepts",        path: "/docs/concepts" },
    ],
  },
  {
    group: "FEATURES",
    items: [
      { title: "Receipts & Extraction",     path: "/docs/features/receipts" },
      { title: "Classification & Learning", path: "/docs/features/classification" },
      { title: "Ledger & Personal Vault",   path: "/docs/features/ledger" },
      { title: "Budgets & Net Worth",       path: "/docs/features/budgets" },
      { title: "Bank Feeds & Reconcile",    path: "/docs/features/reconcile" },
      { title: "Reports & Ask",             path: "/docs/features/reports" },
      { title: "Accountant Workspace",      path: "/docs/features/workspace" },
      { title: "Audit & Compliance",        path: "/docs/features/audit" },
    ],
  },
  {
    group: "INTEGRATIONS",
    items: [
      { title: "Xero",                path: "/docs/integrations/xero" },
      { title: "Stitch bank feeds",   path: "/docs/integrations/stitch" },
      { title: "Gmail forward-in",    path: "/docs/integrations/gmail" },
      { title: "API & Tokens",        path: "/docs/integrations/api" },
    ],
  },
  {
    group: "REFERENCE",
    items: [
      { title: "FAQ",         path: "/docs/faq" },
      { title: "Security",    path: "/docs/security" },
      { title: "Changelog",   path: "/docs/changelog" },
    ],
  },
];
