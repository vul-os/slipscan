<script lang="ts">
  /**
   * The one modal primitive: scrim, panel, focus trap, focus restore.
   *
   * Every overlay in the product goes through this — the command palette,
   * first-run setup, and every confirm/destructive prompt — so the keyboard
   * contract is written once:
   *
   *   - focus moves into the panel on open (`data-autofocus` wins, else the
   *     first focusable, else the panel itself)
   *   - Tab and Shift-Tab cycle *within* the panel and cannot escape it
   *   - Escape closes (unless `dismissible={false}`), as does the scrim
   *   - on close, focus returns exactly where it came from
   *
   * `aria-modal="true"` is what tells assistive tech the rest of the page is
   * inert while this is up; the background is deliberately not given the
   * `inert` attribute, because these panels mount inside the shell they
   * would be disabling.
   *
   * Motion: the scrim fades and the panel rises using the shared
   * `--animate-*` tokens, which the global `prefers-reduced-motion` rule in
   * app.css collapses to a single frame.
   */
  import { tick, type Snippet } from "svelte";

  let {
    open = false,
    title,
    /** Rendered under the title and wired up as `aria-describedby`. */
    description,
    /** False for a prompt that must be answered rather than waved away. */
    dismissible = true,
    size = "md",
    /** Hide the title visually (the palette shows its own search row). */
    hideTitle = false,
    /** Vertical placement: palettes sit high, prompts sit centred. */
    align = "center",
    onclose,
    children,
    footer,
    class: cls = "",
  }: {
    open?: boolean;
    title: string;
    description?: string;
    dismissible?: boolean;
    size?: "sm" | "md" | "lg";
    hideTitle?: boolean;
    align?: "center" | "top";
    onclose?: () => void;
    /** Optional: a dialog can be a title, a description and a footer. */
    children?: Snippet;
    footer?: Snippet;
    class?: string;
  } = $props();

  const uid = nextId();
  const titleId = `dialog-title-${uid}`;
  const descId = `dialog-desc-${uid}`;

  const widths: Record<string, string> = {
    sm: "max-w-sm",
    md: "max-w-lg",
    lg: "max-w-2xl",
  };

  let panel = $state<HTMLElement | null>(null);
  /** Where focus was before the dialog opened, to hand it back on close. */
  let restoreTo: HTMLElement | null = null;

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Tabbable elements inside the panel, in DOM order.
   *
   * Deliberately no visibility filter: the obvious one (`offsetParent`) is
   * null for anything inside a `position: fixed` ancestor and for every
   * element in jsdom, so it would silently empty this list — and an empty
   * list means the trap stops trapping. Panels here show and hide content
   * with `{#if}`, which removes it from the DOM entirely, so presence in the
   * panel is the same question as visibility.
   */
  function focusables(): HTMLElement[] {
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
  }

  $effect(() => {
    if (!open) return;
    restoreTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || !panel) return;
      const preferred = panel.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusables()[0] ?? panel).focus();
    });
    return () => {
      cancelled = true;
      // The element may have been unmounted by whatever the dialog did;
      // `isConnected` keeps that from throwing focus onto nothing.
      if (restoreTo?.isConnected) restoreTo.focus();
      restoreTo = null;
    };
  });

  function close() {
    if (dismissible) onclose?.();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (!dismissible) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) {
      // Nothing to cycle between: keep focus on the panel rather than
      // letting Tab walk out into the screen behind the scrim.
      e.preventDefault();
      panel?.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<script lang="ts" module>
  let counter = 0;
  /** Per-instance suffix for the aria-labelledby/describedby wiring. */
  function nextId(): number {
    counter += 1;
    return counter;
  }
</script>

{#if open}
  <div
    class="scrim {align === 'top' ? 'scrim-top' : ''}"
    onkeydown={onKeydown}
    role="presentation"
  >
    <!-- A real button, not a div with a click handler: the scrim is a
         genuine "close" affordance, and this keeps it out of the tab order
         while staying reachable to a pointer and to a virtual cursor. -->
    <button
      type="button"
      class="scrim-hit"
      tabindex="-1"
      aria-label={dismissible ? `Close ${title}` : `${title} (must be answered)`}
      onclick={close}
    ></button>

    <div
      bind:this={panel}
      class="elev-overlay dialog-panel w-full {widths[size]} {cls}"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      tabindex="-1"
    >
      <div class={hideTitle ? "sr-only" : "px-5 pt-4 pb-3"}>
        <h2 id={titleId} class="text-[15px] font-semibold tracking-tight">
          {title}
        </h2>
        {#if description}
          <p id={descId} class="mt-1 text-[12.5px] leading-relaxed text-t2">
            {description}
          </p>
        {/if}
      </div>

      {@render children?.()}

      {#if footer}
        <div
          class="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3"
        >
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
