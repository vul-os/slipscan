/**
 * Tiny hand-rolled hash router — no dependency, per the architecture contract.
 * Routes are flat ids; the hash is `#/<id>`. Works in Tauri and plain browser.
 */

export const ROUTES = [
  "dashboard",
  "transactions",
  "receipts",
  "budgets",
  "ledger",
  "reconcile",
  "payments",
  "reports",
  "settings",
] as const;

export type RouteId = (typeof ROUTES)[number];

const DEFAULT_ROUTE: RouteId = "dashboard";

function fromHash(): RouteId {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  return (ROUTES as readonly string[]).includes(raw)
    ? (raw as RouteId)
    : DEFAULT_ROUTE;
}

class Router {
  current: RouteId = $state(fromHash());

  constructor() {
    window.addEventListener("hashchange", () => {
      this.current = fromHash();
    });
  }

  go(route: RouteId): void {
    window.location.hash = `/${route}`;
    // hashchange won't fire if the hash is unchanged; keep state in sync.
    this.current = route;
  }
}

export const router = new Router();
