<script lang="ts">
  /**
   * The one chip system: extraction confidence, recon states, delivery
   * states, region/currency chips all render through this. Tones map to the
   * theme-tuned semantic tokens (AA text on panel in both themes).
   */
  let {
    tone = "neutral",
    label,
    dot = true,
    size = "sm",
  }: {
    tone?: "neutral" | "success" | "warning" | "danger" | "accent";
    label: string;
    dot?: boolean;
    size?: "sm" | "md";
  } = $props();

  const tones: Record<string, string> = {
    neutral: "border-line bg-sunken text-t2",
    success: "border-success/25 bg-success/10 text-success",
    warning: "border-warning/25 bg-warning/10 text-warning",
    danger: "border-danger/25 bg-danger/10 text-danger",
    accent:
      "border-accent-ring/40 bg-accent/15 text-accent-text dark:text-accent",
  };

  const dots: Record<string, string> = {
    neutral: "bg-t3",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    accent: "bg-accent-ring dark:bg-accent",
  };

  const sizes: Record<string, string> = {
    sm: "px-2 py-0.5 text-[11px]",
    md: "px-2.5 py-1 text-[12px]",
  };
</script>

<span
  class="inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap {sizes[size]} {tones[tone]}"
>
  {#if dot}<span class="size-1.5 shrink-0 rounded-full {dots[tone]}"></span>{/if}
  {label}
</span>
