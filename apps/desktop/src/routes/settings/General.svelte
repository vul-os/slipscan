<script lang="ts">
  /**
   * General tab: appearance, the books this database holds, and the privacy
   * contract. `settings` is bound because the theme buttons write straight
   * into the blob the shell saves.
   *
   * Books are creatable here and not only in first-run setup. That is the
   * point: setup is a one-time flow behind a gate, and "I need a book" is
   * not a one-time need. Region and currency come from `region_list` — no
   * jurisdiction is chosen in this file or below it.
   */
  import { api } from "../../lib/api/client";
  import { currentBook } from "../../lib/book";
  import { bookEpoch } from "../../lib/books.svelte";
  import { currencyForRegion, currencyOptions } from "../../lib/onboarding.svelte";
  import { theme, type ThemeMode } from "../../lib/theme.svelte";
  import type {
    Book,
    BookKind,
    BookProfile,
    RegionInfo,
    Settings,
  } from "../../lib/api/types";
  import Badge from "../../lib/components/Badge.svelte";
  import Icon from "../../lib/components/Icon.svelte";

  let {
    settings = $bindable(),
    book,
    books = [],
    onbookcreated,
  }: {
    settings: Settings;
    /** The book the screens work with — `books[0]`, or null when empty. */
    book: Book | null;
    /** Every book in the database, so an extra one is never invisible. */
    books?: Book[];
    /** Tell the shell to reload, so a new book reaches the rest of the app. */
    onbookcreated?: () => void;
  } = $props();

  const themeModes: Array<{ mode: ThemeMode; label: string }> = [
    { mode: "system", label: "Follow OS" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];

  // -- create a book --------------------------------------------------------

  let showForm = $state(false);
  let regions = $state<RegionInfo[]>([]);
  let regionsError = $state<string | null>(null);
  let newName = $state("Personal");
  let newKind = $state<BookKind>("personal");
  let newRegion = $state<string | null>(null);
  let newCurrency = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);
  let createdName = $state<string | null>(null);

  const bookKinds: Array<{ id: BookKind; label: string }> = [
    { id: "personal", label: "Personal" },
    { id: "business", label: "Business" },
  ];

  const suggestedCurrencies = $derived(currencyOptions(regions));

  /** Profiles load when the form opens, not on tab load: a form nobody
   * opened should not cost a round trip. */
  async function openForm() {
    showForm = true;
    createError = null;
    createdName = null;
    if (regions.length > 0) return;
    try {
      regions = await api.regionList();
    } catch (err) {
      regionsError = String(err);
    }
  }

  /** Picking a profile fills in its currency unless one was typed. */
  function chooseRegion(id: string) {
    const previous = currencyForRegion(regions, newRegion);
    const untouched = newCurrency === "" || newCurrency === previous;
    newRegion = id;
    if (untouched) newCurrency = currencyForRegion(regions, id) ?? "";
  }

  const createIssue = $derived.by(() => {
    if (newName.trim() === "") return "Name the book to create it.";
    if (!newRegion) return "Choose a region profile.";
    if (!/^[A-Za-z]{3}$/.test(newCurrency.trim()))
      return "Enter a three-letter ISO-4217 currency code.";
    return null;
  });

  async function createBook() {
    if (createIssue) return;
    creating = true;
    createError = null;
    // Only the *first* book invalidates what is already on screen. An
    // additional one changes nothing the app displays (it reads the first
    // book), so remounting over it would only throw away this form's own
    // "Created …" confirmation.
    const wasEmpty = books.length === 0;
    try {
      const made = await api.bookCreate({
        name: newName.trim(),
        kind: newKind,
        region: newRegion ?? undefined,
        currency: newCurrency.trim().toUpperCase(),
      });
      createdName = made.name;
      if (wasEmpty) bookEpoch.bump();
      showForm = false;
      newName = "Personal";
      newRegion = null;
      newCurrency = "";
      onbookcreated?.();
    } catch (err) {
      createError = String(err);
    } finally {
      creating = false;
    }
  }

  // -- book profile (Phase 6.0 — ROADMAP.md "Phase 6", Book profiles) ------
  // Which capability groups this book shows right now, and the two things
  // Settings can change about it later, in either direction: `kind` itself,
  // and the multi-location override. Downgrading only ever hides groups
  // here — nothing in `location_count` or the underlying rows changes as a
  // side effect of either control.

  let profile = $state<BookProfile | null>(null);
  let profileError = $state<string | null>(null);
  let profileBusy = $state(false);

  $effect(() => {
    const id = book?.id;
    profile = null;
    profileError = null;
    if (!id) return;
    void api
      .bookProfile({ book_id: id })
      .then((p) => (profile = p))
      .catch((err) => (profileError = String(err)));
  });

  async function changeKind(kind: BookKind) {
    if (!book || profileBusy || profile?.kind === kind) return;
    profileBusy = true;
    profileError = null;
    try {
      profile = await api.bookSetKind({ book_id: book.id, kind });
      // Every business-only screen's own gate (Contacts, Catalogue, …) and
      // the sidebar's "Trade" group both read a `BookProfile` cached against
      // `bookEpoch.value` — without this, switching Personal -> Business
      // here left the rail showing the old capability set until the next
      // book was created or the app reloaded, while this screen (which
      // re-fetches on its own) already looked right. Caught by reading a
      // screenshot: the two disagreed and only one of them was visible.
      bookEpoch.bump();
    } catch (err) {
      profileError = String(err);
    } finally {
      profileBusy = false;
    }
  }

  type MultiLocationMode = "auto" | "on" | "off";
  const multiLocationMode = $derived<MultiLocationMode>(
    profile?.multi_location_override === true
      ? "on"
      : profile?.multi_location_override === false
        ? "off"
        : "auto",
  );

  async function setMultiLocationMode(mode: MultiLocationMode) {
    if (!book || profileBusy) return;
    profileBusy = true;
    profileError = null;
    try {
      profile = await api.bookSetMultiLocationOverride({
        book_id: book.id,
        multi_location_override: mode === "auto" ? null : mode === "on",
      });
      // Same staleness fix as changeKind: this flag gates the sidebar's
      // Locations entry too, once one exists.
      bookEpoch.bump();
    } catch (err) {
      profileError = String(err);
    } finally {
      profileBusy = false;
    }
  }
