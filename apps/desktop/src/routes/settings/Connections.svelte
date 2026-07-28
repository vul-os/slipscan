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
  import { router } from "../../lib/router.svelte";
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

  <!--
    Bank connections.

    This panel used to render `settings.scrapers` as a live list, with an
    empty state behind it. `scrapers` is a SettingsDto field with no writer on
    any surface — no CLI command, no server route, nothing in this app — so
    the list branch could only ever be reached by the browser mock, which
    filled it with two fabricated banks. That made the dev shell and the
    documentation screenshots show connected accounts the product cannot
    have. The unreachable branch is gone; what is left is the true state,
    stated once.
  -->
  <section class="card p-4">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="bank" size={15} class="text-t3" />
        Bank connections
      </h2>
      <Badge tone="neutral" dot={false} label="not implemented" />
    </div>
    <p class="mb-3 text-[12px] text-t3">
      The design is scraper adapters running bank sessions on this machine,
      with their logins in the vault. None of it is built — there is no
      adapter to configure and nothing to connect.
    </p>
    <EmptyState
      icon="bank"
      title="No bank connections, and none possible yet"
      body="Getting transactions in today means importing a statement CSV, which SlipScan does well: slipscan import on the CLI, then Reconcile to match it against what you already have."
    />
  </section>

  <!--
    Payments registers webhook URLs, and those are egress. A tab that opens by
    claiming to hold "every configured egress in one place" has to either list
    them or point at them, or it is quietly incomplete.
  -->
  <section class="card p-4">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="zap" size={15} class="text-t3" />
        Webhook endpoints
      </h2>
      <button class="btn h-7" onclick={() => router.go("payments")}>
        Open Payments
        <Icon name="arrow-right" size={13} />
      </button>
    </div>
    <p class="text-[12px] text-t3">
      The one other place SlipScan can reach the network is the endpoints you
      register on Payments, which receive a signed POST when a watched
      reference code turns up. They are configured there, next to the watch
      codes that trigger them, and they only ever fire on a delivery you
      queued or ran.
    </p>
  </section>
</div>
