<script lang="ts">
  import { api } from "../lib/api/client";
  import { router } from "../lib/router.svelte";
  import { globalSearch } from "../lib/search.svelte";
  import { fmtDate, fmtMoney } from "../lib/format";
  import type { Account, Book, Category, Transaction } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";

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
  let transactions = $state<Transaction[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [b] = await api.bookList();
      if (!b) throw new Error("no book configured");
      book = b;
      [accounts, categories, transactions] = await Promise.all([
        api.accountList({ book_id: b.id }),
        api.categoryList({ book_id: b.id }),
        api.transactionList({ book_id: b.id }),
      ]);
    } catch (err) {
      loadError = String(err);
    } finally {
      loading = false;
    }
  }
  load();

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
    } catch (err) {
      categorizeError = String(err);
    }
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
  <div class="relative w-64">
    <Icon
      name="search"
      size={14}
      class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
    />
    <input
      class="input pl-8"
      placeholder="Filter by merchant or description…"
      bind:value={search}
    />
  </div>
  <select class="input w-44" bind:value={accountFilter} aria-label="Account">
    <option value="">All accounts</option>
    {#each accounts as a (a.id)}
      <option value={a.id}>{a.name}</option>
    {/each}
  </select>
  <select class="input w-44" bind:value={categoryFilter} aria-label="Category">
    <option value="">All categories</option>
    <option value="none">Uncategorised</option>
    {#each categories as c (c.id)}
      <option value={c.id}>{c.name}</option>
    {/each}
  </select>
  <span class="ml-auto text-[12px] text-t3">
    {filtered.length} of {transactions.length} · outflow
    <span class="num">{fmtMoney(outflow, book?.currency ?? "ZAR")}</span>
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
        <button class="btn" onclick={load}>Retry</button>
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
    <table class="w-full border-collapse text-[12.5px]">
      <thead>
        <tr class="bg-sunken/60">
          <th class="th w-28">Date</th>
          <th class="th">Description</th>
          <th class="th w-40">Account</th>
          <th class="th w-40">Category</th>
          <th class="th w-20">Source</th>
          <th class="th w-32 text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as tx (tx.id)}
          <tr class="transition-colors hover:bg-sunken/50">
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
            <td class="td truncate text-t2">{accountName(tx.account_id)}</td>
            <td class="td">
              <select
                class="input h-7 w-full px-1.5 text-[12px] {tx.category_id
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
            <td class="td text-[11px] text-t3">{sourceLabel[tx.source]}</td>
            <td class="td text-right">
              <Money amount={tx.amount_minor} currency={tx.currency} signed colored />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
