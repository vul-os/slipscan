<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtMoney, fmtPct } from "../lib/format";
  import type { ReconSuggestion } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  let suggestions = $state<ReconSuggestion[]>([]);
  let loading = $state(true);
  let running = $state(false);
  let bookId = $state("");

  async function load() {
    loading = true;
    const [book] = await api.bookList();
    if (!book) return;
    bookId = book.id;
    suggestions = await api.reconSuggest({ book_id: book.id });
    loading = false;
  }
  load();

  async function run() {
    running = true;
    suggestions = await api.reconSuggest({ book_id: bookId });
    running = false;
  }

  async function decide(s: ReconSuggestion, accept: boolean) {
    const updated = await api.reconConfirm({ suggestion_id: s.id, accept });
    suggestions = suggestions
      .map((x) => (x.id === s.id ? updated : x))
      .filter((x) => x.status !== "rejected");
  }

  const confirmed = $derived(suggestions.filter((s) => s.status === "confirmed"));
  const pending = $derived(suggestions.filter((s) => s.status === "suggested"));

  function scoreTone(score: number): "success" | "accent" | "warning" {
    if (score >= 0.95) return "success";
    if (score >= 0.85) return "accent";
    return "warning";
  }
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

{#if loading}
  <div class="card"><Skeleton rows={6} /></div>
{:else if suggestions.length === 0}
  <div class="card">
    <EmptyState
      icon="check-circle"
      title="Everything is reconciled"
      body="No unmatched slips or transactions right now. Import more receipts or pull fresh bank data, then run matching again."
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
          <div class="flex items-center gap-4 px-4 py-3">
            <div class="min-w-0 flex-1 leading-tight">
              <span class="flex items-center gap-2 text-[12.5px]">
                <Icon name="bank" size={13} class="shrink-0 text-t3" />
                <span class="truncate font-medium"
                  >{s.transaction_description}</span
                >
                <span class="num shrink-0 text-t2"
                  >{fmtMoney(s.transaction_amount_minor)}</span
                >
              </span>
              <span class="mt-1 flex items-center gap-2 text-[12.5px] text-t2">
                <Icon name="receipt" size={13} class="shrink-0 text-t3" />
                <span class="truncate">{s.document_merchant}</span>
                <span class="num shrink-0"
                  >{fmtMoney(-s.document_total_minor)}</span
                >
              </span>
            </div>
            <Badge
              tone={scoreTone(s.score)}
              label="{fmtPct(s.score)} match"
            />
            <div class="flex shrink-0 items-center gap-1.5">
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
        {/each}
      </div>
    </section>
  {/if}

  <section>
    <h2 class="mb-2 flex items-center gap-2 text-[13px] font-semibold">
      <Icon name="check-circle" size={15} class="text-success" />
      Matched
      <span class="num text-t3">{confirmed.length}</span>
    </h2>
    {#if confirmed.length === 0}
      <div class="card">
        <EmptyState
          icon="reconcile"
          title="Nothing confirmed yet"
          body="Confirmed pairs land here and flow through to the ledger."
        />
      </div>
    {:else}
      <div class="card divide-y divide-line">
        {#each confirmed as s (s.id)}
          <div class="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
            <Icon name="bank" size={13} class="shrink-0 text-t3" />
            <span class="truncate font-medium">{s.transaction_description}</span>
            <Icon name="arrow-right" size={12} class="shrink-0 text-t3" />
            <Icon name="receipt" size={13} class="shrink-0 text-t3" />
            <span class="truncate text-t2">{s.document_merchant}</span>
            <span class="ml-auto flex shrink-0 items-center gap-3">
              <Badge tone="success" label={fmtPct(s.score)} />
              <span class="num">{fmtMoney(s.transaction_amount_minor)}</span>
            </span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
