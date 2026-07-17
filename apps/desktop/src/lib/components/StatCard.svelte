<script lang="ts">
  let {
    label,
    value,
    sub,
    tone = "neutral",
  }: {
    label: string;
    /** Preformatted value string (amounts render in mono). */
    value: string;
    sub?: string;
    tone?: "neutral" | "accent" | "warning" | "danger";
  } = $props();
</script>

<div class="card relative overflow-hidden p-4">
  {#if tone === "accent"}
    <span class="absolute inset-y-0 left-0 w-[3px] bg-accent"></span>
  {:else if tone === "warning"}
    <span class="absolute inset-y-0 left-0 w-[3px] bg-warning"></span>
  {:else if tone === "danger"}
    <span class="absolute inset-y-0 left-0 w-[3px] bg-danger"></span>
  {/if}
  <p class="eyebrow">{label}</p>
  <p class="mt-2 font-mono text-[22px] leading-none font-medium tracking-tight tabular-nums">
    {value}
  </p>
  {#if sub}
    <p class="mt-2 text-[11.5px] text-t3">{sub}</p>
  {/if}
</div>
