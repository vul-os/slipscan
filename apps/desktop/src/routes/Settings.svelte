<script lang="ts">
  /**
   * Settings shell. It owns exactly three things: the settings blob
   * (settings_get / settings_set), the save button that writes it back, and
   * the tab strip. Every tab under ./settings/ runs its own load() — the FX
   * status, the vault list and the data-folder status are fetched only when
   * their tab is on screen.
   *
   * Household members and classification packs used to live here, outside
   * the tab set. They are top-level screens now (Household, Packs) — neither
   * was ever a setting.
   */
  import { api } from "../lib/api/client";
  import { currentBook } from "../lib/book";
  import type { Book, Settings } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import General from "./settings/General.svelte";
  import Data from "./settings/Data.svelte";
  import Connections from "./settings/Connections.svelte";
  import Vault from "./settings/Vault.svelte";
  import Devices from "./settings/Devices.svelte";

  let s = $state<Settings | null>(null);
  /** Every book in the database; `book` is the one the screens work with. */
  let books = $state<Book[]>([]);
  let book = $state<Book | null>(null);
  let saving = $state(false);
  let savedAt = $state<number | null>(null);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);

  type Tab = "general" | "data" | "connections" | "vault" | "devices";
  let tab = $state<Tab>("general");

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "general", label: "General" },
    { id: "data", label: "Data & backup" },
    { id: "connections", label: "Connections" },
    { id: "vault", label: "Credential vault" },
    // Devices sits beside the vault because that is literally where its key
    // lives: this device's private key is a write-only vault entry. It is not
    // a sync screen — nothing syncs — which the tab itself says up front.
    { id: "devices", label: "Devices" },
  ];

  /** True while the data-folder move is running (bound out of the Data tab).
   * That one await makes the whole app read-only, so saving and switching
   * tabs are both held until it finishes. */
  let dataMoving = $state(false);

  async function load() {
    loadError = null;
    try {
      const [settings, allBooks] = await Promise.all([
        api.settingsGet(),
        api.bookList(),
      ]);
      s = settings;
      books = allBooks;
      book = currentBook(allBooks);
    } catch (err) {
      loadError = String(err);
    }
  }
  void load();

  async function save() {
    if (!s) return;
    saving = true;
    saveError = null;
    try {
      s = await api.settingsSet({ settings: $state.snapshot(s) as Settings });
      savedAt = Date.now();
      setTimeout(() => (savedAt = null), 2500);
    } catch (err) {
      saveError = String(err);
    } finally {
      saving = false;
    }
  }
</script>

<PageHeader
  eyebrow="This machine only"
  title="Settings"
  subtitle="Providers you explicitly configure are the only network egress. Secrets live in the OS keychain — never in config files."
>
  {#snippet actions()}
    {#if savedAt}
      <span
        class="animate-fade-in flex items-center gap-1.5 text-[12px] text-success"
        role="status"
      >
        <Icon name="check" size={13} />
        Saved
      </span>
    {/if}
    <button
      class="btn btn-primary"
      onclick={save}
      disabled={saving || !s || dataMoving}
    >
      {saving ? "Saving…" : "Save changes"}
    </button>
  {/snippet}
</PageHeader>

{#if saveError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    Could not save settings: {saveError}
  </p>
{/if}

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load settings" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={load}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if !s}
  <div class="card"><Skeleton rows={8} /></div>
{:else}
  <div class="mb-4 flex items-center gap-1 border-b border-line" role="tablist">
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
        disabled={dataMoving}
      >
        {t.label}
      </button>
    {/each}
  </div>

  {#if tab === "general"}
    <General bind:settings={s} {book} {books} onbookcreated={load} />
  {:else if tab === "data"}
    <Data bind:moving={dataMoving} onmoved={load} />
  {:else if tab === "connections"}
    <Connections bind:settings={s} {book} />
  {:else if tab === "devices"}
    <Devices />
  {:else}
    <Vault />
  {/if}
{/if}
