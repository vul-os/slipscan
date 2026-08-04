/**
 * Command palette — matcher, catalogue, state machine, and the real thing.
 *
 * The palette is almost entirely keyboard behaviour, which is exactly the
 * kind of thing that type-checks, builds, screenshots fine and is broken.
 * So this covers three layers:
 *
 *   1. `fuzzy.ts` — the ranking rules, as properties rather than snapshots.
 *   2. `commands.ts` / `palette.svelte.ts` — what exists to run and what is
 *      selected, with every effect injected so no DOM is involved.
 *   3. The mounted shell — ⌘K opens it, arrows move `aria-activedescendant`,
 *      Enter navigates, Escape closes and hands focus back. Nothing below
 *      that layer can prove the ARIA wiring is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import App from "../App.svelte";
import { fuzzyPositions, fuzzyScore, highlight } from "../lib/util/fuzzy";
import {
  buildCommands,
  groupCommands,
  navCommands,
  rankCommands,
  searchCommand,
  themeCommands,
  type Command,
  type CommandDeps,
} from "../lib/commands";
import { GOTO_KEYS, NAV_ITEMS } from "../lib/nav";
import { clearIntent, peekIntent } from "../lib/state/intent.svelte";
import { isPaletteChord, optionId, palette } from "../lib/state/palette.svelte";
import { ROUTES, router } from "../lib/state/router.svelte";
import { globalSearch } from "../lib/state/search.svelte";
import { firstRun } from "../lib/state/onboarding.svelte";
import type { Transaction } from "../lib/api/types";

// ---------------------------------------------------------------------------
// 1. the matcher
// ---------------------------------------------------------------------------

describe("fuzzy matching", () => {
  it("matches subsequences, case-insensitively, and rejects non-subsequences", () => {
    expect(fuzzyScore("led", "Ledger")).not.toBeNull();
    expect(fuzzyScore("LDG", "Ledger")).not.toBeNull();
    expect(fuzzyScore("rec", "Reconcile")).not.toBeNull();
    expect(fuzzyScore("zzz", "Reconcile")).toBeNull();
    // Right letters, wrong order: a subsequence matcher must say no.
    expect(fuzzyScore("gel", "Ledger")).toBeNull();
  });

  it("scores a prefix above a mid-word hit", () => {
    const prefix = fuzzyScore("rec", "Reconcile")!;
    const inside = fuzzyScore("rec", "Direct recovery")!;
    expect(prefix).toBeGreaterThan(inside);
  });

  it("scores word starts above buried letters — the reason it is not greedy", () => {
    // A greedy left-to-right matcher takes the `t` in "Trial" then hunts for
    // a `b`, and cannot see that `t`+`b` land on two word starts.
    const wordStarts = fuzzyScore("tb", "Trial balance")!;
    const buried = fuzzyScore("tb", "Attribute")!;
    expect(wordStarts).toBeGreaterThan(buried);
  });

  it("scores a tight run above a scattered one", () => {
    const tight = fuzzyScore("dash", "Dashboard")!;
    const scattered = fuzzyScore("dash", "Delivered a short hint")!;
    expect(tight).toBeGreaterThan(scattered);
  });

  it("treats the empty query as a match with no opinion", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
    expect(fuzzyPositions("", "anything")).toEqual([]);
  });

  it("never reports positions for text it did not match", () => {
    expect(fuzzyPositions("zzz", "Ledger")).toEqual([]);
    expect(highlight("zzz", "Ledger")).toEqual([{ text: "Ledger", hit: false }]);
  });

  it("reassembles the original string from its highlight runs", () => {
    for (const [q, text] of [
      ["led", "Ledger"],
      ["rc", "Reconcile"],
      ["woolw", "WOOLWORTHS 178 CLAREMONT"],
      ["", "Untouched"],
    ] as const) {
      expect(
        highlight(q, text)
          .map((r) => r.text)
          .join(""),
      ).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. the catalogue
// ---------------------------------------------------------------------------

/** Every effect a command can have, captured instead of performed. */
function fakeDeps(): {
  deps: CommandDeps;
  went: string[];
  intents: string[];
  themes: string[];
  searches: string[];
  setUps: number[];
} {
  const went: string[] = [];
  const intents: string[] = [];
  const themes: string[] = [];
  const searches: string[] = [];
  const setUps: number[] = [];
  return {
    went,
    intents,
    themes,
    searches,
    setUps,
    deps: {
      go: (route) => went.push(route),
      requestIntent: (intent) => intents.push(intent.kind),
      setTheme: (mode) => themes.push(mode),
      themeMode: "system",
      searchTransactions: (query) => searches.push(query),
      setUpBook: () => setUps.push(1),
    },
  };
}

