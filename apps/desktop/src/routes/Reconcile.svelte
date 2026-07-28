<script lang="ts">
  /**
   * Reconcile — scored pairings of a slip with a bank transaction.
   *
   * Two things this screen is careful about.
   *
   * **Why a pair scored what it did.** The score is core's; this view does not
   * recompute it and does not pretend to decompose it. What it *can* do is
   * show the evidence carried in the pair itself — whether the amounts agree
   * to the cent, and whether the slip's merchant actually appears in the bank
   * description — and say plainly that the matcher also weighs date proximity,
   * which this payload does not carry.
   *
   * **Undo that is real.** A decision is held for a few seconds before it is
   * sent, so Undo cancels an API call that has not happened rather than trying
   * to reverse one that has. That matters here because core's confirm takes
   * `accept: true|false` and a rejection is terminal — there is no
   * "un-reject", so the only honest undo is one that gets in first. Leaving
   * the screen flushes the queue rather than dropping it: navigating away is
   * not a cancel.
   */
  import { onDestroy, tick } from "svelte";
  import { api } from "../lib/api/client";
  import { routeCache } from "../lib/loadCache";
  import { fmtMoney, fmtPct } from "../lib/format";
  import { takeIntent } from "../lib/intent.svelte";
  import type { ReconSuggestion } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

  /** Score at or above which a pair is called strong; the bulk selector and
   * the band badge share it so the word means one thing on this screen. */
  const STRONG = 0.9;
  const LIKELY = 0.8;
  /** How long a decision is held before it is sent. */
  const UNDO_MS = 6000;

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
  const initial = (() => {
    const cached = routeCache.get<Snapshot>("reconcile");
    if (cached) {
      bookId = cached.bookId;
      suggestions = cached.suggestions;
      loading = false;
      return load(true);
    }
    return load();
  })();

  async function run() {
    running = true;
    error = null;
    try {
      suggestions = await api.reconSuggest({ book_id: bookId });
      selected = [];
      cacheSnapshot();
    } catch (err) {
      error = String(err);
    } finally {
      running = false;
    }
  }

  // The palette's "Run reconcile" means *run it*, not just "show me the
  // screen" — claimed once, so it never fires again on the next visit, and
  // only after the first load has settled (matching needs the book id).
  if (takeIntent("run-reconcile")) {
    void initial.then(() => {
      if (!error) return run();
    });
  }

  // -- deferred decisions ---------------------------------------------------

  interface Decision {
    id: string;
    accept: boolean;
  }

  /** Decided in the UI, not yet sent. Undo simply empties this. */
  let queued = $state<Decision[]>([]);
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = $state(false);

  const decisionFor = (id: string) => queued.find((d) => d.id === id);

  function schedule() {
    clearTimeout(queueTimer);
    queueTimer = setTimeout(() => void flush(), UNDO_MS);
  }

  /** Send everything held, oldest first, then reconcile local state with what
   * core returned. A failure keeps the rows visible and says why. */
  async function flush() {
    clearTimeout(queueTimer);
    const batch = $state.snapshot(queued) as Decision[];
    if (batch.length === 0) return;
    queued = [];
    flushing = true;
    try {
      for (const decision of batch) {
        const updated = await api.reconConfirm({
          suggestion_id: decision.id,
          accept: decision.accept,
        });
        suggestions = suggestions
          .map((x) => (x.id === updated.id ? updated : x))
          .filter((x) => x.status !== "rejected");
      }
      cacheSnapshot();
    } catch (err) {
      error = String(err);
      // Whatever did not go through is refetched rather than guessed at.
      await load(true);
    } finally {
      flushing = false;
    }
  }

  function undo() {
    clearTimeout(queueTimer);
    queued = [];
  }

  function decide(ids: string[], accept: boolean) {
    if (ids.length === 0) return;
    error = null;
    const fresh = ids.filter((id) => !decisionFor(id));
    if (fresh.length === 0) return;
    queued = [...queued, ...fresh.map((id) => ({ id, accept }))];
    selected = selected.filter((id) => !fresh.includes(id));
    schedule();
  }

  // Navigating away commits; it is not a silent cancel. The route unmounts on
  // every navigation, so this is the only place that promise can be kept.
  onDestroy(() => {
    void flush();
  });

  const pending = $derived(
    suggestions.filter((s) => s.status === "suggested" && !decisionFor(s.id)),
  );
  const confirmed = $derived(
    suggestions.filter(
      (s) =>
        s.status === "confirmed" ||
        (s.status === "suggested" && decisionFor(s.id)?.accept === true),
    ),
  );
  const queuedConfirms = $derived(queued.filter((d) => d.accept).length);
  const queuedRejects = $derived(queued.length - queuedConfirms);

  // -- selection & bulk -----------------------------------------------------

  let selected = $state<string[]>([]);
  let bulkOpen = $state(false);

  const selectedPending = $derived(
    pending.filter((s) => selected.includes(s.id)),
  );
  const strongPending = $derived(pending.filter((s) => s.score >= STRONG));

  function toggleSelect(id: string) {
    selected = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id];
  }

  function confirmSelected() {
    decide(
      selectedPending.map((s) => s.id),
      true,
    );
    bulkOpen = false;
  }

  // -- match signals --------------------------------------------------------
  // Observable evidence from the pair, not a decomposition of core's score.

  interface Signal {
    ok: boolean;
    label: string;
  }

  function amountSignal(s: ReconSuggestion): Signal {
    const bank = Math.abs(s.transaction_amount_minor);
    const slip = Math.abs(s.document_total_minor);
    if (bank === slip) return { ok: true, label: "Amounts agree to the cent" };
    return {
      ok: false,
      label: `Amounts differ by ${fmtMoney(Math.abs(bank - slip), s.currency)}`,
    };
  }

  /** Longest word of the slip's merchant that also occurs in the bank
   * description. Short tokens ("de", "pty") are skipped — they match
   * everything and would make this signal meaningless. */
  function merchantSignal(s: ReconSuggestion): Signal {
    const description = s.transaction_description.toLowerCase();
    const words = s.document_merchant
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4)
      .sort((a, b) => b.length - a.length);
    const hit = words.find((w) => description.includes(w));
    if (hit)
      return { ok: true, label: `“${hit}” appears in the bank description` };
    return { ok: false, label: "Merchant name is not in the bank description" };
  }

  function band(score: number): { tone: "success" | "neutral" | "warning"; label: string } {
    if (score >= STRONG) return { tone: "success", label: "strong" };
    if (score >= LIKELY) return { tone: "neutral", label: "likely" };
    return { tone: "warning", label: "weak" };
  }

  // -- keyboard -------------------------------------------------------------

  /** The review list, queried for its rows rather than holding an array of
   * refs: rows leave the list as decisions are made, and a keyed `bind:this`
   * array goes stale exactly when focus needs to move. */
  let listEl = $state<HTMLElement | null>(null);

  async function focusRow(index: number) {
    await tick();
    const rows = listEl?.querySelectorAll<HTMLElement>('li[tabindex="0"]');
    if (!rows || rows.length === 0) return;
    rows[Math.max(0, Math.min(index, rows.length - 1))]?.focus();
  }

  function onRowKeydown(e: KeyboardEvent, s: ReconSuggestion, index: number) {
    // Keys from the row's own buttons/checkbox bubble here; only the row
    // itself drives these shortcuts, or Enter on Confirm would fire twice.
    if (e.target !== e.currentTarget) return;
    const key = e.key.toLowerCase();
    if (key === "c" || key === "y" || e.key === "Enter") {
      e.preventDefault();
      decide([s.id], true);
      void focusRow(index);
    } else if (key === "r" || key === "n") {
      e.preventDefault();
      decide([s.id], false);
      void focusRow(index);
    } else if (key === "x" || e.key === " ") {
      e.preventDefault();
      toggleSelect(s.id);
    } else if (e.key === "ArrowDown" || key === "j") {
      e.preventDefault();
      void focusRow(index + 1);
    } else if (e.key === "ArrowUp" || key === "k") {
      e.preventDefault();
      void focusRow(index - 1);
    }
  }
