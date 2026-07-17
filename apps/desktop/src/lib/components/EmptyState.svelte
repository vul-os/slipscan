<script lang="ts">
  import type { Snippet } from "svelte";
  import type { IconName } from "../icons";
  import Icon from "./Icon.svelte";

  let {
    icon = "inbox",
    title,
    body,
    hint,
    actions,
  }: {
    icon?: IconName;
    title: string;
    body?: string;
    /** Optional keyboard hint, e.g. "press U to upload". */
    hint?: string;
    actions?: Snippet;
  } = $props();
</script>

<div
  class="flex flex-col items-center justify-center gap-1 px-6 py-14 text-center"
>
  <div
    class="mb-3 flex size-11 items-center justify-center rounded-xl border border-line bg-sunken text-t3"
  >
    <Icon name={icon} size={20} />
  </div>
  <h3 class="text-[14px] font-semibold">{title}</h3>
  {#if body}
    <p class="max-w-sm text-[12.5px] leading-relaxed text-t2">{body}</p>
  {/if}
  {#if actions}
    <div class="mt-4 flex items-center gap-2">{@render actions()}</div>
  {/if}
  {#if hint}
    <p class="mt-3 text-[11px] text-t3">{hint}</p>
  {/if}
</div>
