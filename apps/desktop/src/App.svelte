<script lang="ts">
  import type { Component } from "svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import { router, type RouteId } from "./lib/router.svelte";
  import Dashboard from "./routes/Dashboard.svelte";
  import Transactions from "./routes/Transactions.svelte";
  import Receipts from "./routes/Receipts.svelte";
  import Budgets from "./routes/Budgets.svelte";
  import Ledger from "./routes/Ledger.svelte";
  import Reconcile from "./routes/Reconcile.svelte";
  import Payments from "./routes/Payments.svelte";
  import Reports from "./routes/Reports.svelte";
  import Settings from "./routes/Settings.svelte";

  const screens: Record<RouteId, Component> = {
    dashboard: Dashboard,
    transactions: Transactions,
    receipts: Receipts,
    budgets: Budgets,
    ledger: Ledger,
    reconcile: Reconcile,
    payments: Payments,
    reports: Reports,
    settings: Settings,
  };

  const Screen = $derived(screens[router.current]);

  // Keyboard nav: ⌘/Ctrl-K focuses search, `G` then a letter jumps to a section.
  const gotoKeys: Record<string, RouteId> = {
    d: "dashboard",
    t: "transactions",
    r: "receipts",
    b: "budgets",
    l: "ledger",
    c: "reconcile",
    y: "payments",
    p: "reports",
    s: "settings",
  };

  let gPending = false;
  let gTimer: ReturnType<typeof setTimeout> | undefined;

  function onKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      document.getElementById("global-search")?.focus();
      return;
    }
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
      const route = gotoKeys[key];
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

<div class="flex h-screen overflow-hidden">
  <Sidebar />
  <main class="min-w-0 flex-1 overflow-y-auto bg-surface" id="main">
    {#key router.current}
      <div class="animate-slide-up mx-auto max-w-[1060px] px-8 py-7">
        <Screen />
      </div>
    {/key}
  </main>
</div>
