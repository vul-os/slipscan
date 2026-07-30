/**
 * Typed API client for the slipscan-core service surface.
 *
 * Under Tauri, every call goes through `invoke()` using the contract command
 * names (book_list, transaction_list, …). Outside Tauri (plain `vite dev` in
 * a browser) — or while a command is not wired into src-tauri yet — calls
 * transparently fall back to the in-memory mock dataset so the UI always runs.
 */
import { invoke } from "@tauri-apps/api/core";
import { mockApi } from "./mock";
import { apiStatus } from "./status.svelte";
import type {
  Account,
  BenchmarkReport,
  Book,
  Budget,
  BudgetUpsert,
  BudgetWithSpend,
  Category,
  DataMoveRequest,
  DataStatus,
  DeviceIdentity,
  DevicePeer,
  DeviceRotateResult,
  DeviceRotation,
  Document,
  DocumentImportRequest,
  FxConversion,
  FxQuote,
  FxStatus,
  Health,
  IncomeExpenseReport,
  JournalEntry,
  JournalPostRequest,
  LedgerAccount,
  Member,
  MemberAmountRow,
  MemberCategoryRow,
  MemberPatch,
  MemberSettleRow,
  NewBook,
  NewMember,
  InstalledPackInfo,
  NewPayEndpoint,
  NewPayWatch,
  PackDocumentRequest,
  PackInstallOutcome,
  PackOffer,
  PackSourceInfo,
  PackVerification,
  PairingAcceptance,
  PairingInvite,
  PairingInviteMeta,
  PairRedeemRequest,
  PayDelivery,
  PayEndpoint,
  PayEndpointWithSecret,
  PayMatch,
  PayWatch,
  ReconConfirmRequest,
  ReconSuggestion,
  RegionInfo,
  Settings,
  SpendingReport,
  SplitShare,
  Transaction,
  TransactionListQuery,
  TransactionSplit,
  TrialBalance,
  VatRate,
  VatSummary,
  VaultCredentialMeta,
  VaultReplaceRequest,
  VaultSetRequest,
} from "./types";

export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True only for "this command is not registered at all" errors — real
 * domain errors (validation, not-found, unbalanced journal) must surface. */
function isCommandMissing(command: string, err: unknown): boolean {
  return String(err).includes(`Command ${command} not found`);
}

async function call<T>(
  command: string,
  args: Record<string, unknown>,
  mock: () => Promise<T>,
): Promise<T> {
  if (!isTauri) return mock();
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    if (!isCommandMissing(command, err)) throw err;
    // Command not wired into src-tauri yet: keep the shell usable, but flag
    // it — the sidebar shows a "mock" badge so fake data is never silent.
    apiStatus.usedMockFallback = true;
    console.warn(`[api] ${command} unavailable, using mock data:`, err);
    return mock();
  }
}

