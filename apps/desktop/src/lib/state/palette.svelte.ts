/**
 * Command-palette state machine.
 *
 * Kept out of the component so the keyboard contract — the part that is easy
 * to break and impossible to see in a screenshot — is testable without a
 * DOM. The component owns focus, scrolling and markup; everything here is
 * "what is open, what matched, what is selected, what happens on Enter".
 *
 * Focus discipline (WAI-ARIA combobox pattern): DOM focus never leaves the
 * text input while the palette is open — the highlighted row is communicated
 * with `aria-activedescendant`, not by moving focus. Restoring focus on
 * close belongs to Dialog.svelte, which owns it for every overlay; the one
 * exception is running a command, where the element focus came from has
 * usually just been unmounted by the navigation, so the component sends
 * focus into the new screen instead.
 */

import { rankCommands, type Command } from "./commands";

/** Enough rows that scrolling is possible, few enough that ranking matters. */
const MAX_RESULTS = 40;

class Palette {
  open = $state(false);
  query = $state("");
  /** Index into `results`; clamped on read, so a shrinking list is safe. */
  #cursor = $state(0);
  /** The catalogue, rebuilt by the component whenever its inputs change. */
  commands = $state<Command[]>([]);

  readonly results: Command[] = $derived(
    rankCommands(this.commands, this.query, MAX_RESULTS),
  );

  /** -1 when nothing matched, so callers never index an empty list. */
  readonly activeIndex: number = $derived(
    this.results.length === 0
      ? -1
      : Math.min(Math.max(this.#cursor, 0), this.results.length - 1),
  );

  readonly active: Command | null = $derived(
    this.activeIndex === -1 ? null : (this.results[this.activeIndex] ?? null),
  );

  /** The id `aria-activedescendant` must point at, or undefined. */
  readonly activeDescendantId: string | undefined = $derived(
    this.active ? optionId(this.activeIndex) : undefined,
  );

  /** Open on a clean query and selection. ⌘K while open re-opens harmlessly. */
  show(): void {
    this.open = true;
    this.query = "";
    this.#cursor = 0;
  }

  /** Close and reset. Focus is Dialog's business, not the state machine's. */
  hide(): void {
    this.open = false;
    this.query = "";
    this.#cursor = 0;
  }

  /** Typing resets the selection to the best match. */
  setQuery(value: string): void {
    this.query = value;
    this.#cursor = 0;
  }

  /** Move the highlight, wrapping at both ends. No-op on an empty list. */
  move(delta: number): void {
    const count = this.results.length;
    if (count === 0) return;
    const from = this.activeIndex === -1 ? 0 : this.activeIndex;
    this.#cursor = (((from + delta) % count) + count) % count;
  }

  first(): void {
    this.#cursor = 0;
  }

  last(): void {
    this.#cursor = Math.max(0, this.results.length - 1);
  }

  /** Point the highlight at a row (pointer hover, so Enter follows the mouse). */
  focusIndex(index: number): void {
    if (index >= 0 && index < this.results.length) this.#cursor = index;
  }

  /**
   * Run the highlighted command. Returns true when something ran, so the
   * caller knows whether to move focus into the screen or hand it back.
   */
  runActive(): boolean {
    const command = this.active;
    if (!command) return false;
    this.hide();
    command.run();
    return true;
  }

  runAt(index: number): boolean {
    this.focusIndex(index);
    return this.runActive();
  }
}

/** Stable per-row DOM id — `aria-activedescendant` needs one to point at. */
export function optionId(index: number): string {
  return `palette-option-${index}`;
}

export const palette = new Palette();

/**
 * Does this keystroke mean "open the command palette"?
 *
 * ⌘K on macOS, Ctrl-K elsewhere. Both are accepted on both platforms: the
 * app runs under Tauri on all three desktops and users bring their habits
 * with them. Deliberately not gated on the event target — ⌘K works from
 * inside the sidebar search box too, which is where it used to only put the
 * caret.
 */
export function isPaletteChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k";
}
