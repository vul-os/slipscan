<script lang="ts">
  import { api } from "../lib/api/client";
  import { router } from "../lib/router.svelte";
  import { globalSearch } from "../lib/search.svelte";
  import { routeCache } from "../lib/loadCache";
  import { fmtDate, fmtMoney, minorToInput, parseMoneyInput } from "../lib/format";
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

  let search = $state(globalSearch.query);
  let accountFilter = $state("");
  let categoryFilter = $state("");

  // Pick up queries typed into the sidebar search box.
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
      const [b] = await api.bookList();
      if (!b) throw new Error("no book configured");
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
      load(true);
    } else {
      load();
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

  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.name ?? "—";

  let categorizeError = $state<string | null>(null);

  async function categorize(tx: Transaction, categoryId: string) {
    // An empty value clears the category (back to Uncategorised).
    const next = categoryId || null;
    if (next === tx.category_id) return;
    categorizeError = null;
    try {
      const updated = await api.transactionCategorize({
        transaction_id: tx.id,
        category_id: next,
      });
      transactions = transactions.map((t) => (t.id === tx.id ? updated : t));
      syncTransactionsCache();
    } catch (err) {
      categorizeError = String(err);
    }
  }

  // -- attribution & splits: metadata only, never touches amount/currency/
  // category (ARCHITECTURE.md "Household members & per-person attribution").

  const memberOf = (memberId: string | null): Member | null =>
    members.find((m) => m.id === memberId) ?? null;

  /** Id of the transaction whose picker/split panel is expanded, if any. */
  let expandedFor = $state<string | null>(null);
  let panelMode = $state<"pick" | "split">("pick");
  let attributeBusy = $state<string | null>(null);
  let attributeError = $state<string | null>(null);

  function toggleExpand(tx: Transaction) {
    if (expandedFor === tx.id) {
      expandedFor = null;
      return;
    }
    expandedFor = tx.id;
    panelMode = "pick";
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
      expandedFor = null;
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
      expandedFor = null;
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

  function clearFilters() {
    search = "";
    accountFilter = "";
    categoryFilter = "";
  }

  const sourceLabel: Record<Transaction["source"], string> = {
    scraper: "bank",
    email: "email",
    import: "import",
    manual: "manual",
  };
</script>

<PageHeader
  eyebrow="Money in · money out"
  title="Transactions"
  subtitle="Every bank-level transaction across your accounts. Categorise, filter, and trace back to slips. Statement import lands via the CLI (slipscan import) for now."
/>

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
    />
    {#if search}
      <button
        type="button"
        class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-t3 hover:text-t1"
        style="transition: color var(--dur-quick) var(--ease-standard);"
        aria-label="Clear search"
        onclick={() => (search = "")}
      >
        <Icon name="x" size={13} />
      </button>
    {/if}
  </div>
  <select class="input w-full sm:w-44" bind:value={accountFilter} aria-label="Account">
    <option value="">All accounts</option>
    {#each accounts as a (a.id)}
      <option value={a.id}>{a.name}</option>
    {/each}
  </select>
  <select class="input w-full sm:w-44" bind:value={categoryFilter} aria-label="Category">
    <option value="">All categories</option>
    <option value="none">Uncategorised</option>
    {#each categories as c (c.id)}
      <option value={c.id}>{c.name}</option>
    {/each}
  </select>
  <span class="ml-auto flex items-center gap-1.5 text-[12px] text-t3">
    <span class="num tabular-nums">{filtered.length}</span> of
    <span class="num tabular-nums">{transactions.length}</span>
    {#if book}
      <span aria-hidden="true" class="text-line-2">·</span> outflow
      <Money amount={outflow} currency={book.currency} class="text-t2" />
    {/if}
  </span>
</div>

{#if categorizeError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    {categorizeError}
  </p>
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
      body="Import a slip in Receipts, or bring in a bank statement with the CLI: slipscan import <file>. Nothing leaves this machine."
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
    <div class="table-wrap table-scroll">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th w-28">Date</th>
            <th class="th">Description</th>
            <th class="th w-40">Account</th>
            <th class="th w-44">Category</th>
            {#if members.length > 0}
              <th class="th w-32">Member</th>
            {/if}
            <th class="th w-24">Source</th>
            <th class="th w-32 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as tx (tx.id)}
            <tr class="row-hover">
              <td class="td num whitespace-nowrap text-t2"
                >{fmtDate(tx.posted_at)}</td
              >
              <td class="td max-w-0">
                <span class="block truncate font-medium"
                  >{tx.merchant ?? tx.description}</span
                >
                {#if tx.merchant}
                  <span class="block truncate text-[11px] text-t3"
                    >{tx.description}</span
                  >
                {/if}
              </td>
              <td class="td max-w-0 text-t2">
                <span class="block truncate">{accountName(tx.account_id)}</span>
              </td>
              <td class="td">
                <select
                  class="input h-7 w-full pl-1.5 text-[12px] {tx.category_id
                    ? 'text-t2'
                    : 'text-warning'}"
                  aria-label="Categorise transaction"
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
                    aria-expanded={expandedFor === tx.id}
                    aria-label="Attribute to a household member"
                    disabled={attributeBusy === tx.id}
                    onclick={() => toggleExpand(tx)}
                  >
                    <MemberAvatar member={memberOf(tx.attributed_member_id)} size={17} />
                    <span class="min-w-0 flex-1 truncate text-left text-[11.5px] text-t2">
                      {memberOf(tx.attributed_member_id)?.label ?? "Unattributed"}
                    </span>
                    <Icon name="chevron-down" size={11} class="shrink-0 text-t3" />
                  </button>
                </td>
              {/if}
              <td class="td">
                <Badge tone="neutral" dot={false} label={sourceLabel[tx.source]} />
              </td>
              <td class="td text-right">
                <Money
                  amount={tx.amount_minor}
                  currency={tx.currency}
                  signed
                  colored
                />
              </td>
            </tr>
            {#if expandedFor === tx.id}
              <tr>
                <td class="td bg-sunken/40 p-0" colspan={members.length > 0 ? 7 : 6}>
                  <div class="reveal">
                    <div class="reveal-inner px-3 py-2.5">
                      {#if panelMode === "pick"}
                        <div class="flex flex-wrap items-center gap-1.5">
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
                            <span class="flex items-center gap-1.5 text-[11.5px] text-danger">
                              <Icon name="alert-circle" size={12} />
                              {attributeError}
                            </span>
                          {/if}
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
                          {#each splitRows as row, i (i)}
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
                                onclick={() => removeSplitRow(i)}
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
                              onclick={() => (expandedFor = null)}
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
  {/if}
</div>