</script>

<PageHeader
  eyebrow="Documents ↔ transactions"
  title="Reconcile"
  subtitle="SlipScan pairs slips with bank transactions by amount, date, and merchant. Confirm the good ones; reject the rest — every decision is held briefly so you can undo it."
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
    role="alert"
  >
    <Icon name="alert-circle" size={13} />
    {error}
    <button class="btn btn-ghost ml-auto h-6 px-1.5 text-[11.5px]" onclick={() => load()}>
      Retry
    </button>
  </p>
{/if}

{#if queued.length > 0}
  <!-- The undo window. Nothing has been sent yet: Undo cancels a call that has
       not happened, which is the only honest undo for a terminal reject. -->
  <div
    class="animate-slide-up mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px]"
    role="status"
    aria-live="polite"
  >
    <Icon name="check-circle" size={14} class="shrink-0 text-success" />
    <span class="text-t2">
      {#if queuedConfirms > 0}
        <span class="num">{queuedConfirms}</span> to confirm{queuedRejects > 0
          ? ","
          : ""}
      {/if}
      {#if queuedRejects > 0}
        <span class="num">{queuedRejects}</span> to reject
      {/if}
      · sending in a moment.
    </span>
    <span class="ml-auto flex items-center gap-1.5">
      <button class="btn h-7" onclick={undo}>
        <Icon name="refresh" size={12} />
        Undo
      </button>
      <button
        class="btn btn-ghost h-7"
        disabled={flushing}
        onclick={() => void flush()}
      >
        Apply now
      </button>
    </span>
  </div>
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
      <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="alert-circle" size={15} class="text-warning" />
          Needs review
          <span class="num text-t3">{pending.length}</span>
        </h2>
        <div class="ml-auto flex flex-wrap items-center gap-1.5">
          {#if strongPending.length > 0}
            <button
              class="btn h-7"
              onclick={() => (selected = strongPending.map((s) => s.id))}
            >
              Select {strongPending.length} strong
            </button>
          {/if}
          {#if selectedPending.length > 0}
            <button class="btn btn-ghost h-7" onclick={() => (selected = [])}>
              Clear selection
            </button>
            <button class="btn btn-primary h-7" onclick={() => (bulkOpen = true)}>
              <Icon name="check" size={12} />
              Confirm {selectedPending.length} selected
            </button>
          {/if}
        </div>
      </div>
      <p class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-t3">
        <span>On a focused row:</span>
        <span class="kbd">C</span> confirm
        <span class="kbd">R</span> reject
        <span class="kbd">X</span> select
        <span class="kbd">↑</span><span class="kbd">↓</span> move
      </p>
      <ul class="card divide-y divide-line" bind:this={listEl}>
        {#each pending as s, i (s.id)}
          {@const amount = amountSignal(s)}
          {@const merchant = merchantSignal(s)}
          {@const grade = band(s.score)}
          {@const isSelected = selected.includes(s.id)}
          <!-- Deliberate: the row is a focus stop carrying the review
               shortcuts, which is what makes this queue fast to work through.
               It is not a substitute for real controls — the checkbox and both
               decision buttons inside it are ordinary focusable elements, so
               nothing here is reachable *only* by these keys. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li
            tabindex="0"
            class="row-hover flex flex-wrap items-center gap-x-5 gap-y-2.5 px-4 py-3 {isSelected
              ? 'bg-accent/5'
              : ''}"
            aria-label="{s.transaction_description} matched with {s.document_merchant}, {fmtPct(
              s.score,
            )} confidence"
            onkeydown={(e) => onRowKeydown(e, s, i)}
          >
            <input
              type="checkbox"
              class="shrink-0"
              checked={isSelected}
              aria-label="Select this match for bulk confirm"
              onchange={() => toggleSelect(s.id)}
            />
            <!-- Bank line over slip line; the amounts share a column so the
                 pair reads like a two-row ledger entry. -->
            <div class="min-w-0 flex-1 basis-64">
              <div
                class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-[12.5px] leading-tight"
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
              <!-- Why it scored: the evidence this pair actually carries. -->
              <ul class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                {#each [amount, merchant] as signal (signal.label)}
                  <li class="flex items-center gap-1.5 text-[11px] text-t3">
                    <Icon
                      name={signal.ok ? "check" : "x"}
                      size={11}
                      class={signal.ok ? "text-success" : "text-warning"}
                    />
                    {signal.label}
                  </li>
                {/each}
              </ul>
            </div>
            <div class="flex shrink-0 items-center gap-4">
              <!-- Confidence meter: the pen-ink bar. Olive in light for 3:1
                   against the panel; pure lime in dark. -->
              <div
                class="w-24"
                role="meter"
                aria-label="Match confidence"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(s.score * 100)}
                aria-valuetext="{fmtPct(s.score)} — {grade.label}"
              >
                <span class="flex items-baseline justify-end gap-1.5">
                  <Badge tone={grade.tone} dot={false} label={grade.label} />
                  <span class="num text-[11px] text-t2">{fmtPct(s.score)}</span>
                </span>
                <div
                  class="mt-1.5 h-0.5 overflow-hidden rounded-full bg-line"
                  aria-hidden="true"
                >
                  <!-- Bar draws in on load with the entering easing; the
                       global reduced-motion rule collapses it to one frame. -->
                  <div
                    class="h-full rounded-full bg-accent-text dark:bg-accent"
                    style="width: {Math.min(
                      100,
                      s.score * 100,
                    )}%; transition: width var(--dur-slow) var(--ease-decel);"
                  ></div>
                </div>
              </div>
              <div class="flex items-center gap-1.5">
                <button
                  class="btn h-7 hover:border-success/40"
                  aria-label="Confirm match with {s.document_merchant}"
                  onclick={() => decide([s.id], true)}
                >
                  <Icon name="check" size={13} class="text-success" />
                  Confirm
                </button>
                <button
                  class="btn btn-danger h-7"
                  aria-label="Reject match with {s.document_merchant}"
                  onclick={() => decide([s.id], false)}
                >
                  <Icon name="x" size={13} />
                  Reject
                </button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
      <p class="mt-2 max-w-2xl text-[11px] leading-relaxed text-t3">
        The percentage is the matcher's own score. The two lines under each pair
        are the evidence this view can show from the pair itself — the matcher
        also weighs how close the slip's date is to the transaction's, and those
        dates are not part of what it returns here.
        <span class="whitespace-nowrap">Strong is {fmtPct(STRONG)}+</span>,
        likely {fmtPct(LIKELY)}+.
      </p>
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
              {#if decisionFor(s.id)}
                <Badge tone="neutral" dot={false} label="undoable" />
              {/if}
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

<ConfirmDialog
  open={bulkOpen}
  title="Confirm {selectedPending.length} {selectedPending.length === 1
    ? 'match'
    : 'matches'}?"
  body="Each selected slip is linked to its transaction. Nothing is sent for a few seconds after you confirm, so you can still undo the whole batch."
  confirmLabel="Confirm {selectedPending.length}"
  onconfirm={confirmSelected}
  oncancel={() => (bulkOpen = false)}
/>
