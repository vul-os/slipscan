<script lang="ts">
  /**
   * Sales › Orders — the editable draft side of the workflow.
   *
   * Status only ever moves forward: draft -> confirmed -> paid, or draft/
   * confirmed -> cancelled. Every guard below mirrors the service layer
   * exactly (see mock.ts `requireDraft`) rather than re-deriving it, so a
   * control disables for the same reason the API would refuse it:
   *   - lines can be added, edited or removed only while draft.
   *   - confirming needs at least one line, and a location if any line is
   *     stock-tracked (`variant_id` set) — confirming deducts stock and
   *     posts revenue/VAT/COGS in the same transaction.
   *   - cancelling is refused only once an order is already cancelled or
   *     paid; a confirmed order's cancel writes compensating stock
   *     movements and reverses its journals rather than erasing anything.
   *   - only a confirmed order can be marked paid, and only a draft can be
   *     deleted outright (a confirmed one has already moved stock, so it is
   *     cancelled, never deleted).
   *
   * Issuing an invoice copies a confirmed/paid order's lines as they stand;
   * nothing here stops a second invoice being issued from the same order
   * (core does not guard that either), so the button says plainly when one
   * already exists instead of pretending the guard is there.
   *
   * Simple reload-after-write throughout, like Transactions/Budgets: this
   * screen mutates several related lists (order header, its lines, its
   * totals, the invoice index), and refetching the lot after any one write
   * is one honest source of truth rather than five places that could drift
   * from what the server actually did.
   */
  import { api } from "../../lib/api/client";
  import {
    fmtDate,
    localDate,
    minorToInput,
    parseMoneyInput,
  } from "../../lib/format";
  import type {
    Book,
    Contact,
    Invoice,
    Location,
    ProductVariant,
    SalesOrder,
    SalesOrderItem,
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

  let { book, onissued }: { book: Book; onissued?: () => void } = $props();

  const statusTone: Record<
    SalesOrder["status"],
    "neutral" | "accent" | "success" | "danger"
  > = {
    draft: "neutral",
    confirmed: "accent",
    paid: "success",
    cancelled: "danger",
  };

  let contacts = $state<Contact[]>([]);
  let variants = $state<ProductVariant[]>([]);
  let locations = $state<Location[]>([]);
  let vatRates = $state<VatRate[]>([]);
  let orders = $state<SalesOrder[]>([]);
  let invoices = $state<Invoice[]>([]);
  let totals = $state<Map<string, SalesOrderTotals>>(new Map());
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const [c, v, l, vr, o, inv] = await Promise.all([
        api.contactListCustomers({ book_id: book.id }),
        api.productVariantListForBook({ book_id: book.id }),
        api.locationList({ book_id: book.id }),
        api.vatRateList({ book_id: book.id }),
        api.salesOrderList({ book_id: book.id }),
        api.invoiceList({ book_id: book.id }),
      ]);
      const totalsEntries = await Promise.all(
        o.map(
          async (order) =>
            [order.id, await api.salesOrderTotals({ id: order.id })] as const,
        ),
      );
      contacts = c;
      variants = v;
      locations = l;
      vatRates = vr;
      orders = o;
      invoices = inv;
      totals = new Map(totalsEntries);
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      if (!background) loading = false;
    }
  }
  load();

  function contactName(id: string): string {
    return contacts.find((c) => c.id === id)?.name ?? "Unknown contact";
  }
  function locationName(id: string | null): string {
    if (!id) return "—";
    return locations.find((l) => l.id === id)?.name ?? "Unknown location";
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
  function invoiceForOrder(orderId: string): Invoice | null {
    return invoices.find((v) => v.sales_order_id === orderId) ?? null;
  }
  function lineTotal(item: SalesOrderItem): number {
    const net = item.quantity * item.unit_price_minor;
    return net + Math.round((net * item.tax_rate_bps) / 10_000);
  }
  const plural = (n: number, one: string, many: string) =>
    n === 1 ? one : many;

  // -- create order -----------------------------------------------------

  let showCreate = $state(false);
  let newContactId = $state("");
  let newOrderDate = $state(localDate());
  let newLocationId = $state("");
  let newNotes = $state("");
  let createBusy = $state(false);
  let createError = $state<string | null>(null);

  function openCreate() {
    newContactId = "";
    newOrderDate = localDate();
    newLocationId = "";
    newNotes = "";
    createError = null;
    showCreate = true;
  }

  async function createOrder() {
    if (!newContactId) return;
    createBusy = true;
    createError = null;
    try {
      const order = await api.salesOrderCreate({
        book_id: book.id,
        contact_id: newContactId,
        order_date: newOrderDate,
        location_id: newLocationId || null,
        notes: newNotes.trim() || undefined,
      });
      showCreate = false;
      await load(true);
      expanded = order.id;
      resetLineForm();
      await loadItems(order.id);
    } catch (err) {
      createError = String(err);
    } finally {
      createBusy = false;
    }
  }

  // -- row expansion + editing (draft only) ------------------------------

  let expanded = $state<string | null>(null);
  let items = $state<SalesOrderItem[]>([]);
  let itemsLoading = $state(false);
  let itemsError = $state<string | null>(null);

  async function toggleExpand(order: SalesOrder) {
    if (expanded === order.id) {
      expanded = null;
      return;
    }
    expanded = order.id;
    resetLineForm();
    await loadItems(order.id);
  }

  async function loadItems(orderId: string) {
    itemsLoading = true;
    itemsError = null;
    try {
      items = await api.salesOrderItemsList({ sales_order_id: orderId });
    } catch (err) {
      itemsError = String(err);
    } finally {
      itemsLoading = false;
    }
  }

  async function refreshLines(order: SalesOrder) {
    await loadItems(order.id);
    const t = await api.salesOrderTotals({ id: order.id });
    totals = new Map(totals).set(order.id, t);
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

  async function addLine(order: SalesOrder) {
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
      // Overriding the variant's own price is allowed; leaving it blank lets
      // the server default to the variant's stored price.
      const parsed = parseMoneyInput(linePrice, book.currency);
      if (parsed === null || parsed < 0) {
        lineError = "enter a valid unit price";
        return;
      }
      priceMinor = parsed;
    }
    lineBusy = true;
    try {
      await api.salesOrderItemAdd({
        sales_order_id: order.id,
        variant_id: lineVariantId || null,
        description: lineDescription.trim() || undefined,
        quantity: qty,
        unit_price_minor: priceMinor,
        tax_rate_bps: lineTaxBps,
      });
      await refreshLines(order);
      resetLineForm();
    } catch (err) {
      lineError = String(err);
    } finally {
      lineBusy = false;
    }
  }

  async function updateLineQty(order: SalesOrder, item: SalesOrderItem, raw: string) {
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty <= 0 || qty === item.quantity) return;
    try {
      await api.salesOrderItemUpdate({ id: item.id, quantity: qty });
      await refreshLines(order);
    } catch (err) {
      itemsError = String(err);
    }
  }

  async function updateLinePrice(order: SalesOrder, item: SalesOrderItem, raw: string) {
    const parsed = parseMoneyInput(raw, book.currency);
    if (parsed === null || parsed < 0 || parsed === item.unit_price_minor) return;
    try {
      await api.salesOrderItemUpdate({ id: item.id, unit_price_minor: parsed });
      await refreshLines(order);
    } catch (err) {
      itemsError = String(err);
    }
  }

  async function updateLineTax(order: SalesOrder, item: SalesOrderItem, bps: number) {
    if (bps === item.tax_rate_bps) return;
    try {
      await api.salesOrderItemUpdate({ id: item.id, tax_rate_bps: bps });
      await refreshLines(order);
    } catch (err) {
      itemsError = String(err);
    }
  }

  async function removeLine(order: SalesOrder, item: SalesOrderItem) {
    try {
      await api.salesOrderItemRemove({ id: item.id });
      await refreshLines(order);
    } catch (err) {
      itemsError = String(err);
    }
  }

  // -- header edits (draft only): location -------------------------------

  async function updateLocation(order: SalesOrder, locationId: string) {
    try {
      await api.salesOrderUpdate({ id: order.id, location_id: locationId || null });
      await load(true);
    } catch (err) {
      itemsError = String(err);
    }
  }

  // -- status transitions --------------------------------------------------

  let confirmTarget = $state<SalesOrder | null>(null);
  let confirmBusy = $state(false);
  let confirmError = $state<string | null>(null);

  let cancelTarget = $state<SalesOrder | null>(null);
  let cancelBusy = $state(false);
  let cancelError = $state<string | null>(null);

  let deleteTarget = $state<SalesOrder | null>(null);
  let deleteBusy = $state(false);
  let deleteError = $state<string | null>(null);

  let payTarget = $state<SalesOrder | null>(null);
  let payBusy = $state(false);
  let payError = $state<string | null>(null);

  function hasStockLine(rows: SalesOrderItem[]): boolean {
    return rows.some((i) => i.variant_id !== null);
  }

  async function doConfirm() {
    const order = confirmTarget;
    if (!order) return;
    confirmBusy = true;
    confirmError = null;
    try {
      await api.salesOrderConfirm({ id: order.id });
      confirmTarget = null;
      await load(true);
    } catch (err) {
      confirmError = String(err);
    } finally {
      confirmBusy = false;
    }
  }

  async function doCancel() {
    const order = cancelTarget;
    if (!order) return;
    cancelBusy = true;
    cancelError = null;
    try {
      await api.salesOrderCancel({ id: order.id });
      cancelTarget = null;
      await load(true);
    } catch (err) {
      cancelError = String(err);
    } finally {
      cancelBusy = false;
    }
  }

  async function doDelete() {
    const order = deleteTarget;
    if (!order) return;
    deleteBusy = true;
    deleteError = null;
    try {
      await api.salesOrderDelete({ id: order.id });
      deleteTarget = null;
      if (expanded === order.id) expanded = null;
      await load(true);
    } catch (err) {
      deleteError = String(err);
    } finally {
      deleteBusy = false;
    }
  }

  async function doMarkPaid() {
    const order = payTarget;
    if (!order) return;
    payBusy = true;
    payError = null;
    try {
      await api.salesOrderMarkPaid({ id: order.id });
      payTarget = null;
      await load(true);
    } catch (err) {
      payError = String(err);
    } finally {
      payBusy = false;
    }
  }

  // -- issue invoice ---------------------------------------------------

  let issueTarget = $state<SalesOrder | null>(null);
  let issueDueDate = $state(localDate());
  let issueNotes = $state("");
  let issueBusy = $state(false);
  let issueError = $state<string | null>(null);
  let issuedInvoice = $state<Invoice | null>(null);

  function dueDefault(order: SalesOrder): string {
    const contact = contacts.find((c) => c.id === order.contact_id);
    const days = contact?.payment_terms_days ?? 30;
    const d = new Date(`${order.order_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function openIssue(order: SalesOrder) {
    issueTarget = order;
    issueDueDate = dueDefault(order);
    issueNotes = "";
    issueError = null;
    issuedInvoice = null;
  }

  async function doIssue() {
    const order = issueTarget;
    if (!order) return;
    if (issueDueDate < order.order_date) {
      issueError = "the due date cannot be before the order date";
      return;
    }
    issueBusy = true;
    issueError = null;
    try {
      const invoice = await api.invoiceIssue({
        book_id: book.id,
        sales_order_id: order.id,
        due_date: issueDueDate,
        notes: issueNotes.trim() || undefined,
      });
      issuedInvoice = invoice;
      await load(true);
    } catch (err) {
      issueError = String(err);
    } finally {
      issueBusy = false;
    }
  }

  function closeIssue() {
    issueTarget = null;
    issuedInvoice = null;
  }
</script>

<div class="mb-3 flex items-center justify-between gap-2">
  <p class="text-[12px] text-t3">
    {orders.length}
    {plural(orders.length, "order", "orders")}
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
    New order
  </button>
</div>

{#if !loading && contacts.length === 0}
  <p
    class="mb-3 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-t2"
  >
    <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
    This book has no customer contact yet, so an order has nobody to bill.
    Contacts are reachable today through <code class="num">contact_add</code>
    on the CLI or HTTP API — the Contacts screen is not wired up on the
    desktop yet.
  </p>
{/if}

<div class="card overflow-hidden">
  {#if loading}
    <Skeleton rows={6} />
  {:else if loadError}
    <EmptyState icon="alert-circle" title="Could not load orders" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if orders.length === 0}
    <EmptyState
      icon="cart"
      title="No sales orders yet"
      body="Draft an order for a customer, add lines, then confirm it — confirming deducts stock for every stock-tracked line and posts revenue, VAT and cost of goods to the ledger, in the same transaction."
    >
      {#snippet actions()}
        <button
          class="btn btn-primary"
          onclick={openCreate}
          disabled={contacts.length === 0}
        >
          <Icon name="plus" size={14} />
          New order
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
          {#each orders as order (order.id)}
            {@const open = expanded === order.id}
            {@const orderTotals = totals.get(order.id)}
            {@const existingInvoice = invoiceForOrder(order.id)}
            <tr class="row-hover">
              <td class="td">
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 text-left font-medium"
                  aria-expanded={open}
                  aria-controls="so-panel-{order.id}"
                  onclick={() => toggleExpand(order)}
                >
                  <Icon
                    name="chevron-down"
                    size={12}
                    class="shrink-0 text-t3 {open ? '' : '-rotate-90'}"
                  />
                  <span class="num">#{order.number}</span>
                </button>
              </td>
              <td class="td num whitespace-nowrap text-t2">
                {fmtDate(`${order.order_date}T12:00:00Z`)}
              </td>
              <td class="td max-w-0">
                <span class="block truncate">{contactName(order.contact_id)}</span>
              </td>
              <td class="td">
                <Badge tone={statusTone[order.status]} label={order.status} />
              </td>
              <td class="td text-right">
                {#if orderTotals}
                  <Money amount={orderTotals.total_minor} currency={order.currency} />
                {:else}
                  —
                {/if}
              </td>
            </tr>
            {#if open}
              <tr>
                <td class="td bg-sunken/40 p-0" id="so-panel-{order.id}" colspan={5}>
                  <div class="reveal">
                    <div class="reveal-inner space-y-3 px-3 py-3">
                      <!-- header: location, editable while draft -->
                      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px]">
                        <label class="flex items-center gap-1.5">
                          <span class="text-t3">Location</span>
                          {#if order.status === "draft"}
                            <select
                              class="input h-7 w-44 text-[12px]"
                              aria-label="Location for order #{order.number}"
                              value={order.location_id ?? ""}
                              onchange={(e) =>
                                updateLocation(order, e.currentTarget.value)}
                            >
                              <option value="">No location</option>
                              {#each locations as loc (loc.id)}
                                <option value={loc.id}>{loc.name}</option>
                              {/each}
                            </select>
                          {:else}
                            <span class="text-t2">{locationName(order.location_id)}</span>
                          {/if}
                        </label>
                        {#if order.notes}
                          <span class="text-t3">·</span>
                          <span class="text-t2">{order.notes}</span>
                        {/if}
                        {#if existingInvoice}
                          <span class="text-t3">·</span>
                          <span class="flex items-center gap-1 text-t2">
                            <Icon name="receipt" size={12} class="text-t3" />
                            Invoice #{existingInvoice.number} already issued
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
                                {#if order.status === "draft"}
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
                                        <span class="ml-1 text-[10.5px] text-t3"
                                          >stock-tracked</span
                                        >
                                      {/if}
                                    </span>
                                  </td>
                                  <td class="td">
                                    {#if order.status === "draft"}
                                      <input
                                        class="input h-7 w-16 text-[12px]"
                                        type="number"
                                        min="0.01"
                                        step="1"
                                        aria-label="Quantity for {item.description}"
                                        value={item.quantity}
                                        onchange={(e) =>
                                          updateLineQty(order, item, e.currentTarget.value)}
                                      />
                                    {:else}
                                      <span class="num">{item.quantity}</span>
                                    {/if}
                                  </td>
                                  <td class="td">
                                    {#if order.status === "draft"}
                                      <input
                                        class="input h-7 w-24 text-[12px]"
                                        aria-label="Unit price for {item.description}"
                                        value={minorToInput(
                                          item.unit_price_minor,
                                          order.currency,
                                        )}
                                        onchange={(e) =>
                                          updateLinePrice(order, item, e.currentTarget.value)}
                                      />
                                    {:else}
                                      <Money
                                        amount={item.unit_price_minor}
                                        currency={order.currency}
                                      />
                                    {/if}
                                  </td>
                                  <td class="td">
                                    {#if order.status === "draft" && vatRates.length > 0}
                                      <select
                                        class="input h-7 w-full text-[12px]"
                                        aria-label="Tax rate for {item.description}"
                                        value={item.tax_rate_bps}
                                        onchange={(e) =>
                                          updateLineTax(
                                            order,
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
                                    <Money amount={lineTotal(item)} currency={order.currency} />
                                  </td>
                                  {#if order.status === "draft"}
                                    <td class="td">
                                      <button
                                        type="button"
                                        class="btn btn-ghost h-7 w-7 px-0"
                                        aria-label="Remove {item.description}"
                                        onclick={() => removeLine(order, item)}
                                      >
                                        <Icon name="trash" size={13} />
                                      </button>
                                    </td>
                                  {/if}
                                </tr>
                              {:else}
                                <tr>
                                  <td class="td text-t3" colspan={order.status === "draft" ? 6 : 5}>
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
                      {#if order.status === "draft"}
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
                              placeholder={lineVariantId ? undefined : "What is being sold"}
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
                            onclick={() => addLine(order)}
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
                      {#if orderTotals}
                        <div
                          class="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[12px]"
                        >
                          <span class="text-t3"
                            >Subtotal <Money
                              amount={orderTotals.subtotal_minor}
                              currency={order.currency}
                            /></span
                          >
                          <span class="text-t3"
                            >Tax <Money
                              amount={orderTotals.tax_minor}
                              currency={order.currency}
                            /></span
                          >
                          <span class="font-semibold"
                            >Total <Money
                              amount={orderTotals.total_minor}
                              currency={order.currency}
                            /></span
                          >
                        </div>
                      {/if}

                      <!-- status actions -->
                      <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                        {#if order.status === "draft"}
                          {@const stockLine = hasStockLine(items)}
                          {@const needsLocation = stockLine && !order.location_id}
                          <button
                            class="btn btn-primary h-7"
                            disabled={items.length === 0 || needsLocation}
                            title={items.length === 0
                              ? "Add at least one line first"
                              : needsLocation
                                ? "This order has a stock-tracked line — pick a location above before confirming"
                                : undefined}
                            onclick={() => {
                              confirmError = null;
                              confirmTarget = order;
                            }}
                          >
                            <Icon name="check" size={13} />
                            Confirm order
                          </button>
                          <button
                            class="btn h-7"
                            onclick={() => {
                              cancelError = null;
                              cancelTarget = order;
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            class="btn btn-ghost h-7 text-danger"
                            onclick={() => {
                              deleteError = null;
                              deleteTarget = order;
                            }}
                          >
                            <Icon name="trash" size={12} />
                            Delete draft
                          </button>
                        {:else if order.status === "confirmed"}
                          <button
                            class="btn h-7"
                            onclick={() => {
                              payError = null;
                              payTarget = order;
                            }}
                          >
                            Mark paid
                          </button>
                          <button
                            class="btn h-7"
                            onclick={() => {
                              cancelError = null;
                              cancelTarget = order;
                            }}
                          >
                            Cancel order
                          </button>
                          <button class="btn btn-primary h-7" onclick={() => openIssue(order)}>
                            <Icon name="receipt" size={13} />
                            {existingInvoice ? "Issue another invoice" : "Issue invoice"}
                          </button>
                        {:else if order.status === "paid"}
                          <button class="btn btn-primary h-7" onclick={() => openIssue(order)}>
                            <Icon name="receipt" size={13} />
                            {existingInvoice ? "Issue another invoice" : "Issue invoice"}
                          </button>
                        {:else}
                          <span class="flex items-center gap-1.5 text-[11.5px] text-t3">
                            <Icon name="alert-circle" size={12} />
                            Cancelled {order.cancelled_at ? fmtDate(order.cancelled_at) : ""} — no
                            further action.
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

<!-- new order -->
<Dialog
  open={showCreate}
  title="New sales order"
  description="Starts as a draft. Add lines after creating it, then confirm when it is ready — confirming is the moment stock moves and revenue posts."
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
        <span class="mb-1.5 block text-[12px] text-t2">Order date</span>
        <input class="input" type="date" bind:value={newOrderDate} disabled={createBusy} />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">
          Location <span class="text-t3">(needed for stock-tracked lines)</span>
        </span>
        <select class="input" bind:value={newLocationId} disabled={createBusy}>
          <option value="">No location</option>
          {#each locations as loc (loc.id)}
            <option value={loc.id}>{loc.name}</option>
          {/each}
        </select>
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
    <button class="btn btn-primary" disabled={createBusy || !newContactId} onclick={createOrder}>
      {createBusy ? "Creating…" : "Create draft"}
    </button>
  {/snippet}
</Dialog>

<!-- confirm order -->
<ConfirmDialog
  open={confirmTarget !== null}
  title="Confirm order #{confirmTarget?.number ?? ''}?"
  body="This deducts stock for every stock-tracked line and posts revenue, VAT and cost of goods to the ledger, in one transaction. Lines can no longer be edited afterwards — a mistake is corrected by cancelling, which reverses the movements and journals rather than erasing them."
  confirmLabel="Confirm order"
  busy={confirmBusy}
  error={confirmError}
  onconfirm={doConfirm}
  oncancel={() => (confirmTarget = null)}
/>

<!-- cancel order -->
<ConfirmDialog
  open={cancelTarget !== null}
  title="Cancel order #{cancelTarget?.number ?? ''}?"
  body={cancelTarget?.status === "confirmed"
    ? "This order already moved stock and posted to the ledger. Cancelling writes compensating stock movements and reverses its journals — nothing is erased, but this cannot be undone from here."
    : "This draft never moved stock or posted anything, so there is nothing to reverse. It stays on record as cancelled rather than being removed."}
  confirmLabel="Cancel order"
  tone="danger"
  busy={cancelBusy}
  error={cancelError}
  onconfirm={doCancel}
  oncancel={() => (cancelTarget = null)}
/>

<!-- delete draft -->
<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete draft order #{deleteTarget?.number ?? ''}?"
  body="A draft that never confirmed moved nothing, so deleting it removes the order and its lines outright — there is nothing to reverse. Its order number is not reused."
  confirmLabel="Delete draft"
  tone="danger"
  busy={deleteBusy}
  error={deleteError}
  onconfirm={doDelete}
  oncancel={() => (deleteTarget = null)}
/>

<!-- mark paid -->
<ConfirmDialog
  open={payTarget !== null}
  title="Mark order #{payTarget?.number ?? ''} as paid?"
  body="Records that this order was settled outside of an invoice (cash, EFT on the spot). There is no way back to confirmed from here. Invoice payments are tracked separately, on the invoice itself."
  confirmLabel="Mark paid"
  busy={payBusy}
  error={payError}
  onconfirm={doMarkPaid}
  oncancel={() => (payTarget = null)}
/>

<!-- issue invoice -->
<Dialog
  open={issueTarget !== null}
  title="Issue invoice for order #{issueTarget?.number ?? ''}"
  description={issuedInvoice
    ? undefined
    : "Copies this order's lines exactly as they stand. Once issued the invoice is numbered and immutable — a correction is a credit note, which is not built yet."}
  size="sm"
  dismissible={!issueBusy}
  onclose={closeIssue}
>
  <div class="space-y-3 px-5 pb-4">
    {#if issuedInvoice}
      <p
        class="flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success"
        role="status"
      >
        <Icon name="check-circle" size={13} />
        Invoice #{issuedInvoice.number} issued, due {fmtDate(
          `${issuedInvoice.due_date}T12:00:00Z`,
        )}.
      </p>
    {:else}
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Due date</span>
        <input
          data-autofocus
          class="input"
          type="date"
          bind:value={issueDueDate}
          disabled={issueBusy}
        />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Notes (optional)</span>
        <textarea class="input" rows="2" bind:value={issueNotes} disabled={issueBusy}
        ></textarea>
      </label>
      {#if issueError}
        <p
          class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
          {issueError}
        </p>
      {/if}
    {/if}
  </div>
  {#snippet footer()}
    {#if issuedInvoice}
      <button
        class="btn btn-primary"
        onclick={() => {
          closeIssue();
          onissued?.();
        }}
      >
        View in Invoices
      </button>
    {:else}
      <button class="btn" disabled={issueBusy} onclick={closeIssue}>Cancel</button>
      <button class="btn btn-primary" disabled={issueBusy} onclick={doIssue}>
        {issueBusy ? "Issuing…" : "Issue invoice"}
      </button>
    {/if}
  {/snippet}
</Dialog>
