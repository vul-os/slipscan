<script lang="ts">
  /**
   * General tab: appearance, the book this machine holds, and the privacy
   * contract. `settings` is bound because the theme buttons write straight
   * into the blob the shell saves; `book` is read-only here.
   */
  import { theme, type ThemeMode } from "../../lib/theme.svelte";
  import type { Book, Settings } from "../../lib/api/types";
  import Badge from "../../lib/components/Badge.svelte";
  import Icon from "../../lib/components/Icon.svelte";

  let {
    settings = $bindable(),
    book,
  }: {
    settings: Settings;
    book: Book | null;
  } = $props();

  const themeModes: Array<{ mode: ThemeMode; label: string }> = [
    { mode: "system", label: "Follow OS" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];
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
    <h2 class="mb-3 flex items-center gap-2 text-[13px] font-semibold">
      <Icon name="ledger" size={15} class="text-t3" />
      Book
    </h2>
    {#if book}
      <dl class="grid grid-cols-[9rem_1fr] gap-y-2 text-[12.5px]">
        <dt class="text-t3">Name</dt>
        <dd class="font-medium">{book.name}</dd>
        <dt class="text-t3">Kind</dt>
        <dd>
          <Badge tone="neutral" dot={false} label={book.kind} />
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
      </p>
    {:else}
      <p class="text-[12.5px] text-t3">No book configured.</p>
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
    <ul class="space-y-1 text-[12px] text-t2">
      <li>· No telemetry, no analytics, no default network calls.</li>
      <li>
        · Egress only to endpoints you configured in the Connections tab —
        your LLM, your IMAP server, your bank session.
      </li>
      <li>
        · Your data is one folder — a SQLite file plus your documents —
        that you can move, sync, back up, or delete.
      </li>
    </ul>
  </section>
</div>
