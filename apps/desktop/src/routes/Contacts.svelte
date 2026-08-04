<script lang="ts">
  /**
   * Contacts — customers and suppliers, in one table (Phase 6.2).
   *
   * Deliberately one list rather than two screens: a real trading party is
   * often both, and a `both` contact has to appear on both the customer and
   * the supplier view rather than forcing a choice. Role is therefore the
   * one thing this screen keeps most visible — a plain-language badge in
   * every row, and a select right next to it that changes the role in place,
   * no dialog required.
   *
   * Business-only (`BookProfile.show_contacts`). A personal book has no
   * trading parties to track, so this screen refuses the route itself
   * rather than merely relying on the sidebar hiding its own entry — the
   * command palette and a typed `#/contacts` both reach it directly.
   *
   * NOT built: no merge/dedupe for two contacts that turn out to be the same
   * party, no statement, and no per-contact activity feed (orders/invoices
   * live on their own screens once those exist — this is directory data,
   * not a ledger view). Deleting a contact with any order or invoice against
   * it is refused by core; this screen surfaces that refusal in plain words
   * rather than the raw error.
   */
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import { router } from "../lib/router.svelte";
  import { fmtMoney, minorToInput, parseMoneyInput } from "../lib/format";
  import type { Book, BookProfile, Contact, ContactRole } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Money from "../lib/components/Money.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import Dialog from "../lib/components/Dialog.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

  type Tab = "all" | "customer" | "supplier";

  const roleLabel: Record<ContactRole, string> = {
    customer: "Customer",
    supplier: "Supplier",
    both: "Customer & supplier",
  };
  let book = $state<Book | null>(null);
  let profile = $state<BookProfile | null>(null);
  let contacts = $state<Contact[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let tab = $state<Tab>("all");
  let search = $state("");

  function fetchForTab(bookId: string, t: Tab): Promise<Contact[]> {
    if (t === "customer") return api.contactListCustomers({ book_id: bookId });
    if (t === "supplier") return api.contactListSuppliers({ book_id: bookId });
    return api.contactList({ book_id: bookId });
  }

  async function load(background = false) {
    if (!background) loading = true;
    if (!background) loadError = null;
    try {
      const b = requireBook(await api.bookList());
      book = b;
      const p = await api.bookProfile({ book_id: b.id });
      profile = p;
      contacts = p.show_contacts ? await fetchForTab(b.id, tab) : [];
    } catch (err) {
      if (!background) loadError = String(err);
    } finally {
      loading = false;
    }
  }
  load();

  function setTab(t: Tab) {
    if (t === tab) return;
    tab = t;
    void load();
  }

  const filtered = $derived(
    contacts.filter((c) => {
      if (!search) return true;
      const s = search.toLowerCase();
      return (
        c.name.toLowerCase().includes(s) ||
        (c.company_name ?? "").toLowerCase().includes(s) ||
        (c.email ?? "").toLowerCase().includes(s) ||
        (c.phone ?? "").toLowerCase().includes(s)
      );
    }),
  );

  const counts = $derived({
    customer: contacts.filter((c) => c.role === "customer" || c.role === "both")
      .length,
    supplier: contacts.filter((c) => c.role === "supplier" || c.role === "both")
      .length,
  });

  // -------------------------------------------------------------------------
  // create / edit — one form, two modes. Every field round-trips: opening an
  // existing contact fills every input from it, and saving sends every
  // optional field explicitly (empty -> null, clearing it) so the form is
  // never a partial patch a person cannot see the effect of.
  // -------------------------------------------------------------------------

  let formOpen = $state(false);
  let editingId = $state<string | null>(null);
  let fName = $state("");
  let fRole = $state<ContactRole>("customer");
  let fCompany = $state("");
  let fEmail = $state("");
  let fPhone = $state("");
  let fBilling = $state("");
  let fShipping = $state("");
  let fTax = $state("");
  let fTerms = $state("");
  let fCredit = $state("");
  let fNotes = $state("");
  let showMore = $state(false);
  let formBusy = $state(false);
  let formError = $state<string | null>(null);

  function resetForm() {
    fName = "";
    fRole = "customer";
    fCompany = "";
    fEmail = "";
    fPhone = "";
    fBilling = "";
    fShipping = "";
    fTax = "";
    fCredit = "";
    fTerms = "";
    fNotes = "";
    showMore = false;
    formError = null;
  }

  function openCreate() {
    editingId = null;
    resetForm();
    formOpen = true;
  }

  function openEdit(c: Contact) {
    editingId = c.id;
    fName = c.name;
    fRole = c.role;
    fCompany = c.company_name ?? "";
    fEmail = c.email ?? "";
    fPhone = c.phone ?? "";
    fBilling = c.billing_address ?? "";
    fShipping = c.shipping_address ?? "";
    fTax = c.tax_number ?? "";
    fTerms = c.payment_terms_days === null ? "" : String(c.payment_terms_days);
    fCredit =
      c.credit_limit_minor === null
        ? ""
        : minorToInput(c.credit_limit_minor, book?.currency ?? "USD");
    fNotes = c.notes ?? "";
    showMore = Boolean(
      c.billing_address || c.shipping_address || c.tax_number || c.notes,
    );
    formError = null;
    formOpen = true;
  }

  async function submitForm() {
    if (!book) return;
    const name = fName.trim();
    if (!name) {
      formError = "Name the contact to save it.";
      return;
    }
    let termsDays: number | undefined;
    if (fTerms.trim() !== "") {
      const n = Number(fTerms.trim());
      if (!Number.isInteger(n)) {
        formError = "Payment terms must be a whole number of days.";
        return;
      }
      termsDays = n;
    }
    let creditMinor: number | undefined;
    if (fCredit.trim() !== "") {
      const parsed = parseMoneyInput(fCredit, book.currency);
      if (parsed === null) {
        formError = "Enter a valid credit limit amount.";
        return;
      }
      creditMinor = parsed;
    }
    formBusy = true;
    formError = null;
    try {
      if (editingId) {
        await api.contactUpdate({
          id: editingId,
          role: fRole,
          name,
          company_name: fCompany.trim() || null,
          email: fEmail.trim() || null,
          phone: fPhone.trim() || null,
          billing_address: fBilling.trim() || null,
          shipping_address: fShipping.trim() || null,
          tax_number: fTax.trim() || null,
          payment_terms_days: termsDays ?? null,
          credit_limit_minor: creditMinor ?? null,
          notes: fNotes.trim() || null,
        });
      } else {
        await api.contactAdd({
          book_id: book.id,
          role: fRole,
          name,
          company_name: fCompany.trim() || undefined,
          email: fEmail.trim() || undefined,
          phone: fPhone.trim() || undefined,
          billing_address: fBilling.trim() || undefined,
          shipping_address: fShipping.trim() || undefined,
          tax_number: fTax.trim() || undefined,
          payment_terms_days: termsDays,
          credit_limit_minor: creditMinor,
          notes: fNotes.trim() || undefined,
        });
      }
      formOpen = false;
      await load(true);
    } catch (err) {
      formError = String(err);
    } finally {
      formBusy = false;
    }
  }

  // -- quick role change, right from the row --------------------------------

  let roleBusyId = $state<string | null>(null);
  let roleError = $state<string | null>(null);

  async function setRole(c: Contact, role: ContactRole) {
    if (role === c.role) return;
    roleBusyId = c.id;
    roleError = null;
    try {
      await api.contactUpdate({ id: c.id, role });
      await load(true);
    } catch (err) {
      roleError = String(err);
    } finally {
      roleBusyId = null;
    }
  }

  // -- active / inactive ------------------------------------------------------

  let activeBusyId = $state<string | null>(null);

  async function toggleActive(c: Contact) {
    activeBusyId = c.id;
    roleError = null;
    try {
      await api.contactUpdate({ id: c.id, is_active: !c.is_active });
      await load(true);
    } catch (err) {
      roleError = String(err);
    } finally {
      activeBusyId = null;
    }
  }

  // -- remove: refused when the contact has any trade history ----------------

  let confirmRemove = $state<Contact | null>(null);
  let removeBusy = $state(false);
  let removeError = $state<string | null>(null);

  function askRemove(c: Contact) {
    confirmRemove = c;
    removeError = null;
  }

  async function commitRemove() {
    if (!confirmRemove) return;
    removeBusy = true;
    removeError = null;
    try {
      await api.contactRemove({ id: confirmRemove.id });
      confirmRemove = null;
      await load(true);
    } catch (err) {
      // Core refuses ON DELETE RESTRICT when an order or invoice names this
      // contact — say that plainly rather than surfacing the raw error.
      const msg = String(err);
      removeError = msg.includes("cannot be deleted")
        ? "This contact has orders or invoices against it, so it cannot be deleted. Mark it inactive instead if it should stop appearing in pickers."
        : msg;
    } finally {
      removeBusy = false;
    }
  }
</script>

<PageHeader
  title="Contacts"
  subtitle="Customers and suppliers in one list — a party that both buys from you and sells to you is one contact, marked “both”, not two."
>
  {#snippet actions()}
    {#if profile?.show_contacts}
      <button class="btn btn-primary" onclick={openCreate}>
        <Icon name="plus" size={14} />
        New contact
      </button>
    {/if}
  {/snippet}
</PageHeader>

{#if loading}
  <div class="card"><Skeleton rows={6} /></div>
{:else if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load contacts" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={() => load()}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if !profile?.show_contacts}
  <!-- Route refusal: reached directly (hash, palette) rather than through a
       sidebar that already hid this entry. Same message either way. -->
  <div class="card">
    <EmptyState
      icon="bank"
      title="Contacts is for business books"
      body="{book?.name ?? 'This book'} is a personal book, so there is no trading party to track — no customers, no suppliers, nothing to invoice. Switch it to Business in Settings › General to turn this on; nothing here is deleted either way."
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={() => router.go("settings")}>
          Open Settings
        </button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <div class="mb-3 flex flex-wrap items-center gap-2">
    <div
      class="inline-flex items-center gap-0.5 rounded-lg border border-line p-0.5"
      role="tablist"
      aria-label="Filter by role"
    >
      <button
        class="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors
          {tab === 'all'
          ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
          : 'text-t2 hover:bg-sunken'}"
        role="tab"
        aria-selected={tab === "all"}
        onclick={() => setTab("all")}
      >
        All <span class="num text-[10.5px] opacity-70">{contacts.length}</span>
      </button>
      <button
        class="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors
          {tab === 'customer'
          ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
          : 'text-t2 hover:bg-sunken'}"
        role="tab"
        aria-selected={tab === "customer"}
        onclick={() => setTab("customer")}
      >
        Customers <span class="num text-[10.5px] opacity-70">{counts.customer}</span>
      </button>
      <button
        class="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors
          {tab === 'supplier'
          ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
          : 'text-t2 hover:bg-sunken'}"
        role="tab"
        aria-selected={tab === "supplier"}
        onclick={() => setTab("supplier")}
      >
        Suppliers <span class="num text-[10.5px] opacity-70">{counts.supplier}</span>
      </button>
    </div>
    <div class="relative w-full sm:w-64">
      <Icon
        name="search"
        size={14}
        class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
      />
      <input
        class="input pl-8"
        placeholder="Filter by name, company, email…"
        bind:value={search}
      />
    </div>
  </div>

  {#if roleError}
    <p
      class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
      role="alert"
    >
      <Icon name="alert-circle" size={13} />
      {roleError}
    </p>
  {/if}

  <div class="card overflow-hidden">
    {#if contacts.length === 0}
      <EmptyState
        icon="contacts"
        title="No contacts yet"
        body="Add the people and companies you buy from and sell to. A party that is both a customer and a supplier is one contact here, not two — set its role to “both” and it will show up wherever either role matters."
      >
        {#snippet actions()}
          <button class="btn btn-primary" onclick={openCreate}>
            <Icon name="plus" size={14} />
            Add your first contact
          </button>
        {/snippet}
      </EmptyState>
    {:else if filtered.length === 0}
      <EmptyState
        icon="search"
        title="Nothing matches"
        body="Try a broader search, or clear it to see all {contacts.length} in this view."
      >
        {#snippet actions()}
          <button class="btn" onclick={() => (search = "")}>Clear search</button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="table-wrap table-scroll">
        <table class="w-full text-[12.5px]">
          <thead>
            <tr>
              <th class="th">Name</th>
              <th class="th w-48">Role</th>
              <th class="th w-44">Email</th>
              <th class="th w-32">Phone</th>
              <th class="th w-24 text-right">Terms</th>
              <th class="th w-32 text-right">Credit limit</th>
              <th class="th w-24">Status</th>
              <th class="th w-20"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as c (c.id)}
              <tr class="row-hover {c.is_active ? '' : 'opacity-60'}">
                <td class="td max-w-0">
                  <span class="block truncate font-medium">{c.name}</span>
                  {#if c.company_name}
                    <span class="block truncate text-[11px] text-t3"
                      >{c.company_name}</span
                    >
                  {/if}
                </td>
                <td class="td">
                  <!-- Role reads at a glance from the tint and changes with
                       one select — no dialog, no separate "edit" step. -->
                  <select
                    class="input h-7 w-full text-[11.5px] font-medium
                      {c.role === 'customer'
                      ? 'border-accent-ring/50 bg-accent/10 text-accent-text dark:text-accent'
                      : c.role === 'both'
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'text-t2'}"
                    aria-label="Role for {c.name}"
                    value={c.role}
                    disabled={roleBusyId === c.id}
                    onchange={(e) =>
                      setRole(c, e.currentTarget.value as ContactRole)}
                  >
                    <option value="customer">Customer</option>
                    <option value="supplier">Supplier</option>
                    <option value="both">Customer &amp; supplier</option>
                  </select>
                </td>
                <td class="td max-w-0 text-t2">
                  <span class="block truncate">{c.email ?? "—"}</span>
                </td>
                <td class="td text-t2">{c.phone ?? "—"}</td>
                <td class="td num text-right text-t2">
                  {c.payment_terms_days === null ? "—" : `${c.payment_terms_days}d`}
                </td>
                <td class="td text-right">
                  {#if c.credit_limit_minor === null}
                    <span class="text-t3">—</span>
                  {:else}
                    <Money amount={c.credit_limit_minor} currency={book?.currency ?? "USD"} />
                  {/if}
                </td>
                <td class="td">
                  <button
                    class="btn h-6 px-1.5 text-[11px]"
                    disabled={activeBusyId === c.id}
                    onclick={() => toggleActive(c)}
                  >
                    {c.is_active ? "Active" : "Inactive"}
                  </button>
                </td>
                <td class="td">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      class="btn btn-ghost h-7 w-7 px-0"
                      aria-label="Edit {c.name}"
                      onclick={() => openEdit(c)}
                    >
                      <Icon name="pencil" size={13} />
                    </button>
                    <button
                      class="btn btn-ghost h-7 w-7 px-0 hover:text-danger"
                      aria-label="Remove {c.name}"
                      onclick={() => askRemove(c)}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
{/if}

<Dialog
  open={formOpen}
  title={editingId ? "Edit contact" : "New contact"}
  size="md"
  dismissible={!formBusy}
  onclose={() => (formOpen = false)}
>
  <form
    class="space-y-3 px-5 pb-4"
    onsubmit={(e) => {
      e.preventDefault();
      submitForm();
    }}
  >
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="block">
        <span class="mb-1 block text-[12px] text-t2">Name</span>
        <input
          data-autofocus
          class="input"
          bind:value={fName}
          autocomplete="off"
          required
        />
      </label>
      <div class="block">
        <span class="mb-1 block text-[12px] text-t2">Role</span>
        <div class="flex items-center gap-1" role="radiogroup" aria-label="Role">
          {#each Object.entries(roleLabel) as [id, label] (id)}
            <button
              type="button"
              role="radio"
              aria-checked={fRole === id}
              class="flex-1 rounded-lg border px-2 py-1.5 text-[11.5px] transition-colors
                {fRole === id
                ? 'border-accent-ring bg-accent/10 font-medium dark:border-accent/50'
                : 'border-line hover:border-line-2 hover:bg-panel'}"
              onclick={() => (fRole = id as ContactRole)}
            >
              {label}
            </button>
          {/each}
        </div>
      </div>
      <label class="block sm:col-span-2">
        <span class="mb-1 block text-[12px] text-t2">Company</span>
        <input class="input" bind:value={fCompany} autocomplete="off" />
      </label>
      <label class="block">
        <span class="mb-1 block text-[12px] text-t2">Email</span>
        <input class="input" type="email" bind:value={fEmail} autocomplete="off" />
      </label>
      <label class="block">
        <span class="mb-1 block text-[12px] text-t2">Phone</span>
        <input class="input" bind:value={fPhone} autocomplete="off" />
      </label>
    </div>

    <button
      type="button"
      class="flex items-center gap-1 text-[11.5px] font-medium text-t2 hover:text-t1"
      aria-expanded={showMore}
      onclick={() => (showMore = !showMore)}
    >
      <Icon
        name="chevron-down"
        size={12}
        class={showMore ? "" : "-rotate-90"}
      />
      Billing, tax and terms
    </button>
    {#if showMore}
      <div class="reveal">
        <div class="reveal-inner grid gap-3 pt-1 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1 block text-[12px] text-t2">Billing address</span>
            <textarea class="input" rows="2" bind:value={fBilling}></textarea>
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] text-t2">Shipping address</span>
            <textarea class="input" rows="2" bind:value={fShipping}></textarea>
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] text-t2">Tax number</span>
            <input class="input" bind:value={fTax} autocomplete="off" />
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] text-t2"
              >Payment terms (days)</span
            >
            <input
              class="input num"
              inputmode="numeric"
              placeholder="e.g. 30"
              bind:value={fTerms}
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] text-t2">Credit limit</span>
            <input
              class="input num"
              inputmode="decimal"
              placeholder={book ? `e.g. ${fmtMoney(500000, book.currency)}` : ""}
              bind:value={fCredit}
            />
          </label>
          <label class="block sm:col-span-2">
            <span class="mb-1 block text-[12px] text-t2">Notes</span>
            <textarea class="input" rows="2" bind:value={fNotes}></textarea>
          </label>
        </div>
      </div>
    {/if}

    {#if formError}
      <p
        class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        role="alert"
      >
        <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
        {formError}
      </p>
    {/if}
  </form>

  {#snippet footer()}
    <button class="btn" disabled={formBusy} onclick={() => (formOpen = false)}>
      Cancel
    </button>
    <button
      class="btn btn-primary"
      disabled={formBusy || !fName.trim()}
      onclick={submitForm}
    >
      {#if formBusy}
        <Icon name="refresh" size={13} class="animate-spin" />
      {/if}
      {formBusy ? "Saving…" : editingId ? "Save changes" : "Add contact"}
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  open={confirmRemove !== null}
  title="Remove {confirmRemove?.name ?? ''}?"
  body="This deletes the contact record. Core refuses if it has any order or invoice against it — nothing here can force that."
  confirmLabel="Remove contact"
  tone="danger"
  busy={removeBusy}
  error={removeError}
  onconfirm={commitRemove}
  oncancel={() => (confirmRemove = null)}
/>
