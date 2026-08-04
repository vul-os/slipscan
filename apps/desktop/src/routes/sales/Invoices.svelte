<script lang="ts">
  /**
   * Sales › Invoices — numbered facts, never edited.
   *
   * There is no `invoiceUpdate` or `invoiceDelete` anywhere in the API
   * because the database refuses one (types.ts, the block above
   * `invoiceIssue`) — a correction is a credit note, not built. This
   * component must never grow an edit affordance on an issued invoice; the
   * only writes it performs are `invoiceIssue` (a brand new row) and
   * `invoicePaymentRecord` (an insert-only payment against one).
   *
   * Paid/unpaid is `InvoiceTotals.status`, derived from `SUM(payments)`
   * against the line total on every call — never stored, never recomputed
   * here. Every figure on this screen (subtotal/tax/total/paid/due/status)
   * comes straight from `invoiceTotals`.
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
    Invoice,
    InvoiceItem,
    InvoicePayment,
    InvoicePaymentStatus,
    InvoiceTotals,
    ProductVariant,
    VatRate,
  } from "../../lib/api/types";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Skeleton from "../../lib/components/Skeleton.svelte";
  import Money from "../../lib/components/Money.svelte";
  import Badge from "../../lib/components/Badge.svelte";
  import Icon from "../../lib/components/Icon.svelte";
  import Dialog from "../../lib/components/Dialog.svelte";

  let { book }: { book: Book } = $props();

  const statusTone: Record<InvoicePaymentStatus, "warning" | "accent" | "success"> = {
    unpaid: "warning",
    partly_paid: "accent",
    paid: "success",
  };
  const statusLabel: Record<InvoicePaymentStatus, string> = {
    unpaid: "unpaid",
    partly_paid: "partly paid",
    paid: "paid",
  };

  let contacts = $state<Contact[]>([]);
  let variants = $state<ProductVariant[]>([]);
  let vatRates = $state<VatRate[]>([]);
  let invoices = $state<Invoice[]>([]);
  let totals = $state<Map<string, InvoiceTotals>>(new Map());
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const [c, v, vr, inv] = await Promise.all([
        api.contactListCustomers({ book_id: book.id }),
        api.productVariantListForBook({ book_id: book.id }),
        api.vatRateList({ book_id: book.id }),
        api.invoiceList({ book_id: book.id }),
      ]);
      const totalsEntries = await Promise.all(
        inv.map(
          async (i) => [i.id, await api.invoiceTotals({ id: i.id })] as const,
        ),
      );
      contacts = c;
      variants = v;
      vatRates = vr;
      invoices = inv;
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
  function invoiceRef(invoice: Invoice): string {
    return `${invoice.series} #${invoice.number}`;
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
  function lineTotal(item: InvoiceItem): number {
    const net = item.quantity * item.unit_price_minor;
    return net + Math.round((net * item.tax_rate_bps) / 10_000);
  }
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  // -- row expansion: items + payments ------------------------------------

  let expanded = $state<string | null>(null);
  let items = $state<InvoiceItem[]>([]);
  let payments = $state<InvoicePayment[]>([]);
  let panelLoading = $state(false);
  let panelError = $state<string | null>(null);

  async function toggleExpand(invoice: Invoice) {
    if (expanded === invoice.id) {
      expanded = null;
      return;
    }
    expanded = invoice.id;
    panelLoading = true;
    panelError = null;
    try {
      const [its, pays] = await Promise.all([
        api.invoiceItemsList({ invoice_id: invoice.id }),
        api.invoicePaymentsList({ invoice_id: invoice.id }),
      ]);
      items = its;
      payments = pays;
    } catch (err) {
      panelError = String(err);
    } finally {
      panelLoading = false;
    }
  }

  async function refreshPanel(invoiceId: string) {
    const [pays, t] = await Promise.all([
      api.invoicePaymentsList({ invoice_id: invoiceId }),
      api.invoiceTotals({ id: invoiceId }),
    ]);
    payments = pays;
    totals = new Map(totals).set(invoiceId, t);
  }

  // -- record a payment -----------------------------------------------------

  let payTarget = $state<Invoice | null>(null);
  let payAmount = $state("");
  let payDate = $state(localDate());
  let payMethod = $state("");
  let payNote = $state("");
  let payBusy = $state(false);
  let payError = $state<string | null>(null);

  function openPay(invoice: Invoice) {
    payTarget = invoice;
    const t = totals.get(invoice.id);
    payAmount = t ? minorToInput(t.due_minor, invoice.currency) : "";
    payDate = localDate();
    payMethod = "";
    payNote = "";
    payError = null;
  }

  async function recordPayment() {
    const invoice = payTarget;
    if (!invoice) return;
    const parsed = parseMoneyInput(payAmount, invoice.currency);
    if (parsed === null || parsed <= 0) {
      payError = "enter an amount greater than zero";
      return;
    }
    payBusy = true;
    payError = null;
    try {
      await api.invoicePaymentRecord({
        invoice_id: invoice.id,
        amount_minor: parsed,
        paid_at: `${payDate}T12:00:00Z`,
        method: payMethod.trim() || undefined,
        note: payNote.trim() || undefined,
      });
      await refreshPanel(invoice.id);
      payTarget = null;
    } catch (err) {
      payError = String(err);
    } finally {
      payBusy = false;
    }
  }

  // -- standalone invoice (no order behind it) -----------------------------

  interface DraftLine {
    key: number;
    variantId: string;
    description: string;
    quantity: string;
    price: string;
    taxBps: number;
  }
  let draftKey = 0;

  let showCreate = $state(false);
  let newContactId = $state("");
  let newIssueDate = $state(localDate());
  let newDueDate = $state(localDate());
  let newNotes = $state("");
  let draftLines = $state<DraftLine[]>([]);
  let createBusy = $state(false);
  let createError = $state<string | null>(null);
  let createdInvoice = $state<Invoice | null>(null);

  function blankLine(): DraftLine {
    draftKey += 1;
    return {
      key: draftKey,
      variantId: "",
      description: "",
      quantity: "1",
      price: "",
      taxBps: defaultTaxBps(),
    };
  }

  function openCreate() {
    newContactId = "";
    newIssueDate = localDate();
    newDueDate = localDate();
    newNotes = "";
    draftLines = [blankLine()];
    createError = null;
    createdInvoice = null;
    showCreate = true;
  }

  function addDraftLine() {
    draftLines = [...draftLines, blankLine()];
  }
  function removeDraftLine(key: number) {
    draftLines = draftLines.filter((l) => l.key !== key);
  }
  function pickDraftVariant(line: DraftLine, id: string) {
    line.variantId = id;
    const v = variants.find((x) => x.id === id);
    if (v) {
      line.description = v.name;
      line.price = minorToInput(v.price_minor, v.currency);
    } else {
      line.description = "";
      line.price = "";
    }
  }

  async function submitCreate() {
    createError = null;
    if (!newContactId) {
      createError = "choose a customer";
      return;
    }
    if (newDueDate < newIssueDate) {
      createError = "the due date cannot be before the issue date";
      return;
    }
    if (draftLines.length === 0) {
      createError = "add at least one line";
      return;
    }
    const items: {
      variant_id?: string | null;
      description: string;
      quantity: number;
      unit_price_minor: number;
      tax_rate_bps?: number;
    }[] = [];
    for (const line of draftLines) {
      const qty = Number(line.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        createError = "every line needs a quantity greater than zero";
        return;
      }
      const description = line.description.trim();
      if (!description) {
        createError = "every line needs a description";
        return;
      }
      const price = parseMoneyInput(line.price, book.currency);
      if (price === null || price < 0) {
        createError = "every line needs a valid unit price";
        return;
      }
      items.push({
        variant_id: line.variantId || null,
        description,
        quantity: qty,
        unit_price_minor: price,
        tax_rate_bps: line.taxBps,
      });
    }
    createBusy = true;
    try {
      const invoice = await api.invoiceIssue({
        book_id: book.id,
        contact_id: newContactId,
        issue_date: newIssueDate,
        due_date: newDueDate,
        notes: newNotes.trim() || undefined,
        items,
      });
      createdInvoice = invoice;
      await load(true);
    } catch (err) {
      createError = String(err);
    } finally {
      createBusy = false;
    }
  }
</script>

<div class="mb-3 flex items-center justify-between gap-2">
  <p class="text-[12px] text-t3">
    {invoices.length}
    {plural(invoices.length, "invoice", "invoices")}
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
    New invoice
  </button>
</div>

<p class="mb-3 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-t2">
  <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
  Invoices are immutable once issued — there is no edit here, on purpose. A
  wrong line stays on record; a correction is a credit note, which SlipScan
  does not build yet. The usual path is issuing straight from a confirmed
  order on the Orders tab; "New invoice" here is for a standalone bill (a
  retainer, a one-off service) that has no order behind it.
</p>

<div class="card overflow-hidden">
  {#if loading}
    <Skeleton rows={6} />
  {:else if loadError}
    <EmptyState icon="alert-circle" title="Could not load invoices" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if invoices.length === 0}
    <EmptyState
      icon="receipt"
      title="No invoices yet"
      body="Confirm a sales order and issue an invoice from it, or start a standalone one here for a bill that has no order behind it."
    >
      {#snippet actions()}
        <button
          class="btn btn-primary"
          onclick={openCreate}
          disabled={contacts.length === 0}
        >
          <Icon name="plus" size={14} />
          New invoice
        </button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table-wrap table-scroll">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <th class="th w-28">Invoice</th>
            <th class="th w-24">Issued</th>
            <th class="th w-24">Due</th>
            <th class="th">Contact</th>
            <th class="th w-28">Status</th>
            <th class="th w-28 text-right">Total</th>
            <th class="th w-28 text-right">Due</th>
          </tr>
        </thead>
        <tbody>
          {#each invoices as invoice (invoice.id)}
            {@const open = expanded === invoice.id}
            {@const t = totals.get(invoice.id)}
            <tr class="row-hover">
              <td class="td">
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 text-left font-medium"
                  aria-expanded={open}
                  aria-controls="inv-panel-{invoice.id}"
                  onclick={() => toggleExpand(invoice)}
                >
                  <Icon
                    name="chevron-down"
                    size={12}
                    class="shrink-0 text-t3 {open ? '' : '-rotate-90'}"
                  />
                  {invoiceRef(invoice)}
                </button>
              </td>
              <td class="td num whitespace-nowrap text-t2">
                {fmtDate(`${invoice.issue_date}T12:00:00Z`)}
              </td>
              <td class="td num whitespace-nowrap text-t2">
                {fmtDate(`${invoice.due_date}T12:00:00Z`)}
              </td>
              <td class="td max-w-0">
                <span class="block truncate">{contactName(invoice.contact_id)}</span>
              </td>
              <td class="td">
                {#if t}
                  <Badge tone={statusTone[t.status]} label={statusLabel[t.status]} />
                {/if}
              </td>
              <td class="td text-right">
                {#if t}
                  <Money amount={t.total_minor} currency={invoice.currency} />
                {/if}
              </td>
              <td class="td text-right">
                {#if t}
                  <Money
                    amount={t.due_minor}
                    currency={invoice.currency}
                    class={t.due_minor > 0 ? "text-warning" : "text-t3"}
                  />
                {/if}
              </td>
            </tr>
            {#if open}
              <tr>
                <td class="td bg-sunken/40 p-0" id="inv-panel-{invoice.id}" colspan={7}>
                  <div class="reveal">
                    <div class="reveal-inner space-y-3 px-3 py-3">
                      {#if invoice.sales_order_id}
                        <p class="flex items-center gap-1.5 text-[12px] text-t2">
                          <Icon name="cart" size={12} class="text-t3" />
                          Issued from sales order — see the Orders tab.
                        </p>
                      {/if}
                      {#if invoice.notes}
                        <p class="text-[12px] text-t2">{invoice.notes}</p>
                      {/if}

                      {#if panelLoading}
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
                              </tr>
                            </thead>
                            <tbody>
                              {#each items as item (item.id)}
                                <tr class="border-b border-line last:border-b-0">
                                  <td class="td max-w-0">
                                    <span class="block truncate">{item.description}</span>
                                  </td>
                                  <td class="td num">{item.quantity}</td>
                                  <td class="td">
                                    <Money
                                      amount={item.unit_price_minor}
                                      currency={invoice.currency}
                                    />
                                  </td>
                                  <td class="td text-t2">{taxLabel(item.tax_rate_bps)}</td>
                                  <td class="td text-right">
                                    <Money
                                      amount={lineTotal(item)}
                                      currency={invoice.currency}
                                    />
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>

                        {#if t}
                          <div
                            class="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-[12px]"
                          >
                            <span class="text-t3"
                              >Subtotal <Money
                                amount={t.subtotal_minor}
                                currency={invoice.currency}
                              /></span
                            >
                            <span class="text-t3"
                              >Tax <Money amount={t.tax_minor} currency={invoice.currency} /></span
                            >
                            <span class="font-semibold"
                              >Total <Money
                                amount={t.total_minor}
                                currency={invoice.currency}
                              /></span
                            >
                          </div>
                        {/if}

                        <!-- payments: an insert-only ledger against this invoice -->
                        <div class="border-t border-line pt-3">
                          <h4 class="mb-2 text-[11.5px] font-semibold text-t2">
                            Payments
                          </h4>
                          {#if payments.length === 0}
                            <p class="text-[11.5px] text-t3">
                              No payments recorded — this invoice is unpaid.
                            </p>
                          {:else}
                            <ul class="space-y-1">
                              {#each payments as p (p.id)}
                                <li class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px]">
                                  <span class="num text-t2">{fmtDate(p.paid_at)}</span>
                                  <Money amount={p.amount_minor} currency={invoice.currency} />
                                  {#if p.method}
                                    <Badge tone="neutral" dot={false} label={p.method} />
                                  {/if}
                                  {#if p.note}
                                    <span class="text-t3">{p.note}</span>
                                  {/if}
                                </li>
                              {/each}
                            </ul>
                          {/if}

                          {#if t && t.due_minor > 0}
                            <button
                              class="btn btn-primary mt-2 h-7"
                              onclick={() => openPay(invoice)}
                            >
                              <Icon name="plus" size={12} />
                              Record payment
                            </button>
                          {:else if t}
                            <p class="mt-2 flex items-center gap-1.5 text-[11.5px] text-success">
                              <Icon name="check-circle" size={12} />
                              Paid in full.
                            </p>
                          {/if}
                        </div>
                      {/if}

                      {#if panelError}
                        <p class="flex items-center gap-1.5 text-[11.5px] text-danger">
                          <Icon name="alert-circle" size={12} />
                          {panelError}
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

<!-- record payment -->
<Dialog
  open={payTarget !== null}
  title="Record a payment — {payTarget ? invoiceRef(payTarget) : ''}"
  description="Payments are insert-only: this adds a new payment fact rather than editing a balance. Paid/unpaid is always recomputed from every payment on the invoice."
  size="sm"
  dismissible={!payBusy}
  onclose={() => (payTarget = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Amount</span>
      <input
        data-autofocus
        class="input font-mono"
        inputmode="decimal"
        bind:value={payAmount}
        disabled={payBusy}
      />
    </label>
    <div class="grid grid-cols-2 gap-3">
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Date</span>
        <input class="input" type="date" bind:value={payDate} disabled={payBusy} />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Method (optional)</span>
        <input
          class="input"
          placeholder="cash, eft, card…"
          bind:value={payMethod}
          disabled={payBusy}
        />
      </label>
    </div>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Note (optional)</span>
      <input class="input" bind:value={payNote} disabled={payBusy} />
    </label>
    {#if payError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {payError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={payBusy} onclick={() => (payTarget = null)}>
      Cancel
    </button>
    <button class="btn btn-primary" disabled={payBusy} onclick={recordPayment}>
      {payBusy ? "Recording…" : "Record payment"}
    </button>
  {/snippet}
</Dialog>

<!-- new standalone invoice -->
<Dialog
  open={showCreate}
  title="New standalone invoice"
  description={createdInvoice
    ? undefined
    : "For a bill with no sales order behind it. Once issued this is numbered and immutable, the same as one issued from an order."}
  size="lg"
  dismissible={!createBusy}
  onclose={() => (showCreate = false)}
>
  <div class="space-y-3 px-5 pb-4">
    {#if createdInvoice}
      <p
        class="flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success"
        role="status"
      >
        <Icon name="check-circle" size={13} />
        {invoiceRef(createdInvoice)} issued, due {fmtDate(
          `${createdInvoice.due_date}T12:00:00Z`,
        )}.
      </p>
    {:else}
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label class="block">
          <span class="mb-1.5 block text-[12px] text-t2">Customer</span>
          <select
            data-autofocus
            class="input"
            aria-label="Customer"
            bind:value={newContactId}
            disabled={createBusy}
          >
            <option value="">Choose…</option>
            {#each contacts as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1.5 block text-[12px] text-t2">Issue date</span>
          <input class="input" type="date" bind:value={newIssueDate} disabled={createBusy} />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-[12px] text-t2">Due date</span>
          <input class="input" type="date" bind:value={newDueDate} disabled={createBusy} />
        </label>
      </div>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Notes (optional)</span>
        <input class="input" bind:value={newNotes} disabled={createBusy} />
      </label>

      <!-- overflow-x-auto, not overflow-hidden: `.dialog-panel` itself clips
           (app.css), so a wide table left unwrapped here is not merely
           off-screen but genuinely unreachable at a narrow dialog width —
           this scrolls inside itself instead, the same contract
           `.table-wrap` states for the full-width screen tables. -->
      <div class="overflow-x-auto rounded-lg border border-line">
        <table class="w-full min-w-[34rem] text-[12px]">
          <thead>
            <tr class="border-b border-line bg-sunken/60">
              <th class="th">Variant</th>
              <th class="th">Description</th>
              <th class="th w-16">Qty</th>
              <th class="th w-24">Price</th>
              <th class="th w-36">Tax</th>
              <th class="th w-9"></th>
            </tr>
          </thead>
          <tbody>
            {#each draftLines as line (line.key)}
              <tr class="border-b border-line last:border-b-0">
                <td class="td">
                  <select
                    class="input h-7 w-40 text-[12px]"
                    aria-label="Variant"
                    value={line.variantId}
                    onchange={(e) => pickDraftVariant(line, e.currentTarget.value)}
                    disabled={createBusy}
                  >
                    <option value="">Free text</option>
                    {#each variants as v (v.id)}
                      <option value={v.id}>{v.name} · {v.sku}</option>
                    {/each}
                  </select>
                </td>
                <td class="td">
                  <input
                    class="input h-7 w-full text-[12px]"
                    aria-label="Description"
                    bind:value={line.description}
                    disabled={!!line.variantId || createBusy}
                  />
                </td>
                <td class="td">
                  <input
                    class="input h-7 w-16 text-[12px]"
                    type="number"
                    min="0.01"
                    step="1"
                    aria-label="Quantity"
                    bind:value={line.quantity}
                    disabled={createBusy}
                  />
                </td>
                <td class="td">
                  <input
                    class="input h-7 w-20 text-[12px]"
                    aria-label="Unit price"
                    bind:value={line.price}
                    disabled={createBusy}
                  />
                </td>
                <td class="td">
                  {#if vatRates.length > 0}
                    <select
                      class="input h-7 w-full text-[12px]"
                      aria-label="Tax rate"
                      bind:value={line.taxBps}
                      disabled={createBusy}
                    >
                      {#each vatRates as r (r.id)}
                        <option value={r.rate_bps}>{r.name}</option>
                      {/each}
                    </select>
                  {:else}
                    <input
                      class="input h-7 w-20 text-[12px]"
                      type="number"
                      min="0"
                      max="10000"
                      aria-label="Tax rate in basis points"
                      bind:value={line.taxBps}
                      disabled={createBusy}
                    />
                  {/if}
                </td>
                <td class="td">
                  <button
                    type="button"
                    class="btn btn-ghost h-7 w-7 px-0"
                    aria-label="Remove line"
                    disabled={draftLines.length === 1 || createBusy}
                    onclick={() => removeDraftLine(line.key)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <button class="btn h-7" type="button" onclick={addDraftLine} disabled={createBusy}>
        <Icon name="plus" size={12} />
        Add line
      </button>

      {#if createError}
        <p
          class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
          {createError}
        </p>
      {/if}
    {/if}
  </div>
  {#snippet footer()}
    {#if createdInvoice}
      <button class="btn btn-primary" onclick={() => (showCreate = false)}>Done</button>
    {:else}
      <button class="btn" disabled={createBusy} onclick={() => (showCreate = false)}>
        Cancel
      </button>
      <button class="btn btn-primary" disabled={createBusy} onclick={submitCreate}>
        {createBusy ? "Issuing…" : "Issue invoice"}
      </button>
    {/if}
  {/snippet}
</Dialog>
