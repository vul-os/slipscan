<script lang="ts">
  import { api } from "../lib/api/client";
  import { routeCache } from "../lib/loadCache";
  import { fmtDate, fmtPct } from "../lib/format";
  import { csvMoney, downloadCsv, toCsv } from "../lib/csv";
  import type { Document, DocumentStatus } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";

  type Filter = "all" | DocumentStatus;

  let docs = $state<Document[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let filter = $state<Filter>("all");
  let search = $state("");
  let bookId = $state("");

  interface Snapshot {
    bookId: string;
    docs: Document[];
  }

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const [book] = await api.bookList();
      if (!book) throw new Error("no book configured");
      bookId = book.id;
      docs = await api.documentList({ book_id: book.id });
      routeCache.set<Snapshot>("receipts", {
        bookId,
        docs: $state.snapshot(docs) as Document[],
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

  async function toggleDetail(d: Document) {
    if (selected?.id === d.id) {
      selected = null;
      return;
    }
    detailError = null;
    try {
      selected = await api.documentGet({ document_id: d.id });
    } catch (err) {
      detailError = String(err);
    }
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

{#if detailError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    Could not open the receipt detail: {detailError}
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
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if docs.length === 0}
    <EmptyState
      icon="receipt"
      title="No receipts yet"
      body="Import a photo or PDF of a slip, or forward slips to your watched mailbox. Files never leave your machine."
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
    <div class="table-wrap table-scroll">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th">Document</th>
            <th class="th w-28">Date</th>
            <th class="th w-32 text-right">Total</th>
            <th class="th w-32">Status</th>
            <th class="th w-36 text-right">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as d (d.id)}
            {@const open = selected?.id === d.id}
            <tr
              class="row-hover cursor-pointer {open ? 'bg-sunken/60' : ''}"
              role="button"
              tabindex="0"
              aria-expanded={open}
              aria-label="Toggle details for {d.merchant ?? d.file_name}"
              onclick={() => toggleDetail(d)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleDetail(d);
                }
              }}
            >
              <td class="td max-w-0">
                <span class="flex items-center gap-2.5">
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
                </span>
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
                <span class="flex items-center justify-end gap-2">
                  {#if d.extraction}
                    <Badge
                      tone={confidenceTone(d.extraction.confidence)}
                      label={fmtPct(d.extraction.confidence)}
                    />
                  {:else}
                    <span class="num text-t3">—</span>
                  {/if}
                  <Icon
                    name="chevron-down"
                    size={14}
                    class="shrink-0 text-t3 {open ? 'rotate-180' : ''}"
                  />
                </span>
              </td>
            </tr>
            {#if open}
              <tr>
                <td colspan="5" class="!p-0">
                  <div class="reveal border-t border-line bg-sunken/30">
                    <div class="reveal-inner">
                      {#if selected?.extraction}
                        {@const ex = selected.extraction}
                        <div class="px-4 py-3.5">
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
                                {#each ex.line_items as li, i (i)}
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
                        </div>
                      {:else}
                        <p class="px-4 py-3 text-[12px] leading-relaxed text-t3">
                          No extraction yet — this document is {selected?.status}.
                          Run extraction from the CLI (slipscan extract) with your
                          configured LLM provider, or review it manually.
                        </p>
                      {/if}
                    </div>
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
