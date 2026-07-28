<script lang="ts">
  /**
   * Credential vault tab. Write-only: secrets go in, only metadata comes
   * out. Owns its own load and its own state — nothing here is shared with
   * the settings blob or the other tabs.
   *
   * "Write-only" is the hard part of this screen to design, because a list of
   * things you cannot open reads as broken unless the UI says why. So the
   * absence is stated as a property, not left as a gap: there is no reveal
   * control to look for, the fingerprint is offered as the thing you *can*
   * check an entry against, and rotation is presented as the answer to "I
   * lost it" rather than the user hunting for a copy button that will never
   * exist.
   */
  import { tick } from "svelte";
  import { api } from "../../lib/api/client";
  import type { VaultCredentialMeta } from "../../lib/api/types";
  import { fmtDate, fmtRelative } from "../../lib/format";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Icon from "../../lib/components/Icon.svelte";
  import ConfirmDialog from "../../lib/components/ConfirmDialog.svelte";

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
  /** Entry awaiting confirmation of revocation, if any. */
  let confirmRevoke = $state<VaultCredentialMeta | null>(null);
  let revokeBusy = $state(false);
  let revokeError = $state<string | null>(null);

  /**
   * Entries SlipScan writes for itself, rather than ones a person typed in.
   * Today that is the per-endpoint webhook signing secrets from Payments
   * (`pay.endpoint.{id}`, core's `endpoint_secret_name`). Revoking one of
   * these is not "forgetting a password you can re-enter" — the endpoint it
   * belongs to keeps its row and quietly loses the ability to sign, so the
   * prompt has to say which screen just broke.
   */
  const managedBy = (name: string): string | null =>
    name.startsWith("pay.endpoint.") ? "a Payments webhook endpoint" : null;

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

  /**
   * Revocation is type-to-confirm, the one place on these screens that earns
   * it: the secret is destroyed outright and cannot be recovered from
   * anything SlipScan holds — not from a backup of the data folder, which
   * never carries the keychain key. Whatever was using it stops working until
   * the original is re-obtained from wherever it came from, which for an
   * OAuth token or a rotated API key can mean a fresh grant. Typing the name
   * is proportionate to a cost that big.
   */
  async function revokeCredential(name: string) {
    revokeBusy = true;
    revokeError = null;
    try {
      await api.vaultRevoke({ name });
      confirmRevoke = null;
      await loadVault();
    } catch (err) {
      revokeError = String(err);
    } finally {
      revokeBusy = false;
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
    Secrets go in, and only metadata comes out: a name, a label, timestamps
    and a short fingerprint. Everything else is envelope-encrypted under a key
    that exists solely in this machine's OS keychain.
  </p>

  <!-- Said plainly and up front, because a list of things that will not open
       reads as a broken screen otherwise. The point is that there is nothing
       to look for: no reveal control exists, and this explains what to do
       instead of hunting for one. -->
  <p
    class="mb-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
  >
    <Icon name="shield" size={13} class="mt-0.5 shrink-0 text-t3" />
    <span>
      <span class="font-medium">There is no way to read a secret back</span> —
      not here, not on the CLI, not out of the database. That is the design,
      not a missing feature: SlipScan only ever hands one to the code that
      needs it at the moment it is used. To check an entry is the one you
      think it is, compare its
      <span class="font-mono">fp</span> below against the fingerprint shown
      wherever you stored it. If you have lost the original, rotate it — a
      replacement is always possible, recovery never is.
    </span>
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
    <!-- Names what actually uses the vault today. Listing a consumer that is
         not built would make an empty vault look like a setup step someone
         had skipped. -->
    <EmptyState
      icon="key"
      title="No credentials stored"
      body="Mailbox passwords and OAuth tokens for slipscan mail-sync, an LLM API key if you configure a provider, and the signing secret behind every webhook endpoint you add on Payments all live here."
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
              <!-- One word for one operation. This button, the form it opens
                   and the metadata row all say "rotate"; calling it "replace"
                   here and "rotate" two lines down made them read as two
                   different things. -->
              <button
                class="btn h-7"
                aria-expanded={rotating === c.name}
                onclick={() => toggleRotate(c.name)}
              >
                <Icon name="refresh" size={13} />
                {rotating === c.name ? "Close" : "Rotate"}
              </button>
              <button
                class="btn btn-danger h-7"
                onclick={() => {
                  revokeError = null;
                  confirmRevoke = c;
                }}
              >
                <Icon name="trash" size={13} />
                Revoke
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

{#if confirmRevoke}
  {@const target = confirmRevoke}
  {@const managed = managedBy(target.name)}
  <ConfirmDialog
    open
    title="Revoke {target.label ?? target.name}?"
    body={managed
      ? `This secret belongs to ${managed}. Destroying it does not remove the endpoint — it keeps its row and its URL and simply stops being able to sign, so deliveries fail until you rotate its secret from Payments.`
      : "The secret is destroyed. It cannot be recovered from a backup of your data folder, because the key that decrypts it never leaves this machine's keychain — anything using it stops working until you supply the original again."}
    confirmLabel="Revoke credential"
    confirmPhrase={target.name}
    tone="danger"
    busy={revokeBusy}
    error={revokeError}
    onconfirm={() => revokeCredential(target.name)}
    oncancel={() => {
      if (revokeBusy) return;
      confirmRevoke = null;
      revokeError = null;
    }}
  />
{/if}
