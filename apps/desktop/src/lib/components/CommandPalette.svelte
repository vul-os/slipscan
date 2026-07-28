<script lang="ts">
  /**
   * ⌘K / Ctrl-K — the real one.
   *
   * It used to put the caret in the sidebar search box, which is a search
   * box, not a command palette: it could not reach a screen, an action or a
   * setting. This searches all three plus recent transactions.
   *
   * ARIA: the WAI-ARIA 1.2 combobox-with-listbox pattern. The text field
   * keeps DOM focus the entire time and owns `aria-expanded`,
   * `aria-controls` and `aria-activedescendant`; rows are `role="option"`
   * inside `role="group"` sections inside one `role="listbox"`, so a screen
   * reader announces the highlighted row and its section without focus ever
   * moving. Dialog.svelte supplies the scrim, the Escape handling, the Tab
   * trap and focus restoration.
   */
  import { tick } from "svelte";
  import { api } from "../api/client";
  import {
    buildCommands,
    groupCommands,
    searchCommand,
    type Command,
    type CommandDeps,
  } from "../commands";
  import { highlight } from "../fuzzy";
  import { requestIntent } from "../intent.svelte";
  import { optionId, palette } from "../palette.svelte";
  import { router } from "../router.svelte";
  import { globalSearch } from "../search.svelte";
  import { theme } from "../theme.svelte";
  import type { Transaction } from "../api/types";
  import Dialog from "./Dialog.svelte";
  import EmptyState from "./EmptyState.svelte";
  import Icon from "./Icon.svelte";

  /** How many recent transactions the palette carries. Small on purpose:
   * they are a shortcut to a row, not a replacement for Transactions. */
  const RECENT_LIMIT = 6;

  let recents = $state<Transaction[]>([]);
  let loadedRecents = false;

  const deps: CommandDeps = $derived({
    go: (route) => router.go(route),
    requestIntent,
    setTheme: (mode) => theme.set(mode),
    themeMode: theme.mode,
    searchTransactions: (query) => {
      globalSearch.query = query;
    },
  });

  const commands = $derived([
    ...buildCommands(deps, recents),
    ...searchCommand(palette.query, deps),
  ]);

  // The state machine holds the catalogue so its ranking stays testable
  // without a component; this is the one place that feeds it.
  $effect(() => {
    palette.commands = commands;
  });

  /**
   * Recents load once per session, on first open — never on boot. The
   * palette must be usable the instant it opens, so a failure here is
   * swallowed: the catalogue simply has no recent rows, and the "Search
   * transactions for …" command still reaches every one of them.
   */
  $effect(() => {
    if (!palette.open || loadedRecents) return;
    loadedRecents = true;
    void (async () => {
      try {
        const [book] = await api.bookList();
        if (!book) return;
        recents = await api.transactionList({
          book_id: book.id,
          limit: RECENT_LIMIT,
        });
      } catch {
        recents = [];
      }
    })();
  });

  const results = $derived(palette.results);
  const groups = $derived(groupCommands(results));
  /** Flat rank position per row — what `aria-activedescendant` points at. */
  const positions = $derived(
    new Map(results.map((command, index) => [command.id, index])),
  );

  // Keep the highlighted row on screen while arrowing through a long list.
  $effect(() => {
    const id = palette.activeDescendantId;
    if (!id) return;
    void tick().then(() => {
      const row = document.getElementById(id);
      // Optional call: jsdom has no layout and so no scrollIntoView, and a
      // missing scroll is not worth an unhandled rejection.
      row?.scrollIntoView?.({ block: "nearest" });
    });
  });

  function run(index: number) {
    if (!palette.runAt(index)) return;
    // Whatever ran probably replaced the screen focus came from, so send the
    // keyboard into the new one rather than letting it fall onto <body>.
    void tick().then(() => document.getElementById("main")?.focus());
  }

  function onKeydown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        palette.move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        palette.move(-1);
        break;
      case "PageDown":
        e.preventDefault();
        palette.move(5);
        break;
      case "PageUp":
        e.preventDefault();
        palette.move(-5);
        break;
      case "Enter":
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        run(palette.activeIndex);
        break;
      // Home/End are deliberately left alone: this is a text field, and
      // moving the caret is what those keys mean here.
      default:
    }
  }

  const kindTone: Record<Command["kind"], string> = {
    nav: "text-t3",
    action: "text-accent-text dark:text-accent",
    theme: "text-t3",
    recent: "text-t3",
    search: "text-t3",
  };
