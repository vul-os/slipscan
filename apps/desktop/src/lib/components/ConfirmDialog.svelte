<script lang="ts">
  /**
   * The one confirm / destructive-action prompt.
   *
   * Screens were each about to grow their own "are you sure" — an inline
   * two-button strip here, a `window.confirm` there — and those disagree on
   * everything that matters: which button focus lands on, whether Escape
   * cancels, whether the destructive one is visibly destructive, and whether
   * a failure is shown or swallowed.
   *
   * The rules encoded here:
   *   - `tone="danger"` focuses **Cancel**, not Confirm. A prompt that puts
   *     focus on the irreversible button turns a stray Enter into data loss.
   *   - `confirmPhrase` adds type-to-confirm for the genuinely unrecoverable
   *     (removing a member, revoking a secret). The button stays disabled
   *     until the phrase matches exactly.
   *   - `busy` keeps the prompt up, disables both buttons and stops Escape
   *     from dismissing mid-flight, so a long await cannot be abandoned into
   *     an unknown state.
   *   - `error` renders inside the prompt. The caller keeps `open` true on
   *     failure; the user sees why and can retry or cancel.
   *
   * Everything else — scrim, Escape, Tab trap, focus restore — is Dialog.
   */
  import Icon from "./Icon.svelte";
  import Dialog from "./Dialog.svelte";

  let {
    open = false,
    title,
    body,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "default",
    /** Type-to-confirm: the exact text the user must enter. */
    confirmPhrase,
    busy = false,
    error = null,
    onconfirm,
    oncancel,
  }: {
    open?: boolean;
    title: string;
    body?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "danger";
    confirmPhrase?: string;
    busy?: boolean;
    error?: string | null;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  let typed = $state("");

  // Reopening must not inherit the last prompt's half-typed phrase.
  $effect(() => {
    if (!open) typed = "";
  });

  const phraseOk = $derived(
    confirmPhrase === undefined || typed.trim() === confirmPhrase,
  );
  const canConfirm = $derived(!busy && phraseOk);

  function confirm() {
    if (!canConfirm) return;
    onconfirm();
  }
</script>

<Dialog
  {open}
  {title}
  description={body}
  size="sm"
  dismissible={!busy}
  onclose={oncancel}
>
  {#if confirmPhrase !== undefined || error}
    <div class="space-y-3 px-5 pb-4">
      {#if confirmPhrase !== undefined}
        <label class="block">
          <span class="mb-1.5 block text-[12px] text-t2">
            Type <span class="num font-semibold text-t1">{confirmPhrase}</span> to
            confirm
          </span>
          <input
            data-autofocus
            class="input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            disabled={busy}
            aria-invalid={typed.length > 0 && !phraseOk}
            bind:value={typed}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirm();
              }
            }}
          />
        </label>
      {/if}

      {#if error}
        <p
          class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          role="alert"
        >
          <Icon name="alert-circle" size={13} class="mt-px shrink-0" />
          {error}
        </p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="btn"
      disabled={busy}
      data-autofocus={tone === "danger" && confirmPhrase === undefined
        ? true
        : undefined}
      onclick={oncancel}
    >
      {cancelLabel}
    </button>
    <button
      type="button"
      class="btn {tone === 'danger' ? 'btn-destructive' : 'btn-primary'}"
      disabled={!canConfirm}
      data-autofocus={tone === "default" && confirmPhrase === undefined
        ? true
        : undefined}
      onclick={confirm}
    >
      {#if busy}
        <Icon name="refresh" size={13} class="animate-spin" />
      {:else if tone === "danger"}
        <Icon name="trash" size={13} />
      {/if}
      {busy ? "Working…" : confirmLabel}
    </button>
  {/snippet}
</Dialog>
