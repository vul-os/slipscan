<script lang="ts">
  import Money from "./Money.svelte";

  let {
    label,
    value,
    amount,
    currency,
    sub,
    tone = "neutral",
  }: {
    label: string;
    /** Preformatted value string (counts, non-money). */
    value?: string;
    /** Money in integer minor units — renders at display scale with
     * de-emphasized cents via <Money display>. Wins over `value`. */
    amount?: number;
    /** Required alongside `amount` (ISO-4217, from the data). */
    currency?: string;
    sub?: string;
    tone?: "neutral" | "accent" | "warning" | "danger";
  } = $props();

  // Status tones tint the figure itself; no extra chrome. Only the primary
  // (accent) card carries the lime pen-stroke rule on its left edge.
  const valueTone: Record<string, string> = {
    neutral: "",
    accent: "",
    warning: "text-warning",
    danger: "text-danger",
  };
</script>

<div
  class="card relative overflow-hidden p-4 {tone === 'accent' ? 'hero-tint' : ''}"
>
  {#if tone === "accent"}
    <span
      class="absolute inset-y-0 left-0 w-0.5 bg-accent"
      aria-hidden="true"
    ></span>
  {/if}
  <p class="eyebrow">{label}</p>
  <p class="mt-2 {valueTone[tone]}">
    {#if amount !== undefined && currency}
      <Money {amount} {currency} display />
    {:else}
      <span class="num-display">{value}</span>
    {/if}
  </p>
  {#if sub}
    <p class="mt-2 text-[11.5px] text-t3">{sub}</p>
  {/if}
</div>
