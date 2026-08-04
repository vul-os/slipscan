<script lang="ts">
  /**
   * Classification packs — the one install pipeline (ARCHITECTURE.md
   * "Classification packs — one install pipeline").
   *
   * A pack carries rules, never data: a category taxonomy, merchant and
   * keyword classification rules, or anonymous cohort aggregates. There is
   * nowhere in the format to put a transaction of yours.
   *
   * Three things this screen exists to make legible, because they are the
   * things that make a signed pack worth trusting:
   *
   * * **the fingerprint** — signer identity *is* the public key; there is no
   *   registry and no authority. Verify before installing, check the
   *   fingerprint against the publisher's own channel, and only then accept.
   * * **the pin** — the first key to sign a pack id owns it forever. A later
   *   version signed by a different key is refused outright, and nothing on
   *   this screen can override that. It is shown as the refusal it is.
   * * **the direction of travel** — versions only move forward. Re-offering
   *   the installed version is an error, and downgrades are rejected.
   *
   * **Getting one here** is the other half, and it now exists: a pack can be
   * read off a file, a synced folder or USB stick, a git remote, or an HTTPS
   * base — the same signed bytes over any of them, because the signature is
   * what is trusted, not the channel. Two rules make that safe to offer:
   *
   * * **arriving is not accepting.** A signer this machine has never seen is
   *   refused until the user accepts that exact fingerprint. Naming a source
   *   is not consent to everything it will ever serve.
   * * **there is no registry and no default endpoint.** The source list
   *   starts empty and only the user writes to it, so with no source added
   *   nothing on this screen touches a network at all.
   */
  import { tick } from "svelte";
  import {
    fmtBytes,
    fmtDate,
    fmtMonth,
    fmtMoney,
    fmtRelative,
    localMonth,
    shiftMonth,
  } from "../lib/util/format";
  import { api } from "../lib/api/client";
  import { requireBook } from "../lib/book";
  import type {
    BenchmarkReport,
    Book,
    InstalledPackInfo,
    PackInstallOutcome,
    PackOffer,
    PackSourceInfo,
    PackVerification,
  } from "../lib/api/types";
  import PageHeader from "../lib/components/PageHeader.svelte";
  import EmptyState from "../lib/components/EmptyState.svelte";
  import Skeleton from "../lib/components/Skeleton.svelte";
  import Badge from "../lib/components/Badge.svelte";
  import Icon from "../lib/components/Icon.svelte";
  import Money from "../lib/components/Money.svelte";
  import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";

  let book = $state<Book | null>(null);
  let packs = $state<InstalledPackInfo[] | null>(null);
  let loadError = $state<string | null>(null);

  async function load() {
    loadError = null;
    try {
      const b = requireBook(await api.bookList());
      book = b;
      packs = await api.packList({ book_id: b.id });
    } catch (err) {
      packs = null;
      loadError = String(err);
    }
    // Installing or removing a pack changes what the comparison can resolve —
    // a taxonomy pack is what turns a benchmark's keys into local categories,
    // so this is refreshed with the list, not independently of it.
    await loadBenchmarks();
  }
  void load();

  // -- the install form -----------------------------------------------------
  // The three inputs the user actually holds, exactly as `slipscan pack
  // install` takes them: the signed document, its detached signature, and
  // the publisher's public key. Signature and key are shown as hex because
  // hex is the form a publisher publishes and a human compares; picking a
  // raw file just fills the field in.

  /** JSON manifests are small; anything this size is not a pack. */
  const MAX_PACK_BYTES = 8 * 1024 * 1024;

  let showInstall = $state(false);
  /** Set when the panel was opened by a row's "Upgrade" button — used only
   * to point out if the file picked turns out to be a different pack. */
  let upgradeFor = $state<string | null>(null);

  let docName = $state("");
  let docSize = $state(0);
  let docBase64 = $state("");
  let signature = $state("");
  let publicKey = $state("");

  let docInput = $state<HTMLInputElement | null>(null);
  /** Which field a "from file…" pick is filling: the signature or the key. */
  let byteFieldTarget = $state<"signature" | "public_key">("signature");
  let byteFileInput = $state<HTMLInputElement | null>(null);

  let verification = $state<PackVerification | null>(null);
  let installed = $state<PackInstallOutcome | null>(null);
  let formError = $state<string | null>(null);
  let verifying = $state(false);
  let installing = $state(false);

  const ready = $derived(
    docBase64 !== "" && signature.trim() !== "" && publicKey.trim() !== "",
  );

  function toBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function toHex(buf: ArrayBuffer): string {
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function resetForm() {
    docName = "";
    docSize = 0;
    docBase64 = "";
    signature = "";
    publicKey = "";
    verification = null;
    formError = null;
    upgradeFor = null;
  }

  async function openInstall(packId?: string) {
    installed = null;
    showInstall = true;
    upgradeFor = packId ?? null;
    await tick();
    docInput?.focus();
  }

  function closeInstall() {
    showInstall = false;
    resetForm();
  }

  async function toggleInstall() {
    if (showInstall) closeInstall();
    else await openInstall();
  }

  /** Any edit to the three inputs invalidates the preflight: a verification
   * must never outlive the bytes it was computed over. */
  function invalidate() {
    verification = null;
    installed = null;
  }

  async function onDocPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    formError = null;
    invalidate();
    if (file.size > MAX_PACK_BYTES) {
      formError = `"${file.name}" is ${fmtBytes(file.size)} — a pack manifest is JSON, and anything over ${fmtBytes(MAX_PACK_BYTES)} is not one.`;
      return;
    }
    docName = file.name;
    docSize = file.size;
    docBase64 = toBase64(await file.arrayBuffer());
  }

  async function pickBytesFile(target: "signature" | "public_key") {
    byteFieldTarget = target;
    await tick();
    byteFileInput?.click();
  }

  async function onBytesPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    formError = null;
    invalidate();
    const hex = toHex(await file.arrayBuffer());
    if (byteFieldTarget === "signature") signature = hex;
    else publicKey = hex;
  }

  function request() {
    return {
      book_id: book!.id,
      document_base64: docBase64,
      signature,
      public_key: publicKey,
    };
  }

  async function verify() {
    if (!book || !ready) return;
    formError = null;
    installed = null;
    verifying = true;
    try {
      verification = await api.packVerify(request());
    } catch (err) {
      verification = null;
      formError = String(err);
    } finally {
      verifying = false;
    }
  }

  async function install() {
    if (!book || !verification || verification.action === "refuse") return;
    formError = null;
    installing = true;
    try {
      installed = await api.packInstall(request());
      closeInstall();
      await load();
    } catch (err) {
      // The install re-checks everything the preflight checked; if state
      // moved underneath it, the refusal is the truth and the stale
      // verification is not.
      verification = null;
      formError = String(err);
    } finally {
      installing = false;
    }
  }

  // -- pack sources ---------------------------------------------------------
  // The fetch half. A source is a place, not an authority: what comes back is
  // verified before anything is written, and an unseen signer must be
  // accepted by fingerprint before it can install anything at all.
  //
  // The list starts empty and nothing ever seeds it. That is the whole
  // privacy story, and the empty state says so rather than apologising for
  // being empty.

  let showSources = $state(false);
  let sources = $state<PackSourceInfo[] | null>(null);
  let sourceError = $state<string | null>(null);
  let sourceBusy = $state<string | null>(null);

  let newSourceName = $state("");
  let newSourceUri = $state("");
  let addingSource = $state(false);

  /** Which source's catalogue is on screen, and what it offered. */
  let openSource = $state<string | null>(null);
  let offers = $state<PackOffer[] | null>(null);
  let offersError = $state<string | null>(null);
  let fetching = $state(false);
  /** Offers whose new signer the user has explicitly ticked off. Keyed by
   * document, because the same fingerprint on two packs is still two
   * separate decisions. */
  let acceptedSigners = $state<Record<string, boolean>>({});
  let pullBusy = $state<string | null>(null);
  let pullError = $state<string | null>(null);

  async function loadSources() {
    sourceError = null;
    try {
      sources = await api.packSourceList();
    } catch (err) {
      sources = [];
      sourceError = String(err);
    }
  }

  async function toggleSources() {
    showSources = !showSources;
    if (showSources) {
      showInstall = false;
      showSeeds = false;
      resetForm();
      if (sources === null) await loadSources();
    }
  }

  async function addSource(e: Event) {
    e.preventDefault();
    if (!newSourceName.trim() || !newSourceUri.trim()) return;
    sourceError = null;
    addingSource = true;
    try {
      await api.packSourceAdd({ name: newSourceName, uri: newSourceUri });
      newSourceName = "";
      newSourceUri = "";
      await loadSources();
    } catch (err) {
      sourceError = String(err);
    } finally {
      addingSource = false;
    }
  }

  async function removeSource(name: string) {
    sourceError = null;
    sourceBusy = name;
    try {
      await api.packSourceRemove({ name });
      if (openSource === name) {
        openSource = null;
        offers = null;
      }
      await loadSources();
    } catch (err) {
      sourceError = String(err);
    } finally {
      sourceBusy = null;
    }
  }

  /** Read a source and preflight everything it offers. Writes nothing. */
  async function fetchSource(name: string) {
    if (!book) return;
    offersError = null;
    pullError = null;
    acceptedSigners = {};
    openSource = name;
    offers = null;
    fetching = true;
    try {
      offers = await api.packSourceFetch({ book_id: book.id, source: name });
      await loadSources();
    } catch (err) {
      offers = [];
      offersError = String(err);
    } finally {
      fetching = false;
    }
  }

  async function pull(offer: PackOffer) {
    const v = offer.verified;
    if (!book || !v || v.action === "refuse") return;
    pullError = null;
    pullBusy = offer.document;
    try {
      installed = await api.packSourceInstall({
        book_id: book.id,
        source: openSource!,
        pack_id: v.pack_id,
        document: offer.document,
        // Only ever sent when the user has ticked the fingerprint check. The
        // backend compares it against the key that actually signed the bytes,
        // so a "yes" is always a yes to the thing that was shown.
        accept_signer: v.needs_signer_acceptance ? v.signer_fingerprint : undefined,
      });
      await load();
      await fetchSource(openSource!);
    } catch (err) {
      pullError = String(err);
      // The state moved underneath the preflight; the refusal is the truth.
      await fetchSource(openSource!);
    } finally {
      pullBusy = null;
    }
  }

  /** Whether the Install button for this offer is armed. A signer this
   * machine has never seen needs the fingerprint ticked off first — that tick
   * is the entire content of trust-on-first-use. */
  function canPull(offer: PackOffer): boolean {
    const v = offer.verified;
    if (!v || v.action === "refuse") return false;
    return !v.needs_signer_acceptance || acceptedSigners[offer.document] === true;
  }

  const sourceKindLabel: Record<string, string> = {
    file: "one file",
    folder: "folder / USB",
    git: "git remote",
    https: "https",
  };

  // -- uninstall ------------------------------------------------------------
  // Arm-to-confirm through the shared prompt: focus on Cancel, Escape
  // cancels, and the failure lands inside the prompt rather than as a banner
  // at the top of a screen the user is no longer looking at.

  let confirmUninstall = $state<InstalledPackInfo | null>(null);
  let removeBusy = $state<string | null>(null);
  let removeError = $state<string | null>(null);
  let listError = $state<string | null>(null);

  async function uninstall(pack: InstalledPackInfo) {
    listError = null;
    removeError = null;
    removeBusy = pack.pack_id;
    try {
      await api.packUninstall({ book_id: pack.book_id, pack_id: pack.pack_id });
      confirmUninstall = null;
      await load();
    } catch (err) {
      removeError = String(err);
    } finally {
      removeBusy = null;
    }
  }

  const kindLabel: Record<string, string> = {
    taxonomy: "categories & rules",
    benchmark: "peer benchmarks",
  };

  // -- built-in seed packs --------------------------------------------------
  // `pack_install_seeds` exists on every surface, and seeding is deliberately
  // opt-in: which taxonomy a book starts from is the user's decision, and
  // installing a South African chart of accounts into a book kept in Portugal
  // would be the wrong default. So it is presented as a decision — with this
  // book's own region profile in front of the user while they make it — not
  // as something that has quietly already happened.

  let showSeeds = $state(false);
  let seeding = $state(false);
  let seedError = $state<string | null>(null);
  /** Result of the last seed run. `[]` is meaningful: everything was already
   * installed at its current version, so nothing was written. */
  let seeded = $state<PackInstallOutcome[] | null>(null);

  function toggleSeeds() {
    seeded = null;
    seedError = null;
    showSeeds = !showSeeds;
    if (showSeeds) {
      showInstall = false;
      resetForm();
    }
  }

  async function installSeeds() {
    if (!book) return;
    seedError = null;
    seeding = true;
    try {
      seeded = await api.packInstallSeeds({ book_id: book.id });
      showSeeds = false;
      await load();
    } catch (err) {
      seeded = null;
      seedError = String(err);
    } finally {
      seeding = false;
    }
  }

  // -- peer comparison against installed benchmark packs --------------------
  // The READ side, which is the only side that exists. A benchmark pack is a
  // public file of a cohort's published aggregates; the comparison is
  // arithmetic performed here against this book's own spending report, and
  // nothing is transmitted. Contribution — and the local differential privacy
  // that design calls for — is NOT BUILT (docs/BENCHMARKS.md); no copy on
  // this screen may imply otherwise.
  //
  // Two results must never be rendered as zeroes, because a silently-zero
  // benchmark is a lie: a pack in another currency is *not compared* (no FX
  // conversion is applied anywhere in this path), and a taxonomy key nothing
  // installed maps to is *unmatched*, not nil spend.

  let period = $state(localMonth());
  let benchmarks = $state<BenchmarkReport[] | null>(null);
  let benchmarkError = $state<string | null>(null);

  async function loadBenchmarks() {
    benchmarkError = null;
    // No book means the screen is already reporting why; leave the section
    // resolved-and-empty rather than spinning a skeleton forever.
    if (!book) {
      benchmarks = [];
      return;
    }
    benchmarks = null;
    try {
      benchmarks = await api.packBenchmark({ book_id: book.id, period });
    } catch (err) {
      benchmarks = [];
      benchmarkError = String(err);
    }
  }

  function shiftPeriod(months: number) {
    period = shiftMonth(period, months);
    void loadBenchmarks();
  }

  /** Placement wording, straight from the op's `position`. Deliberately
   * descriptive: spending less than the cohort on medical care is not a win
   * and spending more is not a failure, so the badge stays neutral in tone
   * and lets the words and the strip carry the direction. */
  const placement: Record<string, string> = {
    below_p25: "below p25",
    typical: "typical",
    above_p75: "above p75",
  };

  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
