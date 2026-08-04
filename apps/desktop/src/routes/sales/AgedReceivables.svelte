<script lang="ts">
  /**
   * Sales › Aged receivables — who owes what, and how late.
   *
   * A thin, honest wrapper over `report_aged_receivables`: every bucket is
   * exactly what the server computed as of the chosen date, nothing is
   * summed or re-derived here. `AgedBucket` carries no currency field —
   * every invoice this report can see is issued in the book's own currency
   * in practice (the mock defaults an invoice's currency to the book's when
   * none is given, the same as an order), so this renders every figure in
   * `book.currency` rather than inventing a per-row one.
   */
  import { api } from "../../lib/api/client";
  import { localDate } from "../../lib/util/format";
  import type { AgedReceivables, Book } from "../../lib/api/types";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Skeleton from "../../lib/components/Skeleton.svelte";
  import Money from "../../lib/components/Money.svelte";
  import StatCard from "../../lib/components/StatCard.svelte";
  import Icon from "../../lib/components/Icon.svelte";

  let { book }: { book: Book } = $props();

  let asOf = $state(localDate());
  let report = $state<AgedReceivables | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load() {
    loading = true;
    loadError = null;
    try {
      report = await api.reportAgedReceivables({ book_id: book.id, as_of: asOf });
    } catch (err) {
      loadError = String(err);
    } finally {
      loading = false;
    }
  }
  void load();

  const overdueOf = (b: { overdue_1_30_minor: number; overdue_31_60_minor: number; overdue_61_90_minor: number; overdue_90_plus_minor: number }) =>
    b.overdue_1_30_minor + b.overdue_31_60_minor + b.overdue_61_90_minor + b.overdue_90_plus_minor;
</script>

<div class="mb-4 flex flex-wrap items-center gap-2">
  <label class="flex items-center gap-1.5 text-[12px] text-t3">
    As of
    <input
      class="input h-8 w-40"
      type="date"
      bind:value={asOf}
      onchange={load}
    />
  </label>
  <span class="text-[11.5px] text-t3">
    Every unpaid or partly-paid invoice issued on or before this date, bucketed by how overdue it is.
  </span>
</div>

{#if loading}
  <div class="card"><Skeleton rows={6} /></div>
{:else if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load aged receivables" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={load}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if report}
  {#if report.rows.length === 0}
    <div class="card">
      <EmptyState
        icon="check-circle"
        title="Nothing outstanding"
        body="Every invoice as of {asOf} is paid in full, or none has been issued yet. This report only lists contacts still owed something."
      />
    </div>
  {:else}
    <div class="mb-4 grid gap-3 sm:grid-cols-3">
      <StatCard
        label="Total outstanding"
        amount={report.totals.total_minor}
        currency={book.currency}
        sub="{report.rows.length} {report.rows.length === 1 ? 'contact' : 'contacts'}"
      />
      <StatCard
        label="Current"
        amount={report.totals.current_minor}
        currency={book.currency}
        tone="accent"
        sub="not yet overdue"
      />
      <StatCard
        label="Overdue"
        amount={overdueOf(report.totals)}
        currency={book.currency}
        tone={overdueOf(report.totals) > 0 ? "danger" : "neutral"}
        sub="1 day or more past due"
      />
    </div>

    <div class="card overflow-hidden">
      <div class="table-wrap table-scroll">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr>
              <th class="th">Contact</th>
              <th class="th w-28 text-right">Current</th>
              <th class="th w-28 text-right">1–30 days</th>
              <th class="th w-28 text-right">31–60 days</th>
              <th class="th w-28 text-right">61–90 days</th>
              <th class="th w-28 text-right">90+ days</th>
              <th class="th w-32 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {#each report.rows as row (row.contact_id)}
              <tr class="row-hover">
                <td class="td max-w-0">
                  <span class="block truncate font-medium">{row.contact_name}</span>
                </td>
                <td class="td text-right">
                  <Money amount={row.buckets.current_minor} currency={book.currency} />
                </td>
                <td class="td text-right">
                  <Money amount={row.buckets.overdue_1_30_minor} currency={book.currency} />
                </td>
                <td class="td text-right">
                  <Money amount={row.buckets.overdue_31_60_minor} currency={book.currency} />
                </td>
                <td class="td text-right">
                  <Money
                    amount={row.buckets.overdue_61_90_minor}
                    currency={book.currency}
                    class={row.buckets.overdue_61_90_minor > 0 ? "text-warning" : ""}
                  />
                </td>
                <td class="td text-right">
                  <Money
                    amount={row.buckets.overdue_90_plus_minor}
                    currency={book.currency}
                    class={row.buckets.overdue_90_plus_minor > 0 ? "text-danger" : ""}
                  />
                </td>
                <td class="td text-right font-semibold">
                  <Money amount={row.buckets.total_minor} currency={book.currency} />
                </td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr class="border-t border-line-2 font-semibold">
              <td class="td">Total</td>
              <td class="td text-right">
                <Money amount={report.totals.current_minor} currency={book.currency} />
              </td>
              <td class="td text-right">
                <Money amount={report.totals.overdue_1_30_minor} currency={book.currency} />
              </td>
              <td class="td text-right">
                <Money amount={report.totals.overdue_31_60_minor} currency={book.currency} />
              </td>
              <td class="td text-right">
                <Money amount={report.totals.overdue_61_90_minor} currency={book.currency} />
              </td>
              <td class="td text-right">
                <Money amount={report.totals.overdue_90_plus_minor} currency={book.currency} />
              </td>
              <td class="td text-right">
                <Money amount={report.totals.total_minor} currency={book.currency} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  {/if}
{/if}

<p class="mt-3 flex items-start gap-2 text-[11px] text-t3">
  <Icon name="alert-circle" size={12} class="mt-0.5 shrink-0" />
  <span>
    Multi-device numbering is unsolved: two offline devices could each issue
    an invoice numbered the same, which the database turns into a loud
    failure rather than a silent collision. This report is otherwise exactly
    what today's book shows — nothing here converts currencies or estimates.
  </span>
</p>
