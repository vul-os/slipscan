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

/**
 * One file captured by a drop, normalized to what `DropCapture.svelte`
 * could actually get out of it:
 *
 *   - `path` — a real absolute path, the only thing Tauri's webview
 *     file-drop event hands over (see DropCapture.svelte's own doc comment
 *     for why that is the mechanism, not DOM `ondrop`).
 *   - `bytes` — already-read file content, the DOM drag-and-drop fallback
 *     used outside Tauri (plain browser dev, every Playwright spec).
 *   - `oversized` — a `bytes`-path file DropCapture declined to read into
 *     memory at all, because it already exceeded `MAX_IMPORT_BYTES`.
 *
 * Either way, nothing here decides whether the *type* is importable — that
 * answer comes back from `document_import` itself, off
 * `crates/slipscan-ingest/src/import.rs`'s accepted-extension list.
 */
export type DroppedFile =
  | { kind: "path"; path: string }
  | { kind: "bytes"; name: string; mimeType: string; bytesBase64: string }
  | { kind: "oversized"; name: string; sizeBytes: number };

export type Intent =
  /** Receipts: open the import picker on arrival. */
  | { kind: "import-receipt" }
  /** Receipts: import files captured by a drop, from anywhere in the app. */
  | { kind: "import-dropped-files"; files: DroppedFile[] }
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
  "import-dropped-files": "receipts",
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
