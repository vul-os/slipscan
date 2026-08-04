<script lang="ts">
  /**
   * Stock — the append-only movement ledger (ROADMAP.md 6.3b, screen 6.9).
   *
   * The one fact this whole screen exists to keep visible: **on-hand is
   * always `SUM(qty_delta)` over immutable movements, never a stored
   * counter.** There is no "set stock level" control anywhere here and there
   * never will be — a correction is a new `adjustment` or `count` movement,
   * which is exactly what the two dialogs below write. Nothing on this
   * screen edits or deletes a movement; the database has triggers that
   * refuse it.
   *
   * A goods receipt (Purchasing) and a confirmed sale (not built yet) write
   * their own movements as a side effect of that action — this screen does
   * not offer "receipt" or "sale" as a manual kind, only the two a person
   * genuinely enters by hand: an **adjustment** (a known signed correction —
   * breakage, a found box) and a **count** (a physical recount, entered as
   * the counted quantity so the screen computes the signed delta rather than
   * asking someone to do that arithmetic).
   *
   * A **transfer** is two movements summing to zero, written in one
   * transaction — stock is never "in transit" because it is never removed
   * from the ledger while it moves. The confirmation after a transfer shows
   * both movements for exactly that reason.
   *
   * Stock only exists where a business's catalogue does — a personal book
   * has no `product_variants` row to move — so this screen gates on
   * `BookProfile.show_catalogue`, the same flag Settings › General already
   * displays but nothing has enforced until now (ROADMAP.md "Phase 6.0"
   * doc comment: "the screens they would gate are 6.9"). Per-location
   * columns are further gated on `show_locations`: a single-location
   * business sees one honest total, not a location axis with one entry in
   * it. Transfer itself is not gated by that flag — it is a real capability
   * the moment two locations exist, whether or not the axis is on display.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/state/router.svelte";
  import { routeCache } from "../lib/loadCache";
  import { fmtDate } from "../lib/util/format";
  import type {
    Book,
    BookProfile,
    Location,
    LocationKind,
    LowStockVariant,
    ProductVariant,
    StockMovement,
    StockMovementKind,
    TransferResult,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import Dialog from "../lib/components/Dialog.svelte";

  let book = $state<Book | null>(null);
  let profile = $state<BookProfile | null>(null);
  let locations = $state<Location[]>([]);
  let variants = $state<ProductVariant[]>([]);
  let lowVariants = $state<LowStockVariant[]>([]);
  let onHandTotals = $state<Record<string, number>>({});
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  interface Snapshot {
    book: Book;
    profile: BookProfile;
    locations: Location[];
    variants: ProductVariant[];
    lowVariants: LowStockVariant[];
    onHandTotals: Record<string, number>;
  }

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const b = requireBook(await api.bookList());
      const p = await api.bookProfile({ book_id: b.id });
      let locs: Location[] = [];
      let vars: ProductVariant[] = [];
      let low: LowStockVariant[] = [];
      let totals: Record<string, number> = {};
      if (p.show_catalogue) {
        [locs, vars, low] = await Promise.all([
          api.locationList({ book_id: b.id }),
          api.productVariantListForBook({ book_id: b.id }),
          api.stockLowVariants({ book_id: b.id }),
        ]);
        const sums = await Promise.all(
          vars.map((v) => api.stockOnHandTotal({ variant_id: v.id })),
        );
        totals = Object.fromEntries(vars.map((v, i) => [v.id, sums[i]!]));
      }
      book = b;
      profile = p;
      locations = locs;
      variants = vars;
      lowVariants = low;
      onHandTotals = totals;
      routeCache.set<Snapshot>("stock", {
        book: b,
        profile: p,
        locations: locs,
        variants: vars,
        lowVariants: low,
        onHandTotals: totals,
      });
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  {
    const cached = routeCache.get<Snapshot>("stock");
    if (cached) {
      book = cached.book;
      profile = cached.profile;
      locations = cached.locations;
      variants = cached.variants;
      lowVariants = cached.lowVariants;
      onHandTotals = cached.onHandTotals;
      loading = false;
      load(true);
    } else {
      load();
    }
  }

  function syncCache() {
    const cached = routeCache.get<Snapshot>("stock");
    if (!cached) return;
    routeCache.set<Snapshot>("stock", {
      ...cached,
      locations: $state.snapshot(locations) as Location[],
      lowVariants: $state.snapshot(lowVariants) as LowStockVariant[],
      onHandTotals: $state.snapshot(onHandTotals) as Record<string, number>,
    });
  }

  const lowIds = $derived(new Set(lowVariants.map((l) => l.variant.id)));
  const sortedVariants = $derived(
    variants.slice().sort((a, b) => {
      const la = lowIds.has(a.id);
      const lb = lowIds.has(b.id);
      if (la !== lb) return la ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
  );
  const locationName = (id: string): string =>
    locations.find((l) => l.id === id)?.name ?? "(removed location)";

  // -------------------------------------------------------------------------
  // add the first location — a hard prerequisite. `location_id` is required
  // on every movement, so without at least one row here nothing on this
  // screen can write anything, no matter how full the catalogue is.
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
      locKind = "branch";
    } catch (err) {
      locError = String(err);
    } finally {
      locBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // row expand: per-location on-hand + movement history, fetched lazily —
  // the same shape as Transactions' row panel.
  // -------------------------------------------------------------------------

  let expandedId = $state<string | null>(null);
  let detailByLocation = $state<Record<string, [string, number][]>>({});
  let detailMovements = $state<Record<string, StockMovement[]>>({});
  let detailLoading = $state<string | null>(null);
  let detailError = $state<string | null>(null);

  async function loadDetail(v: ProductVariant) {
    detailLoading = v.id;
    detailError = null;
    try {
      const [byLoc, moves] = await Promise.all([
        api.stockOnHandByLocation({ variant_id: v.id }),
        api.stockMovementsForVariant({ variant_id: v.id }),
      ]);
      detailByLocation = { ...detailByLocation, [v.id]: byLoc };
      detailMovements = {
        ...detailMovements,
        [v.id]: moves
          .slice()
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
      };
    } catch (err) {
      detailError = String(err);
    } finally {
      detailLoading = null;
    }
  }

  function toggleExpand(v: ProductVariant) {
    if (expandedId === v.id) {
      expandedId = null;
      return;
    }
    expandedId = v.id;
    if (!(v.id in detailByLocation)) void loadDetail(v);
  }

  async function refreshVariant(variantId: string) {
    const [total, byLoc, moves] = await Promise.all([
      api.stockOnHandTotal({ variant_id: variantId }),
      api.stockOnHandByLocation({ variant_id: variantId }),
      api.stockMovementsForVariant({ variant_id: variantId }),
    ]);
    onHandTotals = { ...onHandTotals, [variantId]: total };
    detailByLocation = { ...detailByLocation, [variantId]: byLoc };
    detailMovements = {
      ...detailMovements,
      [variantId]: moves.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    };
    if (book) lowVariants = await api.stockLowVariants({ book_id: book.id });
    syncCache();
  }

  const kindTone: Record<
    StockMovementKind,
    "success" | "warning" | "accent" | "neutral"
  > = {
    receipt: "success",
    sale: "accent",
    transfer: "neutral",
    adjustment: "warning",
    count: "neutral",
  };

  // -------------------------------------------------------------------------
  // adjust / count — the two manually-written movement kinds.
  // -------------------------------------------------------------------------

  let adjustTarget = $state<ProductVariant | null>(null);
  let adjustMode = $state<"adjustment" | "count">("adjustment");
  let adjustLocationId = $state("");
  let adjustDeltaInput = $state("");
  let adjustCountedInput = $state("");
  let adjustNote = $state("");
  let adjustBusy = $state(false);
  let adjustError = $state<string | null>(null);

  function openAdjust(v: ProductVariant) {
    adjustTarget = v;
    adjustMode = "adjustment";
    adjustLocationId = locations[0]?.id ?? "";
    adjustDeltaInput = "";
    adjustCountedInput = "";
    adjustNote = "";
    adjustError = null;
  }

  const adjustCurrentOnHand = $derived(
    adjustTarget && adjustLocationId
      ? (detailByLocation[adjustTarget.id]?.find(
          ([loc]) => loc === adjustLocationId,
        )?.[1] ?? 0)
      : 0,
  );

  async function commitAdjust() {
    if (!adjustTarget || !adjustLocationId) return;
    adjustError = null;
    let delta: number;
    if (adjustMode === "count") {
      const counted = Number(adjustCountedInput);
      if (!Number.isInteger(counted) || counted < 0) {
        adjustError = "enter a whole, non-negative counted quantity";
        return;
      }
      delta = counted - adjustCurrentOnHand;
      if (delta === 0) {
        adjustError =
          "the counted quantity already matches on-hand at this location — nothing to record";
        return;
      }
    } else {
      const parsed = Number(adjustDeltaInput);
      if (!Number.isInteger(parsed) || parsed === 0) {
        adjustError = "enter a non-zero whole number — negative removes stock";
        return;
      }
      delta = parsed;
    }
    adjustBusy = true;
    try {
      await api.stockMovementRecord({
        variant_id: adjustTarget.id,
        location_id: adjustLocationId,
        qty_delta: delta,
        kind: adjustMode,
        note: adjustNote.trim() || undefined,
      });
      await refreshVariant(adjustTarget.id);
      adjustTarget = null;
    } catch (err) {
      adjustError = String(err);
    } finally {
      adjustBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // transfer — two movements summing to zero.
  // -------------------------------------------------------------------------

  let transferTarget = $state<ProductVariant | null>(null);
  let transferFrom = $state("");
  let transferTo = $state("");
  let transferQty = $state("");
  let transferNote = $state("");
  let transferBusy = $state(false);
  let transferError = $state<string | null>(null);
  let transferResult = $state<TransferResult | null>(null);

  function openTransfer(v: ProductVariant) {
    transferTarget = v;
    transferFrom = locations[0]?.id ?? "";
    transferTo = locations[1]?.id ?? "";
    transferQty = "";
    transferNote = "";
    transferError = null;
    transferResult = null;
  }

  async function commitTransfer() {
    if (!transferTarget) return;
    transferError = null;
    const qty = Number(transferQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      transferError = "enter a positive whole quantity";
      return;
    }
    if (!transferFrom || !transferTo) {
      transferError = "choose both locations";
      return;
    }
    if (transferFrom === transferTo) {
      transferError = "choose two different locations";
      return;
    }
    transferBusy = true;
    try {
      const result = await api.stockTransfer({
        variant_id: transferTarget.id,
        from_location_id: transferFrom,
        to_location_id: transferTo,
        qty,
        note: transferNote.trim() || undefined,
      });
      transferResult = result;
      await refreshVariant(transferTarget.id);
    } catch (err) {
      transferError = String(err);
    } finally {
      transferBusy = false;
    }
  }

  function closeTransfer() {
    transferTarget = null;
    transferResult = null;
  }
</script>

<PageHeader
  eyebrow="Append-only movement ledger"
  title="Stock"
  subtitle="On-hand is always the sum of every movement ever recorded for a variant — there is no “set stock level” control. Correcting a count writes a new adjustment or count movement; nothing here is ever edited or deleted."
/>

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load Stock" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if loading}
  <div class="card"><Skeleton rows={8} /></div>
{:else if profile && !profile.show_catalogue}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Stock is a business feature"
      body="“{book?.name}” is a personal book — Stock only applies to business books, because a stock movement moves a catalogue variant and a personal book has no catalogue. Switch its kind to Business in Settings › General, then come back here."
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={() => router.go("settings")}>
          Open Settings
        </button>
      {/snippet}
    </EmptyState>
  </div>
{:else if book && profile}
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
    <StatCard label="Tracked variants" value={String(variants.length)} />
    <StatCard label="Locations" value={String(locations.length)} />
    <StatCard
      label="Low stock"
      value={String(lowVariants.length)}
      tone={lowVariants.length > 0 ? "warning" : "neutral"}
      sub={lowVariants.length > 0
        ? "at or below reorder point"
        : "all above reorder point"}
    />
  </div>

  {#if locations.length === 0}
    <section class="card mt-4 p-4">
      <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="alert-circle" size={15} class="text-warning" />
        Add a location to start tracking stock
      </h2>
      <p class="mb-3 text-[12px] text-t2">
        Every stock movement — a receipt, a sale, an adjustment, a transfer —
        happens <em>at</em> a location. This book has none yet, so nothing on
        this screen can write anything until one exists, even for a single
        shop running out of one place.
      </p>
      {#if locError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
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
          <input
            class="input w-48"
            placeholder="Main store"
            bind:value={locName}
            required
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Kind</span>
          <select class="input w-36" bind:value={locKind}>
            {#each locationKinds as k (k.id)}
              <option value={k.id}>{k.label}</option>
            {/each}
          </select>
        </label>
        <button
          class="btn btn-primary h-8"
          type="submit"
          disabled={locBusy || !locName.trim()}
        >
          {locBusy ? "Adding…" : "Add location"}
        </button>
      </form>
    </section>
  {/if}

  {#if lowVariants.length > 0}
    <section class="card mt-4 border-warning/25 p-4">
      <h2 class="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="alert-circle" size={15} class="text-warning" />
        Low stock
        <span class="num text-t3">{lowVariants.length}</span>
      </h2>
      <ul class="divide-y divide-line">
        {#each lowVariants as l (l.variant.id)}
          <li class="flex items-center gap-3 py-1.5 text-[12.5px] first:pt-0 last:pb-0">
            <span class="min-w-0 flex-1 truncate">
              <span class="font-medium">{l.variant.name}</span>
              <span class="ml-1.5 font-mono text-[11px] text-t3">{l.variant.sku}</span>
            </span>
            <span class="num text-warning">{l.on_hand}</span>
            <span class="text-t3">on hand of</span>
            <span class="num text-t3">{l.variant.reorder_point}</span>
            <span class="text-t3">reorder point</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="card mt-4 overflow-hidden">
    {#if variants.length === 0}
      <EmptyState
        icon="alert-circle"
        title="No products tracked yet"
        body="Stock movements reference a catalogue variant — add products and variants in Catalogue, then their on-hand and history appear here automatically."
      />
    {:else}
      <div class="table-wrap">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr>
              <th class="th w-9"></th>
              <th class="th">SKU / name</th>
              <th class="th w-28 text-right">Reorder point</th>
              <th class="th w-28 text-right">On hand</th>
            </tr>
          </thead>
          <tbody>
            {#each sortedVariants as v (v.id)}
              {@const open = expandedId === v.id}
              {@const onHand = onHandTotals[v.id] ?? 0}
              {@const low = lowIds.has(v.id)}
              <tr class="row-hover">
                <td class="td">
                  <button
                    type="button"
                    class="flex size-6 items-center justify-center rounded text-t3 hover:text-t1"
                    aria-expanded={open}
                    aria-controls="stock-panel-{v.id}"
                    aria-label="{open ? 'Collapse' : 'Expand'} {v.name}"
                    onclick={() => toggleExpand(v)}
                  >
                    <Icon
                      name="chevron-down"
                      size={13}
                      class={open ? "" : "-rotate-90"}
                    />
                  </button>
                </td>
                <td class="td max-w-0">
                  <button
                    type="button"
                    class="flex w-full min-w-0 flex-col items-start text-left"
                    onclick={() => toggleExpand(v)}
                  >
                    <span class="block truncate font-medium">{v.name}</span>
                    <span class="block truncate font-mono text-[11px] text-t3"
                      >{v.sku}</span
                    >
                  </button>
                </td>
                <td class="td num text-right text-t2">{v.reorder_point}</td>
                <td class="td text-right">
                  <span class="num {low ? 'text-warning' : ''}">{onHand}</span>
                  {#if low}
                    <span class="ml-1.5"
                      ><Badge tone="warning" dot={false} label="low" /></span
                    >
                  {/if}
                </td>
              </tr>
              {#if open}
                <tr>
                  <td class="td bg-sunken/40 p-0" id="stock-panel-{v.id}" colspan={4}>
                    <div class="reveal">
                      <div class="reveal-inner space-y-3 px-4 py-3">
                        {#if detailLoading === v.id}
                          <Skeleton rows={3} />
                        {:else if detailError}
                          <p
                            class="flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
                          >
                            <Icon name="alert-circle" size={13} />
                            {detailError}
                          </p>
                        {:else}
                          {#if profile.show_locations && (detailByLocation[v.id]?.length ?? 0) > 0}
                            <div>
                              <span class="eyebrow mb-1.5 block">By location</span>
                              <ul class="flex flex-wrap gap-2">
                                {#each detailByLocation[v.id] ?? [] as [locId, qty] (locId)}
                                  <li
                                    class="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1 text-[11.5px]"
                                  >
                                    <Icon name="layers" size={12} class="text-t3" />
                                    {locationName(locId)}
                                    <span class="num font-medium">{qty}</span>
                                  </li>
                                {/each}
                              </ul>
                            </div>
                          {/if}

                          <div class="flex flex-wrap items-center gap-1.5">
                            <button
                              class="btn h-7"
                              disabled={locations.length === 0}
                              onclick={() => openAdjust(v)}
                            >
                              <Icon name="pencil" size={12} />
                              Adjust or count
                            </button>
                            <button
                              class="btn h-7"
                              disabled={locations.length < 2}
                              title={locations.length < 2
                                ? "Needs a second location"
                                : undefined}
                              onclick={() => openTransfer(v)}
                            >
                              <Icon name="arrow-right" size={12} />
                              Transfer
                            </button>
                          </div>

                          <div>
                            <span class="eyebrow mb-1.5 block">
                              Movement history
                              <span class="num text-t3"
                                >{(detailMovements[v.id] ?? []).length}</span
                              >
                            </span>
                            {#if (detailMovements[v.id] ?? []).length === 0}
                              <p class="text-[11.5px] text-t3">
                                No movements recorded for this variant yet.
                              </p>
                            {:else}
                              <ul
                                class="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel p-2"
                              >
                                {#each detailMovements[v.id] ?? [] as m (m.id)}
                                  <li
                                    class="flex items-center gap-2 rounded-md px-1.5 py-1 text-[11.5px]"
                                  >
                                    <span class="num shrink-0 text-t3">{fmtDate(m.created_at)}</span>
                                    <Badge
                                      tone={kindTone[m.kind]}
                                      dot={false}
                                      label={m.kind}
                                    />
                                    <span class="min-w-0 flex-1 truncate text-t2">
                                      {locationName(m.location_id)}
                                      {#if m.note}<span class="text-t3"> — {m.note}</span>{/if}
                                    </span>
                                    <span
                                      class="num shrink-0 {m.qty_delta > 0
                                        ? 'text-success'
                                        : 'text-t2'}"
                                    >
                                      {m.qty_delta > 0 ? "+" : ""}{m.qty_delta}
                                    </span>
                                  </li>
                                {/each}
                              </ul>
                            {/if}
                          </div>
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

<!-- Adjust / count -->
<Dialog
  open={adjustTarget !== null}
  title="Adjust or count — {adjustTarget?.name ?? ''}"
  description="An adjustment is a signed correction you already know (breakage, a found box). A count is a physical recount — enter what you counted and SlipScan works out the difference."
  size="sm"
  dismissible={!adjustBusy}
  onclose={() => (adjustTarget = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <div
      class="inline-flex items-center gap-0.5 rounded-lg border border-line p-0.5"
      role="radiogroup"
      aria-label="Movement kind"
    >
      {#each [{ id: "adjustment", label: "Adjustment" }, { id: "count", label: "Count" }] as m (m.id)}
        <button
          type="button"
          role="radio"
          aria-checked={adjustMode === m.id}
          class="rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors
            {adjustMode === m.id
            ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
            : 'text-t2 hover:bg-sunken'}"
          onclick={() => (adjustMode = m.id as "adjustment" | "count")}
        >
          {m.label}
        </button>
      {/each}
    </div>

    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Location</span>
      <select
        data-autofocus
        class="input"
        bind:value={adjustLocationId}
      >
        {#each locations as l (l.id)}
          <option value={l.id}>{l.name}</option>
        {/each}
      </select>
    </label>

    {#if adjustMode === "count"}
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">
          Counted quantity — currently <span class="num">{adjustCurrentOnHand}</span>
          on hand there
        </span>
        <input
          class="input num"
          inputmode="numeric"
          placeholder="0"
          bind:value={adjustCountedInput}
        />
      </label>
    {:else}
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">
          Signed quantity — negative removes stock
        </span>
        <input
          class="input num"
          inputmode="numeric"
          placeholder="-3"
          bind:value={adjustDeltaInput}
        />
      </label>
    {/if}

    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Note (optional)</span>
      <input class="input" placeholder="Damaged in transit" bind:value={adjustNote} />
    </label>

    {#if adjustError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {adjustError}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button class="btn" disabled={adjustBusy} onclick={() => (adjustTarget = null)}>
      Cancel
    </button>
    <button
      class="btn btn-primary"
      disabled={adjustBusy || !adjustLocationId}
      onclick={commitAdjust}
    >
      {#if adjustBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {adjustBusy ? "Recording…" : "Record movement"}
    </button>
  {/snippet}
</Dialog>

<!-- Transfer -->
<Dialog
  open={transferTarget !== null}
  title="Transfer — {transferTarget?.name ?? ''}"
  description="Writes two movements in one transaction — stock leaves one location and arrives at the other, and total on-hand never changes."
  size="sm"
  dismissible={!transferBusy}
  onclose={closeTransfer}
>
  {#if transferResult}
    <div class="space-y-3 px-5 pb-4">
      <p
        class="flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[12px] text-success"
        role="status"
      >
        <Icon name="check-circle" size={14} />
        Transfer recorded — two movements, summing to zero.
      </p>
      <ul class="space-y-1.5">
        <li
          class="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px]"
        >
          <span class="min-w-0 flex-1">{locationName(transferResult.out.location_id)}</span>
          <span class="num text-t2">{transferResult.out.qty_delta}</span>
        </li>
        <li
          class="flex items-center gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px]"
        >
          <span class="min-w-0 flex-1">{locationName(transferResult.in_.location_id)}</span>
          <span class="num text-success">+{transferResult.in_.qty_delta}</span>
        </li>
      </ul>
    </div>
  {:else}
    <div class="space-y-3 px-5 pb-4">
      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1.5 block text-[12px] text-t2">From</span>
          <select data-autofocus class="input" bind:value={transferFrom}>
            {#each locations as l (l.id)}
              <option value={l.id}>{l.name}</option>
            {/each}
          </select>
        </label>
        <label class="block">
          <span class="mb-1.5 block text-[12px] text-t2">To</span>
          <select class="input" bind:value={transferTo}>
            {#each locations as l (l.id)}
              <option value={l.id}>{l.name}</option>
            {/each}
          </select>
        </label>
      </div>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Quantity</span>
        <input
          class="input num"
          inputmode="numeric"
          placeholder="10"
          bind:value={transferQty}
        />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-[12px] text-t2">Note (optional)</span>
        <input class="input" placeholder="Rebalancing ahead of the weekend" bind:value={transferNote} />
      </label>

      {#if transferError}
        <p
          class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
          {transferError}
        </p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if transferResult}
      <button class="btn btn-primary" data-autofocus onclick={closeTransfer}>Done</button>
    {:else}
      <button class="btn" disabled={transferBusy} onclick={closeTransfer}>Cancel</button>
      <button class="btn btn-primary" disabled={transferBusy} onclick={commitTransfer}>
        {#if transferBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
        {transferBusy ? "Transferring…" : "Transfer"}
      </button>
    {/if}
  {/snippet}
</Dialog>
