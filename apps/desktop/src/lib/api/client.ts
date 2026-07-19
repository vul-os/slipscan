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
  Book,
  Budget,
  BudgetUpsert,
  BudgetWithSpend,
  Category,
  DataMoveRequest,
  DataStatus,
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
  ReconConfirmRequest,
  ReconSuggestion,
  RegionInfo,
  Settings,
  SpendingReport,
  Transaction,
  TransactionListQuery,
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
};

export type Api = typeof api;
