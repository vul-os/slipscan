<script lang="ts">
  /**
   * Data & backup tab: the one movable folder holding everything durable.
   * Backup = the user's own cloud syncing that folder (contract: SlipScan
   * ships no backup service).
   *
   * `moving` is bound out because the move is the one operation that makes
   * the whole app read-only — the shell disables saving and tab switching
   * while it runs. `onmoved` lets the shell re-read the book, whose database
   * path changed underneath it.
   */
  import { tick } from "svelte";
  import { api } from "../../lib/api/client";
  import type { DataStatus } from "../../lib/api/types";
  import { fmtBytes } from "../../lib/format";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Skeleton from "../../lib/components/Skeleton.svelte";
  import Badge from "../../lib/components/Badge.svelte";
  import Icon from "../../lib/components/Icon.svelte";

  let {
    moving = $bindable(false),
    onmoved,
  }: {
    /** True while the single move await is pending — the app is read-only. */
    moving?: boolean;
    /** Called after a successful move, once the new folder is live. */
    onmoved?: () => void | Promise<void>;
  } = $props();

  let dataStatus = $state<DataStatus | null>(null);
  let dataLoadError = $state<string | null>(null);
  /** Move flow: idle → "form" (type target) → "confirm" (source→target). */
  let moveStage = $state<"idle" | "form" | "confirm">("idle");
  let moveTarget = $state("");
  let moveError = $state<string | null>(null);
  let movedAt = $state<number | null>(null);
  /** Which of the two outcomes just happened. `use_existing` copies nothing —
   * it repoints at a database already sitting in the target — so reporting it
   * as "Moved" would credit the app with work it deliberately did not do. */
  let movedKind = $state<"moved" | "opened">("moved");
  let moveInput = $state<HTMLInputElement | null>(null);
  let pathCopied = $state(false);

  /** The refusal that has an "open instead" way out (marker from core's
   * DataMoveTargetHasDatabase error). */
  const targetHasDb = $derived(
    moveError?.includes("already contains a SlipScan database") ?? false,
  );

  async function loadDataStatus() {
    dataLoadError = null;
    try {
      dataStatus = await api.dataStatus();
    } catch (err) {
      dataStatus = null;
      dataLoadError = String(err);
    }
  }
  loadDataStatus();

  async function openMoveForm() {
    moveError = null;
    moveTarget = "";
    moveStage = "form";
    await tick();
    moveInput?.focus();
  }

  function cancelMove() {
    moveStage = "idle";
    moveTarget = "";
    moveError = null;
  }

  /** The one long await: copy → verify → open-check → pointer switch →
   * cleanup. While it is pending every other command blocks — read-only. */
  async function runMove(useExisting: boolean) {
    moving = true;
    moveError = null;
    try {
      dataStatus = await api.dataMove({
        target: moveTarget.trim(),
        use_existing: useExisting,
      });
      moveStage = "idle";
      moveTarget = "";
      movedKind = useExisting ? "opened" : "moved";
      movedAt = Date.now();
      setTimeout(() => (movedAt = null), 4000);
      // The book's database path changed too.
      await onmoved?.();
    } catch (err) {
      moveError = String(err);
      moveStage = "confirm";
    } finally {
      moving = false;
    }
  }

  async function copyDataPath() {
    if (!dataStatus) return;
    try {
      await navigator.clipboard.writeText(dataStatus.data_dir);
      pathCopied = true;
      setTimeout(() => (pathCopied = false), 2000);
    } catch {
      // Clipboard unavailable (permissions) — the path is still visible.
    }
  }
</script>

