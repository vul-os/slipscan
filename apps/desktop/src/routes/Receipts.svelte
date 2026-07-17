<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtDate, fmtMoney, fmtPct } from "../lib/format";
  import { csvMoney, downloadCsv, toCsv } from "../lib/csv";
  import type { Document, DocumentStatus } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  type Filter = "all" | DocumentStatus;

  let docs = $state<Document[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let filter = $state<Filter>("all");
  let search = $state("");
  let bookId = $state("");

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [book] = await api.bookList();
      if (!book) throw new Error("no book configured");
      bookId = book.id;
      docs = await api.documentList({ book_id: book.id });
    } catch (err) {
      loadError = String(err);
    } finally {
      loading = false;
    }
  }
  load();

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

  const filtered = $derived(
    docs.filter((d) => {
      if (filter !== "all" && d.status !== filter) return false;
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

  async function onFilePicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
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

  async function toggleDetail(d: Document) {
    if (selected?.id === d.id) {
      selected = null;
      return;
    }
    selected = await api.documentGet({ document_id: d.id });
  }
</script>

<PageHeader
  eyebrow="Slips · receipts · statements"
  title="Receipts"
  subtitle="Drop in slips and let extraction do the typing. Review anything below full confidence."
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
  >
    <Icon name="alert-circle" size={13} />
    {importError}
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
        {#if f.id !== "all" && counts[f.id]}
          <span class="num text-[10.5px] text-t3">{counts[f.id]}</span>
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
        <button class="btn" onclick={load}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if docs.length === 0}
    <EmptyState
      icon="receipt"
      title="No receipts yet"
      body="Drag a photo or PDF anywhere in this window, forward slips to your watched mailbox, or import from a folder. Files never leave your machine."
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
    <table class="w-full border-collapse text-[12.5px]">
      <thead>
        <tr class="bg-sunken/60">
          <th class="th">Document</th>
          <th class="th w-28">Date</th>
          <th class="th w-32 text-right">Total</th>
          <th class="th w-32">Status</th>
          <th class="th w-28 text-right">Confidence</th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as d (d.id)}
          <tr
            class="cursor-pointer transition-colors hover:bg-sunken/50 {selected?.id ===
            d.id
              ? 'bg-sunken/60'
              : ''}"
            onclick={() => toggleDetail(d)}
          >
            <td class="td max-w-0">
              <span class="flex items-center gap-2.5">
                <span
                  class="flex size-7 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
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
              </span>
            </td>
            <td class="td num whitespace-nowrap text-t2">
              {d.issued_at ? fmtDate(d.issued_at) : "—"}
            </td>
            <td class="td num text-right">
              {d.total_minor != null ? fmtMoney(d.total_minor, d.currency) : "—"}
            </td>
            <td class="td">
              <Badge tone={statusTone[d.status]} label={d.status} />
            </td>
            <td class="td num text-right text-t2">
              {d.extraction ? fmtPct(d.extraction.confidence) : "—"}
            </td>
          </tr>
          {#if selected?.id === d.id}
            <tr>
              <td colspan="5" class="td bg-sunken/30">
                {#if selected.extraction}
                  {@const ex = selected.extraction}
                  <div class="px-2 py-1.5">
                    <div class="mb-2 flex items-baseline justify-between">
                      <span class="text-[12.5px] font-semibold">
                        {ex.merchant || selected.file_name}
                        <span class="ml-2 text-[11px] font-normal text-t3">
                          {fmtDate(ex.issued_at)} · {fmtPct(ex.confidence)} confidence
                        </span>
                      </span>
                      <span class="num">{fmtMoney(ex.total_minor, ex.currency)}</span>
                    </div>
                    {#if ex.line_items.length > 0}
                      <ul class="divide-y divide-line/60">
                        {#each ex.line_items as li, i (i)}
                          <li
                            class="flex items-center gap-3 py-1 text-[12px]"
                          >
                            <span class="min-w-0 flex-1 truncate text-t2"
                              >{li.description}</span
                            >
                            <span class="num w-14 text-right text-t3"
                              >×{li.quantity}</span
                            >
                            <span class="num w-24 text-right"
                              >{fmtMoney(li.total_minor, ex.currency)}</span
                            >
                          </li>
                        {/each}
                      </ul>
                    {/if}
                    <div
                      class="mt-2 flex items-center gap-4 text-[11px] text-t3"
                    >
                      <span>VAT {fmtMoney(ex.vat_minor, ex.currency)}</span>
                      {#if ex.discount_minor > 0}
                        <span>Discounts −{fmtMoney(ex.discount_minor, ex.currency)}</span>
                      {/if}
                      <span class="num">{ex.currency}</span>
                    </div>
                  </div>
                {:else}
                  <p class="px-2 py-2 text-[12px] text-t3">
                    No extraction yet — this document is {selected.status}.
                    Run extraction from the CLI (slipscan extract) with your
                    configured LLM provider, or review it manually.
                  </p>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}
</div>