const TXN: Transaction = {
  id: "txn-1",
  book_id: "book-1",
  account_id: "acct-1",
  posted_at: "2026-07-16T10:00:00Z",
  description: "WOOLWORTHS 178 CLAREMONT",
  merchant: "Woolworths",
  amount_minor: -84_235,
  currency: "ZAR",
  category_id: null,
  source: "import",
  provider_txn_id: null,
  hash: "h",
  attributed_member_id: null,
  created_at: "2026-07-16T10:00:00Z",
};

describe("command catalogue", () => {
  it("covers every route in the rail, in rail order", () => {
    const { deps } = fakeDeps();
    expect(navCommands(deps).map((c) => c.id)).toEqual(
      ROUTES.map((r) => `nav:${r}`),
    );
  });

  it("the nav model and the router agree on the route list and its order", () => {
    // The rail, the palette and the `G` chord all read lib/nav.ts. If it
    // ever disagrees with ROUTES, one of them is silently unreachable.
    expect(NAV_ITEMS.map((i) => i.route)).toEqual([...ROUTES]);
    expect(Object.values(GOTO_KEYS).sort()).toEqual([...ROUTES].sort());
    expect(new Set(Object.keys(GOTO_KEYS)).size).toBe(ROUTES.length);
  });

  it("runs the named actions by navigating and parking an intent", () => {
    const { deps, went, intents } = fakeDeps();
    const byId = new Map(buildCommands(deps).map((c) => [c.id, c]));

    for (const [id, route, intent] of [
      ["action:import-receipt", "receipts", "import-receipt"],
      ["action:new-transaction", "transactions", "new-transaction"],
      ["action:install-pack", "packs", "install-pack"],
      ["action:run-reconcile", "reconcile", "run-reconcile"],
      ["action:move-data-folder", "settings", "settings-tab"],
    ] as const) {
      const command = byId.get(id);
      expect(command, `missing ${id}`).toBeDefined();
      command!.run();
      expect(went.at(-1)).toBe(route);
      expect(intents.at(-1)).toBe(intent);
    }
  });

  it("switches theme on the spot — no navigation, no intent", () => {
    const { deps, went, intents, themes } = fakeDeps();
    const dark = themeCommands(deps).find((c) => c.id === "theme:dark")!;
    dark.run();
    expect(themes).toEqual(["dark"]);
    expect(went).toEqual([]);
    expect(intents).toEqual([]);
  });

  it("marks the theme that is already on, and only that one", () => {
    const { deps } = fakeDeps();
    const marked = themeCommands({ ...deps, themeMode: "dark" }).filter(
      (c) => c.trailing === "Current",
    );
    expect(marked.map((c) => c.id)).toEqual(["theme:dark"]);
  });

  it("renders recent transactions through fmtMoney, not raw minor units", () => {
    const { deps, went, intents } = fakeDeps();
    const [recent] = buildCommands(deps, [TXN]).filter((c) =>
      c.id.startsWith("txn:"),
    );
    expect(recent!.label).toBe("Woolworths");
    // −84_235 ZAR minor units, whitespace-normalised for the NBSP Intl adds.
    expect(recent!.trailing?.replace(/\s+/g, " ")).toBe("−R 842.35");
    recent!.run();
    expect(intents).toEqual(["reveal-transaction"]);
    expect(went).toEqual(["transactions"]);
  });

  it("offers the typed text to the transactions filter, but never for nothing", () => {
    const { deps, went, searches } = fakeDeps();
    expect(searchCommand("   ", deps)).toEqual([]);
    const [search] = searchCommand("takealot", deps);
    expect(search!.label).toContain("takealot");
    search!.run();
    expect(searches).toEqual(["takealot"]);
    expect(went).toEqual(["transactions"]);
  });
});

