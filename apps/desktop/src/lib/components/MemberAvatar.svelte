<script lang="ts">
  /**
   * The one avatar chip for household members: a colour swatch + initial
   * (core stores the colour verbatim, never interprets it — display only),
   * or a dashed "unattributed" placeholder when there is no member.
   */
  import type { Member } from "../api/types";

  let {
    member,
    size = 20,
    class: cls = "",
  }: {
    member: Member | null;
    size?: number;
    class?: string;
  } = $props();

  /** WCAG 2.x relative luminance (sRGB -> linear), used only to pick the
   * initial's ink colour — member.colour is arbitrary and stored verbatim
   * (core never interprets it), so contrast must be computed per-swatch
   * rather than assumed. Falls back to dark ink for malformed input. */
  function relativeLuminance(hex: string): number {
    const clean = hex.replace("#", "");
    if (clean.length !== 6 || /[^0-9a-fA-F]/.test(clean)) return 0;
    const channel = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const r = channel(parseInt(clean.slice(0, 2), 16));
    const g = channel(parseInt(clean.slice(2, 4), 16));
    const b = channel(parseInt(clean.slice(4, 6), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Threshold ~0.179 is where black-on-bg and white-on-bg contrast cross
  // over (WCAG contrast formula); picking by side of that line clears
  // 4.5:1 AA for both light and dark swatches, theme-independent since the
  // swatch colour itself is a fixed literal.
  const initialInk = $derived(
    member && relativeLuminance(member.colour) > 0.179 ? "#09090b" : "#ffffff",
  );
</script>

{#if member}
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full font-semibold {cls}"
    style="width: {size}px; height: {size}px; font-size: {Math.max(9, size * 0.42)}px; background-color: {member.colour}; color: {initialInk};"
    title={member.label}
  >
    {member.initial}
  </span>
{:else}
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-line-2 text-t3 {cls}"
    style="width: {size}px; height: {size}px; font-size: {Math.max(9, size * 0.42)}px;"
    title="Unattributed"
  >
    ·
  </span>
{/if}
