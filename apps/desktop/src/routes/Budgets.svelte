<script lang="ts">
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import {
    fmtMoney,
    fmtMonth,
    localMonth,
    parseMoneyInput,
    shiftMonth,
  } from "../lib/format";
  import { swrLoad } from "../lib/loadCache";
  import type { Book, Category } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import Money from "../lib/components/Money.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  const thisMonth = localMonth();
  let month = $state(thisMonth);

  let book = $state<Book | null>(null);
  let categories = $state<Category[]>([]);

  async function load() {
    const [b] = await api.bookList();
    if (!b) throw new Error("no book configured");
    book = b;
    categories = await api.categoryList({ book_id: b.id });
    return api.budgetList({ book_id: b.id, month });
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>(`budgets:${month}`, load, (v) => (data = v), { fresh });
  let data = $state(reload());

  function goMonth(n: number) {
    month = shiftMonth(month, n);
    data = reload();
  }

  // -- new / updated budget -------------------------------------------------
  let showForm = $state(false);
  let formCategoryId = $state("");
  let formAmount = $state("");
  let formRollover = $state(false);
  let formBusy = $state(false);
  let formError = $state<string | null>(null);
  let formCategorySelect = $state<HTMLSelectElement | null>(null);

  function closeForm() {
    showForm = false;
    formError = null;
  }

  async function openForm() {
    formError = null;
    showForm = true;
    await tick();
    formCategorySelect?.focus();
  }

  function toggleForm() {
    if (showForm) closeForm();
    else openForm();
  }

  async function saveBudget() {
    if (!book) return;
    const amount = parseMoneyInput(formAmount, book.currency);
    if (!formCategoryId || amount === null || amount <= 0) {
      formError = "Pick a category and a positive amount.";
      return;
    }
    formError = null;
    formBusy = true;
    try {
      await api.budgetUpsert({
        book_id: book.id,
        category_id: formCategoryId,
        month,
        amount_minor: amount,
        currency: book.currency,
        rollover: formRollover,
      });
      formCategoryId = "";
      formAmount = "";
      formRollover = false;
      showForm = false;
      data = reload(true);
    } catch (err) {
      formError = String(err);
    } finally {
      formBusy = false;
    }
  }

  /** Meter ink: lime while under the limit; at/over it, the warn semantic —
   * a flat tone switch, never a gradient. */
  function barTone(spent: number, amount: number): string {
    if (amount > 0 && spent >= amount) return "bg-warning";
    return "bg-accent-ring dark:bg-accent";
  }

  /** Fill width: capped at 100, with a visible tick as soon as anything is
   * spent (a 0.1% sliver would otherwise render as nothing). */
  function barWidth(spent: number, amount: number): number {
    if (spent <= 0) return 0;
    return Math.min(100, Math.max(1.5, (spent / Math.max(1, amount)) * 100));
  }
</script>

<PageHeader
  eyebrow={fmtMonth(month)}
  title="Budgets"
  subtitle="Monthly limits per category, tracked as transactions come in. (Rollover of unspent amounts is stored per budget but not yet applied to next month's numbers.)"
>
  {#snippet actions()}
    <div class="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
      <button
        class="btn btn-ghost h-7 px-2"
        aria-label="Previous month"
        onclick={() => goMonth(-1)}
      >
        <Icon name="chevron-left" size={13} />
      </button>
      <!-- min-width keeps the chevrons from drifting as month names change -->
      <span
        class="flex min-w-[7.5rem] items-center justify-center gap-1.5 px-1.5 text-[12.5px] font-medium"
        aria-live="polite"
      >
        <Icon name="calendar" size={13} class="text-t3" />
        {fmtMonth(month)}
      </span>
      <button
        class="btn btn-ghost h-7 px-2"
        aria-label="Next month"
        onclick={() => goMonth(1)}
      >
        <Icon name="chevron-right" size={13} />
      </button>
    </div>
    {#if month !== thisMonth}
      <button
        class="btn h-8"
        onclick={() => {
          month = thisMonth;
          data = reload();
        }}
      >
        Today
      </button>
    {/if}
    <button class="btn btn-primary" onclick={toggleForm}>
      <Icon name="plus" size={14} />
      New budget
    </button>
  {/snippet}
</PageHeader>

{#if showForm}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
       Escape-to-close only; interaction lives on the inputs/buttons. -->
  <form
    class="card animate-slide-up mb-4 p-4"
    onsubmit={(e) => {
      e.preventDefault();
      saveBudget();
    }}
    onkeydown={(e) => {
      if (e.key === "Escape") closeForm();
    }}
  >
    <h2 class="mb-3 text-[13px] font-semibold">
      Budget for {fmtMonth(month)}
    </h2>
    {#if formError}
      <p
        class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
      >
        <Icon name="alert-circle" size={13} />
        {formError}
      </p>
    {/if}
    <div class="flex flex-wrap items-end gap-3">
      <label class="block min-w-52">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Category</span>
        <select class="input" bind:this={formCategorySelect} bind:value={formCategoryId}>
          <option value="" disabled>Pick a category…</option>
          {#each categories.filter((c) => c.kind === "expense") as c (c.id)}
            <option value={c.id}>{c.icon ?? ""} {c.name}</option>
          {/each}
        </select>
      </label>
      <label class="block w-40">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Monthly limit</span
        >
        <input
          class="input text-right font-mono"
          placeholder="e.g. 4 000,00"
          bind:value={formAmount}
        />
      </label>
      <label class="flex h-9 items-center gap-2 text-[12px] text-t2">
        <input type="checkbox" bind:checked={formRollover} />
        Roll over what's left (not applied yet)
      </label>
      <button class="btn btn-primary" type="submit" disabled={formBusy}>
        {formBusy ? "Saving…" : "Save budget"}
      </button>
      <button class="btn btn-ghost" type="button" onclick={closeForm}>
        Cancel
      </button>
    </div>
  </form>
{/if}

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
          <button class="btn btn-primary" onclick={openForm}>
            <Icon name="plus" size={14} />
            Create your first budget
          </button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    {@const total = budgets.reduce((s, b) => s + b.amount_minor, 0)}
    {@const spent = budgets.reduce((s, b) => s + b.spent_minor, 0)}
    {@const cur = budgets[0].currency}
    <div class="mb-4 grid gap-3 sm:grid-cols-3">
      <StatCard label="Budgeted" value={fmtMoney(total, cur)} />
      <StatCard
        label="Spent so far"
        value={fmtMoney(spent, cur)}
        tone={spent > total ? "warning" : "neutral"}
      />
      <StatCard
        label="Remaining"
        value={fmtMoney(Math.max(0, total - spent), cur)}
        tone="accent"
      />
    </div>

    <div class="card divide-y divide-line">
      {#each budgets as b (b.id)}
        {@const remaining = b.amount_minor - b.spent_minor}
        <div class="px-4 py-3.5">
          <div class="mb-1.5 flex items-baseline justify-between gap-3">
            <span class="flex min-w-0 items-center gap-2 text-[13px] font-medium">
              <span class="truncate">{b.category_name}</span>
              {#if b.rollover}
                <Badge tone="neutral" dot={false} label="rollover" />
              {/if}
            </span>
            <span class="num shrink-0 text-t2">
              <Money amount={b.spent_minor} currency={b.currency} />
              <span class="text-t3">
                of <Money amount={b.amount_minor} currency={b.currency} />
              </span>
            </span>
          </div>
          <div class="flex items-center gap-3">
            <!-- The meter is a ruled hairline with a pen stroke of ink over
                 it — numbers in the row carry the data; this is aria-hidden. -->
            <div class="relative h-2 flex-1" aria-hidden="true">
              <span
                class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line"
              ></span>
              <span
                class="absolute top-1/2 left-0 h-[3px] -translate-y-1/2 rounded-full {barTone(
                  b.spent_minor,
                  b.amount_minor,
                )}"
                style="width: {barWidth(b.spent_minor, b.amount_minor)}%;
                  transition: width var(--dur-slow) var(--ease-standard);"
              ></span>
            </div>
            <span
              class="num w-28 shrink-0 text-right {remaining < 0
                ? 'text-warning'
                : 'text-t2'}"
            >
              <Money amount={Math.abs(remaining)} currency={b.currency} />
              {remaining < 0 ? "over" : "left"}
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
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
