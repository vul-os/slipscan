<script lang="ts">
  /**
   * Devices tab: this device's identity, the peers it has pinned, and the
   * pairing ceremony (docs/NODES.md).
   *
   * Three things this screen has to keep straight, because all three are easy
   * to get wrong in a way that looks fine:
   *
   * * **NOTHING SYNCS.** Identity and pairing are real; there is no oplog, no
   *   transport, no coordinator and no endpoint. Pairing two devices proves
   *   who they are and then does nothing else. That sentence is on this screen
   *   in as many words, in every panel that could be read as promising
   *   otherwise, because a "paired" row with a green dot is exactly what a
   *   person reads as "my data is on both".
   *
   * * **The key-name comparison is the authentication.** The blobs are
   *   self-signed: a signature proves possession of the key *inside* the blob
   *   and nothing about who sent it, so an attacker who substitutes the whole
   *   blob produces one that verifies perfectly. What closes that gap is a
   *   person comparing nine words against the other device's screen. This
   *   screen therefore makes the user **type** the other device's key-name
   *   rather than offering a checkbox next to a name it printed itself. The
   *   IPC boundary also accepts `confirmed_by_human` — for a caller that
   *   genuinely displayed the name and got a yes — and this screen
   *   deliberately does not use it: a tick box beside a value we rendered is
   *   the rubber stamp the whole ceremony exists to avoid, and typing is what
   *   the CLI's `--expect-keyname` asks for too. Nothing here parses a blob to
   *   display what is in it either; core recomputes the key-name from the key
   *   and compares, so there is no second opinion to disagree with it.
   *
   * * **A pairing blob is a credential** until it is redeemed or expires — it
   *   carries the single-use claim token. It is shown, it can be copied, and
   *   it is dropped from state the moment the step it belongs to is over
   *   (`clearInvite` / `clearAcceptance`, and unmounting this tab). It is
   *   never logged and never interpolated into an error message.
   */
  import { tick } from "svelte";
  import { api } from "../../lib/api/client";
  import type {
    DeviceIdentity,
    DevicePeer,
    DeviceRotation,
    PairingInviteMeta,
  } from "../../lib/api/types";
  import { fmtDate, fmtRelative } from "../../lib/format";
  import Badge from "../../lib/components/Badge.svelte";
  import ConfirmDialog from "../../lib/components/ConfirmDialog.svelte";
  import EmptyState from "../../lib/components/EmptyState.svelte";
  import Icon from "../../lib/components/Icon.svelte";
  import Skeleton from "../../lib/components/Skeleton.svelte";

  let identity = $state<DeviceIdentity | null>(null);
  let peers = $state<DevicePeer[]>([]);
  let invites = $state<PairingInviteMeta[]>([]);
  let rotations = $state<DeviceRotation[]>([]);
  /** Null until the first load finishes — distinguishes "no identity yet"
   * (a real, expected state) from "not read yet". */
  let loaded = $state(false);
  /** A failed *read*. Kept apart from the empty state: "could not read device
   * state" must never look like "this device has no identity". */
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  let initLabel = $state("");
  let initBusy = $state(false);

  let rotateBusy = $state(false);
  let confirmRotate = $state(false);
  let confirmReset = $state(false);
  let resetBusy = $state(false);
  /** Peer awaiting a revoke / forget confirmation. */
  let confirmRevoke = $state<DevicePeer | null>(null);
  let confirmForget = $state<DevicePeer | null>(null);
  let peerBusy = $state<string | null>(null);

  // -- the ceremony -----------------------------------------------------------
  // Step 1 (this device invites) and step 2 (this device was invited) are two
  // separate panels on purpose: they happen on different machines, and one
  // combined "pair" form invites pasting the wrong blob into the wrong field.

  /** The invite this device just minted. `blob` is a credential — see above. */
  let invite = $state<{ id: string; blob: string; keyname: string; expires_at: string } | null>(
    null,
  );
  let inviteLabel = $state("");
  let inviteBusy = $state(false);

  /** Step 4: the acceptance blob that came back, plus the other device's
   * key-name as the user read it off that device's screen. */
  let confirmBlob = $state("");
  let confirmKeyname = $state("");
  let confirmPairBusy = $state(false);
  let confirmedPeer = $state<DevicePeer | null>(null);

  /** Step 2: an invite blob from another device, plus that device's key-name. */
  let acceptBlob = $state("");
  let acceptKeyname = $state("");
  let acceptBusy = $state(false);
  /** The acceptance to carry back. `blob` is a credential — it echoes the
   * claim token — so it is dropped as soon as the user says they are done. */
  let acceptance = $state<{ peer: DevicePeer; blob: string } | null>(null);

  let copied = $state<string | null>(null);
  let acceptBlobInput = $state<HTMLTextAreaElement | null>(null);

  async function load() {
    loadError = null;
    try {
      const [i, p, inv, r] = await Promise.all([
        api.deviceStatus(),
        api.deviceList(),
        api.deviceInviteList(),
        api.deviceRotations(),
      ]);
      identity = i;
      peers = p;
      invites = inv;
      rotations = r;
    } catch (err) {
      loadError = String(err);
    } finally {
      loaded = true;
    }
  }
  load();

  /** Re-read whenever an invite changes rather than on a timer: an invite's
   * remaining life is information, not an animation. */
  let nowIso = $state(new Date().toISOString());

  const active = $derived(peers.filter((p) => p.revoked_at === null));
  const revoked = $derived(peers.filter((p) => p.revoked_at !== null));
  const liveInvites = $derived(
    invites.filter((i) => i.redeemed_at === null && i.expires_at > nowIso),
  );

  function inviteState(i: PairingInviteMeta): {
    tone: "accent" | "neutral" | "success";
    label: string;
  } {
    if (i.redeemed_at) return { tone: "success", label: "redeemed" };
    if (i.expires_at <= nowIso) return { tone: "neutral", label: "expired" };
    return { tone: "accent", label: "open" };
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => (copied = null), 2000);
    } catch {
      // Clipboard denied (or unavailable outside a secure context). The blob
      // is on screen and selectable, which is the fallback — and this must
      // not report success it did not have.
      copied = null;
      actionError =
        "could not reach the clipboard — select the text and copy it manually";
    }
  }

  async function createIdentity() {
    actionError = null;
    initBusy = true;
    try {
      identity = await api.deviceInit({ label: initLabel.trim() || undefined });
      initLabel = "";
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      initBusy = false;
    }
  }

  async function rotate() {
    actionError = null;
    rotateBusy = true;
    try {
      const result = await api.deviceRotate();
      identity = result.identity;
      confirmRotate = false;
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      rotateBusy = false;
    }
  }

  async function reset() {
    actionError = null;
    resetBusy = true;
    try {
      await api.deviceReset({ confirm: true });
      confirmReset = false;
      clearInvite();
      clearAcceptance();
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      resetBusy = false;
    }
  }

  async function revokePeer(peer: DevicePeer) {
    actionError = null;
    peerBusy = peer.public_key;
    try {
      await api.deviceRevoke({ device_id: peer.public_key });
      confirmRevoke = null;
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      peerBusy = null;
    }
  }

  async function forgetPeer(peer: DevicePeer) {
    actionError = null;
    peerBusy = peer.public_key;
    try {
      await api.deviceForget({ device_id: peer.public_key });
      confirmForget = null;
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      peerBusy = null;
    }
  }

  async function createInvite() {
    actionError = null;
    inviteBusy = true;
    try {
      invite = await api.devicePairInvite({
        label: inviteLabel.trim() || undefined,
      });
      inviteLabel = "";
      nowIso = new Date().toISOString();
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      inviteBusy = false;
    }
  }

  /** Drop the invite blob from state — it is a credential, so it lives no
   * longer than it is needed. The step-2 form is deliberately untouched: the
   * answer may arrive long after the blob has been carried away. */
  function hideInvite() {
    invite = null;
  }

  /** The whole step is over (the pairing completed, or the invite was
   * withdrawn): drop the blob and whatever was typed against it. */
  function clearInvite() {
    invite = null;
    confirmBlob = "";
    confirmKeyname = "";
  }

  function clearAcceptance() {
    acceptance = null;
    acceptBlob = "";
    acceptKeyname = "";
  }

  async function withdrawInvite(id: string) {
    actionError = null;
    try {
      await api.deviceInviteCancel({ id });
      if (invite?.id === id) clearInvite();
      nowIso = new Date().toISOString();
      await load();
    } catch (err) {
      actionError = String(err);
    }
  }

  /** Step 2. The typed key-name is the authentication; it goes to core, which
   * recomputes the real one from the key in the blob and compares. */
  async function acceptInvite() {
    actionError = null;
    acceptBusy = true;
    try {
      acceptance = await api.devicePairAccept({
        blob: acceptBlob.trim(),
        expect_keyname: acceptKeyname.trim(),
      });
      acceptBlob = "";
      acceptKeyname = "";
      await load();
    } catch (err) {
      // Never echo the blob here — it is a credential, and it is also not the
      // useful part of any of these failures.
      actionError = String(err);
    } finally {
      acceptBusy = false;
    }
  }

  /** Step 4. Burns the invite's single-use claim token. */
  async function completePairing() {
    actionError = null;
    confirmPairBusy = true;
    try {
      confirmedPeer = await api.devicePairConfirm({
        blob: confirmBlob.trim(),
        expect_keyname: confirmKeyname.trim(),
      });
      clearInvite();
      nowIso = new Date().toISOString();
      await load();
    } catch (err) {
      actionError = String(err);
    } finally {
      confirmPairBusy = false;
    }
  }

  async function focusAcceptBlob() {
    await tick();
    acceptBlobInput?.focus();
  }
