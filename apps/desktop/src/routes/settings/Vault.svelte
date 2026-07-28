<script lang="ts">
  /**
   * Credential vault tab. Write-only: secrets go in, only metadata comes
   * out. Owns its own load and its own state — nothing here is shared with
   * the settings blob or the other tabs.
   */
  import { tick } from "svelte";
  import { api } from "../../lib/api/client";
  import type { VaultCredentialMeta } from "../../lib/api/types";
  import { fmtDate, fmtRelative } from "../../lib/format";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Icon from "../../lib/components/Icon.svelte";

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
  loadVault();

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
</script>

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
        <li class="row-hover py-2.5 first:pt-0 last:pb-0">
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
