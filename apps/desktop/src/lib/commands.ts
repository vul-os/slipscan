/**
 * The command palette's catalogue and ranking.
 *
 * Pure by construction: every effect a command can have arrives as a
 * `CommandDeps` callback, so the whole catalogue can be built and run in a
 * test without a router, a theme or a DOM. The palette component owns the
 * wiring; this file owns *what there is to do* and *what ranks first*.
 *
 * Honesty rule (ARCHITECTURE.md, and the reason the mock badge exists): a
 * command never claims more than it does. "New transaction" navigates to
 * Transactions and parks an intent — if that screen has not wired the intent
 * up yet, the user still lands exactly where the work happens, and nothing
 * pretended a composer opened.
 */

import { fuzzyScore } from "./fuzzy";
import type { IconName } from "./icons";
import { intentRoute, type Intent } from "./intent.svelte";
import { NAV_GROUPS } from "./nav";
import type { RouteId } from "./router.svelte";
import type { ThemeMode } from "./theme.svelte";
import type { Transaction } from "./api/types";
import { fmtDate, fmtMoney } from "./format";

export type CommandKind = "nav" | "action" | "theme" | "recent" | "search";

export interface Command {
  /** Stable within one palette session; used for `aria-activedescendant`. */
  id: string;
  kind: CommandKind;
  /** Section heading in the listbox. */
  group: string;
  label: string;
  /** Quiet second line — where the command goes, or what it will do. */
  detail?: string;
  /** Right-aligned trailing text: a shortcut chord, an amount, a state. */
  trailing?: string;
  /** Extra searchable words. Never rendered. */
  keywords: string;
  icon: IconName;
  run: () => void;
}

export interface CommandDeps {
  go: (route: RouteId) => void;
  requestIntent: (intent: Intent) => void;
  setTheme: (mode: ThemeMode) => void;
  /** Read at build time so the current mode can be marked. */
  themeMode: ThemeMode;
  /** Hand a free-text query to the Transactions filter. */
  searchTransactions: (query: string) => void;
}

/** Every destination in the rail, in rail order, with its jump chord. */
export function navCommands(deps: CommandDeps): Command[] {
  return NAV_GROUPS.flatMap((group) =>
    group.items.map(
      (item): Command => ({
        id: `nav:${item.route}`,
        kind: "nav",
        group: `Go to · ${group.heading}`,
        label: item.label,
        trailing: `G ${item.key}`,
        keywords: `${item.keywords} go to open jump navigate`,
        icon: item.icon,
        run: () => deps.go(item.route),
      }),
    ),
  );
}

/**
 * Things to *do*, as opposed to places to go. Each one navigates to the
 * screen that owns the work and parks an intent for it (see
 * intent.svelte.ts) — the navigation is the part that is guaranteed.
 */
export function actionCommands(deps: CommandDeps): Command[] {
  /**
   * The destination is *derived* from the intent rather than passed
   * alongside it: intent.svelte.ts already records which screen owns which
   * intent, and a command that navigated somewhere other than the screen
   * expected to claim its intent would leave that intent unclaimed forever.
   */
  const action = (
    id: string,
    label: string,
    detail: string,
    icon: IconName,
    keywords: string,
    intent: Intent,
  ): Command => ({
    id: `action:${id}`,
    kind: "action",
    group: "Actions",
    label,
    detail,
    keywords,
    icon,
    run: () => {
      deps.requestIntent(intent);
      deps.go(intentRoute(intent.kind));
    },
  });

  return [
    action(
      "import-receipt",
      "Import a receipt",
      "Receipts — pick a slip to extract",
      "upload",
      "add upload slip document invoice pdf scan extract new",
      { kind: "import-receipt" },
    ),
    action(
      "new-transaction",
      "New transaction",
      "Transactions — add a line by hand",
      "plus",
      "add create entry manual spend income record",
      { kind: "new-transaction" },
    ),
    action(
      "run-reconcile",
      "Run reconcile",
      "Reconcile — match slips against transactions",
      "reconcile",
      "match matching pair suggestions confirm slips",
      { kind: "run-reconcile" },
    ),
    action(
      "install-pack",
      "Install a pack",
      "Packs — verify and install a signed pack",
      "package",
      "add classification rules taxonomy benchmark signer verify",
      { kind: "install-pack" },
    ),
    action(
      "move-data-folder",
      "Move the data folder",
      "Settings › Data — one folder holds everything durable",
      "folder",
      "relocate storage database documents path directory backup icloud dropbox",
      { kind: "settings-tab", tab: "data" },
    ),
    action(
      "connect-mailbox",
      "Connect a mailbox",
      "Settings › Connections — IMAP details and credentials",
      "mail",
      "imap email inbox bank alerts credentials",
      { kind: "settings-tab", tab: "connections" },
    ),
  ];
}

