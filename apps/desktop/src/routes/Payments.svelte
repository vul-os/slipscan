<script lang="ts">
  /**
   * Payments — reference watches in, signed webhooks out.
   *
   * Two things this screen has to keep straight, because both are easy to
   * overstate:
   *
   * * **Where detection fires.** The hook lives inside `transaction_create`,
   *   so every source inherits it. The set of sources is now three: statement
   *   imports, manual entries, and bank-alert emails — the last of those
   *   changed this release. `slipscan mail-sync --alerts --account …` parses
   *   alert mail into statement lines and feeds them through the *same*
   *   import path a CSV takes, so those transactions do reach the detection
   *   hook and can fire a watch. The caveat that keeps it honest is a
   *   different one: **no bank patterns ship**, so nothing is parsed until the
   *   user installs a `mailrules` pack for their bank (Settings ›
   *   Connections). This screen used to say email parsing was not
   *   implemented, which is now the wrong claim in the too-pessimistic
   *   direction.
   * * **What a signing secret is.** It is generated locally, held write-only
   *   in the credential vault, and displayed exactly once — at creation or at
   *   rotation, in a modal that has to be acknowledged. There is no path that
   *   brings it back; losing it means rotating, which breaks whatever is
   *   already verifying with the old one. That is why rotate is a confirm,
   *   not a button.
   */
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
  import Dialog from "../lib/components/Dialog.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

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

  /**
   * Arm-to-confirm for the three irreversible actions on this screen, through
   * the shared ConfirmDialog: focus lands on Cancel, Escape cancels, the
   * failure renders inside the prompt, and the await cannot be abandoned
   * halfway. Rotation is in here with the two removals on purpose — it
   * destroys a live secret, so a single stray click must not be able to
   * break a receiver that is verifying signatures right now.
   */
  type Confirm =
    | { kind: "watch-remove"; watch: PayWatch }
    | { kind: "endpoint-remove"; endpoint: PayEndpoint }
    | { kind: "endpoint-rotate"; endpoint: PayEndpoint };

  let confirm = $state<Confirm | null>(null);
  let confirmBusy = $state(false);
  let confirmError = $state<string | null>(null);

  function ask(next: Confirm) {
    confirm = next;
    confirmError = null;
  }

  function cancelConfirm() {
    if (confirmBusy) return;
    confirm = null;
    confirmError = null;
  }

  const confirmCopy = $derived.by(() => {
    const c = confirm;
    if (!c) return null;
    if (c.kind === "watch-remove") {
      // Removing a watch is a wider blast radius than it looks: pay_matches
      // is ON DELETE CASCADE from pay_watch_codes, and pay_deliveries is ON
      // DELETE CASCADE from pay_matches (migration 0005_shapepay), so the
      // record of what this code ever matched goes too. Pause keeps all of
      // it, so the prompt names it rather than making removal the only exit.
      const hits = matchCount(c.watch.id);
      return {
        title: `Stop watching ${c.watch.code}?`,
        body:
          `This also deletes what it has already matched — ` +
          `${hits} ${hits === 1 ? "match" : "matches"} and any deliveries ` +
          `queued from ${hits === 1 ? "it" : "them"}, including ones still ` +
          `retrying. To stop firing webhooks but keep the history, pause it ` +
          `instead.`,
        label: "Remove watch code",
      };
    }
    if (c.kind === "endpoint-remove") {
      return {
        title: `Remove “${c.endpoint.label}”?`,
        body: "Its signing secret is destroyed and its queued deliveries — including anything still pending a retry — go with it. Nothing is re-sent to this URL afterwards.",
        label: "Remove endpoint",
      };
    }
    return {
      title: `Rotate the secret for “${c.endpoint.label}”?`,
      body: "The current secret stops working the moment this completes, so anything already verifying signatures with it starts rejecting them. The new secret is shown once, immediately after.",
      // Named as the destruction it is — rotation is not a refresh, it throws
      // the old key away — which is also what makes the prompt's trash icon
      // the right icon rather than a mismatched one.
      label: "Rotate & destroy the old",
    };
  });

  async function runConfirm() {
    const c = confirm;
    if (!c || !book) return;
    confirmBusy = true;
    confirmError = null;
    try {
      let rotated: PayEndpointWithSecret | null = null;
      if (c.kind === "watch-remove") {
        await api.payWatchRemove({ watch_id: c.watch.id });
        watches = await api.payWatchList({ book_id: book.id });
      } else if (c.kind === "endpoint-remove") {
        await api.payEndpointRemove({ endpoint_id: c.endpoint.id });
        if (revealed?.endpoint.id === c.endpoint.id) dismissReveal();
        // Deliveries cascade with the endpoint — refresh both lists.
        [endpoints, deliveries] = await Promise.all([
          api.payEndpointList({ book_id: book.id }),
          api.payDeliveryList({ book_id: book.id }),
        ]);
      } else {
        rotated = await api.payEndpointRotateSecret({
          endpoint_id: c.endpoint.id,
        });
      }
      confirm = null;
      if (rotated) {
        // Let the prompt unmount and hand focus back before the reveal claims
        // it. Two dialogs mounting in one flush makes focus restore ambiguous,
        // and the loser is the user's focus, which lands on <body>.
        await tick();
        reveal(rotated, "rotated");
      }
    } catch (err) {
      // Stays open with the reason on it, so the action can be retried or
      // abandoned deliberately rather than vanishing into a page-level error.
      confirmError = String(err);
    } finally {
      confirmBusy = false;
    }
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

  /** Mirrors `MAX_DELIVERY_ATTEMPTS` in slipscan-core's pay module. Kept as a
   * named constant rather than a number inlined into prose so the copy and the
   * per-row wording cannot drift apart from each other. */
  const MAX_DELIVERY_ATTEMPTS = 20;

  /** Attempts timeline: one dot per past attempt (capped — older ones fold
   * into a "+n" count). Every attempt of an undelivered delivery failed; a
   * delivered one succeeded on its last try. */
  const DOTS_MAX = 6;
  function attemptDots(d: PayDelivery): Array<"ok" | "fail"> {
    const n = Math.min(d.attempts, DOTS_MAX);
    return Array.from({ length: n }, (_, i) =>
      d.state === "delivered" && i === n - 1 ? "ok" : "fail",
    );
  }
</script>

<PageHeader
  eyebrow="Reference watches · signed webhooks"
  title="Payments"
  subtitle="When a transaction lands carrying a reference code you watch, SlipScan fires HMAC-signed webhooks at endpoints you register — from this machine, with no central infrastructure in the path."
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
        as whole tokens against a transaction's description and merchant, so
        <span class="font-mono">INV1</span> never matches
        <span class="font-mono">INV11</span>.
      </p>
      <!-- The detection hook lives inside transaction_create, so it does
           apply to every source. Saying "any source" and stopping there would
           still mislead, because the set of sources that reach it is a
           specific three. State the set — and state the condition on the
           newest one, which is a missing pack, not missing code. -->
      <p
        class="mb-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
      >
        <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
        <span>
          Detection runs on every transaction as it is created, which today
          means <span class="font-medium">statement imports, entries you make
          yourself, and bank-alert emails</span>. Alert mail goes through the
          same import path a statement does, so a parsed alert can fire a watch
          — but only once you have installed a
          <span class="font-mono">mailrules</span> pack for your bank, because
          no bank patterns ship. Settings › Connections says where that stands.
        </span>
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
            <li class="row-hover flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
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
                  onclick={() => ask({ kind: "watch-remove", watch: w })}
                >
                  <Icon name="trash" size={13} />
                  Remove
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
            <li class="row-hover flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
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
                  onclick={() => ask({ kind: "endpoint-rotate", endpoint: e })}
                >
                  <Icon name="refresh" size={13} />
                  Rotate secret
                </button>
                <button
                  class="btn btn-danger h-7"
                  onclick={() => ask({ kind: "endpoint-remove", endpoint: e })}
                >
                  <Icon name="trash" size={13} />
                  Remove
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
            <span
              class="animate-fade-in flex items-center gap-1.5 text-[12px] text-success"
              role="status"
            >
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
        A delivery that does not land retries with backoff — 1m, 5m, 30m, 2h,
        12h, then daily — and a 4xx rejection fails immediately without
        retrying. Payloads carry the reference, amount and dates, never account
        numbers or the raw bank description.
      </p>
      <!-- The cap is the part a screen is tempted to leave out, and it is
           exactly the part that matters: "failed" is terminal, there is no
           re-queue command on any surface, and a receiver that comes back up
           on day 21 gets nothing. Saying "retries until the receiver answers"
           would be a promise the queue does not keep. -->
      <p
        class="mb-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
      >
        <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
        <span>
          Retrying stops after {MAX_DELIVERY_ATTEMPTS} attempts and the delivery
          is abandoned as <span class="font-medium">failed</span>. That state is
          final — nothing re-queues it, so a receiver fixed after that point has
          to be reconciled from the matches themselves.
        </span>
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
            <li class="row-hover flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
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
                <span class="mt-0.5 flex items-center gap-2">
                  <!-- attempts timeline: filled dots = past attempts (red
                       failed, green landed), hollow dot = the next scheduled
                       try. Decorative — the text carries the same facts. -->
                  <span
                    class="flex shrink-0 items-center gap-1"
                    aria-hidden="true"
                  >
                    {#if d.attempts > DOTS_MAX}
                      <span class="font-mono text-[10px] leading-none text-t3">
                        +{d.attempts - DOTS_MAX}
                      </span>
                    {/if}
                    {#each attemptDots(d) as dot, i (i)}
                      {#if i > 0 || d.attempts > DOTS_MAX}
                        <span class="h-px w-1.5 bg-line-2"></span>
                      {/if}
                      <span
                        class="size-[7px] rounded-full {dot === 'ok'
                          ? 'bg-success'
                          : 'bg-danger'}"
                      ></span>
                    {/each}
                    {#if d.state === "pending"}
                      {#if d.attempts > 0}
                        <span class="h-px w-1.5 bg-line-2"></span>
                      {/if}
                      <span
                        class="size-[7px] rounded-full border border-line-2"
                      ></span>
                    {/if}
                  </span>
                  <span class="truncate font-mono text-[10.5px] text-t3">
                    {d.attempts}
                    {d.attempts === 1 ? "attempt" : "attempts"}
                    {#if d.state === "pending"}
                      · next retry {fmtUntil(d.next_attempt_at)}
                    {:else if d.state === "failed"}
                      <!-- Terminal. Saying so on the row is the difference
                           between "it is still trying" and the truth. -->
                      · <span class="text-danger">given up — not retried</span>
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
              </span>
              <Badge tone={stateTone(d)} label={d.state} />
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{/if}

<!--
  The one-time reveal.

  A secret you can only ever see once must not be something a user can scroll
  past, tab past, or dismiss by pressing Escape on their way somewhere else.
  So it is the one modal in the product that refuses to be waved away
  (`dismissible={false}` — no scrim click, no Escape): the only way out is the
  button that says you have stored it. The secret is never truncated, because
  copying it by hand has to stay possible when the clipboard is unavailable.
-->
<Dialog
  open={revealed !== null}
  title={revealed?.action === "rotated"
    ? "New signing secret — shown once"
    : "Signing secret — shown once"}
  description={revealed
    ? `For “${revealed.endpoint.label}”. This is the only time it is displayed; after this it can be rotated, never read.`
    : undefined}
  dismissible={false}
  onclose={dismissReveal}
>
  {#if revealed}
    {@const r = revealed}
    <div class="space-y-3 px-5 pb-4">
      <p
        class="flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed text-warning"
      >
        <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
        <span>
          {#if r.action === "rotated"}
            The previous secret has already been destroyed — anything still
            verifying with it is failing right now. Put this one in place.
          {:else}
            Copy it into your receiver to verify signatures. Lose it and the
            only way forward is rotating, which breaks whatever is already
            verifying with it.
          {/if}
        </span>
      </p>

      <div>
        <span class="eyebrow mb-1.5 block" id="pay-secret-label">
          HMAC-SHA256 key · 64 hex characters
        </span>
        <code
          class="block rounded-md border border-line bg-sunken px-2.5 py-2 font-mono text-[12px] leading-relaxed break-all select-all"
          aria-labelledby="pay-secret-label"
        >
          {r.secret}
        </code>
      </div>
    </div>
  {/if}

  {#snippet footer()}
    <button class="btn" onclick={copySecret}>
      {#if secretCopied}
        <Icon name="check" size={13} />
        Copied
      {:else}
        <Icon name="copy" size={13} />
        Copy
      {/if}
    </button>
    <button class="btn btn-primary" data-autofocus onclick={dismissReveal}>
      Done — I've stored it
    </button>
  {/snippet}
</Dialog>

<ConfirmDialog
  open={confirm !== null}
  title={confirmCopy?.title ?? ""}
  body={confirmCopy?.body}
  confirmLabel={confirmCopy?.label ?? "Confirm"}
  tone="danger"
  busy={confirmBusy}
  error={confirmError}
  onconfirm={runConfirm}
  oncancel={cancelConfirm}
/>
