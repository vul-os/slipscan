<script lang="ts">
  /**
   * First-run setup.
   *
   * Offered by itself only when `book_list` comes back empty and the user
   * has not already dismissed it (see onboarding.svelte.ts, which owns that
   * gate and the persistence), and openable on demand from the command
   * palette's "Set up a new book". Escape, the scrim and "Skip setup" all
   * close it; it never blocks the app.
   *
   * The region step creates the book: `book_create` is a registered IPC
   * command, so the region and currency chosen here become an actual book —
   * with the chart of accounts, tax rate table and tax-report name that
   * profile prescribes — rather than a preference nothing reads.
   *
   * What it is still careful not to lie about, because the honest caveat is
   * the product: bank-alert-email parsing is not built. The mailbox step
   * says so and sends the user to where the IMAP details live, rather than
   * collecting details that nothing reads.
   *
   * Region and currency come from `region_list` — regions are data, never
   * code, so there is no hardcoded jurisdiction anywhere in this file.
   */
  import { api } from "../api/client";
  import { bookEpoch } from "../books.svelte";
  import { fmtBytes } from "../format";
  import { requestIntent } from "../intent.svelte";
  import {
    currencyForRegion,
    currencyOptions,
    firstRun,
    stepNumber,
    FIRST_RUN_STEPS,
  } from "../onboarding.svelte";
  import { router } from "../router.svelte";
  import type { Book, BookKind, DataStatus, RegionInfo } from "../api/types";
  import Badge from "./Badge.svelte";
  import Dialog from "./Dialog.svelte";
  import Icon from "./Icon.svelte";
  import Skeleton from "./Skeleton.svelte";

  let regions = $state<RegionInfo[]>([]);
  let regionsError = $state<string | null>(null);
  let dataStatus = $state<DataStatus | null>(null);
  let dataError = $state<string | null>(null);
  let target = $state("");
  let moving = $state(false);
  let moved = $state(false);
  let loaded = false;
  /** Books already in the database, so the flow can say plainly whether this
   * will be the first one or an additional one. */
  let existingBooks = $state<Book[]>([]);

  /** Load on first open, never on boot: a dialog nobody sees costs nothing. */
  $effect(() => {
    if (!firstRun.open || loaded) return;
    loaded = true;
    void api
      .regionList()
      .then((list) => {
        regions = list;
        // Adopt the profile's currency only if the user has not typed one.
        if (firstRun.region && firstRun.currency === "")
          firstRun.currency = currencyForRegion(list, firstRun.region) ?? "";
      })
      .catch((err) => (regionsError = String(err)));
    void api
      .dataStatus()
      .then((status) => {
        dataStatus = status;
        target = status.data_dir;
      })
      .catch((err) => (dataError = String(err)));
  });

  /**
   * Each run starts clean. The dialog is mounted for the whole session, so
   * without this a second visit through the palette would open still showing
   * the book the first visit created and offer no way to make another.
   */
  let seenSession = -1;
  $effect(() => {
    if (firstRun.session === seenSession) return;
    seenSession = firstRun.session;
    createdBook = null;
    bookError = null;
    bookName = "Personal";
    bookKind = "personal";
    void api
      .bookList()
      .then((list) => (existingBooks = list))
      .catch(() => (existingBooks = []));
  });

  const selectedRegion = $derived(
    regions.find((r) => r.id === firstRun.region) ?? null,
  );
  const suggestedCurrencies = $derived(currencyOptions(regions));

  // -- the book this step creates ------------------------------------------
  // The dialog only opens when `book_list` came back empty, so "create" here
  // really is the first book. Name and kind are the only two things core
  // needs beyond the region and currency chosen above; everything
  // jurisdictional is carried by the region id, which came from the data.
  let bookName = $state("Personal");
  const BOOK_KINDS: Array<{ id: BookKind; label: string; hint: string }> = [
    { id: "personal", label: "Personal", hint: "Household spending and budgets" },
    { id: "business", label: "Business", hint: "Double-entry ledger and tax periods" },
  ];
  let bookKind = $state<BookKind>("personal");
  let createdBook = $state<Book | null>(null);
  let creating = $state(false);
  let bookError = $state<string | null>(null);

  async function createBook() {
    creating = true;
    bookError = null;
    // See General.svelte: only the first book invalidates the screens behind
    // this dialog, and only then is a remount worth the state it discards.
    const wasEmpty = existingBooks.length === 0;
    try {
      const made = await api.bookCreate({
        name: bookName.trim(),
        kind: bookKind,
        // Both come straight from the profile the user picked. Core rejects
        // a region id it does not know rather than quietly downgrading it.
        region: firstRun.region ?? undefined,
        currency: firstRun.currency.trim().toUpperCase(),
      });
      createdBook = made;
      existingBooks = [...existingBooks, made];
      // Every screen behind this dialog loaded against a database with no
      // book; tell the shell to run them again.
      if (wasEmpty) bookEpoch.bump();
    } catch (err) {
      bookError = String(err);
    } finally {
      creating = false;
    }
  }

  async function useFolder(useExisting: boolean) {
    moving = true;
    dataError = null;
    try {
      dataStatus = await api.dataMove({ target, use_existing: useExisting });
      moved = true;
    } catch (err) {
      dataError = String(err);
    } finally {
      moving = false;
    }
  }

  function openSettings(tab: "general" | "data" | "connections" | "vault") {
    firstRun.dismiss();
    requestIntent({ kind: "settings-tab", tab });
    router.go("settings");
  }