</script>

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
            settings.theme = t.mode;
          }}
        >
          {t.label}
        </button>
      {/each}
    </div>
  </section>

  <!-- book -->
  <section class="card p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="ledger" size={15} class="text-t3" />
        Book
      </h2>
      <button class="btn h-7" onclick={openForm} disabled={showForm}>
        <Icon name="plus" size={13} />
        Create a book
      </button>
    </div>

    {#if createdName}
      <p
        class="animate-fade-in mb-3 flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-[12px] text-success"
        role="status"
      >
        <Icon name="check-circle" size={13} />
        Created “{createdName}”.
      </p>
    {/if}

    {#if showForm}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
           Escape-to-close only; interaction lives on the inputs/buttons. -->
      <form
        class="animate-slide-up mb-4 rounded-lg border border-line bg-sunken p-3"
        onsubmit={(e) => {
          e.preventDefault();
          createBook();
        }}
        onkeydown={(e) => {
          if (e.key === "Escape") showForm = false;
        }}
      >
        <h3 class="mb-2 text-[12.5px] font-semibold">New book</h3>
        {#if regionsError}
          <p
            class="mb-2 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
            role="alert"
          >
            <Icon name="alert-circle" size={13} />
            Could not read the region profiles: {regionsError}
          </p>
        {/if}
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
            <input class="input" bind:value={newName} autocomplete="off" required />
          </label>
          <div class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Kind</span>
            <div class="flex items-center gap-1.5" role="radiogroup" aria-label="Book kind">
              {#each bookKinds as k (k.id)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={newKind === k.id}
                  class="flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors
                    {newKind === k.id
                    ? 'border-accent-ring bg-accent/10 font-medium dark:border-accent/50'
                    : 'border-line hover:border-line-2 hover:bg-panel'}"
                  onclick={() => (newKind = k.id)}
                >
                  {k.label}
                </button>
              {/each}
            </div>
          </div>
          <div class="block sm:col-span-2">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">
              Region profile — decides the chart of accounts, tax rates and
              report labels
            </span>
            <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Region profile">
              {#each regions as r (r.id)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={newRegion === r.id}
                  class="rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors
                    {newRegion === r.id
                    ? 'border-accent-ring bg-accent/10 font-medium dark:border-accent/50'
                    : 'border-line hover:border-line-2 hover:bg-panel'}"
                  onclick={() => chooseRegion(r.id)}
                >
                  {r.display_name}
                  <span class="ml-1 text-t3">{r.tax_report_name}</span>
                </button>
              {/each}
            </div>
          </div>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">
              Currency (ISO-4217)
            </span>
            <input
              class="input w-32 uppercase"
              maxlength="3"
              autocapitalize="characters"
              autocomplete="off"
              spellcheck="false"
              list="general-book-currencies"
              bind:value={newCurrency}
            />
            <datalist id="general-book-currencies">
              {#each suggestedCurrencies as code (code)}
                <option value={code}></option>
              {/each}
            </datalist>
          </label>
        </div>
        {#if createError}
          <p
            class="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
            role="alert"
          >
            <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
            {createError}
          </p>
        {/if}
        <div class="mt-3 flex items-center gap-2">
          <button
            class="btn btn-primary h-7"
            type="submit"
            disabled={creating || createIssue !== null}
            title={createIssue ?? undefined}
          >
            {creating ? "Creating…" : "Create book"}
          </button>
          <button
            class="btn btn-ghost h-7"
            type="button"
            onclick={() => (showForm = false)}
          >
            Cancel
          </button>
          {#if createIssue}
            <span class="text-[11.5px] text-t3">{createIssue}</span>
          {/if}
        </div>
      </form>
    {/if}

    {#if books.length > 1}
      <!-- Every book, so one made here is never invisible. The desktop reads
           the first book in the database and has no switcher yet; saying so
           is the difference between a limitation and a disappearing book. -->
      <ul class="mb-3 divide-y divide-line rounded-lg border border-line">
        {#each books as b (b.id)}
          <li class="flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
            <span class="font-medium">{b.name}</span>
            <span class="num text-t3">{b.currency}</span>
            <span class="text-t3">{b.region_name}</span>
            <span class="ml-auto">
              {#if b.id === currentBook(books)?.id}
                <Badge tone="accent" label="Shown in the app" dot={false} />
              {:else}
                <Badge tone="neutral" label="CLI and server only" dot={false} />
              {/if}
            </span>
          </li>
        {/each}
      </ul>
      <p class="mb-3 text-[11px] text-t3">
        SlipScan's screens work with the first book in the database. The
        others are real — <code class="num">slipscan --book</code> and the
        HTTP API reach them — but there is no book switcher in the app yet.
      </p>
    {/if}

    {#if book}
      <dl class="grid grid-cols-[9rem_1fr] gap-y-2 text-[12.5px]">
        <dt class="text-t3">Name</dt>
        <dd class="font-medium">{book.name}</dd>
        <dt class="text-t3">Kind</dt>
        <dd>
          <div
            class="inline-flex items-center gap-1 rounded-lg border border-line p-0.5"
            role="radiogroup"
            aria-label="Book kind"
          >
            {#each bookKinds as k (k.id)}
              {@const active = (profile?.kind ?? book.kind) === k.id}
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={profileBusy}
                class="rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors
                  {active
                  ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
                  : 'text-t2 hover:bg-sunken'}"
                onclick={() => changeKind(k.id)}
              >
                {k.label}
              </button>
            {/each}
          </div>
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
        Changing kind here is the other direction of the same choice made
        at creation, in both directions, any time (ROADMAP.md "Phase 6" —
        Book profiles): downgrading only hides the groups below, and never
        deletes a location, a contact, or a catalogue row.
      </p>

      {#if profileError}
        <p
          class="mt-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
          {profileError}
        </p>
      {/if}

      {#if profile}
        <div class="mt-4 rounded-lg border border-line bg-sunken p-3">
          <h3 class="text-[12px] font-semibold">This book shows</h3>
          <ul class="mt-2 flex flex-wrap gap-1.5">
            <li><Badge tone="accent" dot={false} label="Accounts" /></li>
            <li><Badge tone="accent" dot={false} label="Transactions" /></li>
            <li><Badge tone="accent" dot={false} label="Budgets" /></li>
            <li><Badge tone="accent" dot={false} label="Members" /></li>
            {#if profile.show_contacts}
              <li><Badge tone="accent" dot={false} label="Contacts" /></li>
            {/if}
            {#if profile.show_catalogue}
              <li><Badge tone="accent" dot={false} label="Catalogue" /></li>
            {/if}
            {#if profile.show_purchasing}
              <li><Badge tone="accent" dot={false} label="Purchasing" /></li>
            {/if}
            {#if profile.show_sales}
              <li><Badge tone="accent" dot={false} label="Sales" /></li>
            {/if}
            {#if profile.show_locations}
              <li><Badge tone="accent" dot={false} label="Locations" /></li>
            {/if}
          </ul>
          <p class="mt-2 text-[11px] text-t3">
            A personal book stops here. A business book adds contacts,
            catalogue, purchasing and sales; the location axis needs
            business kind <em>and</em> more than one location (or the
            override below). None of these have a screen of their own yet
            (Phase 6.9) — this list tracks what the model will show once
            they do, not a set of screens you can open today.
          </p>

          {#if profile.kind === "business"}
            <div class="mt-3 border-t border-line pt-3">
              <h4 class="text-[11.5px] font-semibold">Multi-location</h4>
              <p class="mt-1 text-[11px] text-t3">
                {profile.location_count === 0
                  ? "No locations yet."
                  : profile.location_count === 1
                    ? "One location."
                    : `${profile.location_count} locations.`}
                Derived: {profile.multi_location ? "on" : "off"}.
              </p>
              <div
                class="mt-2 inline-flex items-center gap-1 rounded-lg border border-line p-0.5"
                role="radiogroup"
                aria-label="Multi-location override"
              >
                {#each [{ id: "auto", label: "Auto (derive)" }, { id: "on", label: "On" }, { id: "off", label: "Off" }] as m (m.id)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={multiLocationMode === m.id}
                    disabled={profileBusy}
                    class="rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors
                      {multiLocationMode === m.id
                      ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
                      : 'text-t2 hover:bg-panel'}"
                    onclick={() =>
                      setMultiLocationMode(m.id as "auto" | "on" | "off")}
                  >
                    {m.label}
                  </button>
                {/each}
              </div>
              <p class="mt-1.5 text-[11px] text-t3">
                Auto turns the axis on the moment a second location exists —
                the common case needs no toggle. Pin “On” for a business
                setting up its first branch that wants the axis before a
                second location exists; pin “Off” to hide it despite two or
                more. Nothing here deletes a location either way.
              </p>
            </div>
          {/if}
        </div>
      {/if}
    {:else if !showForm}
      <p class="text-[12.5px] text-t2">
        This database holds no book yet. SlipScan does not invent one — the
        region profile and currency a book is created with decide its chart
        of accounts and tax rates, and those are yours to choose.
      </p>
      <button class="btn btn-primary mt-3" onclick={openForm}>
        <Icon name="plus" size={13} />
        Create the first book
      </button>
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
    <!-- Kept exhaustive on purpose. A privacy list that names three egress
         paths when there are four is worse than no list, so this enumerates
         every one the product can actually open — including the webhook
         endpoints Payments registers, which do not live in Connections — and
         names none it cannot. -->
    <ul class="space-y-1 text-[12px] text-t2">
      <li>· No telemetry, no analytics, no default network calls.</li>
      <li>
        · Egress only to endpoints you entered yourself: your LLM provider,
        your IMAP or OAuth mail host, your exchange-rate instance — all in
        Connections — and the webhook URLs you register on Payments.
      </li>
      <li>
        · Each of those fires only when you ask. Nothing polls, and nothing
        runs in the background.
      </li>
      <li>
        · Your data is one folder — a SQLite file plus your documents —
        that you can move, sync, back up, or delete.
      </li>
    </ul>
  </section>
</div>
