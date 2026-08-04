<script lang="ts">
  /**
   * Purchasing — purchase orders and the goods receipts against them
   * (ROADMAP.md 6.4, screen 6.9).
   *
   * The keystone fact this screen exists to surface: `poReceive` writes the
   * stock movement and the receipt fact in the **same transaction**, so
   * on-hand (Stock) and receiving progress here can never disagree about how
   * much arrived. Receiving progress itself — none / partial / complete — is
   * `SUM(qty)` over `po_receipts` every time, never a stored counter; the
   * badge on every line comes straight from `poItemsWithReceiving`, the call
   * this screen was told is the one a purchasing screen actually wants
   * rather than three separate round trips per line.
   *
   * Three server refusals are surfaced verbatim rather than re-worded,
   * because core and the mock already say them in plain English: a line's
   * ordered quantity cannot drop below what has already been received, a
   * cancelled order refuses further line edits, and ordering from a
   * customer-only contact is refused (closed off here anyway by only
   * offering `contactListSuppliers` in the picker).
   *
   * Two hard prerequisites, both real and both handled inline rather than
   * pointed at screens that do not exist yet: `location_id` is required on
   * every purchase order, and `supplier_id` must name a contact with the
   * supplier role. Neither has a CRUD screen of its own in this build, so a
   * minimal, honest quick-add lives here for each — not a stand-in for
   * Locations/Contacts screens, just enough to not be a dead end.
   *
   * **Not built, named rather than implied:** editing a purchase order's own
   * header (supplier, location, dates, notes) after creation — `poUpdate`
   * exists and is wired in `client.ts` but this screen does not call it, so
   * a mistyped PO number or a wrong order date has no fix here yet, only in
   * the line items and status.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/router.svelte";
  import { routeCache } from "../lib/loadCache";
  import { fmtDate, localDate, minorToInput, parseMoneyInput } from "../lib/format";
  import type {
    Book,
    BookProfile,
    Contact,
    Location,
    LocationKind,
    PoReceipt,
    PoReceiptStatus,
    ProductVariant,
    PurchaseOrder,
    PurchaseOrderItem,
    PurchaseOrderItemReceiving,
    PurchaseOrderStatus,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import Dialog from "../lib/components/Dialog.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

  let book = $state<Book | null>(null);
  let profile = $state<BookProfile | null>(null);
  let locations = $state<Location[]>([]);
  let suppliers = $state<Contact[]>([]);
  let variants = $state<ProductVariant[]>([]);
  let pos = $state<PurchaseOrder[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  interface Snapshot {
    book: Book;
    profile: BookProfile;
    locations: Location[];
    suppliers: Contact[];
    variants: ProductVariant[];
    pos: PurchaseOrder[];
  }

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const b = requireBook(await api.bookList());
      const p = await api.bookProfile({ book_id: b.id });
      let locs: Location[] = [];
      let sups: Contact[] = [];
      let vars: ProductVariant[] = [];
      let list: PurchaseOrder[] = [];
      if (p.show_purchasing) {
        [locs, sups, vars, list] = await Promise.all([
          api.locationList({ book_id: b.id }),
          api.contactListSuppliers({ book_id: b.id }),
          api.productVariantListForBook({ book_id: b.id }),
          api.poList({ book_id: b.id }),
        ]);
      }
      book = b;
      profile = p;
      locations = locs;
      suppliers = sups;
      variants = vars;
      pos = list;
      routeCache.set<Snapshot>("purchasing", {
        book: b,
        profile: p,
        locations: locs,
        suppliers: sups,
        variants: vars,
        pos: list,
      });
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  {
    const cached = routeCache.get<Snapshot>("purchasing");
    if (cached) {
      book = cached.book;
      profile = cached.profile;
      locations = cached.locations;
      suppliers = cached.suppliers;
      variants = cached.variants;
      pos = cached.pos;
      loading = false;
      load(true);
    } else {
      load();
    }
  }

  function syncCache() {
    const cached = routeCache.get<Snapshot>("purchasing");
    if (!cached) return;
    routeCache.set<Snapshot>("purchasing", {
      ...cached,
      locations: $state.snapshot(locations) as Location[],
      suppliers: $state.snapshot(suppliers) as Contact[],
      pos: $state.snapshot(pos) as PurchaseOrder[],
    });
  }

  const locationName = (id: string): string =>
    locations.find((l) => l.id === id)?.name ?? "(removed location)";
  const supplierName = (id: string): string =>
    suppliers.find((s) => s.id === id)?.name ?? "(supplier)";
  const variantLabel = (id: string): string => {
    const v = variants.find((x) => x.id === id);
    return v ? `${v.name} · ${v.sku}` : "(removed variant)";
  };

  const draftCount = $derived(pos.filter((p) => p.status === "draft").length);
  const orderedCount = $derived(pos.filter((p) => p.status === "ordered").length);
  const cancelledCount = $derived(pos.filter((p) => p.status === "cancelled").length);

  const statusTone: Record<PurchaseOrderStatus, "neutral" | "accent" | "danger"> = {
    draft: "neutral",
    ordered: "accent",
    cancelled: "danger",
  };
  const receivingTone: Record<PoReceiptStatus, "neutral" | "warning" | "success"> = {
    none: "neutral",
    partial: "warning",
    complete: "success",
  };

  // -------------------------------------------------------------------------
  // add the first location / supplier — hard prerequisites for any order.
  // -------------------------------------------------------------------------

  let locName = $state("");
  let locKind = $state<LocationKind>("branch");
  let locBusy = $state(false);
  let locError = $state<string | null>(null);
  const locationKinds: Array<{ id: LocationKind; label: string }> = [
    { id: "branch", label: "Branch" },
    { id: "warehouse", label: "Warehouse" },
    { id: "site", label: "Site" },
  ];

  async function addLocation() {
    if (!book || !locName.trim()) return;
    locBusy = true;
    locError = null;
    try {
      const created = await api.locationCreate({
        book_id: book.id,
        name: locName.trim(),
        kind: locKind,
      });
      locations = [...locations, created];
      syncCache();
      locName = "";
    } catch (err) {
      locError = String(err);
    } finally {
      locBusy = false;
    }
  }

  let supName = $state("");
  let supBusy = $state(false);
  let supError = $state<string | null>(null);

  async function addSupplier() {
    if (!book || !supName.trim()) return;
    supBusy = true;
    supError = null;
    try {
      const created = await api.contactAdd({
        book_id: book.id,
        role: "supplier",
        name: supName.trim(),
      });
      suppliers = [...suppliers, created];
      syncCache();
      supName = "";
    } catch (err) {
      supError = String(err);
    } finally {
      supBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // create a purchase order
  // -------------------------------------------------------------------------

  let showCreate = $state(false);
  let poNumber = $state("");
  let poSupplierId = $state("");
  let poLocationId = $state("");
  let poOrderDate = $state(localDate());
  let poExpected = $state("");
  let poCurrency = $state("");
  let poTax = $state("");
  let poNotes = $state("");
  let createBusy = $state(false);
  let createError = $state<string | null>(null);

  function suggestPoNumber(): string {
    const d = localDate().replaceAll("-", "");
    return `PO-${d}-${String(pos.length + 1).padStart(3, "0")}`;
  }

  function openCreate() {
    showCreate = true;
    poNumber = suggestPoNumber();
    poSupplierId = suppliers[0]?.id ?? "";
    poLocationId = locations[0]?.id ?? "";
    poOrderDate = localDate();
    poExpected = "";
    poCurrency = book?.currency ?? "";
    poTax = "";
    poNotes = "";
    createError = null;
  }

  async function commitCreate() {
    if (!book) return;
    createError = null;
    if (!poSupplierId) {
      createError = "choose a supplier";
      return;
    }
    if (!poLocationId) {
      createError = "choose a location";
      return;
    }
    if (!poNumber.trim()) {
      createError = "enter a PO number";
      return;
    }
    const currency = (poCurrency.trim() || book.currency).toUpperCase();
    let taxMinor: number | undefined;
    if (poTax.trim()) {
      const parsed = parseMoneyInput(poTax, currency);
      if (parsed === null || parsed < 0) {
        createError = "enter a valid, non-negative tax amount";
        return;
      }
      taxMinor = parsed;
    }
    createBusy = true;
    try {
      const created = await api.poCreate({
        book_id: book.id,
        supplier_id: poSupplierId,
        location_id: poLocationId,
        po_number: poNumber.trim(),
        order_date: poOrderDate,
        expected_delivery: poExpected || undefined,
        currency,
        tax_minor: taxMinor,
        notes: poNotes.trim() || undefined,
      });
      pos = [created, ...pos];
      syncCache();
      showCreate = false;
      openExpand(created);
    } catch (err) {
      createError = String(err);
    } finally {
      createBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // expand a PO: lines paired with derived receiving progress, plus the
  // order's own derived overall status.
  // -------------------------------------------------------------------------

  let expandedId = $state<string | null>(null);
  let detailItems = $state<Record<string, PurchaseOrderItemReceiving[]>>({});
  let detailStatus = $state<Record<string, PoReceiptStatus>>({});
  let detailLoading = $state<string | null>(null);
  let detailError = $state<string | null>(null);

  let addLineVariantId = $state("");
  let addLineQty = $state("");
  let addLinePrice = $state("");
  let addLineBusy = $state(false);
  let addLineError = $state<string | null>(null);

  async function loadDetail(poId: string) {
    detailLoading = poId;
    detailError = null;
    try {
      const [items, status] = await Promise.all([
        api.poItemsWithReceiving({ purchase_order_id: poId }),
        api.poReceivingStatus({ purchase_order_id: poId }),
      ]);
      detailItems = { ...detailItems, [poId]: items };
      detailStatus = { ...detailStatus, [poId]: status };
    } catch (err) {
      detailError = String(err);
    } finally {
      detailLoading = null;
    }
  }

  function openExpand(po: PurchaseOrder) {
    expandedId = po.id;
    addLineVariantId = variants[0]?.id ?? "";
    addLineQty = "";
    addLinePrice = "";
    addLineError = null;
    if (!(po.id in detailItems)) void loadDetail(po.id);
  }

  function toggleExpand(po: PurchaseOrder) {
    if (expandedId === po.id) {
      expandedId = null;
      return;
    }
    openExpand(po);
  }

  /** After any line/receipt mutation: re-derive both the lines and the PO's
   * own totals — `qty_ordered`/`total_minor` on the order row can change
   * from underneath a line edit. */
  async function refreshDetail(poId: string) {
    const [updated] = await Promise.all([
      api.poGet({ po_id: poId }),
      loadDetail(poId),
    ]);
    pos = pos.map((p) => (p.id === updated.id ? updated : p));
    syncCache();
  }

  async function commitAddLine(po: PurchaseOrder) {
    addLineError = null;
    if (!addLineVariantId) {
      addLineError = "choose a product";
      return;
    }
    const qty = Number(addLineQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      addLineError = "enter a positive whole quantity";
      return;
    }
    let unitPriceMinor: number | undefined;
    if (addLinePrice.trim()) {
      const parsed = parseMoneyInput(addLinePrice, po.currency);
      if (parsed === null || parsed < 0) {
        addLineError = "enter a valid, non-negative unit price";
        return;
      }
      unitPriceMinor = parsed;
    }
    addLineBusy = true;
    try {
      await api.poItemAdd({
        purchase_order_id: po.id,
        variant_id: addLineVariantId,
        qty_ordered: qty,
        unit_price_minor: unitPriceMinor,
      });
      await refreshDetail(po.id);
      addLineQty = "";
      addLinePrice = "";
    } catch (err) {
      addLineError = String(err);
    } finally {
      addLineBusy = false;
    }
  }

  // -- edit a line --

  let editItem = $state<PurchaseOrderItem | null>(null);
  let editPoId = $state("");
  let editQty = $state("");
  let editPrice = $state("");
  let editBusy = $state(false);
  let editError = $state<string | null>(null);

  function openEditItem(item: PurchaseOrderItem, po: PurchaseOrder) {
    editItem = item;
    editPoId = po.id;
    editQty = String(item.qty_ordered);
    editPrice = minorToInput(item.unit_price_minor, po.currency);
    editError = null;
  }

  async function commitEditItem() {
    if (!editItem) return;
    const po = pos.find((p) => p.id === editPoId);
    if (!po) return;
    editError = null;
    const qty = Number(editQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      editError = "enter a positive whole quantity";
      return;
    }
    const parsedPrice = parseMoneyInput(editPrice, po.currency);
    if (parsedPrice === null || parsedPrice < 0) {
      editError = "enter a valid, non-negative unit price";
      return;
    }
    editBusy = true;
    try {
      await api.poItemUpdate({
        id: editItem.id,
        qty_ordered: qty,
        unit_price_minor: parsedPrice,
      });
      await refreshDetail(po.id);
      editItem = null;
    } catch (err) {
      editError = String(err);
    } finally {
      editBusy = false;
    }
  }

  // -- receive against a line --

  let receiveTarget = $state<{ item: PurchaseOrderItemReceiving; po: PurchaseOrder } | null>(
    null,
  );
  let receiveQty = $state("");
  let receiveLocationId = $state("");
  let receiveNote = $state("");
  let receiveBy = $state("");
  let receiveBusy = $state(false);
  let receiveError = $state<string | null>(null);

  function openReceive(item: PurchaseOrderItemReceiving, po: PurchaseOrder) {
    receiveTarget = { item, po };
    receiveQty = "";
    receiveLocationId = po.location_id;
    receiveNote = "";
    receiveBy = "";
    receiveError = null;
  }

  async function commitReceive() {
    if (!receiveTarget) return;
    receiveError = null;
    const qty = Number(receiveQty);
    if (!Number.isInteger(qty) || qty === 0) {
      receiveError =
        "enter a non-zero whole quantity — negative corrects an earlier over-receipt";
      return;
    }
    if (!receiveLocationId) {
      receiveError = "choose a location";
      return;
    }
    receiveBusy = true;
    try {
      await api.poReceive({
        purchase_order_item_id: receiveTarget.item.item.id,
        location_id: receiveLocationId,
        qty,
        note: receiveNote.trim() || undefined,
        received_by: receiveBy.trim() || undefined,
      });
      await refreshDetail(receiveTarget.po.id);
      receiveTarget = null;
    } catch (err) {
      receiveError = String(err);
    } finally {
      receiveBusy = false;
    }
  }

  // -- receipt history for one line --

  let historyItem = $state<PurchaseOrderItemReceiving | null>(null);
  let historyReceipts = $state<PoReceipt[]>([]);
  let historyLoading = $state(false);
  let historyError = $state<string | null>(null);

  async function openHistory(item: PurchaseOrderItemReceiving) {
    historyItem = item;
    historyReceipts = [];
    historyError = null;
    historyLoading = true;
    try {
      historyReceipts = await api.poReceiptsForItem({ item_id: item.item.id });
      historyReceipts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    } catch (err) {
      historyError = String(err);
    } finally {
      historyLoading = false;
    }
  }

  // -------------------------------------------------------------------------
  // status transitions, delete — one shared confirm prompt.
  // -------------------------------------------------------------------------

  type Confirm =
    | { kind: "mark-ordered"; po: PurchaseOrder }
    | { kind: "cancel"; po: PurchaseOrder }
    | { kind: "delete-item"; item: PurchaseOrderItem; poId: string }
    | { kind: "delete"; po: PurchaseOrder };

  let confirm = $state<Confirm | null>(null);
  let confirmBusy = $state(false);
  let confirmError = $state<string | null>(null);

  const confirmCopy = $derived.by(() => {
    const c = confirm;
    if (!c) return null;
    if (c.kind === "mark-ordered")
      return {
        title: `Mark ${c.po.po_number} as ordered?`,
        body: "One-way: an ordered order can only move on to cancelled, never back to draft.",
        label: "Mark as ordered",
        tone: "default" as const,
      };
    if (c.kind === "cancel")
      return {
        title: `Cancel ${c.po.po_number}?`,
        body: "Permanent. No further lines can be added or edited, and nothing more can be received against it.",
        label: "Cancel order",
        tone: "danger" as const,
      };
    if (c.kind === "delete-item")
      return {
        title: `Delete this line?`,
        body: "Refused if anything has already been received against it.",
        label: "Delete line",
        tone: "danger" as const,
      };
    return {
      title: `Delete ${c.po.po_number}?`,
      body: "Refused if anything has been received against any of its lines.",
      label: "Delete order",
      tone: "danger" as const,
    };
  });

  async function runConfirm() {
    const c = confirm;
    if (!c) return;
    confirmBusy = true;
    confirmError = null;
    try {
      if (c.kind === "mark-ordered") {
        const updated = await api.poSetStatus({ po_id: c.po.id, status: "ordered" });
        pos = pos.map((p) => (p.id === updated.id ? updated : p));
      } else if (c.kind === "cancel") {
        const updated = await api.poSetStatus({ po_id: c.po.id, status: "cancelled" });
        pos = pos.map((p) => (p.id === updated.id ? updated : p));
      } else if (c.kind === "delete-item") {
        await api.poItemDelete({ item_id: c.item.id });
        await refreshDetail(c.poId);
      } else {
        await api.poDelete({ po_id: c.po.id });
        pos = pos.filter((p) => p.id !== c.po.id);
        if (expandedId === c.po.id) expandedId = null;
      }
      syncCache();
      confirm = null;
    } catch (err) {
      confirmError = String(err);
    } finally {
      confirmBusy = false;
    }
  }
