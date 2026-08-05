<script lang="ts">
  /**
   * Fixed assets & depreciation (migration 0016, PARITY.md "Fixed assets").
   *
   * A register entry is a capitalised cost — no journal posts when it is
   * created. `depreciationRun` is the keystone: it posts one period at a
   * time (**DR** depreciation expense, **CR** accumulated depreciation),
   * idempotent per (asset, period) — a period already posted, or one out of
   * sequence, is refused rather than silently re-posted or skipped. Every
   * figure this screen shows for accumulated depreciation / net book value
   * comes from `assetWithDepreciation`, never computed here, so it can never
   * disagree with what actually posted.
   *
   * Editing an asset's schedule-affecting fields (cost, acquisition date,
   * useful life, method, rate) is refused once any depreciation has posted
   * against it, or once it is disposed — only name/description stay
   * editable. There is no edit form on this screen for that reason: the one
   * thing worth surfacing here is the refusal itself, from the server, on
   * the rare attempt.
   *
   * Disposing reverses (never deletes) any depreciation already posted for a
   * period after the disposal date, because the posted ledger is immutable
   * — see `CoreService::asset_dispose`'s doc comment.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/state/router.svelte";
  import { routeCache } from "../lib/loadCache";
  import { fmtDate, localDate, parseMoneyInput } from "../lib/util/format";
  import type {
    Asset,
    AssetDepreciationRun,
    AssetWithDepreciation,
    Book,
    BookProfile,
    DepreciationMethod,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import Dialog from "../lib/components/Dialog.svelte";

  let book = $state<Book | null>(null);
  let profile = $state<BookProfile | null>(null);
  let rows = $state<AssetWithDepreciation[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  interface Snapshot {
    book: Book;
    profile: BookProfile;
    rows: AssetWithDepreciation[];
  }

  async function loadRows(bookId: string): Promise<AssetWithDepreciation[]> {
    const assets = await api.assetList({ book_id: bookId });
    return Promise.all(assets.map((a) => api.assetWithDepreciation({ id: a.id })));
  }

  async function load(background = false) {
    if (!background) loading = true;
    loadError = null;
    try {
      const b = requireBook(await api.bookList());
      const p = await api.bookProfile({ book_id: b.id });
      const list = p.show_assets ? await loadRows(b.id) : [];
      book = b;
      profile = p;
      rows = list;
      routeCache.set<Snapshot>("assets", { book: b, profile: p, rows: list });
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  {
    const cached = routeCache.get<Snapshot>("assets");
    if (cached) {
      book = cached.book;
      profile = cached.profile;
      rows = cached.rows;
      loading = false;
      void load(true);
    } else {
      void load();
    }
  }

  function syncCache() {
    const cached = routeCache.get<Snapshot>("assets");
    if (!cached) return;
    routeCache.set<Snapshot>("assets", { ...cached, rows: $state.snapshot(rows) as AssetWithDepreciation[] });
  }

  async function refreshOne(assetId: string) {
    const updated = await api.assetWithDepreciation({ id: assetId });
    rows = rows.map((r) => (r.asset.id === assetId ? updated : r));
    syncCache();
  }

  const activeCount = $derived(rows.filter((r) => r.asset.status === "active").length);
  const disposedCount = $derived(rows.filter((r) => r.asset.status === "disposed").length);
  const totalCostMinor = $derived(rows.reduce((s, r) => s + r.asset.cost_minor, 0));
  const totalNbvMinor = $derived(rows.reduce((s, r) => s + r.net_book_value_minor, 0));
  const displayCurrency = $derived(book?.currency ?? "ZAR");

  const statusTone: Record<Asset["status"], "neutral" | "danger"> = {
    active: "neutral",
    disposed: "danger",
  };

  /** `YYYY-MM` of the next unposted period, purely for a sensible dialog
   * default — the server, not this guess, decides what is actually valid. */
  function nextPeriodGuess(row: AssetWithDepreciation): string {
    const [ay, am] = row.asset.acquired_date.split("-").map(Number) as [number, number];
    const total = ay * 12 + (am - 1) + row.periods_run;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
  }

  // -------------------------------------------------------------------------
  // create an asset
  // -------------------------------------------------------------------------

  let showCreate = $state(false);
  let newName = $state("");
  let newDescription = $state("");
  let newAcquiredDate = $state(localDate());
  let newCost = $state("");
  let newResidual = $state("");
  let newCurrency = $state("");
  let newLifeMonths = $state("");
  let newMethod = $state<DepreciationMethod>("straight_line");
  let newRateBps = $state("");
  let createBusy = $state(false);
  let createError = $state<string | null>(null);

  function openCreate() {
    showCreate = true;
    newName = "";
    newDescription = "";
    newAcquiredDate = localDate();
    newCost = "";
    newResidual = "";
    newCurrency = book?.currency ?? "";
    newLifeMonths = "";
    newMethod = "straight_line";
    newRateBps = "";
    createError = null;
  }

  async function commitCreate() {
    if (!book) return;
    createError = null;
    if (!newName.trim()) {
      createError = "enter a name";
      return;
    }
    const currency = (newCurrency.trim() || book.currency).toUpperCase();
    const costMinor = parseMoneyInput(newCost, currency);
    if (costMinor === null || costMinor <= 0) {
      createError = "enter a positive cost";
      return;
    }
    let residualMinor: number | undefined;
    if (newResidual.trim()) {
      const parsed = parseMoneyInput(newResidual, currency);
      if (parsed === null || parsed < 0) {
        createError = "enter a valid, non-negative residual value";
        return;
      }
      residualMinor = parsed;
    }
    const lifeMonths = Number(newLifeMonths);
    if (!Number.isInteger(lifeMonths) || lifeMonths <= 0) {
      createError = "enter a whole number of months (at least 1)";
      return;
    }
    let rateBps: number | undefined;
    if (newMethod === "reducing_balance") {
      rateBps = Math.round(Number(newRateBps) * 100);
      if (!Number.isFinite(rateBps) || rateBps <= 0 || rateBps > 10_000) {
        createError = "enter a per-period rate between 0 and 100%";
        return;
      }
    }
    createBusy = true;
    try {
      const created = await api.assetCreate({
        book_id: book.id,
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        acquired_date: newAcquiredDate,
        cost_minor: costMinor,
        residual_minor: residualMinor,
        currency,
        useful_life_months: lifeMonths,
        method: newMethod,
        reducing_balance_rate_bps: rateBps,
      });
      const withDep: AssetWithDepreciation = {
        asset: created,
        accumulated_depreciation_minor: 0,
        net_book_value_minor: created.cost_minor,
        periods_run: 0,
      };
      rows = [withDep, ...rows];
      syncCache();
      showCreate = false;
    } catch (err) {
      createError = String(err);
    } finally {
      createBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // expand a row: depreciation history, run-depreciation and dispose.
  // -------------------------------------------------------------------------

  let expandedId = $state<string | null>(null);
  let historyByAsset = $state<Record<string, AssetDepreciationRun[]>>({});
  let historyLoading = $state<string | null>(null);
  let historyError = $state<string | null>(null);

  async function loadHistory(assetId: string) {
    historyLoading = assetId;
    historyError = null;
    try {
      const runs = await api.depreciationRunsForAsset({ asset_id: assetId });
      historyByAsset = { ...historyByAsset, [assetId]: runs };
    } catch (err) {
      historyError = String(err);
    } finally {
      historyLoading = null;
    }
  }

  function toggleExpand(row: AssetWithDepreciation) {
    if (expandedId === row.asset.id) {
      expandedId = null;
      return;
    }
    expandedId = row.asset.id;
    if (!(row.asset.id in historyByAsset)) void loadHistory(row.asset.id);
  }

  let runTarget = $state<AssetWithDepreciation | null>(null);
  let runPeriod = $state("");
  let runBusy = $state(false);
  let runError = $state<string | null>(null);
  let runResult = $state<AssetDepreciationRun | null | undefined>(undefined);

  function openRun(row: AssetWithDepreciation) {
    runTarget = row;
    runPeriod = nextPeriodGuess(row);
    runError = null;
    runResult = undefined;
  }

  async function commitRun() {
    if (!runTarget) return;
    if (!/^\d{4}-\d{2}$/.test(runPeriod)) {
      runError = "enter a period as YYYY-MM";
      return;
    }
    runBusy = true;
    runError = null;
    try {
      const run = await api.depreciationRun({ asset_id: runTarget.asset.id, period: runPeriod });
      runResult = run;
      await refreshOne(runTarget.asset.id);
      if (runTarget.asset.id in historyByAsset) await loadHistory(runTarget.asset.id);
    } catch (err) {
      runError = String(err);
    } finally {
      runBusy = false;
    }
  }

  let disposeTarget = $state<AssetWithDepreciation | null>(null);
  let disposeDate = $state(localDate());
  let disposeProceeds = $state("");
  let disposeBusy = $state(false);
  let disposeError = $state<string | null>(null);

  function openDispose(row: AssetWithDepreciation) {
    disposeTarget = row;
    disposeDate = localDate();
    disposeProceeds = "";
    disposeError = null;
  }

  async function commitDispose() {
    if (!disposeTarget) return;
    disposeError = null;
    const currency = disposeTarget.asset.currency;
    let proceedsMinor: number | undefined;
    if (disposeProceeds.trim()) {
      const parsed = parseMoneyInput(disposeProceeds, currency);
      if (parsed === null || parsed < 0) {
        disposeError = "enter a valid, non-negative proceeds amount";
        return;
      }
      proceedsMinor = parsed;
    }
    disposeBusy = true;
    try {
      await api.assetDispose({
        id: disposeTarget.asset.id,
        disposed_date: disposeDate,
        proceeds_minor: proceedsMinor,
      });
      await refreshOne(disposeTarget.asset.id);
      if (disposeTarget.asset.id in historyByAsset) await loadHistory(disposeTarget.asset.id);
      disposeTarget = null;
    } catch (err) {
      disposeError = String(err);
    } finally {
      disposeBusy = false;
    }
  }
</script>

<PageHeader
  eyebrow="Fixed assets · depreciation"
  title="Assets"
  subtitle="A register of what this book capitalised — cost, acquisition date, useful life and method. Running depreciation posts one period at a time, DR depreciation expense, CR accumulated depreciation, and refuses to post the same period twice."
>
  {#snippet actions()}
    {#if profile?.show_assets}
      <button class="btn btn-primary" onclick={openCreate}>
        <Icon name="plus" size={14} />
        New asset
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load Assets" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if loading}
  <div class="card"><Skeleton rows={8} /></div>
{:else if profile && !profile.show_assets}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Assets is a business feature"
      body="“{book?.name}” is a personal book — the fixed-asset register only applies to business books, because depreciation posts against chart-of-accounts control accounts a personal book does not seed. Switch its kind to Business in Settings › General, then come back here."
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
    <StatCard label="Active" value={String(activeCount)} />
    <StatCard label="Disposed" value={String(disposedCount)} />
    <StatCard label="Total cost" amount={totalCostMinor} currency={displayCurrency} />
    <StatCard label="Net book value" amount={totalNbvMinor} currency={displayCurrency} tone="accent" />
  </div>

  <div class="card mt-4 overflow-hidden">
    {#if rows.length === 0}
      <EmptyState
        icon="alert-circle"
        title="No assets yet"
        body="Register a capitalised cost — cost, acquisition date, useful life and method — then run depreciation against it one period at a time."
      >
        {#snippet actions()}
          <button class="btn btn-primary" onclick={openCreate}>
            <Icon name="plus" size={13} />
            New asset
          </button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table-wrap">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr class="border-b border-line text-left text-t2">
              <th class="th">Asset</th>
              <th class="th">Status</th>
              <th class="th">Acquired</th>
              <th class="th">Method</th>
              <th class="th text-right">Cost</th>
              <th class="th text-right">Accum. depreciation</th>
              <th class="th text-right">Net book value</th>
              <th class="th"></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.asset.id)}
              <tr class="cursor-pointer border-b border-line last:border-0 hover:bg-sunken/50" onclick={() => toggleExpand(row)}>
                <td class="td">
                  <div class="font-medium">{row.asset.name}</div>
                  {#if row.asset.description}
                    <div class="text-[11.5px] text-t2">{row.asset.description}</div>
                  {/if}
                </td>
                <td class="td"><Badge tone={statusTone[row.asset.status]} label={row.asset.status} /></td>
                <td class="td text-t2">{fmtDate(row.asset.acquired_date)}</td>
                <td class="td text-t2">{row.asset.method === "straight_line" ? "Straight-line" : "Reducing balance"}</td>
                <td class="td text-right"><Money amount={row.asset.cost_minor} currency={row.asset.currency} /></td>
                <td class="td text-right"><Money amount={row.accumulated_depreciation_minor} currency={row.asset.currency} /></td>
                <td class="td text-right"><Money amount={row.net_book_value_minor} currency={row.asset.currency} /></td>
                <td class="td text-right">
                  <Icon name={expandedId === row.asset.id ? "minus" : "plus"} size={13} class="text-t2" />
                </td>
              </tr>
              {#if expandedId === row.asset.id}
                <tr class="border-b border-line bg-sunken/30 last:border-0">
                  <td class="td" colspan="8">
                    <div class="flex flex-wrap items-center gap-2 py-1">
                      {#if row.asset.status === "active"}
                        <button class="btn h-8" onclick={(e) => { e.stopPropagation(); openRun(row); }}>
                          <Icon name="refresh" size={13} />
                          Run depreciation
                        </button>
                        <button class="btn h-8" onclick={(e) => { e.stopPropagation(); openDispose(row); }}>
                          Dispose
                        </button>
                      {:else}
                        <span class="text-[12px] text-t2">
                          Disposed {row.asset.disposed_date ? fmtDate(row.asset.disposed_date) : ""}
                          {#if row.asset.disposal_proceeds_minor != null}
                            · proceeds <Money amount={row.asset.disposal_proceeds_minor} currency={row.asset.currency} />
                          {/if}
                        </span>
                      {/if}
                      <span class="text-[12px] text-t2">
                        {row.periods_run} period(s) posted · useful life {row.asset.useful_life_months} months
                        {#if row.asset.method === "reducing_balance" && row.asset.reducing_balance_rate_bps != null}
                          · {(row.asset.reducing_balance_rate_bps / 100).toFixed(2)}% per period
                        {/if}
                      </span>
                    </div>
                    {#if historyLoading === row.asset.id}
                      <Skeleton rows={2} />
                    {:else if historyError}
                      <p class="text-[12px] text-danger">{historyError}</p>
                    {:else if (historyByAsset[row.asset.id]?.length ?? 0) > 0}
                      <ul class="divide-y divide-line">
                        {#each historyByAsset[row.asset.id] ?? [] as run (run.id)}
                          <li class="flex items-center justify-between py-1.5 text-[12px]">
                            <span class="text-t2">{run.period} · period {run.period_index}</span>
                            <span class="num"><Money amount={run.depreciation_minor} currency={row.asset.currency} /></span>
                          </li>
                        {/each}
                      </ul>
                    {:else}
                      <p class="py-1 text-[12px] text-t2">No depreciation posted yet.</p>
                    {/if}
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

<!-- Create asset -->
<Dialog
  open={showCreate}
  title="New asset"
  size="md"
  dismissible={!createBusy}
  onclose={() => (showCreate = false)}
>
  <div class="grid gap-3 px-5 pb-4 sm:grid-cols-2">
    <label class="block sm:col-span-2">
      <span class="mb-1.5 block text-[12px] text-t2">Name</span>
      <input data-autofocus class="input" bind:value={newName} />
    </label>
    <label class="block sm:col-span-2">
      <span class="mb-1.5 block text-[12px] text-t2">Description (optional)</span>
      <input class="input" bind:value={newDescription} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Acquired</span>
      <input class="input" type="date" bind:value={newAcquiredDate} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Currency</span>
      <input class="input w-24 uppercase" maxlength={3} bind:value={newCurrency} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Cost</span>
      <input class="input num" placeholder="0.00" bind:value={newCost} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Residual value (optional)</span>
      <input class="input num" placeholder="0.00" bind:value={newResidual} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Useful life (months)</span>
      <input class="input num" inputmode="numeric" bind:value={newLifeMonths} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Method</span>
      <select class="input" bind:value={newMethod}>
        <option value="straight_line">Straight-line</option>
        <option value="reducing_balance">Reducing balance</option>
      </select>
    </label>
    {#if newMethod === "reducing_balance"}
      <label class="block sm:col-span-2">
        <span class="mb-1.5 block text-[12px] text-t2">Rate per period (%)</span>
        <input class="input num" placeholder="e.g. 20" bind:value={newRateBps} />
      </label>
    {/if}
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
      {createBusy ? "Registering…" : "Register asset"}
    </button>
  {/snippet}
</Dialog>

<!-- Run depreciation -->
<Dialog
  open={runTarget !== null}
  title="Run depreciation — {runTarget?.asset.name ?? ''}"
  description="DR depreciation expense, CR accumulated depreciation. Refused if this period is not the asset's next one, or already posted."
  size="sm"
  dismissible={!runBusy}
  onclose={() => (runTarget = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Period (YYYY-MM)</span>
      <input data-autofocus class="input" bind:value={runPeriod} />
    </label>
    {#if runResult === null}
      <p class="text-[12px] text-t2">
        Nothing was posted — either there is no chart of accounts to post into, or nothing was
        left to depreciate this period.
      </p>
    {/if}
    {#if runError}
      <p class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {runError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={runBusy} onclick={() => (runTarget = null)}>Close</button>
    <button class="btn btn-primary" disabled={runBusy} onclick={commitRun}>
      {#if runBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {runBusy ? "Posting…" : "Post"}
    </button>
  {/snippet}
</Dialog>

<!-- Dispose -->
<Dialog
  open={disposeTarget !== null}
  title="Dispose — {disposeTarget?.asset.name ?? ''}"
  description="Permanent. Reverses (never deletes) any depreciation already posted for a period after the disposal date."
  size="sm"
  dismissible={!disposeBusy}
  onclose={() => (disposeTarget = null)}
>
  <div class="space-y-3 px-5 pb-4">
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Disposed on</span>
      <input data-autofocus class="input" type="date" bind:value={disposeDate} />
    </label>
    <label class="block">
      <span class="mb-1.5 block text-[12px] text-t2">Proceeds (optional)</span>
      <input class="input num" placeholder="0.00" bind:value={disposeProceeds} />
    </label>
    {#if disposeError}
      <p class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger" role="alert">
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {disposeError}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <button class="btn" disabled={disposeBusy} onclick={() => (disposeTarget = null)}>Cancel</button>
    <button class="btn btn-danger" disabled={disposeBusy} onclick={commitDispose}>
      {#if disposeBusy}<Icon name="refresh" size={13} class="animate-spin" />{/if}
      {disposeBusy ? "Disposing…" : "Dispose asset"}
    </button>
  {/snippet}
</Dialog>
