<script lang="ts">
  /**
   * Receipts — slips in, and the loop that closes them against the book.
   *
   * The review loop is meant to be driven from the keyboard: J/K walk the
   * list, Enter opens a slip, and — because a keyboard-activated Enter lands
   * focus on the panel's primary action — a second Enter confirms the match.
   * Two keystrokes per slip.
   *
   * What "review" can actually mean here is bounded by the service surface,
   * and this screen states the boundary rather than papering over it:
   *   - confirming or rejecting the transaction a slip reconciles against is
   *     real (`recon_confirm`), and is offered inline per slip,
   *   - correcting extracted fields and marking a slip `reviewed` are NOT
   *     wired into the desktop app — core has `document_review` /
   *     `document_transition`, but neither is registered as a command in
   *     src-tauri/src/commands.rs, so no button here claims to do it.
   */
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { routeCache } from "../lib/loadCache";
  import { takeIntent } from "../lib/intent.svelte";
  import { requestIntent } from "../lib/intent.svelte";
  import { router } from "../lib/router.svelte";
  import { fmtDate, fmtPct } from "../lib/format";
  import { csvMoney, downloadCsv, toCsv } from "../lib/csv";
  import type {
    Document,
    DocumentStatus,
    ReconSuggestion,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";

  /** `review` is the queue, not a stored status: everything not yet reviewed. */
  type Filter = "all" | "review" | DocumentStatus;

  let docs = $state<Document[]>([]);
  /** Reconciliation suggestions, keyed by document below. `recon_suggest`
   * already excludes rejected pairs, so what is here is live. */
  let suggestions = $state<ReconSuggestion[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let search = $state("");
  let bookId = $state("");

  // Filters can be handed in from the dashboard's "slips to review" stat; the
  // router ignores everything after `?` in the hash, which leaves it free.
  const entry = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const FILTER_IDS: Filter[] = [
    "all",
    "review",
    "pending",
    "extracted",
    "reviewed",
    "failed",
  ];
  const entryFilter = entry.get("status") as Filter | null;
  let filter = $state<Filter>(
    entryFilter && FILTER_IDS.includes(entryFilter) ? entryFilter : "all",
  );

  interface Snapshot {
    bookId: string;
    docs: Document[];
    suggestions: ReconSuggestion[];
  }

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const book = requireBook(await api.bookList());
      bookId = book.id;
      [docs, suggestions] = await Promise.all([
        api.documentList({ book_id: book.id }),
        api.reconSuggest({ book_id: book.id }),
      ]);
      routeCache.set<Snapshot>("receipts", {
        bookId,
        docs: $state.snapshot(docs) as Document[],
        suggestions: $state.snapshot(suggestions) as ReconSuggestion[],
      });
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  // Seed from the session cache so a tab switch renders instantly, then
  // refresh in the background (stale-while-revalidate).
  {
    const cached = routeCache.get<Snapshot>("receipts");
    if (cached) {
      bookId = cached.bookId;
      docs = cached.docs;
      suggestions = cached.suggestions ?? [];
      loading = false;
      load(true);
    } else {
      load();
    }
  }

  function exportDocs() {
    const csv = toCsv(
      ["file", "merchant", "date", "total", "currency", "status", "confidence"],
      docs.map((d) => [
        d.file_name,
        d.merchant,
        d.issued_at ? d.issued_at.slice(0, 10) : "",
        d.total_minor != null ? csvMoney(d.total_minor, d.currency) : "",
        d.currency,
        d.status,
        d.extraction ? d.extraction.confidence.toFixed(2) : "",
      ]),
    );
    downloadCsv("receipts.csv", csv);
  }

  const filters: Array<{ id: Filter; label: string }> = [
    { id: "all", label: "All" },
    { id: "review", label: "To review" },
    { id: "pending", label: "Pending" },
    { id: "extracted", label: "Extracted" },
    { id: "reviewed", label: "Reviewed" },
  ];

  const counts = $derived(
    docs.reduce(
      (acc, d) => ((acc[d.status] = (acc[d.status] ?? 0) + 1), acc),
      {} as Partial<Record<DocumentStatus, number>>,
    ),
  );
  const reviewCount = $derived(docs.filter((d) => d.status !== "reviewed").length);
  const countFor = (id: Filter): number =>
    id === "review" ? reviewCount : id === "all" ? docs.length : (counts[id] ?? 0);

  const matchOf = (documentId: string): ReconSuggestion | null =>
    suggestions.find((s) => s.document_id === documentId) ?? null;

  const filtered = $derived(
    docs.filter((d) => {
      if (filter === "review" && d.status === "reviewed") return false;
      if (filter !== "all" && filter !== "review" && d.status !== filter)
        return false;
      if (search) {
        const s = search.toLowerCase();
        if (
          !(d.merchant ?? "").toLowerCase().includes(s) &&
          !d.file_name.toLowerCase().includes(s)
        )
          return false;
      }
      return true;
    }),
  );

  const statusTone: Record<
    DocumentStatus,
    "warning" | "accent" | "success" | "danger"
  > = {
    pending: "warning",
    extracted: "accent",
    reviewed: "success",
    failed: "danger",
  };

  /** Extraction confidence → the one chip system. High is quiet success,
   * the mid band earns the lime "review me" accent, low is a warning. */
  function confidenceTone(c: number): "success" | "accent" | "warning" {
    if (c >= 0.9) return "success";
    if (c >= 0.7) return "accent";
    return "warning";
  }

  let fileInput = $state<HTMLInputElement | null>(null);
  let importError = $state<string | null>(null);
  let importing = $state(false);

  /** Expanded row (detail view via document_get). */
  let selected = $state<Document | null>(null);

  function importReceipt() {
    importError = null;
    fileInput?.click();
  }

  function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  /** Formats extraction can work with. The file input's `accept` attribute
   * is advisory only (any file can be picked via "All Files"), so this is
   * the real gate — without it a .zip or .exe becomes a permanently
   * "pending" document. */
  const ACCEPTED_EXTENSIONS = [
    ".pdf", ".heic", ".heif", ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".bmp", ".tif", ".tiff", ".avif",
  ];
  const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

  function unsupportedReason(file: File): string | null {
    const typeOk =
      file.type.startsWith("image/") ||
      file.type === "application/pdf" ||
      ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!typeOk) {
      return `"${file.name}" is not a supported receipt format — use a photo (JPG, PNG, HEIC, …) or a PDF.`;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      return `"${file.name}" is ${Math.round(file.size / 1024 / 1024)} MB — receipts are capped at ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`;
    }
    return null;
  }

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const reason = unsupportedReason(file);
    if (reason) {
      importError = reason;
      return;
    }
    importing = true;
    importError = null;
    try {
      await api.documentImport({
        book_id: bookId,
        file_name: file.name,
        mime_type: file.type || "application/octet-stream",
        bytes_base64: toBase64(await file.arrayBuffer()),
      });
      docs = await api.documentList({ book_id: bookId });
    } catch (err) {
      importError = String(err);
    } finally {
      importing = false;
    }
  }

  let detailError = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // keyboard review loop
  //
  // Roving tabindex over the disclosure buttons: Tab reaches the list once,
  // J/K walk it, Enter opens. A keyboard-activated open (click `detail === 0`)
  // hands focus to the panel's primary action, so the common answer —
  // "yes, that is the transaction" — is the very next Enter. A mouse click
  // deliberately does not move focus: a peek should stay a peek.
  // ---------------------------------------------------------------------------

  let listEl = $state<HTMLElement | null>(null);
  let focusIndex = $state(0);

  $effect(() => {
    if (focusIndex > filtered.length - 1) {
      focusIndex = Math.max(0, filtered.length - 1);
    }
  });

  async function focusRow(index: number) {
    focusIndex = index;
    await tick();
    listEl
      ?.querySelector<HTMLElement>(`[data-row="${index}"] [data-rowfocus]`)
      ?.focus();
  }

  async function focusPanelAction() {
    await tick();
    listEl?.querySelector<HTMLElement>("[data-panel-primary]")?.focus();
  }

  function onRowKeydown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const last = filtered.length - 1;
    if (last < 0) return;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        void focusRow(Math.min(last, focusIndex + 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        void focusRow(Math.max(0, focusIndex - 1));
        break;
      case "Home":
        e.preventDefault();
        void focusRow(0);
        break;
      case "End":
        e.preventDefault();
        void focusRow(last);
        break;
      case "Escape":
        if (selected) {
          e.preventDefault();
          selected = null;
          void focusRow(focusIndex);
        }
        break;
    }
  }

  async function toggleDetail(d: Document, viaKeyboard: boolean) {
    if (selected?.id === d.id) {
      selected = null;
      return;
    }
    detailError = null;
    try {
      selected = await api.documentGet({ document_id: d.id });
      if (viaKeyboard) await focusPanelAction();
    } catch (err) {
      detailError = String(err);
    }
  }

  // ---------------------------------------------------------------------------
  // reconciliation: the one review action that is actually wired
  // ---------------------------------------------------------------------------

  let reconBusy = $state<string | null>(null);
  let reconError = $state<string | null>(null);

  async function decide(suggestion: ReconSuggestion, accept: boolean) {
    reconError = null;
    reconBusy = suggestion.id;
    try {
      const updated = await api.reconConfirm({
        suggestion_id: suggestion.id,
        accept,
      });
      // A rejected pair leaves the list entirely — `recon_suggest` would not
      // return it again, and showing it as "rejected" would invite a second
      // decision that has nowhere to go.
      suggestions = accept
        ? suggestions.map((s) => (s.id === updated.id ? updated : s))
        : suggestions.filter((s) => s.id !== updated.id);
      const cached = routeCache.get<Snapshot>("receipts");
      if (cached) {
        routeCache.set<Snapshot>("receipts", {
          ...cached,
          suggestions: $state.snapshot(suggestions) as ReconSuggestion[],
        });
      }
    } catch (err) {
      reconError = String(err);
    } finally {
      reconBusy = null;
    }
  }

  function openTransaction(id: string) {
    requestIntent({ kind: "reveal-transaction", id });
    router.go("transactions");
  }

  // The palette parks "import a receipt" here; opening the picker on arrival
  // is the whole point of the command.
  if (takeIntent("import-receipt")) {
    queueMicrotask(importReceipt);
  }
