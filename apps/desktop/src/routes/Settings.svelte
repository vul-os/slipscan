<script lang="ts">
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import { theme, type ThemeMode } from "../lib/theme.svelte";
  import type { Book, Settings, VaultCredentialMeta } from "../lib/api/types";
  import { fmtDate, fmtRelative } from "../lib/format";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  let s = $state<Settings | null>(null);
  let book = $state<Book | null>(null);
  let saving = $state(false);
  let savedAt = $state<number | null>(null);
  let loadError = $state<string | null>(null);
  let saveError = $state<string | null>(null);

  // -- credential vault (write-only: secrets go in, only metadata comes out)
  let credentials = $state<VaultCredentialMeta[]>([]);
  let vaultError = $state<string | null>(null);
  /** A failed vault *read* — kept apart from the generic empty state: for
   * security-critical data, "could not read the vault" must never look like
   * "you have no credentials". */
  let vaultLoadError = $state<string | null>(null);
  let showAddForm = $state(false);
  let addName = $state("");
  let addLabel = $state("");
  let addSecret = $state("");
  let addBusy = $state(false);
  let addNameInput = $state<HTMLInputElement | null>(null);
  /** Name of the entry currently being rotated, if any. */
  let rotating = $state<string | null>(null);
  let rotateSecret = $state("");
  let rotateBusy = $state(false);
  let rotateSecretInput = $state<HTMLInputElement | null>(null);
  /** Entry name awaiting a second click to confirm revocation. */
  let revokeArmed = $state<string | null>(null);
  let revokeTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmRevoke(name?: string) {
    if (name === undefined || revokeArmed === name) {
      revokeArmed = null;
      clearTimeout(revokeTimer);
    }
  }

  async function loadVault() {
    vaultLoadError = null;
    try {
      credentials = await api.vaultList();
    } catch (err) {
      credentials = [];
      vaultLoadError = String(err);
    }
  }

  async function load() {
    loadError = null;
    try {
      const [settings, books] = await Promise.all([
        api.settingsGet(),
        api.bookList(),
      ]);
      s = settings;
      book = books[0] ?? null;
    } catch (err) {
      loadError = String(err);
      return;
    }
    await loadVault();
  }
  load();

  function closeAddForm() {
    showAddForm = false;
    addName = "";
    addLabel = "";
    addSecret = "";
  }

  async function toggleAddForm() {
    vaultError = null;
    if (showAddForm) {
      closeAddForm();
      return;
    }
    showAddForm = true;
    await tick();
    addNameInput?.focus();
  }

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

  async function addCredential() {
    vaultError = null;
    addBusy = true;
    try {
      await api.vaultSet({
        name: addName.trim(),
        label: addLabel.trim() || undefined,
        secret: addSecret,
      });
      await loadVault();
      addName = "";
      addLabel = "";
      showAddForm = false;
    } catch (err) {
      vaultError = String(err);
    } finally {
      addSecret = ""; // the secret never lingers in UI state
      addBusy = false;
    }
  }

  async function replaceCredential(name: string) {
    vaultError = null;
    rotateBusy = true;
    try {
      await api.vaultReplace({ name, secret: rotateSecret });
      await loadVault();
      rotating = null;
    } catch (err) {
      vaultError = String(err);
    } finally {
      rotateSecret = "";
      rotateBusy = false;
    }
  }

  async function toggleRotate(name: string) {
    rotating = rotating === name ? null : name;
    rotateSecret = "";
    vaultError = null;
    if (rotating) {
      await tick();
      rotateSecretInput?.focus();
    }
  }

  /** Two-step revoke: first click arms, second click destroys. The armed
   * state disarms on mouse-out, focus loss, Escape, or a short timeout —
   * keyboard users must never be left with a permanently armed button. */
  async function revokeCredential(name: string) {
    if (revokeArmed !== name) {
      disarmRevoke();
      revokeArmed = name;
      revokeTimer = setTimeout(() => disarmRevoke(name), 5000);
      return;
    }
    disarmRevoke();
    vaultError = null;
    try {
      await api.vaultRevoke({ name });
      await loadVault();
    } catch (err) {
      vaultError = String(err);
    }
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
            onclick={() => {
              theme.set(t.mode);
              // Keep the persisted setting in step with the live theme so
              // "Save changes" never silently reverts the choice.
              if (s) s.theme = t.mode;
            }}
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
        Store the API key in the Credential vault below (e.g. as
        <span class="font-mono">llm.api_key</span>) — it is envelope-encrypted
        and write-only, never in SQLite or config files.
      </p>
      <p class="mt-1.5 text-[11px] text-t3">
        Extraction currently runs via the CLI (slipscan extract); in-app
        extraction is on the roadmap.
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
        Mail polling currently runs via the CLI (slipscan mail-sync); the
        password lives in the OS keychain, never here.
      </p>
    </section>

    <!-- bank connections (scraper adapters) -->
    <section class="card p-4">
      <h2 class="mb-1 text-[13px] font-semibold">Bank connections</h2>
      <p class="mb-3 text-[12px] text-t3">
        Scraper adapters run bank sessions on this machine. Credentials live in
        the vault; only status metadata is shown here.
      </p>
      {#if s.scrapers.length === 0}
        <EmptyState
          icon="bank"
          title="No bank connections"
          body="Statement CSV import works today (via the CLI); live scraper adapters are on the roadmap."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each s.scrapers as sc (sc.id)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span
                class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
              >
                <Icon name="bank" size={15} />
              </span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">
                  {sc.institution}
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {sc.adapter}
                  {#if sc.last_sync}· last sync {fmtRelative(sc.last_sync)}{/if}
                </span>
              </span>
              <Badge
                tone={sc.status === "connected"
                  ? "success"
                  : sc.status === "needs_attention"
                    ? "warning"
                    : "neutral"}
                label={sc.status === "needs_attention"
                  ? "needs re-auth"
                  : sc.status}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- credential vault -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="key" size={15} class="text-t3" />
          Credential vault
        </h2>
        <button class="btn h-7" onclick={toggleAddForm}>
          <Icon name="plus" size={13} />
          Add credential
        </button>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Write-only: secrets can be set, rotated and revoked — never viewed.
        Only a label, timestamps and a fingerprint are stored in the clear.
      </p>

      {#if vaultError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <Icon name="alert-circle" size={13} />
          {vaultError}
        </p>
      {/if}

      {#if showAddForm}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
             the keydown handler only closes the form on Escape (a11y win);
             all interaction happens on the inputs/buttons inside. -->
        <form
          class="mb-4 grid gap-3 rounded-lg border border-line bg-sunken/40 p-3 sm:grid-cols-2"
          onsubmit={(e) => {
            e.preventDefault();
            addCredential();
          }}
          onkeydown={(e) => {
            if (e.key === "Escape") closeAddForm();
          }}
        >
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
            <input
              class="input font-mono"
              placeholder="imap.password.fastmail"
              bind:this={addNameInput}
              bind:value={addName}
              required
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Label (optional)</span
            >
            <input
              class="input"
              placeholder="Fastmail app password"
              bind:value={addLabel}
            />
          </label>
          <label class="block sm:col-span-2">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Secret — write-only, it can never be read back</span
            >
            <input
              class="input font-mono"
              type="password"
              autocomplete="off"
              placeholder="paste the password / API key / token"
              bind:value={addSecret}
              required
            />
          </label>
          <div class="flex items-center gap-2 sm:col-span-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={addBusy || !addName.trim() || !addSecret}
            >
              {addBusy ? "Storing…" : "Store in vault"}
            </button>
            <button class="btn btn-ghost h-7" type="button" onclick={closeAddForm}>
              Cancel
            </button>
          </div>
        </form>
      {/if}

      {#if vaultLoadError}
        <EmptyState
          icon="alert-circle"
          title="Could not read the vault"
          body="The credential list is unavailable — this does not mean the vault is empty. {vaultLoadError}"
        >
          {#snippet actions()}
            <button class="btn" onclick={loadVault}>Retry</button>
          {/snippet}
        </EmptyState>
      {:else if credentials.length === 0}
        <EmptyState
          icon="key"
          title="No credentials stored"
          body="IMAP passwords, LLM API keys and bank-scraper logins live here, envelope-encrypted under a key that only exists in your OS keychain."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each credentials as c (c.name)}
            <li class="py-2.5 first:pt-0 last:pb-0">
              <div class="flex items-center gap-3">
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
                >
                  <Icon name="key" size={15} />
                </span>
                <span class="min-w-0 flex-1 leading-tight">
                  <span class="block text-[12.5px] font-medium">
                    {c.label ?? c.name}
                    {#if c.version > 1}
                      <span class="num text-[10.5px] text-t3">v{c.version}</span>
                    {/if}
                  </span>
                  <span class="block truncate font-mono text-[10.5px] text-t3">
                    {c.name} · fp {c.fingerprint} · added {fmtDate(c.created_at)}
                    {#if c.rotated_at}· rotated {fmtDate(c.rotated_at)}{/if}
                    {#if c.last_used_at}· used {fmtRelative(c.last_used_at)}{/if}
                  </span>
                </span>
                <div class="flex shrink-0 items-center gap-1.5">
                  <button class="btn h-7" onclick={() => toggleRotate(c.name)}>
                    <Icon name="refresh" size={13} />
                    Replace
                  </button>
                  <button
                    class="btn btn-danger h-7"
                    onclick={() => revokeCredential(c.name)}
                    onmouseleave={() => disarmRevoke(c.name)}
                    onblur={() => disarmRevoke(c.name)}
                    onkeydown={(e) => {
                      if (e.key === "Escape") disarmRevoke(c.name);
                    }}
                  >
                    <Icon name="trash" size={13} />
                    {revokeArmed === c.name ? "Really revoke?" : "Revoke"}
                  </button>
                </div>
              </div>
              {#if rotating === c.name}
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
                     Escape-to-close only; interaction lives on the input/button. -->
                <form
                  class="mt-2 flex items-center gap-2 pl-11"
                  onsubmit={(e) => {
                    e.preventDefault();
                    replaceCredential(c.name);
                  }}
                  onkeydown={(e) => {
                    if (e.key === "Escape") {
                      rotating = null;
                      rotateSecret = "";
                    }
                  }}
                >
                  <input
                    class="input font-mono flex-1"
                    type="password"
                    autocomplete="off"
                    placeholder="new secret — the old one is destroyed"
                    bind:this={rotateSecretInput}
                    bind:value={rotateSecret}
                    required
                  />
                  <button
                    class="btn btn-primary h-7"
                    type="submit"
                    disabled={rotateBusy || !rotateSecret}
                  >
                    {rotateBusy ? "Rotating…" : "Rotate"}
                  </button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- packs -->
    <section class="card p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-[13px] font-semibold">Classification packs</h2>
      </div>
      {#if s.packs.length === 0}
        <EmptyState
          icon="package"
          title="No packs installed"
          body="Packs share category taxonomies and classification rules — never data. Each pack is ed25519-signed and verified on install. Install from the CLI: slipscan pack install."
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
