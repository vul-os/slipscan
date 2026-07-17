<script lang="ts">
  import { fmtMoney } from "../format";

  let {
    amount,
    currency = "ZAR",
    signed = false,
    colored = false,
    class: cls = "",
  }: {
    /** Integer minor units, signed. */
    amount: number;
    currency?: string;
    /** Always render an explicit +/− sign. */
    signed?: boolean;
    /** Tint income green; leave outflows neutral. */
    colored?: boolean;
    class?: string;
  } = $props();

  const tone = $derived(
    colored && amount > 0 ? "text-success" : colored && amount < 0 ? "" : "",
  );
</script>

<span class="num {tone} {cls}">{fmtMoney(amount, currency, { signed })}</span>
