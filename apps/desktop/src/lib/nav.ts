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
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * Eleven destinations is more than reads as one list, so the rail is
 * grouped: what the money did, what the books say, and what the machine is
 * set up with.
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
