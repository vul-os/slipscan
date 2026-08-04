<script lang="ts">
  /**
   * Sales — sales orders and invoicing, one screen with three views.
   *
   * ONE route, not two. Orders and invoices are one workflow (a confirmed
   * order is issued straight into an invoice — the common path — and both
   * views share the same contacts, catalogue and money formatting), so
   * splitting them into separate nav entries would just make the handoff
   * between them a navigation instead of a tab click. Aged receivables rides
   * along as a third tab for the same reason Reports keeps its cards on one
   * page: it is a read view over the same invoices the middle tab lists, not
   * a separate concern.
   *
   * This is also the first screen gated by a `BookProfile.show_*` flag
   * (`show_sales`) rather than the flag only being described in Settings ›
   * General. The rail entry is still always present — `NAV_GROUPS`/`ROUTES`
   * are static, pinned by a test — so the gate lives here: a personal book
   * opens Sales and is told plainly why there is nothing to see, the same
   * honesty Settings › General already gives that axis.
   *
   * Two hard facts from the API this screen must never blur:
   *   - an order is an editable draft; an invoice is issued already numbered
   *     and immutable — there is no edit or delete for one anywhere below.
   *   - paid/unpaid is `InvoiceTotals.status`, derived from `SUM(payments)`
   *     every time. Nothing here stores or recomputes it.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { swrLoad } from "../lib/loadCache";
  import { router } from "../lib/state/router.svelte";
  import type { Book, BookProfile } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Orders from "./sales/Orders.svelte";
  import Invoices from "./sales/Invoices.svelte";
  import AgedReceivables from "./sales/AgedReceivables.svelte";

  interface Data {
    book: Book;
    profile: BookProfile;
  }

  async function load(): Promise<Data> {
    const book = requireBook(await api.bookList());
    const profile = await api.bookProfile({ book_id: book.id });
    return { book, profile };
  }

  const reload = (fresh = false) =>
    swrLoad<Data>("sales:gate", load, (v) => (data = v), { fresh });
  let data = $state(reload());

  type Tab = "orders" | "invoices" | "aged";
  let tab = $state<Tab>("orders");
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "orders", label: "Orders" },
    { id: "invoices", label: "Invoices" },
    { id: "aged", label: "Aged receivables" },
  ];
</script>

<PageHeader
  eyebrow="Customers · orders · invoicing"
  title="Sales"
  subtitle="Draft an order for a customer, confirm it to deduct stock and post revenue — then issue the invoice. Invoices are numbered facts once issued: a correction is a credit note, which is not built yet."
/>

{#await data}
  <div class="card"><Skeleton rows={8} /></div>
{:then { book, profile }}
  {#if !profile.show_sales}
    <div class="card">
      <EmptyState
        icon="cart"
        title="Sales is a business-book feature"
        body="{book.name} is a personal book, so orders, invoicing and aged receivables stay hidden — the same axis Settings › General lists for contacts, catalogue and purchasing. Switch this book to Business there to use them; nothing here is deleted by switching, only shown or hidden."
      >
        {#snippet actions()}
          <button
            class="btn btn-primary"
            onclick={() => router.go("settings")}
          >
            Open Settings › General
          </button>
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <div
      class="mb-4 flex items-center gap-1 border-b border-line"
      role="tablist"
    >
      {#each tabs as t (t.id)}
        <button
          role="tab"
          aria-selected={tab === t.id}
          class="-mb-px border-b-2 px-3 py-2 text-[13px] font-medium
            {tab === t.id
            ? 'border-accent text-t1'
            : 'border-transparent text-t3 hover:text-t2'}"
          style="transition: color var(--dur-quick) var(--ease-standard), border-color var(--dur-quick) var(--ease-standard);"
          onclick={() => (tab = t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    {#if tab === "orders"}
      <Orders {book} onissued={() => (tab = "invoices")} />
    {:else if tab === "invoices"}
      <Invoices {book} />
    {:else}
      <AgedReceivables {book} />
    {/if}
  {/if}
{:catch err}
  <div class="card">
    <EmptyState
      icon="alert-circle"
      title="Could not load Sales"
      body={String(err)}
    >
      {#snippet actions()}
        <button class="btn" onclick={() => (data = reload(true))}>
          Retry
        </button>
      {/snippet}
    </EmptyState>
  </div>
{/await}
