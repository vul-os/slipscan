<script lang="ts">
  import { tick } from "svelte";
  import { api } from "../lib/api/client";
  import type {
    Book,
    PayDelivery,
    PayEndpoint,
    PayEndpointWithSecret,
    PayMatch,
    PayWatch,
  } from "../lib/api/types";
  import { fmtMoney, fmtRelative, parseMoneyInput } from "../lib/format";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";

  let book = $state<Book | null>(null);
  let watches = $state<PayWatch[]>([]);
  let endpoints = $state<PayEndpoint[]>([]);
  let matches = $state<PayMatch[]>([]);
  let deliveries = $state<PayDelivery[]>([]);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);

  // -- watch codes --
  let watchError = $state<string | null>(null);
  let showWatchForm = $state(false);
  let watchCode = $state("");
  let watchLabel = $state("");
  let watchAmount = $state("");
  let watchCurrency = $state("");
  let watchBusy = $state(false);
  let watchCodeInput = $state<HTMLInputElement | null>(null);

  // -- endpoints --
  let endpointError = $state<string | null>(null);
  let showEndpointForm = $state(false);
  let epLabel = $state("");
  let epUrl = $state("");
  let epBusy = $state(false);
  let epLabelInput = $state<HTMLInputElement | null>(null);
  /** Id of the endpoint whose secret is being rotated right now, if any. */
  let rotatingId = $state<string | null>(null);

  /**
   * The one-time secret reveal. Populated only from an add/rotate response —
   * the single sanctioned display — and cleared the moment the user is done.
   * There is no way to bring a secret back: losing it means rotating.
   */
  let revealed = $state<{
    endpoint: PayEndpoint;
    secret: string;
    action: "created" | "rotated";
  } | null>(null);
  let secretCopied = $state(false);

  // -- deliveries --
  let deliveryError = $state<string | null>(null);
  let deliverBusy = $state(false);
  let deliveredNote = $state<string | null>(null);

  /** Two-step remove (same pattern as the vault's revoke): first click arms,
   * second destroys; disarms on mouse-out, blur, Escape, or timeout. Keys
   * are prefixed (`watch:` / `endpoint:`) so the two lists never cross-arm. */
  let removeArmed = $state<string | null>(null);
  let removeTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmRemove(key?: string) {
    if (key === undefined || removeArmed === key) {
      removeArmed = null;
      clearTimeout(removeTimer);
    }
  }

  function armOrConfirm(key: string): boolean {
    if (removeArmed !== key) {
      disarmRemove();
      removeArmed = key;
      removeTimer = setTimeout(() => disarmRemove(key), 5000);
      return false;
    }
    disarmRemove();
    return true;
  }

  async function loadLists(bookId: string) {
    [watches, endpoints, matches, deliveries] = await Promise.all([
      api.payWatchList({ book_id: bookId }),
      api.payEndpointList({ book_id: bookId }),
      api.payMatchList({ book_id: bookId }),
      api.payDeliveryList({ book_id: bookId }),
    ]);
  }

  async function load() {
    loadError = null;
    try {
      const books = await api.bookList();
      book = books[0] ?? null;
      if (book) {
        watchCurrency ||= book.currency;
        await loadLists(book.id);
      }
      loaded = true;
    } catch (err) {
      loadError = String(err);
    }
  }
  load();

  const matchCount = (watchId: string): number =>
    matches.filter((m) => m.watch_id === watchId).length;

  const endpointLabel = (id: string): string =>
    endpoints.find((e) => e.id === id)?.label ?? "(removed endpoint)";

  /** The stored payload is metadata-only JSON; pull the display fields. */
  function payloadSummary(
    d: PayDelivery,
  ): { reference: string; amount: string } | null {
    try {
      const p = JSON.parse(d.payload) as {
        reference?: string;
        amount_minor?: number;
        currency?: string;
      };
      if (!p.reference || p.amount_minor == null || !p.currency) return null;
      return {
        reference: p.reference,
        amount: fmtMoney(p.amount_minor, p.currency),
      };
    } catch {
      return null;
    }
  }

  /** "due now" / "in 42m" for a pending delivery's next attempt. */
  function fmtUntil(iso: string, now = new Date()): string {
    const mins = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
    if (mins <= 0) return "due now";
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.round(hours / 24)}d`;
  }

  const sortedDeliveries = $derived(
    deliveries.slice().sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
  );
  const dueCount = $derived(
    deliveries.filter(
      (d) =>
        d.state === "pending" && d.next_attempt_at <= new Date().toISOString(),
    ).length,
  );

  // -- watch codes --

  function closeWatchForm() {
    showWatchForm = false;
    watchCode = "";
    watchLabel = "";
    watchAmount = "";
  }

  async function toggleWatchForm() {
    watchError = null;
    if (showWatchForm) {
      closeWatchForm();
      return;
    }
    showWatchForm = true;
    await tick();
    watchCodeInput?.focus();
  }

  async function addWatch() {
    if (!book) return;
    watchError = null;
    const currency = (watchCurrency.trim() || book.currency).toUpperCase();
    let amount: number | undefined;
    if (watchAmount.trim()) {
      const parsed = parseMoneyInput(watchAmount, currency);
      if (parsed === null || parsed <= 0) {
        watchError =
          "enter a positive exact amount (e.g. 4500.00), or leave it empty to match any amount";
        return;
      }
      amount = parsed;
    }
    watchBusy = true;
    try {
      await api.payWatchAdd({
        book_id: book.id,
        code: watchCode.trim(),
        label: watchLabel.trim() || undefined,
        expected_amount_minor: amount,
        expected_currency: amount !== undefined ? currency : undefined,
      });
      watches = await api.payWatchList({ book_id: book.id });
      closeWatchForm();
    } catch (err) {
      watchError = String(err);
    } finally {
      watchBusy = false;
    }
  }

  async function removeWatch(id: string) {
    if (!armOrConfirm(`watch:${id}`) || !book) return;
    watchError = null;
    try {
      await api.payWatchRemove({ watch_id: id });
      watches = await api.payWatchList({ book_id: book.id });
    } catch (err) {
      watchError = String(err);
    }
  }

  async function toggleWatch(w: PayWatch) {
    watchError = null;
    try {
      const updated = await api.payWatchSetEnabled({
        watch_id: w.id,
        enabled: !w.enabled,
      });
      watches = watches.map((x) => (x.id === updated.id ? updated : x));
    } catch (err) {
      watchError = String(err);
    }
  }

  // -- endpoints --

  function closeEndpointForm() {
    showEndpointForm = false;
    epLabel = "";
    epUrl = "";
  }

  async function toggleEndpointForm() {
    endpointError = null;
    if (showEndpointForm) {
      closeEndpointForm();
      return;
    }
    showEndpointForm = true;
    await tick();
    epLabelInput?.focus();
  }

  function reveal(res: PayEndpointWithSecret, action: "created" | "rotated") {
    revealed = { endpoint: res.endpoint, secret: res.secret, action };
    secretCopied = false;
  }

  /** Done with the one-time display: drop the secret from UI state for good. */
  function dismissReveal() {
    revealed = null;
    secretCopied = false;
  }

  async function copySecret() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      secretCopied = true;
      setTimeout(() => (secretCopied = false), 2000);
    } catch {
      // Clipboard unavailable — the secret is still on screen to copy by hand.
    }
  }

  async function addEndpoint() {
    if (!book) return;
    endpointError = null;
    epBusy = true;
    try {
      const res = await api.payEndpointAdd({
        book_id: book.id,
        label: epLabel.trim(),
        url: epUrl.trim(),
      });
      endpoints = await api.payEndpointList({ book_id: book.id });
      closeEndpointForm();
      reveal(res, "created");
    } catch (err) {
      endpointError = String(err);
    } finally {
      epBusy = false;
    }
  }

  async function rotateSecret(id: string) {
    endpointError = null;
    rotatingId = id;
    try {
      reveal(await api.payEndpointRotateSecret({ endpoint_id: id }), "rotated");
    } catch (err) {
      endpointError = String(err);
    } finally {
      rotatingId = null;
    }
  }

  async function removeEndpoint(id: string) {
    if (!armOrConfirm(`endpoint:${id}`) || !book) return;
    endpointError = null;
    try {
      await api.payEndpointRemove({ endpoint_id: id });
      if (revealed?.endpoint.id === id) dismissReveal();
      // Deliveries cascade with the endpoint — refresh both lists.
      [endpoints, deliveries] = await Promise.all([
        api.payEndpointList({ book_id: book.id }),
        api.payDeliveryList({ book_id: book.id }),
      ]);
    } catch (err) {
      endpointError = String(err);
    }
  }

  async function toggleEndpoint(e: PayEndpoint) {
    endpointError = null;
    try {
      const updated = await api.payEndpointSetEnabled({
        endpoint_id: e.id,
        enabled: !e.enabled,
      });
      endpoints = endpoints.map((x) => (x.id === updated.id ? updated : x));
    } catch (err) {
      endpointError = String(err);
    }
  }

  // -- deliveries --

  /** Explicit user action — the only Payments call that touches the network,
   * and only to the endpoint URLs registered above. */
  async function deliverNow() {
    if (!book) return;
    deliveryError = null;
    deliverBusy = true;
    try {
      const acted = await api.payDeliverDue();
      deliveries = await api.payDeliveryList({ book_id: book.id });
      deliveredNote =
        acted.length === 0
          ? "Nothing was due"
          : `Attempted ${acted.length} ${acted.length === 1 ? "delivery" : "deliveries"}`;
      setTimeout(() => (deliveredNote = null), 4000);
    } catch (err) {
      deliveryError = String(err);
    } finally {
      deliverBusy = false;
    }
  }

  function stateTone(
    d: PayDelivery,
  ): "success" | "danger" | "warning" | "neutral" {
    if (d.state === "delivered") return "success";
    if (d.state === "failed") return "danger";
    return d.attempts > 0 ? "warning" : "neutral";
  }
</script>

<PageHeader
  eyebrow="ShapePay"
  title="Payments"
  subtitle="Inbox in, webhook out: when an inbound transaction carries a reference code you watch, SlipScan fires HMAC-signed webhooks at endpoints you register. No central infrastructure."
/>

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load payments" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={load}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if !loaded}
  <div class="card"><Skeleton rows={8} /></div>
{:else}
  <div class="space-y-4">
    <!-- watch codes: a flat list — enabled is the only state -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="search" size={15} class="text-t3" />
          Watch codes
        </h2>
        <button class="btn h-7" onclick={toggleWatchForm}>
          <Icon name="plus" size={13} />
          Add watch code
        </button>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        The EFT reference you gave a customer. Codes match case-insensitively
        as whole tokens on inbound transactions from any source — email-ingested
        bank alerts first (Settings → Email ingest), imports and manual entries
        alike.
      </p>

      {#if watchError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <Icon name="alert-circle" size={13} />
          {watchError}
        </p>
      {/if}

      {#if showWatchForm}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
             Escape-to-close only; interaction lives on the inputs/buttons. -->
        <form
          class="mb-4 grid gap-3 rounded-lg border border-line bg-sunken/40 p-3 sm:grid-cols-2"
          onsubmit={(e) => {
            e.preventDefault();
            addWatch();
          }}
          onkeydown={(e) => {
            if (e.key === "Escape") closeWatchForm();
          }}
        >
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Reference code</span
            >
            <input
              class="input font-mono"
              placeholder="INV-2041"
              bind:this={watchCodeInput}
              bind:value={watchCode}
              required
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Label (optional)</span
            >
            <input
              class="input"
              placeholder="Deck repair invoice"
              bind:value={watchLabel}
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Exact amount (optional — any amount matches when empty)</span
            >
            <input
              class="input font-mono"
              placeholder="4500.00"
              bind:value={watchAmount}
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >Currency (for the exact amount)</span
            >
            <input
              class="input w-24 font-mono uppercase"
              maxlength={3}
              placeholder={book?.currency ?? "ZAR"}
              bind:value={watchCurrency}
            />
          </label>
          <div class="flex items-center gap-2 sm:col-span-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={watchBusy || !watchCode.trim()}
            >
              {watchBusy ? "Adding…" : "Watch this code"}
            </button>
            <button class="btn btn-ghost h-7" type="button" onclick={closeWatchForm}>
              Cancel
            </button>
          </div>
        </form>
      {/if}

      {#if watches.length === 0}
        <EmptyState
          icon="search"
          title="No watch codes"
          body="Add a reference code and SlipScan watches every inbound transaction for it — when it lands, your webhook endpoints are notified with a signed payload."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each watches as w (w.id)}
            {@const hits = matchCount(w.id)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">
                  <span class="font-mono">{w.code}</span>
                  {#if w.label}
                    <span class="ml-1 text-t2">— {w.label}</span>
                  {/if}
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {#if w.expected_amount_minor != null && w.expected_currency}
                    exactly {fmtMoney(w.expected_amount_minor, w.expected_currency)}
                  {:else}
                    any amount
                  {/if}
                  · {hits}
                  {hits === 1 ? "match" : "matches"} · added {fmtRelative(w.created_at)}
                </span>
              </span>
              {#if !w.enabled}
                <Badge tone="neutral" label="paused" />
              {/if}
              <div class="flex shrink-0 items-center gap-1.5">
                <button class="btn h-7" onclick={() => toggleWatch(w)}>
                  {w.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  class="btn btn-danger h-7"
                  onclick={() => removeWatch(w.id)}
                  onmouseleave={() => disarmRemove(`watch:${w.id}`)}
                  onblur={() => disarmRemove(`watch:${w.id}`)}
                  onkeydown={(e) => {
                    if (e.key === "Escape") disarmRemove(`watch:${w.id}`);
                  }}
                >
                  <Icon name="trash" size={13} />
                  {removeArmed === `watch:${w.id}` ? "Really remove?" : "Remove"}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- webhook endpoints: vault-held signing secrets, shown exactly once -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="zap" size={15} class="text-t3" />
          Webhook endpoints
        </h2>
        <button class="btn h-7" onclick={toggleEndpointForm}>
          <Icon name="plus" size={13} />
          Add endpoint
        </button>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Matches POST a signed JSON payload to every enabled endpoint. Each
        endpoint's signing secret lives in the credential vault, write-only —
        it is shown exactly once when created or rotated, then never again.
      </p>

      {#if endpointError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <Icon name="alert-circle" size={13} />
          {endpointError}
        </p>
      {/if}

      {#if revealed}
        <div
          class="mb-4 rounded-lg border border-accent-ring/40 bg-accent/[0.06] p-3"
        >
          <p class="mb-1 flex items-center gap-2 text-[12.5px] font-semibold">
            <Icon name="key" size={14} class="text-accent-ring dark:text-accent" />
            Signing secret for “{revealed.endpoint.label}”
            <Badge tone="warning" label="shown once" />
          </p>
          <p class="mb-2 text-[11.5px] text-t3">
            Copy it into your receiver now to verify signatures
            {#if revealed.action === "rotated"}
              — the previous secret has been destroyed.
            {:else}
              — after you close this it can never be viewed again, only
              rotated.
            {/if}
          </p>
          <div class="flex items-center gap-2">
            <code
              class="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-[11.5px]"
            >
              {revealed.secret}
            </code>
            <button class="btn h-7 shrink-0" onclick={copySecret}>
              {#if secretCopied}
                <Icon name="check" size={13} />
                Copied
              {:else}
                <Icon name="copy" size={13} />
                Copy
              {/if}
            </button>
            <button class="btn btn-primary h-7 shrink-0" onclick={dismissReveal}>
              Done — I've stored it
            </button>
          </div>
        </div>
      {/if}

      {#if showEndpointForm}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
             Escape-to-close only; interaction lives on the inputs/buttons. -->
        <form
          class="mb-4 grid gap-3 rounded-lg border border-line bg-sunken/40 p-3 sm:grid-cols-[1fr_2fr]"
          onsubmit={(e) => {
            e.preventDefault();
            addEndpoint();
          }}
          onkeydown={(e) => {
            if (e.key === "Escape") closeEndpointForm();
          }}
        >
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">Label</span>
            <input
              class="input"
              placeholder="Shop backend"
              bind:this={epLabelInput}
              bind:value={epLabel}
              required
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2"
              >URL — http(s), no embedded credentials (the signature
              authenticates)</span
            >
            <input
              class="input font-mono"
              placeholder="https://example.com/hooks/slipscan"
              bind:value={epUrl}
              required
            />
          </label>
          <div class="flex items-center gap-2 sm:col-span-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={epBusy || !epLabel.trim() || !epUrl.trim()}
            >
              {epBusy ? "Adding…" : "Add endpoint"}
            </button>
            <button
              class="btn btn-ghost h-7"
              type="button"
              onclick={closeEndpointForm}
            >
              Cancel
            </button>
          </div>
        </form>
      {/if}

      {#if endpoints.length === 0}
        <EmptyState
          icon="zap"
          title="No webhook endpoints"
          body="Register the URL of a system you run — your shop backend, an automation, a self-hosted bridge. Every match POSTs there with an HMAC-SHA256 signature, timestamp and nonce."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each endpoints as e (e.id)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span
                class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
              >
                <Icon name="zap" size={15} />
              </span>
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">{e.label}</span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {e.url} · added {fmtRelative(e.created_at)}
                </span>
              </span>
              {#if !e.enabled}
                <Badge tone="neutral" label="paused" />
              {/if}
              <div class="flex shrink-0 items-center gap-1.5">
                <button class="btn h-7" onclick={() => toggleEndpoint(e)}>
                  {e.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  class="btn h-7"
                  onclick={() => rotateSecret(e.id)}
                  disabled={rotatingId !== null}
                >
                  <Icon name="refresh" size={13} />
                  {rotatingId === e.id ? "Rotating…" : "Rotate secret"}
                </button>
                <button
                  class="btn btn-danger h-7"
                  onclick={() => removeEndpoint(e.id)}
                  onmouseleave={() => disarmRemove(`endpoint:${e.id}`)}
                  onblur={() => disarmRemove(`endpoint:${e.id}`)}
                  onkeydown={(ev) => {
                    if (ev.key === "Escape") disarmRemove(`endpoint:${e.id}`);
                  }}
                >
                  <Icon name="trash" size={13} />
                  {removeArmed === `endpoint:${e.id}`
                    ? "Really remove?"
                    : "Remove"}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- deliveries: the retry queue, with an explicit deliver-now action -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="inbox" size={15} class="text-t3" />
          Deliveries
        </h2>
        <div class="flex items-center gap-1.5">
          {#if deliveredNote}
            <span class="flex items-center gap-1.5 text-[12px] text-success">
              <Icon name="check" size={13} />
              {deliveredNote}
            </span>
          {/if}
          <button
            class="btn h-7"
            onclick={deliverNow}
            disabled={deliverBusy || deliveries.length === 0}
            title="POST every due pending delivery now — the only network call on this page, and only to the endpoints above"
          >
            <Icon name="upload" size={13} />
            {deliverBusy
              ? "Delivering…"
              : dueCount > 0
                ? `Deliver now (${dueCount} due)`
                : "Deliver now"}
          </button>
        </div>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Failed deliveries retry with backoff (1m, 5m, 30m, 2h, 12h, then
        daily) until the receiver answers; a 4xx rejection fails immediately.
        Payloads carry the reference, amount and dates — never account numbers
        or the raw bank description.
      </p>

      {#if deliveryError}
        <p
          class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
        >
          <Icon name="alert-circle" size={13} />
          {deliveryError}
        </p>
      {/if}

      {#if sortedDeliveries.length === 0}
        <EmptyState
          icon="inbox"
          title="No deliveries yet"
          body="When a watched reference code turns up in an inbound transaction, one signed delivery per enabled endpoint queues here."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each sortedDeliveries as d (d.id)}
            {@const summary = payloadSummary(d)}
            <li class="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span class="min-w-0 flex-1 leading-tight">
                <span class="block text-[12.5px] font-medium">
                  {#if summary}
                    <span class="font-mono">{summary.reference}</span>
                    <span class="num">· {summary.amount}</span>
                  {:else}
                    Delivery
                  {/if}
                  <span class="text-t2">→ {endpointLabel(d.endpoint_id)}</span>
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  {d.attempts}
                  {d.attempts === 1 ? "attempt" : "attempts"}
                  {#if d.state === "pending"}
                    · next retry {fmtUntil(d.next_attempt_at)}
                  {/if}
                  {#if d.last_status != null}
                    · HTTP {d.last_status}
                  {/if}
                  {#if d.last_error && d.state !== "delivered"}
                    · <span class="text-danger">{d.last_error}</span>
                  {/if}
                  · updated {fmtRelative(d.updated_at)}
                </span>
              </span>
              <Badge tone={stateTone(d)} label={d.state} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{/if}
