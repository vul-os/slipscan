<script lang="ts">
  /**
   * Household — whose money it is.
   *
   * Members are local data, never logins (ARCHITECTURE.md "Household members
   * & per-person attribution"): SlipScan has no authentication, and a member
   * describes whose money a transaction is, never who may open the book.
   * Attribution is metadata on the transaction — it never touches debits or
   * credits, so double-entry integrity is untouched; it only adds a member
   * dimension to reporting.
   *
   * Everything below is computed locally from the book's own rows: the four
   * member reports (expense, contribution, share-of-category, settle-up) are
   * ordinary SQL over this machine's database. Nothing here opens a socket.
   *
   * Attributing a single transaction, and splitting one across members,
   * belong to the row itself and live on Transactions.
   */
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/state/router.svelte";
  import {
    fmtMoney,
    fmtMonth,
    localMonth,
    monthEnd,
    shiftMonth,
  } from "../lib/util/format";
  import { swrLoad } from "../lib/loadCache";
  import type {
    Account,
    Member,
    MemberAmountRow,
    MemberCategoryRow,
    MemberSettleRow,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import MemberAvatar from "../lib/components/MemberAvatar.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

  const thisMonth = localMonth();
  let month = $state(thisMonth);

  async function load() {
    const book = requireBook(await api.bookList());
    const from = `${month}-01`;
    const to = monthEnd(month);
    const period = { book_id: book.id, from, to };
    const [members, accounts, expense, contribution, settleUp, byCategory] =
      await Promise.all([
        api.memberList({ book_id: book.id }),
        api.accountList({ book_id: book.id }),
        api.reportMemberExpense(period),
        api.reportMemberContribution(period),
        api.reportSettleUp(period),
        api.reportMemberCategory(period),
      ]);
    return { book, members, accounts, expense, contribution, settleUp, byCategory };
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>(`household:${month}`, load, (v) => (data = v), { fresh });
  let data = $state(reload());

  function goMonth(n: number) {
    month = shiftMonth(month, n);
    data = reload();
  }

  // -- members --------------------------------------------------------------
  // A member is a label, an initial and a colour, plus optionally the account
  // they own (which is what new transactions on it default their attribution
  // to). Core stores the colour verbatim and never interprets it.

  const memberSwatches = [
    "#6f9200", "#007fa3", "#b0761f", "#6a6fbf",
    "#b1524e", "#16a34a", "#d97706", "#dc2626",
  ];
  // Human names for the colour-swatch buttons' accessible names — a raw hex
  // string ("#6a6fbf") reads poorly to screen readers.
  const memberSwatchNames: Record<string, string> = {
    "#6f9200": "Olive",
    "#007fa3": "Teal",
    "#b0761f": "Ochre",
    "#6a6fbf": "Periwinkle",
    "#b1524e": "Clay",
    "#16a34a": "Green",
    "#d97706": "Amber",
    "#dc2626": "Red",
  };

  let membersError = $state<string | null>(null);
  let showMemberForm = $state(false);
  let memberLabel = $state("");
  let memberInitial = $state("");
  let memberColour = $state(memberSwatches[0]!);
  let memberDefaultAccount = $state("");
  let memberBusy = $state(false);
  let memberLabelInput = $state<HTMLInputElement | null>(null);

  /** Id of the member being edited inline, if any. */
  let editingMemberId = $state<string | null>(null);
  let editLabel = $state("");
  let editInitial = $state("");
  let editColour = $state("");
  let editDefaultAccount = $state("");
  let editBusy = $state(false);

  /**
   * Removing a member is arm-to-confirm through the shared prompt: focus
   * lands on Cancel, Escape cancels, and the await cannot be abandoned.
   *
   * Deliberately without `confirmPhrase`. Type-to-confirm is for the
   * unrecoverable, and this is not: a member carrying attributed history
   * cannot be removed at all until it is reassigned (core refuses, and the
   * refusal opens the picker below), and one carrying none is a label and a
   * colour that can be typed again in seconds. Making people spell out a name
   * to undo a typo is friction pretending to be safety.
   */
  let confirmRemove = $state<Member | null>(null);
  let removeBusy = $state<string | null>(null);
  let removeError = $state<string | null>(null);
  let reassignFor = $state<string | null>(null);
  let reassignTarget = $state("");

  const accountName = (accounts: Account[], accountId: string): string =>
    accounts.find((a) => a.id === accountId)?.name ?? "—";

  function closeMemberForm() {
    showMemberForm = false;
    memberLabel = "";
    memberInitial = "";
    memberColour = memberSwatches[0]!;
    memberDefaultAccount = "";
  }

  async function toggleMemberForm() {
    membersError = null;
    if (showMemberForm) {
      closeMemberForm();
      return;
    }
    showMemberForm = true;
    await tick();
    memberLabelInput?.focus();
  }

  async function addMember(bookId: string) {
    membersError = null;
    memberBusy = true;
    try {
      await api.memberAdd({
        book_id: bookId,
        label: memberLabel.trim(),
        initial: memberInitial.trim() || undefined,
        colour: memberColour,
        default_account_id: memberDefaultAccount || undefined,
      });
      closeMemberForm();
      data = reload(true);
    } catch (err) {
      membersError = String(err);
    } finally {
      memberBusy = false;
    }
  }

  function startEditMember(m: Member) {
    membersError = null;
    editingMemberId = editingMemberId === m.id ? null : m.id;
    editLabel = m.label;
    editInitial = m.initial;
    editColour = m.colour;
    editDefaultAccount = m.default_account_id ?? "";
  }

  async function saveMember(m: Member) {
    membersError = null;
    editBusy = true;
    try {
      await api.memberUpdate({
        id: m.id,
        label: editLabel.trim(),
        initial: editInitial.trim(),
        colour: editColour,
        // "" means the user chose no default account: send an explicit null
        // to clear it, rather than omitting the key, which means "leave as is".
        default_account_id: editDefaultAccount || null,
      });
      editingMemberId = null;
      data = reload(true);
    } catch (err) {
      membersError = String(err);
    } finally {
      editBusy = false;
    }
  }

  async function attemptRemoveMember(
    m: Member,
    members: Member[],
    reassignTo?: string,
  ) {
    membersError = null;
    removeError = null;
    removeBusy = m.id;
    try {
      await api.memberRemove({ id: m.id, reassign_to: reassignTo });
      if (reassignFor === m.id) reassignFor = null;
      confirmRemove = null;
      data = reload(true);
    } catch (err) {
      const msg = String(err);
      if (!reassignTo && msg.includes("attributed transactions or splits")) {
        // Not an error to show inside the prompt — it is a different
        // decision. Close the prompt and open the picker that can actually
        // resolve it, with the history intact.
        confirmRemove = null;
        reassignFor = m.id;
        reassignTarget = members.find((x) => x.id !== m.id)?.id ?? "";
      } else if (confirmRemove?.id === m.id) {
        removeError = msg;
      } else {
        membersError = msg;
      }
    } finally {
      removeBusy = null;
    }
  }

  // -- derived views over the reports ---------------------------------------

  const total = (rows: MemberAmountRow[]): number =>
    rows.reduce((s, r) => s + r.total_minor, 0);

  /** Share of the ranked rollup a row holds, 0–1. Zero totals give zero
   * rather than NaN, so a month with no activity still renders. */
  const share = (row: MemberAmountRow, sum: number): number =>
    sum <= 0 ? 0 : row.total_minor / sum;

  /**
   * Share-of-category, pivoted: one row per category, one column per member
   * who appears in the period. Categories are ordered by total spend, which
   * puts the household's real weight at the top.
   */
  function categoryMatrix(rows: MemberCategoryRow[]) {
    const columns: Array<{ id: string | null; label: string }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const key = r.member_id ?? "\0unattributed";
      if (!seen.has(key)) {
        seen.add(key);
        columns.push({ id: r.member_id, label: r.member_label });
      }
    }
    // Unattributed sorts last, like every other member-dimensioned report.
    columns.sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : 0));

    const byCategory = new Map<
      string,
      { name: string; cells: Map<string, number>; total: number }
    >();
    for (const r of rows) {
      const key = r.category_id ?? "\0uncategorized";
      const entry = byCategory.get(key) ?? {
        name: r.category_name,
        cells: new Map<string, number>(),
        total: 0,
      };
      const cell = r.member_id ?? "\0unattributed";
      entry.cells.set(cell, (entry.cells.get(cell) ?? 0) + r.total_minor);
      entry.total += r.total_minor;
      byCategory.set(key, entry);
    }
    const categories = [...byCategory.entries()]
      .map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => b.total - a.total);
    return { columns, categories };
  }

  const cellKey = (memberId: string | null): string =>
    memberId ?? "\0unattributed";

  /** Widest absolute net in the period — the scale the diverging settle-up
   * bars are drawn against. Never zero, so the divide is always safe. */
  const settleScale = (rows: MemberSettleRow[]): number =>
    Math.max(1, ...rows.map((r) => Math.abs(r.net_minor)));
