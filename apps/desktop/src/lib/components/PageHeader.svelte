<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    eyebrow,
    title,
    subtitle,
    actions,
  }: {
    eyebrow?: string;
    title: string;
    subtitle?: string;
    actions?: Snippet;
  } = $props();
</script>

<header class="mb-6 flex flex-wrap items-end justify-between gap-4">
  <div class="min-w-0">
    {#if eyebrow}
      <p class="eyebrow mb-1.5">{eyebrow}</p>
    {/if}
    <h1 class="text-[26px] leading-tight font-semibold tracking-[-0.02em]">
      {title}
    </h1>
    {#if subtitle}
      <p class="mt-1 max-w-xl text-[13px] text-t2">{subtitle}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex shrink-0 items-center gap-2">{@render actions()}</div>
  {/if}
</header>
