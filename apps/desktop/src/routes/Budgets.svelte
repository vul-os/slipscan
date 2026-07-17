<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtMoney, fmtMonth } from "../lib/format";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  const month = new Date().toISOString().slice(0, 7);

  async function load() {
    const [book] = await api.bookList();
    if (!book) throw new Error("no book configured");
    return api.budgetList({ book_id: book.id, month });
  }

  const data = load();

  function barTone(spent: number, amount: number): string {
    if (amount === 0) return "bg-ink-400";
    const r = spent / amount;
    if (r >= 1) return "bg-danger";
    if (r >= 0.8) return "bg-warning";
    return "bg-accent-ring dark:bg-accent";
  }
</script>

<PageHeader
  eyebrow={fmtMonth(month)}
  title="Budgets"
  subtitle="Monthly limits per category. Rollover carries what's left into next month."
>
  {#snippet actions()}
    <button class="btn">
      <Icon name="calendar" size={14} />
      {fmtMonth(month)}
    </button>
    <button class="btn btn-primary">
      <Icon name="plus" size={14} />
      New budget
    </button>
  {/snippet}
</PageHeader>

{#await data}
  <div class="card"><Skeleton rows={7} /></div>
{:then budgets}
  {#if budgets.length === 0}
    <div class="card">
      <EmptyState
        icon="budgets"
        title="No budgets for {fmtMonth(month)}"
        body="Set a monthly limit on the categories you care about — groceries, eating out, fuel — and SlipScan tracks the burn as transactions come in."
      >
        {#snippet actions()}
          <button class="btn btn-primary">
            <Icon name="plus" size={14} />
            Create your first budget
          </button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    {@const total = budgets.reduce((s, b) => s + b.amount_minor, 0)}
    {@const spent = budgets.reduce((s, b) => s + b.spent_minor, 0)}
    <div class="mb-4 grid grid-cols-3 gap-3">
      <StatCard label="Budgeted" value={fmtMoney(total)} />
      <StatCard
        label="Spent so far"
        value={fmtMoney(-spent)}
        tone={spent > total ? "danger" : "neutral"}
      />
      <StatCard
        label="Remaining"
        value={fmtMoney(Math.max(0, total - spent))}
        tone="accent"
      />
    </div>

    <div class="card divide-y divide-line">
      {#each budgets as b (b.id)}
        {@const remaining = b.amount_minor - b.spent_minor}
        <div class="px-4 py-3.5">
          <div class="mb-1.5 flex items-baseline justify-between gap-3">
            <span class="flex items-center gap-2 text-[13px] font-medium">
              {b.category_name}
              {#if b.rollover}
                <Badge tone="neutral" dot={false} label="rollover" />
              {/if}
            </span>
            <span class="num text-t2">
              {fmtMoney(b.spent_minor)}
              <span class="text-t3">of {fmtMoney(b.amount_minor)}</span>
            </span>
          </div>
          <div class="flex items-center gap-3">
            <div class="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
              <div
                class="h-full rounded-full transition-all {barTone(
                  b.spent_minor,
                  b.amount_minor,
                )}"
                style="width: {Math.min(
                  100,
                  (b.spent_minor / Math.max(1, b.amount_minor)) * 100,
                )}%"
              ></div>
            </div>
            <span
              class="num w-28 text-right {remaining < 0
                ? 'text-danger'
                : 'text-t2'}"
            >
              {remaining < 0
                ? `${fmtMoney(remaining)} over`
                : `${fmtMoney(remaining)} left`}
            </span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load budgets"
      body={String(err)}
    />
  </div>
{/await}
