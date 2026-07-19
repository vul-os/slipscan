<script lang="ts">
  import { fmtMoneyParts } from "../format";

  let {
    amount,
    currency,
    signed = false,
    colored = false,
    display = false,
    class: cls = "",
  }: {
    /** Integer minor units, signed. */
    amount: number;
    /** ISO-4217 code from the data (book/account/txn) — no fallback. */
    currency: string;
    /** Always render an explicit +/− sign. */
    signed?: boolean;
    /** Tint income green; leave outflows neutral. */
    colored?: boolean;
    /** Hero scale: .num-display (clamped size, tight tracking, tiny cents). */
    display?: boolean;
    class?: string;
  } = $props();

  const parts = $derived(fmtMoneyParts(amount, currency, { signed }));
  const tone = $derived(colored && amount > 0 ? "text-success" : "");
</script>

<span class="{display ? 'num-display' : 'num'} {tone} {cls}"
  >{parts.sign}{parts.pre}{#if parts.frac}<span class="money-frac"
      >{parts.frac}</span
    >{/if}{parts.post}</span
>
