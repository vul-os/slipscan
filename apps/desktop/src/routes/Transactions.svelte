<script lang="ts">
  /**
   * Transactions — the book, and the one screen where classification is
   * actually taught.
   *
   * The interaction that matters most here is the merchant rule. Core has
   * always learned it (`transaction_categorize` upserts a
   * `MappingSource::User` merchant→category mapping, which outranks Rule and
   * Pack), but nothing in the UI said so, and nothing offered to fix the rows
   * that were already imported under the old answer. Both are surfaced now:
   *   - correcting one row offers, in place, to bring the rest of that
   *     merchant into line,
   *   - the row panel carries a standing "Always categorise X as …" control
   *     that previews every row it would rewrite before it rewrites one,
   *   - every batch write is undoable.
   *
   * The rest is what a book larger than a demo needs and this screen did not
   * have: a date-range filter (the shared picker), saved views, bulk select +
   * multi-edit, keyboard row navigation, and pagination.
   *
   * NOT built, and deliberately not pretended: the service surface has no
   * delete and no manual create (there is no `transaction_delete` or
   * `transaction_create` in src-tauri/src/commands.rs), so this screen offers
   * neither. The palette's "New transaction" intent is claimed here only to
   * say where transactions actually come from, rather than to open a composer
   * that could not save.
   */
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/state/router.svelte";
  import { globalSearch } from "../lib/state/search.svelte";
  import { takeIntent } from "../lib/state/intent.svelte";
  import { routeCache } from "../lib/loadCache";
  import {
    fmtDate,
    fmtMoney,
    localMonth,
    minorToInput,
    monthEnd,
    parseMoneyInput,
  } from "../lib/util/format";
  import type { DateRange } from "../lib/util/daterange";
  import type {
    Account,
    Book,
    Category,
    Member,
    SplitShare,
    Transaction,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import MemberAvatar from "../lib/components/MemberAvatar.svelte";
  import DateRangePicker from "../lib/components/DateRangePicker.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";
  import Dialog from "../lib/components/Dialog.svelte";

  /** Where a line came from, in the user's words rather than the enum's. */
  const sourceLabel: Record<Transaction["source"], string> = {
    scraper: "bank",
    email: "email",
    import: "import",
    manual: "manual",
  };

  // -------------------------------------------------------------------------
  // Filter hand-off from other screens.
  //
  // The router owns `#/<route>` and ignores anything after a `?` (see
  // `fromHash` in router.svelte.ts), which leaves the query string free as a
  // one-way channel for "open Transactions, already filtered". The dashboard
  // spends it so every figure it prints is traceable to the rows underneath.
  // Read once, on mount: it is a starting position, not a binding.
  // -------------------------------------------------------------------------

  function hashQuery(): URLSearchParams {
    return new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  }

  const entry = hashQuery();

  // The palette's search command writes here; seeding it rather than keeping a
  // second copy leaves one answer to "what is being searched for".
  if (entry.get("q")) globalSearch.query = entry.get("q") ?? "";

  let search = $state(globalSearch.query);
  let accountFilter = $state(entry.get("account") ?? "");
  let categoryFilter = $state(entry.get("category") ?? "");

  /** Off by default: a book is not a month, and "everything" is the honest
   * opening view. Switches itself on for a range handed in from elsewhere. */
  let dateOn = $state(entry.has("from") || entry.has("to"));
  let datePanelOpen = $state(false);
  const thisMonth = localMonth();
  let from = $state(entry.get("from") ?? `${thisMonth}-01`);
  let to = $state(entry.get("to") ?? monthEnd(thisMonth));

  // Pick up queries handed over by the palette's search command.
  $effect(() => {
    search = globalSearch.query;
  });

  let book = $state<Book | null>(null);
  let accounts = $state<Account[]>([]);
  let categories = $state<Category[]>([]);
  let members = $state<Member[]>([]);
  let transactions = $state<Transaction[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  interface Snapshot {
    book: Book;
    accounts: Account[];
    categories: Category[];
    members: Member[];
    transactions: Transaction[];
  }

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const b = requireBook(await api.bookList());
      book = b;
      [accounts, categories, members, transactions] = await Promise.all([
        api.accountList({ book_id: b.id }),
        api.categoryList({ book_id: b.id }),
        api.memberList({ book_id: b.id }),
        api.transactionList({ book_id: b.id }),
      ]);
      routeCache.set<Snapshot>("transactions", {
        book: b,
        accounts: $state.snapshot(accounts) as Account[],
        categories: $state.snapshot(categories) as Category[],
        members: $state.snapshot(members) as Member[],
        transactions: $state.snapshot(transactions) as Transaction[],
      });
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  // Seed from the session cache so a tab switch renders instantly, then
  // refresh in the background (stale-while-revalidate).
  {
    const cached = routeCache.get<Snapshot>("transactions");
    if (cached) {
      book = cached.book;
      accounts = cached.accounts;
      categories = cached.categories;
      members = cached.members;
      transactions = cached.transactions;
      loading = false;
      void load(true);
    } else {
      void load();
    }
  }

  function syncTransactionsCache() {
    const cached = routeCache.get<Snapshot>("transactions");
    if (cached) {
      routeCache.set<Snapshot>("transactions", {
        ...cached,
        transactions: $state.snapshot(transactions) as Transaction[],
      });
    }
  }

  // -------------------------------------------------------------------------
  // filtering and paging
  // -------------------------------------------------------------------------

  const filtered = $derived(
    transactions.filter((t) => {
      if (accountFilter && t.account_id !== accountFilter) return false;
      if (categoryFilter === "none" && t.category_id !== null) return false;
      if (
        categoryFilter &&
        categoryFilter !== "none" &&
        t.category_id !== categoryFilter
      )
        return false;
      if (dateOn) {
        // `posted_at` is an instant and the bounds are inclusive dates, so the
        // comparison is on the date part or the last day of the range is lost.
        const day = t.posted_at.slice(0, 10);
        if (day < from || day > to) return false;
      }
      if (search) {
        const s = search.toLowerCase();
        if (
          !t.description.toLowerCase().includes(s) &&
          !(t.merchant ?? "").toLowerCase().includes(s)
        )
          return false;
      }
      return true;
    }),
  );

  const outflow = $derived(
    filtered.reduce((s, t) => s + Math.min(0, t.amount_minor), 0),
  );

  /** Paged, not virtualised: one <table> holding a real book's worth of rows
   * is what makes this screen unusable, and a pager is the affordance people
   * already know how to drive from the keyboard. */
  const PAGE_SIZES = [25, 50, 100, 250];
  let pageSize = $state(50);
  let page = $state(0);
  const pageCount = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));
  const pageRows = $derived(
    filtered.slice(page * pageSize, page * pageSize + pageSize),
  );
  const firstShown = $derived(filtered.length === 0 ? 0 : page * pageSize + 1);
  const lastShown = $derived(Math.min(filtered.length, (page + 1) * pageSize));

  // Filtering down to fewer pages must not strand the view on an empty one.
  $effect(() => {
    if (page > pageCount - 1) page = pageCount - 1;
  });

  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? "—";
  const categoryName = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? "Uncategorised";
  const memberOf = (memberId: string | null): Member | null =>
    members.find((m) => m.id === memberId) ?? null;
  const labelOf = (tx: Transaction) => tx.merchant ?? tx.description;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const filtersActive = $derived(
    Boolean(search || accountFilter || categoryFilter || dateOn),
  );

  function clearFilters() {
    search = "";
    globalSearch.query = "";
    accountFilter = "";
    categoryFilter = "";
    dateOn = false;
    page = 0;
  }

  function applyRange(range: DateRange) {
    from = range.from;
    to = range.to;
    dateOn = true;
    page = 0;
  }

  // -------------------------------------------------------------------------
  // saved views
  //
  // Local only, like the theme: a view is a bookmark for a filter set, and
  // there is neither a service surface for one nor a reason to want one.
  // -------------------------------------------------------------------------

  interface SavedView {
    id: string;
    name: string;
    q: string;
    account: string;
    category: string;
    dated: boolean;
    from: string;
    to: string;
  }

  const VIEWS_KEY = "slipscan.transactions.views";

  function loadViews(): SavedView[] {
    try {
      const raw = localStorage.getItem(VIEWS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Validated rather than trusted: this is storage a previous version (or
      // a curious user) wrote, and one malformed entry must not take the
      // screen down.
      return parsed.filter(
        (v): v is SavedView =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as SavedView).id === "string" &&
          typeof (v as SavedView).name === "string",
      );
    } catch {
      return [];
    }
  }

  let views = $state<SavedView[]>(loadViews());

  function persistViews() {
    try {
      localStorage.setItem(VIEWS_KEY, JSON.stringify($state.snapshot(views)));
    } catch {
      // A blocked or full quota is not worth failing a filter over.
    }
  }

  const currentView = $derived<SavedView>({
    id: "current",
    name: "",
    q: search,
    account: accountFilter,
    category: categoryFilter,
    dated: dateOn,
    from,
    to,
  });

  function sameAsCurrent(v: SavedView): boolean {
    return (
      v.q === currentView.q &&
      v.account === currentView.account &&
      v.category === currentView.category &&
      v.dated === currentView.dated &&
      (!v.dated || (v.from === currentView.from && v.to === currentView.to))
    );
  }

  function applyView(v: SavedView) {
    search = v.q;
    globalSearch.query = v.q;
    accountFilter = v.account;
    categoryFilter = v.category;
    dateOn = v.dated;
    if (v.dated) {
      from = v.from;
      to = v.to;
    }
    page = 0;
  }

  let saveViewOpen = $state(false);
  let saveViewName = $state("");
  let deleteView = $state<SavedView | null>(null);

  /** A name made of the filters themselves, so the common case is one Enter. */
  function suggestedViewName(): string {
    const bits: string[] = [];
    if (categoryFilter === "none") bits.push("Uncategorised");
    else if (categoryFilter) bits.push(categoryName(categoryFilter));
    if (accountFilter) bits.push(accountName(accountFilter));
    if (search) bits.push(`“${search}”`);
    if (dateOn) bits.push(`${from} → ${to}`);
    return bits.join(" · ") || "All transactions";
  }

  function openSaveView() {
    saveViewName = suggestedViewName();
    saveViewOpen = true;
  }

  function commitSaveView() {
    const name = saveViewName.trim();
    if (!name) return;
    views = [
      ...views,
      { ...$state.snapshot(currentView), id: `v${Date.now()}`, name },
    ];
    persistViews();
    saveViewOpen = false;
  }

  function commitDeleteView() {
    const target = deleteView;
    if (!target) return;
    views = views.filter((v) => v.id !== target.id);
    persistViews();
    deleteView = null;
  }

  // -------------------------------------------------------------------------
  // selection
  // -------------------------------------------------------------------------

  let selectedIds = $state<string[]>([]);
  const selected = $derived(new Set(selectedIds));
  const selectedRows = $derived(transactions.filter((t) => selected.has(t.id)));
  const pageAllSelected = $derived(
    pageRows.length > 0 && pageRows.every((t) => selected.has(t.id)),
  );

  function toggleSelect(tx: Transaction) {
    selectedIds = selected.has(tx.id)
      ? selectedIds.filter((id) => id !== tx.id)
      : [...selectedIds, tx.id];
  }

  function togglePageSelection() {
    if (pageAllSelected) {
      const onPage = new Set(pageRows.map((t) => t.id));
      selectedIds = selectedIds.filter((id) => !onPage.has(id));
    } else {
      const merged = new Set(selectedIds);
      for (const t of pageRows) merged.add(t.id);
      selectedIds = [...merged];
    }
  }

  // -------------------------------------------------------------------------
  // merchant rules — the learning loop, made reachable
  //
  // Core normalises a merchant before storing its mapping (slipscan-core
  // util::normalize_merchant: lowercase every alphanumeric, collapse every
  // other run to a single space). Mirrored here so the rows this screen
  // promises to change are exactly the rows core groups together.
  //
  // Only lines that *carry* a merchant are grouped. Core can also derive a key
  // from a bare description (merchant_key_from_description, with its own
  // volatile-token and generic-word rules); guessing at that here would let
  // the UI promise a grouping it cannot verify, so a merchant-less line simply
  // gets no rule offer.
  // -------------------------------------------------------------------------

  function merchantKey(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function siblingsOf(tx: Transaction): Transaction[] {
    if (!tx.merchant) return [];
    const key = merchantKey(tx.merchant);
    if (!key) return [];
    return transactions.filter(
      (t) => t.merchant && merchantKey(t.merchant) === key,
    );
  }

  // -------------------------------------------------------------------------
  // batch writes, and putting them back
  // -------------------------------------------------------------------------

  /** What one write changed, so it can be reversed. */
  interface Restore {
    id: string;
    category_id?: string | null;
    member_id?: string | null;
  }

  let busyMessage = $state<string | null>(null);
  let writeError = $state<string | null>(null);

  /** The "you just taught a rule — want the rest?" bar. */
  let offer = $state<{
    merchant: string;
    categoryId: string;
    others: Transaction[];
  } | null>(null);
  /** The "here is what changed, put it back?" bar. */
  let undoBar = $state<{
    message: string;
    note: string | null;
    restore: Restore[];
  } | null>(null);
  /** A plain statement of fact (including "this is not built"). */
  let infoMessage = $state<string | null>(null);

  function clearNotices() {
    offer = null;
    undoBar = null;
    infoMessage = null;
  }

  /**
   * Apply a category to many transactions, one call at a time.
   *
   * Sequential on purpose: every call also upserts the merchant mapping in
   * core, and the *last* write is the one the mapping keeps. Firing them in
   * parallel would make "what did SlipScan learn" depend on scheduling.
   */
  async function categorizeMany(
    rows: Transaction[],
    categoryId: string | null,
  ): Promise<Restore[]> {
    const restore: Restore[] = [];
    let done = 0;
    for (const tx of rows) {
      busyMessage = `Categorising ${++done} of ${rows.length}…`;
      const updated = await api.transactionCategorize({
        transaction_id: tx.id,
        category_id: categoryId,
      });
      restore.push({ id: tx.id, category_id: tx.category_id });
      transactions = transactions.map((t) => (t.id === tx.id ? updated : t));
    }
    syncTransactionsCache();
    return restore;
  }

  async function attributeMany(
    rows: Transaction[],
    memberId: string | null,
  ): Promise<Restore[]> {
    const restore: Restore[] = [];
    let done = 0;
    for (const tx of rows) {
      busyMessage = `Attributing ${++done} of ${rows.length}…`;
      const updated = await api.transactionAttribute({
        transaction_id: tx.id,
        member_id: memberId,
      });
      restore.push({ id: tx.id, member_id: tx.attributed_member_id });
      transactions = transactions.map((t) => (t.id === tx.id ? updated : t));
    }
    syncTransactionsCache();
    return restore;
  }

  /**
   * Put a batch back.
   *
   * Order is load-bearing for categories. `transaction_categorize` teaches the
   * merchant rule; `transaction_uncategorize` deliberately does not touch it
   * (clearing one row is not evidence the rule is wrong). So rows returning to
   * *no* category are restored first and rows returning to a real category
   * last — which leaves the rule where it was, instead of wherever the loop
   * happened to finish.
   */
  async function undo(restore: Restore[]) {
    writeError = null;
    const ordered = [
      ...restore.filter((r) => r.category_id === null),
      ...restore.filter((r) => r.category_id !== null),
    ];
    try {
      let done = 0;
      for (const step of ordered) {
        busyMessage = `Restoring ${++done} of ${ordered.length}…`;
        const updated =
          step.member_id !== undefined
            ? await api.transactionAttribute({
                transaction_id: step.id,
                member_id: step.member_id,
              })
            : await api.transactionCategorize({
                transaction_id: step.id,
                category_id: step.category_id ?? null,
              });
        transactions = transactions.map((t) => (t.id === step.id ? updated : t));
      }
      syncTransactionsCache();
      clearNotices();
      infoMessage = `Put back ${ordered.length} ${plural(ordered.length, "transaction", "transactions")}.`;
    } catch (err) {
      writeError = String(err);
    } finally {
      busyMessage = null;
    }
  }

  /**
   * The undo bar for a merchant-rule batch, including what undo cannot put
   * back.
   *
   * If none of the rows had a category to return to, undoing restores the rows
   * but leaves the merchant rule pointing at the new category — there is no
   * earlier answer to re-teach it with. Saying so is the difference between an
   * undo and the promise of one.
   */
  function showRuleUndo(
    restore: Restore[],
    merchant: string,
    categoryId: string,
  ) {
    const hadCategory = restore.some((r) => r.category_id !== null);
    clearNotices();
    undoBar = {
      message: `${merchant} → ${categoryName(categoryId)} applied to ${restore.length} ${plural(restore.length, "transaction", "transactions")}.`,
      note: hadCategory
        ? null
        : `Undo puts the rows back. SlipScan keeps ${merchant} → ${categoryName(categoryId)} until you categorise one of them differently.`,
      restore,
    };
  }

  /** Single-row categorise from the table, plus the offer to fix the rest. */
  async function categorize(tx: Transaction, categoryId: string) {
    // An empty value clears the category (back to Uncategorised).
    const next = categoryId || null;
    if (next === tx.category_id) return;
    writeError = null;
    try {
      const updated = await api.transactionCategorize({
        transaction_id: tx.id,
        category_id: next,
      });
      transactions = transactions.map((t) => (t.id === tx.id ? updated : t));
      syncTransactionsCache();
      clearNotices();
      // Setting a category has just taught core this merchant. Offer to bring
      // the already-imported rows into line — that is the whole gesture, and
      // it only means anything when rows still disagree.
      const others = next
        ? siblingsOf(tx).filter((t) => t.id !== tx.id && t.category_id !== next)
        : [];
      if (next && tx.merchant && others.length > 0) {
        offer = { merchant: tx.merchant, categoryId: next, others };
      }
    } catch (err) {
      writeError = String(err);
    }
  }

  async function acceptOffer() {
    const pending = offer;
    if (!pending) return;
    writeError = null;
    try {
      const restore = await categorizeMany(pending.others, pending.categoryId);
      showRuleUndo(restore, pending.merchant, pending.categoryId);
    } catch (err) {
      writeError = String(err);
    } finally {
      busyMessage = null;
    }
  }

  // -- the standing "always categorise this merchant" dialog ----------------

  let ruleTx = $state<Transaction | null>(null);
  let ruleCategoryId = $state("");
  let ruleBusy = $state(false);
  let ruleError = $state<string | null>(null);

  const ruleSiblings = $derived(ruleTx ? siblingsOf(ruleTx) : []);
  const ruleChanging = $derived(
    ruleCategoryId
      ? ruleSiblings.filter((t) => t.category_id !== ruleCategoryId)
      : [],
  );

  function openRule(tx: Transaction) {
    ruleTx = tx;
    ruleCategoryId = tx.category_id ?? "";
    ruleError = null;
    ruleBusy = false;
  }

  async function commitRule() {
    const target = ruleTx;
    if (!target || !ruleCategoryId) return;
    const merchant = target.merchant ?? "";
    const categoryId = ruleCategoryId;
    const rows = ruleChanging.slice();
    ruleBusy = true;
    ruleError = null;
    try {
      const restore = await categorizeMany(rows, categoryId);
      ruleTx = null;
      showRuleUndo(restore, merchant, categoryId);
    } catch (err) {
      ruleError = String(err);
    } finally {
      ruleBusy = false;
      busyMessage = null;
    }
  }

  // -------------------------------------------------------------------------
  // bulk edit
  // -------------------------------------------------------------------------

  let bulkCategoryId = $state("");
  let bulkMemberId = $state("");
  let bulkConfirmOpen = $state(false);
  let bulkBusy = $state(false);
  let bulkError = $state<string | null>(null);

  async function commitBulkCategorize() {
    const rows = selectedRows.slice();
    const target = bulkCategoryId === "none" ? null : bulkCategoryId;
    bulkBusy = true;
    bulkError = null;
    try {
      const restore = await categorizeMany(rows, target);
      bulkConfirmOpen = false;
      selectedIds = [];
      bulkCategoryId = "";
      clearNotices();
      undoBar = {
        message: `Categorised ${restore.length} ${plural(restore.length, "transaction", "transactions")} as ${target ? categoryName(target) : "Uncategorised"}.`,
        note: target
          ? "Each of those merchants is now a rule, so future imports classify themselves."
          : null,
        restore,
      };
    } catch (err) {
      bulkError = String(err);
    } finally {
      bulkBusy = false;
      busyMessage = null;
    }
  }

  async function commitBulkAttribute() {
    const rows = selectedRows.slice();
    const target = bulkMemberId === "none" ? null : bulkMemberId;
    writeError = null;
    try {
      const restore = await attributeMany(rows, target);
      selectedIds = [];
      bulkMemberId = "";
      clearNotices();
      undoBar = {
        message: `Attributed ${restore.length} ${plural(restore.length, "transaction", "transactions")} to ${target ? (memberOf(target)?.label ?? "a member") : "nobody"}.`,
        note: null,
        restore,
      };
    } catch (err) {
      writeError = String(err);
    } finally {
      busyMessage = null;
    }
  }

  // -------------------------------------------------------------------------
  // row detail: attribution & splits — metadata only, never touches
  // amount/currency/category (ARCHITECTURE.md "Household members &
  // per-person attribution").
  // -------------------------------------------------------------------------

  /** Id of the transaction whose detail panel is expanded, if any. */
  let expandedFor = $state<string | null>(null);
  let panelMode = $state<"detail" | "split">("detail");
  let attributeBusy = $state<string | null>(null);
  let attributeError = $state<string | null>(null);

  function toggleExpand(tx: Transaction) {
    if (expandedFor === tx.id) {
      expandedFor = null;
      return;
    }
    expandedFor = tx.id;
    panelMode = "detail";
    attributeError = null;
  }

  async function attribute(tx: Transaction, memberId: string | null) {
    attributeError = null;
    attributeBusy = tx.id;
    try {
      const updated = await api.transactionAttribute({
        transaction_id: tx.id,
        member_id: memberId,
      });
      transactions = transactions.map((t) => (t.id === tx.id ? updated : t));
      syncTransactionsCache();
    } catch (err) {
      attributeError = String(err);
    } finally {
      attributeBusy = null;
    }
  }

  // -- split editor: a set of (member, share) rows that must sum to the
  // transaction's absolute amount; an empty set clears the split.
  let splitTargetTx = $state<Transaction | null>(null);
  let splitRows = $state<Array<{ member_id: string; amount: string }>>([]);
  let splitBusy = $state(false);
  let splitError = $state<string | null>(null);

  async function openSplitEditor(tx: Transaction) {
    panelMode = "split";
    splitTargetTx = tx;
    splitError = null;
    splitBusy = false;
    splitRows = [];
    try {
      const existing = await api.transactionSplitsList({ transaction_id: tx.id });
      if (existing.length > 0) {
        splitRows = existing.map((s) => ({
          member_id: s.member_id,
          amount: minorToInput(s.share_minor, tx.currency),
        }));
      } else {
        const starter = tx.attributed_member_id ?? members[0]?.id;
        if (starter) {
          splitRows = [
            {
              member_id: starter,
              amount: minorToInput(Math.abs(tx.amount_minor), tx.currency),
            },
          ];
        }
      }
    } catch (err) {
      splitError = String(err);
    }
  }

  function addSplitRow() {
    const used = new Set(splitRows.map((r) => r.member_id));
    const next = members.find((m) => !used.has(m.id));
    if (!next) return;
    splitRows = [...splitRows, { member_id: next.id, amount: "" }];
  }

  function removeSplitRow(index: number) {
    splitRows = splitRows.filter((_, i) => i !== index);
  }

  const splitTargetMinor = $derived(
    splitTargetTx ? Math.abs(splitTargetTx.amount_minor) : 0,
  );
  const splitSumMinor = $derived(
    splitTargetTx
      ? splitRows.reduce(
          (sum, r) => sum + (parseMoneyInput(r.amount, splitTargetTx!.currency) ?? 0),
          0,
        )
      : 0,
  );

  async function saveSplit() {
    if (!splitTargetTx) return;
    const tx = splitTargetTx;
    splitError = null;
    const shares: SplitShare[] = [];
    for (const row of splitRows) {
      const parsed = parseMoneyInput(row.amount, tx.currency);
      if (parsed === null || parsed <= 0) {
        splitError = `enter a positive amount for ${memberOf(row.member_id)?.label ?? "each member"}`;
        return;
      }
      shares.push({ member_id: row.member_id, share_minor: parsed });
    }
    if (shares.length > 0 && splitSumMinor !== splitTargetMinor) {
      splitError = `shares must sum to ${fmtMoney(splitTargetMinor, tx.currency)} (currently ${fmtMoney(splitSumMinor, tx.currency)})`;
      return;
    }
    splitBusy = true;
    try {
      await api.transactionSplitSet({ transaction_id: tx.id, shares });
      panelMode = "detail";
      splitTargetTx = null;
    } catch (err) {
      splitError = String(err);
    } finally {
      splitBusy = false;
    }
  }

  async function clearSplit() {
    splitRows = [];
    await saveSplit();
  }

  // -------------------------------------------------------------------------
  // keyboard
  //
  // Roving tabindex over the rows: Tab lands in the focused row and walks that
  // row's own controls, j/k (or the arrows) move between rows, Enter opens a
  // row through its real disclosure button, x selects. Nothing here needs a
  // mouse, and Tab does not have to walk fifty rows to leave the table.
  //
  // The handler hangs off the row controls rather than a wrapper div: a
  // keydown listener on a plain <div> is exactly the "static element with an
  // interaction" that a keyboard user cannot reach in the first place.
  // -------------------------------------------------------------------------

  let tableEl = $state<HTMLElement | null>(null);
  let focusIndex = $state(0);

  // A shorter page (or a filter) must not leave the roving index off the end.
  $effect(() => {
    if (focusIndex > pageRows.length - 1) {
      focusIndex = Math.max(0, pageRows.length - 1);
    }
  });

  async function focusRow(index: number) {
    focusIndex = index;
    await tick();
    tableEl
      ?.querySelector<HTMLElement>(`[data-row="${index}"] [data-rowfocus]`)
      ?.focus();
  }

  function onRowKeydown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const last = pageRows.length - 1;
    if (last < 0) return;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        void focusRow(Math.min(last, focusIndex + 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        void focusRow(Math.max(0, focusIndex - 1));
        break;
      case "Home":
        e.preventDefault();
        void focusRow(0);
        break;
      case "End":
        e.preventDefault();
        void focusRow(last);
        break;
      case "x": {
        const row = pageRows[focusIndex];
        if (!row) return;
        e.preventDefault();
        toggleSelect(row);
        break;
      }
      case "Escape":
        if (expandedFor) {
          e.preventDefault();
          expandedFor = null;
          void focusRow(focusIndex);
        } else if (selectedIds.length > 0) {
          e.preventDefault();
          selectedIds = [];
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // intents parked by the command palette
  //
  // Claimed at init, applied once the rows are actually here — an intent that
  // resolved against an empty list would silently do nothing.
  // -------------------------------------------------------------------------

  const reveal = takeIntent("reveal-transaction");
  if (reveal) {
    // A filter left over from a previous visit would hide the very row the
    // palette just promised to open.
    clearFilters();
    expandedFor = reveal.id;
    panelMode = "detail";
  }
  if (takeIntent("new-transaction")) {
    infoMessage =
      "Adding a transaction by hand is not built. Lines arrive from a statement import (slipscan import --preset), a watched mailbox, or a bank scraper.";
  }

  let revealed = false;
  $effect(() => {
    if (!reveal || revealed || filtered.length === 0) return;
    const index = filtered.findIndex((t) => t.id === reveal.id);
    if (index < 0) return;
    revealed = true;
    page = Math.floor(index / pageSize);
    void focusRow(index % pageSize);
  });
</script>

<PageHeader
  eyebrow="Money in · money out"
  title="Transactions"
  subtitle="Every bank-level transaction across your accounts. Correct one merchant and SlipScan classifies it that way from then on. Statement files still arrive from the CLI: slipscan import parses a CSV into transactions and categorises them on the way in."
>
  {#snippet actions()}
    <button class="btn" disabled={!filtersActive} onclick={openSaveView}>
      <Icon name="plus" size={14} />
      Save view
    </button>
    <button class="btn" disabled={!filtersActive} onclick={clearFilters}>
      Clear filters
    </button>
  {/snippet}
</PageHeader>

<div class="mb-3 flex flex-wrap items-center gap-2">
  <div class="relative w-full sm:w-64">
    <Icon
      name="search"
      size={14}
      class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
    />
    <input
      class="input pr-8 pl-8"
      placeholder="Filter by merchant or description…"
      bind:value={search}
      oninput={() => (page = 0)}
    />
    {#if search}
      <button
        type="button"
        class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-t3 hover:text-t1"
        style="transition: color var(--dur-quick) var(--ease-standard);"
        aria-label="Clear search"
        onclick={() => {
          search = "";
          globalSearch.query = "";
        }}
      >
        <Icon name="x" size={13} />
      </button>
    {/if}
  </div>
  <select
    class="input w-full sm:w-44"
    bind:value={accountFilter}
    aria-label="Account"
    onchange={() => (page = 0)}
  >
    <option value="">All accounts</option>
    {#each accounts as a (a.id)}
      <option value={a.id}>{a.name}</option>
    {/each}
  </select>
  <select
    class="input w-full sm:w-44"
    bind:value={categoryFilter}
    aria-label="Category"
    onchange={() => (page = 0)}
  >
    <option value="">All categories</option>
    <option value="none">Uncategorised</option>
    {#each categories as c (c.id)}
      <option value={c.id}>{c.name}</option>
    {/each}
  </select>
  <button
    class="btn {dateOn ? 'border-accent-ring/50 bg-accent/10' : ''}"
    aria-expanded={datePanelOpen}
    aria-controls="tx-date-panel"
    onclick={() => (datePanelOpen = !datePanelOpen)}
  >
    <Icon name="calendar" size={14} />
    {dateOn ? `${from} → ${to}` : "Any date"}
    <Icon name="chevron-down" size={12} class="text-t3" />
  </button>
  <span class="ml-auto flex items-center gap-1.5 text-[12px] text-t3">
    <span class="num tabular-nums">{filtered.length}</span> of
    <span class="num tabular-nums">{transactions.length}</span>
    {#if book}
      <span aria-hidden="true" class="text-line-2">·</span> outflow
      <Money amount={outflow} currency={book.currency} class="text-t2" />
    {/if}
  </span>
</div>

{#if datePanelOpen}
  <div id="tx-date-panel" class="reveal mb-3">
    <div class="reveal-inner">
      <div class="card flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
        <DateRangePicker
          {from}
          {to}
          label="Transaction date range"
          onchange={applyRange}
        />
        <button
          class="btn h-7 {dateOn ? '' : 'border-accent-ring/50 bg-accent/10'}"
          aria-pressed={!dateOn}
          onclick={() => {
            dateOn = false;
            page = 0;
          }}
        >
          Any date
        </button>
      </div>
    </div>
  </div>
{/if}

{#if views.length > 0}
  <div
    class="mb-3 flex flex-wrap items-center gap-1.5"
    role="group"
    aria-label="Saved views"
  >
    <span class="eyebrow mr-0.5">Views</span>
    {#each views as v (v.id)}
      {@const active = sameAsCurrent(v)}
      <span
        class="inline-flex items-center rounded-full border {active
          ? 'border-accent-ring/50 bg-accent/10'
          : 'border-line bg-panel'}"
      >
        <button
          class="rounded-l-full px-2.5 py-1 text-[11.5px] font-medium text-t2 hover:text-t1"
          aria-pressed={active}
          onclick={() => applyView(v)}
        >
          {v.name}
        </button>
        <button
          class="flex size-6 items-center justify-center rounded-r-full text-t3 hover:text-danger"
          aria-label="Delete the view {v.name}"
          onclick={() => (deleteView = v)}
        >
          <Icon name="x" size={11} />
        </button>
      </span>
    {/each}
  </div>
{/if}

<!-- One live region for everything a batch write has to say, so a screen
     reader hears the result instead of watching rows change in silence. -->
<div role="status" aria-live="polite">
  {#if busyMessage}
    <p
      class="mb-3 flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] text-t2"
    >
      <Icon name="refresh" size={13} class="animate-spin" />
      {busyMessage}
    </p>
  {:else if offer}
    <div
      class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent-ring/40 bg-accent/10 px-3 py-2.5"
    >
      <Icon name="sparkle" size={14} class="text-accent-text dark:text-accent" />
      <span class="min-w-0 flex-1 text-[12.5px] leading-snug">
        <strong class="font-semibold">{offer.merchant}</strong> will be
        {categoryName(offer.categoryId)} from now on.
        <span class="text-t2">
          {offer.others.length} earlier
          {plural(offer.others.length, "transaction", "transactions")} from
          {offer.merchant}
          {plural(offer.others.length, "says", "say")} something else.
        </span>
      </span>
      <span class="flex items-center gap-2">
        <button class="btn btn-primary h-7" onclick={acceptOffer}>
          Fix {offer.others.length}
          {plural(offer.others.length, "row", "rows")}
        </button>
        <button class="btn btn-ghost h-7" onclick={() => (offer = null)}>
          Not now
        </button>
      </span>
    </div>
  {:else if undoBar}
    <div
      class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-sunken px-3 py-2.5"
    >
      <Icon name="check-circle" size={14} class="shrink-0 text-success" />
      <span class="min-w-0 flex-1 text-[12.5px] leading-snug">
        {undoBar.message}
        {#if undoBar.note}
          <span class="mt-0.5 block text-[11.5px] text-t3">{undoBar.note}</span>
        {/if}
      </span>
      <span class="flex items-center gap-2">
        <button class="btn h-7" onclick={() => undoBar && undo(undoBar.restore)}>
          <Icon name="refresh" size={12} />
          Undo
        </button>
        <button class="btn btn-ghost h-7" onclick={() => (undoBar = null)}>
          Dismiss
        </button>
      </span>
    </div>
  {:else if infoMessage}
    <p
      class="mb-3 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] text-t2"
    >
      <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
      <span class="flex-1">{infoMessage}</span>
      <button
        class="shrink-0 text-t3 hover:text-t1"
        aria-label="Dismiss message"
        onclick={() => (infoMessage = null)}
      >
        <Icon name="x" size={13} />
      </button>
    </p>
  {/if}
</div>

{#if writeError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
    role="alert"
  >
    <Icon name="alert-circle" size={13} />
    {writeError}
  </p>
{/if}

{#if selectedIds.length > 0}
  <div
    class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-2 bg-panel px-3 py-2.5"
    role="group"
    aria-label="Actions for the selected transactions"
  >
    <span class="text-[12.5px] font-medium">
      <span class="num">{selectedIds.length}</span> selected
    </span>
    <label class="flex items-center gap-1.5 text-[11.5px] text-t3">
      Categorise
      <select
        class="input h-7 w-40 text-[12px]"
        aria-label="Category for the selected transactions"
        bind:value={bulkCategoryId}
      >
        <option value="">Choose…</option>
        <option value="none">Uncategorised</option>
        {#each categories as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </label>
    <button
      class="btn h-7"
      disabled={!bulkCategoryId}
      onclick={() => {
        bulkError = null;
        bulkConfirmOpen = true;
      }}
    >
      Apply
    </button>
    {#if members.length > 0}
      <label class="flex items-center gap-1.5 text-[11.5px] text-t3">
        Attribute
        <select
          class="input h-7 w-36 text-[12px]"
          aria-label="Member for the selected transactions"
          bind:value={bulkMemberId}
        >
          <option value="">Choose…</option>
          <option value="none">Unattributed</option>
          {#each members as m (m.id)}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      </label>
      <button
        class="btn h-7"
        disabled={!bulkMemberId}
        onclick={commitBulkAttribute}
      >
        Apply
      </button>
    {/if}
    <button class="btn btn-ghost ml-auto h-7" onclick={() => (selectedIds = [])}>
      Clear selection
    </button>
  </div>
{/if}

<div class="card overflow-hidden">
  {#if loading}
    <Skeleton rows={10} />
  {:else if loadError}
    <EmptyState icon="alert-circle" title="Could not load transactions" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if transactions.length === 0}
    <EmptyState
      icon="transactions"
      title="No transactions yet"
      body="Import a slip in Receipts, or bring in a bank statement from the CLI: slipscan import --preset <id> --account <name>. Nothing leaves this machine."
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={() => router.go("receipts")}>
          Import a receipt
        </button>
      {/snippet}
    </EmptyState>
  {:else if filtered.length === 0}
    <EmptyState
      icon="search"
      title="Nothing matches those filters"
      body="Try a broader search, or clear the filters to see all {transactions.length} transactions."
    >
      {#snippet actions()}
        <button class="btn" onclick={clearFilters}>Clear filters</button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table-wrap table-scroll" bind:this={tableEl}>
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th w-9">
              <input
                type="checkbox"
                class="size-3.5 align-middle"
                aria-label="Select every transaction on this page"
                checked={pageAllSelected}
                onchange={togglePageSelection}
              />
            </th>
            <th class="th w-28">Date</th>
            <th class="th">Description</th>
            <th class="th w-40">Account</th>
            <th class="th w-44">Category</th>
            {#if members.length > 0}
              <th class="th w-32">Member</th>
            {/if}
            <th class="th w-32 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {#each pageRows as tx, i (tx.id)}
            {@const open = expandedFor === tx.id}
            {@const isSelected = selected.has(tx.id)}
            <tr class="row-hover {isSelected ? 'bg-accent/5' : ''}" data-row={i}>
              <td class="td">
                <input
                  type="checkbox"
                  class="size-3.5 align-middle"
                  aria-label="Select {labelOf(tx)}"
                  tabindex={i === focusIndex ? 0 : -1}
                  checked={isSelected}
                  onchange={() => toggleSelect(tx)}
                  onkeydown={onRowKeydown}
                />
              </td>
              <td class="td num whitespace-nowrap text-t2"
                >{fmtDate(tx.posted_at)}</td
              >
              <td class="td max-w-0">
                <button
                  type="button"
                  data-rowfocus
                  class="flex w-full min-w-0 items-center gap-1.5 text-left"
                  tabindex={i === focusIndex ? 0 : -1}
                  aria-expanded={open}
                  aria-controls="tx-panel-{tx.id}"
                  onfocus={() => (focusIndex = i)}
                  onclick={() => toggleExpand(tx)}
                  onkeydown={onRowKeydown}
                >
                  <Icon
                    name="chevron-down"
                    size={12}
                    class="shrink-0 text-t3 {open ? '' : '-rotate-90'}"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-medium"
                      >{tx.merchant ?? tx.description}</span
                    >
                    {#if tx.merchant}
                      <span class="block truncate text-[11px] text-t3"
                        >{tx.description}</span
                      >
                    {/if}
                  </span>
                </button>
              </td>
              <td class="td max-w-0 text-t2">
                <span class="block truncate">{accountName(tx.account_id)}</span>
              </td>
              <td class="td">
                <select
                  class="input h-7 w-full pl-1.5 text-[12px] {tx.category_id
                    ? 'text-t2'
                    : 'text-warning'}"
                  aria-label="Categorise {labelOf(tx)}"
                  tabindex={i === focusIndex ? 0 : -1}
                  value={tx.category_id ?? ""}
                  onchange={(e) => categorize(tx, e.currentTarget.value)}
                >
                  <option value="">Uncategorised</option>
                  {#each categories as c (c.id)}
                    <option value={c.id}>{c.icon ?? ""} {c.name}</option>
                  {/each}
                </select>
              </td>
              {#if members.length > 0}
                <td class="td">
                  <button
                    type="button"
                    class="btn h-7 w-full justify-start gap-1.5 px-1.5"
                    aria-label="Attribute {labelOf(tx)} to a household member"
                    tabindex={i === focusIndex ? 0 : -1}
                    disabled={attributeBusy === tx.id}
                    onclick={() => {
                      expandedFor = tx.id;
                      panelMode = "detail";
                    }}
                    onkeydown={onRowKeydown}
                  >
                    <MemberAvatar member={memberOf(tx.attributed_member_id)} size={17} />
                    <span class="min-w-0 flex-1 truncate text-left text-[11.5px] text-t2">
                      {memberOf(tx.attributed_member_id)?.label ?? "Unattributed"}
                    </span>
                  </button>
                </td>
              {/if}
              <td class="td text-right">
                <Money
                  amount={tx.amount_minor}
                  currency={tx.currency}
                  signed
                  colored
                />
              </td>
            </tr>
            {#if open}
              <tr>
                <td
                  class="td bg-sunken/40 p-0"
                  id="tx-panel-{tx.id}"
                  colspan={members.length > 0 ? 7 : 6}
                >
                  <div class="reveal">
                    <div class="reveal-inner space-y-3 px-3 py-3">
                      {#if panelMode === "detail"}
                        <!-- 1 · the merchant rule. The single most useful
                             thing this screen can offer, so it leads. -->
                        {#if tx.merchant}
                          {@const family = siblingsOf(tx)}
                          <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            <span class="flex items-center gap-1.5 text-[11.5px] text-t3">
                              <Icon name="sparkle" size={12} />
                              Merchant rule
                            </span>
                            <span class="text-[12.5px]">
                              Always categorise
                              <strong class="font-semibold">{tx.merchant}</strong>
                              as
                              <strong class="font-semibold"
                                >{categoryName(tx.category_id)}</strong
                              >
                            </span>
                            <span class="num text-[11.5px] text-t3">
                              {family.length}
                              {plural(family.length, "transaction", "transactions")}
                            </span>
                            <button class="btn h-7" onclick={() => openRule(tx)}>
                              Change or apply…
                            </button>
                          </div>
                        {:else}
                          <p class="text-[11.5px] text-t3">
                            This line carries no merchant name, so there is
                            nothing to write a merchant rule against. Core may
                            still derive a key from the description at import
                            time; this screen will not claim that it did.
                          </p>
                        {/if}

                        <!-- 2 · attribution -->
                        {#if members.length > 0}
                          <div
                            class="flex flex-wrap items-center gap-1.5 border-t border-line pt-3"
                          >
                            <span
                              class="mr-1 flex items-center gap-1.5 text-[11.5px] text-t3"
                            >
                              <Icon name="wallet" size={12} />
                              Attributed to
                            </span>
                            <button
                              type="button"
                              class="btn h-7 gap-1.5 {tx.attributed_member_id === null
                                ? 'border-accent-ring/50 bg-accent/10'
                                : ''}"
                              disabled={attributeBusy === tx.id}
                              onclick={() => attribute(tx, null)}
                            >
                              <MemberAvatar member={null} size={15} />
                              Unattributed
                            </button>
                            {#each members as m (m.id)}
                              <button
                                type="button"
                                class="btn h-7 gap-1.5 {tx.attributed_member_id === m.id
                                  ? 'border-accent-ring/50 bg-accent/10'
                                  : ''}"
                                disabled={attributeBusy === tx.id}
                                onclick={() => attribute(tx, m.id)}
                              >
                                <MemberAvatar member={m} size={15} />
                                {m.label}
                              </button>
                            {/each}
                            <button
                              type="button"
                              class="btn btn-ghost h-7"
                              onclick={() => openSplitEditor(tx)}
                            >
                              <Icon name="reconcile" size={13} />
                              Split…
                            </button>
                            {#if attributeError}
                              <span
                                class="flex items-center gap-1.5 text-[11.5px] text-danger"
                              >
                                <Icon name="alert-circle" size={12} />
                                {attributeError}
                              </span>
                            {/if}
                          </div>
                        {/if}

                        <!-- 3 · provenance -->
                        <div
                          class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[11.5px] text-t3"
                        >
                          <span class="flex items-center gap-1.5">
                            Source
                            <Badge
                              tone="neutral"
                              dot={false}
                              label={sourceLabel[tx.source]}
                            />
                          </span>
                          <span class="num">{fmtDate(tx.posted_at)}</span>
                          <span class="min-w-0 truncate">{tx.description}</span>
                          <button
                            class="btn btn-ghost ml-auto h-7"
                            onclick={() => router.go("reconcile")}
                          >
                            <Icon name="reconcile" size={13} />
                            Match a slip
                          </button>
                        </div>
                      {:else if splitTargetTx?.id === tx.id}
                        <div class="space-y-2">
                          <p class="text-[11.5px] text-t3">
                            Split this {fmtMoney(
                              Math.abs(tx.amount_minor),
                              tx.currency,
                            )} transaction across members — shares must sum to
                            the full amount.
                          </p>
                          {#each splitRows as row, ri (ri)}
                            <div class="flex items-center gap-2">
                              <MemberAvatar member={memberOf(row.member_id)} size={16} />
                              <select
                                class="input h-7 w-36"
                                aria-label="Member"
                                bind:value={row.member_id}
                              >
                                {#each members as m (m.id)}
                                  <option value={m.id}>{m.label}</option>
                                {/each}
                              </select>
                              <input
                                class="input h-7 w-28 font-mono"
                                aria-label="Share amount"
                                inputmode="decimal"
                                placeholder="0.00"
                                bind:value={row.amount}
                              />
                              <button
                                type="button"
                                class="btn btn-ghost h-7 w-7 px-0"
                                aria-label="Remove this split row"
                                onclick={() => removeSplitRow(ri)}
                              >
                                <Icon name="x" size={13} />
                              </button>
                            </div>
                          {/each}
                          <div class="flex flex-wrap items-center gap-2">
                            <button
                              class="btn h-7"
                              type="button"
                              disabled={splitRows.length >= members.length}
                              onclick={addSplitRow}
                            >
                              <Icon name="plus" size={12} />
                              Add member
                            </button>
                            <span
                              class="num text-[11.5px] {splitSumMinor === splitTargetMinor
                                ? 'text-success'
                                : 'text-t3'}"
                            >
                              {fmtMoney(splitSumMinor, tx.currency)} of {fmtMoney(
                                splitTargetMinor,
                                tx.currency,
                              )}
                            </span>
                          </div>
                          {#if splitError}
                            <p class="flex items-center gap-1.5 text-[11.5px] text-danger">
                              <Icon name="alert-circle" size={12} />
                              {splitError}
                            </p>
                          {/if}
                          <div class="flex items-center gap-2 pt-1">
                            <button
                              class="btn btn-primary h-7"
                              type="button"
                              disabled={splitBusy || splitRows.length === 0}
                              onclick={saveSplit}
                            >
                              {splitBusy ? "Saving…" : "Save split"}
                            </button>
                            <button
                              class="btn h-7"
                              type="button"
                              disabled={splitBusy}
                              onclick={clearSplit}
                            >
                              Clear split
                            </button>
                            <button
                              class="btn btn-ghost h-7"
                              type="button"
                              onclick={() => (panelMode = "detail")}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      {/if}
                    </div>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Pager. "25 of 25" with nothing to click is only honest while a book
         stays small; this is what the same screen does at 25 000. -->
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 py-2"
    >
      <label class="flex items-center gap-1.5 text-[11.5px] text-t3">
        Rows
        <select
          class="input h-7 w-20 text-[12px]"
          aria-label="Rows per page"
          value={pageSize}
          onchange={(e) => {
            pageSize = Number(e.currentTarget.value);
            page = 0;
          }}
        >
          {#each PAGE_SIZES as size (size)}
            <option value={size}>{size}</option>
          {/each}
        </select>
      </label>
      <span class="num text-[11.5px] text-t3">
        Showing {firstShown}–{lastShown}
      </span>
      <span class="ml-auto flex items-center gap-1.5">
        <button
          class="btn h-7 w-7 px-0"
          aria-label="Previous page"
          disabled={page === 0}
          onclick={() => (page = Math.max(0, page - 1))}
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span class="num text-[11.5px] text-t3">
          Page {page + 1} of {pageCount}
        </span>
        <button
          class="btn h-7 w-7 px-0"
          aria-label="Next page"
          disabled={page >= pageCount - 1}
          onclick={() => (page = Math.min(pageCount - 1, page + 1))}
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </span>
    </div>
    <p class="border-t border-line px-3 py-2 text-[11px] text-t3">
      <span class="kbd">J</span> / <span class="kbd">K</span> move ·
      <span class="kbd">↵</span> opens a row ·
      <span class="kbd">X</span> selects ·
      <span class="kbd">Esc</span> closes
    </p>
  {/if}
</div>

<!-- The standing merchant rule. A dialog rather than an inline strip because
     it is a decision about every future import, and because it has to show
     exactly which rows it will rewrite before it rewrites one. -->
<Dialog
  open={ruleTx !== null}
  title="Always categorise {ruleTx?.merchant ?? ''}"
  description="Correcting a single transaction already teaches SlipScan this merchant, and your answer outranks any pack rule. This also brings the transactions already imported into line."
  size="md"
  dismissible={!ruleBusy}
  onclose={() => (ruleTx = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Category</span>
      <select
        data-autofocus
        class="input"
        aria-label="Category for this merchant"
        disabled={ruleBusy}
        bind:value={ruleCategoryId}
      >
        <option value="">Choose a category…</option>
        {#each categories as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </label>

    <div class="rounded-lg border border-line bg-sunken px-3 py-2.5">
      {#if !ruleCategoryId}
        <p class="text-[12px] text-t3">
          Pick a category to see exactly what would change.
        </p>
      {:else if ruleChanging.length === 0}
        <p class="text-[12px] text-t2">
          All <span class="num">{ruleSiblings.length}</span>
          {plural(ruleSiblings.length, "transaction", "transactions")} from
          {ruleTx?.merchant} already
          {plural(ruleSiblings.length, "says", "say")}
          {categoryName(ruleCategoryId)}. Nothing to change.
        </p>
      {:else}
        <p class="mb-2 text-[12px] text-t2">
          <span class="num">{ruleChanging.length}</span> of
          <span class="num">{ruleSiblings.length}</span>
          {plural(ruleSiblings.length, "transaction", "transactions")} would move
          to {categoryName(ruleCategoryId)}:
        </p>
        <ul class="max-h-40 space-y-1 overflow-y-auto">
          {#each ruleChanging.slice(0, 8) as t (t.id)}
            <li class="flex items-center gap-2 text-[11.5px]">
              <span class="num shrink-0 text-t3">{fmtDate(t.posted_at)}</span>
              <span class="min-w-0 flex-1 truncate text-t2"
                >{categoryName(t.category_id)}</span
              >
              <Icon name="arrow-right" size={11} class="shrink-0 text-t3" />
              <span class="shrink-0">{categoryName(ruleCategoryId)}</span>
              <Money
                amount={t.amount_minor}
                currency={t.currency}
                signed
                class="ml-2 shrink-0"
              />
            </li>
          {/each}
          {#if ruleChanging.length > 8}
            <li class="text-[11.5px] text-t3">
              …and {ruleChanging.length - 8} more.
            </li>
          {/if}
        </ul>
      {/if}
    </div>

    {#if ruleError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {ruleError}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button class="btn" disabled={ruleBusy} onclick={() => (ruleTx = null)}>
      Cancel
    </button>
    <button
      class="btn btn-primary"
      disabled={ruleBusy || !ruleCategoryId || ruleChanging.length === 0}
      onclick={commitRule}
    >
      {#if ruleBusy}
        <Icon name="refresh" size={13} class="animate-spin" />
      {/if}
      {ruleBusy
        ? "Applying…"
        : `Apply to ${ruleChanging.length} ${plural(ruleChanging.length, "row", "rows")}`}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  open={bulkConfirmOpen}
  title="Categorise {selectedIds.length} {plural(
    selectedIds.length,
    'transaction',
    'transactions',
  )}?"
  body="They move to {bulkCategoryId === 'none'
    ? 'Uncategorised'
    : categoryName(bulkCategoryId)}.{bulkCategoryId === 'none'
    ? ' Clearing a category leaves the merchant rules alone.'
    : ' Each merchant becomes a rule, so future imports classify themselves.'}"
  confirmLabel="Categorise"
  busy={bulkBusy}
  error={bulkError}
  onconfirm={commitBulkCategorize}
  oncancel={() => (bulkConfirmOpen = false)}
/>

<Dialog
  open={saveViewOpen}
  title="Save this view"
  description="Filters only — a view is a bookmark, kept on this machine."
  size="sm"
  onclose={() => (saveViewOpen = false)}
>
  <div class="px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Name</span>
      <input
        data-autofocus
        class="input"
        type="text"
        bind:value={saveViewName}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitSaveView();
          }
        }}
      />
    </label>
  </div>
  {#snippet footer()}
    <button class="btn" onclick={() => (saveViewOpen = false)}>Cancel</button>
    <button
      class="btn btn-primary"
      disabled={!saveViewName.trim()}
      onclick={commitSaveView}>Save view</button
    >
  {/snippet}
</Dialog>

<ConfirmDialog
  open={deleteView !== null}
  title="Delete the view “{deleteView?.name ?? ''}”?"
  body="The filters it holds are forgotten. No transaction is touched."
  confirmLabel="Delete view"
  tone="danger"
  onconfirm={commitDeleteView}
  oncancel={() => (deleteView = null)}
/>
