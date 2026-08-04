/**
 * The one navigation model.
 *
 * The sidebar rail and the command palette both render destinations, and
 * before this existed each carried its own copy of the labels, icons and
 * jump letters. One list, imported by both, is the only way they cannot
 * drift apart — the same reason `ROUTES` exists in router.svelte.ts.
 *
 * The flattened order of `NAV_GROUPS` is exactly `ROUTES`; the group
 * headings are decoration around that sequence, never a re-ordering of it
 * (pinned by a test).
 */

import type { BookProfile } from "./api/types";
import type { IconName } from "./icons";
import type { RouteId } from "./router.svelte";

export interface NavItem {
  route: RouteId;
  label: string;
  icon: IconName;
  /** The letter in the `G` then <letter> jump chord — shown in the rail. */
  key: string;
  /**
   * Words a user might type looking for this screen that are not in its
   * label. Search-only: never rendered, so they can be blunt.
   */
  keywords: string;
  /**
   * A `BookProfile` flag gating this destination — omitted for one every
   * book shows. A personal book resolves every business-only flag to
   * `false`, so the sidebar hides the entry (Sidebar.svelte) and the screen
   * itself refuses the route when it is opened directly (by hash, or from
   * the command palette) rather than through the rail.
   */
  requires?: keyof BookProfile;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * More destinations than reads as one list, so the rail is grouped: what the
 * money did, what the business trades, what the books say, and what the
 * machine is set up with.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: "Money",
    items: [
      {
        route: "dashboard",
        label: "Dashboard",
        icon: "dashboard",
        key: "D",
        keywords: "home overview summary net balance start",
      },
      {
        route: "transactions",
        label: "Transactions",
        icon: "transactions",
        key: "T",
        keywords: "spend lines bank statement merchant search categorise",
      },
      {
        route: "receipts",
        label: "Receipts",
        icon: "receipt",
        key: "R",
        keywords: "slips documents invoices import scan extract",
      },
      {
        route: "budgets",
        label: "Budgets",
        icon: "budgets",
        key: "B",
        keywords: "limits caps envelopes monthly allowance",
      },
      {
        route: "household",
        label: "Household",
        icon: "wallet",
        key: "H",
        keywords: "members people who paid split share settle up",
      },
    ],
  },
  {
    // Business-only destinations, gated by `BookProfile` — a personal book
    // resolves every `requires` flag below to `false`, so this whole group
    // renders with zero visible items and Sidebar.svelte drops it rather
    // than showing an empty heading. Order within the group, across every
    // agent adding to it: Contacts, Catalogue, Stock, Purchasing, Sales.
    heading: "Trade",
    items: [
      {
        route: "contacts",
        label: "Contacts",
        icon: "contacts",
        key: "N",
        keywords:
          "customers suppliers parties company email phone address credit terms",
        requires: "show_contacts",
      },
      {
        route: "catalogue",
        label: "Catalogue",
        icon: "catalogue",
        // Not "G": that is the jump chord's own trigger key, and pairing it
        // with itself (press G, then G again) works mechanically but reads
        // as a typo waiting to happen.
        key: "U",
        keywords:
          "products variants sku price cost reorder point category attributes",
        requires: "show_catalogue",
      },
      {
        route: "stock",
        label: "Stock",
        icon: "layers",
        key: "I",
        keywords:
          "inventory on hand levels warehouse count adjustment transfer low reorder variants",
        requires: "show_catalogue",
      },
      {
        route: "purchasing",
        label: "Purchasing",
        icon: "truck",
        key: "O",
        keywords: "purchase orders suppliers goods receipt receiving po",
        requires: "show_purchasing",
      },
      {
        route: "sales",
        label: "Sales",
        icon: "cart",
        key: "V",
        keywords:
          "orders invoices invoicing customers quotes billing receivables aged",
        requires: "show_sales",
      },
    ],
  },
  {
    heading: "Books",
    items: [
      {
        route: "ledger",
        label: "Ledger",
        icon: "ledger",
        key: "L",
        keywords:
          "journal double entry chart of accounts debit credit trial balance",
      },
      {
        route: "reconcile",
        label: "Reconcile",
        icon: "reconcile",
        key: "C",
        keywords: "match slips to transactions pairs confirm suggestions",
      },
      {
        route: "payments",
        label: "Payments",
        icon: "zap",
        key: "Y",
        keywords: "webhooks watches endpoints reference codes deliveries",
      },
      {
        route: "reports",
        label: "Reports",
        icon: "reports",
        key: "P",
        keywords: "vat tax spending income expense trial balance export csv",
      },
    ],
  },
  {
    heading: "This machine",
    items: [
      {
        route: "packs",
        label: "Packs",
        icon: "package",
        key: "K",
        keywords: "classification rules taxonomy benchmark install signer seeds",
      },
      {
        route: "settings",
        label: "Settings",
        icon: "settings",
        key: "S",
        keywords:
          "preferences options data folder mailbox vault theme region currency",
      },
    ],
  },
];

/** Every destination, flattened — identical in order to `ROUTES`. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Lowercase jump letter → route, for the `G` then <letter> chord. */
export const GOTO_KEYS: Record<string, RouteId> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.key.toLowerCase(), item.route]),
);

const byRoute = new Map(NAV_ITEMS.map((item) => [item.route, item]));

/** The nav entry for a route. Total over `RouteId` — every route is in the
 * rail, and the "flattened order equals ROUTES" test guarantees it. */
export function navItem(route: RouteId): NavItem {
  const item = byRoute.get(route);
  if (!item) throw new Error(`no nav entry for route ${route}`);
  return item;
}
