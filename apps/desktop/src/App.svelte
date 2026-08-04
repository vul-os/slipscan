<script lang="ts">
  import type { Component } from "svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import FirstRun from "./lib/components/FirstRun.svelte";
  import { api } from "./lib/api/client";
  import { bookEpoch } from "./lib/books.svelte";
  import { GOTO_KEYS } from "./lib/nav";
  import { firstRun } from "./lib/onboarding.svelte";
  import { isPaletteChord, palette } from "./lib/palette.svelte";
  import { router, type RouteId } from "./lib/router.svelte";
  import Dashboard from "./routes/Dashboard.svelte";
  import Transactions from "./routes/Transactions.svelte";
  import Receipts from "./routes/Receipts.svelte";
  import Budgets from "./routes/Budgets.svelte";
  import Household from "./routes/Household.svelte";
  import Ledger from "./routes/Ledger.svelte";
  import Reconcile from "./routes/Reconcile.svelte";
  import Payments from "./routes/Payments.svelte";
  import Reports from "./routes/Reports.svelte";
  import Sales from "./routes/Sales.svelte";
  import Packs from "./routes/Packs.svelte";
  import Settings from "./routes/Settings.svelte";

  const screens: Record<RouteId, Component> = {
    dashboard: Dashboard,
    transactions: Transactions,
    receipts: Receipts,
    budgets: Budgets,
    household: Household,
    ledger: Ledger,
    reconcile: Reconcile,
    payments: Payments,
    reports: Reports,
    sales: Sales,
    packs: Packs,
    settings: Settings,
  };

  const Screen = $derived(screens[router.current]);

  /**
   * First-run setup is offered only when there is genuinely nothing set up —
   * `book_list` came back empty. A *failed* call is not an empty one, so a
   * transport error passes `null` and the flow stays out of the way rather
   * than greeting an existing user with a setup wizard.
   */
  api
    .bookList()
    .then((books) => firstRun.consider(books.length))
    .catch(() => firstRun.consider(null));

  /**
   * Keyboard shell.
   *
   * ⌘K / Ctrl-K opens the command palette from anywhere, including from
   * inside a text field — it used to only move the caret into the sidebar
   * search box, which is why it had to be gated on the target.
   *
   * `G` then a letter still jumps to a section (the letters live in
   * lib/nav.ts alongside the labels the rail and the palette both render),
   * and is still suppressed inside inputs so typing "g" into a filter does
   * not navigate.
   */
  let gPending = false;
  let gTimer: ReturnType<typeof setTimeout> | undefined;

  function onKeydown(e: KeyboardEvent) {
    if (isPaletteChord(e)) {
      e.preventDefault();
      palette.show();
      return;
    }
    // An overlay owns the keyboard while it is up; the G chord must not fire
    // behind it, including when focus is on a dialog panel rather than a
    // field.
    if (palette.open || firstRun.open) return;

    const el = e.target as HTMLElement | null;
    if (
      el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable)
    )
      return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const key = e.key.toLowerCase();
    if (gPending) {
      gPending = false;
      clearTimeout(gTimer);
      const route = GOTO_KEYS[key];
      if (route) {
        e.preventDefault();
        router.go(route);
      }
      return;
    }
    if (key === "g") {
      gPending = true;
      clearTimeout(gTimer);
      gTimer = setTimeout(() => (gPending = false), 900);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Button, not an anchor: the hash belongs to the router (`#/<route>`). -->
<button
  type="button"
  class="skip-link"
  onclick={() => document.getElementById("main")?.focus()}
>
  Skip to content
</button>

<div class="flex h-screen overflow-hidden">
  <Sidebar />
  <main
    class="min-w-0 flex-1 overflow-y-auto bg-surface"
    id="main"
    tabindex="-1"
  >
    <!-- The epoch is in the key so creating the first book re-runs the
         current screen's load, which had nothing to load before it. -->
    {#key `${router.current}:${bookEpoch.value}`}
      <div class="route-enter mx-auto max-w-[1060px] px-5 py-6 rail:px-8 rail:py-7">
        <Screen />
      </div>
    {/key}
  </main>
</div>

<!-- Overlays live outside the shell so they are never clipped by the scroll
     container, and so their scrim covers the rail as well as the screen. -->
<CommandPalette />
<FirstRun />