</script>

<div class="space-y-4">
  <!--
    The claim this whole screen has to lead with. Identity and pairing are
    built; a sync is not, and a paired device that looks like a sync is the
    most misleading thing this app could show.
  -->
  <p
    class="flex items-start gap-1.5 rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[11.5px] leading-relaxed text-t2"
  >
    <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0 text-t3" />
    <span>
      <span class="font-medium">Nothing syncs between devices yet.</span> What
      is built is identity and pairing: a device has a keypair, and pairing two
      of them establishes that this key and that key belong together. There is
      no replication log, no transport, no coordinator and no endpoint to
      configure — so pairing your laptop and your phone proves who they are and
      then does nothing else. Moving data today means moving the data folder
      (Data &amp; backup), or your own cloud syncing it.
    </span>
  </p>

  {#if actionError}
    <p
      class="flex items-start gap-1.5 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger"
      role="alert"
    >
      <Icon name="alert-circle" size={13} class="mt-0.5 shrink-0" />
      {actionError}
    </p>
  {/if}

  <!-- this device -->
  <section class="card p-4">
    <div class="mb-1 flex items-center justify-between">
      <h2 class="flex items-center gap-2 text-[13px] font-semibold">
        <Icon name="monitor" size={15} class="text-t3" />
        This device
      </h2>
      {#if identity}
        <div class="flex items-center gap-1.5">
          <button class="btn h-7" onclick={() => (confirmRotate = true)}>
            <Icon name="refresh" size={13} />
            Rotate key
          </button>
          <button class="btn btn-danger h-7" onclick={() => (confirmReset = true)}>
            <Icon name="trash" size={13} />
            Reset identity
          </button>
        </div>
      {/if}
    </div>
    <p class="mb-3 text-[12px] text-t3">
      There are no accounts here — no email, no password, no username, no login
      and no server that decides who you are. This device generated its own
      ed25519 keypair; the public half <em>is</em> its id, and the private half
      lives in the credential vault, write-only, under a key that never leaves
      this machine's keychain.
    </p>

    {#if !loaded}
      <Skeleton rows={3} />
    {:else if loadError}
      <EmptyState
        icon="alert-circle"
        title="Could not read this device's identity"
        body="This does not mean the device has none. {loadError}"
      >
        {#snippet actions()}
          <button class="btn" onclick={load}>Retry</button>
        {/snippet}
      </EmptyState>
    {:else if !identity}
      <EmptyState
        icon="monitor"
        title="This device has no identity yet"
        body="Creating one generates a keypair on this machine. Nothing is registered anywhere, nothing is contacted, and no data starts moving — an identity is only what a later pairing would be between."
      >
        {#snippet actions()}
          <form
            class="flex items-center gap-2"
            onsubmit={(e) => {
              e.preventDefault();
              createIdentity();
            }}
          >
            <input
              class="input w-48"
              placeholder="laptop"
              aria-label="Device label"
              bind:value={initLabel}
            />
            <button class="btn btn-primary" type="submit" disabled={initBusy}>
              {initBusy ? "Creating…" : "Create identity"}
            </button>
          </form>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="grid gap-3">
        <div class="flex items-center gap-3">
          <span
            class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
          >
            <Icon name="monitor" size={15} />
          </span>
          <span class="min-w-0 flex-1 leading-tight">
            <span class="block text-[12.5px] font-medium">{identity.label}</span>
            <span class="block truncate font-mono text-[10.5px] text-t3">
              created {fmtDate(identity.created_at)}
              {#if identity.rotated_at}· rotated {fmtDate(identity.rotated_at)}{/if}
            </span>
          </span>
        </div>

        <!--
          The key-name, given the room it needs. This is the value another
          person reads off this screen and compares against what their own
          device shows; a fingerprint nobody can actually compare protects
          nobody, which is why it is nine checksummed words rather than 64 hex
          characters.
        -->
        <div class="rounded-lg border border-line bg-sunken/40 p-3">
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-[11.5px] font-medium text-t2">
              This device's key-name
            </span>
            <button
              class="btn h-7"
              onclick={() => copy(identity!.keyname, "keyname")}
            >
              <Icon name="copy" size={13} />
              {copied === "keyname" ? "Copied" : "Copy"}
            </button>
          </div>
          <p class="font-mono text-[13px] break-words select-all">
            {identity.keyname}
          </p>
          <p class="mt-1.5 text-[11px] leading-relaxed text-t3">
            Read these nine words out to whoever is pairing with you, and have
            them check the same words appear on their screen. That comparison
            <span class="font-medium">is</span> the authentication: the pairing
            blobs are self-signed, so one that was swapped in flight verifies
            perfectly — only a person noticing the words differ catches it.
          </p>
          <p class="mt-2 truncate font-mono text-[10.5px] text-t3">
            device id {identity.public_key}
          </p>
        </div>
      </div>
    {/if}
  </section>

  <!-- paired devices -->
  {#if identity}
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="shield" size={15} class="text-t3" />
          Paired devices
        </h2>
        <span class="num text-[11px] text-t3">
          {active.length} paired{revoked.length
            ? ` · ${revoked.length} revoked`
            : ""}
        </span>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        A pin, and nothing more: this device knows that key and can prove the
        other end holds it. Nothing is connected — the timestamps below are
        when you paired, never when a device was last seen, because nothing
        checks.
      </p>

      {#if peers.length === 0}
        <EmptyState
          icon="shield"
          title="No paired devices"
          body="Pairing is a local, human-in-the-loop ceremony carried out of band: you move two short blobs between the machines yourself. SlipScan opens no socket to do it."
        />
      {:else}
        <ul class="divide-y divide-line">
          {#each peers as peer (peer.public_key)}
            <li class="row-hover py-2.5 first:pt-0 last:pb-0">
              <div class="flex items-center gap-3">
                <span
                  class="flex size-8 shrink-0 items-center justify-center rounded-md bg-sunken text-t3"
                >
                  <Icon name="monitor" size={15} />
                </span>
                <span class="min-w-0 flex-1 leading-tight">
                  <span
                    class="flex items-center gap-2 text-[12.5px] font-medium"
                  >
                    {peer.label}
                    {#if peer.revoked_at}
                      <Badge tone="danger" label="revoked" />
                    {/if}
                  </span>
                  <span class="block truncate font-mono text-[10.5px] text-t3">
                    {peer.keyname}
                  </span>
                  <span class="block truncate font-mono text-[10.5px] text-t3">
                    paired {fmtDate(peer.paired_at)}
                    {#if peer.revoked_at}· revoked {fmtDate(peer.revoked_at)}{/if}
                  </span>
                </span>
                <div class="flex shrink-0 items-center gap-1.5">
                  {#if peer.revoked_at}
                    <button
                      class="btn h-7"
                      disabled={peerBusy === peer.public_key}
                      onclick={() => (confirmForget = peer)}
                    >
                      <Icon name="trash" size={13} />
                      Forget
                    </button>
                  {:else}
                    <button
                      class="btn btn-danger h-7"
                      disabled={peerBusy === peer.public_key}
                      onclick={() => (confirmRevoke = peer)}
                    >
                      <Icon name="x" size={13} />
                      Revoke
                    </button>
                  {/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
        {#if revoked.length > 0}
          <p class="mt-3 text-[11px] leading-relaxed text-t3">
            A revoked device stays listed on purpose. The pin becomes a
            tombstone so that key cannot quietly pair again — a later attempt
            from it is refused rather than treated as a fresh introduction. Only
            forgetting it, deliberately and locally, clears the way back.
          </p>
        {/if}
      {/if}
    </section>

    <!-- the ceremony, step 1 + step 4: this device invites -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="key" size={15} class="text-t3" />
          Invite a device
        </h2>
        {#if liveInvites.length > 0}
          <Badge
            tone="accent"
            label="{liveInvites.length} open invite{liveInvites.length === 1
              ? ''
              : 's'}"
          />
        {/if}
      </div>
      <p class="mb-3 text-[12px] text-t3">
        Two hops, both carried by you: hand the invite to the other device, and
        bring its answer back. A QR photo, a paste into a chat, a file on a
        stick — whatever you like. There is no coordinator and no directory to
        route it through, which is exactly why there is nothing to configure.
      </p>

      {#if invite}
        <div class="mb-3 rounded-lg border border-accent-ring/40 bg-accent/5 p-3">
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-[11.5px] font-medium text-t2">
              Step 1 · carry this to the other device
            </span>
            <span class="num text-[11px] text-t3">
              expires {fmtRelative(invite.expires_at)}
            </span>
          </div>
          <!--
            Read-only, selectable, and never in a link or an error message: this
            text carries the invite's single-use claim token, so it is a
            credential until it is redeemed or expires.
          -->
          <textarea
            class="input w-full font-mono text-[11px]"
            rows="3"
            readonly
            aria-label="Pairing invite to carry to the other device"
            value={invite.blob}
          ></textarea>
          <p
            class="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-t3"
          >
            <Icon name="shield" size={12} class="mt-0.5 shrink-0" />
            <span>
              Treat this like a password until it is used: it contains a
              single-use claim token. It expires on its own, and you can
              withdraw it below.
            </span>
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <button class="btn h-7" onclick={() => copy(invite!.blob, "invite")}>
              <Icon name="copy" size={13} />
              {copied === "invite" ? "Copied" : "Copy invite"}
            </button>
            <button class="btn h-7" onclick={() => withdrawInvite(invite!.id)}>
              <Icon name="x" size={13} />
              Withdraw
            </button>
            <button class="btn btn-ghost h-7" onclick={hideInvite}>
              Hide
            </button>
          </div>
          <p class="mt-1.5 text-[11px] text-t3">
            Hiding it does not withdraw it — the invite stays open until it is
            redeemed or expires — but this text cannot be shown again. Copy it
            first.
          </p>
        </div>
      {:else}
        <form
          class="mb-3 flex flex-wrap items-center gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            createInvite();
          }}
        >
          <input
            class="input w-56"
            placeholder="what you are pairing (e.g. phone)"
            aria-label="Label for the device you expect to pair with"
            bind:value={inviteLabel}
          />
          <button class="btn btn-primary h-7" type="submit" disabled={inviteBusy}>
            <Icon name="plus" size={13} />
            {inviteBusy ? "Creating…" : "Create invite"}
          </button>
        </form>
      {/if}

      <!--
        Step 2 is a *sibling* of the blob, not a child of it, and that placement
        is load-bearing. The other device may take minutes — or a walk to
        another room — so this form has to survive hiding the blob and closing
        the app. Nested inside the `{#if invite}` block it was reachable only in
        the same session that minted the invite, which left a live invite in the
        database with no way in the UI to finish redeeming it.
      -->
      {#if invite || liveInvites.length > 0}
        <form
          class="mb-3 grid gap-2 rounded-lg border border-line bg-sunken/40 p-3"
          onsubmit={(e) => {
            e.preventDefault();
            completePairing();
          }}
        >
          <span class="text-[11.5px] font-medium text-t2">
            Step 2 · paste the answer that came back
          </span>
          <textarea
            class="input w-full font-mono text-[11px]"
            rows="3"
            placeholder="ss-pair1.… — the blob the other device produced"
            aria-label="Acceptance blob from the other device"
            bind:value={confirmBlob}
          ></textarea>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">
              The key-name shown on that device
            </span>
            <input
              class="input font-mono"
              placeholder="nine words, exactly as they appear there"
              bind:value={confirmKeyname}
            />
          </label>
          <p class="text-[11px] leading-relaxed text-t3">
            Type what you can see on the other screen. It is compared against the
            key inside the blob and a mismatch is refused — that comparison is
            the only thing standing between you and pairing whatever was
            substituted in transit. A name that fails its own checksum reports
            itself as mistyped, which is a different answer from "wrong device".
          </p>
          <div class="flex items-center gap-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={confirmPairBusy ||
                !confirmBlob.trim() ||
                !confirmKeyname.trim()}
            >
              {confirmPairBusy ? "Checking…" : "Compare and pair"}
            </button>
          </div>
        </form>
      {/if}

      {#if confirmedPeer}
        <p
          class="mb-3 flex items-start gap-1.5 rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[12px] leading-relaxed text-success"
          role="status"
        >
          <Icon name="check-circle" size={13} class="mt-0.5 shrink-0" />
          <span>
            Paired with {confirmedPeer.label} ({confirmedPeer.keyname}). Both
            devices now know each other's keys — and nothing else happens:
            there is no sync to start.
          </span>
        </p>
      {/if}

      {#if invites.length > 0}
        <h3 class="mb-1 text-[11.5px] font-medium text-t2">Invites minted</h3>
        <ul class="divide-y divide-line">
          {#each invites as i (i.id)}
            {@const status = inviteState(i)}
            <li class="row-hover flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span class="min-w-0 flex-1 leading-tight">
                <span class="flex items-center gap-2 text-[12px]">
                  {i.label}
                  <Badge tone={status.tone} label={status.label} />
                </span>
                <span class="block truncate font-mono text-[10.5px] text-t3">
                  created {fmtDate(i.created_at)} · expires {fmtDate(
                    i.expires_at,
                  )}
                  {#if i.redeemed_by}· redeemed by {i.redeemed_by.slice(0, 16)}…{/if}
                </span>
              </span>
              {#if !i.redeemed_at && i.expires_at > nowIso}
                <button
                  class="btn h-7 shrink-0"
                  onclick={() => withdrawInvite(i.id)}
                >
                  Withdraw
                </button>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-[11px] text-t3">
          Metadata only — an invite's claim token is never stored in the clear
          and is never shown again. Once it is redeemed it is burnt: invites are
          single-use, and replaying one is refused.
        </p>
      {/if}
    </section>

    <!-- the ceremony, step 2: this device was invited -->
    <section class="card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="inbox" size={15} class="text-t3" />
          A device invited you
        </h2>
      </div>
      <p class="mb-3 text-[12px] text-t3">
        The other side of the same ceremony. Paste the invite, check the
        key-name against that device's screen, and carry the answer back.
      </p>

      {#if acceptance}
        <div class="rounded-lg border border-accent-ring/40 bg-accent/5 p-3">
          <p class="mb-1 text-[11.5px] font-medium text-t2">
            {acceptance.peer.label} is pinned · carry this answer back
          </p>
          <textarea
            class="input w-full font-mono text-[11px]"
            rows="3"
            readonly
            aria-label="Acceptance blob to carry back to the inviting device"
            value={acceptance.blob}
          ></textarea>
          <p class="mt-1.5 text-[11px] leading-relaxed text-t3">
            The pairing is only finished when the inviting device redeems this.
            It echoes the invite's claim token, so treat it the same way — and
            once that device has it, this text is spent.
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              class="btn h-7"
              onclick={() => copy(acceptance!.blob, "acceptance")}
            >
              <Icon name="copy" size={13} />
              {copied === "acceptance" ? "Copied" : "Copy answer"}
            </button>
            <button class="btn btn-ghost h-7" onclick={clearAcceptance}>
              Done
            </button>
          </div>
        </div>
      {:else}
        <form
          class="grid gap-2"
          onsubmit={(e) => {
            e.preventDefault();
            acceptInvite();
          }}
        >
          <textarea
            class="input w-full font-mono text-[11px]"
            rows="3"
            placeholder="ss-pair1.… — the invite from the other device"
            aria-label="Pairing invite from the other device"
            bind:this={acceptBlobInput}
            bind:value={acceptBlob}
          ></textarea>
          <label class="block">
            <span class="mb-1 block text-[11.5px] font-medium text-t2">
              The key-name shown on that device
            </span>
            <input
              class="input font-mono"
              placeholder="nine words, exactly as they appear there"
              bind:value={acceptKeyname}
            />
          </label>
          <p class="text-[11px] leading-relaxed text-t3">
            Compared against the key in the blob before anything is pinned. If
            the words differ, the pairing is refused and nothing is written —
            which is the point: an invite substituted in transit signs itself
            perfectly well.
          </p>
          <div class="flex items-center gap-2">
            <button
              class="btn btn-primary h-7"
              type="submit"
              disabled={acceptBusy || !acceptBlob.trim() || !acceptKeyname.trim()}
            >
              {acceptBusy ? "Checking…" : "Compare and pair"}
            </button>
            <button
              class="btn btn-ghost h-7"
              type="button"
              onclick={focusAcceptBlob}
            >
              Paste invite
            </button>
          </div>
        </form>
      {/if}
    </section>

    {#if rotations.length > 0}
      <section class="card p-4">
        <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="refresh" size={15} class="text-t3" />
          Key rotations
        </h2>
        <p class="mb-3 text-[12px] text-t3">
          Each rotation is signed by the key it replaced, so the chain proves
          itself. Rotating changes this device's id, which means peers' pins of
          <em>this</em> device go stale — and nothing re-pairs them for you,
          because there is no transport to do it over.
        </p>
        <ul class="divide-y divide-line">
          {#each rotations as r (r.signature)}
            <li class="py-2 first:pt-0 last:pb-0">
              <span class="block font-mono text-[10.5px] text-t3">
                {fmtDate(r.rotated_at)} · {r.old_public_key.slice(0, 12)}… →
                {r.new_public_key.slice(0, 12)}…
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

{#if confirmRotate}
  <ConfirmDialog
    open
    title="Rotate this device's key?"
    body="A new keypair is generated and signed by the current one, so the change is provable. This device's id changes: every device you have paired with still holds the old key and will not recognise the new one until you pair again. Nothing is notified — there is no transport to notify over."
    confirmLabel="Rotate key"
    busy={rotateBusy}
    error={actionError}
    onconfirm={rotate}
    oncancel={() => {
      if (rotateBusy) return;
      confirmRotate = false;
      actionError = null;
    }}
  />
{/if}

{#if confirmReset && identity}
  {@const target = identity}
  <ConfirmDialog
    open
    title="Reset this device's identity?"
    body="The private key is destroyed. It cannot be recovered from a backup of your data folder, because the key that decrypts the vault never leaves this machine's keychain — this device becomes a stranger to every device it was paired with. Your pins of those devices are kept; forget them one at a time if you want them gone."
    confirmLabel="Destroy this identity"
    confirmPhrase={target.label}
    tone="danger"
    busy={resetBusy}
    error={actionError}
    onconfirm={reset}
    oncancel={() => {
      if (resetBusy) return;
      confirmReset = false;
      actionError = null;
    }}
  />
{/if}

{#if confirmRevoke}
  {@const target = confirmRevoke}
  <ConfirmDialog
    open
    title="Revoke {target.label}?"
    body="The pin becomes a tombstone rather than disappearing, so that key cannot quietly pair again — an attempt from it is refused instead of being taken as a new introduction. You can still forget it afterwards, deliberately, which is the only way back."
    confirmLabel="Revoke device"
    tone="danger"
    busy={peerBusy === target.public_key}
    error={actionError}
    onconfirm={() => revokePeer(target)}
    oncancel={() => {
      if (peerBusy) return;
      confirmRevoke = null;
      actionError = null;
    }}
  />
{/if}

{#if confirmForget}
  {@const target = confirmForget}
  <ConfirmDialog
    open
    title="Forget {target.label}?"
    body="The pin is removed outright, tombstone included, so this key may pair with you again from scratch. That is the whole effect: forgetting is how a revocation is undone, and it is deliberately local — no message from anywhere can reach it."
    confirmLabel="Forget device"
    tone="danger"
    confirmPhrase={target.label}
    busy={peerBusy === target.public_key}
    error={actionError}
    onconfirm={() => forgetPeer(target)}
    oncancel={() => {
      if (peerBusy) return;
      confirmForget = null;
      actionError = null;
    }}
  />
{/if}