/** Theme, switched on the spot — no navigation, no intent, it just happens. */
export function themeCommands(deps: CommandDeps): Command[] {
  const modes: Array<{ mode: ThemeMode; label: string; icon: IconName }> = [
    { mode: "dark", label: "Switch theme to dark", icon: "moon" },
    { mode: "light", label: "Switch theme to light", icon: "sun" },
    { mode: "system", label: "Switch theme to follow the OS", icon: "monitor" },
  ];
  return modes.map(({ mode, label, icon }) => ({
    id: `theme:${mode}`,
    kind: "theme" as const,
    group: "Theme",
    label,
    trailing: deps.themeMode === mode ? "Current" : undefined,
    keywords: "appearance dark light mode colour color contrast night day",
    icon,
    run: () => deps.setTheme(mode),
  }));
}

/**
 * The most recent transactions, so the palette answers "where was that
 * Woolworths charge" without a trip through Transactions and its filter.
 * Money goes through `fmtMoney` like everywhere else — integer minor units
 * in, locale string out.
 */
export function recentCommands(
  transactions: Transaction[],
  deps: CommandDeps,
): Command[] {
  return transactions.map((txn) => ({
    id: `txn:${txn.id}`,
    kind: "recent" as const,
    group: "Recent transactions",
    label: txn.merchant ?? txn.description,
    detail: fmtDate(txn.posted_at),
    trailing: fmtMoney(txn.amount_minor, txn.currency),
    keywords: `${txn.description} ${txn.merchant ?? ""} transaction`,
    icon: "transactions" as IconName,
    run: () => {
      deps.requestIntent({ kind: "reveal-transaction", id: txn.id });
      deps.go(intentRoute("reveal-transaction"));
    },
  }));
}

/**
 * The escape hatch: whatever was typed, handed to the Transactions filter.
 * Always last and never ranked away, because it is the answer when nothing
 * else matched.
 */
export function searchCommand(query: string, deps: CommandDeps): Command[] {
  const q = query.trim();
  if (q === "") return [];
  return [
    {
      id: "search:transactions",
      kind: "search",
      group: "Search",
      label: `Search transactions for “${q}”`,
      detail: "Transactions — filter by description or merchant",
      keywords: "find filter query lookup",
      icon: "search",
      run: () => {
        deps.searchTransactions(q);
        deps.go("transactions");
      },
    },
  ];
}

/** The whole catalogue in its natural (empty-query) order. */
export function buildCommands(
  deps: CommandDeps,
  transactions: Transaction[] = [],
): Command[] {
  return [
    ...actionCommands(deps),
    ...navCommands(deps),
    ...recentCommands(transactions, deps),
    ...themeCommands(deps),
  ];
}

/** A label hit is worth more than a hit buried in the keyword blob. */
const KEYWORD_WEIGHT = 0.6;

function haystack(command: Command): string {
  return `${command.label} ${command.detail ?? ""} ${command.keywords}`;
}

/**
 * Rank the catalogue for `query`.
 *
 * An empty query keeps the natural order (actions, then destinations, then
 * recents, then theme) rather than inventing one. A non-empty query keeps
 * only fuzzy matches, best first; ties fall back to catalogue order, so the
 * list never reshuffles for reasons the user cannot see.
 */
export function rankCommands(
  commands: Command[],
  query: string,
  limit = 40,
): Command[] {
  const q = query.trim();
  if (q === "") return commands.slice(0, limit);

  const scored: Array<{ command: Command; score: number; order: number }> = [];
  commands.forEach((command, order) => {
    const onLabel = fuzzyScore(q, command.label);
    const onAll = fuzzyScore(q, haystack(command));
    if (onLabel === null && onAll === null) return;
    const score = Math.max(
      onLabel ?? -Infinity,
      onAll === null ? -Infinity : onAll * KEYWORD_WEIGHT,
    );
    scored.push({ command, score, order });
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.command);
}

/** Results grouped for rendering, preserving rank order across groups. */
export interface CommandGroup {
  /**
   * Unique per run — a heading can legitimately appear twice, because
   * ranking interleaves groups (two Theme rows either side of a Go-to row is
   * a correct result, not a bug). Keying a rendered list on `heading` alone
   * is what turns that into a duplicate-key crash.
   */
  key: string;
  heading: string;
  commands: Command[];
}

export function groupCommands(commands: Command[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  for (const command of commands) {
    const last = groups[groups.length - 1];
    if (last && last.heading === command.group) last.commands.push(command);
    else
      groups.push({
        key: `${command.group}#${groups.length}`,
        heading: command.group,
        commands: [command],
      });
  }
  return groups;
}
