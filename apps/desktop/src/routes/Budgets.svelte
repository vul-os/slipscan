<script lang="ts">
  /**
   * Budgets — a monthly limit per category, and the burn against it.
   *
   * HONEST GAP, stated on screen and not only here: `rollover` is a flag
   * STORED on a budget and applied to nothing. No number on this screen is
   * adjusted by it, and next month's limit is not increased by what was left
   * over. The badge and the note below say exactly that, because a chip that
   * merely read "rollover" would imply a feature that does not exist.
   *
   * Everything else is computed from this book's own rows: `budget_list`
   * returns the limit joined with the period's actual spend, and the
   * drill-down lists the transactions behind it — same month, same category,
   * outflows only.
   */
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import {
    fmtDate,
    fmtMoney,
    fmtMonth,
    fmtPct,
    localDate,
    localMonth,
    monthEnd,
    parseMoneyInput,
    shiftMonth,
  } from "../lib/format";
  import { swrLoad } from "../lib/loadCache";
  import type {
    Book,
    BudgetWithSpend,
    Category,
    Transaction,
  } from "../lib/api/types";
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

  interface Data {
    budgets: BudgetWithSpend[];
    /** The month's transactions, for the per-category drill-down. */
    transactions: Transaction[];
    currency: string;
  }

  async function load(): Promise<Data> {
    const b = requireBook(await api.bookList());
    book = b;
    const from = `${month}-01`;
    const to = monthEnd(month);
    const [cats, budgets, transactions] = await Promise.all([
      api.categoryList({ book_id: b.id }),
      api.budgetList({ book_id: b.id, month }),
      api.transactionList({ book_id: b.id, from, to }),
    ]);
    categories = cats;
    // The book currency travels with the data so formatting never falls back
    // to a hardcoded one; per-budget rows still format in their own.
    return { budgets, transactions, currency: b.currency };
  }

  const reload = (fresh = false) =>
    swrLoad<Data>(`budgets:${month}`, load, (v) => (data = v), { fresh });
  let data = $state(reload());

  // -- period navigation ----------------------------------------------------
  // The stepper is the whole control: two chevrons, the month, and a Today
  // that only appears when it would do something. Left/Right arrows step it
  // while it has focus, so a keyboard user never has to hunt for the buttons.

  function goMonth(n: number) {
    month = shiftMonth(month, n);
    expanded = null;
    data = reload();
  }

  function goToday() {
    if (month === thisMonth) return;
    month = thisMonth;
    expanded = null;
    data = reload();
  }

  function onStepperKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goMonth(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      goMonth(1);
    }
  }

  /**
   * How far through the month "now" is, 0..1 — or null for any month that is
   * not the current one, where a pace marker would be meaningless. Drives the
   * tick on each meter: spend ahead of the tick is spend ahead of the clock.
   */
  const pace = $derived.by(() => {
    if (month !== thisMonth) return null;
    const today = localDate();
    const days = Number(monthEnd(month).slice(8));
    return Number(today.slice(8)) / days;
  });

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

  async function openForm(categoryId = "") {
    formError = null;
    formCategoryId = categoryId;
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

  // -- per-category drill-down ----------------------------------------------
  /** Budget id whose transactions are showing, if any. */
  let expanded = $state<string | null>(null);

  function toggleRow(id: string) {
    expanded = expanded === id ? null : id;
  }

  /** This month's outflows in one category, newest first. */
  function linesFor(all: Transaction[], categoryId: string): Transaction[] {
    return all
      .filter(
        (t) =>
          t.category_id === categoryId &&
          t.amount_minor < 0 &&
          t.posted_at.slice(0, 7) === month,
      )
      .sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1));
  }

  /**
   * Categorised outflow this month that no budget covers. Not an error — most
   * people budget a handful of categories — but it is the number that makes
   * "Spent so far" add up, so it is shown rather than quietly dropped.
   */
  function unbudgeted(all: Transaction[], budgets: BudgetWithSpend[]) {
    const covered = new Set(budgets.map((b) => b.category_id));
    const totals = new Map<string, number>();
    for (const t of all) {
      if (t.amount_minor >= 0) continue;
      if (t.posted_at.slice(0, 7) !== month) continue;
      if (t.category_id === null || covered.has(t.category_id)) continue;
      const cat = categories.find((c) => c.id === t.category_id);
      if (cat?.kind !== "expense") continue;
      totals.set(
        t.category_id,
        (totals.get(t.category_id) ?? 0) + -t.amount_minor,
      );
    }
    return [...totals.entries()]
      .map(([category_id, amount_minor]) => ({
        category_id,
        name: categories.find((c) => c.id === category_id)?.name ?? "—",
        amount_minor,
      }))
      .sort((a, b) => b.amount_minor - a.amount_minor);
  }

  /** Meter ink, semantic in three flat tones (never a gradient): lime while
   * there's comfortable headroom, amber as spend approaches the limit (≥85%),
   * red once it's met or breached — the same ok/warn/error logic the dashboard
   * nudges use. */
  function barTone(spent: number, amount: number): string {
    if (amount <= 0) return "bg-accent-ring dark:bg-accent";
    const ratio = spent / amount;
    if (ratio >= 1) return "bg-danger";
    if (ratio >= 0.85) return "bg-warning";
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
  subtitle="Monthly limits per category, tracked as transactions come in. Open a row to see exactly which transactions spent it."
>
  {#snippet actions()}
    <!-- A toolbar, not a widget: Left/Right step the month while focus is
         anywhere inside, and both chevrons stay ordinary buttons — the
         shortcut is an accelerator, never the only way through. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="flex items-center gap-0.5 rounded-lg border border-line p-0.5"
      role="group"
      aria-label="Budget month"
      aria-keyshortcuts="ArrowLeft ArrowRight"
      onkeydown={onStepperKeydown}
    >
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
      <button class="btn h-8" onclick={goToday}>Today</button>
    {/if}
    <button class="btn btn-primary" aria-expanded={showForm} onclick={toggleForm}>
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
        role="alert"
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
          inputmode="decimal"
          placeholder="e.g. 4 000,00"
          bind:value={formAmount}
        />
      </label>
      <label class="flex h-9 items-center gap-2 text-[12px] text-t2">
        <input type="checkbox" bind:checked={formRollover} />
        Flag rollover
        <span class="text-t3">(stored, not applied)</span>
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
{:then d}
  {#if d.budgets.length === 0}
    <div class="card">
      <EmptyState
        icon="budgets"
        title="No budgets for {fmtMonth(month)}"
        body="Set a monthly limit on the categories you care about — groceries, eating out, fuel — and SlipScan tracks the burn as transactions come in."
      >
        {#snippet actions()}
          <button class="btn btn-primary" onclick={() => openForm()}>
            <Icon name="plus" size={14} />
            Create your first budget
          </button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    {@const total = d.budgets.reduce((s, b) => s + b.amount_minor, 0)}
    {@const spent = d.budgets.reduce((s, b) => s + b.spent_minor, 0)}
    {@const cur = d.budgets[0].currency}
    {@const over = d.budgets.filter((b) => b.spent_minor > b.amount_minor)}
    {@const flagged = d.budgets.filter((b) => b.rollover)}
    <div class="mb-4 grid gap-3 sm:grid-cols-3">
      <StatCard
        label="Budgeted"
        amount={total}
        currency={cur}
        sub="{d.budgets.length} {d.budgets.length === 1
          ? 'category'
          : 'categories'} · {fmtMonth(month)}"
      />
      <StatCard
        label="Spent so far"
        amount={spent}
        currency={cur}
        tone={spent > total ? "warning" : "neutral"}
        sub={total > 0
          ? `${fmtPct(spent / total)} of the limit${
              pace === null ? "" : ` · ${fmtPct(pace)} through the month`
            }`
          : undefined}
      />
      <StatCard
        label={spent > total ? "Over budget" : "Remaining"}
        amount={Math.abs(total - spent)}
        currency={cur}
        tone={spent > total ? "danger" : "accent"}
        sub={over.length > 0
          ? `${over.length} ${over.length === 1 ? "category is" : "categories are"} over`
          : "every category still inside its limit"}
      />
    </div>

    {#if flagged.length > 0}
      <!-- The one thing this screen must not imply. `rollover` is stored on
           the budget and applied to nothing: no figure above or below is
           adjusted by it, and next month's limit is not raised by what was
           left. Said plainly, once, next to the budgets carrying the flag. -->
      <p
        class="mb-4 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-t2"
      >
        <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-warning" />
        <span>
          <span class="font-medium text-t1">Rollover is recorded, not applied.</span>
          {flagged.length}
          {flagged.length === 1 ? "budget carries" : "budgets carry"} the rollover
          flag. SlipScan stores it, but no number on this screen uses it — unspent
          amounts do not carry into {fmtMonth(shiftMonth(month, 1))}, and next
          month's limits are exactly what you set.
        </span>
      </p>
    {/if}

    <div class="card divide-y divide-line overflow-hidden">
      {#each d.budgets as b (b.id)}
        {@const remaining = b.amount_minor - b.spent_minor}
        {@const isOver = remaining < 0}
        {@const open = expanded === b.id}
        {@const lines = open ? linesFor(d.transactions, b.category_id) : []}
        {@const listed = lines.reduce((s, t) => s + -t.amount_minor, 0)}
        <div class="relative">
          {#if isOver}
            <!-- Over-budget rows carry the error semantic on their left edge —
                 a pen-stroke marker matching the dashboard's over-budget
                 nudge, so a problem row is scannable at a glance. -->
            <span
              class="absolute inset-y-0 left-0 z-10 w-0.5 bg-danger"
              aria-hidden="true"
            ></span>
          {/if}
          <button
            type="button"
            class="row-hover block w-full px-4 py-3.5 text-left"
            aria-expanded={open}
            aria-controls="budget-lines-{b.id}"
            onclick={() => toggleRow(b.id)}
          >
            <div class="mb-1.5 flex items-baseline justify-between gap-3">
              <span class="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                <Icon
                  name={open ? "chevron-up" : "chevron-down"}
                  size={12}
                  class="shrink-0 text-t3"
                />
                <span class="truncate">{b.category_name}</span>
                {#if b.rollover}
                  <Badge tone="neutral" dot={false} label="rollover: not applied" />
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
                {#if pace !== null}
                  <!-- Where the clock is, not where the money is: spend to the
                       right of this tick is spend ahead of the month. -->
                  <span
                    class="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-line-2"
                    style="left: {pace * 100}%"
                  ></span>
                {/if}
              </div>
              <!-- Fixed-width, no-wrap cell: the amount + its 'left/over' label
                   always stay on one line and right-align across every row, so
                   4-digit amounts never break the two-vs-one-line rhythm. -->
              <span
                class="num w-32 shrink-0 text-right whitespace-nowrap {isOver
                  ? 'text-danger'
                  : 'text-t2'}"
              >
                <Money amount={Math.abs(remaining)} currency={b.currency} />
                {isOver ? "over" : "left"}
              </span>
            </div>
          </button>
          {#if open}
            <div id="budget-lines-{b.id}" class="reveal">
              <div class="reveal-inner border-t border-line bg-sunken/40">
                {#if lines.length === 0}
                  <p class="px-4 py-3 text-[12px] text-t3">
                    No transactions in {b.category_name} this month. The burn above
                    is whatever core counted for the same period.
                  </p>
                {:else}
                  <table class="w-full text-[12.5px]">
                    <caption class="sr-only">
                      {b.category_name} transactions in {fmtMonth(month)}
                    </caption>
                    <tbody>
                      {#each lines as t (t.id)}
                        <tr class="row-hover">
                          <td class="td num w-28 border-t-0 pl-9 whitespace-nowrap text-t3"
                            >{fmtDate(t.posted_at)}</td
                          >
                          <td class="td max-w-0 border-t-0 text-t2">
                            <span class="block truncate"
                              >{t.merchant ?? t.description}</span
                            >
                          </td>
                          <td class="td w-32 border-t-0 pr-4 text-right">
                            <Money amount={-t.amount_minor} currency={t.currency} />
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                  <p class="px-4 py-2.5 text-[11px] text-t3">
                    {lines.length}
                    {lines.length === 1 ? "transaction" : "transactions"} ·
                    {fmtMoney(listed, b.currency)} listed
                    {#if listed !== b.spent_minor}
                      <span class="text-warning">
                        — the burn above ({fmtMoney(b.spent_minor, b.currency)}) is
                        computed by core over the same period and counts activity
                        not listed here.
                      </span>
                    {/if}
                  </p>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    {@const loose = unbudgeted(d.transactions, d.budgets)}
    {#if loose.length > 0}
      <section class="mt-6">
        <h2 class="mb-2 flex items-baseline gap-2">
          <span class="eyebrow">Spent outside a budget</span>
          <span class="num text-[10.5px] text-t3">{loose.length}</span>
        </h2>
        <div class="card divide-y divide-line overflow-hidden">
          {#each loose as row (row.category_id)}
            <div class="row-hover flex items-center gap-3 px-4 py-2.5">
              <span class="min-w-0 flex-1 truncate text-[12.5px] text-t2"
                >{row.name}</span
              >
              <Money
                amount={row.amount_minor}
                currency={d.currency}
                class="shrink-0 text-t2"
              />
              <button
                class="btn h-7 shrink-0"
                onclick={() => openForm(row.category_id)}
              >
                <Icon name="plus" size={12} />
                Budget this
              </button>
            </div>
          {/each}
        </div>
        <p class="mt-2 text-[11px] text-t3">
          Categorised outflow this month with no limit set. It is not counted in
          the totals above, which cover budgeted categories only.
        </p>
      </section>
    {/if}
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
