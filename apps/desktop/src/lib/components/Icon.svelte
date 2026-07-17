<script lang="ts">
  import { icons, type IconName } from "../icons";

  let {
    name,
    size = 16,
    class: cls = "",
  }: { name: IconName; size?: number; class?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={cls}
  aria-hidden="true"
>
  <!-- eslint-disable-next-line svelte/no-at-html-tags — static icon path data -->
  {@html icons[name]}
</svg>
