<script lang="ts">
  import { api } from "../lib/api/client";
  import { routeCache } from "../lib/loadCache";
  import { fmtPct } from "../lib/format";
  import type { ReconSuggestion } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";

  let suggestions = $state<ReconSuggestion[]>([]);
  let loading = $state(true);
  let running = $state(false);
  let bookId = $state("");
  let error = $state<string | null>(null);

  interface Snapshot {
    bookId: string;
    suggestions: ReconSuggestion[];
  }

  function cacheSnapshot() {
    routeCache.set<Snapshot>("reconcile", {
      bookId,
      suggestions: $state.snapshot(suggestions) as ReconSuggestion[],
    });
  }

  async function load(background = false) {
    if (!background) loading = true;
    error = null;
    try {
      const [book] = await api.bookList();
      if (!book) throw new Error("no book configured");
      bookId = book.id;
      suggestions = await api.reconSuggest({ book_id: book.id });
      cacheSnapshot();
    } catch (err) {
      if (!background) error = String(err);
    } finally {
      loading = false;
    }
  }
  // Seed from the session cache so a tab switch renders instantly, then
  // refresh in the background (stale-while-revalidate).
  {
    const cached = routeCache.get<Snapshot>("reconcile");
    if (cached) {
      bookId = cached.bookId;
      suggestions = cached.suggestions;
      loading = false;
      load(true);
    } else {
      load();
    }
  }

  async function run() {
    running = true;
    error = null;
    try {
      suggestions = await api.reconSuggest({ book_id: bookId });
      cacheSnapshot();
    } catch (err) {
      error = String(err);
    } finally {
      running = false;
    }
  }

  async function decide(s: ReconSuggestion, accept: boolean) {
    error = null;
    try {
      const updated = await api.reconConfirm({ suggestion_id: s.id, accept });
      suggestions = suggestions
        .map((x) => (x.id === s.id ? updated : x))
        .filter((x) => x.status !== "rejected");
      cacheSnapshot();
    } catch (err) {
      error = String(err);
    }
  }

  const confirmed = $derived(suggestions.filter((s) => s.status === "confirmed"));
  const pending = $derived(suggestions.filter((s) => s.status === "suggested"));
</script>

<PageHeader
  eyebrow="Documents ↔ transactions"
  title="Reconcile"
  subtitle="SlipScan pairs slips with bank transactions by amount, date, and merchant. Confirm the good ones; reject the rest."
>
  {#snippet actions()}
    <button class="btn btn-primary" onclick={run} disabled={running}>
      <Icon name="reconcile" size={14} />
      {running ? "Matching…" : "Run matching"}
    </button>
  {/snippet}
</PageHeader>

{#if error}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    {error}
    <button class="btn btn-ghost ml-auto h-6 px-1.5 text-[11.5px]" onclick={() => load()}>
      Retry
    </button>
  </p>
{/if}

{#if loading}
  <div class="card"><Skeleton rows={6} /></div>
{:else if suggestions.length === 0 && !error}
  <div class="card">
    <EmptyState
      title="All square"
      body="No unmatched slips or transactions right now. Import receipts or pull fresh bank data, then run matching again."
      hint="Press G then C to come back here any time"
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={run}>Run matching</button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  {#if pending.length > 0}
    <section class="mb-6">
      <h2 class="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="alert-circle" size={15} class="text-warning" />
        Needs review
        <span class="num text-t3">{pending.length}</span>
      </h2>
      <div class="card divide-y divide-line">
        {#each pending as s (s.id)}
          <div
            class="row-hover flex flex-wrap items-center gap-x-5 gap-y-2.5 px-4 py-3"
          >
            <!-- Bank line over slip line; the amounts share a column so the
                 pair reads like a two-row ledger entry. -->
            <div
              class="grid min-w-0 flex-1 basis-64 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[12.5px] leading-tight"
            >
              <Icon name="bank" size={13} class="text-t3" />
              <span class="truncate font-medium">{s.transaction_description}</span>
              <Money
                amount={s.transaction_amount_minor}
                currency={s.currency}
                class="text-right"
              />
              <Icon name="receipt" size={13} class="text-t3" />
              <span class="truncate text-t2">{s.document_merchant}</span>
              <Money
                amount={-s.document_total_minor}
                currency={s.currency}
                class="text-right text-t2"
              />
            </div>
            <div class="flex shrink-0 items-center gap-4">
              <!-- Confidence meter: the pen-ink bar. Olive in light for 3:1
                   against the panel; pure lime in dark. -->
              <div
                class="w-20"
                role="meter"
                aria-label="Match confidence"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(s.score * 100)}
              >
                <span
                  class="num block text-right text-[11px] {s.score < 0.85
                    ? 'text-warning'
                    : 'text-t2'}">{fmtPct(s.score)}</span
                >
                <div
                  class="mt-1 h-0.5 overflow-hidden rounded-full bg-line"
                  aria-hidden="true"
                >
                  <div
                    class="h-full rounded-full bg-accent-text dark:bg-accent"
                    style="width: {Math.min(100, s.score * 100)}%"
                  ></div>
                </div>
              </div>
              <div class="flex items-center gap-1.5">
                <button class="btn h-7" onclick={() => decide(s, true)}>
                  <Icon name="check" size={13} class="text-success" />
                  Confirm
                </button>
                <button
                  class="btn btn-danger h-7"
                  onclick={() => decide(s, false)}
                >
                  <Icon name="x" size={13} />
                  Reject
                </button>
              </div>
            </div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Matched: settled business — deliberately quieter than the queue above. -->
  <section>
    <h2 class="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-t2">
      <Icon name="check-circle" size={14} class="text-success" />
      Matched
      <span class="num text-t3">{confirmed.length}</span>
    </h2>
    {#if confirmed.length === 0}
      <p class="card px-4 py-5 text-center text-[12px] text-t3">
        Confirmed pairs land here and flow through to the ledger.
      </p>
    {:else}
      <div class="card divide-y divide-line">
        {#each confirmed as s (s.id)}
          <div
            class="row-hover flex items-center gap-3 px-4 py-2 text-[12.5px] text-t2"
          >
            <Icon name="bank" size={13} class="shrink-0 text-t3" />
            <span class="truncate">{s.transaction_description}</span>
            <Icon name="arrow-right" size={12} class="shrink-0 text-t3" />
            <Icon name="receipt" size={13} class="shrink-0 text-t3" />
            <span class="truncate text-t3">{s.document_merchant}</span>
            <span class="ml-auto flex shrink-0 items-baseline gap-3">
              <span class="num text-[11px] text-t3">{fmtPct(s.score)}</span>
              <Money
                amount={s.transaction_amount_minor}
                currency={s.currency}
                class="text-t2"
              />
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
