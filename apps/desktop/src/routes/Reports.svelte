<script lang="ts">
  /**
   * Reports — everything computed on this machine, from this book's rows.
   *
   * Two contracts this screen keeps.
   *
   * **The tax report is named by the region profile.** "VAT201" is the South
   * African profile's label; another profile calls it something else and
   * labels its boxes differently. Every string in that card comes from
   * `report_vat_summary` (`report_name`, `labels`) — no jurisdiction is
   * hardcoded anywhere on this screen.
   *
   * **FX provenance is shown, never hidden.** Converted report views are not
   * built (Phase 4.7): no figure here has been through an exchange rate, and
   * the FX card says so. What it *does* show is the rate cache exactly as
   * core records it — the decimal rate as a string, OpenRate's quality grade,
   * and how old the quote is — because a rate without its grade and its age
   * is a number pretending to be a fact.
   */
  import { api } from "../lib/api/client";
  import { fmtDate, fmtMoney, fmtMonth, fmtPct } from "../lib/format";
  import { swrLoad } from "../lib/loadCache";
  import { csvMoney, downloadCsv, toCsv } from "../lib/csv";
  import { datePresets, type DateRange } from "../lib/daterange";
  import type {
    Book,
    FxStatus,
    MemberCategoryRow,
    MemberSettleRow,
    SpendingReport,
    VatSummary,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import DateRangePicker from "../lib/components/DateRangePicker.svelte";
  import MemberAvatar from "../lib/components/MemberAvatar.svelte";

  /**
   * Everything period-scoped on this screen reads from one range, and it
   * starts on the picker's own first preset ("this month") so the control
   * opens showing a pressed button rather than a custom range nobody chose.
   */
  let range = $state<DateRange>(datePresets()[0]!.range);

  async function load() {
    const [book] = await api.bookList();
    if (!book) throw new Error("no book configured");
    const { from, to } = range;
    const [spending, incomeExpense, vat, members, settleUp, memberCategory, fx] =
      await Promise.all([
        api.reportSpending({ book_id: book.id, from, to }),
        api.reportIncomeExpense({ book_id: book.id }),
        // The tax period is a calendar month; the range's end month is the
        // one being reported on.
        api.reportVatSummary({ book_id: book.id, period: to.slice(0, 7) }),
        api.memberList({ book_id: book.id }),
        api.reportSettleUp({ book_id: book.id, from, to }),
        api.reportMemberCategory({ book_id: book.id, from, to }),
        // FX is opt-in and its service may not be wired at all. A missing
        // rate cache must not take the whole reports screen down with it.
        api.fxStatus().catch((): FxStatus | null => null),
      ]);
    return {
      book,
      spending,
      incomeExpense,
      vat,
      members,
      settleUp,
      memberCategory,
      fx,
      from,
      to,
    };
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>(`reports:${range.from}:${range.to}`, load, (v) => (data = v), {
      fresh,
    });
  let data = $state(reload());

  function setRange(next: DateRange) {
    range = next;
    data = reload();
  }

  /** `2026-07-01` → a locale short date, midday UTC so no zone loses a day. */
  const dayLabel = (iso: string) => fmtDate(`${iso}T12:00:00Z`);
  const rangeLabel = $derived(`${dayLabel(range.from)} – ${dayLabel(range.to)}`);

  // -- household: a member filter over the settle-up + category breakdown
  // (ARCHITECTURE.md "Household members & per-person attribution"). "" =
  // all members; "none" = the Unattributed bucket.
  let memberFilter = $state("");

  const shortMonth = (m: string) =>
    new Date(`${m}-01T12:00:00Z`).toLocaleString(undefined, { month: "short" });

  // Income-vs-expense: which month column is hovered or focused (null = none).
  // Drives the header read-out and dims the sibling columns for focus.
  let activeMonth = $state<number | null>(null);
  /** Roving tabindex within the column group: one tab stop, arrows to move. */
  let keyboardMonth = $state(0);
  let chartEl = $state<HTMLElement | null>(null);

  function onColumnKeydown(e: KeyboardEvent, index: number, count: number) {
    let next = -1;
    if (e.key === "ArrowRight") next = Math.min(count - 1, index + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    if (next < 0) return;
    e.preventDefault();
    keyboardMonth = next;
    chartEl?.querySelectorAll<HTMLElement>("button")[next]?.focus();
  }

  // -- spending list: full by default is too long, one row is too little ----
  let showAllCategories = $state(false);
  const TOP_CATEGORIES = 7;

  // -- FX provenance --------------------------------------------------------

  /** Staleness in words. `null` from core means *unknown*, which is a
   * different statement from "fresh" and is rendered as such. */
  function fmtAge(secs: number | null): string {
    if (secs === null) return "age unknown";
    if (secs < 90) return `${Math.max(0, Math.round(secs))}s old`;
    const mins = Math.round(secs / 60);
    if (mins < 90) return `${mins} min old`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h old`;
    return `${Math.round(hours / 24)}d old`;
  }

  // -- CSV exports: computed locally, downloaded as Blob object-URLs ---------

  let exportError = $state<string | null>(null);

  /** `transactions-personal-2026-07-01_2026-07-31.csv` — the period a file
   * covers belongs in its name, or the download folder becomes a guessing
   * game. */
  const fileName = (stem: string, book: Book) =>
    `${stem}-${book.slug}-${range.from}_${range.to}.csv`;

  async function exportTransactions(book: Book) {
    exportError = null;
    try {
      const [accounts, categories, rows] = await Promise.all([
        api.accountList({ book_id: book.id }),
        api.categoryList({ book_id: book.id }),
        api.transactionList({
          book_id: book.id,
          from: range.from,
          to: range.to,
        }),
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
      downloadCsv(fileName("transactions", book), csv);
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
    downloadCsv(fileName("spending", book), csv);
  }

  function exportSettleUp(book: Book, rows: MemberSettleRow[]) {
    exportError = null;
    const csv = toCsv(
      ["member", "contributed", "spent", "net", "currency"],
      rows.map((r) => [
        r.member_label,
        csvMoney(r.contributions_minor, r.currency),
        csvMoney(r.expenses_minor, r.currency),
        csvMoney(r.net_minor, r.currency),
        r.currency,
      ]),
    );
    downloadCsv(fileName("settle-up", book), csv);
  }

  function exportMemberCategory(book: Book, rows: MemberCategoryRow[]) {
    exportError = null;
    const csv = toCsv(
      ["member", "category", "amount", "currency"],
      rows.map((r) => [
        r.member_label,
        r.category_name,
        csvMoney(r.total_minor, r.currency),
        r.currency,
      ]),
    );
    downloadCsv(fileName("member-category", book), csv);
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

<div class="mb-4">
  <DateRangePicker
    from={range.from}
    to={range.to}
    label="Report period"
    onchange={setRange}
  />
</div>

{#if exportError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
    role="alert"
  >
    <Icon name="alert-circle" size={13} />
    {exportError}
  </p>
{/if}

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then d}
  {@const active =
    activeMonth !== null ? d.incomeExpense.months[activeMonth] : null}
  <div class="grid gap-4 lg:grid-cols-2">
    <!-- income vs expense -->
    <section class="card p-4">
      <header class="mb-4 flex h-5 items-baseline justify-between gap-3">
        <h2 class="shrink-0 text-[13px] font-semibold">Income vs expense</h2>
        {#if active}
          <!-- Hovered/focused month: exact figures in Geist Mono, live read-out. -->
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
        <!-- Each column is a real button with its own accessible name, so the
             read-out is reachable by keyboard rather than hover-only; the
             group is one tab stop and the arrows move between months. -->
        <div
          class="flex h-36 items-end gap-3 border-b border-line pb-1.5"
          role="group"
          aria-label="Monthly income versus expense, {d.incomeExpense.months
            .length} months"
          bind:this={chartEl}
        >
          {#each d.incomeExpense.months as m, i (m.month)}
            <button
              type="button"
              class="flex flex-1 cursor-default flex-col items-center rounded-sm transition-opacity duration-(--dur-quick) ease-(--ease-standard)"
              class:opacity-40={activeMonth !== null && activeMonth !== i}
              tabindex={keyboardMonth === i ? 0 : -1}
              aria-label="{fmtMonth(m.month)}: income {fmtMoney(
                m.income_minor,
                d.incomeExpense.currency,
              )}, expense {fmtMoney(m.expense_minor, d.incomeExpense.currency)}"
              onmouseenter={() => (activeMonth = i)}
              onmouseleave={() => (activeMonth = null)}
              onfocus={() => {
                activeMonth = i;
                keyboardMonth = i;
              }}
              onblur={() => (activeMonth = null)}
              onkeydown={(e) =>
                onColumnKeydown(e, i, d.incomeExpense.months.length)}
            >
              <span
                class="flex h-28 w-full items-end justify-center gap-1"
                aria-hidden="true"
              >
                <span
                  class="col-bar bg-ink-900 dark:bg-ink-200"
                  style="height: {Math.max(2, (m.income_minor / max) * 100)}%"
                ></span>
                <span
                  class="col-bar bg-accent-ring dark:bg-accent"
                  style="height: {Math.max(2, (m.expense_minor / max) * 100)}%"
                ></span>
              </span>
            </button>
          {/each}
        </div>
        <div class="mt-1.5 flex gap-3">
          {#each d.incomeExpense.months as m (m.month)}
            <span class="axis-label flex-1 text-center">{shortMonth(m.month)}</span>
          {/each}
        </div>
        <p class="mt-2 text-[11px] text-t3">
          Every month the book holds — this trend is not scoped by the period
          above.
        </p>
      {/if}
    </section>

    <!-- spending breakdown -->
    <section class="card p-4">
      <header class="mb-4 flex items-baseline justify-between gap-3">
        <h2 class="min-w-0 text-[13px] font-semibold">
          Spending <span class="font-normal text-t3">· {rangeLabel}</span>
        </h2>
        <span class="num shrink-0 text-t2"
          >{fmtMoney(d.spending.total_spent_minor, d.spending.currency)}</span
        >
      </header>
      {#if d.spending.by_category.length === 0}
        <EmptyState
          icon="budgets"
          title="No spending in this period"
          body="Categorised outflows will break down here."
        />
      {:else}
        {@const rows = showAllCategories
          ? d.spending.by_category
          : d.spending.by_category.slice(0, TOP_CATEGORIES)}
        <ul class="space-y-2.5">
          {#each rows as row (row.category_id)}
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
        {#if d.spending.by_category.length > TOP_CATEGORIES}
          <button
            class="btn btn-ghost mt-3 h-7 px-1.5 text-[11.5px] text-t2"
            aria-expanded={showAllCategories}
            onclick={() => (showAllCategories = !showAllCategories)}
          >
            <Icon
              name={showAllCategories ? "chevron-up" : "chevron-down"}
              size={12}
            />
            {showAllCategories
              ? "Show top " + TOP_CATEGORIES
              : `Show all ${d.spending.by_category.length} categories`}
          </button>
        {/if}
      {/if}
    </section>

    <!-- tax-period summary (named by the book's region profile) -->
    <section class="card p-4">
      <header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-[13px] font-semibold">
          {d.vat.report_name}
          <span class="font-normal text-t3">· {fmtMonth(d.vat.period)}</span>
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
        <div class="flex items-center justify-between gap-3 py-2">
          <dt class="text-t2">{d.vat.labels.output_tax}</dt>
          <dd class="num">{fmtMoney(d.vat.output_vat_minor, d.vat.currency)}</dd>
        </div>
        <div class="flex items-center justify-between gap-3 py-2">
          <dt class="text-t2">{d.vat.labels.input_tax}</dt>
          <dd class="num">{fmtMoney(d.vat.input_vat_minor, d.vat.currency)}</dd>
        </div>
        <div class="flex items-center justify-between gap-3 py-2 font-semibold">
          <dt>Net {d.vat.net_vat_minor <= 0 ? "refundable" : "payable"}</dt>
          <dd class="num">
            {fmtMoney(Math.abs(d.vat.net_vat_minor), d.vat.currency)}
          </dd>
        </div>
      </dl>
      <p class="mt-3 text-[11px] leading-relaxed text-t3">
        The report's name and every box label above come from this book's region
        profile ({d.book.region_name}) — {d.vat.labels.net_tax}. The period is a
        calendar month and follows the end of the range above.
      </p>
    </section>

    <!-- exchange rates: provenance for every rate core holds, and a plain
         statement that nothing on this screen has been converted -->
    <section class="card p-4">
      <header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-[13px] font-semibold">Exchange rates</h2>
        {#if d.fx?.configured}
          <Badge tone="neutral" dot={false} label="OpenRate configured" />
        {:else}
          <Badge tone="neutral" dot={false} label="not configured" />
        {/if}
      </header>
      {#if d.fx === null}
        <p class="text-[12px] leading-relaxed text-t2">
          The rate service did not answer, so there is nothing to report about
          it. No figure on this screen depends on one.
        </p>
      {:else if d.fx.cached_rates.length === 0}
        <p class="text-[12px] leading-relaxed text-t2">
          {#if d.fx.configured}
            No rates are cached yet. Fetching one is an explicit action in
            Settings; it is the only part of SlipScan that talks to a network.
          {:else}
            Exchange rates are opt-in and are not configured. Point SlipScan at
            an OpenRate endpoint in Settings if you want them.
          {/if}
        </p>
      {:else}
        <div class="table-wrap">
          <table class="w-full text-[12.5px]">
            <thead>
              <tr>
                <th class="th w-24">Pair</th>
                <th class="th text-right">Rate</th>
                <th class="th w-20">Grade</th>
                <th class="th w-40">As of</th>
              </tr>
            </thead>
            <tbody>
              {#each d.fx.cached_rates as r (`${r.from_currency}${r.to_currency}`)}
                <tr class="row-hover">
                  <td class="td num whitespace-nowrap"
                    >{r.from_currency}→{r.to_currency}</td
                  >
                  <!-- The exact decimal core stored, as a string. Never parsed
                       into a float here: money math is i64 minor units. -->
                  <td class="td num text-right">{r.rate}</td>
                  <td class="td">
                    <Badge tone="neutral" dot={false} label={r.grade} />
                  </td>
                  <td class="td text-t2">
                    <span class="num block whitespace-nowrap"
                      >{fmtDate(r.as_of)}</span
                    >
                    <span class="block text-[11px] text-t3">{fmtAge(r.age_secs)}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-t3">
        <Icon name="alert-circle" size={12} class="mt-0.5 shrink-0" />
        <span>
          <span class="font-medium text-t2">Nothing here is converted.</span>
          Every total on this screen is in the book's base currency ({d.book
            .currency}); activity recorded in another currency is left out of
          them rather than converted at some rate. Converted report views are
          not built yet.{#if d.fx && d.fx.cached_rates.length > 0}
            Where a rate <em>is</em> used, it comes with the grade and the age
            shown above — a rate without them is a number pretending to be a
            fact.{/if}
        </span>
      </p>
    </section>
  </div>

  <!-- household: settle-up ("who owes whom") + a per-member category filter
       (ARCHITECTURE.md "Household members & per-person attribution") -->
  {#if d.members.length > 0}
    <section class="card mt-4 p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-[13px] font-semibold">
          Household <span class="font-normal text-t3">· {rangeLabel}</span>
        </h2>
        <label class="flex items-center gap-2 text-[11.5px] text-t3">
          Member
          <select
            class="input h-7 w-40"
            bind:value={memberFilter}
            aria-label="Filter by member"
          >
            <option value="">All members</option>
            {#each d.members as m (m.id)}
              <option value={m.id}>{m.label}</option>
            {/each}
            <option value="none">Unattributed</option>
          </select>
        </label>
      </div>

      <!-- settle-up: net position per member over the period -->
      <div class="table-wrap mb-4">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr>
              <th class="th">Member</th>
              <th class="th text-right">Contributed</th>
              <th class="th text-right">Spent</th>
              <th class="th text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {#each d.settleUp.filter((r) => !memberFilter || (memberFilter === "none" ? r.member_id === null : r.member_id === memberFilter)) as row (row.member_id ?? "unattributed")}
              <tr class="row-hover">
                <td class="td">
                  <span class="flex items-center gap-2">
                    <MemberAvatar
                      member={row.member_id
                        ? (d.members.find((m) => m.id === row.member_id) ?? null)
                        : null}
                      size={18}
                    />
                    {row.member_label}
                  </span>
                </td>
                <td class="td num text-right"
                  >{fmtMoney(row.contributions_minor, row.currency)}</td
                >
                <td class="td num text-right"
                  >{fmtMoney(row.expenses_minor, row.currency)}</td
                >
                <td
                  class="td num text-right {row.net_minor > 0
                    ? 'text-success'
                    : row.net_minor < 0
                      ? 'text-danger'
                      : ''}"
                >
                  {fmtMoney(row.net_minor, row.currency, { signed: true })}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="mb-4 text-[11px] text-t3">
        Net = contributions minus attributed expenses. Positive means the
        household owes them; negative means they owe the household. Attribution
        is metadata: it never changes a debit or a credit.
      </p>

      <!-- category breakdown for the filtered member -->
      {#if memberFilter}
        {@const rows = d.memberCategory.filter((r) =>
          memberFilter === "none" ? r.member_id === null : r.member_id === memberFilter,
        )}
        {@const total = rows.reduce((s, r) => s + r.total_minor, 0)}
        {#if rows.length === 0}
          <p class="text-[12px] text-t3">No spend this period for this member.</p>
        {:else}
          <ul class="space-y-2">
            {#each rows as row (row.category_id ?? "uncategorized")}
              <li class="flex items-center gap-3">
                <span class="w-32 truncate text-[12px] text-t2">{row.category_name}</span>
                <div class="meter flex-1">
                  <div
                    class="meter-fill"
                    style="width: {total === 0
                      ? 0
                      : Math.max(2, (row.total_minor / total) * 100)}%"
                  ></div>
                </div>
                <span class="num w-24 text-right">{fmtMoney(row.total_minor, row.currency)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="text-[11.5px] text-t3">
          Select a member above to see their share of each category.
        </p>
      {/if}
    </section>
  {/if}

  <!-- exports -->
  <section class="card mt-4 p-4">
    <h2 class="mb-3 text-[13px] font-semibold">Exports</h2>
    <ul class="grid gap-2 sm:grid-cols-2">
      {#each [
        {
          label: "Transactions (CSV)",
          desc: `All accounts · ${rangeLabel}`,
          run: () => exportTransactions(d.book),
          skip: false,
        },
        {
          label: "Trial balance (CSV)",
          desc: "Every posted entry, as of today",
          run: () => exportTrialBalance(d.book),
          skip: false,
        },
        {
          label: "Spending by category (CSV)",
          desc: rangeLabel,
          run: () => exportSpending(d.book, d.spending),
          skip: false,
        },
        {
          label: `${d.vat.report_name} (CSV)`,
          desc: fmtMonth(d.vat.period),
          run: () => exportTax(d.book, d.vat),
          skip: false,
        },
        {
          label: "Settle up (CSV)",
          desc: `Per member · ${rangeLabel}`,
          run: () => exportSettleUp(d.book, d.settleUp),
          skip: d.members.length === 0,
        },
        {
          label: "Member by category (CSV)",
          desc: `Per member · ${rangeLabel}`,
          run: () => exportMemberCategory(d.book, d.memberCategory),
          skip: d.members.length === 0,
        },
      ].filter((e) => !e.skip) as exp (exp.label)}
        <li
          class="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5"
        >
          <span class="min-w-0 leading-tight">
            <span class="block truncate text-[12.5px] font-medium">{exp.label}</span>
            <span class="block truncate text-[11px] text-t3">{exp.desc}</span>
          </span>
          <button class="btn h-7 shrink-0" onclick={exp.run}>
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
