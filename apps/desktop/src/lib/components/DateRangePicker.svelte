<script lang="ts">
  /**
   * The one date-range control: presets plus two explicit dates.
   *
   * Reports, Household and Transactions all take `{from, to}`, and three
   * hand-rolled versions would be three chances to disagree about what "last
   * 3 months" means. It means three calendar months from the 1st — see
   * daterange.ts, which owns that decision and is tested on its own.
   *
   * Behaviour worth knowing:
   *   - The presets are a radio-style group (`aria-pressed`), not a select,
   *     so the common ranges are one key away.
   *   - The two date fields are native `<input type="date">`: they are
   *     keyboard- and locale-correct for free, and the OS picker is better
   *     than anything hand-rolled here.
   *   - An invalid or inverted range is **announced, not swallowed**. The
   *     control keeps showing what was typed and reports why it is unusable
   *     rather than silently snapping to something else.
   *   - `onchange` fires only for valid ranges, so callers never have to
   *     defend against `from > to`.
   */
  import {
    datePresets,
    matchPreset,
    rangeDays,
    rangeError,
    type DateRange,
  } from "../util/daterange";
  import Icon from "./Icon.svelte";

  let {
    from,
    to,
    onchange,
    /** Accessible name for the whole control. */
    label = "Date range",
    /** Injectable clock — the presets are relative to "today". */
    now = new Date(),
    class: cls = "",
  }: {
    from: string;
    to: string;
    onchange: (range: DateRange) => void;
    label?: string;
    now?: Date;
    class?: string;
  } = $props();

  const presets = $derived(datePresets(now));
  const current = $derived<DateRange>({ from, to });
  const activePreset = $derived(matchPreset(current, now));
  const issue = $derived(rangeError(current));
  const days = $derived(rangeDays(current));

  function apply(range: DateRange) {
    if (rangeError(range)) return;
    onchange(range);
  }
</script>

<div
  class="flex flex-wrap items-center gap-x-3 gap-y-2 {cls}"
  role="group"
  aria-label={label}
>
  <div
    class="flex flex-wrap items-center gap-0.5 rounded-lg border border-line p-0.5"
    role="group"
    aria-label="{label} presets"
  >
    {#each presets as preset (preset.id)}
      <button
        type="button"
        class="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors
          {activePreset === preset.id
          ? 'bg-ink-900 text-ink-50 dark:bg-ink-100 dark:text-ink-900'
          : 'text-t2 hover:bg-sunken hover:text-t1'}"
        aria-pressed={activePreset === preset.id}
        onclick={() => apply(preset.range)}
      >
        {preset.label}
      </button>
    {/each}
  </div>

  <div class="flex items-center gap-1.5">
    <!-- aria-label rather than a <label for>: two pickers on one screen
         must not collide on an id, and the visible name is the group's. -->
    <input
      class="input w-[8.5rem]"
      type="date"
      aria-label="{label} start"
      value={from}
      max={to}
      aria-invalid={issue !== null}
      onchange={(e) => apply({ from: e.currentTarget.value, to })}
    />
    <Icon name="arrow-right" size={13} class="shrink-0 text-t3" />
    <input
      class="input w-[8.5rem]"
      type="date"
      aria-label="{label} end"
      value={to}
      min={from}
      aria-invalid={issue !== null}
      onchange={(e) => apply({ from, to: e.currentTarget.value })}
    />
  </div>

  {#if issue}
    <p
      class="flex items-center gap-1.5 text-[11.5px] text-danger"
      role="alert"
    >
      <Icon name="alert-circle" size={12} />
      {issue}
    </p>
  {:else}
    <p class="axis-label">{days} {days === 1 ? "day" : "days"}</p>
  {/if}
</div>