</script>

<Dialog
  open={firstRun.open}
  title="Set up SlipScan"
  size="lg"
  dismissible={!moving}
  onclose={() => firstRun.dismiss()}
>
  <!-- progress -->
  <div class="px-5 pb-4">
    <ol class="flex items-center gap-1.5" aria-label="Setup progress">
      {#each FIRST_RUN_STEPS as step, i (step)}
        {@const done = i < stepNumber(firstRun.step) - 1}
        {@const here = step === firstRun.step}
        <li
          class="h-1 flex-1 rounded-full {here
            ? 'bg-accent-text dark:bg-accent'
            : done
              ? 'bg-accent-ring/50 dark:bg-accent/40'
              : 'bg-line'}"
          aria-current={here ? "step" : undefined}
        >
          <span class="sr-only">
            Step {i + 1}{here ? " (current)" : done ? " (done)" : ""}
          </span>
        </li>
      {/each}
    </ol>
    <p class="eyebrow mt-2">
      Step {stepNumber(firstRun.step)} of {FIRST_RUN_STEPS.length}
    </p>
  </div>

  <div class="max-h-[min(58vh,30rem)] overflow-y-auto px-5 pb-5">
    {#if firstRun.step === "welcome"}
      <h3 class="text-[14px] font-semibold">
        Everything stays on this machine
      </h3>
      <p class="mt-1.5 text-[12.5px] leading-relaxed text-t2">
        SlipScan reads your slips and bank lines into one local database. There
        is no account and no server: nothing leaves this computer unless you
        explicitly ask it to — fetching an exchange rate, or firing a webhook
        you registered yourself.
      </p>
      <p class="mt-3 text-[12.5px] leading-relaxed text-t2">
        The next three steps are the choices worth making now. All of them live
        in Settings afterwards, and you can skip out at any point.
      </p>
      <ul class="mt-4 space-y-2 text-[12.5px] text-t2">
        <li class="flex items-start gap-2">
          <Icon name="globe" size={14} class="mt-0.5 shrink-0 text-t3" />
          A region profile and the currency you keep books in
        </li>
        <li class="flex items-start gap-2">
          <Icon name="folder" size={14} class="mt-0.5 shrink-0 text-t3" />
          Where the one durable data folder lives
        </li>
        <li class="flex items-start gap-2">
          <Icon name="mail" size={14} class="mt-0.5 shrink-0 text-t3" />
          Whether a mailbox is in the picture
        </li>
      </ul>
    {:else if firstRun.step === "region"}
      <h3 class="text-[14px] font-semibold">Region and currency</h3>
      <p class="mt-1.5 text-[12.5px] leading-relaxed text-t2">
        A region profile decides the chart of accounts, the tax rate table and
        what the tax report is called. These come from the profiles installed
        on this machine — SlipScan has no built-in home country.
      </p>

      {#if regionsError}
        <p
          class="mt-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} />
          Could not read the region profiles: {regionsError}
        </p>
      {:else if regions.length === 0}
        <Skeleton rows={3} />
      {:else}
        <div class="mt-4 space-y-1.5" role="radiogroup" aria-label="Region profile">
          {#each regions as region (region.id)}
            {@const active = firstRun.region === region.id}
            <button
              type="button"
              role="radio"
              aria-checked={active}
              class="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors
                {active
                ? 'border-accent-ring bg-accent/10 dark:border-accent/50'
                : 'border-line hover:border-line-2 hover:bg-sunken'}"
              onclick={() => firstRun.chooseRegion(region.id, regions)}
            >
              <Icon
                name={active ? "check-circle" : "globe"}
                size={16}
                class={active ? "text-accent-text dark:text-accent" : "text-t3"}
              />
              <span class="min-w-0 flex-1">
                <span class="block text-[13px] font-medium"
                  >{region.display_name}</span
                >
                <span class="block text-[11.5px] text-t3">
                  Tax report: {region.tax_report_name}{region.default_currency
                    ? ` · default ${region.default_currency}`
                    : ""}
                </span>
              </span>
              {#if region.country}
                <Badge tone="neutral" label={region.country} dot={false} />
              {/if}
            </button>
          {/each}
        </div>

        <label class="mt-4 block">
          <span class="mb-1.5 block text-[12px] font-medium">
            Currency (ISO-4217)
          </span>
          <input
            class="input w-40 uppercase"
            type="text"
            maxlength="3"
            autocapitalize="characters"
            autocomplete="off"
            spellcheck="false"
            list="first-run-currencies"
            aria-describedby="first-run-currency-help"
            aria-invalid={firstRun.issue !== null}
            bind:value={firstRun.currency}
          />
          <datalist id="first-run-currencies">
            {#each suggestedCurrencies as code (code)}
              <option value={code}></option>
            {/each}
          </datalist>
        </label>
        <p id="first-run-currency-help" class="mt-1.5 text-[11.5px] text-t3">
          {selectedRegion?.default_currency
            ? `${selectedRegion.display_name} suggests ${selectedRegion.default_currency}. Any three-letter code works — amounts are stored as integer minor units, never floats.`
            : "Any three-letter code works — amounts are stored as integer minor units, never floats."}
        </p>

        {#if createdBook}
          {@const made = createdBook}
          <div
            class="animate-fade-in mt-4 rounded-lg border border-success/30 bg-success/10 p-3"
            role="status"
          >
            <p class="flex items-center gap-1.5 text-[12px] font-medium text-success">
              <Icon name="check-circle" size={13} />
              Created “{made.name}”
            </p>
            <dl class="mt-2 space-y-1 text-[11.5px] text-t2">
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-t3">Region profile</dt>
                <dd>{made.region_name}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-t3">Currency</dt>
                <dd class="num">{made.currency}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-t3">Tax report</dt>
                <dd>{made.tax_report_name}</dd>
              </div>
            </dl>
            <p class="mt-2 text-[11.5px] leading-relaxed text-t3">
              Its chart of accounts and tax rate table came from that profile,
              not from anything built into SlipScan.
            </p>
          </div>
        {:else}
          {#if existingBooks.length > 0}
            <!-- Honest, because this flow is reachable from the palette at
                 any time: the desktop screens read the first book in the
                 database, so an additional one is real but not what they
                 show. Settings › General lists every book and says the same. -->
            <p
              class="mt-4 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 text-[12px] leading-relaxed text-warning"
            >
              <Icon name="alert-circle" size={14} class="mt-px shrink-0" />
              <span>
                This database already holds
                {existingBooks.length === 1
                  ? `a book (“${existingBooks[0]!.name}”)`
                  : `${existingBooks.length} books`}. SlipScan's screens work
                with the first book in a database, so creating another adds it
                for the CLI and server without changing what you see here.
              </span>
            </p>
          {/if}
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1.5 block text-[12px] font-medium">Book name</span>
              <input
                class="input"
                type="text"
                autocomplete="off"
                spellcheck="false"
                disabled={creating}
                bind:value={bookName}
              />
            </label>
            <div class="block">
              <span class="mb-1.5 block text-[12px] font-medium">Kind</span>
              <div
                class="flex items-center gap-1.5"
                role="radiogroup"
                aria-label="Book kind"
              >
                {#each BOOK_KINDS as kind (kind.id)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={bookKind === kind.id}
                    title={kind.hint}
                    disabled={creating}
                    class="flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors
                      {bookKind === kind.id
                      ? 'border-accent-ring bg-accent/10 font-medium dark:border-accent/50'
                      : 'border-line hover:border-line-2 hover:bg-sunken'}"
                    onclick={() => (bookKind = kind.id)}
                  >
                    {kind.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>
          <button
            type="button"
            class="btn btn-primary mt-3"
            disabled={creating || firstRun.issue !== null || bookName.trim() === ""}
            title={firstRun.issue ?? undefined}
            onclick={createBook}
          >
            <Icon name="plus" size={13} />
            {creating ? "Creating…" : "Create this book"}
          </button>
          <p class="mt-2 text-[11.5px] leading-relaxed text-t3">
            The profile decides the chart of accounts, the tax rate table and
            what the tax report is called. Your choice is also remembered on
            this machine, so Settings opens on it later.
          </p>
        {/if}

        {#if bookError}
          <p
            class="mt-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
            role="alert"
          >
            <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
            {bookError}
          </p>
        {/if}
      {/if}
    {:else if firstRun.step === "data"}
      <h3 class="text-[14px] font-semibold">The data folder</h3>
      <p class="mt-1.5 text-[12.5px] leading-relaxed text-t2">
        One folder holds everything durable — the database and every imported
        document. Put it wherever your own backups already reach; SlipScan
        ships no backup service of its own.
      </p>

      {#if dataStatus === null && !dataError}
        <Skeleton rows={2} />
      {:else if dataStatus}
        <dl class="mt-4 space-y-2 rounded-lg border border-line bg-sunken p-3">
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-[11.5px] text-t3">Current folder</dt>
            <dd class="num min-w-0 truncate text-[12px]">
              {dataStatus.data_dir}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-[11.5px] text-t3">Database</dt>
            <dd class="num text-[12px]">
              {dataStatus.db_exists
                ? fmtBytes(dataStatus.db_size_bytes)
                : "not created yet"}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-3">
            <dt class="text-[11.5px] text-t3">Documents</dt>
            <dd class="num text-[12px]">
              {dataStatus.document_count} · {fmtBytes(
                dataStatus.documents_size_bytes,
              )}
            </dd>
          </div>
          {#if dataStatus.cloud_sync_hint}
            <div class="flex items-baseline justify-between gap-3">
              <dt class="text-[11.5px] text-t3">Looks synced by</dt>
              <dd><Badge tone="accent" label={dataStatus.cloud_sync_hint} /></dd>
            </div>
          {/if}
        </dl>

        <label class="mt-4 block">
          <span class="mb-1.5 block text-[12px] font-medium">
            Use a different folder
          </span>
          <input
            class="input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="~/Documents/SlipScan"
            disabled={moving}
            bind:value={target}
          />
        </label>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn"
            disabled={moving || target.trim() === ""}
            onclick={() => useFolder(false)}
          >
            <Icon name="folder" size={13} />
            {moving ? "Copying…" : "Move data here"}
          </button>
          <button
            type="button"
            class="btn"
            disabled={moving || target.trim() === ""}
            onclick={() => useFolder(true)}
          >
            <Icon name="check" size={13} />
            Open existing data here
          </button>
        </div>
        <p class="mt-2 text-[11.5px] leading-relaxed text-t3">
          “Open existing” adopts a folder that already holds a SlipScan
          database — which is how you get a book if one already exists
          somewhere. Moving copies, verifies, then switches; the app is
          read-only while it runs.
        </p>

        {#if moved}
          <p
            class="animate-fade-in mt-3 flex items-center gap-1.5 text-[12px] text-success"
            role="status"
          >
            <Icon name="check-circle" size={13} />
            Data folder is now {dataStatus.data_dir}
          </p>
        {/if}
      {/if}

      {#if dataError}
        <p
          class="mt-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
          {dataError}
        </p>
      {/if}
    {:else if firstRun.step === "mailbox"}
      <h3 class="text-[14px] font-semibold">Mailbox</h3>
      <p class="mt-1.5 text-[12.5px] leading-relaxed text-t2">
        SlipScan can hold IMAP details so a mailbox of e-mailed invoices is one
        place away, with the password in the OS keychain rather than in the
        database.
      </p>
      <p
        class="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2.5 text-[12px] leading-relaxed text-warning"
      >
        <Icon name="alert-circle" size={14} class="mt-px shrink-0" />
        <span>
          <strong class="font-semibold">Not built yet:</strong> parsing bank
          alert e-mails into transactions is not implemented. Configuring a
          mailbox stores the connection details and nothing reads them yet, so
          there is nothing to gain from setting it up in this flow.
        </span>
      </p>
      <button
        type="button"
        class="btn mt-3"
        onclick={() => openSettings("connections")}
      >
        <Icon name="mail" size={13} />
        Open Settings › Connections anyway
      </button>
    {:else}
      <h3 class="text-[14px] font-semibold">That is the setup</h3>
      <dl class="mt-3 space-y-2 rounded-lg border border-line bg-sunken p-3">
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-[11.5px] text-t3">Book</dt>
          <dd class="text-[12px]">
            {createdBook ? createdBook.name : "not created"}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-[11.5px] text-t3">Region</dt>
          <dd class="text-[12px]">
            {selectedRegion?.display_name ?? "not chosen"}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-[11.5px] text-t3">Currency</dt>
          <dd class="num text-[12px]">
            {firstRun.currency.trim().toUpperCase() || "not chosen"}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-[11.5px] text-t3">Data folder</dt>
          <dd class="num min-w-0 truncate text-[12px]">
            {dataStatus?.data_dir ?? "unchanged"}
          </dd>
        </div>
      </dl>
      <p class="mt-3 text-[12.5px] leading-relaxed text-t2">
        Press <span class="kbd">⌘K</span> anywhere for the command palette — it
        reaches every screen, every action and your recent transactions. Or press
        <span class="kbd">G</span> then a letter to jump straight to a section.
      </p>
      <p class="mt-3 text-[12.5px] leading-relaxed text-t2">
        Every one of these choices lives in Settings, and can be changed there
        at any time.
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="btn btn-ghost mr-auto text-t2"
      disabled={moving}
      onclick={() => firstRun.dismiss()}
    >
      Skip setup
    </button>
    {#if firstRun.step !== "welcome"}
      <button type="button" class="btn" disabled={moving} onclick={() => firstRun.retreat()}>
        <Icon name="chevron-left" size={13} />
        Back
      </button>
    {/if}
    {#if firstRun.step === "done"}
      <button
        type="button"
        class="btn btn-primary"
        data-autofocus
        onclick={() => firstRun.finish()}
      >
        <Icon name="check" size={13} />
        Start using SlipScan
      </button>
    {:else}
      <button
        type="button"
        class="btn btn-primary"
        disabled={firstRun.issue !== null || moving}
        title={firstRun.issue ?? undefined}
        onclick={() => firstRun.advance()}
      >
        Next
        <Icon name="chevron-right" size={13} />
      </button>
    {/if}
  {/snippet}
</Dialog>

{#if firstRun.open && firstRun.issue}
  <!-- The reason Next is disabled, announced rather than left to a tooltip. -->
  <p class="sr-only" role="status">{firstRun.issue}</p>
{/if}
