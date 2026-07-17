<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtMoney, fmtMonth, fmtPct } from "../lib/format";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Icon from "../lib/components/Icon.svelte";

  const month = new Date().toISOString().slice(0, 7);

  async function load() {
    const [book] = await api.bookList();
    if (!book) throw new Error("no book configured");
    const [spending, incomeExpense, vat] = await Promise.all([
      api.reportSpending({
        book_id: book.id,
        from: `${month}-01`,
        to: `${month}-31`,
      }),
      api.reportIncomeExpense({ book_id: book.id }),
      api.reportVatSummary({ book_id: book.id, period: month }),
    ]);
    return { book, spending, incomeExpense, vat };
  }

  const data = load();

  const shortMonth = (m: string) =>
    new Date(`${m}-01T12:00:00Z`).toLocaleString("en-ZA", { month: "short" });
</script>

<PageHeader
  eyebrow="Insight without upload"
  title="Reports"
  subtitle="Spending, income vs expense, VAT and trial balance — computed locally, exportable as CSV."
>
  {#snippet actions()}
    <button class="btn">
      <Icon name="download" size={14} />
      Export CSV
    </button>
  {/snippet}
</PageHeader>

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then d}
  <div class="grid gap-4 lg:grid-cols-2">
    <!-- income vs expense -->
    <section class="card p-4">
      <header class="mb-4 flex items-baseline justify-between">
        <h2 class="text-[13px] font-semibold">Income vs expense</h2>
        <span class="flex items-center gap-3 text-[11px] text-t3">
          <span class="flex items-center gap-1.5">
            <span class="size-2 rounded-[3px] bg-ink-900 dark:bg-ink-200"
            ></span> income
          </span>
          <span class="flex items-center gap-1.5">
            <span class="size-2 rounded-[3px] bg-accent-ring dark:bg-accent"
            ></span> expense
          </span>
        </span>
      </header>
      {#if d.incomeExpense.months.length === 0}
        <EmptyState
          icon="reports"
          title="Not enough data yet"
          body="Once a month or two of transactions is in, the trend shows here."
        />
      {:else}
        {@const max = Math.max(
          ...d.incomeExpense.months.map((m) =>
            Math.max(m.income_minor, m.expense_minor),
          ),
        )}
        <div class="flex h-40 items-end gap-3">
          {#each d.incomeExpense.months as m (m.month)}
            <div class="flex flex-1 flex-col items-center gap-1.5">
              <div class="flex h-32 w-full items-end justify-center gap-1">
                <div
                  class="w-3.5 rounded-t-[3px] bg-ink-900 dark:bg-ink-200"
                  style="height: {Math.max(2, (m.income_minor / max) * 100)}%"
                  title="Income {fmtMoney(m.income_minor)}"
                ></div>
                <div
                  class="w-3.5 rounded-t-[3px] bg-accent-ring dark:bg-accent"
                  style="height: {Math.max(2, (m.expense_minor / max) * 100)}%"
                  title="Expense {fmtMoney(m.expense_minor)}"
                ></div>
              </div>
              <span class="text-[10.5px] text-t3">{shortMonth(m.month)}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- spending breakdown -->
    <section class="card p-4">
      <header class="mb-4 flex items-baseline justify-between">
        <h2 class="text-[13px] font-semibold">
          Spending · {fmtMonth(month)}
        </h2>
        <span class="num text-t2">{fmtMoney(-d.spending.total_spent_minor)}</span
        >
      </header>
      {#if d.spending.by_category.length === 0}
        <EmptyState
          icon="budgets"
          title="No spending this month"
          body="Categorised outflows will break down here."
        />
      {:else}
        <ul class="space-y-2.5">
          {#each d.spending.by_category.slice(0, 7) as row (row.category_id)}
            <li class="flex items-center gap-3">
              <span class="w-32 truncate text-[12px] text-t2"
                >{row.category_name}</span
              >
              <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                <div
                  class="h-full rounded-full bg-ink-900 dark:bg-ink-200"
                  style="width: {Math.max(2, row.share * 100)}%"
                ></div>
              </div>
              <span class="num w-24 text-right">{fmtMoney(row.amount_minor)}</span>
              <span class="num w-10 text-right text-t3">{fmtPct(row.share)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- VAT summary -->
    <section class="card p-4">
      <header class="mb-3 flex items-baseline justify-between">
        <h2 class="text-[13px] font-semibold">VAT summary · {fmtMonth(month)}</h2>
        <button class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3">
          <Icon name="download" size={12} />
          VAT201 export
        </button>
      </header>
      <dl class="divide-y divide-line text-[12.5px]">
        <div class="flex items-center justify-between py-2">
          <dt class="text-t2">Output VAT (sales)</dt>
          <dd class="num">{fmtMoney(d.vat.output_vat_minor)}</dd>
        </div>
        <div class="flex items-center justify-between py-2">
          <dt class="text-t2">Input VAT (purchases)</dt>
          <dd class="num">{fmtMoney(d.vat.input_vat_minor)}</dd>
        </div>
        <div class="flex items-center justify-between py-2 font-semibold">
          <dt>Net {d.vat.net_vat_minor <= 0 ? "refundable" : "payable"}</dt>
          <dd class="num">{fmtMoney(Math.abs(d.vat.net_vat_minor))}</dd>
        </div>
      </dl>
    </section>

    <!-- exports -->
    <section class="card p-4">
      <h2 class="mb-3 text-[13px] font-semibold">Exports</h2>
      <ul class="space-y-2">
        {#each [
          { label: "Transactions (CSV)", desc: "All accounts, current book" },
          { label: "Trial balance (CSV)", desc: "As of today" },
          { label: "Spending by category (CSV)", desc: fmtMonth(month) },
        ] as exp (exp.label)}
          <li
            class="flex items-center justify-between rounded-lg border border-line px-3 py-2.5"
          >
            <span class="leading-tight">
              <span class="block text-[12.5px] font-medium">{exp.label}</span>
              <span class="block text-[11px] text-t3">{exp.desc}</span>
            </span>
            <button class="btn h-7">
              <Icon name="download" size={13} />
              Export
            </button>
          </li>
        {/each}
      </ul>
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
        <Icon name="shield" size={12} />
        Reports are computed on this machine. Nothing is uploaded, ever.
      </p>
    </section>
  </div>
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load reports"
      body={String(err)}
    />
  </div>
{/await}