export const api = {
  health: (): Promise<Health> => call("health", {}, mockApi.health),

  bookList: (): Promise<Book[]> => call("book_list", {}, mockApi.book_list),

  /** Create a book and seed it (chart of accounts + starter categories) from
   * the region profile it was created with — the command is what first-run
   * setup calls to turn the region and currency the user picked into an
   * actual book. Nothing jurisdictional is chosen here: `region` is an id the
   * caller took from `regionList`, and core rejects one it does not know. */
  bookCreate: (q: NewBook): Promise<Book> =>
    call("book_create", { query: q }, () => mockApi.book_create(q)),

  // -- data folder: one movable folder holds everything durable. Backup is
  // the user's own cloud syncing that folder; SlipScan ships no backup
  // service. --

  dataStatus: (): Promise<DataStatus> =>
    call("data_status", {}, mockApi.data_status),

  /** Single await for the whole copy→verify→switch→cleanup sequence; while
   * it is pending the app is read-only (other commands block on the move). */
  dataMove: (q: DataMoveRequest): Promise<DataStatus> =>
    call("data_move", { query: q }, () => mockApi.data_move(q)),

  accountList: (q: { book_id: string }): Promise<Account[]> =>
    call("account_list", { query: q }, () => mockApi.account_list(q)),

  transactionList: (q: TransactionListQuery): Promise<Transaction[]> =>
    call("transaction_list", { query: q }, () => mockApi.transaction_list(q)),

  transactionCategorize: (q: {
    transaction_id: string;
    category_id: string | null;
  }): Promise<Transaction> =>
    call("transaction_categorize", { query: q }, () =>
      mockApi.transaction_categorize(q),
    ),

  categoryList: (q: { book_id: string }): Promise<Category[]> =>
    call("category_list", { query: q }, () => mockApi.category_list(q)),

  // -- household members & per-person attribution: local data, never a
  // login. A book with zero members works unchanged. --

  memberList: (q: { book_id: string }): Promise<Member[]> =>
    call("member_list", { query: q }, () => mockApi.member_list(q)),

  memberAdd: (q: NewMember): Promise<Member> =>
    call("member_add", { query: q }, () => mockApi.member_add(q)),

  memberUpdate: (q: MemberPatch): Promise<Member> =>
    call("member_update", { query: q }, () => mockApi.member_update(q)),

  memberRemove: (q: { id: string; reassign_to?: string }): Promise<null> =>
    call("member_remove", { query: q }, () => mockApi.member_remove(q)),

  /** Override (or clear, with `member_id: null`) a transaction's
   * attribution — metadata only, never touches amount/currency/category. */
  transactionAttribute: (q: {
    transaction_id: string;
    member_id: string | null;
  }): Promise<Transaction> =>
    call("transaction_attribute", { query: q }, () =>
      mockApi.transaction_attribute(q),
    ),

  transactionSplitsList: (q: {
    transaction_id: string;
  }): Promise<TransactionSplit[]> =>
    call("transaction_splits_list", { query: q }, () =>
      mockApi.transaction_splits_list(q),
    ),

  /** Replace a transaction's split set; an empty `shares` array clears it. */
  transactionSplitSet: (q: {
    transaction_id: string;
    shares: SplitShare[];
  }): Promise<TransactionSplit[]> =>
    call("transaction_split_set", { query: q }, () =>
      mockApi.transaction_split_set(q),
    ),

  reportMemberExpense: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberAmountRow[]> =>
    call("report_member_expense", { query: q }, () =>
      mockApi.report_member_expense(q),
    ),

  reportMemberContribution: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberAmountRow[]> =>
    call("report_member_contribution", { query: q }, () =>
      mockApi.report_member_contribution(q),
    ),

  reportMemberCategory: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberCategoryRow[]> =>
    call("report_member_category", { query: q }, () =>
      mockApi.report_member_category(q),
    ),

  reportSettleUp: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<MemberSettleRow[]> =>
    call("report_settle_up", { query: q }, () => mockApi.report_settle_up(q)),

  budgetList: (q: {
    book_id: string;
    month: string;
  }): Promise<BudgetWithSpend[]> =>
    call("budget_list", { query: q }, () => mockApi.budget_list(q)),

  budgetUpsert: (q: BudgetUpsert): Promise<Budget> =>
    call("budget_upsert", { query: q }, () => mockApi.budget_upsert(q)),

  documentList: (q: { book_id: string }): Promise<Document[]> =>
    call("document_list", { query: q }, () => mockApi.document_list(q)),

  documentGet: (q: { document_id: string }): Promise<Document> =>
    call("document_get", { query: q }, () => mockApi.document_get(q)),

  documentImport: (q: DocumentImportRequest): Promise<Document> =>
    call("document_import", { query: q }, () => mockApi.document_import(q)),

  ledgerAccountList: (q: { book_id: string }): Promise<LedgerAccount[]> =>
    call("ledger_account_list", { query: q }, () =>
      mockApi.ledger_account_list(q),
    ),

  journalList: (q: { book_id: string }): Promise<JournalEntry[]> =>
    call("journal_list", { query: q }, () => mockApi.journal_list(q)),

  journalPost: (q: JournalPostRequest): Promise<JournalEntry> =>
    call("journal_post", { query: q }, () => mockApi.journal_post(q)),

  reconSuggest: (q: { book_id: string }): Promise<ReconSuggestion[]> =>
    call("recon_suggest", { query: q }, () => mockApi.recon_suggest(q)),

  reconConfirm: (q: ReconConfirmRequest): Promise<ReconSuggestion> =>
    call("recon_confirm", { query: q }, () => mockApi.recon_confirm(q)),

  reportSpending: (q: {
    book_id: string;
    from: string;
    to: string;
  }): Promise<SpendingReport> =>
    call("report_spending", { query: q }, () => mockApi.report_spending(q)),

  reportIncomeExpense: (q: { book_id: string }): Promise<IncomeExpenseReport> =>
    call("report_income_expense", { query: q }, () =>
      mockApi.report_income_expense(q),
    ),

  reportVatSummary: (q: {
    book_id: string;
    period: string;
  }): Promise<VatSummary> =>
    call("report_vat_summary", { query: q }, () =>
      mockApi.report_vat_summary(q),
    ),

  reportTrialBalance: (q: { book_id: string }): Promise<TrialBalance> =>
    call("report_trial_balance", { query: q }, () =>
      mockApi.report_trial_balance(q),
    ),

  regionList: (): Promise<RegionInfo[]> =>
    call("region_list", {}, mockApi.region_list),

  // -- tax rates: listed and configurable per book (the generic profile's
  // standard rate is a placeholder until the user sets it) --

  vatRateList: (q: { book_id: string }): Promise<VatRate[]> =>
    call("vat_rate_list", { query: q }, () => mockApi.vat_rate_list(q)),

  vatRateSetBps: (q: {
    book_id: string;
    code: string;
    rate_bps: number;
  }): Promise<VatRate> =>
    call("vat_rate_set_bps", { query: q }, () => mockApi.vat_rate_set_bps(q)),

  // -- FX (OpenRate): opt-in. Only fxFetchRate touches the network, and only
  // on an explicit user action against the configured endpoint. --

  fxStatus: (): Promise<FxStatus> => call("fx_status", {}, mockApi.fx_status),

  fxConfigure: (q: { base_url: string }): Promise<FxStatus> =>
    call("fx_configure", { query: q }, () => mockApi.fx_configure(q)),

  fxFetchRate: (q: { from: string; to: string }): Promise<FxQuote> =>
    call("fx_fetch_rate", { query: q }, () => mockApi.fx_fetch_rate(q)),

  fxConvert: (q: {
    from: string;
    to: string;
    amount_minor: number;
    /** Optional pinned decimal rate: replays a booked conversion exactly
     * instead of using the current cached rate. */
    rate?: string;
  }): Promise<FxConversion> =>
    call("fx_convert", { query: q }, () => mockApi.fx_convert(q)),

  // -- Payments: watch reference codes on inbound transactions, fire signed
  // webhooks. Only payDeliverDue touches the network — on explicit user
  // action, and only to endpoints the user registered. --

  payWatchList: (q: { book_id: string }): Promise<PayWatch[]> =>
    call("pay_watch_list", { query: q }, () => mockApi.pay_watch_list(q)),

  payWatchAdd: (q: NewPayWatch): Promise<PayWatch> =>
    call("pay_watch_add", { query: q }, () => mockApi.pay_watch_add(q)),

  payWatchRemove: (q: { watch_id: string }): Promise<null> =>
    call("pay_watch_remove", { query: q }, () => mockApi.pay_watch_remove(q)),

  payWatchSetEnabled: (q: {
    watch_id: string;
    enabled: boolean;
  }): Promise<PayWatch> =>
    call("pay_watch_set_enabled", { query: q }, () =>
      mockApi.pay_watch_set_enabled(q),
    ),

  payEndpointList: (q: { book_id: string }): Promise<PayEndpoint[]> =>
    call("pay_endpoint_list", { query: q }, () => mockApi.pay_endpoint_list(q)),

  /** The response carries the signing secret EXACTLY ONCE — show it, let the
   * user copy it, then drop it from state. It can never be read back. */
  payEndpointAdd: (q: NewPayEndpoint): Promise<PayEndpointWithSecret> =>
    call("pay_endpoint_add", { query: q }, () => mockApi.pay_endpoint_add(q)),

  /** Same single-display contract as payEndpointAdd; the old secret is
   * destroyed. */
  payEndpointRotateSecret: (q: {
    endpoint_id: string;
  }): Promise<PayEndpointWithSecret> =>
    call("pay_endpoint_rotate_secret", { query: q }, () =>
      mockApi.pay_endpoint_rotate_secret(q),
    ),

  /** Removes the endpoint (queued deliveries cascade) and revokes its
   * vault-held signing secret. */
  payEndpointRemove: (q: { endpoint_id: string }): Promise<null> =>
    call("pay_endpoint_remove", { query: q }, () =>
      mockApi.pay_endpoint_remove(q),
    ),

  payEndpointSetEnabled: (q: {
    endpoint_id: string;
    enabled: boolean;
  }): Promise<PayEndpoint> =>
    call("pay_endpoint_set_enabled", { query: q }, () =>
      mockApi.pay_endpoint_set_enabled(q),
    ),

  payMatchList: (q: { book_id: string }): Promise<PayMatch[]> =>
    call("pay_match_list", { query: q }, () => mockApi.pay_match_list(q)),

  payDeliveryList: (q: { book_id: string }): Promise<PayDelivery[]> =>
    call("pay_delivery_list", { query: q }, () => mockApi.pay_delivery_list(q)),

  /** POST every due pending delivery now (signed in core's vault); returns
   * the deliveries acted on, updated. */
  payDeliverDue: (): Promise<PayDelivery[]> =>
    call("pay_deliver_due", {}, mockApi.pay_deliver_due),

  // -- classification packs: rules, never data. Every install goes through
  // verify → TOFU trust → Installer, so a signer change is a refusal and
  // versions only move forward. Nothing here touches the network: a pack is
  // a file the user already holds. --

  packList: (q: { book_id: string }): Promise<InstalledPackInfo[]> =>
    call("pack_list", { query: q }, () => mockApi.pack_list(q)),

  /** Preflight: verifies the signature and reports the signer's fingerprint
   * and what installing would do. Writes nothing — call it before
   * `packInstall` so the trust-on-first-use decision is an informed one. */
  packVerify: (q: PackDocumentRequest): Promise<PackVerification> =>
    call("pack_verify", { query: q }, () => mockApi.pack_verify(q)),

  /** Verify and install (or upgrade). Passing the publisher's key *is* the
   * trust decision; the pack id is pinned to it from then on. */
  packInstall: (q: PackDocumentRequest): Promise<PackInstallOutcome> =>
    call("pack_install", { query: q }, () => mockApi.pack_install(q)),

  /** Removes the pack's rules and registration. Categories it created stay
   * (local now) so history never breaks, and the signer pin is kept. */
  packUninstall: (q: { book_id: string; pack_id: string }): Promise<boolean> =>
    call("pack_uninstall", { query: q }, () => mockApi.pack_uninstall(q)),

  // -- pack sources: the fetch half. The same signed bytes over any
  // transport — a file, a synced folder or USB stick, a git remote, plain
  // HTTPS — because the signature is what is trusted, not the channel.
  //
  // There is no registry and no default source: the list starts empty, only
  // `packSourceAdd` ever writes to it, and until it has an entry nothing here
  // makes an outbound request. --

  /** Configured sources. Empty on a fresh install, and empty is the whole
   * privacy story: no source, no request. */
  packSourceList: (): Promise<PackSourceInfo[]> =>
    call("pack_source_list", {}, mockApi.pack_source_list),

  /** Add a source. Nothing is contacted by adding one — it is read when the
   * user asks. `uri` is `file:<path>`, `folder:<path>`, `git:<url>[#ref]` or
   * `https://<url>`; plain `http://` is refused. */
  packSourceAdd: (q: { name: string; uri: string }): Promise<PackSourceInfo> =>
    call("pack_source_add", { query: q }, () => mockApi.pack_source_add(q)),

  /** Forget a source. Installed packs are untouched — where a pack came from
   * is history, not a dependency. */
  packSourceRemove: (q: { name: string }): Promise<boolean> =>
    call("pack_source_remove", { query: q }, () => mockApi.pack_source_remove(q)),

  /** Read a source's catalogue and preflight every pack against the book.
   * **Installs nothing.** Each offer carries the catalogue's claim and, when
   * the bytes verify, the real facts — show the second, act on the second. */
  packSourceFetch: (q: { book_id: string; source: string }): Promise<PackOffer[]> =>
    call("pack_source_fetch", { query: q }, () => mockApi.pack_source_fetch(q)),

  /** Fetch one pack from a source and install it. Verification happens on the
   * bytes first. A signer this machine has never seen refuses unless
   * `accept_signer` carries the fingerprint the user was shown and checked —
   * and a pack id whose publisher key changed refuses regardless, because the
   * pin is not overridable from anywhere. */
  packSourceInstall: (q: {
    book_id: string;
    source: string;
    pack_id: string;
    document?: string;
    accept_signer?: string;
  }): Promise<PackInstallOutcome> =>
    call("pack_source_install", { query: q }, () => mockApi.pack_source_install(q)),

  /** Install the built-in seed packs into a book. **Opt-in, never automatic**
   * — which taxonomy a book starts from is the user's decision, and putting a
   * South African chart in front of someone in Portugal would be wrong.
   * Idempotent: a seed already at the same version is skipped, and categories
   * the user already has are adopted by (parent, name), never duplicated, so
   * re-running clobbers nothing. Returns only the seeds it actually wrote. */
  packInstallSeeds: (q: { book_id: string }): Promise<PackInstallOutcome[]> =>
    call("pack_install_seeds", { query: q }, () => mockApi.pack_install_seeds(q)),

  /** Compare this book's spend for one calendar month against every
   * installed benchmark pack — the read side of peer comparison, computed
   * here, transmitting nothing. `skipped` and `unmapped_keys` must be shown:
   * a pack in another currency is *not compared* (no FX is applied) and a
   * key nothing maps to is missing, and rendering either as a zero would be
   * a lie. Contribution, and the differential privacy it needs, are not
   * built (BENCHMARKS.md). */
  packBenchmark: (q: { book_id: string; period: string }): Promise<BenchmarkReport[]> =>
    call("pack_benchmark", { query: q }, () => mockApi.pack_benchmark(q)),

  settingsGet: (): Promise<Settings> =>
    call("settings_get", {}, mockApi.settings_get),

  settingsSet: (q: { settings: Settings }): Promise<Settings> =>
    call("settings_set", { query: q }, () => mockApi.settings_set(q)),

  // -- credential vault: write-only, metadata comes back, secrets never do --

  vaultList: (): Promise<VaultCredentialMeta[]> =>
    call("vault_list", {}, mockApi.vault_list),

  vaultSet: (q: VaultSetRequest): Promise<VaultCredentialMeta> =>
    call("vault_set", { query: q }, () => mockApi.vault_set(q)),

  vaultReplace: (q: VaultReplaceRequest): Promise<VaultCredentialMeta> =>
    call("vault_replace", { query: q }, () => mockApi.vault_replace(q)),

  vaultRevoke: (q: { name: string }): Promise<null> =>
    call("vault_revoke", { query: q }, () => mockApi.vault_revoke(q)),

  // -- device identity and pairing (docs/NODES.md).
  //
  // **NOTHING SYNCS YET.** Identity and pairing are real; there is no oplog
  // and no transport. Pairing two devices proves who they are and then does
  // nothing else, and every screen here must say so.
  //
  // The ceremony (invite/accept/confirm) plus init, rotate, reset and forget
  // are **local-only and exist only as IPC** — the HTTP routes of those names
  // refuse and say why: they create or destroy the private key, or they carry
  // a single-use claim token and need a human in front of the screen. Same
  // treatment vaultSet/vaultReplace already get. --

  /** This device's identity, or `null` if it has none yet. */
  deviceStatus: (): Promise<DeviceIdentity | null> =>
    call("device_status", {}, mockApi.device_status),

  /** Pinned peers, revoked tombstones included — hiding a tombstone would
   * hide the reason a re-pair is being refused. */
  deviceList: (): Promise<DevicePeer[]> =>
    call("device_list", {}, mockApi.device_list),

  deviceGet: (q: { device_id: string }): Promise<DevicePeer> =>
    call("device_get", { query: q }, () => mockApi.device_get(q)),

  /** Invites this device minted. Never carries a claim token. */
  deviceInviteList: (): Promise<PairingInviteMeta[]> =>
    call("device_invite_list", {}, mockApi.device_invite_list),

  deviceRotations: (): Promise<DeviceRotation[]> =>
    call("device_rotations", {}, mockApi.device_rotations),

  /** Revoke a peer: the pin becomes a tombstone so that key cannot silently
   * pair again. `deviceForget` is the deliberate way back. */
  deviceRevoke: (q: { device_id: string }): Promise<DevicePeer> =>
    call("device_revoke", { query: q }, () => mockApi.device_revoke(q)),

  /** Generate this device's keypair — the private half goes straight into the
   * write-only vault, the public half becomes the device id. Refused if an
   * identity already exists. */
  deviceInit: (q: { label?: string }): Promise<DeviceIdentity> =>
    call("device_init", { query: q }, () => mockApi.device_init(q)),

  /** Rotate this device's key, signed by the key it replaces. The device id
   * changes, so peers' pins of this device go stale — and nothing re-pairs
   * them, because there is no transport to do it over. */
  deviceRotate: (): Promise<DeviceRotateResult> =>
    call("device_rotate", {}, mockApi.device_rotate),

  /** Destroy this device's private key and identity. Peer pins are kept.
   * `confirm` is required — it cannot be undone and the key cannot be
   * recovered from a backup of the data folder. */
  deviceReset: (q: { confirm: boolean }): Promise<null> =>
    call("device_reset", { query: q }, () => mockApi.device_reset(q)),

  /** Drop a peer's pin entirely, tombstone included — the deliberate local
   * reset that lets a revoked key pair again. */
  deviceForget: (q: { device_id: string }): Promise<boolean> =>
    call("device_forget", { query: q }, () => mockApi.device_forget(q)),

  /** Mint a single-use pairing invite. The returned `blob` **is a credential**
   * until redeemed or expired: show it, let it be copied, then drop it. */
  devicePairInvite: (q: {
    label?: string;
    ttl_seconds?: number;
  }): Promise<PairingInvite> =>
    call("device_pair_invite", { query: q }, () => mockApi.device_pair_invite(q)),

  /** Withdraw an unredeemed invite — the answer to "that blob went to the
   * wrong window". */
  deviceInviteCancel: (q: { id: string }): Promise<boolean> =>
    call("device_invite_cancel", { query: q }, () =>
      mockApi.device_invite_cancel(q),
    ),

  /** Redeem an invite: pins the inviter and returns the acceptance blob to
   * carry back. The key-name check is **mandatory** — pass the key-name the
   * user typed, or `confirmed_by_human` only if this screen displayed it and
   * got an affirmative. Supplying neither is refused by the backend. */
  devicePairAccept: (q: PairRedeemRequest): Promise<PairingAcceptance> =>
    call("device_pair_accept", { query: q }, () => mockApi.device_pair_accept(q)),

  /** Redeem the acceptance blob: burns the single-use claim token and pins the
   * accepter. Same mandatory key-name check. */
  devicePairConfirm: (q: PairRedeemRequest): Promise<DevicePeer> =>
    call("device_pair_confirm", { query: q }, () =>
      mockApi.device_pair_confirm(q),
    ),
};

export type Api = typeof api;
