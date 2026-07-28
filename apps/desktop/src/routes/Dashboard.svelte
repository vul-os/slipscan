<script lang="ts">
  /**
   * Dashboard — the month at a glance, and a way into every figure on it.
   *
   * The rule this screen is held to: **no dead numbers**. Every stat, every
   * category bar, every recent line and every nudge leads to the rows that
   * produced it, so a figure that looks wrong can be interrogated instead of
   * merely doubted. Transactions accepts its filters through the hash query
   * (`#/transactions?category=…&from=…&to=…`), which the router ignores by
   * design — see `fromHash` in router.svelte.ts.
   *
   * Nudges are computed here, on this machine, from data already fetched
   * (lib/nudges.ts). What is new is that each one now carries somewhere to
   * go: "Groceries is over budget" is only useful next to the spend that made
   * it so.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import {
    fmtDate,
    fmtMoney,
    fmtMonth,
    fmtPct,
    greeting,
    localMonth,
    monthEnd,
  } from "../lib/format";
  import { swrLoad } from "../lib/loadCache";
  import { computeNudges, type Nudge, type NudgeSeverity } from "../lib/nudges";
  import { requestIntent } from "../lib/intent.svelte";
  import { router, type RouteId } from "../lib/router.svelte";
  import type { Member, MemberAmountRow } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import StatCard from "../lib/components/StatCard.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import MemberAvatar from "../lib/components/MemberAvatar.svelte";

  const month = localMonth();
  const periodFrom = `${month}-01`;
  const periodTo = monthEnd(month);

  /**
   * Navigate to Transactions carrying a filter.
   *
   * The router owns `#/<route>` and drops anything after `?`, so the query
   * string is free for exactly this. Written straight to `location.hash`
   * rather than through `router.go`, which would rebuild the hash and throw
   * the filter away; the shell's `hashchange` listener still picks it up.
   */
  function openTransactions(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    window.location.hash = qs ? `/transactions?${qs}` : "/transactions";
  }

  /** Open one transaction, expanded — the palette's existing hand-off. */
  function openTransaction(id: string) {
    requestIntent({ kind: "reveal-transaction", id });
    router.go("transactions");
  }

  /** Per-person spend + contribution for the period, joined by member —
   * every current member appears, even at zero. */
  interface HouseholdRow {
    member: Member | null;
    label: string;
    spentMinor: number;
    contributedMinor: number;
  }

  function joinHousehold(
    members: Member[],
    expense: MemberAmountRow[],
    contribution: MemberAmountRow[],
  ): HouseholdRow[] {
    const spent = new Map(expense.map((r) => [r.member_id, r.total_minor]));
    const contributed = new Map(contribution.map((r) => [r.member_id, r.total_minor]));
    const rows: HouseholdRow[] = members.map((m) => ({
      member: m,
      label: m.label,
      spentMinor: spent.get(m.id) ?? 0,
      contributedMinor: contributed.get(m.id) ?? 0,
    }));
    const unattributedSpent = spent.get(null) ?? 0;
    const unattributedContributed = contributed.get(null) ?? 0;
    if (unattributedSpent !== 0 || unattributedContributed !== 0) {
      rows.push({
        member: null,
        label: "Unattributed",
        spentMinor: unattributedSpent,
        contributedMinor: unattributedContributed,
      });
    }
    return rows;
  }

  /** Where a nudge leads. Rendered as buttons under the nudge itself. */
  interface NudgeTarget {
    label: string;
    route: RouteId;
    /** Only meaningful for `transactions`; see `openTransactions`. */
    params?: Record<string, string>;
  }

  /**
   * Turn a nudge into somewhere to go.
   *
   * This reads nudges.ts's own output shape: budget nudge ids end in the
   * category id (`budget-over-<id>`), and the duplicate/subscription titles
   * carry the exact merchant string after the colon. Both are a deliberate
   * coupling to that module and nothing else — the alternative was to teach
   * every nudge about routing, which would put navigation inside a pure
   * rules-and-stats pass.
   */
  function nudgeTargets(n: Nudge): NudgeTarget[] {
    if (n.kind === "budget") {
      const categoryId = n.id.replace(/^budget-(over|drift)-/, "");
      return [
        {
          label: "See the spend",
          route: "transactions",
          params: { category: categoryId, from: periodFrom, to: periodTo },
        },
        { label: "Adjust the budget", route: "budgets" },
      ];
    }
    const merchant = n.title.slice(n.title.indexOf(":") + 1).trim();
    if (!merchant) return [{ label: "Open transactions", route: "transactions" }];
    return [
      {
        label:
          n.kind === "duplicate" ? "Compare the charges" : "See every charge",
        route: "transactions",
        params: { q: merchant },
      },
    ];
  }

  async function load() {
    const book = requireBook(await api.bookList());
    const [
      accounts,
      categories,
      members,
      transactions,
      docs,
      budgets,
      spending,
      memberExpense,
      memberContribution,
    ] = await Promise.all([
      api.accountList({ book_id: book.id }),
      api.categoryList({ book_id: book.id }),
      api.memberList({ book_id: book.id }),
      api.transactionList({ book_id: book.id }),
      api.documentList({ book_id: book.id }),
      api.budgetList({ book_id: book.id, month }),
      api.reportSpending({ book_id: book.id, from: periodFrom, to: periodTo }),
      api.reportMemberExpense({ book_id: book.id, from: periodFrom, to: periodTo }),
      api.reportMemberContribution({
        book_id: book.id,
        from: periodFrom,
        to: periodTo,
      }),
    ]);
    // Nudges are computed right here, on-device, from the stats above.
    const nudges = computeNudges({ transactions, budgets, categories, month });
    return {
      book,
      accounts,
      categories,
      recent: transactions.slice(0, 7),
      uncategorised: transactions.filter((t) => t.category_id === null).length,
      docs,
      budgets,
      spending,
      nudges,
      members,
      household: joinHousehold(members, memberExpense, memberContribution),
    };
  }

  type Data = Awaited<ReturnType<typeof load>>;
  const reload = (fresh = false) =>
    swrLoad<Data>("dashboard", load, (v) => (data = v), { fresh });
  let data = $state(reload());

  const nudgeTone: Record<NudgeSeverity, "danger" | "warning" | "accent"> = {
    danger: "danger",
    warning: "warning",
    info: "accent",
  };
  const nudgeLabel: Record<NudgeSeverity, string> = {
    danger: "act now",
    warning: "heads up",
    info: "insight",
  };
