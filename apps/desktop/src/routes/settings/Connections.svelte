<script lang="ts">
  /**
   * Connections tab: every configured egress in one place — exchange rates,
   * receipt extraction, email ingest, bank connections. Reading FX status is
   * purely local; the network is touched only by the explicit fetch/refresh
   * buttons below.
   *
   * The LLM, mailbox and scraper fields live in the settings blob the shell
   * owns and saves, so `settings` is bound rather than copied.
   */
  import { api } from "../../lib/api/client";
  import type { Book, FxCachedRate, FxStatus, Settings } from "../../lib/api/types";
  import { fmtRelative } from "../../lib/format";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Badge from "../../lib/components/Badge.svelte";
  import Icon from "../../lib/components/Icon.svelte";

  let {
    settings = $bindable(),
    book,
  }: {
    settings: Settings;
    book: Book | null;
  } = $props();

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
  loadFx();

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
</script>

<div class="space-y-4">
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
          <li class="row-hover flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
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
        tone={settings.llm.provider === "none" ? "neutral" : "accent"}
        label={settings.llm.provider === "none" ? "off" : settings.llm.provider}
      />
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Provider</span
        >
        <select class="input" bind:value={settings.llm.provider}>
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
          bind:value={settings.llm.model}
        />
      </label>
      <label class="block sm:col-span-2">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Endpoint (local / self-hosted)</span
        >
        <input
          class="input font-mono"
          placeholder="http://localhost:11434"
          bind:value={settings.llm.endpoint}
        />
      </label>
    </div>
    <p class="mt-3 flex items-start gap-1.5 text-[11px] text-t3">
      <Icon name="key" size={12} class="mt-0.5 shrink-0" />
      <span>
        Store the API key in the Credential vault tab (e.g. as
        <span class="font-mono">llm.api_key</span>) — it is
        envelope-encrypted and write-only, never in SQLite or config files.
      </span>
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
        <input type="checkbox" bind:checked={settings.mailbox.enabled} />
        Enabled
      </label>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Host</span>
        <input
          class="input font-mono"
          placeholder="imap.example.com"
          bind:value={settings.mailbox.host}
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Port</span>
        <input class="input font-mono" type="number" bind:value={settings.mailbox.port} />
      </label>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Username</span
        >
        <input
          class="input"
          placeholder="you@example.com"
          bind:value={settings.mailbox.username}
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Folder</span>
        <input class="input font-mono" bind:value={settings.mailbox.folder} />
      </label>
    </div>
    <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
      <Icon name="mail" size={12} />
      Mail polling currently runs via the CLI (slipscan mail-sync); the
      password lives in the OS keychain, never here.
    </p>
  </section>

  <!-- bank connections (scraper adapters). `settings.scrapers` is a
       SettingsDto field that defaults to an empty list and that nothing in
       this app writes, so outside the browser mock this list is always the
       empty state below. -->
  <section class="card p-4">
    <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
      <Icon name="bank" size={15} class="text-t3" />
      Bank connections
    </h2>
    <p class="mb-3 text-[12px] text-t3">
      Scraper adapters run bank sessions on this machine. Credentials live in
      the vault; only status metadata is shown here.
    </p>
    {#if settings.scrapers.length === 0}
      <EmptyState
        icon="bank"
        title="No bank connections"
        body="Statement CSV import works today (via the CLI); live scraper adapters are on the roadmap."
      />
    {:else}
      <ul class="divide-y divide-line">
        {#each settings.scrapers as sc (sc.id)}
          <li class="row-hover flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
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
</div>
