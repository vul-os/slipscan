<script lang="ts">
  import { api } from "../lib/api/client";
  import { fmtDate, fmtMoney, parseMoneyInput } from "../lib/format";
  import type { LedgerAccountType } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  type Tab = "accounts" | "journal" | "trial";
  let tab = $state<Tab>("accounts");

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "accounts", label: "Chart of accounts" },
    { id: "journal", label: "Journal" },
    { id: "trial", label: "Trial balance" },
  ];

  let bookId = $state("");

  async function load() {
    const [book] = await api.bookList();
    if (!book) throw new Error("no book configured");
    bookId = book.id;
    const [accounts, journal, trial] = await Promise.all([
      api.ledgerAccountList({ book_id: book.id }),
      api.journalList({ book_id: book.id }),
      api.reportTrialBalance({ book_id: book.id }),
    ]);
    return { accounts, journal, trial };
  }

  let data = $state(load());

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
  let entryDate = $state(new Date().toISOString().slice(0, 10));
  let memo = $state("");
  let lines = $state<FormLine[]>([blankLine(), blankLine()]);
  let posting = $state(false);
  let postError = $state<string | null>(null);

  function openForm() {
    tab = "journal";
    showForm = true;
    postError = null;
  }

  const lineMinor = (raw: string): number =>
    Math.max(0, parseMoneyInput(raw) ?? 0);
  const debitTotal = $derived(
    lines.reduce((s, l) => s + lineMinor(l.debit), 0),
  );
  const creditTotal = $derived(
    lines.reduce((s, l) => s + lineMinor(l.credit), 0),
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
      data = load();
    } catch (err) {
      postError = String(err);
    } finally {
      posting = false;
    }
  }

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
</script>

<PageHeader
  eyebrow="Double-entry"
  title="Ledger"
  subtitle="Chart of accounts, balanced journal entries, and the trial balance behind every report."