</script>

<Dialog
  open={palette.open}
  title="Command palette"
  description="Search screens, actions and recent transactions. Arrow keys move, Enter runs, Escape closes."
  hideTitle
  align="top"
  size="lg"
  class="overflow-hidden"
  onclose={() => palette.hide()}
>
  <!-- query -->
  <div class="relative border-b border-line">
    <Icon
      name="search"
      size={15}
      class="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-t3"
    />
    <input
      data-autofocus
      id="palette-input"
      class="h-12 w-full bg-transparent pr-4 pl-10 text-[14px] text-t1 outline-none placeholder:text-t3"
      type="text"
      role="combobox"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      aria-expanded="true"
      aria-controls="palette-listbox"
      aria-autocomplete="list"
      aria-activedescendant={palette.activeDescendantId}
      aria-label="Search screens, actions and recent transactions"
      placeholder="Search screens, actions, transactions…"
      value={palette.query}
      oninput={(e) => palette.setQuery(e.currentTarget.value)}
      onkeydown={onKeydown}
    />
  </div>

  <!-- results -->
  <div
    id="palette-listbox"
    class="palette-list max-h-[min(60vh,26rem)] overflow-y-auto py-1.5"
    role="listbox"
    aria-label="Results"
  >
    {#if results.length === 0}
      <!-- Reachable only before the catalogue is built (one frame at most):
           any non-empty query keeps the "Search transactions for …" command,
           and an empty one shows the whole catalogue. It is here so that
           frame is never a blank box. -->
      <EmptyState
        title="Nothing matches that"
        body="Try a screen name (“ledger”), something to do (“import”), or a merchant."
      />
    {:else}
      {#each groups as group (group.key)}
        <div role="group" aria-label={group.heading}>
          <p class="eyebrow px-4 pt-2 pb-1">{group.heading}</p>
          {#each group.commands as command (command.id)}
            {@const index = positions.get(command.id) ?? -1}
            {@const selected = index === palette.activeIndex}
            <!-- tabindex="-1": an option in the combobox pattern is never in
                 the tab order (the text field keeps focus), but it must be
                 programmatically focusable to satisfy the role.

                 The keyboard-handler rule does not apply here and following
                 it would break the pattern: keystrokes belong to the
                 combobox input, which drives this list through
                 aria-activedescendant. Enter on the highlighted row is
                 handled there, so every row is fully keyboard-operable —
                 the click handler exists only for the pointer. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id={optionId(index)}
              role="option"
              tabindex="-1"
              aria-selected={selected}
              class="palette-option {selected ? 'is-active' : ''}"
              onclick={() => run(index)}
              onpointermove={() => palette.focusIndex(index)}
            >
              <Icon
                name={command.icon}
                size={15}
                class="shrink-0 {selected ? '' : kindTone[command.kind]}"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-[13px]">
                  {#each highlight(palette.query, command.label) as run, i (i)}<span
                      class={run.hit ? "palette-hit" : ""}>{run.text}</span
                    >{/each}
                </span>
                {#if command.detail}
                  <span
                    class="block truncate text-[11.5px] {selected
                      ? 'opacity-70'
                      : 'text-t3'}">{command.detail}</span
                  >
                {/if}
              </span>
              {#if command.trailing}
                <span
                  class="shrink-0 {command.kind === 'recent'
                    ? 'num text-[12px]'
                    : 'kbd'} {selected ? 'palette-trailing-active' : ''}"
                  >{command.trailing}</span
                >
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    <p class="mr-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-t3">
      <span class="flex items-center gap-1.5">
        <span class="kbd"><Icon name="chevron-up" size={10} /></span>
        <span class="kbd"><Icon name="chevron-down" size={10} /></span>
        navigate
      </span>
      <span class="flex items-center gap-1.5">
        <span class="kbd"><Icon name="corner-down-left" size={10} /></span>
        run
      </span>
      <span class="flex items-center gap-1.5">
        <span class="kbd">esc</span>
        close
      </span>
      <span class="flex items-center gap-1.5">
        <span class="kbd">G</span>
        then a letter jumps
      </span>
    </p>
  {/snippet}
</Dialog>
