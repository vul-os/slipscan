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
  import { router } from "../../lib/state/router.svelte";
  import type {
    Account,
    Book,
    FxCachedRate,
    FxStatus,
    InstalledPackInfo,
    Settings,
    WatchFolderStatus,
  } from "../../lib/api/types";
  import { fmtRelative } from "../../lib/util/format";
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
  void loadFx();

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

  // -- watch folder -----------------------------------------------------------
  // Local drop-folder watching (ROADMAP.md "Phase 2 ... Slip/receipt
  // capture") — the desktop wiring for the engine `slipscan watch` already
  // runs on the CLI. Not egress (nothing here ever touches the network),
  // but it is the one control on this screen that keeps something running
  // without being asked again for every file, so its lifecycle gets stated
  // as plainly as the mailbox panel below states its own gaps.

  let watch = $state<WatchFolderStatus | null>(null);
  let watchFolderInput = $state("");
  let watchBusy = $state(false);
  let watchError = $state<string | null>(null);

  async function loadWatch() {
    watchError = null;
    try {
      watch = await api.watchFolderStatus();
      watchFolderInput = watch.folder ?? "";
    } catch (err) {
      watchError = String(err);
    }
  }
  void loadWatch();

  async function setWatch(enabled: boolean) {
    watchBusy = true;
    watchError = null;
    try {
      watch = await api.watchFolderSet({
        enabled,
        folder: enabled ? watchFolderInput.trim() : (watch?.folder ?? null),
      });
    } catch (err) {
      watchError = String(err);
    } finally {
      watchBusy = false;
    }
  }

  // -- bank-alert emails ------------------------------------------------------
  // The engine is real (`slipscan mail-sync --alerts --account …`, which feeds
  // parsed alerts into the same statement-import path a CSV takes, so dedupe,
  // categorisation and payment detection are inherited rather than
  // reimplemented). What is *not* real is a bank format: **no bank patterns
  // ship**. Every format is a signed `mailrules` pack the community publishes
  // and the user installs per book, so this panel's honest job is to report
  // whether this book has one and to hand over the exact command — not to
  // present a switch that would do nothing.

  let mailrulesPacks = $state<InstalledPackInfo[] | null>(null);
  let alertAccounts = $state<Account[]>([]);
  let alertAccountId = $state("");
  let alertLoadError = $state<string | null>(null);
  let alertCopied = $state(false);

  async function loadAlertReadiness() {
    if (!book) {
      mailrulesPacks = [];
      return;
    }
    alertLoadError = null;
    try {
      const [packs, accounts] = await Promise.all([
        api.packList({ book_id: book.id }),
        api.accountList({ book_id: book.id }),
      ]);
      mailrulesPacks = packs.filter((p) => p.kind === "mailrules");
      alertAccounts = accounts;
      alertAccountId = accounts[0]?.id ?? "";
    } catch (err) {
      mailrulesPacks = [];
      alertLoadError = String(err);
    }
  }
  void loadAlertReadiness();

  /** The command to run, with the chosen account already in it. `--account`
   * is required by the CLI precisely because alerts have to be booked
   * somewhere, and guessing which card is not something this pipeline does. */
  const alertCommand = $derived(
    `slipscan mail-sync --alerts --account ${
      alertAccounts.find((a) => a.id === alertAccountId)?.name ?? "<account>"
    }`,
  );

  async function copyAlertCommand() {
    try {
      await navigator.clipboard.writeText(alertCommand);
      alertCopied = true;
      setTimeout(() => (alertCopied = false), 2000);
    } catch {
      alertCopied = false;
    }
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
        void saveFxUrl();
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
          void fetchFxRate(fxFrom.trim(), fxTo.trim(), "new");
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
    <!--
      What these fields actually are, stated plainly.

      They are saved into the desktop's own `desktop.settings` blob.
      `slipscan mail-sync` reads a *different* settings key
      (`mail.imap.config`), so filling these in does not configure a sync —
      and the previous wording here ("mail polling currently runs via the
      CLI") read as though it did. Same defect the Bank connections panel
      below was corrected for: a form whose values nothing consumes.
    -->
    <p
      class="mt-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
    >
      <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
      <span>
        Polling runs from the CLI, and it reads its own settings key —
        <span class="font-mono">mail.imap.config</span> — not these fields.
        What you enter here is the desktop's record of the mailbox and nothing
        consumes it yet, so a sync has to be configured for
        <span class="font-mono">slipscan mail-sync</span> separately. The
        password never belongs here either way: store it in the Credential
        vault and name that entry in the CLI's config.
      </span>
    </p>
  </section>

  <!-- watch folder -->
  <section class="card p-4">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="folder" size={15} class="text-t3" />
        Watch folder
      </h2>
      <Badge
        tone={watch?.running ? "accent" : "neutral"}
        label={watch?.running ? "watching" : watch?.enabled ? "not running" : "off"}
      />
    </div>
    <p class="mb-3 text-[12px] text-t3">
      Point SlipScan at a drop folder and it imports anything already
      there, then keeps importing as files land — the same engine
      <span class="font-mono">slipscan watch</span> runs on the CLI, wired
      into the app and going through the same import path the Receipts file
      picker uses.
    </p>

    <!-- The lifecycle, stated once and not softened. -->
    <p
      class="mb-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
    >
      <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
      <span>
        <span class="font-medium">This only watches while SlipScan is open.</span>
        Closing the app stops it — there is no separate background process,
        and nothing here ever touches the network. It resumes on its own the
        next time you open SlipScan, if it was still on. For a folder that
        needs watching whether or not the app is running, use
        <span class="font-mono">slipscan watch &lt;dir&gt;</span> from the CLI
        instead (<span class="font-mono">--once</span> for cron or launchd).
      </span>
    </p>

    {#if watchError}
      <p
        class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} />
        {watchError}
      </p>
    {/if}

    {#if watch?.last_error}
      <p
        class="mb-3 flex items-center gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] text-warning"
        role="alert"
      >
        <Icon name="alert-circle" size={13} />
        Stopped: {watch.last_error}
      </p>
    {/if}

    <div class="flex flex-wrap items-end gap-2">
      <label class="block min-w-56 flex-1">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Folder</span>
        <input
          class="input font-mono"
          placeholder="e.g. ~/Documents/SlipScan Drop"
          bind:value={watchFolderInput}
          disabled={watchBusy || watch?.running}
        />
      </label>
      {#if watch?.running}
        <button class="btn h-8" onclick={() => setWatch(false)} disabled={watchBusy}>
          {watchBusy ? "Stopping…" : "Stop watching"}
        </button>
      {:else}
        <button
          class="btn btn-primary h-8"
          onclick={() => setWatch(true)}
          disabled={watchBusy || !watchFolderInput.trim()}
        >
          {watchBusy ? "Starting…" : "Start watching"}
        </button>
      {/if}
    </div>

    {#if watch?.running}
      <p class="mt-2 text-[11px] text-t3">
        Watching <span class="font-mono">{watch.folder}</span>
        {#if watch.book_name}into "{watch.book_name}"{/if} ·
        {watch.imported_count}
        {watch.imported_count === 1 ? "file" : "files"} imported since it
        started{#if watch.started_at}
          ({fmtRelative(watch.started_at)}){/if}.
      </p>
    {/if}
  </section>

  <!--
    Bank-alert emails.

    Sits beside the mailbox above because it reads the same mailbox. The
    engine ships and works; the *formats* do not — and that distinction is the
    whole content of this panel. Announcing "bank alerts supported" with no
    pack installed would be the exact overstatement the Payments screen had to
    be corrected for in the other direction.
  -->
  <section class="card p-4">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="inbox" size={15} class="text-t3" />
        Bank-alert emails
      </h2>
      <Badge
        tone={mailrulesPacks && mailrulesPacks.length > 0 ? "accent" : "neutral"}
        label={mailrulesPacks === null
          ? "checking…"
          : mailrulesPacks.length > 0
            ? `${mailrulesPacks.length} mailrules pack${mailrulesPacks.length === 1 ? "" : "s"}`
            : "no bank patterns installed"}
      />
    </div>
    <p class="mb-3 text-[12px] text-t3">
      The most common way money visibly moves is your bank emailing you that a
      card was used. SlipScan can turn those messages into transactions — they
      go through the same import path a statement CSV does, so duplicates are
      collapsed, your categorisation rules apply, and a watched reference code
      still fires.
    </p>

    <!--
      The caveat that makes the rest true. Not one bank, country or currency
      appears in this codebase: the formats are data.
    -->
    <p
      class="mb-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
    >
      <Icon name="package" size={13} class="mt-0.5 shrink-0 text-t3" />
      <span>
        <span class="font-medium">No bank patterns ship with SlipScan</span>, so
        until you install a <span class="font-mono">mailrules</span> pack for
        your bank this does nothing at all. That is deliberate: a pattern that
        misreads an amount does not just miss a transaction, it writes a wrong
        one and teaches the learning loop to keep being wrong. Rules are signed,
        versioned packs you install per book — never guesses, and never
        code.
      </span>
    </p>

    {#if alertLoadError}
      <p
        class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
      >
        <Icon name="alert-circle" size={13} />
        Could not check which packs this book has: {alertLoadError}
      </p>
    {/if}

    {#if mailrulesPacks && mailrulesPacks.length > 0}
      <ul class="mb-3 divide-y divide-line">
        {#each mailrulesPacks as p (p.pack_id)}
          <li class="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
            <span class="min-w-0 flex-1 leading-tight">
              <span class="block text-[12.5px] font-medium">{p.name}</span>
              <span class="block truncate font-mono text-[10.5px] text-t3">
                {p.pack_id} · v{p.version} · signer {p.signer_fingerprint}
              </span>
            </span>
          </li>
        {/each}
      </ul>
    {:else if mailrulesPacks !== null}
      <div class="mb-3 rounded-lg border border-line bg-sunken/40">
        <EmptyState
          icon="package"
          title="No mailrules pack for your bank"
          body="Add a pack source on Packs and install one, or point Packs at a file a publisher gave you. Nothing is contacted until you name a source."
        >
          {#snippet actions()}
            <button class="btn" onclick={() => router.go("packs")}>
              Open Packs
              <Icon name="arrow-right" size={13} />
            </button>
          {/snippet}
        </EmptyState>
      </div>
    {/if}

    <!-- How to actually run it. The desktop does not poll mail — same as the
         IMAP panel above — so the honest surface is the exact command. -->
    <div class="rounded-lg border border-line bg-sunken/40 p-3">
      <p class="mb-2 text-[11.5px] font-medium text-t2">
        Run a sync from the CLI
      </p>
      <div class="flex flex-wrap items-center gap-2">
        {#if alertAccounts.length > 0}
          <label class="block">
            <span class="mb-1 block text-[11px] text-t3">Book alerts to</span>
            <select class="input" bind:value={alertAccountId}>
              {#each alertAccounts as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
          </label>
        {/if}
        <span class="min-w-0 flex-1">
          <span class="mb-1 block text-[11px] text-t3">Command</span>
          <code
            class="block overflow-x-auto rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11.5px] select-all"
            >{alertCommand}</code
          >
        </span>
        <button class="btn h-7 self-end" onclick={copyAlertCommand}>
          <Icon name="copy" size={13} />
          {alertCopied ? "Copied" : "Copy"}
        </button>
      </div>
      <p class="mt-2 text-[11px] leading-relaxed text-t3">
        Needs a mailbox configured for the CLI first — see the note in Email
        ingest above; the fields in that panel are not it. One account per run:
        alerts are booked to the account you name, and an
        alert whose card digits contradict that account is declined rather than
        filed against the wrong card. Sorting several cards automatically by
        those digits is not wired to anything — the library can do it, no
        surface calls it, so today you run this once per account. Anything a
        rule cannot read with certainty is declined with a reason instead of
        guessed.
      </p>
    </div>
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
