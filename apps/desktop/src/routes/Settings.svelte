<script lang="ts">
  import { api, isTauri } from "../lib/api/client";
  import { theme, type ThemeMode } from "../lib/theme.svelte";
  import type { Book, Settings } from "../lib/api/types";
  import { fmtDate } from "../lib/format";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  let s = $state<Settings | null>(null);
  let book = $state<Book | null>(null);
  let saving = $state(false);
  let savedAt = $state<number | null>(null);

  async function load() {
    const [settings, books] = await Promise.all([
      api.settingsGet(),
      api.bookList(),
    ]);
    s = settings;
    book = books[0] ?? null;
  }
  load();

  async function save() {
    if (!s) return;
    saving = true;
    s = await api.settingsSet({ settings: $state.snapshot(s) as Settings });
    saving = false;
    savedAt = Date.now();
    setTimeout(() => (savedAt = null), 2500);
  }

  const themeModes: Array<{ mode: ThemeMode; label: string }> = [
    { mode: "system", label: "Follow OS" },
    { mode: "light", label: "Light" },
    { mode: "dark", label: "Dark" },
  ];
</script>

<PageHeader
  eyebrow="This machine only"
  title="Settings"
  subtitle="Providers you explicitly configure are the only network egress. Secrets live in the OS keychain — never in config files."
>
  {#snippet actions()}
    {#if savedAt}
      <span class="flex items-center gap-1.5 text-[12px] text-success">
        <Icon name="check" size={13} />
        Saved
      </span>
    {/if}
    <button class="btn btn-primary" onclick={save} disabled={saving || !s}>
      {saving ? "Saving…" : "Save changes"}
    </button>
  {/snippet}
</PageHeader>

{#if !s}
  <div class="card"><Skeleton rows={8} /></div>
{:else}
  <div class="space-y-4">
    <!-- appearance -->
    <section class="card p-4">
      <h2 class="mb-1 text-[13px] font-semibold">Appearance</h2>
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
            onclick={() => theme.set(t.mode)}
          >
            {t.label}
          </button>
        {/each}
      </div>
    </section>

    <!-- book -->
    <section class="card p-4">
      <h2 class="mb-3 text-[13px] font-semibold">Book</h2>
      {#if book}
        <dl class="grid grid-cols-[9rem_1fr] gap-y-2 text-[12.5px]">
          <dt class="text-t3">Name</dt>
          <dd class="font-medium">{book.name}</dd>
          <dt class="text-t3">Kind</dt>
          <dd>
            <Badge tone="neutral" dot={false} label={book.kind} />
          </dd>
          <dt class="text-t3">Currency</dt>
          <dd class="num">{book.currency}</dd>
          <dt class="text-t3">Database file</dt>
          <dd class="num text-t2">{book.file_path}</dd>
        </dl>
      {:else}
        <p class="text-[12.5px] text-t3">No book configured.</p>
      {/if}
    </section>

    <!-- llm provider -->
    <section class="card p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-[13px] font-semibold">Receipt extraction (LLM)</h2>
        <Badge
          tone={s.llm.provider === "none" ? "neutral" : "accent"}
          label={s.llm.provider === "none" ? "off" : s.llm.provider}
        />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2"
            >Provider</span
          >
          <select class="input" bind:value={s.llm.provider}>
            <option value="none">None — manual entry only</option>
            <option value="local">Local model</option>
            <option value="openai-compatible">OpenAI-compatible endpoint</option>
            <option value="anthropic">Anthropic (BYO key)</option>
          </select>
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Model</span>
          <input
            class="input"
            placeholder="e.g. a vision-capable model"
            bind:value={s.llm.model}
          />
        </label>
        <label class="block sm:col-span-2">
          <span class="mb-1 block text-[11.5px] font-medium text-t2"
            >Endpoint (local / self-hosted)</span
          >
          <input
            class="input font-mono"
            placeholder="http://localhost:11434"
            bind:value={s.llm.endpoint}
          />
        </label>
      </div>
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
        <Icon name="key" size={12} />
        API key is stored in the OS keychain{s.llm.keychain_entry
          ? ` as “${s.llm.keychain_entry}”`
          : ""} — never in SQLite or config files.
        <button class="btn btn-ghost h-6 px-1.5 text-[11px]" disabled={!isTauri}>
          Set key…
        </button>
      </p>
    </section>

    <!-- mailbox -->
    <section class="card p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-[13px] font-semibold">Email ingest (IMAP)</h2>
        <label class="flex items-center gap-2 text-[12px] text-t2">
          <input type="checkbox" bind:checked={s.mailbox.enabled} />
          Enabled
        </label>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Host</span>
          <input
            class="input font-mono"
            placeholder="imap.example.com"
            bind:value={s.mailbox.host}
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Port</span>
          <input class="input font-mono" type="number" bind:value={s.mailbox.port} />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2"
            >Username</span
          >
          <input
            class="input"
            placeholder="you@example.com"
            bind:value={s.mailbox.username}
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11.5px] font-medium text-t2">Folder</span>
          <input class="input font-mono" bind:value={s.mailbox.folder} />
        </label>
      </div>
      <p class="mt-3 flex items-center gap-1.5 text-[11px] text-t3">
        <Icon name="mail" size={12} />
        Slips mailed to this inbox are pulled on your schedule. Password lives
        in the OS keychain.
      </p>
    </section>

    <!-- packs -->
    <section class="card p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-[13px] font-semibold">Classification packs</h2>
        <button class="btn h-7">
          <Icon name="package" size={13} />
          Install pack…
        </button>
      </div>
      {#if s.packs.length === 0}
        <EmptyState
          icon="package"
          title="No packs installed"
          body="Packs share category taxonomies and classification rules — never data. Each pack is ed25519-signed and verified on install."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each s.packs as p (p.id)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span
                class="flex size-8 items-center justify-center rounded-md bg-sunken text-t3"
              >
                <Icon name="package" size={15} />
              </span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">
                  {p.name}
                  <span class="num text-t3">v{p.version}</span>
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {p.publisher} · {p.signer_fingerprint} · installed
                  {fmtDate(p.installed_at)}
                </span>
              </span>
              <Badge tone="success" label="verified" />
            </li>
          {/each}
        </ul>
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
          · Egress only to endpoints you configured above — your LLM, your
          IMAP server, your bank session.
        </li>
        <li>· Your data is a SQLite file you can copy, back up, or delete.</li>
      </ul>
    </section>
  </div>
{/if}
