<script lang="ts">
  /**
   * Ledger — the double-entry record the reports are computed from.
   *
   * The one rule this screen exists to make obvious: **a posted entry is
   * immutable**. Core has no update and no delete for a journal entry, so
   * there is deliberately no edit button anywhere here, and nobody should go
   * looking for one. A correction is a *reversal*: a new, balanced entry that
   * swaps the original's debits and credits and leaves the original standing.
   * That is what the Reverse action does, and the banner on the Journal tab
   * says so in the same words.
   *
   * Everything is one book's own rows, read through three services:
   * `ledger_account_list` (the chart, with each account's VAT treatment),
   * `journal_list` (entries and their lines) and `report_trial_balance`.
   */
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import {
    fmtDate,
    fmtMoney,
    localDate,
    minorToInput,
    parseMoneyInput,
  } from "../lib/util/format";
  import { swrLoad } from "../lib/loadCache";
  import type { JournalEntry, LedgerAccountType } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";

  type Tab = "accounts" | "journal" | "trial";
  let tab = $state<Tab>("accounts");

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "accounts", label: "Chart of accounts" },
    { id: "journal", label: "Journal" },
    { id: "trial", label: "Trial balance" },
  ];

  /** Roving tabindex: one tab stop for the strip, arrows move between tabs. */
  let tabRefs = $state<Array<HTMLButtonElement | null>>([]);

  function onTabKeydown(e: KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    let next = -1;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next < 0) return;
    e.preventDefault();
    tab = tabs[next]!.id;
    tabRefs[next]?.focus();
  }

  let bookId = $state("");
  /**
   * The book's ISO-4217 code, captured when the load resolves.
   *
   * It is deliberately NOT derived from `data`: `swrLoad` hands back the
   * in-flight promise on a cold visit and only swaps in the resolved value on
   * a later refresh, so a `data instanceof Promise ? "" : data.currency`
   * derivation stays `""` for the whole first visit — and `""` is not a
   * currency. `Intl.NumberFormat` throws `Invalid currency code` on it, which
   * aborted the render mid-update and left the Journal tab showing the
   * previous tab's markup. Set it here and both branches agree.
   */
  let bookCurrency = $state("");

  async function load() {
    const book = requireBook(await api.bookList());
    bookId = book.id;
    bookCurrency = book.currency;
    const [accounts, journal, trial] = await Promise.all([
      api.ledgerAccountList({ book_id: book.id }),
      api.journalList({ book_id: book.id }),
      api.reportTrialBalance({ book_id: book.id }),
    ]);
    // The book currency travels with the (cached) data — formatting never
    // falls back to a hardcoded currency.
    return { accounts, journal, trial, currency: book.currency };
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>("ledger", load, (v) => (data = v), { fresh });
  let data = $state(reload());

  // -- chart of accounts ----------------------------------------------------
  let accountFilter = $state("");
  let showArchived = $state(false);

  const typeOrder: LedgerAccountType[] = [
    "asset",
    "liability",
    "equity",
    "income",
    "expense",
  ];
  const typeLabel: Record<LedgerAccountType, string> = {
    asset: "Assets",
    liability: "Liabilities",
    equity: "Equity",
    income: "Income",
    expense: "Expenses",
  };

  // -- manual journal entry -------------------------------------------------
  interface FormLine {
    ledger_account_id: string;
    debit: string;
    credit: string;
  }
  const blankLine = (): FormLine => ({
    ledger_account_id: "",
    debit: "",
    credit: "",
  });

  let showForm = $state(false);
  let entryDate = $state(localDate());
  let memo = $state("");
  let lines = $state<FormLine[]>([blankLine(), blankLine()]);
  let posting = $state(false);
  let postError = $state<string | null>(null);
  let memoInput = $state<HTMLInputElement | null>(null);
  /**
   * The entry this form is a correction *of*, when it is one. Nothing is
   * sent about it — core has no concept of a linked reversal — so it exists
   * purely to tell the user what they are undoing and to keep the wording
   * honest: the original is never touched.
   */
  let reversalOf = $state<JournalEntry | null>(null);

  async function openForm() {
    tab = "journal";
    showForm = true;
    postError = null;
    reversalOf = null;
    memo = "";
    entryDate = localDate();
    lines = [blankLine(), blankLine()];
    await tick();
    memoInput?.focus();
  }

  /**
   * Correction, the only way there is one: a new entry with this one's
   * debits and credits swapped. The original stays exactly as posted — it is
   * pre-filled here, not edited, and the user can change anything before
   * posting.
   */
  async function startReversal(entry: JournalEntry) {
    tab = "journal";
    showForm = true;
    postError = null;
    reversalOf = entry;
    entryDate = localDate();
    memo = `Reversal — ${entry.memo}`;
    lines = entry.lines.map((l) => ({
      ledger_account_id: l.ledger_account_id,
      debit: l.credit_minor ? minorToInput(l.credit_minor, bookCurrency) : "",
      credit: l.debit_minor ? minorToInput(l.debit_minor, bookCurrency) : "",
    }));
    await tick();
    memoInput?.focus();
  }

  function closeForm() {
    showForm = false;
    reversalOf = null;
    postError = null;
  }

  const lineMinor = (raw: string): number =>
    Math.max(0, parseMoneyInput(raw, bookCurrency) ?? 0);
  const debitTotal = $derived(
    lines.reduce((s, l) => s + lineMinor(l.debit), 0),
  );
  const creditTotal = $derived(
    lines.reduce((s, l) => s + lineMinor(l.credit), 0),
  );
  /** Signed imbalance — drives the live balanced/off-by indicator. */
  const diff = $derived(debitTotal - creditTotal);
  /** Lines carrying an amount but no account: they would be dropped on
   * submit, so they block posting instead of silently disappearing. */
  const orphanLines = $derived(
    lines.some(
      (l) =>
        !l.ledger_account_id && (lineMinor(l.debit) > 0 || lineMinor(l.credit) > 0),
    ),
  );

  async function postJournal() {
    postError = null;
    posting = true;
    try {
      await api.journalPost({
        book_id: bookId,
        entry_date: entryDate,
        memo,
        lines: lines
          .filter((l) => l.ledger_account_id)
          .map((l) => ({
            ledger_account_id: l.ledger_account_id,
            debit_minor: lineMinor(l.debit),
            credit_minor: lineMinor(l.credit),
          })),
      });
      memo = "";
      lines = [blankLine(), blankLine()];
      showForm = false;
      reversalOf = null;
      data = reload(true);
    } catch (err) {
      postError = String(err);
    } finally {
      posting = false;
    }
  }

  // -- journal filter -------------------------------------------------------
  let journalFilter = $state("");

  function matchesEntry(entry: JournalEntry, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q === "") return true;
    if (entry.memo.toLowerCase().includes(q)) return true;
    if (entry.entry_date.includes(q)) return true;
    return entry.lines.some((l) =>
      l.ledger_account_name.toLowerCase().includes(q),
    );
  }
