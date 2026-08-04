/**
 * One-shot intent hand-off between the shell and a screen.
 *
 * The command palette can navigate on its own, but "New transaction" means
 * more than "show me Transactions" — it means arrive with the composer
 * open. The palette cannot reach into a screen (screens mount fresh on every
 * navigation), so it leaves an intent here and the screen claims it on mount.
 *
 * Deliberately *claim-once*: `takeIntent` clears what it returns, so an
 * intent cannot fire again on the next visit to the screen. An intent nobody
 * claims is simply dropped on the next navigation — a screen that has not
 * wired one up degrades to plain navigation rather than breaking.
 *
 * This is the same shape as `globalSearch` in search.svelte.ts (which stays
 * as it is: that value is a *filter*, read repeatedly, not a one-shot).
 */

import type { RouteId } from "./router.svelte";

/** Which Settings tab to land on (mirrors the tab strip in Settings.svelte). */
export type SettingsTab = "general" | "data" | "connections" | "vault";

export type Intent =
  /** Receipts: open the import picker on arrival. */
  | { kind: "import-receipt" }
  /** Transactions: open the new-transaction composer on arrival. */
  | { kind: "new-transaction" }
  /** Packs: open the install-a-pack panel on arrival. */
  | { kind: "install-pack" }
  /** Reconcile: run matching on arrival instead of waiting for the button. */
  | { kind: "run-reconcile" }
  /** Settings: select a tab on arrival. */
  | { kind: "settings-tab"; tab: SettingsTab }
  /** Transactions: scroll to and expand one row. */
  | { kind: "reveal-transaction"; id: string };

/** Which screen is expected to claim each intent. */
const OWNER: Record<Intent["kind"], RouteId> = {
  "import-receipt": "receipts",
  "new-transaction": "transactions",
  "install-pack": "packs",
  "run-reconcile": "reconcile",
  "settings-tab": "settings",
  "reveal-transaction": "transactions",
};

export function intentRoute(kind: Intent["kind"]): RouteId {
  return OWNER[kind];
}

const store = $state<{ pending: Intent | null }>({ pending: null });

/** Park an intent for the screen that owns it. Replaces any unclaimed one. */
export function requestIntent(intent: Intent): void {
  store.pending = intent;
}

/**
 * Claim the pending intent if it is of `kind`, clearing it. Returns `null`
 * otherwise, so a screen can ask for exactly what it knows how to handle.
 */
export function takeIntent<K extends Intent["kind"]>(
  kind: K,
): Extract<Intent, { kind: K }> | null {
  const pending = store.pending;
  if (!pending || pending.kind !== kind) return null;
  store.pending = null;
  return pending as Extract<Intent, { kind: K }>;
}

/** Read without claiming — for tests and for debugging the hand-off. */
export function peekIntent(): Intent | null {
  return store.pending;
}

/** Drop any unclaimed intent (the shell does this when the user navigates
 * somewhere the intent was not meant for). */
export function clearIntent(): void {
  store.pending = null;
}
