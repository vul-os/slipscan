<script lang="ts">
  import { fmtMoney } from "../format";

  let {
    amount,
    currency,
    signed = false,
    colored = false,
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
    class?: string;
  } = $props();

  const tone = $derived(
    colored && amount > 0 ? "text-success" : colored && amount < 0 ? "" : "",
  );
</script>

<span class="num {tone} {cls}">{fmtMoney(amount, currency, { signed })}</span>
