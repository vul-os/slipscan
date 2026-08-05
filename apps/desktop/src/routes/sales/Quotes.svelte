<script lang="ts">
  /**
   * Sales › Quotes — a priced offer that has not happened yet.
   *
   * Status only ever moves forward: draft -> sent -> accepted | declined |
   * expired. Every guard below mirrors the service layer exactly (see
   * mock.ts `requireQuoteDraft`) rather than re-deriving it:
   *   - lines can be added, edited or removed only while draft.
   *   - sending needs at least one line.
   *   - only a sent quote can be declined, left to expire, or accepted.
   *   - only a draft quote can be deleted outright.
   *
   * A quote never touches stock or the ledger — there is no location, no
   * confirm, no journal anywhere on this screen. Accepting one copies its
   * lines into a brand-new **draft** sales order (it does not confirm it);
   * `onaccepted` hands control back to the Orders tab so a person can add a
   * location and confirm from there, the same handoff Orders makes into
   * Invoices when one is issued.
   *
   * Simple reload-after-write throughout, matching Orders.svelte's own
   * pattern for the identical reason: this screen mutates several related
   * lists (quote header, its lines, its totals), and refetching the lot
   * after any one write is one honest source of truth.
   */
  import { api } from "../../lib/api/client";
  import {
    fmtDate,
    localDate,
    minorToInput,
    parseMoneyInput,
  } from "../../lib/util/format";
  import type {
    Book,
    Contact,
    ProductVariant,
    Quote,
    QuoteItem,
    SalesOrder,
    SalesOrderTotals,
    VatRate,
  } from "../../lib/api/types";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Skeleton from "../../lib/components/Skeleton.svelte";
  import Money from "../../lib/components/Money.svelte";
  import Badge from "../../lib/components/Badge.svelte";
  import Icon from "../../lib/components/Icon.svelte";
  import Dialog from "../../lib/components/Dialog.svelte";
  import ConfirmDialog from "../../lib/components/ConfirmDialog.svelte";

  let { book, onaccepted }: { book: Book; onaccepted?: () => void } = $props();

  const statusTone: Record<
    Quote["status"],
    "neutral" | "accent" | "success" | "danger"
  > = {
    draft: "neutral",
    sent: "accent",
    accepted: "success",
    declined: "danger",
    expired: "danger",
  };

  let contacts = $state<Contact[]>([]);
  let variants = $state<ProductVariant[]>([]);
  let vatRates = $state<VatRate[]>([]);
  let quotesList = $state<Quote[]>([]);
  let totals = $state<Map<string, SalesOrderTotals>>(new Map());
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const [c, v, vr, qs] = await Promise.all([
        api.contactListCustomers({ book_id: book.id }),
        api.productVariantListForBook({ book_id: book.id }),
        api.vatRateList({ book_id: book.id }),
        api.quoteList({ book_id: book.id }),
      ]);
      const totalsEntries = await Promise.all(
        qs.map(
          async (quote) =>
            [quote.id, await api.quoteTotals({ id: quote.id })] as const,
        ),
      );
      contacts = c;
      variants = v;
      vatRates = vr;
      quotesList = qs;
      totals = new Map(totalsEntries);
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      if (!background) loading = false;
    }
  }
  void load();

  function contactName(id: string): string {
    return contacts.find((c) => c.id === id)?.name ?? "Unknown contact";
  }
  function taxLabel(bps: number): string {
    const rate = vatRates.find((r) => r.rate_bps === bps);
    return rate ? rate.name : `${(bps / 100).toFixed(2)}%`;
  }
  function defaultTaxBps(): number {
    return (
      vatRates.find((r) => r.is_active && r.code === "STD")?.rate_bps ??
      vatRates.find((r) => r.is_active)?.rate_bps ??
      0
    );
  }
  function lineTotal(item: QuoteItem): number {
    const net = item.quantity * item.unit_price_minor;
    return net + Math.round((net * item.tax_rate_bps) / 10_000);
  }
  const plural = (n: number, one: string, many: string) =>
    n === 1 ? one : many;

  // -- create quote -----------------------------------------------------

  let showCreate = $state(false);
  let newContactId = $state("");
  let newQuoteDate = $state(localDate());
  let newExpiryDate = $state("");
  let newNotes = $state("");
  let createBusy = $state(false);
  let createError = $state<string | null>(null);

  function openCreate() {
    newContactId = "";
    newQuoteDate = localDate();
    newExpiryDate = "";
    newNotes = "";
    createError = null;
    showCreate = true;
  }

  async function createQuote() {
    if (!newContactId) return;
    createBusy = true;
    createError = null;
    try {
      const quote = await api.quoteCreate({
        book_id: book.id,
        contact_id: newContactId,
        quote_date: newQuoteDate,
        expiry_date: newExpiryDate || undefined,
        notes: newNotes.trim() || undefined,
      });
      showCreate = false;
      await load(true);
      expanded = quote.id;
      resetLineForm();
      await loadItems(quote.id);
    } catch (err) {
      createError = String(err);
    } finally {
      createBusy = false;
    }
  }

  // -- row expansion + editing (draft only) ------------------------------

  let expanded = $state<string | null>(null);
  let items = $state<QuoteItem[]>([]);
  let itemsLoading = $state(false);
  let itemsError = $state<string | null>(null);

  async function toggleExpand(quote: Quote) {
    if (expanded === quote.id) {
      expanded = null;
      return;
    }
    expanded = quote.id;
    resetLineForm();
    await loadItems(quote.id);
  }

  async function loadItems(quoteId: string) {
    itemsLoading = true;
    itemsError = null;
    try {
      items = await api.quoteItemsList({ quote_id: quoteId });
    } catch (err) {
      itemsError = String(err);
    } finally {
      itemsLoading = false;
    }
  }

  async function refreshLines(quote: Quote) {
    await loadItems(quote.id);
    const t = await api.quoteTotals({ id: quote.id });
    totals = new Map(totals).set(quote.id, t);
  }

  // -- line editor (add / inline update / remove), draft only -----------

  let lineVariantId = $state("");
  let lineDescription = $state("");
  let lineQty = $state("1");
  let linePrice = $state("");
  let lineTaxBps = $state(0);
  let lineBusy = $state(false);
  let lineError = $state<string | null>(null);

  function resetLineForm() {
    lineVariantId = "";
    lineDescription = "";
    lineQty = "1";
    linePrice = "";
    lineError = null;
    lineTaxBps = defaultTaxBps();
  }

  function pickVariant(id: string) {
    lineVariantId = id;
    const v = variants.find((x) => x.id === id);
    if (v) {
      lineDescription = v.name;
      linePrice = minorToInput(v.price_minor, v.currency);
    } else {
      lineDescription = "";
      linePrice = "";
    }
  }

  async function addLine(quote: Quote) {
    lineError = null;
    const qty = Number(lineQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      lineError = "enter a quantity greater than zero";
      return;
    }
    let priceMinor: number | undefined;
    if (!lineVariantId) {
      if (!lineDescription.trim()) {
        lineError = "a free-text line needs a description";
        return;
      }
      const parsed = parseMoneyInput(linePrice, book.currency);
      if (parsed === null || parsed < 0) {
        lineError = "enter a valid unit price";
        return;
      }
      priceMinor = parsed;
    } else if (linePrice.trim() !== "") {
      const parsed = parseMoneyInput(linePrice, book.currency);
      if (parsed === null || parsed < 0) {
        lineError = "enter a valid unit price";
        return;
      }
      priceMinor = parsed;
    }
    lineBusy = true;
    try {
      await api.quoteItemAdd({
        quote_id: quote.id,
        variant_id: lineVariantId || null,
        description: lineDescription.trim() || undefined,
        quantity: qty,
        unit_price_minor: priceMinor,
        tax_rate_bps: lineTaxBps,
      });
      await refreshLines(quote);
      resetLineForm();
    } catch (err) {
      lineError = String(err);
    } finally {
      lineBusy = false;
    }
  }

  async function updateLineQty(quote: Quote, item: QuoteItem, raw: string) {
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty <= 0 || qty === item.quantity) return;
    try {
      await api.quoteItemUpdate({ id: item.id, quantity: qty });
      await refreshLines(quote);
    } catch (err) {
      itemsError = String(err);
    }
  }

  async function updateLinePrice(quote: Quote, item: QuoteItem, raw: string) {
    const parsed = parseMoneyInput(raw, book.currency);
    if (parsed === null || parsed < 0 || parsed === item.unit_price_minor) return;
    try {
      await api.quoteItemUpdate({ id: item.id, unit_price_minor: parsed });
      await refreshLines(quote);
    } catch (err) {
      itemsError = String(err);
    }
  }

  async function updateLineTax(quote: Quote, item: QuoteItem, bps: number) {
    if (bps === item.tax_rate_bps) return;
    try {
      await api.quoteItemUpdate({ id: item.id, tax_rate_bps: bps });
      await refreshLines(quote);
    } catch (err) {
      itemsError = String(err);
    }
  }

  async function removeLine(quote: Quote, item: QuoteItem) {
    try {
      await api.quoteItemRemove({ id: item.id });
      await refreshLines(quote);
    } catch (err) {
      itemsError = String(err);
    }
  }

  // -- header edits (draft only): expiry date -----------------------------

  async function updateExpiry(quote: Quote, raw: string) {
    try {
      await api.quoteUpdate({ id: quote.id, expiry_date: raw || null });
      await load(true);
    } catch (err) {
      itemsError = String(err);
    }
  }

  // -- status transitions --------------------------------------------------

  let sendTarget = $state<Quote | null>(null);
  let sendBusy = $state(false);
  let sendError = $state<string | null>(null);

  let declineTarget = $state<Quote | null>(null);
  let declineBusy = $state(false);
  let declineError = $state<string | null>(null);

  let expireTarget = $state<Quote | null>(null);
  let expireBusy = $state(false);
  let expireError = $state<string | null>(null);

  let deleteTarget = $state<Quote | null>(null);
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);

  async function doSend() {
    const quote = sendTarget;
    if (!quote) return;
    sendBusy = true;
    sendError = null;
    try {
      await api.quoteSend({ id: quote.id });
      sendTarget = null;
      await load(true);
    } catch (err) {
      sendError = String(err);
    } finally {
      sendBusy = false;
    }
  }

  async function doDecline() {
    const quote = declineTarget;
    if (!quote) return;
    declineBusy = true;
    declineError = null;
    try {
      await api.quoteDecline({ id: quote.id });
      declineTarget = null;
      await load(true);
    } catch (err) {
      declineError = String(err);
    } finally {
      declineBusy = false;
    }
  }

  async function doExpire() {
    const quote = expireTarget;
    if (!quote) return;
    expireBusy = true;
    expireError = null;
    try {
      await api.quoteExpire({ id: quote.id });
      expireTarget = null;
      await load(true);
    } catch (err) {
      expireError = String(err);
    } finally {
      expireBusy = false;
    }
  }

  async function doDelete() {
    const quote = deleteTarget;
    if (!quote) return;
    deleteBusy = true;
    deleteError = null;
    try {
      await api.quoteDelete({ id: quote.id });
      deleteTarget = null;
      if (expanded === quote.id) expanded = null;
      await load(true);
    } catch (err) {
      deleteError = String(err);
    } finally {
      deleteBusy = false;
    }
  }

  // -- accept: copies lines into a new draft sales order -----------------

  let acceptTarget = $state<Quote | null>(null);
  let acceptBusy = $state(false);
  let acceptError = $state<string | null>(null);
  let acceptedOrder = $state<SalesOrder | null>(null);

  function openAccept(quote: Quote) {
    acceptTarget = quote;
    acceptError = null;
    acceptedOrder = null;
  }

  async function doAccept() {
    const quote = acceptTarget;
    if (!quote) return;
    acceptBusy = true;
    acceptError = null;
    try {
      acceptedOrder = await api.quoteAccept({ id: quote.id });
      await load(true);
    } catch (err) {
      acceptError = String(err);
    } finally {
      acceptBusy = false;
    }
  }

  function closeAccept() {
    acceptTarget = null;
    acceptedOrder = null;
  }