</script>

<PageHeader
  eyebrow={fmtMonth(month)}
  title="Household"
  subtitle="The people sharing this book, and what each of them put in and spent. Members are local rows like categories are — no accounts, no logins, nothing hosted."
>
  {#snippet actions()}
    <div class="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
      <button
        class="btn btn-ghost h-7 px-2"
        aria-label="Previous month"
        onclick={() => goMonth(-1)}
      >
        <Icon name="chevron-left" size={13} />
      </button>
      <!-- min-width keeps the chevrons from drifting as month names change -->
      <span
        class="flex min-w-[7.5rem] items-center justify-center gap-1.5 px-1.5 text-[12.5px] font-medium"
        aria-live="polite"
      >
        <Icon name="calendar" size={13} class="text-t3" />
        {fmtMonth(month)}
      </span>
      <button
        class="btn btn-ghost h-7 px-2"
        aria-label="Next month"
        onclick={() => goMonth(1)}
      >
        <Icon name="chevron-right" size={13} />
      </button>
    </div>
    {#if month !== thisMonth}
      <button
        class="btn h-8"
        onclick={() => {
          month = thisMonth;
          data = reload();
        }}
      >
        Today
      </button>
    {/if}
    <button class="btn btn-primary" onclick={toggleMemberForm}>
      <Icon name="plus" size={14} />
      Add member
    </button>
  {/snippet}
</PageHeader>

{#if membersError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    {membersError}
  </p>
{/if}

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then d}
  {@const spent = total(d.expense)}
  {@const contributed = total(d.contribution)}

  {#if showMemberForm}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
         Escape-to-close only; interaction lives on the inputs/buttons. -->
    <form
      class="card animate-slide-up mb-4 grid gap-3 p-4 sm:grid-cols-2"
      onsubmit={(e) => {
        e.preventDefault();
        void addMember(d.book.id);
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") closeMemberForm();
      }}
    >
      <h2 class="text-[13px] font-semibold sm:col-span-2">New member</h2>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
        <input
          class="input"
          placeholder="Alex"
          bind:this={memberLabelInput}
          bind:value={memberLabel}
          required
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Initial (optional)</span
        >
        <input
          class="input"
          maxlength={2}
          placeholder={memberLabel.charAt(0).toUpperCase() || "A"}
          bind:value={memberInitial}
        />
      </label>
      <div class="block sm:col-span-2">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Colour</span>
        <div
          class="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Colour"
        >
          {#each memberSwatches as swatch (swatch)}
            <button
              type="button"
              class="size-6 rounded-full ring-offset-2 ring-offset-panel transition-shadow {memberColour ===
              swatch
                ? 'ring-2 ring-t1'
                : 'hover:ring-2 hover:ring-line-2'}"
              style="background-color: {swatch};"
              aria-pressed={memberColour === swatch}
              aria-label={memberSwatchNames[swatch] ?? swatch}
              onclick={() => (memberColour = swatch)}
            ></button>
          {/each}
        </div>
      </div>
      <label class="block sm:col-span-2">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Default account (optional) — new transactions on it attribute here
          unless overridden</span
        >
        <select class="input" bind:value={memberDefaultAccount}>
          <option value="">No default — joint / shared</option>
          {#each d.accounts as a (a.id)}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
      </label>
      <div class="flex items-center gap-2 sm:col-span-2">
        <button
          class="btn btn-primary h-7"
          type="submit"
          disabled={memberBusy || !memberLabel.trim()}
        >
          {memberBusy ? "Adding…" : "Add member"}
        </button>
        <button class="btn btn-ghost h-7" type="button" onclick={closeMemberForm}>
          Cancel
        </button>
      </div>
    </form>
  {/if}

  {#if d.members.length === 0}
    <div class="card">
      <EmptyState
        icon="wallet"
        title="No household members yet"
        body="Add the people sharing this book to see spend and contributions per person, each one's share of every category, and where everybody stands at the end of the month — all computed on this machine."
      >
        {#snippet actions()}
          <button class="btn btn-primary" onclick={toggleMemberForm}>
            <Icon name="plus" size={14} />
            Add the first member
          </button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <div class="mb-4 grid gap-3 sm:grid-cols-3">
      <StatCard
        label="Contributed"
        amount={contributed}
        currency={d.book.currency}
        sub="Money in, attributed per person"
      />
      <StatCard
        label="Attributed spend"
        amount={spent}
        currency={d.book.currency}
        sub="Money out, splits distributed"
      />
      <StatCard
        label="Members"
        value={String(d.members.length)}
        tone="accent"
        sub={d.members.map((m) => m.label).join(" · ")}
      />
    </div>

    <!-- members ------------------------------------------------------- -->
    <section class="card mb-4 overflow-hidden">
      <header class="flex items-baseline justify-between px-4 pt-4 pb-3">
        <h2 class="text-[13px] font-semibold">Members</h2>
        <span class="text-[11px] text-t3">
          Attribute or split a single transaction on
          <button
            class="underline underline-offset-2 hover:text-t2"
            onclick={() => router.go("transactions")}
          >
            Transactions
          </button>
        </span>
      </header>
      <ul class="divide-y divide-line border-t border-line">
        {#each d.members as m (m.id)}
          {@const mySpend =
            d.expense.find((r) => r.member_id === m.id)?.total_minor ?? 0}
          {@const myIn =
            d.contribution.find((r) => r.member_id === m.id)?.total_minor ?? 0}
          <li class="row-hover px-4 py-3">
            <div class="flex flex-wrap items-center gap-3">
              <MemberAvatar member={m} size={28} />
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">{m.label}</span>
                <span class="block truncate text-[10.5px] text-t3">
                  {m.default_account_id
                    ? `Owns ${accountName(d.accounts, m.default_account_id)}`
                    : "No default account — joint / shared"}
                </span>
              </span>
              <!-- The two figures that matter, aligned across every row. -->
              <span class="flex shrink-0 items-center gap-4">
                <span class="text-right leading-tight">
                  <span class="block text-[10px] tracking-[0.08em] text-t3 uppercase"
                    >In</span
                  >
                  <span class="num block">{fmtMoney(myIn, d.book.currency)}</span>
                </span>
                <span class="text-right leading-tight">
                  <span class="block text-[10px] tracking-[0.08em] text-t3 uppercase"
                    >Out</span
                  >
                  <span class="num block">{fmtMoney(mySpend, d.book.currency)}</span>
                </span>
              </span>
              <div class="flex shrink-0 items-center gap-1.5">
                <button class="btn h-7" onclick={() => startEditMember(m)}>
                  <Icon name="pencil" size={13} />
                  {editingMemberId === m.id ? "Close" : "Edit"}
                </button>
                <button
                  class="btn btn-danger h-7"
                  disabled={removeBusy === m.id}
                  onclick={() => {
                    removeError = null;
                    confirmRemove = m;
                  }}
                >
                  <Icon name="trash" size={13} />
                  Remove
                </button>
              </div>
            </div>

            {#if reassignFor === m.id}
              <div
                class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5"
              >
                <Icon name="alert-circle" size={13} class="shrink-0 text-warning" />
                <span class="text-[11.5px] text-warning"
                  >Has attributed transactions or splits — move them to:</span
                >
                <select class="input h-7 w-40" bind:value={reassignTarget}>
                  {#each d.members.filter((x) => x.id !== m.id) as other (other.id)}
                    <option value={other.id}>{other.label}</option>
                  {/each}
                </select>
                <button
                  class="btn btn-primary h-7"
                  disabled={!reassignTarget || removeBusy === m.id}
                  onclick={() => attemptRemoveMember(m, d.members, reassignTarget)}
                >
                  Reassign &amp; remove
                </button>
                <button class="btn btn-ghost h-7" onclick={() => (reassignFor = null)}>
                  Cancel
                </button>
              </div>
            {/if}

            {#if editingMemberId === m.id}
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
                   Escape-to-close only; interaction lives on the inputs/buttons. -->
              <form
                class="mt-2 grid gap-3 rounded-lg border border-line bg-sunken/40 p-3 sm:grid-cols-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  void saveMember(m);
                }}
                onkeydown={(e) => {
                  if (e.key === "Escape") editingMemberId = null;
                }}
              >
                <label class="block">
                  <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
                  <input class="input" bind:value={editLabel} required />
                </label>
                <label class="block">
                  <span class="mb-1 block text-[11.5px] font-medium text-t2"
                    >Initial</span
                  >
                  <input class="input" maxlength={2} bind:value={editInitial} required />
                </label>
                <div class="block sm:col-span-2">
                  <span class="mb-1 block text-[11.5px] font-medium text-t2"
                    >Colour</span
                  >
                  <div
                    class="flex flex-wrap items-center gap-1.5"
                    role="group"
                    aria-label="Colour"
                  >
                    {#each memberSwatches as swatch (swatch)}
                      <button
                        type="button"
                        class="size-6 rounded-full ring-offset-2 ring-offset-panel transition-shadow {editColour ===
                        swatch
                          ? 'ring-2 ring-t1'
                          : 'hover:ring-2 hover:ring-line-2'}"
                        style="background-color: {swatch};"
                        aria-pressed={editColour === swatch}
                        aria-label={memberSwatchNames[swatch] ?? swatch}
                        onclick={() => (editColour = swatch)}
                      ></button>
                    {/each}
                  </div>
                </div>
                <label class="block sm:col-span-2">
                  <span class="mb-1 block text-[11.5px] font-medium text-t2"
                    >Default account</span
                  >
                  <select class="input" bind:value={editDefaultAccount}>
                    <option value="">No default — joint / shared</option>
                    {#each d.accounts as a (a.id)}
                      <option value={a.id}>{a.name}</option>
                    {/each}
                  </select>
                </label>
                <div class="flex items-center gap-2 sm:col-span-2">
                  <button
                    class="btn btn-primary h-7"
                    type="submit"
                    disabled={editBusy || !editLabel.trim() || !editInitial.trim()}
                  >
                    {editBusy ? "Saving…" : "Save"}
                  </button>
                  <button
                    class="btn btn-ghost h-7"
                    type="button"
                    onclick={() => (editingMemberId = null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    <!-- rollups ------------------------------------------------------- -->
    <div class="mb-4 grid gap-4 lg:grid-cols-2">
      {#each [{ title: "Spend by member", rows: d.expense, sum: spent, empty: "Nothing attributed out this month." }, { title: "Contributions by member", rows: d.contribution, sum: contributed, empty: "Nothing attributed in this month." }] as panel (panel.title)}
        <section class="card p-4">
          <header class="mb-4 flex items-baseline justify-between">
            <h2 class="text-[13px] font-semibold">{panel.title}</h2>
            <span class="num text-t2">{fmtMoney(panel.sum, d.book.currency)}</span>
          </header>
          {#if panel.rows.length === 0}
            <p class="py-6 text-center text-[12px] text-t3">{panel.empty}</p>
          {:else}
            <ul class="space-y-2.5">
              {#each panel.rows as row (row.member_id ?? "unattributed")}
                <li class="flex items-center gap-3">
                  <MemberAvatar
                    member={row.member_id
                      ? (d.members.find((m) => m.id === row.member_id) ?? null)
                      : null}
                    size={20}
                  />
                  <span class="w-24 truncate text-[12px] text-t2"
                    >{row.member_label}</span
                  >
                  <div class="meter flex-1">
                    <div
                      class="meter-fill"
                      style="width: {Math.max(2, share(row, panel.sum) * 100)}%"
                    ></div>
                  </div>
                  <span class="num w-24 text-right"
                    >{fmtMoney(row.total_minor, row.currency)}</span
                  >
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    </div>

    <!-- settle up ----------------------------------------------------- -->
    <section class="card mb-4 p-4">
      <header class="mb-1 flex items-baseline justify-between gap-3">
        <h2 class="text-[13px] font-semibold">Settle up · {fmtMonth(month)}</h2>
        <span class="text-[11px] text-t3">contributions − attributed spend</span>
      </header>
      <p class="mb-4 text-[11.5px] text-t3">
        A member's net is their standing with the household pool over this
        period. Positive (right of the line) means the household owes them;
        negative means they owe the household. How you actually square up —
        equal shares, proportional to income, or not at all — is the
        household's call, not SlipScan's.
      </p>
      {#if d.settleUp.length === 0}
        <EmptyState
          icon="wallet"
          title="Nothing to settle for {fmtMonth(month)}"
          body="No attributed activity landed in this period."
        />
      {:else}
        {@const scale = settleScale(d.settleUp)}
        <div class="table-wrap">
          <table class="w-full text-[12.5px]">
            <thead>
              <tr>
                <th class="th" scope="col">Member</th>
                <th class="th text-right" scope="col">Contributed</th>
                <th class="th text-right" scope="col">Spent</th>
                <th class="th text-right" scope="col">Net</th>
                <th class="th w-[34%]" scope="col">
                  <span class="sr-only">Net position</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {#each d.settleUp as row (row.member_id ?? "unattributed")}
                {@const width = (Math.abs(row.net_minor) / scale) * 50}
                <tr class="row-hover">
                  <td class="td">
                    <span class="flex items-center gap-2">
                      <MemberAvatar
                        member={row.member_id
                          ? (d.members.find((m) => m.id === row.member_id) ?? null)
                          : null}
                        size={18}
                      />
                      {row.member_label}
                    </span>
                  </td>
                  <td class="td num text-right"
                    >{fmtMoney(row.contributions_minor, row.currency)}</td
                  >
                  <td class="td num text-right"
                    >{fmtMoney(row.expenses_minor, row.currency)}</td
                  >
                  <td
                    class="td num text-right {row.net_minor > 0
                      ? 'text-success'
                      : row.net_minor < 0
                        ? 'text-danger'
                        : ''}"
                  >
                    {fmtMoney(row.net_minor, row.currency, { signed: true })}
                  </td>
                  <!-- Diverging bar around a zero axis: the figures in the
                       row carry the data, so this is aria-hidden. -->
                  <td class="td">
                    <div class="relative h-3" aria-hidden="true">
                      <span
                        class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line"
                      ></span>
                      <span
                        class="absolute top-1/2 left-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-line-2"
                      ></span>
                      {#if row.net_minor > 0}
                        <span
                          class="absolute top-1/2 left-1/2 h-[3px] -translate-y-1/2 rounded-r-full bg-success"
                          style="width: {Math.max(1, width)}%;
                            transition: width var(--dur-slow) var(--ease-standard);"
                        ></span>
                      {:else if row.net_minor < 0}
                        <span
                          class="absolute top-1/2 right-1/2 h-[3px] -translate-y-1/2 rounded-l-full bg-danger"
                          style="width: {Math.max(1, width)}%;
                            transition: width var(--dur-slow) var(--ease-standard);"
                        ></span>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <!-- share of category --------------------------------------------- -->
    {@const matrix = categoryMatrix(d.byCategory)}
    <section class="card p-4">
      <header class="mb-1 flex items-baseline justify-between gap-3">
        <h2 class="text-[13px] font-semibold">Share of category</h2>
        <span class="text-[11px] text-t3">outflows only</span>
      </header>
      <p class="mb-4 text-[11.5px] text-t3">
        Each person's slice of every category this month. A split transaction
        contributes each member their own share; anything nobody is attributed
        for lands in Unattributed.
      </p>
      {#if matrix.categories.length === 0}
        <EmptyState
          icon="budgets"
          title="No attributed spend in {fmtMonth(month)}"
          body="Once transactions in this period carry a member, their share of each category breaks down here."
        />
      {:else}
        <div class="table-wrap">
          <table class="w-full text-[12.5px]">
            <thead>
              <tr>
                <th class="th" scope="col">Category</th>
                {#each matrix.columns as col (col.id ?? "unattributed")}
                  <th class="th text-right" scope="col">
                    <span class="flex items-center justify-end gap-1.5">
                      <MemberAvatar
                        member={col.id
                          ? (d.members.find((m) => m.id === col.id) ?? null)
                          : null}
                        size={16}
                      />
                      {col.label}
                    </span>
                  </th>
                {/each}
                <th class="th text-right" scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {#each matrix.categories as row (row.id)}
                <tr class="row-hover">
                  <th class="td text-left font-medium" scope="row">{row.name}</th>
                  {#each matrix.columns as col (col.id ?? "unattributed")}
                    {@const cell = row.cells.get(cellKey(col.id)) ?? 0}
                    <td class="td num text-right {cell === 0 ? 'text-t3' : ''}">
                      {cell === 0 ? "—" : fmtMoney(cell, d.book.currency)}
                    </td>
                  {/each}
                  <td class="td num text-right font-medium">
                    {fmtMoney(row.total, d.book.currency)}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
        <Icon name="shield" size={12} />
        Members, attributions and settle-up are ordinary rows in this book.
        None of it introduces a network call, an account, or a hosted service.
      </p>
    </section>
  {/if}

  <!-- Lives inside the resolved branch because the reassign fallback needs
       the loaded member list to offer somewhere for the history to go. -->
  {#if confirmRemove}
    {@const target = confirmRemove}
    <ConfirmDialog
      open
      title="Remove {target.label}?"
      body="No transaction is deleted or changed — attribution is metadata, and removing a member never touches a debit or a credit. If anything is still attributed to {target.label}, SlipScan refuses outright and offers to move that history to another member first, so nothing is quietly orphaned."
      confirmLabel="Remove member"
      tone="danger"
      busy={removeBusy === target.id}
      error={removeError}
      onconfirm={() => attemptRemoveMember(target, d.members)}
      oncancel={() => {
        if (removeBusy) return;
        confirmRemove = null;
        removeError = null;
      }}
    />
  {/if}
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load the household"
      body={String(err)}
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
