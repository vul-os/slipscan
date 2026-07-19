<script lang="ts">
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { theme, type ThemeMode } from "../lib/theme.svelte";
  import type {
    Book,
    DataStatus,
    FxCachedRate,
    FxStatus,
    Settings,
    VaultCredentialMeta,
  } from "../lib/api/types";
  import { fmtBytes, fmtDate, fmtRelative } from "../lib/format";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  let s = $state<Settings | null>(null);
  let book = $state<Book | null>(null);
  let saving = $state(false);
  let savedAt = $state<number | null>(null);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);

  // -- credential vault (write-only: secrets go in, only metadata comes out)
  let credentials = $state<VaultCredentialMeta[]>([]);
  let vaultError = $state<string | null>(null);
  /** A failed vault *read* — kept apart from the generic empty state: for
   * security-critical data, "could not read the vault" must never look like
   * "you have no credentials". */
  let vaultLoadError = $state<string | null>(null);
  let showAddForm = $state(false);
  let addName = $state("");
  let addLabel = $state("");
  let addSecret = $state("");
  let addBusy = $state(false);
  let addNameInput = $state<HTMLInputElement | null>(null);
  /** Name of the entry currently being rotated, if any. */
  let rotating = $state<string | null>(null);
  let rotateSecret = $state("");
  let rotateBusy = $state(false);
  let rotateSecretInput = $state<HTMLInputElement | null>(null);
  /** Entry name awaiting a second click to confirm revocation. */
  let revokeArmed = $state<string | null>(null);
  let revokeTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmRevoke(name?: string) {
    if (name === undefined || revokeArmed === name) {
      revokeArmed = null;
      clearTimeout(revokeTimer);
    }
  }

  async function loadVault() {
    vaultLoadError = null;
    try {
      credentials = await api.vaultList();
    } catch (err) {
      credentials = [];
      vaultLoadError = String(err);
    }
  }

  // -- data & backup: the one movable folder holding everything durable.
  // Backup = the user's own cloud syncing that folder (contract: SlipScan
  // ships no backup service).
  let dataStatus = $state<DataStatus | null>(null);
  let dataLoadError = $state<string | null>(null);
  /** Move flow: idle → "form" (type target) → "confirm" (source→target). */
  let moveStage = $state<"idle" | "form" | "confirm">("idle");
  let moveTarget = $state("");
  let moveError = $state<string | null>(null);
  /** True while the single move await is pending — the app is read-only. */
  let moving = $state(false);
  let movedAt = $state<number | null>(null);
  let moveInput = $state<HTMLInputElement | null>(null);
  let pathCopied = $state(false);

  /** The refusal that has an "open instead" way out (marker from core's
   * DataMoveTargetHasDatabase error). */
  const targetHasDb = $derived(
    moveError?.includes("already contains a SlipScan database") ?? false,
  );

  async function loadDataStatus() {
    dataLoadError = null;
    try {
      dataStatus = await api.dataStatus();
    } catch (err) {
      dataStatus = null;
      dataLoadError = String(err);
    }
  }

  async function openMoveForm() {
    moveError = null;
    moveTarget = "";
    moveStage = "form";
    await tick();
    moveInput?.focus();
  }

  function cancelMove() {
    moveStage = "idle";
    moveTarget = "";
    moveError = null;
  }

  /** The one long await: copy → verify → open-check → pointer switch →
   * cleanup. While it is pending every other command blocks — read-only. */
  async function runMove(useExisting: boolean) {
    moving = true;
    moveError = null;
    try {
      dataStatus = await api.dataMove({
        target: moveTarget.trim(),
        use_existing: useExisting,
      });
      moveStage = "idle";
      moveTarget = "";
      movedAt = Date.now();
      setTimeout(() => (movedAt = null), 4000);
      // The book's database path changed too.
      await load();
    } catch (err) {
      moveError = String(err);
      moveStage = "confirm";
    } finally {
      moving = false;
    }
  }

  async function copyDataPath() {
    if (!dataStatus) return;
    try {
      await navigator.clipboard.writeText(dataStatus.data_dir);
      pathCopied = true;
      setTimeout(() => (pathCopied = false), 2000);
    } catch {
      // Clipboard unavailable (permissions) — the path is still visible.
    }
  }

  // -- FX (OpenRate): opt-in. Reading status is purely local; the network is
  // touched only by the explicit fetch/refresh buttons below.
  let fx = $state<FxStatus | null>(null);
  let fxUrl = $state("");
  let fxSaving = $state(false);
  let fxError = $state<string | null>(null);
  /** Pair key currently being fetched ("USD/EUR"), or "new" for the form. */
  let fxBusy = $state<string | null>(null);
  let fxFrom = $state("");
  let fxTo = $state("");

  async function loadFx() {
    try {
      fx = await api.fxStatus();
      fxUrl = fx.base_url ?? "";
    } catch (err) {
      fx = null;
      fxError = String(err);
    }
  }

  async function saveFxUrl() {
    fxSaving = true;
    fxError = null;
    try {
      fx = await api.fxConfigure({ base_url: fxUrl.trim() });
      fxUrl = fx.base_url ?? "";
    } catch (err) {
      fxError = String(err);
    } finally {
      fxSaving = false;
    }
  }

  /** Explicit user action — the only path that performs an FX network call. */
  async function fetchFxRate(from: string, to: string, key: string) {
    fxBusy = key;
    fxError = null;
    try {
      await api.fxFetchRate({ from, to });
      if (key === "new") {
        fxFrom = "";
        fxTo = "";
      }
      await loadFx();
    } catch (err) {
      fxError = String(err);
    } finally {
      fxBusy = null;
    }
  }

  /** A rate dated more than ~26h ago is flagged (weekend/holiday gaps show). */
  function isStale(r: FxCachedRate): boolean {
    return r.age_secs === null || r.age_secs > 93_600;
  }

  async function load() {
    loadError = null;
    try {
      const [settings, books] = await Promise.all([
        api.settingsGet(),
        api.bookList(),
      ]);
      s = settings;
      book = books[0] ?? null;
    } catch (err) {
      loadError = String(err);
      return;
    }
    await Promise.all([loadVault(), loadFx(), loadDataStatus()]);
  }
  load();

  function closeAddForm() {
    showAddForm = false;
    addName = "";
    addLabel = "";
    addSecret = "";
  }

  async function toggleAddForm() {
    vaultError = null;
    if (showAddForm) {
      closeAddForm();
      return;
    }
    showAddForm = true;
    await tick();
    addNameInput?.focus();
  }

  async function save() {
    if (!s) return;
    saving = true;
    saveError = null;
    try {
      s = await api.settingsSet({ settings: $state.snapshot(s) as Settings });
      savedAt = Date.now();
      setTimeout(() => (savedAt = null), 2500);
    } catch (err) {
      saveError = String(err);
    } finally {
      saving = false;
    }
  }

  async function addCredential() {
    vaultError = null;
    addBusy = true;
    try {
      await api.vaultSet({
        name: addName.trim(),
        label: addLabel.trim() || undefined,
        secret: addSecret,
      });
      await loadVault();
      addName = "";
      addLabel = "";
      showAddForm = false;
    } catch (err) {
      vaultError = String(err);
    } finally {
      addSecret = ""; // the secret never lingers in UI state
      addBusy = false;
    }
  }

  async function replaceCredential(name: string) {
    vaultError = null;
    rotateBusy = true;
    try {
      await api.vaultReplace({ name, secret: rotateSecret });
      await loadVault();
      rotating = null;
    } catch (err) {
      vaultError = String(err);
    } finally {
      rotateSecret = "";
      rotateBusy = false;
    }
  }

  async function toggleRotate(name: string) {
    rotating = rotating === name ? null : name;
    rotateSecret = "";
    vaultError = null;
    if (rotating) {
      await tick();
      rotateSecretInput?.focus();
    }
  }

  /** Two-step revoke: first click arms, second click destroys. The armed
   * state disarms on mouse-out, focus loss, Escape, or a short timeout —
   * keyboard users must never be left with a permanently armed button. */
  async function revokeCredential(name: string) {
    if (revokeArmed !== name) {
      disarmRevoke();
      revokeArmed = name;
      revokeTimer = setTimeout(() => disarmRevoke(name), 5000);
      return;
    }
    disarmRevoke();
    vaultError = null;
    try {
      await api.vaultRevoke({ name });
      await loadVault();
    } catch (err) {
      vaultError = String(err);
    }
  }

  const themeModes: Array<{ mode: ThemeMode; label: string }> = [
    { mode: "system", label: "Follow OS" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];
</script>

<PageHeader
  eyebrow="This machine only"
  title="Settings"
  subtitle="Providers you explicitly configure are the only network egress. Secrets live in the OS keychain — never in config files."
>
  {#snippet actions()}
    {#if savedAt}
      <span
        class="animate-fade-in flex items-center gap-1.5 text-[12px] text-success"
        role="status"
      >
        <Icon name="check" size={13} />
        Saved
      </span>
    {/if}
    <button
      class="btn btn-primary"
      onclick={save}
      disabled={saving || !s || moving}
    >
      {saving ? "Saving…" : "Save changes"}
    </button>
  {/snippet}
</PageHeader>

{#if saveError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    Could not save settings: {saveError}
  </p>
{/if}

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load settings" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={load}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if !s}
  <div class="card"><Skeleton rows={8} /></div>
{:else}
  <div class="space-y-4">
    <!-- appearance -->
    <section class="card p-4">
      <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="monitor" size={15} class="text-t3" />
        Appearance
      </h2>
      <p class="mb-3 text-[12px] text-t3">
        Dark is first-class; the app follows your OS unless you override it.
      </p>
      <div
        class="inline-flex items-center gap-0.5 rounded-lg border border-line p-0.5"
        role="group"
        aria-label="Theme"
      >
        {#each themeModes as t (t.mode)}
          <button
            class="rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors
              {theme.mode === t.mode
              ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
              : 'text-t2 hover:bg-sunken'}"
            aria-pressed={theme.mode === t.mode}
            onclick={() => {
              theme.set(t.mode);
              // Keep the persisted setting in step with the live theme so
              // "Save changes" never silently reverts the choice.
              if (s) s.theme = t.mode;
            }}
          >
            {t.label}
          </button>
        {/each}
      </div>
    </section>

    <!-- book -->
    <section class="card p-4">
      <h2 class="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="ledger" size={15} class="text-t3" />
        Book
      </h2>
      {#if book}
        <dl class="grid grid-cols-[9rem_1fr] gap-y-2 text-[12.5px]">
          <dt class="text-t3">Name</dt>
          <dd class="font-medium">{book.name}</dd>
          <dt class="text-t3">Kind</dt>
          <dd>
            <Badge tone="neutral" dot={false} label={book.kind} />
          </dd>
          <dt class="text-t3">Region</dt>
          <dd>
            {book.region_name}
            <span class="ml-1 font-mono text-[10.5px] text-t3">{book.region}</span>
          </dd>
          <dt class="text-t3">Currency</dt>
          <dd class="num">{book.currency}</dd>
          <dt class="text-t3">Tax report</dt>
          <dd>{book.tax_report_name}</dd>
          <dt class="text-t3">Database file</dt>
          <dd class="num break-all text-t2">{book.file_path}</dd>
        </dl>
        <p class="mt-3 text-[11px] text-t3">
          Regions are data, not code: the region profile picked at book
          creation drives the chart of accounts, tax rates and report labels.
        </p>
      {:else}
        <p class="text-[12.5px] text-t3">No book configured.</p>
      {/if}
    </section>

    <!-- data & backup: one movable folder, backed up by the user's own cloud -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="folder" size={15} class="text-t3" />
          Data &amp; backup
        </h2>
        <div class="flex items-center gap-1.5">
          {#if movedAt}
            <span
              class="animate-fade-in flex items-center gap-1.5 text-[12px] text-success"
              role="status"
            >
              <Icon name="check" size={13} />
              Moved
            </span>
          {/if}
          {#if dataStatus?.cloud_sync_hint}
            <Badge tone="success" label="inside {dataStatus.cloud_sync_hint}" />
          {:else if dataStatus?.is_default_location}
            <Badge tone="neutral" dot={false} label="default location" />
          {/if}
        </div>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Everything durable — the database and your original documents — lives
        in this one folder. Move it anywhere: an external drive, your
        Documents, a NAS mount. The CLI and self-host server follow the same
        pointer, so every surface agrees on where your data is.
      </p>

      {#if dataLoadError}
        <EmptyState
          icon="alert-circle"
          title="Could not read the data folder status"
          body={dataLoadError}
        >
          {#snippet actions()}
            <button class="btn" onclick={loadDataStatus}>Retry</button>
          {/snippet}
        </EmptyState>
      {:else if !dataStatus}
        <Skeleton rows={2} />
      {:else}
        <div class="flex items-center gap-3 rounded-lg border border-line bg-sunken/40 p-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
          >
            <Icon name="folder" size={15} />
          </span>
          <span class="min-w-0 flex-1 leading-tight">
            <span class="block truncate font-mono text-[12px] font-medium">
              {dataStatus.data_dir}
            </span>
            <span class="num block text-[10.5px] text-t3">
              database {fmtBytes(dataStatus.db_size_bytes)} ·
              {dataStatus.document_count}
              {dataStatus.document_count === 1 ? "document" : "documents"}
              ({fmtBytes(dataStatus.documents_size_bytes)})
            </span>
          </span>
          <div class="flex shrink-0 items-center gap-1.5">
            <button class="btn h-7" onclick={copyDataPath} disabled={moving}>
              {#if pathCopied}
                <Icon name="check" size={13} />
                Copied
              {:else}
                Copy path
              {/if}
            </button>
            {#if moveStage === "idle"}
              <button class="btn h-7" onclick={openMoveForm} disabled={moving}>
                <Icon name="arrow-right" size={13} />
                Move…
              </button>
            {/if}
          </div>
        </div>

        {#if moving}
          <p
            class="mt-3 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] text-warning"
            role="status"
          >
            <Icon name="refresh" size={13} class="animate-spin" />
            Moving your data — copying, verifying checksums, then switching
            over. SlipScan is read-only until this finishes.
          </p>
        {:else if moveStage !== "idle"}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
               Escape-to-close only; interaction lives on the inputs/buttons. -->
          <form
            class="mt-3 space-y-3 rounded-lg border border-line bg-sunken/40 p-3"
            onsubmit={(e) => {
              e.preventDefault();
              if (moveStage === "form" && moveTarget.trim()) {
                moveError = null;
                moveStage = "confirm";
              }
            }}
            onkeydown={(e) => {
              if (e.key === "Escape") cancelMove();
            }}
          >
            {#if moveError}
              <p
                class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
              >
                <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
                <span>{moveError}</span>
              </p>
            {/if}

            {#if moveStage === "form"}
              <label class="block">
                <span class="mb-1 block text-[11.5px] font-medium text-t2">
                  New data folder — pick one your own cloud syncs to make it
                  your backup
                </span>
                <input
                  class="input font-mono"
                  placeholder="e.g. ~/Documents/SlipScan, or a folder inside iCloud Drive / Dropbox"
                  bind:this={moveInput}
                  bind:value={moveTarget}
                  required
                />
              </label>
              <div class="flex items-center gap-2">
                <button
                  class="btn btn-primary h-7"
                  type="submit"
                  disabled={!moveTarget.trim()}
                >
                  Continue
                </button>
                <button class="btn btn-ghost h-7" type="button" onclick={cancelMove}>
                  Cancel
                </button>
              </div>
            {:else}
              <div
                class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[12px]"
              >
                <span class="min-w-0 truncate rounded-md border border-line bg-surface px-2 py-1.5 font-mono">
                  {dataStatus.data_dir}
                </span>
                <Icon name="arrow-right" size={14} class="text-t3" />
                <span class="min-w-0 truncate rounded-md border border-accent-ring/40 bg-surface px-2 py-1.5 font-mono">
                  {moveTarget.trim()}
                </span>
              </div>
              <p class="text-[11.5px] text-t3">
                SlipScan copies the database and documents, verifies every
                file's checksum, opens the copy to check it, switches over
                atomically, and only then removes the old copy. The app is
                read-only while this runs.
              </p>
              <div class="flex items-center gap-2">
                {#if targetHasDb}
                  <button
                    class="btn btn-primary h-7"
                    type="button"
                    onclick={() => runMove(true)}
                  >
                    Open that folder's data instead
                  </button>
                {:else}
                  <button
                    class="btn btn-primary h-7"
                    type="button"
                    onclick={() => runMove(false)}
                  >
                    Move data
                  </button>
                {/if}
                <button
                  class="btn btn-ghost h-7"
                  type="button"
                  onclick={() => {
                    moveError = null;
                    moveStage = "form";
                  }}
                >
                  Back
                </button>
                <button class="btn btn-ghost h-7" type="button" onclick={cancelMove}>
                  Cancel
                </button>
              </div>
            {/if}
          </form>
        {/if}

        <!-- backup guidance — the contract's words, next to the folder -->
        <div class="mt-3 rounded-lg border border-line bg-sunken/40 p-3">
          <p class="text-[12px] font-medium">
            Your data lives in this folder. Sync it with your own cloud
            (iCloud Drive, Dropbox, Syncthing, Nextcloud, NAS) — SlipScan
            ships no backup service; backing up is yours.
          </p>
          <p class="mt-1.5 flex items-start gap-1.5 text-[11px] text-t3">
            <Icon name="key" size={12} class="mt-0.5 shrink-0" />
            <span>
              Credentials never travel with the folder: the vault's key stays
              in this machine's OS keychain, so a synced or copied folder
              alone yields no secrets — and restoring on a new machine means
              re-entering them once.
            </span>
          </p>
        </div>
      {/if}
    </section>

    <!-- exchange rates (OpenRate) -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="transactions" size={15} class="text-t3" />
          Exchange rates (OpenRate)
        </h2>
        <Badge
          tone={fx?.configured ? "accent" : "neutral"}
          label={fx?.configured ? "on" : "off"}
        />
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Opt-in: with no endpoint configured, SlipScan makes zero FX network
        calls. Rates are fetched only when you ask, cached locally with their
        quality grade and timestamps, and conversions always reuse the
        recorded rate — reports reproduce offline.
      </p>

      {#if fxError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <Icon name="alert-circle" size={13} />
          {fxError}
        </p>
      {/if}

      <form
        class="mb-3 flex flex-wrap items-center gap-2"
        onsubmit={(e) => {
          e.preventDefault();
          saveFxUrl();
        }}
      >
        <input
          class="input min-w-48 flex-1 font-mono"
          placeholder="https://your-openrate-instance — leave empty to keep FX off"
          bind:value={fxUrl}
        />
        <button class="btn btn-primary h-7" type="submit" disabled={fxSaving}>
          {fxSaving ? "Saving…" : "Save endpoint"}
        </button>
      </form>

      {#if fx?.configured}
        <form
          class="mb-3 flex items-center gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            fetchFxRate(fxFrom.trim(), fxTo.trim(), "new");
          }}
        >
          <input
            class="input w-24 font-mono uppercase"
            placeholder="USD"
            maxlength={3}
            bind:value={fxFrom}
            aria-label="From currency"
          />
          <span class="text-[12px] text-t3">→</span>
          <input
            class="input w-24 font-mono uppercase"
            placeholder={book?.currency ?? "EUR"}
            maxlength={3}
            bind:value={fxTo}
            aria-label="To currency"
          />
          <button
            class="btn h-7"
            type="submit"
            disabled={fxBusy !== null ||
              fxFrom.trim().length !== 3 ||
              fxTo.trim().length !== 3}
          >
            <Icon name="refresh" size={13} />
            {fxBusy === "new" ? "Fetching…" : "Fetch rate"}
          </button>
        </form>
      {/if}

      {#if fx && fx.cached_rates.length > 0}
        <ul class="divide-y divide-line">
          {#each fx.cached_rates as r (`${r.from_currency}/${r.to_currency}`)}
            {@const pair = `${r.from_currency}/${r.to_currency}`}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span class="min-w-0 flex-1 leading-tight">
                <span class="num block text-[12.5px] font-medium">
                  {pair} · {r.rate}
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  as of {fmtRelative(r.as_of)} · grade {r.grade} · fetched
                  {fmtRelative(r.fetched_at)}
                  {#if isStale(r)}
                    · <span class="text-warning">stale</span>
                  {/if}
                </span>
              </span>
              <button
                class="btn h-7 shrink-0"
                onclick={() => fetchFxRate(r.from_currency, r.to_currency, pair)}
                disabled={fxBusy !== null}
              >
                <Icon name="refresh" size={13} />
                {fxBusy === pair ? "Refreshing…" : "Refresh"}
              </button>
            </li>
          {/each}
        </ul>
      {:else if fx?.configured}
        <p class="text-[12.5px] text-t3">
          No cached rates yet — fetch a currency pair above.
        </p>
      {/if}
    </section>

    <!-- llm provider -->
    <section class="card p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="sparkle" size={15} class="text-t3" />
          Receipt extraction (LLM)
        </h2>
        <Badge
          tone={s.llm.provider === "none" ? "neutral" : "accent"}
          label={s.llm.provider === "none" ? "off" : s.llm.provider}
        />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2"
            >Provider</span
          >
          <select class="input" bind:value={s.llm.provider}>
            <option value="none">None — manual entry only</option>
            <option value="local">Local model</option>
            <option value="openai-compatible">OpenAI-compatible endpoint</option>
            <option value="anthropic">Anthropic (BYO key)</option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Model</span>
          <input
            class="input"
            placeholder="e.g. a vision-capable model"
            bind:value={s.llm.model}
          />
        </label>
        <label class="block sm:col-span-2">
          <span class="mb-1 block text-[11.5px] font-medium text-t2"
            >Endpoint (local / self-hosted)</span
          >
          <input
            class="input font-mono"
            placeholder="http://localhost:11434"
            bind:value={s.llm.endpoint}
          />
        </label>
      </div>
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
        <Icon name="key" size={12} />
        Store the API key in the Credential vault below (e.g. as
        <span class="font-mono">llm.api_key</span>) — it is envelope-encrypted
        and write-only, never in SQLite or config files.
      </p>
      <p class="mt-1.5 text-[11px] text-t3">
        Extraction currently runs via the CLI (slipscan extract); in-app
        extraction is on the roadmap.
      </p>
    </section>

    <!-- mailbox -->
    <section class="card p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="mail" size={15} class="text-t3" />
          Email ingest (IMAP)
        </h2>
        <label class="flex items-center gap-2 text-[12px] text-t2">
          <input type="checkbox" bind:checked={s.mailbox.enabled} />
          Enabled
        </label>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Host</span>
          <input
            class="input font-mono"
            placeholder="imap.example.com"
            bind:value={s.mailbox.host}
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Port</span>
          <input class="input font-mono" type="number" bind:value={s.mailbox.port} />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2"
            >Username</span
          >
          <input
            class="input"
            placeholder="you@example.com"
            bind:value={s.mailbox.username}
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Folder</span>
          <input class="input font-mono" bind:value={s.mailbox.folder} />
        </label>
      </div>
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
        <Icon name="mail" size={12} />
        Mail polling currently runs via the CLI (slipscan mail-sync); the
        password lives in the OS keychain, never here.
      </p>
    </section>

    <!-- bank connections (scraper adapters) -->
    <section class="card p-4">
      <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="bank" size={15} class="text-t3" />
        Bank connections
      </h2>
      <p class="mb-3 text-[12px] text-t3">
        Scraper adapters run bank sessions on this machine. Credentials live in
        the vault; only status metadata is shown here.
      </p>
      {#if s.scrapers.length === 0}
        <EmptyState
          icon="bank"
          title="No bank connections"
          body="Statement CSV import works today (via the CLI); live scraper adapters are on the roadmap."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each s.scrapers as sc (sc.id)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span
                class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
              >
                <Icon name="bank" size={15} />
              </span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">
                  {sc.institution}
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {sc.adapter}
                  {#if sc.last_sync}· last sync {fmtRelative(sc.last_sync)}{/if}
                </span>
              </span>
              <Badge
                tone={sc.status === "connected"
                  ? "success"
                  : sc.status === "needs_attention"
                    ? "warning"
                    : "neutral"}
                label={sc.status === "needs_attention"
                  ? "needs re-auth"
                  : sc.status}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- credential vault -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="key" size={15} class="text-t3" />
          Credential vault
        </h2>
        <button class="btn h-7" onclick={toggleAddForm}>
          <Icon name="plus" size={13} />
          Add credential
        </button>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Write-only: secrets can be set, rotated and revoked — never viewed.
        Only a label, timestamps and a fingerprint are stored in the clear.
      </p>

      {#if vaultError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <Icon name="alert-circle" size={13} />
          {vaultError}
        </p>
      {/if}

      {#if showAddForm}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
             the keydown handler only closes the form on Escape (a11y win);
             all interaction happens on the inputs/buttons inside. -->
        <form
          class="mb-4 grid gap-3 rounded-lg border border-line bg-sunken/40 p-3 sm:grid-cols-2"
          onsubmit={(e) => {
            e.preventDefault();
            addCredential();
          }}
          onkeydown={(e) => {
            if (e.key === "Escape") closeAddForm();
          }}
        >
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
            <input
              class="input font-mono"
              placeholder="imap.password.fastmail"
              bind:this={addNameInput}
              bind:value={addName}
              required
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Label (optional)</span
            >
            <input
              class="input"
              placeholder="Fastmail app password"
              bind:value={addLabel}
            />
          </label>
          <label class="block sm:col-span-2">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Secret — write-only, it can never be read back</span
            >
            <input
              class="input font-mono"
              type="password"
              autocomplete="off"
              placeholder="paste the password / API key / token"
              bind:value={addSecret}
              required
            />
          </label>
          <div class="flex items-center gap-2 sm:col-span-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={addBusy || !addName.trim() || !addSecret}
            >
              {addBusy ? "Storing…" : "Store in vault"}
            </button>
            <button class="btn btn-ghost h-7" type="button" onclick={closeAddForm}>
              Cancel
            </button>
          </div>
        </form>
      {/if}

      {#if vaultLoadError}
        <EmptyState
          icon="alert-circle"
          title="Could not read the vault"
          body="The credential list is unavailable — this does not mean the vault is empty. {vaultLoadError}"
        >
          {#snippet actions()}
            <button class="btn" onclick={loadVault}>Retry</button>
          {/snippet}
        </EmptyState>
      {:else if credentials.length === 0}
        <EmptyState
          icon="key"
          title="No credentials stored"
          body="IMAP passwords, LLM API keys and bank-scraper logins live here, envelope-encrypted under a key that only exists in your OS keychain."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each credentials as c (c.name)}
            <li class="py-2.5 first:pt-0 last:pb-0">
              <div class="flex items-center gap-3">
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
                >
                  <Icon name="key" size={15} />
                </span>
                <span class="min-w-0 flex-1 leading-tight">
                  <span class="block text-[12.5px] font-medium">
                    {c.label ?? c.name}
                    {#if c.version > 1}
                      <span class="num text-[10.5px] text-t3">v{c.version}</span>
                    {/if}
                  </span>
                  <span class="block truncate font-mono text-[10.5px] text-t3">
                    {c.name} · fp {c.fingerprint} · added {fmtDate(c.created_at)}
                    {#if c.rotated_at}· rotated {fmtDate(c.rotated_at)}{/if}
                    {#if c.last_used_at}· used {fmtRelative(c.last_used_at)}{/if}
                  </span>
                </span>
                <div class="flex shrink-0 items-center gap-1.5">
                  <button class="btn h-7" onclick={() => toggleRotate(c.name)}>
                    <Icon name="refresh" size={13} />
                    Replace
                  </button>
                  <button
                    class="btn btn-danger h-7"
                    onclick={() => revokeCredential(c.name)}
                    onmouseleave={() => disarmRevoke(c.name)}
                    onblur={() => disarmRevoke(c.name)}
                    onkeydown={(e) => {
                      if (e.key === "Escape") disarmRevoke(c.name);
                    }}
                  >
                    <Icon name="trash" size={13} />
                    {revokeArmed === c.name ? "Really revoke?" : "Revoke"}
                  </button>
                </div>
              </div>
              {#if rotating === c.name}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
                     Escape-to-close only; interaction lives on the input/button. -->
                <form
                  class="mt-2 flex items-center gap-2 pl-11"
                  onsubmit={(e) => {
                    e.preventDefault();
                    replaceCredential(c.name);
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Escape") {
                      rotating = null;
                      rotateSecret = "";
                    }
                  }}
                >
                  <input
                    class="input font-mono flex-1"
                    type="password"
                    autocomplete="off"
                    placeholder="new secret — the old one is destroyed"
                    bind:this={rotateSecretInput}
                    bind:value={rotateSecret}
                    required
                  />
                  <button
                    class="btn btn-primary h-7"
                    type="submit"
                    disabled={rotateBusy || !rotateSecret}
                  >
                    {rotateBusy ? "Rotating…" : "Rotate"}
                  </button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- packs -->
    <section class="card p-4">
      <h2 class="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="package" size={15} class="text-t3" />
        Classification packs
      </h2>
      {#if s.packs.length === 0}
        <EmptyState
          icon="package"
          title="No packs installed"
          body="Packs share category taxonomies and classification rules — never data. Each pack is ed25519-signed and verified on install. Install from the CLI: slipscan pack install."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each s.packs as p (p.id)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span
                class="flex size-8 items-center justify-center rounded-md bg-sunken text-t3"
              >
                <Icon name="package" size={15} />
              </span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">
                  {p.name}
                  <span class="num text-t3">v{p.version}</span>
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {p.publisher} · {p.signer_fingerprint} · installed
                  {fmtDate(p.installed_at)}
                </span>
              </span>
              <Badge tone="success" label="verified" />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- privacy -->
    <section
      class="card border-accent-ring/30 bg-accent/[0.04] p-4 dark:bg-accent/[0.03]"
    >
      <h2 class="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="shield" size={15} class="text-accent-ring dark:text-accent" />
        Privacy, non-negotiable
      </h2>
      <ul class="space-y-1 text-[12px] text-t2">
        <li>· No telemetry, no analytics, no default network calls.</li>
        <li>
          · Egress only to endpoints you configured above — your LLM, your
          IMAP server, your bank session.
        </li>
        <li>
          · Your data is one folder — a SQLite file plus your documents —
          that you can move, sync, back up, or delete.
        </li>
      </ul>
    </section>
  </div>
{/if}