</script>

<PageHeader
  eyebrow="Purchase orders · goods receipts"
  title="Purchasing"
  subtitle="A goods receipt writes the stock movement and the receipt fact in the same transaction, so on-hand and receiving progress can never disagree. Progress — none, partial, complete — is derived from the receipts every time, never stored."
>
  {#snippet actions()}
    {#if profile?.show_purchasing}
      <button
        class="btn btn-primary"
        disabled={locations.length === 0 || suppliers.length === 0}
        title={locations.length === 0
          ? "Add a location first"
          : suppliers.length === 0
            ? "Add a supplier first"
            : undefined}
        onclick={openCreate}
      >
        <Icon name="plus" size={14} />
        New purchase order
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load Purchasing" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if loading}
  <div class="card"><Skeleton rows={8} /></div>
{:else if profile && !profile.show_purchasing}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Purchasing is a business feature"
      body="“{book?.name}” is a personal book — Purchasing only applies to business books, because a purchase order buys from a supplier contact into a catalogue that a personal book does not have. Switch its kind to Business in Settings › General, then come back here."
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={() => router.go("settings")}>
          Open Settings
        </button>
      {/snippet}
    </EmptyState>
  </div>
{:else if book && profile}
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <StatCard label="Draft" value={String(draftCount)} />
    <StatCard label="Ordered" value={String(orderedCount)} tone="accent" />
    <StatCard label="Cancelled" value={String(cancelledCount)} />
    <StatCard label="Suppliers" value={String(suppliers.length)} />
  </div>

  {#if locations.length === 0 || suppliers.length === 0}
    <section class="card mt-4 space-y-4 p-4">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="alert-circle" size={15} class="text-warning" />
        Before the first order
      </h2>
      {#if locations.length === 0}
        <div>
          <p class="mb-2 text-[12px] text-t2">
            Every purchase order arrives <em>at</em> a location. This book has
            none yet.
          </p>
          {#if locError}
            <p class="mb-2 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              <Icon name="alert-circle" size={13} />
              {locError}
            </p>
          {/if}
          <form
            class="flex flex-wrap items-end gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              addLocation();
            }}
          >
            <label class="block">
              <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
              <input class="input w-48" placeholder="Main store" bind:value={locName} required />
            </label>
            <label class="block">
              <span class="mb-1 block text-[11.5px] font-medium text-t2">Kind</span>
              <select class="input w-36" bind:value={locKind}>
                {#each locationKinds as k (k.id)}
                  <option value={k.id}>{k.label}</option>
                {/each}
              </select>
            </label>
            <button class="btn btn-primary h-8" type="submit" disabled={locBusy || !locName.trim()}>
              {locBusy ? "Adding…" : "Add location"}
            </button>
          </form>
        </div>
      {/if}
      {#if suppliers.length === 0}
        <div class="border-t border-line pt-4">
          <p class="mb-2 text-[12px] text-t2">
            Every purchase order buys from a supplier contact. This book has
            none yet — this adds a minimal one; the full Contacts screen
            covers everything else about it.
          </p>
          {#if supError}
            <p class="mb-2 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              <Icon name="alert-circle" size={13} />
              {supError}
            </p>
          {/if}
          <form
            class="flex flex-wrap items-end gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              addSupplier();
            }}
          >
            <label class="block">
              <span class="mb-1 block text-[11.5px] font-medium text-t2">Supplier name</span>
              <input class="input w-56" placeholder="Acme Wholesale" bind:value={supName} required />
            </label>
            <button class="btn btn-primary h-8" type="submit" disabled={supBusy || !supName.trim()}>
              {supBusy ? "Adding…" : "Add supplier"}
            </button>
          </form>
        </div>
      {/if}
    </section>
  {/if}

  <div class="card mt-4 overflow-hidden">
    {#if pos.length === 0}
      <EmptyState
        icon="alert-circle"
        title="No purchase orders yet"
        body={locations.length === 0 || suppliers.length === 0
          ? "Add a location and a supplier above, then create the first order."
          : "Create an order, add lines against your catalogue, and receive stock against it as it arrives."}
      >
        {#snippet actions()}
          {#if locations.length > 0 && suppliers.length > 0}
            <button class="btn btn-primary" onclick={openCreate}>
              <Icon name="plus" size={13} />
              New purchase order
            </button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table-wrap">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr>
              <th class="th w-9"></th>
              <th class="th">PO number</th>
              <th class="th">Supplier</th>
              <th class="th">Location</th>
              <th class="th w-28">Order date</th>
              <th class="th w-24">Status</th>
              <th class="th w-28 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {#each pos as po (po.id)}
              {@const open = expandedId === po.id}
              {@const items = detailItems[po.id] ?? []}
              <tr class="row-hover">
                <td class="td">
                  <button
                    type="button"
                    class="flex size-6 items-center justify-center rounded text-t3 hover:text-t1"
                    aria-expanded={open}
                    aria-controls="po-panel-{po.id}"
                    aria-label="{open ? 'Collapse' : 'Expand'} {po.po_number}"
                    onclick={() => toggleExpand(po)}
                  >
                    <Icon name="chevron-down" size={13} class={open ? "" : "-rotate-90"} />
                  </button>
                </td>
                <td class="td">
                  <button
                    type="button"
                    class="font-mono font-medium hover:underline"
                    onclick={() => toggleExpand(po)}
                  >
                    {po.po_number}
                  </button>
                </td>
                <td class="td max-w-0 truncate text-t2">{supplierName(po.supplier_id)}</td>
                <td class="td max-w-0 truncate text-t2">{locationName(po.location_id)}</td>
                <td class="td num whitespace-nowrap text-t2">{fmtDate(po.order_date)}</td>
                <td class="td"><Badge tone={statusTone[po.status]} label={po.status} /></td>
                <td class="td text-right">
                  <Money amount={po.total_minor} currency={po.currency} />
                </td>
              </tr>
              {#if open}
                <tr>
                  <td class="td bg-sunken/40 p-0" id="po-panel-{po.id}" colspan={7}>
                    <div class="reveal">
                      <div class="reveal-inner space-y-4 px-4 py-3">
                        {#if po.expected_delivery || po.notes}
                          <p class="text-[11.5px] text-t3">
                            {#if po.expected_delivery}
                              Expected {fmtDate(po.expected_delivery)}.
                            {/if}
                            {#if po.notes}{po.notes}{/if}
                          </p>
                        {/if}

                        <!-- status actions -->
                        <div class="flex flex-wrap items-center gap-1.5">
                          {#if po.status === "draft"}
                            <button class="btn h-7" onclick={() => (confirm = { kind: "mark-ordered", po })}>
                              <Icon name="check" size={12} />
                              Mark as ordered
                            </button>
                            <button
                              class="btn btn-danger h-7"
                              onclick={() => (confirm = { kind: "cancel", po })}
                            >
                              Cancel order
                            </button>
                            <button
                              class="btn btn-ghost h-7 ml-auto"
                              onclick={() => (confirm = { kind: "delete", po })}
                            >
                              <Icon name="trash" size={13} />
                              Delete
                            </button>
                          {:else if po.status === "ordered"}
                            <button
                              class="btn btn-danger h-7"
                              onclick={() => (confirm = { kind: "cancel", po })}
                            >
                              Cancel order
                            </button>
                            {#if detailStatus[po.id] === "none" || detailStatus[po.id] === undefined}
                              <button
                                class="btn btn-ghost h-7 ml-auto"
                                onclick={() => (confirm = { kind: "delete", po })}
                              >
                                <Icon name="trash" size={13} />
                                Delete
                              </button>
                            {/if}
                          {:else}
                            <Badge tone="neutral" dot={false} label="cancelled — no further changes" />
                          {/if}
                          {#if detailStatus[po.id]}
                            <span class="ml-auto flex items-center gap-1.5 text-[11.5px] text-t3">
                              Receiving
                              <Badge
                                tone={receivingTone[detailStatus[po.id]!]}
                                dot={false}
                                label={detailStatus[po.id]!}
                              />
                            </span>
                          {/if}
                        </div>

                        {#if detailLoading === po.id}
                          <Skeleton rows={3} />
                        {:else if detailError}
                          <p class="flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                            <Icon name="alert-circle" size={13} />
                            {detailError}
                          </p>
                        {:else}
                          <!-- lines -->
                          <div>
                            <span class="eyebrow mb-1.5 block">
                              Lines <span class="num text-t3">{items.length}</span>
                            </span>
                            {#if items.length === 0}
                              <p class="text-[11.5px] text-t3">No lines yet.</p>
                            {:else}
                              <ul class="space-y-1.5">
                                {#each items as it (it.item.id)}
                                  <li
                                    class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-panel px-3 py-2 text-[12px]"
                                  >
                                    <span class="min-w-0 flex-1 basis-48 truncate font-medium">
                                      {variantLabel(it.item.variant_id)}
                                    </span>
                                    <span class="num text-t3">{it.item.qty_ordered} ordered</span>
                                    <span class="num text-t3">
                                      × <Money amount={it.item.unit_price_minor} currency={po.currency} />
                                    </span>
                                    <span class="num font-medium">
                                      <Money amount={it.item.total_minor} currency={po.currency} />
                                    </span>
                                    <button
                                      type="button"
                                      class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]
                                        {receivingTone[it.status] === 'success'
                                        ? 'border-success/25 bg-success/10 text-success'
                                        : receivingTone[it.status] === 'warning'
                                          ? 'border-warning/25 bg-warning/10 text-warning'
                                          : 'border-line bg-sunken text-t2'}"
                                      onclick={() => openHistory(it)}
                                      title="View receipt history"
                                    >
                                      <span class="num">{it.received_qty}</span> received · {it.status}
                                    </button>
                                    <span class="ml-auto flex shrink-0 items-center gap-1">
                                      {#if po.status !== "cancelled"}
                                        <button
                                          class="btn h-6 px-2 text-[11px]"
                                          onclick={() => openReceive(it, po)}
                                        >
                                          <Icon name="download" size={11} />
                                          Receive
                                        </button>
                                        <button
                                          class="btn h-6 px-2 text-[11px]"
                                          onclick={() => openEditItem(it.item, po)}
                                        >
                                          <Icon name="pencil" size={11} />
                                        </button>
                                        <button
                                          class="btn btn-ghost h-6 px-2 text-[11px]"
                                          aria-label="Delete line"
                                          onclick={() =>
                                            (confirm = { kind: "delete-item", item: it.item, poId: po.id })}
                                        >
                                          <Icon name="trash" size={11} />
                                        </button>
                                      {/if}
                                    </span>
                                  </li>
                                {/each}
                              </ul>
                            {/if}
                          </div>

                          <!-- add line -->
                          {#if po.status !== "cancelled"}
                            {#if variants.length === 0}
                              <p class="text-[11.5px] text-t3">
                                No products in the catalogue yet — add one there, then order it here.
                              </p>
                            {:else}
                              <form
                                class="flex flex-wrap items-end gap-2 border-t border-line pt-3"
                                onsubmit={(e) => {
                                  e.preventDefault();
                                  commitAddLine(po);
                                }}
                              >
                                <label class="block">
                                  <span class="mb-1 block text-[11px] text-t3">Product</span>
                                  <select class="input h-8 w-56 text-[12px]" bind:value={addLineVariantId}>
                                    {#each variants as v (v.id)}
                                      <option value={v.id}>{v.name} · {v.sku}</option>
                                    {/each}
                                  </select>
                                </label>
                                <label class="block">
                                  <span class="mb-1 block text-[11px] text-t3">Quantity</span>
                                  <input
                                    class="input num h-8 w-20 text-[12px]"
                                    inputmode="numeric"
                                    placeholder="10"
                                    bind:value={addLineQty}
                                  />
                                </label>
                                <label class="block">
                                  <span class="mb-1 block text-[11px] text-t3">Unit price (optional)</span>
                                  <input
                                    class="input num h-8 w-28 text-[12px]"
                                    placeholder="0.00"
                                    bind:value={addLinePrice}
                                  />
                                </label>
                                <button
                                  class="btn h-8"
                                  type="submit"
                                  disabled={addLineBusy || !addLineVariantId || !addLineQty.trim()}
                                >
                                  <Icon name="plus" size={12} />
                                  {addLineBusy ? "Adding…" : "Add line"}
                                </button>
                              </form>
                              {#if addLineError}
                                <p class="flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                                  <Icon name="alert-circle" size={13} />
                                  {addLineError}
                                </p>
                              {/if}
                            {/if}
                          {/if}
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
{/if}

<!-- Create order -->
<Dialog
  open={showCreate}
  title="New purchase order"
  size="md"
  dismissible={!createBusy}
  onclose={() => (showCreate = false)}
>
  <div class="grid gap-3 px-5 pb-4 sm:grid-cols-2">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Supplier</span>
      <select data-autofocus class="input" bind:value={poSupplierId}>
        {#each suppliers as s (s.id)}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Location</span>
      <select class="input" bind:value={poLocationId}>
        {#each locations as l (l.id)}
          <option value={l.id}>{l.name}</option>
        {/each}
      </select>
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">PO number</span>
      <input class="input font-mono" bind:value={poNumber} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Order date</span>
      <input class="input" type="date" bind:value={poOrderDate} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Expected delivery (optional)</span>
      <input class="input" type="date" bind:value={poExpected} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Currency</span>
      <input class="input w-24 uppercase" maxlength={3} bind:value={poCurrency} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Tax (optional)</span>
      <input class="input num" placeholder="0.00" bind:value={poTax} />
    </label>
    <label class="block sm:col-span-2">
      <span class="mb-1.5 block text-[12px] text-t2">Notes (optional)</span>
      <input class="input" bind:value={poNotes} />
    </label>
    {#if createError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger sm:col-span-2"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {createError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={createBusy} onclick={() => (showCreate = false)}>Cancel</button>
    <button class="btn btn-primary" disabled={createBusy} onclick={commitCreate}>
      {#if createBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {createBusy ? "Creating…" : "Create order"}
    </button>
  {/snippet}
</Dialog>

<!-- Edit line -->
<Dialog
  open={editItem !== null}
  title="Edit line — {editItem ? variantLabel(editItem.variant_id) : ''}"
  size="sm"
  dismissible={!editBusy}
  onclose={() => (editItem = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Quantity ordered</span>
      <input data-autofocus class="input num" inputmode="numeric" bind:value={editQty} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Unit price</span>
      <input class="input num" bind:value={editPrice} />
    </label>
    {#if editError}
      <p class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {editError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={editBusy} onclick={() => (editItem = null)}>Cancel</button>
    <button class="btn btn-primary" disabled={editBusy} onclick={commitEditItem}>
      {#if editBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {editBusy ? "Saving…" : "Save"}
    </button>
  {/snippet}
</Dialog>

<!-- Receive -->
<Dialog
  open={receiveTarget !== null}
  title="Receive — {receiveTarget ? variantLabel(receiveTarget.item.item.variant_id) : ''}"
  description="Writes the stock movement and the receipt fact together, in one transaction."
  size="sm"
  dismissible={!receiveBusy}
  onclose={() => (receiveTarget = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">
        Quantity received — negative corrects an earlier over-receipt
      </span>
      <input data-autofocus class="input num" inputmode="numeric" placeholder="10" bind:value={receiveQty} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Arrived at</span>
      <select class="input" bind:value={receiveLocationId}>
        {#each locations as l (l.id)}
          <option value={l.id}>{l.name}</option>
        {/each}
      </select>
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Received by (optional)</span>
      <input class="input" bind:value={receiveBy} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Note (optional)</span>
      <input class="input" bind:value={receiveNote} />
    </label>
    {#if receiveError}
      <p class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {receiveError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={receiveBusy} onclick={() => (receiveTarget = null)}>Cancel</button>
    <button class="btn btn-primary" disabled={receiveBusy} onclick={commitReceive}>
      {#if receiveBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {receiveBusy ? "Recording…" : "Record receipt"}
    </button>
  {/snippet}
</Dialog>

<!-- Receipt history -->
<Dialog
  open={historyItem !== null}
  title="Receipt history — {historyItem ? variantLabel(historyItem.item.variant_id) : ''}"
  description="Every receipt ever recorded against this line. Insert-only — nothing here is ever edited or removed; a correction is a new, negative receipt."
  size="sm"
  onclose={() => (historyItem = null)}
>
  <div class="px-5 pb-4">
    {#if historyLoading}
      <Skeleton rows={3} />
    {:else if historyError}
      <p class="flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">
        <Icon name="alert-circle" size={13} />
        {historyError}
      </p>
    {:else if historyReceipts.length === 0}
      <p class="text-[12px] text-t3">Nothing received against this line yet.</p>
    {:else}
      <ul class="max-h-64 space-y-1.5 overflow-y-auto">
        {#each historyReceipts as r (r.id)}
          <li class="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px]">
            <span class="num shrink-0 text-t3">{fmtDate(r.created_at)}</span>
            <span class="min-w-0 flex-1 truncate text-t2">
              {locationName(r.location_id)}
              {#if r.received_by}· {r.received_by}{/if}
              {#if r.note}<span class="text-t3"> — {r.note}</span>{/if}
            </span>
            <span class="num shrink-0 {r.qty > 0 ? 'text-success' : 'text-t2'}">
              {r.qty > 0 ? "+" : ""}{r.qty}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</Dialog>

<ConfirmDialog
  open={confirm !== null}
  title={confirmCopy?.title ?? ""}
  body={confirmCopy?.body}
  confirmLabel={confirmCopy?.label ?? "Confirm"}
  tone={confirmCopy?.tone ?? "default"}
  busy={confirmBusy}
  error={confirmError}
  onconfirm={runConfirm}
  oncancel={() => (confirm = null)}
/>