</script>

{#snippet target(t: NudgeTarget)}
  <button
    class="btn h-7"
    onclick={() =>
      t.route === "transactions"
        ? openTransactions(t.params)
        : router.go(t.route)}
  >
    {t.label}
    <Icon name="arrow-right" size={12} />
  </button>
{/snippet}

{#await data}
  <!-- Loading mirrors the loaded layout so nothing jumps on arrival. -->
  <div aria-busy="true">
    <div class="mb-6">
      <div class="skeleton h-2.5 w-32"></div>
      <div class="skeleton mt-2.5 h-7 w-64 max-w-full"></div>
      <div class="skeleton mt-2 h-3 w-80 max-w-full"></div>
    </div>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {#each Array.from({ length: 4 }, (_, i) => i) as i (i)}
        <div class="card p-4">
          <div class="skeleton h-2.5 w-20"></div>
          <div class="skeleton mt-3 h-6 w-28"></div>
          <div class="skeleton mt-3 h-2.5 w-24"></div>
        </div>
      {/each}
    </div>
    <div class="mt-4 grid gap-4 lg:grid-cols-5">
      <div class="card lg:col-span-2"><Skeleton rows={5} /></div>
      <div class="card lg:col-span-3"><Skeleton rows={7} /></div>
    </div>
  </div>
{:then d}
  {@const netMinor = d.accounts.reduce((s, a) => s + a.balance_minor, 0)}
  {@const budgetLeft = d.budgets.reduce(
    (s, b) => s + Math.max(0, b.amount_minor - b.spent_minor),
    0,
  )}
  {@const toReview = d.docs.filter((x) => x.status !== "reviewed").length}
  {@const catName = (id: string | null) =>
    d.categories.find((c) => c.id === id)?.name ?? "Uncategorised"}

  <PageHeader
    eyebrow="{d.book.name} · {d.book.currency}"
    title="{greeting()}."
    subtitle="Here is where {fmtMonth(month)} stands across your accounts. Every figure below opens the rows behind it."
  >
    {#snippet actions()}
      <button class="btn" onclick={() => router.go("reports")}>
        <Icon name="reports" size={14} />
        Reports
      </button>
      <button class="btn btn-primary" onclick={() => router.go("receipts")}>
        <Icon name="upload" size={14} />
        Import receipt
      </button>
    {/snippet}
  </PageHeader>

  <!-- Stats. Each is a control, not a caption: the figure and the rows that
       made it are one click apart, so nothing here has to be taken on
       trust. The 1px lift on hover is the same press language as .btn. -->
  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <button
      class="block w-full rounded-xl text-left transition-transform hover:-translate-y-px focus-visible:rounded-xl"
      aria-label="Net balance {fmtMoney(
        netMinor,
        d.book.currency,
      )} across {d.accounts.length} accounts — open every transaction"
      onclick={() => openTransactions()}
    >
      <StatCard
        label="Net balance"
        amount={netMinor}
        currency={d.book.currency}
        sub="{d.accounts.length} accounts · see every line"
        tone="accent"
      />
    </button>
    <button
      class="block w-full rounded-xl text-left transition-transform hover:-translate-y-px focus-visible:rounded-xl"
      aria-label="Spent in {fmtMonth(month)}: {fmtMoney(
        d.spending.total_spent_minor,
        d.spending.currency,
      )} — open this month's transactions"
      onclick={() => openTransactions({ from: periodFrom, to: periodTo })}
    >
      <StatCard
        label="Spent · {fmtMonth(month)}"
        amount={d.spending.total_spent_minor}
        currency={d.spending.currency}
        sub="across {d.spending.by_category.length} categories"
      />
    </button>
    <button
      class="block w-full rounded-xl text-left transition-transform hover:-translate-y-px focus-visible:rounded-xl"
      aria-label="Budget remaining {fmtMoney(
        budgetLeft,
        d.book.currency,
      )} across {d.budgets.length} category budgets — open Budgets"
      onclick={() => router.go("budgets")}
    >
      <StatCard
        label="Budget remaining"
        amount={budgetLeft}
        currency={d.book.currency}
        sub="{d.budgets.length} category budgets"
      />
    </button>
    <button
      class="block w-full rounded-xl text-left transition-transform hover:-translate-y-px focus-visible:rounded-xl"
      aria-label="{toReview} slips to review — open Receipts"
      onclick={() => {
        window.location.hash = "/receipts?status=review";
      }}
    >
      <StatCard
        label="Slips to review"
        value={String(toReview)}
        sub={toReview > 0 ? "waiting in Receipts" : "all caught up"}
        tone={toReview > 0 ? "warning" : "neutral"}
      />
    </button>
  </div>

  <!-- Uncategorised work, stated where it can be acted on. Correcting one
       merchant teaches SlipScan the rest, which is why this is a first-class
       call to action rather than a statistic. -->
  {#if d.uncategorised > 0}
    <button
      class="row-hover mt-3 flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-warning/25 bg-warning/10 px-4 py-2.5 text-left focus-visible:rounded-xl"
      onclick={() => openTransactions({ category: "none" })}
    >
      <Icon name="alert-circle" size={15} class="shrink-0 text-warning" />
      <span class="min-w-0 flex-1 text-[12.5px] leading-snug">
        <span class="font-medium">
          <span class="num">{d.uncategorised}</span>
          {d.uncategorised === 1 ? "transaction is" : "transactions are"} uncategorised
        </span>
        <span class="block text-[11.5px] text-t2">
          Fix one and SlipScan classifies that merchant from then on.
        </span>
      </span>
      <span class="flex shrink-0 items-center gap-1 text-[12px] font-medium">
        Categorise
        <Icon name="arrow-right" size={13} />
      </span>
    </button>
  {/if}

  <!-- nudges: 100% local rules + stats over your own data, each with
       somewhere to go -->
  {#if d.nudges.length > 0}
    <section class="card relative mt-4 overflow-hidden">
      <!-- The lime pen-stroke rule: quiet card, one crisp mark. -->
      <span
        class="absolute inset-y-0 left-0 w-0.5 bg-accent"
        aria-hidden="true"
      ></span>
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="sparkle" size={15} class="text-accent-ring dark:text-accent" />
          Nudges
          <span class="num text-t3">{d.nudges.length}</span>
        </h2>
        <span class="flex items-center gap-1.5 text-[11px] text-t3">
          <Icon name="shield" size={12} />
          computed on this machine
        </span>
      </header>
      <ul class="mt-2 pb-2">
        {#each d.nudges as n (n.id)}
          <li
            class="row-hover flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-line px-4 py-2.5 first:border-t-0"
          >
            <span class="mt-0.5 shrink-0">
              <Badge tone={nudgeTone[n.severity]} label={nudgeLabel[n.severity]} />
            </span>
            <span class="min-w-0 flex-1 leading-tight">
              <span class="block text-[12.5px] font-medium">{n.title}</span>
              <span class="block text-[11.5px] text-t3">{n.body}</span>
            </span>
            <span class="flex shrink-0 items-center gap-2">
              {#each nudgeTargets(n) as t (t.label)}
                {@render target(t)}
              {/each}
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <div class="mt-4 grid gap-4 lg:grid-cols-5">
    <!-- spending by category -->
    <section class="card lg:col-span-2">
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="text-[13px] font-semibold">Spending by category</h2>
        <button
          class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
          onclick={() => router.go("budgets")}
        >
          Budgets
          <Icon name="arrow-right" size={12} />
        </button>
      </header>
      {#if d.spending.by_category.length === 0}
        <EmptyState
          title="Nothing spent yet"
          body="When transactions land, the month breaks down here."
        />
      {:else}
        <ul class="space-y-1 p-2">
          {#each d.spending.by_category.slice(0, 6) as row (row.category_id)}
            <!-- The report keys uncategorised spend under an id no category
                 has; the filter for it is `none`, not that id. -->
            {@const known = d.categories.some((c) => c.id === row.category_id)}
            <li>
              <button
                class="group row-hover w-full rounded-lg px-2 py-1.5 text-left"
                aria-label="{row.category_name}: {fmtMoney(
                  row.amount_minor,
                  d.spending.currency,
                )}, {fmtPct(row.share)} of the month — open those transactions"
                onclick={() =>
                  openTransactions({
                    category: known ? row.category_id : "none",
                    from: periodFrom,
                    to: periodTo,
                  })}
              >
                <span class="mb-1 flex items-baseline justify-between gap-2">
                  <span class="truncate text-[12.5px] text-t2"
                    >{row.category_name}</span
                  >
                  <span class="num text-t1"
                    >{fmtMoney(row.amount_minor, d.spending.currency)}
                    <span class="text-t3">· {fmtPct(row.share)}</span></span
                  >
                </span>
                <!-- Single-series ranked bar — the shared .meter system, so
                     the spending hue (chart-1) stays identical to Reports. -->
                <span class="meter block">
                  <span
                    class="meter-fill block group-hover:opacity-100"
                    style="width: {Math.max(2, row.share * 100)}%"
                  ></span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- recent activity -->
    <section class="card lg:col-span-3">
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="text-[13px] font-semibold">Recent activity</h2>
        <button
          class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
          onclick={() => openTransactions()}
        >
          All transactions
          <Icon name="arrow-right" size={12} />
        </button>
      </header>
      {#if d.recent.length === 0}
        <EmptyState
          icon="transactions"
          title="No transactions yet"
          body="Connect a bank scraper, watch a folder, or add transactions manually — everything stays on this machine."
          hint="Press G then T to open Transactions"
        />
      {:else}
        <ul class="mt-2 pb-2">
          {#each d.recent as tx (tx.id)}
            <li class="border-t border-line first:border-t-0">
              <button
                class="row-hover flex w-full items-center gap-3 px-4 py-2.5 text-left"
                aria-label="{tx.merchant ?? tx.description}, {fmtMoney(
                  tx.amount_minor,
                  tx.currency,
                )} — open this transaction"
                onclick={() => openTransaction(tx.id)}
              >
                <span
                  class="flex size-7 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
                >
                  <Icon
                    name={tx.amount_minor > 0 ? "download" : "receipt"}
                    size={14}
                  />
                </span>
                <span class="min-w-0 flex-1 leading-tight">
                  <span class="block truncate text-[12.5px] font-medium">
                    {tx.merchant ?? tx.description}
                  </span>
                  <span class="block truncate text-[11px] text-t3">
                    {fmtDate(tx.posted_at)} · {catName(tx.category_id)}
                  </span>
                </span>
                <Money amount={tx.amount_minor} currency={tx.currency} signed colored />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>

  <!-- household: per-person spend + contribution for the period, computed
       locally like every other report (ARCHITECTURE.md "Household members
       & per-person attribution") -->
  {#if d.members.length > 0}
    <section class="card mt-4">
      <header class="flex items-center justify-between px-4 pt-4">
        <h2 class="text-[13px] font-semibold">
          Household · {fmtMonth(month)}
        </h2>
        <button
          class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
          onclick={() => router.go("household")}
        >
          Settle up
          <Icon name="arrow-right" size={12} />
        </button>
      </header>
      <ul class="mt-2 pb-2">
        {#each d.household as row (row.member?.id ?? "unattributed")}
          <li class="border-t border-line first:border-t-0">
            <button
              class="row-hover flex w-full items-center gap-3 px-4 py-2.5 text-left"
              aria-label="{row.label}: spent {fmtMoney(
                row.spentMinor,
                d.book.currency,
              )}, contributed {fmtMoney(
                row.contributedMinor,
                d.book.currency,
              )} — open Household"
              onclick={() => router.go("household")}
            >
              <MemberAvatar member={row.member} size={26} />
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block truncate text-[12.5px] font-medium">{row.label}</span>
                <span class="block truncate text-[11px] text-t3">
                  {row.member?.default_account_id
                    ? "owns an account"
                    : row.member
                      ? "joint / shared"
                      : "no member set"}
                </span>
              </span>
              <span class="text-right leading-tight">
                <span class="block text-[11px] text-t3">Spent</span>
                <Money amount={-row.spentMinor} currency={d.book.currency} class="text-t1" />
              </span>
              <span class="text-right leading-tight">
                <span class="block text-[11px] text-t3">Contributed</span>
                <Money
                  amount={row.contributedMinor}
                  currency={d.book.currency}
                  signed
                  colored
                />
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load dashboard"
      body={String(err)}
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