>
  {#snippet actions()}
    <button class="btn">
      <Icon name="plus" size={14} />
      Add account
    </button>
    <button class="btn btn-primary" onclick={openForm}>
      <Icon name="plus" size={14} />
      New journal entry
    </button>
  {/snippet}
</PageHeader>

<div class="mb-4 flex items-center gap-1 border-b border-line" role="tablist">
  {#each tabs as t (t.id)}
    <button
      role="tab"
      aria-selected={tab === t.id}
      class="-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors
        {tab === t.id
        ? 'border-accent text-t1'
        : 'border-transparent text-t3 hover:text-t2'}"
      onclick={() => (tab = t.id)}
    >
      {t.label}
    </button>
  {/each}
</div>

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then d}
  {#if tab === "accounts"}
    {#if d.accounts.length === 0}
      <div class="card">
        <EmptyState
          icon="ledger"
          title="No chart of accounts yet"
          body="Start from the standard SA template, or add accounts one by one with your own codes."
        >
          {#snippet actions()}
            <button class="btn btn-primary">Use standard template</button>
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="space-y-5">
        {#each typeOrder as type (type)}
          {@const rows = d.accounts.filter((a) => a.type === type)}
          {#if rows.length > 0}
            <section>
              <h2 class="eyebrow mb-2">{typeLabel[type]}</h2>
              <div class="card divide-y divide-line">
                {#each rows as a (a.id)}
                  <div class="group flex items-center gap-3 px-4 py-2.5">
                    <span class="num w-12 text-t3">{a.code}</span>
                    <span class="flex-1 text-[13px] font-medium">{a.name}</span>
                    {#if a.vat_rate_bp}
                      <Badge
                        tone="neutral"
                        dot={false}
                        label="VAT {a.vat_rate_bp / 100}%"
                      />
                    {/if}
                    <button
                      class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      View ledger
                      <Icon name="arrow-right" size={12} />
                    </button>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
        {/each}
      </div>
    {/if}
  {:else if tab === "journal"}
    {#if showForm}
      <form
        class="card mb-4 p-4"
        onsubmit={(e) => {
          e.preventDefault();
          postJournal();
        }}
      >
        <h2 class="mb-3 text-[13px] font-semibold">New journal entry</h2>
        {#if postError}
          <p
            class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            <Icon name="alert-circle" size={13} />
            {postError}
          </p>
        {/if}
        <div class="mb-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Date</span>
            <input class="input font-mono" type="date" bind:value={entryDate} />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Memo</span>
            <input
              class="input"
              placeholder="What is this entry for?"
              bind:value={memo}
            />
          </label>
        </div>
        <div class="space-y-2">
          {#each lines as line, i (i)}
            <div class="flex items-center gap-2">
              <select
                class="input h-8 flex-1"
                aria-label="Ledger account"
                bind:value={line.ledger_account_id}
              >
                <option value="" disabled>Account…</option>
                {#each d.accounts.filter((a) => !a.archived) as a (a.id)}
                  <option value={a.id}>{a.code} · {a.name}</option>
                {/each}
              </select>
              <input
                class="input h-8 w-32 text-right font-mono"
                placeholder="Debit"
                aria-label="Debit"
                bind:value={line.debit}
              />
              <input
                class="input h-8 w-32 text-right font-mono"
                placeholder="Credit"
                aria-label="Credit"
                bind:value={line.credit}
              />
              <button
                class="btn btn-ghost h-8 px-2"
                type="button"
                aria-label="Remove line"
                disabled={lines.length <= 2}
                onclick={() => (lines = lines.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          {/each}
        </div>
        <div class="mt-3 flex items-center gap-2">
          <button
            class="btn h-7"
            type="button"
            onclick={() => (lines = [...lines, blankLine()])}
          >
            <Icon name="plus" size={13} />
            Add line
          </button>
          <span class="ml-auto text-[12px] text-t3">
            Debit <span class="num">{fmtMoney(debitTotal)}</span> · Credit
            <span class="num">{fmtMoney(creditTotal)}</span>
          </span>
          {#if debitTotal === creditTotal && debitTotal > 0}
            <Badge tone="success" label="balanced" />
          {:else}
            <Badge tone="warning" label="unbalanced" />
          {/if}
          <button
            class="btn btn-primary h-7"
            type="submit"
            disabled={posting || debitTotal !== creditTotal || debitTotal === 0}
          >
            {posting ? "Posting…" : "Post entry"}
          </button>
          <button
            class="btn btn-ghost h-7"
            type="button"
            onclick={() => (showForm = false)}
          >
            Cancel
          </button>
        </div>
      </form>
    {/if}
    {#if d.journal.length === 0}
      <div class="card">
        <EmptyState
          icon="ledger"
          title="No journal entries"
          body="Entries appear here when you post them manually or confirm reconciled slips. Debits always equal credits — core enforces it."
        >
          {#snippet actions()}
            <button class="btn btn-primary" onclick={openForm}
              >New journal entry</button
            >
          {/snippet}
        </EmptyState>
      </div>
    {:else}
      <div class="space-y-3">
        {#each d.journal as e (e.id)}
          {@const debit = e.lines.reduce((s, l) => s + l.debit_minor, 0)}
          <article class="card overflow-hidden">
            <header
              class="flex items-center gap-3 border-b border-line bg-sunken/60 px-4 py-2.5"
            >
              <span class="num text-t3">{fmtDate(e.entry_date)}</span>
              <span class="flex-1 text-[13px] font-medium">{e.memo}</span>
              <Badge tone="success" label="balanced" />
              <span class="num text-t2">{fmtMoney(debit)}</span>
            </header>
            <table class="w-full text-[12.5px]">
              <tbody>
                {#each e.lines as l (l.id)}
                  <tr>
                    <td class="td border-t-0 pl-4 text-t2"
                      >{l.ledger_account_name}</td
                    >
                    <td class="td num w-32 border-t-0 text-right">
                      {l.debit_minor ? fmtMoney(l.debit_minor) : ""}
                    </td>
                    <td class="td num w-32 border-t-0 text-right text-t2">
                      {l.credit_minor ? fmtMoney(l.credit_minor) : ""}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </article>
        {/each}
      </div>
    {/if}
  {:else if d.trial.rows.every((r) => r.debit_minor === 0 && r.credit_minor === 0)}
    <div class="card">
      <EmptyState
        icon="reports"
        title="Trial balance is empty"
        body="Post journal entries and the running debit/credit totals per account will show here."
      />
    </div>
  {:else}
    <div class="card overflow-hidden">
      <table class="w-full border-collapse text-[12.5px]">
        <thead>
          <tr class="bg-sunken/60">
            <th class="th w-16">Code</th>
            <th class="th">Account</th>
            <th class="th w-36 text-right">Debit</th>
            <th class="th w-36 text-right">Credit</th>
          </tr>
        </thead>
        <tbody>
          {#each d.trial.rows.filter((r) => r.debit_minor || r.credit_minor) as r (r.ledger_account_id)}
            <tr class="hover:bg-sunken/50">
              <td class="td num text-t3">{r.code}</td>
              <td class="td font-medium">{r.name}</td>
              <td class="td num text-right"
                >{r.debit_minor ? fmtMoney(r.debit_minor) : ""}</td
              >
              <td class="td num text-right"
                >{r.credit_minor ? fmtMoney(r.credit_minor) : ""}</td
              >
            </tr>
          {/each}
          <tr class="bg-sunken/60 font-semibold">
            <td class="td" colspan="2">
              <span class="flex items-center gap-2">
                Totals
                {#if d.trial.total_debit_minor === d.trial.total_credit_minor}
                  <Badge tone="success" label="in balance" />
                {:else}
                  <Badge tone="danger" label="out of balance" />
                {/if}
              </span>
            </td>
            <td class="td num text-right"
              >{fmtMoney(d.trial.total_debit_minor)}</td
            >
            <td class="td num text-right"
              >{fmtMoney(d.trial.total_credit_minor)}</td
            >
          </tr>
        </tbody>
      </table>
    </div>
  {/if}
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load ledger"
      body={String(err)}
    />
  </div>
{/await}