</script>

<div class="mb-3 flex items-center justify-between gap-2">
  <p class="text-[12px] text-t3">
    {quotesList.length}
    {plural(quotesList.length, "quote", "quotes")}
  </p>
  <button
    class="btn btn-primary"
    onclick={openCreate}
    disabled={loading || contacts.length === 0}
    title={contacts.length === 0
      ? "Add a customer contact first (contact_add — no Contacts screen is wired up here yet)"
      : undefined}
  >
    <Icon name="plus" size={14} />
    New quote
  </button>
</div>

{#if !loading && contacts.length === 0}
  <p
    class="mb-3 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-t2"
  >
    <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
    This book has no customer contact yet, so a quote has nobody to offer to.
    Contacts are reachable today through <code class="num">contact_add</code>
    on the CLI or HTTP API — the Contacts screen is not wired up on the
    desktop yet.
  </p>
{/if}

<div class="card overflow-hidden">
  {#if loading}
    <Skeleton rows={6} />
  {:else if loadError}
    <EmptyState icon="alert-circle" title="Could not load quotes" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if quotesList.length === 0}
    <EmptyState
      icon="receipt"
      title="No quotes yet"
      body="Draft a priced offer for a customer, add lines, then send it. A quote never touches stock or the ledger — nothing has moved until it is accepted, which copies its lines into a brand-new draft sales order."
    >
      {#snippet actions()}
        <button
          class="btn btn-primary"
          onclick={openCreate}
          disabled={contacts.length === 0}
        >
          <Icon name="plus" size={14} />
          New quote
        </button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table-wrap table-scroll">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th w-20">#</th>
            <th class="th w-28">Date</th>
            <th class="th">Contact</th>
            <th class="th w-28">Status</th>
            <th class="th w-32 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {#each quotesList as quote (quote.id)}
            {@const open = expanded === quote.id}
            {@const quoteTotals = totals.get(quote.id)}
            <tr class="row-hover">
              <td class="td">
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 text-left font-medium"
                  aria-expanded={open}
                  aria-controls="qt-panel-{quote.id}"
                  onclick={() => toggleExpand(quote)}
                >
                  <Icon
                    name="chevron-down"
                    size={12}
                    class="shrink-0 text-t3 {open ? '' : '-rotate-90'}"
                  />
                  <span class="num">#{quote.number}</span>
                </button>
              </td>
              <td class="td num whitespace-nowrap text-t2">
                {fmtDate(`${quote.quote_date}T12:00:00Z`)}
              </td>
              <td class="td max-w-0">
                <span class="block truncate">{contactName(quote.contact_id)}</span>
              </td>
              <td class="td">
                <Badge tone={statusTone[quote.status]} label={quote.status} />
              </td>
              <td class="td text-right">
                {#if quoteTotals}
                  <Money amount={quoteTotals.total_minor} currency={quote.currency} />
                {:else}
                  —
                {/if}
              </td>
            </tr>
            {#if open}
              <tr>
                <td class="td bg-sunken/40 p-0" id="qt-panel-{quote.id}" colspan={5}>
                  <div class="reveal">
                    <div class="reveal-inner space-y-3 px-3 py-3">
                      <!-- header: expiry date, editable while draft -->
                      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
                        <label class="flex items-center gap-1.5">
                          <span class="text-t3">Expires</span>
                          {#if quote.status === "draft"}
                            <input
                              class="input h-7 w-40 text-[12px]"
                              type="date"
                              aria-label="Expiry date for quote #{quote.number}"
                              value={quote.expiry_date ?? ""}
                              onchange={(e) => updateExpiry(quote, e.currentTarget.value)}
                            />
                          {:else}
                            <span class="text-t2">
                              {quote.expiry_date
                                ? fmtDate(`${quote.expiry_date}T12:00:00Z`)
                                : "No expiry set"}
                            </span>
                          {/if}
                        </label>
                        {#if quote.notes}
                          <span class="text-t3">·</span>
                          <span class="text-t2">{quote.notes}</span>
                        {/if}
                        {#if quote.converted_sales_order_id}
                          <span class="text-t3">·</span>
                          <span class="flex items-center gap-1 text-t2">
                            <Icon name="cart" size={12} class="text-t3" />
                            Converted to a sales order
                          </span>
                        {/if}
                      </div>

                      <!-- lines -->
                      {#if itemsLoading}
                        <Skeleton rows={2} />
                      {:else}
                        <div class="overflow-hidden rounded-lg border border-line">
                          <table class="w-full text-[12px]">
                            <thead>
                              <tr class="border-b border-line bg-sunken/60">
                                <th class="th">Line</th>
                                <th class="th w-20">Qty</th>
                                <th class="th w-28">Unit price</th>
                                <th class="th w-36">Tax</th>
                                <th class="th w-28 text-right">Total</th>
                                {#if quote.status === "draft"}
                                  <th class="th w-9"></th>
                                {/if}
                              </tr>
                            </thead>
                            <tbody>
                              {#each items as item (item.id)}
                                <tr class="border-b border-line last:border-b-0">
                                  <td class="td max-w-0">
                                    <span class="block truncate">
                                      {item.description}
                                      {#if item.variant_id}
                                        <span class="ml-1 text-[10.5px] text-t3">from catalogue</span>
                                      {/if}
                                    </span>
                                  </td>
                                  <td class="td">
                                    {#if quote.status === "draft"}
                                      <input
                                        class="input h-7 w-16 text-[12px]"
                                        type="number"
                                        min="0.01"
                                        step="1"
                                        aria-label="Quantity for {item.description}"
                                        value={item.quantity}
                                        onchange={(e) =>
                                          updateLineQty(quote, item, e.currentTarget.value)}
                                      />
                                    {:else}
                                      <span class="num">{item.quantity}</span>
                                    {/if}
                                  </td>
                                  <td class="td">
                                    {#if quote.status === "draft"}
                                      <input
                                        class="input h-7 w-24 text-[12px]"
                                        aria-label="Unit price for {item.description}"
                                        value={minorToInput(
                                          item.unit_price_minor,
                                          quote.currency,
                                        )}
                                        onchange={(e) =>
                                          updateLinePrice(quote, item, e.currentTarget.value)}
                                      />
                                    {:else}
                                      <Money
                                        amount={item.unit_price_minor}
                                        currency={quote.currency}
                                      />
                                    {/if}
                                  </td>
                                  <td class="td">
                                    {#if quote.status === "draft" && vatRates.length > 0}
                                      <select
                                        class="input h-7 w-full text-[12px]"
                                        aria-label="Tax rate for {item.description}"
                                        value={item.tax_rate_bps}
                                        onchange={(e) =>
                                          updateLineTax(
                                            quote,
                                            item,
                                            Number(e.currentTarget.value),
                                          )}
                                      >
                                        {#each vatRates as r (r.id)}
                                          <option value={r.rate_bps}>{r.name}</option>
                                        {/each}
                                      </select>
                                    {:else}
                                      <span class="text-t2">{taxLabel(item.tax_rate_bps)}</span>
                                    {/if}
                                  </td>
                                  <td class="td text-right">
                                    <Money amount={lineTotal(item)} currency={quote.currency} />
                                  </td>
                                  {#if quote.status === "draft"}
                                    <td class="td">
                                      <button
                                        type="button"
                                        class="btn btn-ghost h-7 w-7 px-0"
                                        aria-label="Remove {item.description}"
                                        onclick={() => removeLine(quote, item)}
                                      >
                                        <Icon name="trash" size={13} />
                                      </button>
                                    </td>
                                  {/if}
                                </tr>
                              {:else}
                                <tr>
                                  <td class="td text-t3" colspan={quote.status === "draft" ? 6 : 5}>
                                    No lines yet.
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      {/if}

                      {#if itemsError}
                        <p class="flex items-center gap-1.5 text-[11.5px] text-danger">
                          <Icon name="alert-circle" size={12} />
                          {itemsError}
                        </p>
                      {/if}

                      <!-- add a line: draft only -->
                      {#if quote.status === "draft"}
                        <div
                          class="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-sunken/40 p-2.5"
                        >
                          <label class="block">
                            <span class="mb-1 block text-[11px] text-t3">Variant</span>
                            <select
                              class="input h-7 w-44 text-[12px]"
                              aria-label="Variant for new line"
                              value={lineVariantId}
                              onchange={(e) => pickVariant(e.currentTarget.value)}
                            >
                              <option value="">Free text / service</option>
                              {#each variants as v (v.id)}
                                <option value={v.id}>{v.name} · {v.sku}</option>
                              {/each}
                            </select>
                          </label>
                          <label class="block min-w-0 flex-1">
                            <span class="mb-1 block text-[11px] text-t3">Description</span>
                            <input
                              class="input h-7 w-full text-[12px]"
                              aria-label="Description for new line"
                              bind:value={lineDescription}
                              disabled={!!lineVariantId}
                              placeholder={lineVariantId ? undefined : "What is being offered"}
                            />
                          </label>
                          <label class="block">
                            <span class="mb-1 block text-[11px] text-t3">Qty</span>
                            <input
                              class="input h-7 w-16 text-[12px]"
                              type="number"
                              min="0.01"
                              step="1"
                              aria-label="Quantity for new line"
                              bind:value={lineQty}
                            />
                          </label>
                          <label class="block">
                            <span class="mb-1 block text-[11px] text-t3">Unit price</span>
                            <input
                              class="input h-7 w-24 text-[12px]"
                              aria-label="Unit price for new line"
                              bind:value={linePrice}
                              placeholder={lineVariantId ? "variant price" : "0.00"}
                            />
                          </label>
                          <label class="block">
                            <span class="mb-1 block text-[11px] text-t3">Tax</span>
                            {#if vatRates.length > 0}
                              <select
                                class="input h-7 w-36 text-[12px]"
                                aria-label="Tax rate for new line"
                                bind:value={lineTaxBps}
                              >
                                {#each vatRates as r (r.id)}
                                  <option value={r.rate_bps}>{r.name}</option>
                                {/each}
                              </select>
                            {:else}
                              <input
                                class="input h-7 w-24 text-[12px]"
                                type="number"
                                min="0"
                                max="10000"
                                aria-label="Tax rate in basis points for new line"
                                bind:value={lineTaxBps}
                              />
                            {/if}
                          </label>
                          <button
                            class="btn h-7"
                            disabled={lineBusy}
                            onclick={() => addLine(quote)}
                          >
                            <Icon name="plus" size={12} />
                            Add line
                          </button>
                        </div>
                        {#if lineError}
                          <p class="flex items-center gap-1.5 text-[11.5px] text-danger">
                            <Icon name="alert-circle" size={12} />
                            {lineError}
                          </p>
                        {/if}
                      {/if}

                      <!-- totals -->
                      {#if quoteTotals}
                        <div
                          class="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[12px]"
                        >
                          <span class="text-t3"
                            >Subtotal <Money
                              amount={quoteTotals.subtotal_minor}
                              currency={quote.currency}
                            /></span
                          >
                          <span class="text-t3"
                            >Tax <Money
                              amount={quoteTotals.tax_minor}
                              currency={quote.currency}
                            /></span
                          >
                          <span class="font-semibold"
                            >Total <Money
                              amount={quoteTotals.total_minor}
                              currency={quote.currency}
                            /></span
                          >
                        </div>
                      {/if}

                      <!-- status actions -->
                      <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                        {#if quote.status === "draft"}
                          <button
                            class="btn btn-primary h-7"
                            disabled={items.length === 0}
                            title={items.length === 0
                              ? "Add at least one line first"
                              : undefined}
                            onclick={() => {
                              sendError = null;
                              sendTarget = quote;
                            }}
                          >
                            <Icon name="mail" size={13} />
                            Send quote
                          </button>
                          <button
                            class="btn btn-ghost h-7 text-danger"
                            onclick={() => {
                              deleteError = null;
                              deleteTarget = quote;
                            }}
                          >
                            <Icon name="trash" size={12} />
                            Delete draft
                          </button>
                        {:else if quote.status === "sent"}
                          <button
                            class="btn btn-primary h-7"
                            onclick={() => openAccept(quote)}
                          >
                            <Icon name="check" size={13} />
                            Accept
                          </button>
                          <button
                            class="btn h-7"
                            onclick={() => {
                              declineError = null;
                              declineTarget = quote;
                            }}
                          >
                            Decline
                          </button>
                          <button
                            class="btn btn-ghost h-7"
                            onclick={() => {
                              expireError = null;
                              expireTarget = quote;
                            }}
                          >
                            Let it expire
                          </button>
                        {:else}
                          <span class="flex items-center gap-1.5 text-[11.5px] text-t3">
                            <Icon name="alert-circle" size={12} />
                            {#if quote.status === "accepted"}
                              Accepted {quote.accepted_at ? fmtDate(quote.accepted_at) : ""} — see
                              the resulting order under Orders.
                            {:else if quote.status === "declined"}
                              Declined {quote.declined_at ? fmtDate(quote.declined_at) : ""} — no
                              further action.
                            {:else}
                              Expired {quote.expired_at ? fmtDate(quote.expired_at) : ""} — no
                              further action.
                            {/if}
                          </span>
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
  {/if}
</div>

<!-- new quote -->
<Dialog
  open={showCreate}
  title="New quote"
  description="Starts as a draft. Add lines after creating it, then send it when it is ready. A quote never touches stock or the ledger — nothing has happened yet."
  size="md"
  dismissible={!createBusy}
  onclose={() => (showCreate = false)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Customer</span>
      <select
        data-autofocus
        class="input"
        aria-label="Customer"
        bind:value={newContactId}
        disabled={createBusy}
      >
        <option value="">Choose a customer…</option>
        {#each contacts as c (c.id)}
          <option value={c.id}>{c.name}</option>
        {/each}
      </select>
    </label>
    <div class="grid grid-cols-2 gap-3">
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Quote date</span>
        <input class="input" type="date" bind:value={newQuoteDate} disabled={createBusy} />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">
          Expires <span class="text-t3">(optional)</span>
        </span>
        <input class="input" type="date" bind:value={newExpiryDate} disabled={createBusy} />
      </label>
    </div>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Notes (optional)</span>
      <textarea class="input" rows="2" bind:value={newNotes} disabled={createBusy}></textarea>
    </label>
    {#if createError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {createError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={createBusy} onclick={() => (showCreate = false)}>
      Cancel
    </button>
    <button class="btn btn-primary" disabled={createBusy || !newContactId} onclick={createQuote}>
      {createBusy ? "Creating…" : "Create draft"}
    </button>
  {/snippet}
</Dialog>

<!-- send quote -->
<ConfirmDialog
  open={sendTarget !== null}
  title="Send quote #{sendTarget?.number ?? ''}?"
  body="Lines can no longer be edited once sent. From here the quote can be accepted, declined, or left to expire."
  confirmLabel="Send quote"
  busy={sendBusy}
  error={sendError}
  onconfirm={doSend}
  oncancel={() => (sendTarget = null)}
/>

<!-- decline quote -->
<ConfirmDialog
  open={declineTarget !== null}
  title="Decline quote #{declineTarget?.number ?? ''}?"
  body="Records that the customer said no. The quote stays on record rather than being removed."
  confirmLabel="Decline quote"
  tone="danger"
  busy={declineBusy}
  error={declineError}
  onconfirm={doDecline}
  oncancel={() => (declineTarget = null)}
/>

<!-- expire quote -->
<ConfirmDialog
  open={expireTarget !== null}
  title="Mark quote #{expireTarget?.number ?? ''} as expired?"
  body="Nothing expires a quote automatically — this is a deliberate call, not a timer."
  confirmLabel="Mark expired"
  tone="danger"
  busy={expireBusy}
  error={expireError}
  onconfirm={doExpire}
  oncancel={() => (expireTarget = null)}
/>

<!-- delete draft -->
<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete draft quote #{deleteTarget?.number ?? ''}?"
  body="A draft that was never sent moved nothing, so deleting it removes the quote and its lines outright. Its quote number is not reused."
  confirmLabel="Delete draft"
  tone="danger"
  busy={deleteBusy}
  error={deleteError}
  onconfirm={doDelete}
  oncancel={() => (deleteTarget = null)}
/>

<!-- accept quote -->
<Dialog
  open={acceptTarget !== null}
  title="Accept quote #{acceptTarget?.number ?? ''}"
  description={acceptedOrder
    ? undefined
    : "Copies this quote's lines into a brand-new draft sales order. This quote's own lines are never changed — the order starts as a draft, same as any other; add a location and confirm it from the Orders tab when ready."}
  size="sm"
  dismissible={!acceptBusy}
  onclose={closeAccept}
>
  <div class="space-y-3 px-5 pb-4">
    {#if acceptedOrder}
      <p
        class="flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success"
        role="status"
      >
        <Icon name="check-circle" size={13} />
        Created sales order #{acceptedOrder.number} as a draft.
      </p>
    {:else if acceptError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {acceptError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    {#if acceptedOrder}
      <button
        class="btn btn-primary"
        onclick={() => {
          closeAccept();
          onaccepted?.();
        }}
      >
        View in Orders
      </button>
    {:else}
      <button class="btn" disabled={acceptBusy} onclick={closeAccept}>Cancel</button>
      <button class="btn btn-primary" disabled={acceptBusy} onclick={doAccept}>
        {acceptBusy ? "Accepting…" : "Accept"}
      </button>
    {/if}
  {/snippet}
</Dialog>
