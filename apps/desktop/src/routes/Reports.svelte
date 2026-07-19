<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtMoney, fmtMonth, fmtPct, localMonth, monthEnd } from "../lib/format";
  import { swrLoad } from "../lib/loadCache";
  import { csvMoney, downloadCsv, toCsv } from "../lib/csv";
  import type { Book, SpendingReport, VatSummary } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Icon from "../lib/components/Icon.svelte";

  const month = localMonth();

  async function load() {
    const [book] = await api.bookList();
    if (!book) throw new Error("no book configured");
    const [spending, incomeExpense, vat] = await Promise.all([
      api.reportSpending({
        book_id: book.id,
        from: `${month}-01`,
        to: monthEnd(month),
      }),
      api.reportIncomeExpense({ book_id: book.id }),
      api.reportVatSummary({ book_id: book.id, period: month }),
    ]);
    return { book, spending, incomeExpense, vat };
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>("reports", load, (v) => (data = v), { fresh });
  let data = $state(reload());

  const shortMonth = (m: string) =>
    new Date(`${m}-01T12:00:00Z`).toLocaleString(undefined, { month: "short" });

  // Income-vs-expense: which month column the pointer is over (null = none).
  // Drives the header read-out and dims the sibling columns for focus.
  let hoveredMonth = $state<number | null>(null);

  // -- CSV exports: computed locally, downloaded as Blob object-URLs ---------

  let exportError = $state<string | null>(null);

  async function exportTransactions(book: Book) {
    exportError = null;
    try {
      const [accounts, categories, rows] = await Promise.all([
        api.accountList({ book_id: book.id }),
        api.categoryList({ book_id: book.id }),
        api.transactionList({ book_id: book.id }),
      ]);
      const accountName = (id: string) =>
        accounts.find((a) => a.id === id)?.name ?? "";
      const categoryName = (id: string | null) =>
        categories.find((c) => c.id === id)?.name ?? "";
      const csv = toCsv(
        ["date", "description", "merchant", "account", "category", "amount", "currency"],
        rows.map((t) => [
          t.posted_at.slice(0, 10),
          t.description,
          t.merchant,
          accountName(t.account_id),
          categoryName(t.category_id),
          csvMoney(t.amount_minor, t.currency),
          t.currency,
        ]),
      );
      downloadCsv(`transactions-${book.slug}.csv`, csv);
    } catch (err) {
      exportError = String(err);
    }
  }

  async function exportTrialBalance(book: Book) {
    exportError = null;
    try {
      const tb = await api.reportTrialBalance({ book_id: book.id });
      const csv = toCsv(
        ["code", "account", "type", "debit", "credit", "currency"],
        [
          ...tb.rows.map((r) => [
            r.code,
            r.name,
            r.type,
            csvMoney(r.debit_minor, tb.currency),
            csvMoney(r.credit_minor, tb.currency),
            tb.currency,
          ]),
          [
            "",
            "Totals",
            "",
            csvMoney(tb.total_debit_minor, tb.currency),
            csvMoney(tb.total_credit_minor, tb.currency),
            tb.currency,
          ],
        ],
      );
      downloadCsv(`trial-balance-${book.slug}.csv`, csv);
    } catch (err) {
      exportError = String(err);
    }
  }

  function exportSpending(book: Book, spending: SpendingReport) {
    exportError = null;
    const csv = toCsv(
      ["category", "amount", "share", "currency"],
      [
        ...spending.by_category.map((r) => [
          r.category_name,
          csvMoney(r.amount_minor, spending.currency),
          r.share.toFixed(4),
          spending.currency,
        ]),
        [
          "Total",
          csvMoney(spending.total_spent_minor, spending.currency),
          "",
          spending.currency,
        ],
      ],
    );
    downloadCsv(`spending-${book.slug}-${month}.csv`, csv);
  }

  // The tax report's name and box labels come from the book's region
  // profile ("VAT201" in South Africa, "Tax summary" generically) — the UI
  // never hardcodes a jurisdiction's wording.
  function exportTax(book: Book, vat: VatSummary) {
    exportError = null;
    const csv = toCsv(
      ["item", "amount", "currency"],
      [
        [vat.labels.output_tax, csvMoney(vat.output_vat_minor, vat.currency), vat.currency],
        [vat.labels.input_tax, csvMoney(vat.input_vat_minor, vat.currency), vat.currency],
        [vat.labels.net_tax, csvMoney(vat.net_vat_minor, vat.currency), vat.currency],
      ],
    );
    const slug = vat.report_name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    downloadCsv(`${slug}-${book.slug}-${vat.period}.csv`, csv);
  }
</script>

<PageHeader
  eyebrow="Insight without upload"
  title="Reports"
  subtitle="Spending, income vs expense, tax and trial balance — computed locally, exportable as CSV."
>
  {#snippet actions()}
    <button
      class="btn"
      onclick={async () => {
        // When the initial load failed, `await data` re-throws its
        // rejection — surface it instead of silently doing nothing.
        try {
          await exportTransactions((await data).book);
        } catch (err) {
          exportError = String(err);
        }
      }}
    >
      <Icon name="download" size={14} />
      Export CSV
    </button>
  {/snippet}
</PageHeader>

{#if exportError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    {exportError}
  </p>
{/if}

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then d}
  {@const active =
    hoveredMonth !== null ? d.incomeExpense.months[hoveredMonth] : null}
  <div class="grid gap-4 lg:grid-cols-2">
    <!-- income vs expense -->
    <section class="card p-4">
      <header class="mb-4 flex h-5 items-baseline justify-between gap-3">
        <h2 class="shrink-0 text-[13px] font-semibold">Income vs expense</h2>
        {#if active}
          <!-- Hovered month: exact figures in Geist Mono, live read-out. -->
          <span class="flex items-center gap-3 text-[11px] whitespace-nowrap">
            <span class="text-t3">{shortMonth(active.month)}</span>
            <span class="flex items-center gap-1.5">
              <span class="size-2 shrink-0 rounded-[3px] bg-ink-900 dark:bg-ink-200"
              ></span>
              <span class="num text-t1"
                >{fmtMoney(active.income_minor, d.incomeExpense.currency)}</span
              >
            </span>
            <span class="flex items-center gap-1.5">
              <span class="size-2 shrink-0 rounded-[3px] bg-accent-ring dark:bg-accent"
              ></span>
              <span class="num text-t1"
                >{fmtMoney(active.expense_minor, d.incomeExpense.currency)}</span
              >
            </span>
          </span>
        {:else}
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
        {/if}
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
        <!-- Peak caption anchors the vertical scale; the baseline hairline
             gives the columns a zero to stand on. -->
        <div class="mb-1 flex justify-end">
          <span class="axis-label">{fmtMoney(max, d.incomeExpense.currency)}</span>
        </div>
        <div
          class="flex h-36 items-end gap-3 border-b border-line pb-1.5"
          role="img"
          aria-label="Monthly income versus expense, {d.incomeExpense.months
            .length} months"
        >
          {#each d.incomeExpense.months as m, i (m.month)}
            <!-- Decorative to AT (the chart wrapper carries role="img" + a
                 label); the hover only drives the sighted read-out. -->
            <div
              class="flex flex-1 flex-col items-center gap-1.5 transition-opacity duration-(--dur-quick) ease-(--ease-standard)"
              class:opacity-40={hoveredMonth !== null && hoveredMonth !== i}
              role="presentation"
              onmouseenter={() => (hoveredMonth = i)}
              onmouseleave={() => (hoveredMonth = null)}
            >
              <div class="flex h-28 w-full items-end justify-center gap-1">
                <div
                  class="col-bar bg-ink-900 dark:bg-ink-200"
                  style="height: {Math.max(2, (m.income_minor / max) * 100)}%"
                  title="Income {fmtMoney(m.income_minor, d.incomeExpense.currency)}"
                ></div>
                <div
                  class="col-bar bg-accent-ring dark:bg-accent"
                  style="height: {Math.max(2, (m.expense_minor / max) * 100)}%"
                  title="Expense {fmtMoney(m.expense_minor, d.incomeExpense.currency)}"
                ></div>
              </div>
            </div>
          {/each}
        </div>
        <div class="mt-1.5 flex gap-3">
          {#each d.incomeExpense.months as m (m.month)}
            <span class="axis-label flex-1 text-center">{shortMonth(m.month)}</span>
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
        <span class="num text-t2"
          >{fmtMoney(d.spending.total_spent_minor, d.spending.currency)}</span
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
            <li
              class="group flex items-center gap-3"
              title="{row.category_name}: {fmtMoney(
                row.amount_minor,
                d.spending.currency,
              )} ({fmtPct(row.share)})"
            >
              <span class="w-32 truncate text-[12px] text-t2"
                >{row.category_name}</span
              >
              <div class="meter flex-1">
                <div
                  class="meter-fill group-hover:opacity-100"
                  style="width: {Math.max(2, row.share * 100)}%"
                ></div>
              </div>
              <span class="num w-24 text-right"
                >{fmtMoney(row.amount_minor, d.spending.currency)}</span
              >
              <span class="num w-10 text-right text-t3">{fmtPct(row.share)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- tax-period summary (named by the book's region profile) -->
    <section class="card p-4">
      <header class="mb-3 flex items-baseline justify-between">
        <h2 class="text-[13px] font-semibold">
          {d.vat.report_name} · {fmtMonth(month)}
        </h2>
        <button
          class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
          onclick={() => exportTax(d.book, d.vat)}
        >
          <Icon name="download" size={12} />
          CSV export
        </button>
      </header>
      <dl class="divide-y divide-line text-[12.5px]">
        <div class="flex items-center justify-between py-2">
          <dt class="text-t2">{d.vat.labels.output_tax}</dt>
          <dd class="num">{fmtMoney(d.vat.output_vat_minor, d.vat.currency)}</dd>
        </div>
        <div class="flex items-center justify-between py-2">
          <dt class="text-t2">{d.vat.labels.input_tax}</dt>
          <dd class="num">{fmtMoney(d.vat.input_vat_minor, d.vat.currency)}</dd>
        </div>
        <div class="flex items-center justify-between py-2 font-semibold">
          <dt>Net {d.vat.net_vat_minor <= 0 ? "refundable" : "payable"}</dt>
          <dd class="num">
            {fmtMoney(Math.abs(d.vat.net_vat_minor), d.vat.currency)}
          </dd>
        </div>
      </dl>
    </section>

    <!-- exports -->
    <section class="card p-4">
      <h2 class="mb-3 text-[13px] font-semibold">Exports</h2>
      <ul class="space-y-2">
        {#each [
          {
            label: "Transactions (CSV)",
            desc: "All accounts, current book",
            run: () => exportTransactions(d.book),
          },
          {
            label: "Trial balance (CSV)",
            desc: "As of today",
            run: () => exportTrialBalance(d.book),
          },
          {
            label: "Spending by category (CSV)",
            desc: fmtMonth(month),
            run: () => exportSpending(d.book, d.spending),
          },
        ] as exp (exp.label)}
          <li
            class="flex items-center justify-between rounded-lg border border-line px-3 py-2.5"
          >
            <span class="leading-tight">
              <span class="block text-[12.5px] font-medium">{exp.label}</span>
              <span class="block text-[11px] text-t3">{exp.desc}</span>
            </span>
            <button class="btn h-7" onclick={exp.run}>
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
      <p class="mt-1.5 text-[11px] text-t3">
        Totals are in the book's base currency ({d.book.currency}); activity
        recorded in other currencies is not converted and is left out of them.
      </p>
    </section>
  </div>
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load reports"
      body={String(err)}
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
