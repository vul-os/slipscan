<script lang="ts">
  import logoMark from "../../assets/logo-mark.svg?raw";
  import { router, type RouteId } from "../router.svelte";
  import { theme, type ThemeMode } from "../theme.svelte";
  import { api, isTauri } from "../api/client";
  import { apiStatus } from "../api/status.svelte";
  import { globalSearch } from "../search.svelte";
  import type { Book, Health } from "../api/types";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  interface NavItem {
    route: RouteId;
    label: string;
    icon: IconName;
    key: string;
  }

  const nav: NavItem[] = [
    { route: "dashboard", label: "Dashboard", icon: "dashboard", key: "D" },
    { route: "transactions", label: "Transactions", icon: "transactions", key: "T" },
    { route: "receipts", label: "Receipts", icon: "receipt", key: "R" },
    { route: "budgets", label: "Budgets", icon: "budgets", key: "B" },
    { route: "ledger", label: "Ledger", icon: "ledger", key: "L" },
    { route: "reconcile", label: "Reconcile", icon: "reconcile", key: "C" },
    { route: "payments", label: "Payments", icon: "zap", key: "Y" },
    { route: "reports", label: "Reports", icon: "reports", key: "P" },
    { route: "settings", label: "Settings", icon: "settings", key: "S" },
  ];

  const themeModes: Array<{ mode: ThemeMode; icon: IconName; label: string }> = [
    { mode: "system", icon: "monitor", label: "Follow OS theme" },
    { mode: "light", icon: "sun", label: "Light theme" },
    { mode: "dark", icon: "moon", label: "Dark theme" },
  ];

  let book = $state<Book | null>(null);
  let health = $state<Health | null>(null);
  let searchText = $state("");

  api.bookList().then((books) => (book = books[0] ?? null));
  api.health().then((h) => (health = h));

  function submitSearch() {
    globalSearch.query = searchText;
    router.go("transactions");
  }

  // `?screenshot=1` (scripts/screenshot.mjs) hides the mock badge so docs
  // captures show the product, not the dev harness. Dev in a browser still
  // always shows it.
  const screenshotMode = new URLSearchParams(window.location.search).has(
    "screenshot",
  );
  const mockData = $derived(
    (!isTauri || apiStatus.usedMockFallback) && !screenshotMode,
  );
</script>

<!-- Below the `rail` breakpoint (~900px) this collapses to an icon rail:
     labels/search/book hide, nav shows icon-only with title tooltips. -->
<aside
  class="flex w-14 shrink-0 flex-col border-r border-line bg-panel rail:w-60"
  aria-label="Primary"
>
  <!-- brand -->
  <div
    class="flex items-center justify-center gap-2.5 px-0 pt-4 pb-3 rail:justify-start rail:px-4"
  >
    <span
      class="inline-flex size-8 shrink-0 rounded-[7px] ring-1 ring-line dark:ring-ink-700 [&>svg]:size-8"
    >
      {@html logoMark}
    </span>
    <span class="hidden text-[15px] font-semibold tracking-tight rail:inline">
      slip<span class="text-accent-ring dark:text-accent">/</span>scan
    </span>
  </div>

  <!-- book -->
  <div
    class="mx-3 mb-3 hidden items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 rail:flex"
  >
    <span
      class="flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken text-[11px] font-semibold text-t2"
    >
      {book ? book.name.slice(0, 1).toUpperCase() : "·"}
    </span>
    <span class="min-w-0 flex-1 leading-tight">
      <span class="block truncate text-[12.5px] font-medium">
        {book?.name ?? "Loading…"}
      </span>
      <span class="block truncate text-[11px] text-t3">
        {book ? `${book.kind} · ${book.currency}` : ""}
      </span>
    </span>
  </div>

  <!-- search -->
  <div class="relative mx-3 mb-3 hidden rail:block">
    <Icon
      name="search"
      size={14}
      class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-t3"
    />
    <input
      id="global-search"
      class="input pr-12 pl-8"
      placeholder="Search transactions…"
      type="text"
      bind:value={searchText}
      onkeydown={(e) => {
        if (e.key === "Enter") submitSearch();
        if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
    <span class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
      <span class="kbd">⌘K</span>
    </span>
  </div>

  <!-- nav -->
  <nav
    class="flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto px-2 rail:px-3"
    aria-label="Sections"
  >
    {#each nav as item (item.route)}
      {@const active = router.current === item.route}
      <a
        href="#/{item.route}"
        title={item.label}
        aria-current={active ? "page" : undefined}
        class="group flex items-center justify-center gap-0 rounded-md px-0 py-[7px] text-[13px] font-medium transition-colors rail:justify-start rail:gap-2.5 rail:px-2.5
          {active
          ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
          : 'text-t2 hover:bg-sunken hover:text-t1'}"
      >
        <Icon
          name={item.icon}
          size={16}
          class={active ? "" : "text-t3 group-hover:text-t2"}
        />
        <span class="hidden min-w-0 flex-1 truncate rail:inline">{item.label}</span>
        {#if active}
          <span class="hidden size-1.5 rounded-full bg-accent rail:inline"></span>
        {:else}
          <span
            class="kbd hidden opacity-0 transition-opacity group-hover:opacity-100 rail:inline-flex"
            title="Press G then {item.key}">{item.key}</span
          >
        {/if}
      </a>
    {/each}
  </nav>

  <!-- footer -->
  <div class="space-y-3 px-2 pt-3 pb-4 rail:px-3">
    <button
      type="button"
      title="Import receipt"
      class="btn btn-primary h-9 w-full justify-center px-0 text-[13px] rail:px-3"
      onclick={() => router.go("receipts")}
    >
      <Icon name="upload" size={15} />
      <span class="hidden rail:inline">Import receipt</span>
    </button>

    <div
      class="flex flex-col items-center gap-2 rail:flex-row rail:justify-between"
    >
      <div
        class="flex flex-col items-center gap-0.5 rounded-md border border-line p-0.5 rail:flex-row"
        role="group"
        aria-label="Theme"
      >
        {#each themeModes as t (t.mode)}
          <button
            type="button"
            title={t.label}
            aria-pressed={theme.mode === t.mode}
            class="flex size-6 items-center justify-center rounded transition-colors
              {theme.mode === t.mode
              ? 'bg-sunken text-t1'
              : 'text-t3 hover:text-t2'}"
            onclick={() => theme.set(t.mode)}
          >
            <Icon name={t.icon} size={13} />
          </button>
        {/each}
      </div>
      <span
        class="hidden items-center gap-1.5 text-[10.5px] text-t3 rail:flex"
        title={!isTauri
          ? "Browser dev — mock data"
          : apiStatus.usedMockFallback
            ? "Some commands are not wired into the backend yet — parts of this UI show mock data"
            : "Running under Tauri"}
      >
        <span
          class="size-1.5 rounded-full {health ? 'bg-success' : 'bg-t3'}"
        ></span>
        {health ? `v${health.version}` : "…"}{mockData ? " · mock" : ""}
      </span>
    </div>
  </div>
</aside>