</script>

<PageHeader
  eyebrow="Signed · offline · rules only"
  title="Packs"
  subtitle="Community classification packs carry a taxonomy and rules — never data. Each one is ed25519-signed, verified before it is installed, and bound to the key that first signed it."
>
  {#snippet actions()}
    <button class="btn" onclick={toggleSources}>
      <Icon name="folder" size={14} />
      Sources
    </button>
    <button class="btn" onclick={toggleSeeds}>
      <Icon name="package" size={14} />
      Built-in seeds
    </button>
    <button class="btn btn-primary" onclick={toggleInstall}>
      <Icon name="upload" size={14} />
      Install a pack
    </button>
  {/snippet}
</PageHeader>

<!-- Hidden pickers: the visible controls are buttons, so the file inputs
     never need to be styled into the layout. -->
<input
  type="file"
  accept="application/json,.json"
  class="hidden"
  bind:this={docInput}
  onchange={onDocPicked}
/>
<input type="file" class="hidden" bind:this={byteFileInput} onchange={onBytesPicked} />

{#if seedError}
  <p
    class="mb-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
    {seedError}
  </p>
{/if}

{#if seeded}
  <!-- The empty result is the interesting one, and it is reported rather
       than hidden: it is what "idempotent" looks like from the outside. -->
  {#if seeded.length === 0}
    <p
      class="animate-fade-in mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[12px] text-t2"
      role="status"
    >
      <Icon name="check" size={13} class="shrink-0 text-t3" />
      Every built-in seed was already installed at its current version — nothing
      was written, and nothing of yours was touched.
    </p>
  {:else}
    <section class="card animate-slide-up mb-4 p-4" role="status">
      <h2 class="mb-1 flex items-center gap-1.5 text-[13px] font-semibold text-success">
        <Icon name="check-circle" size={14} />
        Installed {seeded.length}
        {plural(seeded.length, "seed pack", "seed packs")}
      </h2>
      <p class="mb-3 text-[11.5px] text-t3">
        Each one's region is shown as installed — a pack with no region is
        global.
      </p>
      <ul class="divide-y divide-line">
        {#each seeded as s (s.pack_id)}
          <li class="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 first:pt-0 last:pb-0">
            <span class="text-[12.5px] font-medium">{s.name}</span>
            <span class="num text-t2">v{s.version}</span>
            <Badge tone="neutral" dot={false} label={s.region ?? "global"} />
            <span class="num ml-auto text-[11.5px] text-t3">
              {s.categories_created} created · {s.categories_reused} adopted · {s.rules_installed}
              rules
            </span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

{#if showSeeds && book}
  {@const b = book}
  <section class="card animate-slide-up mb-4 p-4">
    <header class="mb-1 flex items-baseline justify-between gap-3">
      <h2 class="text-[13px] font-semibold">Install the built-in seed packs</h2>
      <button
        class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
        onclick={() => (showSeeds = false)}
      >
        <Icon name="x" size={12} />
        Close
      </button>
    </header>
    <p class="mb-3 max-w-3xl text-[11.5px] leading-relaxed text-t3">
      SlipScan embeds a small set of starter taxonomies — region-specific charts
      of accounts alongside a region-agnostic one. Seeding installs
      <span class="font-medium text-t2">all</span> of them, the region-specific
      ones included, which is exactly why nothing installs them for you: fitting
      one country's chart to a book kept somewhere else would be the wrong
      default. Their payloads ship inside this app, so nothing is fetched and
      there is no publisher key to check — the trust is in the binary you
      already run.
    </p>

    <!-- The region is the decision. Put this book's own profile in front of
         the user while they make it, rather than after. -->
    <p
      class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[12px] text-t2"
    >
      <Icon name="ledger" size={13} class="shrink-0 text-t3" />
      <span>This book uses the</span>
      <Badge tone="accent" dot={false} label="{b.region_name} · {b.currency}" />
      <span>
        region profile. Anything installed here that targets somewhere else is
        still yours to uninstall.
      </span>
    </p>

    <p class="mb-4 max-w-3xl text-[11.5px] leading-relaxed text-t3">
      Safe to run more than once. A seed already installed at the same version
      is skipped, and categories you already have are adopted by (parent, name)
      rather than duplicated — so this never clobbers a taxonomy you have
      already shaped. Rules are not applied retroactively, and your own
      corrections always win over a pack's.
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <button class="btn btn-primary" disabled={seeding} onclick={installSeeds}>
        <Icon name="package" size={14} />
        {seeding ? "Installing…" : "Install the built-in seeds"}
      </button>
      <span class="text-[11px] text-t3">
        Nothing is fetched, and nothing leaves this machine.
      </span>
    </div>
  </section>
{/if}

<!-- ---------------------------------------------------------------------
     Pack sources — the fetch half. A source is a place, never an authority:
     everything it hands over is verified before it is written, an unseen
     signer must be accepted by fingerprint, and a pack id stays pinned to
     the key that first signed it no matter what a source claims.
     ------------------------------------------------------------------- -->
{#if showSources}
  <section class="card animate-slide-up mb-4 p-4">
    <header class="mb-1 flex items-baseline justify-between gap-3">
      <h2 class="text-[13px] font-semibold">Where packs come from</h2>
      <button
        class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3"
        onclick={() => (showSources = false)}
      >
        <Icon name="x" size={12} />
        Close
      </button>
    </header>
    <p class="mb-4 max-w-3xl text-[11.5px] leading-relaxed text-t3">
      A source is a place to read packs from — a file, a folder your machine
      already syncs (or a USB stick you carry), a git remote, or an HTTPS base
      URL. The same signed bytes travel all of them, and they are checked the
      same way, because <span class="font-medium text-t2"
        >the signature is what is trusted, not the channel</span
      >. There is no registry and no default: nothing is contacted until you
      add a source here, and nothing installs until you say so.
    </p>

    {#if sourceError}
      <p
        class="mb-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
      >
        <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
        {sourceError}
      </p>
    {/if}

    {#if sources === null}
      <Skeleton rows={2} />
    {:else if sources.length === 0}
      <p
        class="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[12px] text-t2"
      >
        <Icon name="shield" size={13} class="shrink-0 text-t3" />
        No sources configured — SlipScan is making no outbound request about
        packs at all. That is the default, and it stays that way until you add
        one below.
      </p>
    {:else}
      <ul class="mb-4 divide-y divide-line rounded-lg border border-line">
        {#each sources as s (s.name)}
          <li class="flex flex-wrap items-start gap-3 px-3 py-2.5">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span class="text-[12.5px] font-medium">{s.name}</span>
                <Badge
                  tone="neutral"
                  dot={false}
                  label={sourceKindLabel[s.kind] ?? s.kind}
                />
                {#if s.network}
                  <Badge tone="warning" label="reaches the network" />
                {:else}
                  <Badge tone="success" label="local only" />
                {/if}
              </div>
              <p class="mt-1 truncate font-mono text-[10.5px] text-t3">{s.uri}</p>
              <p class="mt-1 text-[11px] text-t3">
                Added {fmtDate(s.added_at)} · {s.last_synced_at
                  ? `last read ${fmtRelative(s.last_synced_at)}`
                  : "never read"}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                class="btn h-7"
                disabled={fetching && openSource === s.name}
                onclick={() => fetchSource(s.name)}
              >
                <Icon name="search" size={13} />
                {fetching && openSource === s.name ? "Reading…" : "Read"}
              </button>
              <button
                class="btn btn-danger h-7"
                disabled={sourceBusy === s.name}
                onclick={() => removeSource(s.name)}
              >
                <Icon name="trash" size={13} />
                Forget
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <form class="grid gap-2 sm:grid-cols-[10rem_1fr_auto]" onsubmit={addSource}>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Name</span>
        <input
          class="input"
          placeholder="team"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          bind:value={newSourceName}
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2">Source URI</span>
        <input
          class="input font-mono text-[11.5px]"
          placeholder="folder:/Volumes/USB/packs"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          bind:value={newSourceUri}
        />
      </label>
      <div class="flex items-end">
        <button
          class="btn btn-primary h-8 w-full sm:w-auto"
          type="submit"
          disabled={addingSource || !newSourceName.trim() || !newSourceUri.trim()}
        >
          <Icon name="plus" size={13} />
          {addingSource ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
    <p class="mt-2 text-[11px] leading-relaxed text-t3">
      <span class="font-mono">file:</span>&lt;path&gt; ·
      <span class="font-mono">folder:</span>&lt;path&gt; ·
      <span class="font-mono">git:</span>&lt;url&gt;[#ref] ·
      <span class="font-mono">https://</span>&lt;url&gt;. Plain
      <span class="font-mono">http://</span> is refused: the signature would
      still protect the bytes, but a plaintext fetch tells the network which
      packs you run, and that is data about you. Adding a source contacts
      nothing — it is read when you press Read.
    </p>

    <!-- What the source offered, and what each would actually do. -->
    {#if openSource}
      <div class="mt-5 border-t border-line pt-4">
        <h3 class="mb-1 text-[12.5px] font-semibold">
          {openSource} offered
        </h3>
        <p class="mb-3 text-[11.5px] text-t3">
          Nothing has been installed. Every line below was verified against its
          own signature after it arrived — a catalogue's own description of a
          pack is a hint, and where the two disagree the pack is refused.
        </p>

        {#if offersError}
          <p
            class="mb-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
            {offersError}
          </p>
        {/if}
        {#if pullError}
          <p
            class="mb-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
            {pullError}
          </p>
        {/if}

        {#if offers === null}
          <Skeleton rows={3} />
        {:else if offers.length === 0 && !offersError}
          <p class="text-[12px] text-t3">This source offers no packs.</p>
        {:else}
          <ul class="divide-y divide-line rounded-lg border border-line">
            {#each offers as offer (offer.document)}
              <li class="px-3 py-3">
                {#if offer.verified}
                  {@const v = offer.verified}
                  {@const keyChanged =
                    v.pinned_fingerprint !== null &&
                    v.pinned_fingerprint !== v.signer_fingerprint}
                  <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
                    <div class="min-w-0">
                      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span class="text-[12.5px] font-medium">{v.name}</span>
                        <span class="num text-t2">v{v.version}</span>
                        <Badge
                          tone="neutral"
                          dot={false}
                          label={kindLabel[v.kind] ?? v.kind}
                        />
                        <Badge tone="neutral" dot={false} label={v.region ?? "global"} />
                      </div>
                      <p class="mt-1 font-mono text-[10.5px] text-t3">{v.pack_id}</p>
                    </div>
                    <Badge
                      tone={v.action === "refuse"
                        ? "danger"
                        : v.action === "upgrade"
                          ? "accent"
                          : "success"}
                      label={v.action === "refuse"
                        ? "refused"
                        : v.action === "upgrade"
                          ? `upgrade ${v.installed_version} → ${v.version}`
                          : "new install"}
                    />
                  </div>

                  <p
                    class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                  >
                    <span class="flex items-center gap-1.5 text-t3">
                      <Icon name="key" size={11} />
                      <span class="font-mono text-[12px]">{v.signer_fingerprint}</span>
                    </span>
                    {#if v.trusted_as}
                      <Badge tone="success" label="trusted as {v.trusted_as}" />
                    {:else}
                      <Badge tone="warning" label="never seen here" />
                    {/if}
                  </p>

                  {#if keyChanged}
                    <!-- The refusal this pin exists for. Nothing on this
                         screen can wave it through, and it does not pretend
                         otherwise. -->
                    <p
                      class="mt-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[11.5px] leading-relaxed text-danger"
                    >
                      <span class="font-semibold">
                        The publisher key for this pack changed.
                      </span>
                      <span class="font-mono">{v.pack_id}</span> is pinned to
                      <span class="font-mono">{v.pinned_fingerprint}</span> and this
                      copy is signed by
                      <span class="font-mono">{v.signer_fingerprint}</span>. A pack
                      id stays bound to the key that first signed it, so this will
                      not install — not from a source you trust, and not with any
                      option here.
                    </p>
                  {:else if v.refusal}
                    <p
                      class="mt-2 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 p-2.5 text-[11.5px] text-danger"
                    >
                      <Icon name="alert-circle" size={12} class="mt-0.5 shrink-0" />
                      {v.refusal}
                    </p>
                  {/if}

                  {#if v.action !== "refuse"}
                    {#if v.needs_signer_acceptance}
                      <!-- Trust-on-first-use, made into an actual decision.
                           The pack did not become trustworthy by arriving;
                           comparing the fingerprint is the entire content of
                           the word "trust" here. -->
                      <label
                        class="mt-2.5 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-[11.5px] leading-relaxed text-t2"
                      >
                        <input
                          type="checkbox"
                          class="mt-0.5 shrink-0"
                          checked={acceptedSigners[offer.document] === true}
                          onchange={(e) =>
                            (acceptedSigners = {
                              ...acceptedSigners,
                              [offer.document]: e.currentTarget.checked,
                            })}
                        />
                        <span>
                          I have compared
                          <span class="font-mono">{v.signer_fingerprint}</span>
                          against
                          {v.author ? `"${v.author}"'s` : "the publisher's"} own
                          channel. Installing records this key as trusted and pins
                          <span class="font-mono">{v.pack_id}</span> to it forever.
                        </span>
                      </label>
                    {/if}
                    <div class="mt-2.5 flex flex-wrap items-center gap-2">
                      <button
                        class="btn btn-primary h-7"
                        disabled={!canPull(offer) || pullBusy === offer.document}
                        onclick={() => pull(offer)}
                      >
                        <Icon name="download" size={13} />
                        {pullBusy === offer.document
                          ? "Installing…"
                          : v.action === "upgrade"
                            ? `Upgrade to ${v.version}`
                            : v.needs_signer_acceptance
                              ? "Accept signer & install"
                              : `Install ${v.version}`}
                      </button>
                      <span class="num text-[11px] text-t3">
                        {v.categories} categories · {v.merchant_rules} merchant · {v.keyword_rules}
                        keyword
                      </span>
                    </div>
                  {/if}
                {:else}
                  <!-- One unreadable file must not hide the rest of a shared
                       folder, and it must not be quietly dropped either. -->
                  <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span class="text-[12.5px] font-medium text-t2">
                      {offer.name ?? offer.pack_id}
                    </span>
                    <Badge tone="danger" label="not verified" />
                  </div>
                  <p class="mt-1 font-mono text-[10.5px] text-t3">{offer.document}</p>
                  <p class="mt-1 text-[11.5px] text-danger">{offer.error}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </section>
{/if}

{#if installed}
  <p
    class="animate-fade-in mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[12px] text-success"
    role="status"
  >
    <Icon name="check-circle" size={13} />
    <span class="font-medium">
      {installed.outcome === "upgraded"
        ? `Upgraded ${installed.name} ${installed.upgraded_from} → ${installed.version}`
        : `Installed ${installed.name} ${installed.version}`}
    </span>
    <span class="num">
      {installed.categories_created} categories created · {installed.categories_reused}
      reused · {installed.rules_installed} rules
    </span>
  </p>
  <p class="mb-4 text-[11px] text-t3">
    Rules are not applied retroactively: they classify transactions imported
    from here on, not the ones already in this book.
  </p>
{/if}

{#if showInstall}
  <section class="card animate-slide-up mb-4 p-4">
    <header class="mb-1 flex items-baseline justify-between gap-3">
      <h2 class="text-[13px] font-semibold">
        {upgradeFor ? `Upgrade ${upgradeFor}` : "Install a pack"}
      </h2>
      <button class="btn btn-ghost h-6 px-1.5 text-[11.5px] text-t3" onclick={closeInstall}>
        <Icon name="x" size={12} />
        Close
      </button>
    </header>
    <p class="mb-4 text-[11.5px] text-t3">
      A pack is distributed as three things: the signed document, its detached
      signature, and the publisher's public key. Signature and key are hex —
      paste them, or pick the raw file and it fills in.
    </p>

    {#if formError}
      <p
        class="mb-3 flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
      >
        <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
        {formError}
      </p>
    {/if}

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions --
         Escape-to-close only; interaction lives on the inputs/buttons. -->
    <form
      class="grid gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        void verify();
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") closeInstall();
      }}
    >
      <div class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Pack document — the exact signed bytes</span
        >
        <div class="flex flex-wrap items-center gap-2">
          <button class="btn h-8" type="button" onclick={() => docInput?.click()}>
            <Icon name="folder" size={13} />
            {docName ? "Choose another…" : "Choose file…"}
          </button>
          {#if docName}
            <span class="flex min-w-0 items-center gap-2 text-[12px]">
              <Icon name="package" size={13} class="shrink-0 text-t3" />
              <span class="truncate font-medium">{docName}</span>
              <span class="num shrink-0 text-t3">{fmtBytes(docSize)}</span>
            </span>
          {:else}
            <span class="text-[11.5px] text-t3">No file chosen</span>
          {/if}
        </div>
      </div>

      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Detached signature — 128 hex characters</span
        >
        <div class="flex items-center gap-2">
          <input
            class="input font-mono text-[11.5px]"
            placeholder="a1b2c3…"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            bind:value={signature}
            oninput={invalidate}
          />
          <button
            class="btn h-8 shrink-0"
            type="button"
            onclick={() => pickBytesFile("signature")}
          >
            From file…
          </button>
        </div>
      </label>

      <label class="block">
        <span class="mb-1 block text-[11.5px] font-medium text-t2"
          >Publisher public key — 64 hex characters</span
        >
        <div class="flex items-center gap-2">
          <input
            class="input font-mono text-[11.5px]"
            placeholder="7f3a…"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            bind:value={publicKey}
            oninput={invalidate}
          />
          <button
            class="btn h-8 shrink-0"
            type="button"
            onclick={() => pickBytesFile("public_key")}
          >
            From file…
          </button>
        </div>
      </label>

      <div class="flex flex-wrap items-center gap-2">
        <button class="btn btn-primary" type="submit" disabled={!ready || verifying}>
          <Icon name="shield" size={14} />
          {verifying ? "Verifying…" : "Verify"}
        </button>
        <span class="text-[11px] text-t3">
          Verifying writes nothing — it checks the signature and shows you who
          signed it.
        </span>
      </div>
    </form>

    {#if verification}
      {@const v = verification}
      {@const keyChanged =
        v.pinned_fingerprint !== null && v.pinned_fingerprint !== v.signer_fingerprint}
      <div
        class="mt-4 rounded-lg border p-4 {v.action === 'refuse'
          ? 'border-danger/30 bg-danger/5'
          : 'border-line bg-sunken/40'}"
      >
        <!-- The fingerprint is the whole trust decision, so it gets the
             typographic weight of one. -->
        <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="eyebrow mb-1">Signed by</p>
            <p class="font-mono text-[15px] tracking-tight break-all">
              {v.signer_fingerprint}
            </p>
            <p class="mt-1.5 text-[11.5px] text-t3">
              {#if v.trusted_as}
                Already trusted as <span class="font-medium text-t2"
                  >{v.trusted_as}</span
                >{v.author ? ` · pack declares author "${v.author}"` : ""}
              {:else}
                First use of this key. Compare this fingerprint against the
                publisher's own channel before you accept it — installing is
                what records the trust.
              {/if}
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-1.5">
            <Badge
              tone={v.action === "refuse"
                ? "danger"
                : v.action === "upgrade"
                  ? "accent"
                  : "success"}
              label={v.action === "refuse"
                ? "refused"
                : v.action === "upgrade"
                  ? `upgrade ${v.installed_version} → ${v.version}`
                  : "new install"}
            />
            <Badge tone="neutral" dot={false} label={kindLabel[v.kind] ?? v.kind} />
            <Badge tone="neutral" dot={false} label={v.region ?? "global"} />
          </div>
        </div>

        {#if keyChanged}
          <!-- Not a warning to click past: the installer will refuse, and
               this says why in the plainest terms available. -->
          <div
            class="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-3 text-[12px] text-danger"
          >
            <p class="flex items-center gap-1.5 font-semibold">
              <Icon name="alert-circle" size={13} />
              The publisher key for this pack changed
            </p>
            <p class="mt-1.5 leading-relaxed">
              <span class="font-mono">{v.pack_id}</span> is pinned to
              <span class="font-mono">{v.pinned_fingerprint}</span>, and this
              file is signed by <span class="font-mono">{v.signer_fingerprint}</span>.
              A pack id stays bound to the key that first signed it, so this
              will not install — not with a trusted key, and not with any
              option on this screen. If the publisher genuinely rotated their
              key, uninstall the pack and start the pack id over with the new
              one, having checked the new fingerprint out-of-band.
            </p>
          </div>
        {:else if v.action === "refuse" && v.refusal}
          <p
            class="mb-4 flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-[12px] text-danger"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
            {v.refusal}
          </p>
        {/if}

        {#if upgradeFor && upgradeFor !== v.pack_id}
          <p
            class="mb-4 flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/10 p-3 text-[12px] text-warning"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
            This file is <span class="font-mono">{v.pack_id}</span>, not
            <span class="font-mono">{upgradeFor}</span>. Installing it adds a
            second pack rather than upgrading that one.
          </p>
        {/if}

        <!-- Each pair carries its own hairline, so a label binds to the value
             on its own row rather than to the next column's label. -->
        <dl class="grid gap-x-8 text-[12.5px] sm:grid-cols-2">
          <div class="flex justify-between gap-3 border-b border-line py-1.5">
            <dt class="text-t3">Pack</dt>
            <dd class="min-w-0 truncate text-right font-medium">{v.name}</dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-line py-1.5">
            <dt class="text-t3">Id</dt>
            <dd class="min-w-0 truncate text-right font-mono text-[11.5px]">
              {v.pack_id}
            </dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-line py-1.5">
            <dt class="text-t3">Version</dt>
            <dd class="num">{v.version}</dd>
          </div>
          <div class="flex justify-between gap-3 border-b border-line py-1.5">
            <dt class="text-t3">Installed now</dt>
            <dd class="num">{v.installed_version ?? "—"}</dd>
          </div>
          <div class="flex justify-between gap-3 py-1.5">
            <dt class="text-t3">Categories</dt>
            <dd class="num">{v.categories}</dd>
          </div>
          <div class="flex justify-between gap-3 py-1.5">
            <dt class="text-t3">Rules</dt>
            <dd class="num">
              {v.merchant_rules} merchant · {v.keyword_rules} keyword
            </dd>
          </div>
        </dl>

        {#if v.action !== "refuse"}
          <div class="mt-4 flex flex-wrap items-center gap-2">
            <button class="btn btn-primary" disabled={installing} onclick={install}>
              <Icon name="check" size={14} />
              {installing
                ? "Installing…"
                : v.action === "upgrade"
                  ? `Upgrade to ${v.version}`
                  : v.trusted_as
                    ? `Install ${v.version}`
                    : "Trust this signer & install"}
            </button>
            {#if !v.trusted_as}
              <span class="text-[11px] text-t3">
                Installing records this key as trusted and pins
                <span class="font-mono">{v.pack_id}</span> to it.
              </span>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

{#if listError}
  <p
    class="mb-3 flex items-center gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
  >
    <Icon name="alert-circle" size={13} />
    {listError}
  </p>
{/if}

{#if loadError}
  <div class="card">
    <EmptyState icon="alert-circle" title="Could not load packs" body={loadError}>
      {#snippet actions()}
        <button class="btn" onclick={load}>Retry</button>
      {/snippet}
    </EmptyState>
  </div>
{:else if packs === null}
  <div class="card"><Skeleton rows={4} /></div>
{:else if packs.length === 0}
  <div class="card">
    <EmptyState
      icon="package"
      title="No packs installed"
      body="A pack teaches this book how to classify — a category taxonomy and the merchant rules that map onto it. Install one you have been given the signature and key for; your own corrections always win over a pack's rules."
    >
      {#snippet actions()}
        <button class="btn btn-primary" onclick={() => openInstall()}>
          <Icon name="upload" size={14} />
          Install a pack
        </button>
        <!-- The other honest starting point, and the one most people want
             first — still a choice, never a default. -->
        <button class="btn" onclick={toggleSeeds}>
          <Icon name="package" size={14} />
          Use the built-in seeds
        </button>
        <button class="btn" onclick={toggleSources}>
          <Icon name="folder" size={14} />
          Add a source
        </button>
      {/snippet}
    </EmptyState>
  </div>
{:else}
  <section class="card divide-y divide-line overflow-hidden">
    {#each packs as p (p.pack_id)}
      <div class="row-hover flex flex-wrap items-start gap-3 px-4 py-3.5">
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
        >
          <Icon name="package" size={15} />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="text-[13px] font-medium">{p.name}</span>
            <span class="num text-t2">v{p.version}</span>
            <Badge tone="neutral" dot={false} label={kindLabel[p.kind] ?? p.kind} />
            <Badge tone="neutral" dot={false} label={p.region ?? "global"} />
          </div>
          <p class="mt-1 truncate font-mono text-[10.5px] text-t3">{p.pack_id}</p>
          <p class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span class="flex items-center gap-1.5 text-t3">
              <Icon name="key" size={11} />
              <span class="font-mono">{p.signer_fingerprint}</span>
            </span>
            {#if p.signer_label}
              <Badge tone="success" label={p.signer_label} />
            {:else}
              <!-- Not an error: builtin and adopted packs are not trust-store
                   rows, and a revoked signer leaves its packs installed. -->
              <Badge tone="neutral" label="signer not in trust store" />
            {/if}
          </p>
          <p class="mt-1.5 text-[11px] text-t3">
            Installed {fmtDate(p.installed_at)}{p.updated_at !== p.installed_at
              ? ` · updated ${fmtRelative(p.updated_at)}`
              : ""}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <button class="btn h-7" onclick={() => openInstall(p.pack_id)}>
            <Icon name="upload" size={13} />
            Upgrade
          </button>
          <button
            class="btn btn-danger h-7"
            disabled={removeBusy === p.pack_id}
            onclick={() => {
              removeError = null;
              confirmUninstall = p;
            }}
          >
            <Icon name="trash" size={13} />
            Uninstall
          </button>
        </div>
      </div>
    {/each}
  </section>

  <p class="mt-3 text-[11px] leading-relaxed text-t3">
    Uninstalling removes a pack's rules and its registration. Categories it
    created are kept — they are ordinary local categories now, and your
    transactions still point at them — and the pack id stays pinned to its
    original signer, so no other key can take the id over later.
  </p>
{/if}

<p class="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-t3">
  <Icon name="shield" size={12} class="mt-0.5 shrink-0" />
  <span>
    SlipScan fetches packs only from sources you have added yourself — there is
    no registry and no default endpoint, so with no source configured nothing
    here touches a network. Verification, trust and installation happen on this
    machine either way, and nothing about your book is ever sent to a source.
  </span>
</p>

<!-- ---------------------------------------------------------------------
     Peer comparison — the read side of benchmark packs, computed here.
     `skipped` and `unmapped_keys` are rendered as what they are; neither is
     ever collapsed into a zero row.
     ------------------------------------------------------------------- -->
{#if !loadError}
<section class="mt-8">
  <header class="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
    <div class="min-w-0">
      <p class="eyebrow mb-1">Computed here · transmits nothing</p>
      <h2 class="text-[15px] font-semibold tracking-tight">Peer comparison</h2>
      <p class="mt-1.5 max-w-2xl text-[11.5px] leading-relaxed text-t3">
        Your own spend for one month, placed against the cohort statistics an
        installed benchmark pack publishes. The pack is a public file of
        aggregates; the comparison is arithmetic done on this machine against
        this book's spending report. Downloading a public file discloses
        nothing about your finances.
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <button
        class="btn h-7 w-7 justify-center px-0"
        aria-label="Previous month"
        onclick={() => shiftPeriod(-1)}
      >
        <Icon name="chevron-left" size={14} />
      </button>
      <span class="num w-32 text-center text-t2">{fmtMonth(period)}</span>
      <button
        class="btn h-7 w-7 justify-center px-0"
        aria-label="Next month"
        onclick={() => shiftPeriod(1)}
      >
        <Icon name="chevron-right" size={14} />
      </button>
    </div>
  </header>

  {#if benchmarkError}
    <div class="card">
      <EmptyState
        icon="alert-circle"
        title="Could not compare this month"
        body={benchmarkError}
      >
        {#snippet actions()}
          <button class="btn" onclick={loadBenchmarks}>Retry</button>
        {/snippet}
      </EmptyState>
    </div>
  {:else if benchmarks === null}
    <div class="card"><Skeleton rows={3} /></div>
  {:else if benchmarks.length === 0}
    <div class="card">
      <EmptyState
        icon="reports"
        title="No benchmark pack installed"
        body="A benchmark pack carries a cohort's published aggregates and nothing else — medians and quartiles for a region, a household size and an income band, each one standing on a stated minimum number of contributions. Install one the way you install any other pack and this month is compared against it locally."
      >
        {#snippet actions()}
          <button class="btn btn-primary" onclick={() => openInstall()}>
            <Icon name="upload" size={14} />
            Install a pack
          </button>
        {/snippet}
      </EmptyState>
      <p class="mx-auto max-w-lg px-6 pb-8 text-center text-[11px] leading-relaxed text-t3">
        SlipScan ships none. Publishing a benchmark pack needs contributors, and
        the contribution side is not built — see the note below.
      </p>
    </div>
  {:else}
    {#each benchmarks as r (r.pack_id)}
      <article class="card mb-3 p-4">
        <header class="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div class="min-w-0">
            <h3 class="text-[13px] font-medium">{r.pack_name}</h3>
            <p class="mt-1 truncate font-mono text-[10.5px] text-t3">{r.pack_id}</p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-1.5">
            <Badge
              tone="neutral"
              dot={false}
              label="{r.cohort.region} · household of {r.cohort
                .household_size} · band {r.cohort.income_band}"
            />
            <Badge tone="neutral" dot={false} label="k ≥ {r.k_floor}" />
            <Badge tone="neutral" dot={false} label={r.currency} />
          </div>
        </header>

        {#if r.skipped}
          <!-- No FX conversion is applied anywhere in this path, on purpose.
               A row of zeroes would read as "you spend nothing", which is not
               what is known — so the reason is shown instead of a number. -->
          <p
            class="flex items-start gap-1.5 rounded-lg border border-warning/25 bg-warning/10 p-3 text-[12px] leading-relaxed text-warning"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
            <span>
              <span class="font-semibold">Not compared.</span>
              {r.skipped}. Nothing here is estimated or converted, so this month
              has no figure for this pack rather than a zero.
            </span>
          </p>
        {:else if r.comparisons.length === 0}
          <p class="text-[12px] text-t3">
            This pack publishes no statistics for {fmtMonth(r.period)}.
          </p>
        {:else}
          <div class="table-wrap">
            <table class="w-full text-[12.5px]">
              <thead>
                <tr>
                  <th class="th">Category</th>
                  <th class="th w-44">Cohort range</th>
                  <th class="th text-right">Yours</th>
                  <th class="th text-right">Cohort median</th>
                  <th class="th text-right">Difference</th>
                  <th class="th text-right">Sample</th>
                </tr>
              </thead>
              <tbody>
                {#each r.comparisons as c (c.category_key)}
                  <!-- Each row is scaled to its own category: groceries and a
                       streaming subscription share no useful axis, and one
                       shared scale would flatten every small category to
                       nothing. Nothing is compared across rows. -->
                  {@const scale =
                    Math.max(c.p75_minor, c.yours_minor, c.median_minor, 1) * 1.15}
                  {@const at = (v: number) =>
                    Math.min(100, Math.max(0, (v / scale) * 100))}
                  <tr class="row-hover">
                    <td class="td">
                      <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span class="font-mono text-[11.5px]">{c.category_key}</span>
                        <Badge
                          tone="neutral"
                          dot={false}
                          label={placement[c.position] ?? c.position}
                        />
                      </span>
                    </td>
                    <td class="td">
                      <!-- Sunken track = the row's full range; the band is the
                           cohort's middle half, the tick its median, the dot
                           your month. The dot carries a 2px panel ring so it
                           stays legible where it overlaps the band. -->
                      <div
                        class="relative h-1.5 w-full min-w-28 rounded-full bg-sunken"
                        role="img"
                        aria-label="{c.category_key}: yours {fmtMoney(
                          c.yours_minor,
                          c.currency,
                        )}; cohort p25 {fmtMoney(
                          c.p25_minor,
                          c.currency,
                        )}, median {fmtMoney(
                          c.median_minor,
                          c.currency,
                        )}, p75 {fmtMoney(c.p75_minor, c.currency)}"
                      >
                        <div
                          class="absolute inset-y-0 rounded-full bg-line-2"
                          style="left: {at(c.p25_minor)}%; width: {Math.max(
                            1.5,
                            at(c.p75_minor) - at(c.p25_minor),
                          )}%"
                        ></div>
                        <div
                          class="absolute -inset-y-1 w-0.5 rounded-full bg-t2"
                          style="left: {at(c.median_minor)}%"
                        ></div>
                        <div
                          class="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel"
                          style="left: {at(
                            c.yours_minor,
                          )}%; background-color: var(--chart-1)"
                        ></div>
                      </div>
                    </td>
                    <td class="td text-right">
                      <Money amount={c.yours_minor} currency={c.currency} />
                    </td>
                    <td class="td text-right text-t2">
                      <Money amount={c.median_minor} currency={c.currency} />
                    </td>
                    <td class="td text-right">
                      <!-- Left uncoloured on purpose: spending more than the
                           cohort on medical care is not a failure and less is
                           not a win, so the sign is stated and not judged. -->
                      <Money
                        amount={c.delta_minor}
                        currency={c.currency}
                        signed
                        class="block"
                      />
                      <span class="axis-label">
                        {c.ratio_to_median === null
                          ? "cohort median is 0"
                          : `${c.ratio_to_median.toFixed(2)}× median`}
                      </span>
                    </td>
                    <td class="td num text-right text-t3">{c.sample_size}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="mt-2.5 text-[11px] leading-relaxed text-t3">
            The strip shows the cohort's middle half (p25–p75) as a band, its
            median as a tick, and your month as a dot. Every statistic here
            stands on at least {r.k_floor} contributions — that floor is the pack's
            own, and the sample column is the count behind each row.
          </p>
        {/if}

        {#if r.unmapped_keys.length > 0}
          <!-- Reported, never dropped: "why is there no groceries row?" has
               to have an answer, and "unmatched" is a different fact from
               "you spent nothing". -->
          <p
            class="mt-3 flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 p-3 text-[11.5px] leading-relaxed text-t2"
          >
            <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
            <span>
              <span class="font-medium">
                {r.unmapped_keys.length}
                {plural(r.unmapped_keys.length, "statistic", "statistics")} not matched.
              </span>
              This pack publishes
              {#each r.unmapped_keys as key, i (key)}<span class="font-mono"
                  >{key}</span
                >{i < r.unmapped_keys.length - 1 ? ", " : ""}{/each}, and no
              installed taxonomy pack maps
              {plural(r.unmapped_keys.length, "that key", "those keys")} onto a category
              in this book —
              {plural(r.unmapped_keys.length, "it is", "they are")} unmatched, not
              zero. Installing a taxonomy pack that declares
              {plural(r.unmapped_keys.length, "it", "them")} is what resolves this.
            </span>
          </p>
        {/if}
      </article>
    {/each}
  {/if}

  <!-- One <span> holds the whole sentence: the <p> is a flex row so the icon
       can hang, and a bare emphasis element inside it would become a second
       flex item and break the text flow around it. -->
  <p class="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-t3">
    <Icon name="shield" size={12} class="mt-0.5 shrink-0" />
    <span>
      Reading a benchmark pack transmits nothing — it is a public file, and the
      comparison happens here.
      <span class="font-medium text-t2"
        >Contributing your own figures is not implemented</span
      >, and neither is the local differential privacy that contributing would
      require: there is no code in SlipScan that can send a benchmark anywhere,
      so there is nothing here to opt out of.
    </span>
  </p>
</section>
{/if}

{#if confirmUninstall}
  {@const target = confirmUninstall}
  <ConfirmDialog
    open
    title="Uninstall {target.name}?"
    body="Its rules stop classifying and its registration goes. Categories it created stay — they are ordinary local categories now, and your transactions still point at them — and {target.pack_id} stays pinned to the signer that first claimed it, so no other key can take the id over later."
    confirmLabel="Uninstall pack"
    tone="danger"
    busy={removeBusy === target.pack_id}
    error={removeError}
    onconfirm={() => uninstall(target)}
    oncancel={() => {
      if (removeBusy) return;
      confirmUninstall = null;
      removeError = null;
    }}
  />
{/if}