</script>

<PageHeader
  eyebrow="Double-entry"
  title="Ledger"
  subtitle="Chart of accounts, balanced journal entries, and the trial balance behind every report. Posted entries never change — corrections are reversals."
>
  {#snippet actions()}
    <button class="btn btn-primary" aria-expanded={showForm} onclick={openForm}>
      <Icon name="plus" size={14} />
      New journal entry
    </button>
  {/snippet}
</PageHeader>

<div
  class="mb-4 flex items-center gap-1 border-b border-line"
  role="tablist"
  aria-label="Ledger views"
>
  {#each tabs as t, i (t.id)}
    <button
      bind:this={tabRefs[i]}
      role="tab"
      id="ledger-tab-{t.id}"
      aria-selected={tab === t.id}
      aria-controls="ledger-panel-{t.id}"
      tabindex={tab === t.id ? 0 : -1}
      class="-mb-px border-b-2 px-3 py-2 text-[13px] font-medium
        {tab === t.id
        ? 'border-accent text-t1'
        : 'border-transparent text-t3 hover:text-t2'}"
      style="transition: color var(--dur-quick) var(--ease-standard), border-color var(--dur-quick) var(--ease-standard);"
      onclick={() => (tab = t.id)}
      onkeydown={(e) => onTabKeydown(e, i)}
    >
      {t.label}
    </button>
  {/each}
</div>

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then d}
  <div
    role="tabpanel"
    id="ledger-panel-{tab}"
    aria-labelledby="ledger-tab-{tab}"
    tabindex="0"
  >
    {#if tab === "accounts"}
      {@const visible = d.accounts.filter((a) => {
        if (a.archived && !showArchived) return false;
        const q = accountFilter.trim().toLowerCase();
        if (q === "") return true;
        return (
          a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
        );
      })}
      {@const archivedCount = d.accounts.filter((a) => a.archived).length}
      {#if d.accounts.length === 0}
        <div class="card">
          <EmptyState
            title="No chart of accounts"
            body="A chart is seeded from your region profile when a book is created. This one has none — seed it from the CLI: slipscan init."
          />
        </div>
      {:else}
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <div class="relative w-full sm:w-72">
            <Icon
              name="search"
              size={14}
              class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
            />
            <input
              class="input pr-8 pl-8"
              placeholder="Filter by code or account name…"
              aria-label="Filter accounts"
              bind:value={accountFilter}
            />
            {#if accountFilter}
              <button
                type="button"
                class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-t3 hover:text-t1"
                style="transition: color var(--dur-quick) var(--ease-standard);"
                aria-label="Clear account filter"
                onclick={() => (accountFilter = "")}
              >
                <Icon name="x" size={13} />
              </button>
            {/if}
          </div>
          {#if archivedCount > 0}
            <label class="flex items-center gap-2 text-[12px] text-t2">
              <input type="checkbox" bind:checked={showArchived} />
              Show archived
              <span class="num text-t3">{archivedCount}</span>
            </label>
          {/if}
          <span class="ml-auto text-[12px] text-t3">
            <span class="num tabular-nums">{visible.length}</span> of
            <span class="num tabular-nums">{d.accounts.length}</span> accounts
          </span>
        </div>
        {#if visible.length === 0}
          <div class="card">
            <EmptyState
              icon="search"
              title="No account matches that"
              body="Try a shorter code or a different word — the filter matches the account code and its name."
            >
              {#snippet actions()}
                <button class="btn" onclick={() => (accountFilter = "")}>
                  Clear filter
                </button>
              {/snippet}
            </EmptyState>
          </div>
        {:else}
          <!-- One table for the whole chart, not one per type: the code,
               name and VAT columns then line up from the first asset to the
               last expense, which is the entire point of a chart of
               accounts. Type headings are colgroup header rows inside it. -->
          <div class="card overflow-hidden">
            <div class="table-wrap table-scroll">
              <table class="w-full text-[12.5px]">
                <thead>
                  <tr>
                    <th class="th w-20">Code</th>
                    <th class="th">Account</th>
                    <th class="th w-44">VAT treatment</th>
                  </tr>
                </thead>
                <tbody>
                  {#each typeOrder as type (type)}
                    {@const rows = visible.filter((a) => a.type === type)}
                    {#if rows.length > 0}
                      <tr>
                        <th
                          class="th sticky top-8 z-[1] border-t border-line bg-sunken"
                          colspan="3"
                          scope="colgroup"
                        >
                          <span class="flex items-baseline gap-2">
                            {typeLabel[type]}
                            <span class="num text-[10.5px] normal-case">
                              {rows.length}
                            </span>
                          </span>
                        </th>
                      </tr>
                      {#each rows as a (a.id)}
                        <tr class="row-hover">
                          <td class="td num text-t3">{a.code}</td>
                          <td class="td">
                            <span class="flex min-w-0 items-center gap-2">
                              <span class="truncate font-medium">{a.name}</span>
                              {#if a.archived}
                                <Badge tone="neutral" dot={false} label="archived" />
                              {/if}
                            </span>
                          </td>
                          <td class="td">
                            {#if a.vat_rate_bp}
                              <!-- Basis points are the stored unit: 1500 = 15%. -->
                              <Badge
                                tone="neutral"
                                dot={false}
                                label="VAT {a.vat_rate_bp / 100}%"
                              />
                            {:else}
                              <span class="text-[11.5px] text-t3">no VAT</span>
                            {/if}
                          </td>
                        </tr>
                      {/each}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
          <p class="mt-2 text-[11px] text-t3">
            VAT treatment is a property of the account, applied when an entry
            posts to it. Rates come from the book's region profile — change them
            in Settings, not here.
          </p>
        {/if}
      {/if}
    {:else if tab === "journal"}
      <!-- The model, stated where somebody would otherwise look for Edit. -->
      <p
        class="mb-4 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-t2"
      >
        <Icon name="shield" size={13} class="mt-0.5 shrink-0 text-t3" />
        <span>
          <span class="font-medium text-t1">Posted entries are immutable.</span>
          There is no edit and no delete — core does not offer one. To correct an
          entry, reverse it: that posts a new balanced entry with the debits and
          credits swapped, and leaves the original standing as part of the record.
        </span>
      </p>

      {#if showForm}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
             Escape-to-close only; interaction lives on the inputs/buttons. -->
        <form
          class="card animate-slide-up mb-4 p-4"
          onsubmit={(e) => {
            e.preventDefault();
            postJournal();
          }}
          onkeydown={(e) => {
            if (e.key === "Escape") closeForm();
          }}
        >
          <h2 class="mb-3 text-[13px] font-semibold">
            {reversalOf ? "Reversing entry" : "New journal entry"}
          </h2>
          {#if reversalOf}
            <p
              class="mb-3 flex items-start gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-[12px] leading-relaxed text-t2"
            >
              <Icon name="reconcile" size={13} class="mt-0.5 shrink-0 text-t3" />
              <span>
                Debits and credits from
                <span class="font-medium text-t1">“{reversalOf.memo}”</span>
                ({fmtDate(reversalOf.entry_date)}) have been swapped below. Posting
                this adds a new entry; the original is not modified. Edit anything
                you like before posting.
              </span>
            </p>
          {/if}
          {#if postError}
            <p
              class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
              role="alert"
            >
              <Icon name="alert-circle" size={13} />
              {postError}
            </p>
          {/if}
          <div class="mb-4 grid gap-3 sm:grid-cols-[10rem_1fr]">
            <label class="block">
              <span class="mb-1 block text-[11.5px] font-medium text-t2">Date</span>
              <input class="input font-mono" type="date" bind:value={entryDate} />
            </label>
            <label class="block">
              <span class="mb-1 block text-[11.5px] font-medium text-t2">Memo</span>
              <input
                class="input"
                placeholder="What is this entry for?"
                bind:this={memoInput}
                bind:value={memo}
              />
            </label>
          </div>
          <!-- One grid for header, lines, and totals: debit/credit columns stay
               perfectly aligned from the labels through the mono inputs to the
               running totals underneath. -->
          <div
            class="grid grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_2rem] items-center gap-x-2 gap-y-2"
          >
            <span
              class="text-[10.5px] font-semibold tracking-[0.08em] text-t3 uppercase"
              >Account</span
            >
            <span
              class="pr-2.5 text-right text-[10.5px] font-semibold tracking-[0.08em] text-t3 uppercase"
              >Debit</span
            >
            <span
              class="pr-2.5 text-right text-[10.5px] font-semibold tracking-[0.08em] text-t3 uppercase"
              >Credit</span
            >
            <span aria-hidden="true"></span>
            {#each lines as line, i (i)}
              <select
                class="input h-8"
                aria-label="Ledger account, line {i + 1}"
                bind:value={line.ledger_account_id}
              >
                <option value="" disabled>Account…</option>
                {#each d.accounts.filter((a) => !a.archived) as a (a.id)}
                  <option value={a.id}>{a.code} · {a.name}</option>
                {/each}
              </select>
              <input
                class="input h-8 text-right font-mono"
                placeholder={minorToInput(0, bookCurrency)}
                inputmode="decimal"
                aria-label="Debit, line {i + 1}"
                bind:value={line.debit}
              />
              <input
                class="input h-8 text-right font-mono"
                placeholder={minorToInput(0, bookCurrency)}
                inputmode="decimal"
                aria-label="Credit, line {i + 1}"
                bind:value={line.credit}
              />
              <button
                class="btn btn-ghost h-8 w-8 justify-center px-0"
                type="button"
                aria-label="Remove line {i + 1}"
                disabled={lines.length <= 2}
                onclick={() => (lines = lines.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={13} />
              </button>
            {/each}
            <div class="col-span-full border-t border-line"></div>
            <span
              class="flex items-center justify-end gap-2 text-[11.5px] font-medium text-t2"
            >
              {#if orphanLines}
                <Badge tone="warning" label="line needs an account" />
              {:else if debitTotal === 0 && creditTotal === 0}
                <Badge tone="neutral" dot={false} label="no amounts" />
              {:else if diff === 0}
                <Badge tone="success" label="balanced" />
              {:else}
                <Badge
                  tone="danger"
                  label="off by {fmtMoney(Math.abs(diff), bookCurrency)}"
                />
              {/if}
              Totals
            </span>
            <span class="pr-2.5 text-right">
              <Money amount={debitTotal} currency={bookCurrency} class="font-medium" />
            </span>
            <span class="pr-2.5 text-right">
              <Money amount={creditTotal} currency={bookCurrency} class="font-medium" />
            </span>
            <span aria-hidden="true"></span>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <button
              class="btn h-7"
              type="button"
              onclick={() => (lines = [...lines, blankLine()])}
            >
              <Icon name="plus" size={13} />
              Add line
            </button>
            <span class="ml-auto"></span>
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={posting || orphanLines || diff !== 0 || debitTotal === 0}
            >
              {posting ? "Posting…" : reversalOf ? "Post reversal" : "Post entry"}
            </button>
            <button class="btn btn-ghost h-7" type="button" onclick={closeForm}>
              Cancel
            </button>
          </div>
        </form>
      {/if}

      {#if d.journal.length === 0}
        <div class="card">
          <EmptyState
            title="No journal entries"
            body="Post one manually or confirm reconciled slips. Debits always equal credits — core enforces it."
          >
            {#snippet actions()}
              <button class="btn btn-primary" onclick={openForm}
                >New journal entry</button
              >
            {/snippet}
          </EmptyState>
        </div>
      {:else}
        {@const entries = d.journal.filter((e) => matchesEntry(e, journalFilter))}
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <div class="relative w-full sm:w-72">
            <Icon
              name="search"
              size={14}
              class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
            />
            <input
              class="input pr-8 pl-8"
              placeholder="Filter by memo, account or date…"
              aria-label="Filter journal entries"
              bind:value={journalFilter}
            />
            {#if journalFilter}
              <button
                type="button"
                class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-t3 hover:text-t1"
                style="transition: color var(--dur-quick) var(--ease-standard);"
                aria-label="Clear journal filter"
                onclick={() => (journalFilter = "")}
              >
                <Icon name="x" size={13} />
              </button>
            {/if}
          </div>
          <span class="ml-auto text-[12px] text-t3">
            <span class="num tabular-nums">{entries.length}</span> of
            <span class="num tabular-nums">{d.journal.length}</span> entries
          </span>
        </div>
        {#if entries.length === 0}
          <div class="card">
            <EmptyState
              icon="search"
              title="No entry matches that"
              body="The filter looks at the memo, the account names on each line, and the entry date."
            >
              {#snippet actions()}
                <button class="btn" onclick={() => (journalFilter = "")}>
                  Clear filter
                </button>
              {/snippet}
            </EmptyState>
          </div>
        {:else}
          <div class="space-y-3">
            {#each entries as e (e.id)}
              {@const debit = e.lines.reduce((s, l) => s + l.debit_minor, 0)}
              <article class="card overflow-hidden">
                <header
                  class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-sunken/60 px-4 py-2.5"
                >
                  <span class="num shrink-0 text-t3">{fmtDate(e.entry_date)}</span>
                  <h3 class="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {e.memo}
                  </h3>
                  {#if e.source_document_id}
                    <Badge tone="neutral" dot={false} label="from a document" />
                  {/if}
                  <span class="num hidden text-[11px] text-t3 sm:inline"
                    >{e.lines.length} lines</span
                  >
                  <Money amount={debit} currency={bookCurrency} class="text-t2" />
                  <button
                    class="btn h-7 shrink-0"
                    aria-label="Reverse “{e.memo}”"
                    onclick={() => startReversal(e)}
                  >
                    <Icon name="reconcile" size={12} />
                    Reverse
                  </button>
                </header>
                <table class="w-full text-[12.5px]">
                  <caption class="sr-only">
                    Lines of “{e.memo}”, {fmtDate(e.entry_date)}
                  </caption>
                  <thead class="sr-only">
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Account</th>
                      <th scope="col">Debit</th>
                      <th scope="col">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each e.lines as l (l.id)}
                      {@const account = d.accounts.find(
                        (a) => a.id === l.ledger_account_id,
                      )}
                      <tr class="row-hover">
                        <td class="td num w-20 border-t-0 pl-4 text-t3"
                          >{account?.code ?? ""}</td
                        >
                        <td class="td max-w-0 border-t-0 text-t2">
                          <span class="block truncate">{l.ledger_account_name}</span>
                        </td>
                        <td class="td w-32 border-t-0 text-right">
                          {#if l.debit_minor}
                            <Money amount={l.debit_minor} currency={bookCurrency} />
                          {/if}
                        </td>
                        <td class="td w-32 border-t-0 pr-4 text-right">
                          {#if l.credit_minor}
                            <Money
                              amount={l.credit_minor}
                              currency={bookCurrency}
                              class="text-t2"
                            />
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </article>
            {/each}
          </div>
        {/if}
      {/if}
    {:else if d.trial.rows.every((r) => r.debit_minor === 0 && r.credit_minor === 0)}
      <div class="card">
        <EmptyState
          title="Trial balance is empty"
          body="Post journal entries and the per-account debit and credit totals land here."
        />
      </div>
    {:else}
      {@const rows = d.trial.rows.filter((r) => r.debit_minor || r.credit_minor)}
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p class="text-[12px] text-t3">
          As of <span class="num">{fmtDate(d.trial.as_of)}</span> · every posted
          entry in {d.trial.currency}
        </p>
        {#if d.trial.total_debit_minor === d.trial.total_credit_minor}
          <Badge tone="success" label="debits equal credits" />
        {:else}
          <Badge
            tone="danger"
            label="out of balance by {fmtMoney(
              Math.abs(d.trial.total_debit_minor - d.trial.total_credit_minor),
              d.trial.currency,
            )}"
          />
        {/if}
      </div>
      <div class="card overflow-hidden">
        <div class="table-wrap table-scroll">
          <table class="w-full text-[12.5px]">
            <thead>
              <tr>
                <th class="th w-20">Code</th>
                <th class="th">Account</th>
                <th class="th w-36 text-right">Debit</th>
                <th class="th w-36 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {#each typeOrder as type (type)}
                {@const group = rows.filter((r) => r.type === type)}
                {#if group.length > 0}
                  {@const groupDebit = group.reduce((s, r) => s + r.debit_minor, 0)}
                  {@const groupCredit = group.reduce((s, r) => s + r.credit_minor, 0)}
                  <tr>
                    <th
                      class="th sticky top-8 z-[1] border-t border-line bg-sunken"
                      colspan="4"
                      scope="colgroup"
                    >
                      {typeLabel[type]}
                    </th>
                  </tr>
                  {#each group as r (r.ledger_account_id)}
                    <tr class="row-hover">
                      <td class="td num text-t3">{r.code}</td>
                      <td class="td font-medium">{r.name}</td>
                      <td class="td text-right">
                        {#if r.debit_minor}
                          <Money amount={r.debit_minor} currency={d.trial.currency} />
                        {/if}
                      </td>
                      <td class="td text-right">
                        {#if r.credit_minor}
                          <Money amount={r.credit_minor} currency={d.trial.currency} />
                        {/if}
                      </td>
                    </tr>
                  {/each}
                  <!-- A subtotal under a single account is that account
                       again; the row only earns its place from two up. -->
                  {#if group.length > 1}
                  <tr class="text-t2">
                    <td class="td"></td>
                    <td class="td text-[11.5px]">
                      Subtotal · {typeLabel[type]}
                    </td>
                    <td class="td text-right">
                      <Money amount={groupDebit} currency={d.trial.currency} />
                    </td>
                    <td class="td text-right">
                      <Money amount={groupCredit} currency={d.trial.currency} />
                    </td>
                  </tr>
                  {/if}
                {/if}
              {/each}
            </tbody>
            <tfoot>
              <tr class="font-semibold">
                <td class="td sticky bottom-0 bg-panel" colspan="2">Totals</td>
                <td class="td sticky bottom-0 bg-panel text-right">
                  <Money
                    amount={d.trial.total_debit_minor}
                    currency={d.trial.currency}
                    class="font-semibold"
                  />
                </td>
                <td class="td sticky bottom-0 bg-panel text-right">
                  <Money
                    amount={d.trial.total_credit_minor}
                    currency={d.trial.currency}
                    class="font-semibold"
                  />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    {/if}
  </div>
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load ledger"
      body={String(err)}
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
