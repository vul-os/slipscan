<script lang="ts">
  let {
    rows = 5,
    class: cls = "",
  }: { rows?: number; class?: string } = $props();
</script>

<div
  class="space-y-2.5 p-4 {cls}"
  aria-busy="true"
  role="status"
  aria-label="Loading"
>
  {#each Array.from({ length: rows }, (_, i) => i) as i (i)}
    <div class="flex items-center gap-3">
      <div class="skeleton size-7 rounded-md"></div>
      <div class="skeleton h-3" style="width: {62 - ((i * 13) % 30)}%"></div>
      <div class="skeleton ml-auto h-3 w-16"></div>
    </div>
  {/each}
</div>
