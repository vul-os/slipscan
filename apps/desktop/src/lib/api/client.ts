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
import type {
  Account,
  Book,
  Budget,
  BudgetUpsert,
  BudgetWithSpend,
  Category,
  Document,
  DocumentImportRequest,
  Health,
  IncomeExpenseReport,
  JournalEntry,
  JournalPostRequest,
  LedgerAccount,
  ReconConfirmRequest,
  ReconSuggestion,
  Settings,
  SpendingReport,
  Transaction,
  TransactionListQuery,
  TrialBalance,
  VatSummary,
} from "./types";

export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True once any call has fallen back to mock data while under Tauri. */
export let usedMockFallback = false;

async function call<T>(
  command: string,
  args: Record<string, unknown>,
  mock: () => Promise<T>,
): Promise<T> {
  if (!isTauri) return mock();
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    // Core not wired yet (or command missing): keep the shell usable.
    usedMockFallback = true;
    console.warn(`[api] ${command} unavailable, using mock data:`, err);
    return mock();
  }
}

export const api = {
  health: (): Promise<Health> => call("health", {}, mockApi.health),

  bookList: (): Promise<Book[]> => call("book_list", {}, mockApi.book_list),

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

  settingsGet: (): Promise<Settings> =>
    call("settings_get", {}, mockApi.settings_get),

  settingsSet: (q: { settings: Settings }): Promise<Settings> =>
    call("settings_set", { query: q }, () => mockApi.settings_set(q)),
};

export type Api = typeof api;
