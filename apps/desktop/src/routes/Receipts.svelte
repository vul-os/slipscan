<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtDate, fmtMoney, fmtPct } from "../lib/format";
  import type { Document, DocumentStatus } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  type Filter = "all" | DocumentStatus;

  let docs = $state<Document[]>([]);
  let loading = $state(true);
  let filter = $state<Filter>("all");
  let search = $state("");
  let bookId = $state("");

  async function load() {
    loading = true;
    const [book] = await api.bookList();
    if (!book) return;
    bookId = book.id;
    docs = await api.documentList({ book_id: book.id });
    loading = false;
  }
  load();

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

  async function importReceipt() {
    // Shell placeholder: real flow opens the OS file picker via Tauri.
    await api.documentImport({
      book_id: bookId,
      file_name: `scan-${Date.now().toString(36)}.pdf`,
      mime_type: "application/pdf",
    });
    docs = await api.documentList({ book_id: bookId });
  }
</script>

<PageHeader
  eyebrow="Slips · receipts · statements"
  title="Receipts"
  subtitle="Drop in slips and let extraction do the typing. Review anything below full confidence."
>
  {#snippet actions()}
    <button class="btn">
      <Icon name="download" size={14} />
      Export
    </button>
    <button class="btn btn-primary" onclick={importReceipt}>
      <Icon name="upload" size={14} />
      Import receipt
    </button>
  {/snippet}
</PageHeader>

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
          <tr class="transition-colors hover:bg-sunken/50">
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
              {d.total_minor != null ? fmtMoney(-d.total_minor) : "—"}
            </td>
            <td class="td">
              <Badge tone={statusTone[d.status]} label={d.status} />
            </td>
            <td class="td num text-right text-t2">
              {d.extraction ? fmtPct(d.extraction.confidence) : "—"}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