</script>

<PageHeader
  eyebrow="Slips · receipts · statements"
  title="Receipts"
  subtitle="Drop in slips and let extraction do the typing. Review anything below full confidence, and confirm the transaction each slip belongs to."
>
  {#snippet actions()}
    <button class="btn" onclick={exportDocs} disabled={docs.length === 0}>
      <Icon name="download" size={14} />
      Export
    </button>
    <button class="btn btn-primary" onclick={importReceipt} disabled={importing}>
      <Icon name="upload" size={14} />
      {importing ? "Importing…" : "Import receipt"}
    </button>
  {/snippet}
</PageHeader>

<input
  type="file"
  accept="image/*,.pdf,.heic"
  class="hidden"
  bind:this={fileInput}
  onchange={onFilePicked}
/>

{#if importError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
    role="alert"
  >
    <Icon name="alert-circle" size={13} />
    {importError}
  </p>
{/if}

{#if detailError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
    role="alert"
  >
    <Icon name="alert-circle" size={13} />
    Could not open the receipt detail: {detailError}
  </p>
{/if}

{#if reconError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
    role="alert"
  >
    <Icon name="alert-circle" size={13} />
    {reconError}
  </p>
{/if}

<div class="mb-3 flex flex-wrap items-center gap-2">
  <div class="relative w-64">
    <Icon
      name="search"
      size={14}
      class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
    />
    <input
      class="input pl-8"
      placeholder="Search by merchant or file…"
      bind:value={search}
    />
  </div>
  <div class="flex items-center gap-1" role="group" aria-label="Status filter">
    {#each filters as f (f.id)}
      <button
        class="btn h-7 px-2.5 text-[12px] {filter === f.id
          ? 'border-line-2 bg-sunken'
          : 'btn-ghost text-t2'}"
        aria-pressed={filter === f.id}
        onclick={() => (filter = f.id)}
      >
        {f.label}
        {#if f.id !== "all" && countFor(f.id)}
          <span class="num text-[10.5px] text-t3">{countFor(f.id)}</span>
        {/if}
      </button>
    {/each}
  </div>
  <span class="ml-auto text-[12px] text-t3">{filtered.length} results</span>
</div>

<div class="card overflow-hidden">
  {#if loading}
    <Skeleton rows={8} />
  {:else if loadError}
    <EmptyState icon="alert-circle" title="Could not load receipts" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if docs.length === 0}
    <EmptyState
      icon="receipt"
      title="No receipts yet"
      body="Import a photo or PDF of a slip, point slipscan watch <folder> at a drop folder, or forward slips to your watched mailbox. Files never leave your machine."
      hint="Everything is processed locally or by the LLM provider you configure"
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={importReceipt}>
          <Icon name="upload" size={14} />
          Import your first receipt
        </button>
      {/snippet}
    </EmptyState>
  {:else if filtered.length === 0}
    <EmptyState
      icon="search"
      title="No matching receipts"
      body="Nothing with that merchant or status. Try clearing the search."
    >
      {#snippet actions()}
        <button
          class="btn"
          onclick={() => {
            search = "";
            filter = "all";
          }}>Clear filters</button
        >
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table-wrap table-scroll" bind:this={listEl}>
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th">Document</th>
            <th class="th w-28">Date</th>
            <th class="th w-32 text-right">Total</th>
            <th class="th w-32">Status</th>
            <th class="th w-28">Match</th>
            <th class="th w-32 text-right">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as d, i (d.id)}
            {@const open = selected?.id === d.id}
            {@const match = matchOf(d.id)}
            <tr class="row-hover {open ? 'bg-sunken/60' : ''}" data-row={i}>
              <td class="td max-w-0">
                <button
                  type="button"
                  data-rowfocus
                  class="flex w-full min-w-0 items-center gap-2.5 text-left"
                  tabindex={i === focusIndex ? 0 : -1}
                  aria-expanded={open}
                  aria-controls="doc-panel-{d.id}"
                  onfocus={() => (focusIndex = i)}
                  onkeydown={onRowKeydown}
                  onclick={(e) => toggleDetail(d, e.detail === 0)}
                >
                  <span
                    class="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-sunken text-t3"
                  >
                    <Icon name="receipt" size={14} />
                  </span>
                  <span class="min-w-0 leading-tight">
                    <span class="block truncate font-medium">
                      {d.merchant ?? "Awaiting extraction"}
                    </span>
                    <span class="block truncate font-mono text-[10.5px] text-t3">
                      {d.file_name}
                    </span>
                  </span>
                  <Icon
                    name="chevron-down"
                    size={13}
                    class="ml-auto shrink-0 text-t3 {open ? '' : '-rotate-90'}"
                  />
                </button>
              </td>
              <td class="td num whitespace-nowrap text-t2">
                {d.issued_at ? fmtDate(d.issued_at) : "—"}
              </td>
              <td class="td text-right">
                {#if d.total_minor != null}
                  <Money amount={d.total_minor} currency={d.currency} />
                {:else}
                  <span class="num text-t3">—</span>
                {/if}
              </td>
              <td class="td">
                <Badge tone={statusTone[d.status]} label={d.status} />
              </td>
              <td class="td">
                {#if match?.status === "confirmed"}
                  <Badge tone="success" label="matched" />
                {:else if match}
                  <Badge tone="accent" label="{fmtPct(match.score)} match" />
                {:else}
                  <span class="num text-t3">—</span>
                {/if}
              </td>
              <td class="td text-right">
                {#if d.extraction}
                  <Badge
                    tone={confidenceTone(d.extraction.confidence)}
                    label={fmtPct(d.extraction.confidence)}
                  />
                {:else}
                  <span class="num text-t3">—</span>
                {/if}
              </td>
            </tr>
            {#if open}
              <tr>
                <td colspan="6" class="!p-0" id="doc-panel-{d.id}">
                  <div class="reveal border-t border-line bg-sunken/30">
                    <div class="reveal-inner">
                      <div class="px-4 py-3.5">
                        <!-- 1 · what this slip reconciles against. The one
                             review action the service surface actually
                             offers, so it leads and holds the focus. -->
                        {#if match}
                          <div
                            class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border {match.status ===
                            'confirmed'
                              ? 'border-success/25 bg-success/10'
                              : 'border-accent-ring/40 bg-accent/10'} px-3 py-2.5"
                          >
                            <Icon
                              name={match.status === "confirmed"
                                ? "check-circle"
                                : "reconcile"}
                              size={14}
                              class="shrink-0 {match.status === 'confirmed'
                                ? 'text-success'
                                : 'text-accent-text dark:text-accent'}"
                            />
                            <span class="min-w-0 flex-1 text-[12.5px] leading-snug">
                              {match.status === "confirmed"
                                ? "Reconciled against"
                                : "Looks like"}
                              <strong class="font-semibold"
                                >{match.transaction_description}</strong
                              >
                              <Money
                                amount={match.transaction_amount_minor}
                                currency={match.currency}
                                signed
                                class="ml-1"
                              />
                              <span class="text-t2">
                                · {fmtPct(match.score)} confidence
                              </span>
                            </span>
                            {#if match.status === "confirmed"}
                              <button
                                data-panel-primary
                                class="btn h-7"
                                onkeydown={onRowKeydown}
                                onclick={() =>
                                  openTransaction(match.transaction_id)}
                              >
                                Open the transaction
                                <Icon name="arrow-right" size={12} />
                              </button>
                            {:else}
                              <button
                                data-panel-primary
                                class="btn btn-primary h-7"
                                disabled={reconBusy === match.id}
                                onkeydown={onRowKeydown}
                                onclick={() => decide(match, true)}
                              >
                                <Icon name="check" size={13} />
                                {reconBusy === match.id ? "Saving…" : "Confirm match"}
                              </button>
                              <button
                                class="btn h-7"
                                disabled={reconBusy === match.id}
                                onclick={() => decide(match, false)}
                              >
                                Not a match
                              </button>
                            {/if}
                          </div>
                        {:else}
                          <div
                            class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line bg-panel px-3 py-2.5"
                          >
                            <Icon name="reconcile" size={14} class="shrink-0 text-t3" />
                            <span class="min-w-0 flex-1 text-[12px] text-t2">
                              No transaction is matched to this slip yet.
                              Matching runs over the whole book at once.
                            </span>
                            <button
                              data-panel-primary
                              class="btn h-7"
                              onkeydown={onRowKeydown}
                              onclick={() => router.go("reconcile")}
                            >
                              Open Reconcile
                              <Icon name="arrow-right" size={12} />
                            </button>
                          </div>
                        {/if}

                        <!-- 2 · what extraction read off the slip -->
                        {#if selected?.extraction}
                          {@const ex = selected.extraction}
                          <div
                            class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
                          >
                            <span class="text-[12.5px] font-semibold">
                              {ex.merchant || selected.file_name}
                              <span class="ml-1.5 text-[11px] font-normal text-t3">
                                {fmtDate(ex.issued_at)}
                              </span>
                            </span>
                            <Money
                              amount={ex.total_minor}
                              currency={ex.currency}
                              class="font-medium"
                            />
                          </div>
                          {#if ex.line_items.length > 0}
                            <table class="w-full text-[12px]">
                              <thead>
                                <tr>
                                  <th
                                    class="px-0 pb-1 text-left text-[10px] font-semibold tracking-[0.08em] text-t3 uppercase"
                                    >Item</th
                                  >
                                  <th
                                    class="px-0 pb-1 text-right text-[10px] font-semibold tracking-[0.08em] text-t3 uppercase"
                                    >Qty</th
                                  >
                                  <th
                                    class="px-0 pb-1 text-right text-[10px] font-semibold tracking-[0.08em] text-t3 uppercase"
                                    >Amount</th
                                  >
                                </tr>
                              </thead>
                              <tbody>
                                {#each ex.line_items as li, li_i (li_i)}
                                  <tr class="border-t border-line/60">
                                    <td class="max-w-0 py-1.5 pr-3 text-t2">
                                      <span class="block truncate"
                                        >{li.description}</span
                                      >
                                    </td>
                                    <td
                                      class="num w-16 py-1.5 text-right text-t3"
                                      >×{li.quantity}</td
                                    >
                                    <td class="w-28 py-1.5 text-right">
                                      <Money
                                        amount={li.total_minor}
                                        currency={ex.currency}
                                      />
                                    </td>
                                  </tr>
                                {/each}
                              </tbody>
                            </table>
                          {/if}
                          <div
                            class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line/60 pt-2.5 text-[11px] text-t3"
                          >
                            <span class="flex items-center gap-1"
                              >VAT
                              <Money
                                amount={ex.vat_minor}
                                currency={ex.currency}
                                class="text-[11px] text-t2"
                              /></span
                            >
                            {#if ex.discount_minor > 0}
                              <span class="flex items-center gap-1"
                                >Discount −<Money
                                  amount={ex.discount_minor}
                                  currency={ex.currency}
                                  class="text-[11px] text-t2"
                                /></span
                              >
                            {/if}
                            <span class="num ml-auto">{ex.currency}</span>
                          </div>
                          <!-- The honest half of "review": what this screen
                               cannot do, said where you would reach for it. -->
                          <p
                            class="mt-2.5 border-t border-line/60 pt-2.5 text-[11px] leading-relaxed text-t3"
                          >
                            Correcting these fields, and marking a slip
                            reviewed, are not wired into the desktop app —
                            core supports both, but neither is registered as a
                            command yet. Confirming the match above is the
                            review step that is real today.
                          </p>
                        {:else}
                          <p class="text-[12px] leading-relaxed text-t3">
                            No extraction yet — this document is {selected?.status}.
                            Run extraction from the CLI (slipscan extract) with
                            your configured LLM provider.
                          </p>
                        {/if}
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    <p class="border-t border-line px-3 py-2 text-[11px] text-t3">
      <span class="kbd">J</span> / <span class="kbd">K</span> move ·
      <span class="kbd">↵</span> opens a slip and lands on its next action ·
      <span class="kbd">Esc</span> closes
    </p>
  {/if}
</div>