describe("ranking", () => {
  const { deps } = fakeDeps();
  const catalogue = buildCommands(deps, [TXN]);

  it("keeps the natural order when nothing has been typed", () => {
    expect(rankCommands(catalogue, "").map((c) => c.id)).toEqual(
      catalogue.map((c) => c.id),
    );
  });

  it("puts an exact screen name first", () => {
    expect(rankCommands(catalogue, "ledger")[0]!.id).toBe("nav:ledger");
    expect(rankCommands(catalogue, "reconcile")[0]!.id).toBe("nav:reconcile");
  });

  it("finds a screen by a word that is not in its label", () => {
    // "trial balance" is on the Ledger screen; the label never says so.
    const ids = rankCommands(catalogue, "trial balance").map((c) => c.id);
    expect(ids).toContain("nav:ledger");
  });

  it("finds an action by intent rather than by its exact wording", () => {
    expect(rankCommands(catalogue, "upload slip")[0]!.id).toBe(
      "action:import-receipt",
    );
    expect(rankCommands(catalogue, "dark mode")[0]!.id).toBe("theme:dark");
  });

  it("finds a transaction by merchant", () => {
    expect(rankCommands(catalogue, "woolworths")[0]!.id).toBe("txn:txn-1");
  });

  it("returns nothing rather than everything for gibberish", () => {
    expect(rankCommands(catalogue, "qqqzzzxxx")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(rankCommands(catalogue, "", 3)).toHaveLength(3);
  });

  it("groups results without re-ordering them", () => {
    const ranked = rankCommands(catalogue, "");
    const flat = groupCommands(ranked).flatMap((g) => g.commands);
    expect(flat.map((c) => c.id)).toEqual(ranked.map((c) => c.id));
  });
});

// ---------------------------------------------------------------------------
// 3. the state machine
// ---------------------------------------------------------------------------

describe("palette state", () => {
  const { deps } = fakeDeps();

  beforeEach(() => {
    palette.hide();
    palette.commands = buildCommands(deps, [TXN]);
  });

  it("recognises ⌘K and Ctrl-K, and nothing else", () => {
    const chord = (init: KeyboardEventInit) =>
      isPaletteChord(new KeyboardEvent("keydown", { key: "k", ...init }));
    expect(chord({ metaKey: true })).toBe(true);
    expect(chord({ ctrlKey: true })).toBe(true);
    expect(chord({})).toBe(false);
    expect(chord({ metaKey: true, altKey: true })).toBe(false);
    expect(
      isPaletteChord(new KeyboardEvent("keydown", { key: "j", metaKey: true })),
    ).toBe(false);
    // Capitals arrive when Shift is held; the chord still means the same.
    expect(
      isPaletteChord(new KeyboardEvent("keydown", { key: "K", metaKey: true })),
    ).toBe(true);
  });

  it("opens clean every time", () => {
    palette.setQuery("stale");
    palette.move(3);
    palette.hide();
    palette.show();
    expect(palette.open).toBe(true);
    expect(palette.query).toBe("");
    expect(palette.activeIndex).toBe(0);
  });

  it("wraps at both ends of the list", () => {
    palette.show();
    const last = palette.results.length - 1;
    palette.move(-1);
    expect(palette.activeIndex).toBe(last);
    palette.move(1);
    expect(palette.activeIndex).toBe(0);
    palette.last();
    expect(palette.activeIndex).toBe(last);
    palette.first();
    expect(palette.activeIndex).toBe(0);
  });

  it("re-selects the best match as the query changes", () => {
    palette.show();
    palette.move(4);
    expect(palette.activeIndex).toBe(4);
    palette.setQuery("ledger");
    expect(palette.activeIndex).toBe(0);
    expect(palette.active?.id).toBe("nav:ledger");
  });

  it("has no selection, and cannot be run, when nothing matches", () => {
    palette.show();
    palette.setQuery("qqqzzzxxx");
    expect(palette.results).toEqual([]);
    expect(palette.activeIndex).toBe(-1);
    expect(palette.active).toBeNull();
    expect(palette.activeDescendantId).toBeUndefined();
    expect(palette.runActive()).toBe(false);
    // …and arrowing around an empty list must not throw or select a ghost.
    palette.move(1);
    palette.move(-1);
    expect(palette.activeIndex).toBe(-1);
  });

  it("points aria-activedescendant at the highlighted row", () => {
    palette.show();
    expect(palette.activeDescendantId).toBe(optionId(0));
    palette.move(2);
    expect(palette.activeDescendantId).toBe(optionId(2));
  });

  it("closes itself before running, so a command cannot act behind a scrim", () => {
    palette.show();
    palette.setQuery("ledger");
    let openWhileRunning: boolean | null = null;
    palette.commands = [
      {
        id: "probe",
        kind: "action",
        group: "Actions",
        label: "Probe",
        keywords: "",
        icon: "check",
        run: () => (openWhileRunning = palette.open),
      } satisfies Command,
    ];
    palette.setQuery("probe");
    expect(palette.runActive()).toBe(true);
    expect(openWhileRunning).toBe(false);
    expect(palette.open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. the mounted shell
// ---------------------------------------------------------------------------

function render(component: Component): {
  target: HTMLElement;
  dispose: () => void;
} {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target });
  return {
    target,
    dispose: () => {
      unmount(instance);
      target.remove();
    },
  };
}

/** Let promises and Svelte's scheduler catch up. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

function press(key: string, init: KeyboardEventInit = {}, target?: EventTarget) {
  (target ?? window).dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  flushSync();
}

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("command palette in the shell", () => {
  let fatal: string[] = [];
  const onError = (e: ErrorEvent) => fatal.push(e.message);

  beforeEach(() => {
    fatal = [];
    window.addEventListener("error", onError);
    palette.hide();
    clearIntent();
    globalSearch.query = "";
    window.location.hash = "";
    // The mock dataset has a book, so first-run never fires here; pin it.
    firstRun.open = false;
  });

  afterEach(() => {
    window.removeEventListener("error", onError);
    palette.hide();
    document.body.innerHTML = "";
    window.location.hash = "";
  });

  it("⌘K opens a labelled modal combobox with focus in the field", async () => {
    const { target, dispose } = render(App as Component);
    try {
      await tick();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      press("k", { metaKey: true });
      await tick();

      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog, "⌘K did not open a dialog").not.toBeNull();
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      // A modal without an accessible name is an unnamed box to a screen
      // reader; the name has to come from real markup, not a comment.
      const labelledBy = dialog.getAttribute("aria-labelledby")!;
      expect(document.getElementById(labelledBy)?.textContent).toContain(
        "Command palette",
      );

      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(
        document.getElementById(input.getAttribute("aria-controls")!)
          ?.getAttribute("role"),
      ).toBe("listbox");
      expect(target).toBeTruthy();
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("arrows move aria-activedescendant and exactly one option is selected", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      press("k", { metaKey: true });
      await tick();

      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;
      const selected = () =>
        [...document.querySelectorAll('[role="option"]')].filter(
          (o) => o.getAttribute("aria-selected") === "true",
        );

      expect(selected()).toHaveLength(1);
      const first = input.getAttribute("aria-activedescendant");
      expect(document.getElementById(first!)?.getAttribute("aria-selected")).toBe(
        "true",
      );

      press("ArrowDown", {}, input);
      const second = input.getAttribute("aria-activedescendant");
      expect(second).not.toBe(first);
      expect(selected()).toHaveLength(1);
      expect(
        document.getElementById(second!)?.getAttribute("aria-selected"),
      ).toBe("true");

      press("ArrowUp", {}, input);
      expect(input.getAttribute("aria-activedescendant")).toBe(first);
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("filters as you type and Enter runs the highlighted command", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      expect(router.current).toBe("dashboard");

      press("k", { metaKey: true });
      await tick();
      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;

      type(input, "ledger");
      await tick();
      const rows = [...document.querySelectorAll('[role="option"]')];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.textContent).toContain("Ledger");

      press("Enter", {}, input);
      await tick();

      expect(router.current).toBe("ledger");
      expect(window.location.hash).toBe("#/ledger");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      // Focus goes into the screen that just arrived, not onto <body>.
      expect(document.activeElement?.id).toBe("main");
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("hands free text to the transactions filter as the last resort", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      press("k", { metaKey: true });
      await tick();
      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;

      type(input, "takealot");
      await tick();
      const rows = [...document.querySelectorAll('[role="option"]')];
      const search = rows.find((r) => r.textContent?.includes("Search"))!;
      expect(search, "no search escape hatch offered").toBeDefined();
      (search as HTMLElement).click();
      await tick();

      expect(globalSearch.query).toBe("takealot");
      expect(router.current).toBe("transactions");
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("falls back to the search escape hatch when nothing else matches", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      press("k", { metaKey: true });
      await tick();
      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;

      type(input, "qqqzzzxxx");
      await tick();

      // Text nothing in the catalogue matches is still a valid transaction
      // search, so the palette must never be a dead end: exactly one row is
      // left, and it is the escape hatch.
      const rows = [...document.querySelectorAll('[role="option"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("Search transactions for");
      expect(rows[0]!.getAttribute("aria-selected")).toBe("true");

      press("Enter", {}, input);
      await tick();
      expect(globalSearch.query).toBe("qqqzzzxxx");
      expect(router.current).toBe("transactions");
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("Escape closes and gives focus back to whatever opened it", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      const trigger = document.getElementById("palette-trigger")!;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      trigger.click();
      await tick();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      press("Escape", {}, document.activeElement!);
      await tick();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("keeps focus inside the palette when Tab is pressed", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      press("k", { metaKey: true });
      await tick();
      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;

      press("Tab", {}, input);
      flushSync();
      const panel = document.querySelector('[role="dialog"]')!;
      expect(panel.contains(document.activeElement)).toBe(true);

      press("Tab", { shiftKey: true }, document.activeElement!);
      flushSync();
      expect(panel.contains(document.activeElement)).toBe(true);
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("still jumps with G-then-letter, and not while the palette is up", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();

      // The chord that existed before the palette must still work.
      press("g");
      press("l");
      await tick();
      expect(router.current).toBe("ledger");

      // …but `g` typed into the palette is a search, not a navigation.
      press("k", { metaKey: true });
      await tick();
      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;
      press("g", {}, input);
      press("b", {}, input);
      await tick();
      expect(router.current).toBe("ledger");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(fatal).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("switches theme from the palette without leaving the screen", async () => {
    const { dispose } = render(App as Component);
    try {
      await tick();
      router.go("budgets");
      await tick();

      press("k", { metaKey: true });
      await tick();
      const input = document.querySelector<HTMLInputElement>(
        'input[role="combobox"]',
      )!;
      type(input, "switch theme to dark");
      await tick();
      press("Enter", {}, input);
      await tick();

      expect(document.documentElement.classList.contains("dark")).toBe(true);
      expect(router.current).toBe("budgets");
      expect(peekIntent()).toBeNull();
      expect(fatal).toEqual([]);
    } finally {
      // Leave the document as we found it for the suites that follow.
      document.documentElement.classList.remove("dark");
      localStorage.removeItem("slipscan.theme");
      dispose();
    }
  }, 20_000);
});

describe("intent hand-off", () => {
  it("is claimed once, by the screen that asked for its kind", async () => {
    const { requestIntent, takeIntent, peekIntent: peek } = await import(
      "../lib/state/intent.svelte"
    );
    clearIntent();
    requestIntent({ kind: "settings-tab", tab: "data" });
    // A screen that does not handle this kind must not swallow it.
    expect(takeIntent("import-receipt")).toBeNull();
    expect(peek()).not.toBeNull();

    expect(takeIntent("settings-tab")).toEqual({
      kind: "settings-tab",
      tab: "data",
    });
    // …and it does not fire again on the next visit.
    expect(takeIntent("settings-tab")).toBeNull();
    expect(peek()).toBeNull();
  });
});

// Keep a stray timer or spy from leaking into the suites that follow.
afterEach(() => {
  vi.useRealTimers();
});