<section class="card p-4">
  <div class="mb-1 flex items-center justify-between">
    <h2 class="flex items-center gap-2 text-[13px] font-semibold">
      <Icon name="folder" size={15} class="text-t3" />
      Data &amp; backup
    </h2>
    <div class="flex items-center gap-1.5">
      {#if movedAt}
        <span
          class="animate-fade-in flex items-center gap-1.5 text-[12px] text-success"
          role="status"
        >
          <Icon name="check" size={13} />
          {movedKind === "opened" ? "Now open" : "Moved"}
        </span>
      {/if}
      {#if dataStatus?.cloud_sync_hint}
        <Badge tone="success" label="inside {dataStatus.cloud_sync_hint}" />
      {:else if dataStatus?.is_default_location}
        <Badge tone="neutral" dot={false} label="default location" />
      {/if}
    </div>
  </div>
  <p class="mb-3 text-[12px] text-t3">
    Everything durable — the database and your original documents — lives
    in this one folder. Move it anywhere: an external drive, your
    Documents, a NAS mount. The CLI and self-host server follow the same
    pointer, so every surface agrees on where your data is.
  </p>

  {#if dataLoadError}
    <EmptyState
      icon="alert-circle"
      title="Could not read the data folder status"
      body={dataLoadError}
    >
      {#snippet actions()}
        <button class="btn" onclick={loadDataStatus}>Retry</button>
      {/snippet}
    </EmptyState>
  {:else if !dataStatus}
    <Skeleton rows={2} />
  {:else}
    <div class="flex items-center gap-3 rounded-lg border border-line bg-sunken/40 p-3">
      <span
        class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
      >
        <Icon name="folder" size={15} />
      </span>
      <span class="min-w-0 flex-1 leading-tight">
        <span class="block truncate font-mono text-[12px] font-medium">
          {dataStatus.data_dir}
        </span>
        <span class="num block text-[10.5px] text-t3">
          database {fmtBytes(dataStatus.db_size_bytes)} ·
          {dataStatus.document_count}
          {dataStatus.document_count === 1 ? "document" : "documents"}
          ({fmtBytes(dataStatus.documents_size_bytes)})
        </span>
      </span>
      <div class="flex shrink-0 items-center gap-1.5">
        <button class="btn h-7" onclick={copyDataPath} disabled={moving}>
          {#if pathCopied}
            <Icon name="check" size={13} />
            Copied
          {:else}
            Copy path
          {/if}
        </button>
        {#if moveStage === "idle"}
          <button class="btn h-7" onclick={openMoveForm} disabled={moving}>
            <Icon name="arrow-right" size={13} />
            Move…
          </button>
        {/if}
      </div>
    </div>

    {#if moving}
      <p
        class="mt-3 flex items-center gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] text-warning"
        role="status"
      >
        <Icon name="refresh" size={13} class="animate-spin" />
        Moving your data — copying, verifying checksums, then switching
        over. SlipScan is read-only until this finishes.
      </p>
    {:else if moveStage !== "idle"}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
           Escape-to-close only; interaction lives on the inputs/buttons. -->
      <form
        class="mt-3 space-y-3 rounded-lg border border-line bg-sunken/40 p-3"
        onsubmit={(e) => {
          e.preventDefault();
          if (moveStage === "form" && moveTarget.trim()) {
            moveError = null;
            moveStage = "confirm";
          }
        }}
        onkeydown={(e) => {
          if (e.key === "Escape") cancelMove();
        }}
      >
        {#if moveError}
          <p
            class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
            <span>{moveError}</span>
          </p>
        {/if}

        {#if moveStage === "form"}
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">
              New data folder — pick one your own cloud syncs to make it
              your backup
            </span>
            <input
              class="input font-mono"
              placeholder="e.g. ~/Documents/SlipScan, or a folder inside iCloud Drive / Dropbox"
              bind:this={moveInput}
              bind:value={moveTarget}
              required
            />
          </label>
          <div class="flex items-center gap-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={!moveTarget.trim()}
            >
              Continue
            </button>
            <button class="btn btn-ghost h-7" type="button" onclick={cancelMove}>
              Cancel
            </button>
          </div>
        {:else}
          <div
            class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[12px]"
          >
            <span class="min-w-0 truncate rounded-md border border-line bg-surface px-2 py-1.5 font-mono">
              {dataStatus.data_dir}
            </span>
            <Icon name="arrow-right" size={14} class="text-t3" />
            <span class="min-w-0 truncate rounded-md border border-accent-ring/40 bg-surface px-2 py-1.5 font-mono">
              {moveTarget.trim()}
            </span>
          </div>
          <!-- The two outcomes are different operations and are described as
               such. Once the target turns out to hold a database, the only
               button offered stops copying anything, and leaving the copy
               narrative in place would describe work that is not about to
               happen. -->
          {#if targetHasDb}
            <p class="text-[11.5px] text-t3">
              Nothing will be copied or overwritten. SlipScan repoints at the
              database already in that folder and leaves your current one
              exactly where it is — so this is a switch between two sets of
              books, not a move, and it is reversible by pointing back.
            </p>
          {:else}
            <p class="text-[11.5px] text-t3">
              SlipScan copies the database and documents, verifies every
              file's checksum, opens the copy to check it, switches over
              atomically, and only then removes the old copy. The app is
              read-only while this runs.
            </p>
          {/if}
          <!-- The moment this matters is here, not in the guidance box
               further down the page. Someone moving their folder into a
               shared drive is about to form a belief about what they just
               copied, and "everything" is the wrong one. -->
          <p
            class="flex items-start gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[11.5px] leading-relaxed text-t2"
          >
            <Icon name="key" size={13} class="mt-0.5 shrink-0 text-t3" />
            <span>
              <span class="font-medium">Your credentials are not moving.</span>
              The vault's key lives in this machine's OS keychain and stays
              there, so what lands in the new folder yields no secrets on its
              own — which is exactly what makes the folder safe to put in a
              shared drive, and why opening it on another machine means
              entering them once more.
            </span>
          </p>
          <div class="flex items-center gap-2">
            {#if targetHasDb}
              <button
                class="btn btn-primary h-7"
                type="button"
                onclick={() => runMove(true)}
              >
                Open that folder's data instead
              </button>
            {:else}
              <button
                class="btn btn-primary h-7"
                type="button"
                onclick={() => runMove(false)}
              >
                Move data
              </button>
            {/if}
            <button
              class="btn btn-ghost h-7"
              type="button"
              onclick={() => {
                moveError = null;
                moveStage = "form";
              }}
            >
              Back
            </button>
            <button class="btn btn-ghost h-7" type="button" onclick={cancelMove}>
              Cancel
            </button>
          </div>
        {/if}
      </form>
    {/if}

    <!-- backup guidance — the contract's words, next to the folder -->
    <div class="mt-3 rounded-lg border border-line bg-sunken/40 p-3">
      <p class="text-[12px] font-medium">
        Your data lives in this folder. Sync it with your own cloud
        (iCloud Drive, Dropbox, Syncthing, Nextcloud, NAS) — SlipScan
        ships no backup service; backing up is yours.
      </p>
      <p class="mt-1.5 flex items-start gap-1.5 text-[11px] text-t3">
        <Icon name="key" size={12} class="mt-0.5 shrink-0" />
        <span>
          Credentials never travel with the folder: the vault's key stays
          in this machine's OS keychain, so a synced or copied folder
          alone yields no secrets — and restoring on a new machine means
          re-entering them once.
        </span>
      </p>
    </div>
  {/if}
</section>
