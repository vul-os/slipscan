<script lang="ts">
  import { api } from "../lib/api/client";
  import {
    fmtDate,
    fmtMoney,
    fmtMonth,
    fmtPct,
    greeting,
    localMonth,
    monthEnd,
  } from "../lib/format";
  import { swrLoad } from "../lib/loadCache";
  import { computeNudges, type NudgeSeverity } from "../lib/nudges";
  import { router } from "../lib/router.svelte";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  const month = localMonth();

  async function load() {
    const [book] = await api.bookList();
    if (!book) throw new Error("no book configured");
    const [accounts, categories, transactions, docs, budgets, spending] =
      await Promise.all([
        api.accountList({ book_id: book.id }),
        api.categoryList({ book_id: book.id }),
        api.transactionList({ book_id: book.id }),
        api.documentList({ book_id: book.id }),
        api.budgetList({ book_id: book.id, month }),
        api.reportSpending({
          book_id: book.id,
          from: `${month}-01`,
          to: monthEnd(month),
        }),
      ]);
    // Nudges are computed right here, on-device, from the stats above.
    const nudges = computeNudges({ transactions, budgets, categories, month });
    return {
      book,
      accounts,
      categories,
      recent: transactions.slice(0, 7),
      docs,
      budgets,
      spending,
      nudges,
    };
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>("dashboard", load, (v) => (data = v), { fresh });
  let data = $state(reload());

  const nudgeTone: Record<NudgeSeverity, "danger" | "warning" | "accent"> = {
    danger: "danger",
    warning: "warning",
    info: "accent",
  };
  const nudgeLabel: Record<NudgeSeverity, string> = {
    danger: "act now",
    warning: "heads up",
    info: "insight",
  };
</script>

{#await data}
  <!-- Loading mirrors the loaded layout so nothing jumps on arrival. -->
  <div aria-busy="true">
    <div class="mb-6">
      <div class="skeleton h-2.5 w-32"></div>
      <div class="skeleton mt-2.5 h-7 w-64 max-w-full"></div>
      <div class="skeleton mt-2 h-3 w-80 max-w-full"></div>
    </div>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {#each Array.from({ length: 4 }, (_, i) => i) as i (i)}
        <div class="card p-4">
          <div class="skeleton h-2.5 w-20"></div>
          <div class="skeleton mt-3 h-6 w-28"></div>
          <div class="skeleton mt-3 h-2.5 w-24"></div>
        </div>
      {/each}
    </div>
    <div class="mt-4 grid gap-4 lg:grid-cols-5">
      <div class="card lg:col-span-2"><Skeleton rows={5} /></div>
      <div class="card lg:col-span-3"><Skeleton rows={7} /></div>
    </div>
  </div>
{:then d}
  {@const netMinor = d.accounts.reduce((s, a) => s + a.balance_minor, 0)}
  {@const budgetLeft = d.budgets.reduce(
    (s, b) => s + Math.max(0, b.amount_minor - b.spent_minor),
    0,
  )}
  {@const toReview = d.docs.filter((x) => x.status !== "reviewed").length}
  {@const catName = (id: string | null) =>
    d.categories.find((c) => c.id === id)?.name ?? "Uncategorised"}

  <PageHeader
    eyebrow="{d.book.name} · {d.book.currency}"
    title="{greeting()}."
    subtitle="Here is where {fmtMonth(month)} stands across your accounts."
  >
    {#snippet actions()}
      <button class="btn" onclick={() => router.go("reports")}>
        <Icon name="reports" size={14} />
        Reports
      </button>
      <button class="btn btn-primary" onclick={() => router.go("receipts")}>
        <Icon name="upload" size={14} />
        Import receipt
      </button>
    {/snippet}
  </PageHeader>

  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <StatCard
      label="Net balance"
      amount={netMinor}
      currency={d.book.currency}
      sub="{d.accounts.length} accounts"
      tone="accent"
    />
    <StatCard
      label="Spent · {fmtMonth(month)}"
      amount={d.spending.total_spent_minor}
      currency={d.spending.currency}
      sub="across {d.spending.by_category.length} categories"
    />
    <StatCard
      label="Budget remaining"
      amount={budgetLeft}
      currency={d.book.currency}
      sub="{d.budgets.length} category budgets"
    />
    <StatCard
      label="Slips to review"
      value={String(toReview)}
      sub={toReview > 0 ? "waiting in Receipts" : "all caught up"}
      tone={toReview > 0 ? "warning" : "neutral"}
    />
  </div>

  <!-- nudges: 100% local rules + stats over your own data -->
  {#if d.nudges.length > 0}
    <section class="card relative mt-4 overflow-hidden">
      <!-- The lime pen-stroke rule: quiet card, one crisp mark. -->
      <span
        class="absolute inset-y-0 left-0 w-0.5 bg-accent"
        aria-hidden="true"
      ></span>
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="sparkle" size={15} class="text-accent-ring dark:text-accent" />
          Nudges
          <span class="num text-t3">{d.nudges.length}</span>
        </h2>
        <span class="flex items-center gap-1.5 text-[11px] text-t3">
          <Icon name="shield" size={12} />
          computed on this machine
        </span>
      </header>
      <ul class="mt-2 pb-2">
        {#each d.nudges as n (n.id)}
          <li
            class="row-hover flex items-start gap-3 border-t border-line px-4 py-2.5 first:border-t-0"
          >
            <span class="mt-0.5 shrink-0">
              <Badge tone={nudgeTone[n.severity]} label={nudgeLabel[n.severity]} />
            </span>
            <span class="min-w-0 flex-1 leading-tight">
              <span class="block text-[12.5px] font-medium">{n.title}</span>
              <span class="block text-[11.5px] text-t3">{n.body}</span>
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="mt-4 grid gap-4 lg:grid-cols-5">
    <!-- spending by category -->
    <section class="card lg:col-span-2">
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="text-[13px] font-semibold">Spending by category</h2>
        <button
          class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
          onclick={() => router.go("budgets")}
        >
          Budgets
          <Icon name="arrow-right" size={12} />
        </button>
      </header>
      {#if d.spending.by_category.length === 0}
        <EmptyState
          title="Nothing spent yet"
          body="When transactions land, the month breaks down here."
        />
      {:else}
        <ul class="space-y-3 p-4">
          {#each d.spending.by_category.slice(0, 6) as row (row.category_id)}
            <li
              class="group"
              title="{row.category_name}: {fmtMoney(
                row.amount_minor,
                d.spending.currency,
              )} ({fmtPct(row.share)})"
            >
              <div class="mb-1 flex items-baseline justify-between gap-2">
                <span class="truncate text-[12.5px] text-t2"
                  >{row.category_name}</span
                >
                <span class="num text-t1"
                  >{fmtMoney(row.amount_minor, d.spending.currency)}
                  <span class="text-t3">· {fmtPct(row.share)}</span></span
                >
              </div>
              <!-- Single-series ranked bar — the shared .meter system, so
                   the spending hue (chart-1) stays identical to Reports. -->
              <div class="meter">
                <div
                  class="meter-fill group-hover:opacity-100"
                  style="width: {Math.max(2, row.share * 100)}%"
                ></div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- recent activity -->
    <section class="card lg:col-span-3">
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="text-[13px] font-semibold">Recent activity</h2>
        <button
          class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
          onclick={() => router.go("transactions")}
        >
          All transactions
          <Icon name="arrow-right" size={12} />
        </button>
      </header>
      {#if d.recent.length === 0}
        <EmptyState
          icon="transactions"
          title="No transactions yet"
          body="Connect a bank scraper, watch a folder, or add transactions manually — everything stays on this machine."
          hint="Press G then T to open Transactions"
        />
      {:else}
        <ul class="mt-2 pb-2">
          {#each d.recent as tx (tx.id)}
            <li
              class="row-hover flex items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0"
            >
              <span
                class="flex size-7 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
              >
                <Icon
                  name={tx.amount_minor > 0 ? "download" : "receipt"}
                  size={14}
                />
              </span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block truncate text-[12.5px] font-medium">
                  {tx.merchant ?? tx.description}
                </span>
                <span class="block truncate text-[11px] text-t3">
                  {fmtDate(tx.posted_at)} · {catName(tx.category_id)}
                </span>
              </span>
              <Money amount={tx.amount_minor} currency={tx.currency} signed colored />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load dashboard"
      body={String(err)}
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
