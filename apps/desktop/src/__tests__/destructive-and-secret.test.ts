/**
 * The screens that can destroy something, and the one screen that shows a
 * secret.
 *
 * Payments, Packs, Household and the Settings tabs hold every irreversible
 * action in the product — remove a watch code, remove an endpoint, rotate a
 * signing secret, uninstall a pack, remove a member, revoke a credential —
 * plus the only place a secret is ever displayed. Those two facts are what
 * this file exists for, because both fail *silently*:
 *
 * * A confirm prompt that quietly stops being wired still renders a button
 *   that works. The screen looks identical; the safety is gone. So the tests
 *   below assert the negative — that the first click did **not** perform the
 *   action — rather than that a dialog appeared.
 * * A "shown exactly once" secret is only shown once if nothing can make it
 *   go away by accident. Escape, a scrim click and a stray Tab all had to be
 *   closed off deliberately, and any of them could be reopened by a one-line
 *   change to a shared component.
 *
 * The honesty caveats are pinned here for the same reason. "No bank patterns
 * ship", "nothing syncs between devices" and "retrying stops at the cap" are
 * load-bearing claims about what the product does; editing one is two words
 * that no type-check or build would notice. Pinning cuts both ways — the
 * bank-alert assertion in this file had to be *inverted* when `mail-sync
 * --alerts` shipped, because a caveat left stale in the pessimistic direction
 * hides a feature the user has.
 *
 * Devices adds a third kind of guard: the pairing screen's key-name field is
 * the entire authentication step of the ceremony, so a test asserts a pairing
 * cannot be completed without it and that the screen never claims a human
 * confirmed a comparison it did not ask for.
 *
 * Time is frozen inside the mock's July 2026 window, matching render-smoke.
 *
 * NOTE: the mock dataset is module state shared with the other suites, so
 * everything here either cancels out of the destructive path or performs an
 * operation the mock does not mutate (rotation returns a fresh secret and
 * changes nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import Household from "../routes/Household.svelte";
import Packs from "../routes/Packs.svelte";
import Payments from "../routes/Payments.svelte";
import Settings from "../routes/Settings.svelte";
import Vault from "../routes/settings/Vault.svelte";
import {
  mockApi,
  mockForeignAcceptance,
  mockForeignInvite,
} from "../lib/api/mock";

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

let fatal: string[] = [];
let consoleError: MockInstance<typeof console.error>;

function onError(e: ErrorEvent) {
  fatal.push(`window.error: ${e.message}`);
}
function onRejection(e: PromiseRejectionEvent) {
  fatal.push(`unhandledrejection: ${String(e.reason)}`);
}

beforeEach(() => {
  fatal = [];
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  consoleError = vi.spyOn(console, "error").mockImplementation((...args) => {
    fatal.push(`console.error: ${args.map(String).join(" ")}`);
  });
});

afterEach(() => {
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  consoleError.mockRestore();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Drive the event loop until the screen stops changing (see render-smoke). */
async function settle(target: HTMLElement): Promise<void> {
  let previous = "";
  let stable = 0;
  for (let turn = 0; turn < 250; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const busy = target.querySelector('[aria-busy="true"]') !== null;
    const body = target.textContent ?? "";
    stable = !busy && body.length > 0 && body === previous ? stable + 1 : 0;
    previous = body;
    if (stable >= 3) return;
  }
  throw new Error("screen never settled after 250 turns");
}

function text(target: HTMLElement): string {
  return (target.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Accessible name of a control, the way a keyboard user reaches it. */
function nameOf(el: Element): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function buttons(target: HTMLElement, label: string): HTMLButtonElement[] {
  return [...target.querySelectorAll("button")].filter((b) =>
    nameOf(b).includes(label),
  );
}

/** The one button whose accessible name contains `label`. */
function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(target, label);
  if (found.length !== 1)
    throw new Error(
      `expected exactly one button containing ${JSON.stringify(label)}, found ` +
        `${found.length}: ${found.map(nameOf).join(" / ")}`,
    );
  return found[0]!;
}

const dialog = (target: HTMLElement): HTMLElement | null =>
  target.querySelector<HTMLElement>('[role="dialog"]');

function render(component: Component): {
  target: HTMLElement;
  dispose: () => void;
} {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target });
  return {
    target,
    dispose: () => {
      void unmount(instance);
      target.remove();
    },
  };
}

/** Press a key on an element the way a user would — it has to bubble to reach
 * the handler, which lives on the scrim rather than on the panel. */
function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flushSync();
}

// ---------------------------------------------------------------------------
// Payments — the caveats
// ---------------------------------------------------------------------------

describe("payments · what it claims about itself", () => {
  /**
   * This assertion changed direction, which is the interesting part.
   *
   * It used to pin "reading a payment out of a bank-alert email is not
   * implemented". That became false: `slipscan mail-sync --alerts --account …`
   * parses alert mail into statement lines and pushes them through
   * `import_statement_lines` → `transaction_create`, which is where payment
   * detection lives — so a parsed alert genuinely can fire a watch. Leaving
   * the old wording would have been a stale claim in the *pessimistic*
   * direction, which is a defect too: it sends a user looking for a feature
   * they already have.
   *
   * The honest caveat moved rather than disappearing, so this now pins the new
   * one: no bank patterns ship, and nothing is parsed without a `mailrules`
   * pack.
   */
  it("names the three sources of detections, and what gates the newest one", async () => {
    const { target, dispose } = render(Payments as Component);
    try {
      await settle(target);
      const rendered = text(target);

      // The set, stated. "Any source" alone would still mislead.
      expect(rendered).toContain(
        "statement imports, entries you make yourself, and bank-alert emails",
      );
      // The condition on the newest one is a missing pack, not missing code.
      expect(rendered).toContain("no bank patterns ship");
      expect(rendered).toMatch(/mailrules/);

      // The old, now-false claim must not come back.
      expect(rendered).not.toMatch(/bank-alert email is not implemented/i);
      expect(rendered).not.toMatch(/only ever captured as a document/i);

      // Nor may the overstatement that predated *that*: pointing at a settings
      // tab as the thing that makes email trigger a watch skips the pack.
      expect(rendered).not.toContain("email-ingested");
      expect(rendered).not.toMatch(/bank alerts first/i);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("states the attempt cap and that a failed delivery is final", async () => {
    const { target, dispose } = render(Payments as Component);
    try {
      await settle(target);
      const rendered = text(target);

      // core's MAX_DELIVERY_ATTEMPTS. "Retries until the receiver answers"
      // would be a promise the queue does not keep.
      expect(rendered).toContain("Retrying stops after 20 attempts");
      expect(rendered).toContain("nothing re-queues it");

      // The live queue still reads honestly: the mock's second delivery has
      // failed three times and is waiting on a fourth.
      expect(rendered).toContain("3 attempts");
      expect(rendered).toContain("next retry");
      expect(rendered).toContain("HTTP 503");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Payments — rotation and the one-time reveal
// ---------------------------------------------------------------------------

describe("payments · rotating a signing secret", () => {
  it("asks before destroying the old secret, and cancelling rotates nothing", async () => {
    const { target, dispose } = render(Payments as Component);
    try {
      await settle(target);
      expect(dialog(target)).toBeNull();

      buttons(target, "Rotate secret")[0]!.click();
      // Dialog moves focus on a microtask (tick), so let it land before the
      // focus assertion below — flushSync alone only runs the render.
      await settle(target);

      // The first click is a question, not the act.
      const prompt = dialog(target);
      expect(prompt, "rotate no longer confirms").not.toBeNull();
      expect(text(prompt!)).toContain("Rotate the secret for");
      // Named as the destruction it is.
      expect(nameOf(button(target, "Rotate & destroy the old"))).toBeTruthy();
      // Nothing has been revealed, so nothing has been rotated.
      expect(text(target)).not.toMatch(/[0-9a-f]{64}/);

      // Danger prompts focus Cancel: a stray Enter must not destroy a key.
      expect(nameOf(document.activeElement!)).toBe("Cancel");

      press(prompt!, "Escape");
      expect(dialog(target)).toBeNull();
      expect(text(target)).not.toMatch(/[0-9a-f]{64}/);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("shows the new secret once, in a modal that refuses to be waved away", async () => {
    const { target, dispose } = render(Payments as Component);
    try {
      await settle(target);

      buttons(target, "Rotate secret")[0]!.click();
      await settle(target);
      button(target, "Rotate & destroy the old").click();
      await settle(target);

      const reveal = dialog(target);
      expect(reveal, "the rotated secret was never displayed").not.toBeNull();
      expect(text(reveal!)).toContain("shown once");

      // The whole secret, never truncated: copying it by hand has to stay
      // possible when the clipboard is unavailable.
      const code = reveal!.querySelector("code")!;
      const secret = code.textContent!.trim();
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      // The two accidents that would cost the user a secret they can never
      // get back. Neither may close this.
      press(reveal!, "Escape");
      expect(dialog(target), "Escape discarded a one-time secret").not.toBeNull();

      const scrim = target.querySelector<HTMLElement>(".scrim-hit")!;
      scrim.click();
      flushSync();
      expect(dialog(target), "a scrim click discarded a one-time secret")
        .not.toBeNull();
      // The scrim still names itself honestly rather than claiming to close.
      expect(nameOf(scrim)).toContain("must be answered");

      // Only the acknowledgement does — and afterwards the secret is gone
      // from the screen entirely, not merely hidden behind a toggle.
      button(target, "Done — I've stored it").click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).not.toContain(secret);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

describe("payments · removing a watch code", () => {
  it("names the cascade instead of implying the history survives", async () => {
    const { target, dispose } = render(Payments as Component);
    try {
      await settle(target);

      // RENT-12B, the watch with a recorded match in the mock.
      buttons(target, "Remove")[0]!.click();
      await settle(target);

      const prompt = dialog(target)!;
      expect(text(prompt)).toContain("Stop watching RENT-12B?");
      // pay_matches cascades from pay_watch_codes and pay_deliveries cascades
      // from pay_matches (migration 0005_shapepay), so the match and its
      // delivery go too. A prompt that said the history was kept would be
      // describing a different schema.
      expect(text(prompt)).toContain("This also deletes what it has already matched");
      expect(text(prompt)).toContain("1 match");
      // And the non-destructive alternative is offered rather than hidden.
      expect(text(prompt)).toContain("pause it instead");

      press(prompt, "Escape");
      await settle(target);
      expect(text(target)).toContain("RENT-12B");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Packs — uninstall
// ---------------------------------------------------------------------------

describe("packs · uninstalling", () => {
  it("asks first, and the pack survives a cancelled prompt", async () => {
    const { target, dispose } = render(Packs as Component);
    try {
      await settle(target);
      expect(text(target)).toContain("za-retail-base");

      // Several packs are installed in the mock; the first row is enough —
      // the property is that the click asks rather than acts.
      buttons(target, "Uninstall")[0]!.click();
      await settle(target);

      const prompt = dialog(target);
      expect(prompt, "uninstall no longer confirms").not.toBeNull();
      // The prompt carries the two facts that make the decision informed.
      expect(text(prompt!)).toContain("Categories it created stay");
      expect(text(prompt!)).toContain("stays pinned to the signer");

      press(prompt!, "Escape");
      await settle(target);
      expect(dialog(target)).toBeNull();
      // Still installed: the first click asked, it did not act.
      expect(text(target)).toContain("za-retail-base");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Household — members are local rows, and removing one asks first
// ---------------------------------------------------------------------------

describe("household · removing a member", () => {
  it("asks first, and is clear that no transaction is touched", async () => {
    const { target, dispose } = render(Household as Component);
    try {
      await settle(target);
      expect(text(target)).toContain("Alex");

      buttons(target, "Remove")[0]!.click();
      await settle(target);

      const prompt = dialog(target);
      expect(prompt, "member removal no longer confirms").not.toBeNull();
      // Attribution is metadata; the prompt has to say so, because "remove
      // the person who paid for this" reads like it deletes the spending.
      expect(text(prompt!)).toContain("No transaction is deleted or changed");
      expect(text(prompt!)).toContain("offers to move that history");
      expect(nameOf(document.activeElement!)).toBe("Cancel");

      press(prompt!, "Escape");
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("Alex");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("never implies a member is an account, a login or an invite", async () => {
    const { target, dispose } = render(Household as Component);
    try {
      await settle(target);
      const rendered = text(target);

      // SlipScan has no authentication at all. A member describes whose money
      // a transaction is, never who may open the book — so any copy borrowed
      // from a multi-user product is a claim the software cannot honour.
      expect(rendered).not.toMatch(
        /invite|sign in|log in|password|permission|email address|account for/i,
      );
      expect(rendered).toContain("no accounts, no logins, nothing hosted");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Vault — write-only, and revocation
// ---------------------------------------------------------------------------

describe("settings · the vault is write-only", () => {
  it("offers no way to read a secret back, and says so", async () => {
    const { target, dispose } = render(Vault as Component);
    try {
      await settle(target);

      // The property, stated — a list of things that will not open reads as
      // a broken screen unless the screen explains itself.
      expect(text(target)).toContain("There is no way to read a secret back");

      // And no control that implies otherwise. This is the assertion that
      // would catch a well-meaning "just let them peek" patch.
      for (const control of target.querySelectorAll("button, a")) {
        expect(
          nameOf(control),
          `a control offers to reveal a secret: ${nameOf(control)}`,
        ).not.toMatch(/reveal|show secret|view secret|copy secret|unmask/i);
      }

      // Secret entry is a password field, so it is not shoulder-readable
      // and never lands in an autofill store.
      button(target, "Add credential").click();
      await settle(target);
      const secretField = [...target.querySelectorAll("input")].find((i) =>
        (i.placeholder ?? "").includes("paste"),
      )!;
      expect(secretField.type).toBe("password");
      expect(secretField.autocomplete).toBe("off");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("makes revoking type-to-confirm, and holds the button until it matches", async () => {
    const { target, dispose } = render(Vault as Component);
    try {
      await settle(target);
      expect(text(target)).toContain("imap.password.fastmail");

      buttons(target, "Revoke")[0]!.click();
      flushSync();

      const prompt = dialog(target)!;
      expect(prompt).not.toBeNull();
      // The exact entry name has to be typed — this is the one action on
      // these screens where nothing can bring the secret back.
      expect(text(prompt)).toContain("imap.password.fastmail");

      const confirmBtn = button(target, "Revoke credential");
      expect(confirmBtn.disabled, "revoke was live before the phrase matched")
        .toBe(true);

      const field = prompt.querySelector<HTMLInputElement>("[data-autofocus]")!;
      field.value = "imap.password.wrong";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(button(target, "Revoke credential").disabled).toBe(true);
      expect(field.getAttribute("aria-invalid")).toBe("true");

      field.value = "imap.password.fastmail";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
      expect(button(target, "Revoke credential").disabled).toBe(false);

      // Cancelled rather than confirmed: the mock dataset is shared, and the
      // property under test is the gate, not the deletion.
      press(prompt, "Escape");
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("imap.password.fastmail");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Connections — no fabricated egress
// ---------------------------------------------------------------------------

describe("settings · connections shows only egress that can exist", () => {
  it("does not render bank connections the product cannot make", async () => {
    const { target, dispose } = render(Settings as Component);
    try {
      await settle(target);
      button(target, "Connections").click();
      await settle(target);
      const rendered = text(target);

      expect(rendered).toContain("Bank connections");
      expect(rendered).toContain("not implemented");

      // `settings.scrapers` has no writer on any surface, so the only way
      // these names could appear is the old list branch rendering mock data
      // as though the user had connected two real banks.
      expect(rendered).not.toContain("Discovery Bank");
      expect(rendered).not.toContain("za-fnb");
      expect(rendered).not.toContain("needs re-auth");

      // The egress Payments owns is accounted for rather than omitted.
      expect(rendered).toContain("Webhook endpoints");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Connections — bank-alert emails: an engine that ships, and formats that
// do not
// ---------------------------------------------------------------------------

describe("settings · bank-alert emails are honest about the missing half", () => {
  it("states that no bank patterns ship and points at the pack that fixes it", async () => {
    const { target, dispose } = render(Settings as Component);
    try {
      await settle(target);
      button(target, "Connections").click();
      await settle(target);
      const rendered = text(target);

      // The whole content of this panel. `mail-sync --alerts` works; the
      // formats are packs, and SlipScan ships none — so announcing "bank
      // alerts supported" without this sentence would be the overstatement.
      expect(rendered).toContain("Bank-alert emails");
      expect(rendered).toContain("No bank patterns ship with SlipScan");
      expect(rendered).toContain("this does nothing at all");
      expect(rendered).toContain("No mailrules pack for your bank");

      // The exact command, with an account in it — the CLI requires one
      // because alerts have to be booked somewhere and guessing the card is
      // the one thing this pipeline refuses to do.
      expect(rendered).toContain("slipscan mail-sync --alerts --account");

      // Multi-account routing exists in the library and nothing calls it.
      // Implying otherwise would invent a feature.
      expect(rendered).toContain("One account per run");
      expect(rendered).toContain("not wired to anything");

      // And the mailbox fields above are not the sync's config, which is the
      // claim the old wording made.
      expect(rendered).toContain("mail.imap.config");
      expect(rendered).toContain("nothing consumes it yet");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("lists installed mailrules packs instead of the empty state", async () => {
    // The other branch. The mock book has no mailrules pack — which is the
    // true state of every install — so the populated path is only reachable
    // by standing one in.
    const withPack = vi.spyOn(mockApi, "pack_list").mockResolvedValue([
      {
        pack_id: "meridian-alerts",
        book_id: "b1",
        name: "Meridian Bank card alerts",
        version: "1.2.0",
        kind: "mailrules",
        region: null,
        signer_fingerprint: "9a1c-4d02-77bf-e310",
        signer_label: "A Community Publisher",
        installed_at: "2026-07-10T09:00:00Z",
        updated_at: "2026-07-10T09:00:00Z",
      },
    ]);
    try {
      const { target, dispose } = render(Settings as Component);
      try {
        await settle(target);
        button(target, "Connections").click();
        await settle(target);
        const rendered = text(target);

        expect(rendered).toContain("1 mailrules pack");
        expect(rendered).toContain("Meridian Bank card alerts");
        // The signer is shown: which key vouched for a rule that will create
        // transactions is not a detail.
        expect(rendered).toContain("9a1c-4d02-77bf-e310");
        expect(rendered).not.toContain("No mailrules pack for your bank");

        // The caveat that survives having a pack: the desktop still does not
        // poll, so the command is still the surface.
        expect(rendered).toContain("slipscan mail-sync --alerts --account");
        expect(fatal, fatal.join(" | ")).toEqual([]);
      } finally {
        dispose();
      }
    } finally {
      withPack.mockRestore();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Devices — the pairing ceremony, and the three destructive actions
//
// Everything in this block guards a property that fails silently. A key-name
// field that stops being required still renders; a confirm prompt that comes
// unwired still shows a button that works; a blob left in component state
// still looks fine on screen.
// ---------------------------------------------------------------------------

/** Open Settings on the Devices tab. */
async function devicesTab(): Promise<{
  target: HTMLElement;
  dispose: () => void;
}> {
  const handle = render(Settings as Component);
  await settle(handle.target);
  button(handle.target, "Devices").click();
  await settle(handle.target);
  return handle;
}

const field = (target: HTMLElement, label: string): HTMLInputElement =>
  [...target.querySelectorAll("input")].find((i) =>
    (i.getAttribute("aria-label") ??
      i.closest("label")?.textContent ??
      "").includes(label),
  )!;

const area = (target: HTMLElement, label: string): HTMLTextAreaElement =>
  [...target.querySelectorAll("textarea")].find((t) =>
    (t.getAttribute("aria-label") ?? "").includes(label),
  )!;

function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

describe("settings · devices — the key-name comparison is not optional", () => {
  /**
   * **The one that matters.** The pairing blobs are self-signed: a signature
   * proves possession of the key *inside* the blob and nothing about who sent
   * it, so an attacker who substitutes the whole blob produces one that
   * verifies perfectly. A person comparing nine words against the other
   * device's screen is the entire authentication step.
   *
   * So the screen must not let a pairing through without it, and it must not
   * offer a tick box beside a key-name it printed itself — that is a rubber
   * stamp, and `confirmed_by_human` exists for callers that genuinely asked a
   * human, not as a shortcut past asking.
   */
  it("will not pair without a typed key-name, and never claims a human confirmed one", async () => {
    const spy = vi.spyOn(mockApi, "device_pair_accept");
    const { target, dispose } = await devicesTab();
    try {
      const incoming = mockForeignInvite("phone");

      // A blob alone does not enable the action: the comparison is required.
      fill(area(target, "Pairing invite from the other device"), incoming.blob);
      await settle(target);
      const pair = buttons(target, "Compare and pair").at(-1)!;
      expect(
        pair.disabled,
        "a pairing with no key-name typed must not be actionable",
      ).toBe(true);

      // Typing the *wrong* key-name is refused, and nothing is pinned.
      const before = (await mockApi.device_list()).length;
      const wrong = mockForeignInvite("someone else");
      fill(field(target, "key-name shown on that device"), wrong.keyname);
      await settle(target);
      buttons(target, "Compare and pair").at(-1)!.click();
      await settle(target);
      expect(text(target)).toContain("key-name mismatch");
      expect(await mockApi.device_list()).toHaveLength(before);

      // The right key-name pairs, and the screen sent the typed name rather
      // than asserting a human had confirmed something.
      fill(field(target, "key-name shown on that device"), incoming.keyname);
      await settle(target);
      buttons(target, "Compare and pair").at(-1)!.click();
      await settle(target);

      expect(spy).toHaveBeenCalled();
      for (const [arg] of spy.mock.calls) {
        expect(arg.expect_keyname, "the typed key-name must be sent").toBeTruthy();
        expect(
          arg.confirmed_by_human,
          "this screen must never rubber-stamp the comparison",
        ).toBeFalsy();
      }
      expect(await mockApi.device_list()).toHaveLength(before + 1);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      spy.mockRestore();
      dispose();
    }
  }, 30_000);

  /**
   * An invite blob carries a single-use claim token, so it is a credential
   * until it is redeemed or expires. It is shown (carrying it is the point)
   * and it is dropped the moment the step is over — and it never appears in an
   * error message, where it would outlive the flow in a log or a screenshot.
   */
  it("treats a pairing blob as a credential and drops it when the step ends", async () => {
    const { target, dispose } = await devicesTab();
    try {
      button(target, "Create invite").click();
      await settle(target);

      const blob = area(
        target,
        "Pairing invite to carry to the other device",
      ).value;
      expect(blob.startsWith("ss-pair1.")).toBe(true);
      // Said out loud where the blob is shown.
      expect(text(target)).toContain("Treat this like a password until it is used");
      expect(text(target)).toContain("single-use claim token");

      // Complete the pairing the way a person would: the other device answers,
      // and its key-name is typed here.
      const answer = mockForeignAcceptance(blob);
      fill(area(target, "Acceptance blob from the other device"), answer.blob);
      fill(field(target, "key-name shown on that device"), answer.keyname);
      await settle(target);
      // Two panels carry this action — invite-side (first) and accept-side.
      // This is the invite side, step 2 of the ceremony.
      buttons(target, "Compare and pair").at(0)!.click();
      await settle(target);

      const after = text(target);
      expect(after).toContain("Paired with");
      // Pairing succeeded and immediately says what it did not do.
      expect(after).toContain("there is no sync to start");
      // The blob is gone from the screen the moment it is spent.
      expect(after).not.toContain(blob);

      // Replaying the same answer is refused: the claim token was burnt.
      button(target, "Create invite").click();
      await settle(target);
      fill(area(target, "Acceptance blob from the other device"), answer.blob);
      fill(field(target, "key-name shown on that device"), answer.keyname);
      await settle(target);
      // Two panels carry this action — invite-side (first) and accept-side.
      // This is the invite side, step 2 of the ceremony.
      buttons(target, "Compare and pair").at(0)!.click();
      await settle(target);
      expect(text(target)).toMatch(/already redeemed|answers no invite/);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

describe("settings · devices — an open invite outlives the blob on screen", () => {
  /**
   * The regression this exists for. Step 2 of the ceremony ("paste the answer
   * that came back") was nested inside the panel that displays the freshly
   * minted blob, so it was reachable only in the same session that minted the
   * invite. The other device is a walk down the hall away: hiding the blob — or
   * closing the app — left a live invite in the database with no way in the UI
   * to finish redeeming it.
   *
   * The blob must still go away when hidden (it is a credential), and the form
   * must still be there.
   */
  it("keeps the redeem form after the credential is dropped from the screen", async () => {
    const { target, dispose } = await devicesTab();
    try {
      button(target, "Create invite").click();
      await settle(target);
      const blob = area(
        target,
        "Pairing invite to carry to the other device",
      ).value;
      const answer = mockForeignAcceptance(blob);

      button(target, "Hide").click();
      await settle(target);

      // The credential is off the screen…
      expect(text(target)).not.toContain(blob);
      // …the invite is still open, and it is still redeemable.
      expect(text(target)).toContain("Step 2 · paste the answer that came back");
      const pinned = (await mockApi.device_list()).length;

      fill(area(target, "Acceptance blob from the other device"), answer.blob);
      fill(field(target, "key-name shown on that device"), answer.keyname);
      await settle(target);
      buttons(target, "Compare and pair").at(0)!.click();
      await settle(target);

      expect(text(target)).toContain("Paired with");
      expect(await mockApi.device_list()).toHaveLength(pinned + 1);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

describe("settings · devices — destroying something asks first", () => {
  it("revoking asks, and cancelling revokes nothing", async () => {
    const { target, dispose } = await devicesTab();
    try {
      const revoke = buttons(target, "Revoke").at(0)!;
      revoke.click();
      flushSync();

      const prompt = dialog(document.body);
      expect(prompt, "revoking a device did not ask first").not.toBeNull();
      // The tombstone is explained, because "revoke" reads as "delete".
      expect(text(prompt!)).toContain("tombstone");
      expect(text(prompt!)).toContain("cannot quietly pair again");

      const active = (await mockApi.device_list()).filter(
        (p) => p.revoked_at === null,
      ).length;
      button(prompt!, "Cancel").click();
      await settle(target);
      expect(
        (await mockApi.device_list()).filter((p) => p.revoked_at === null),
      ).toHaveLength(active);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  it("forgetting a revoked device is type-to-confirm, since it lets that key back in", async () => {
    const { target, dispose } = await devicesTab();
    try {
      // Relative to whatever the earlier suites in this file left pinned — the
      // mock dataset is module state.
      const pinned = (await mockApi.device_list()).length;
      button(target, "Forget").click();
      flushSync();
      const prompt = dialog(document.body)!;
      expect(text(prompt)).toContain("may pair with you again from scratch");

      // Held until the phrase matches: forgetting is the only way back from a
      // revocation, so it is not a stray-Enter away.
      const confirm = button(prompt, "Forget device");
      expect(confirm.disabled).toBe(true);
      const typed = prompt.querySelector("input")!;
      fill(typed, "old phone");
      expect(button(prompt, "Forget device").disabled).toBe(false);

      button(prompt, "Cancel").click();
      await settle(target);
      expect(await mockApi.device_list()).toHaveLength(pinned);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  it("resetting the identity is type-to-confirm and says recovery is impossible", async () => {
    const { target, dispose } = await devicesTab();
    try {
      button(target, "Reset identity").click();
      flushSync();
      const prompt = dialog(document.body)!;
      const said = text(prompt);

      // The cost, stated: the key is gone and no backup holds it, because the
      // key that decrypts the vault never leaves this machine's keychain.
      expect(said).toContain("cannot be recovered from a backup");
      expect(said).toContain("never leaves this machine's keychain");
      // And the consolation that is actually true: peer pins survive.
      expect(said).toContain("pins of those devices are kept");

      expect(button(prompt, "Destroy this identity").disabled).toBe(true);
      button(prompt, "Cancel").click();
      await settle(target);
      expect(await mockApi.device_status()).not.toBeNull();
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  it("rotating warns that peers will not recognise the new id", async () => {
    const { target, dispose } = await devicesTab();
    try {
      const before = await mockApi.device_status();
      button(target, "Rotate key").click();
      flushSync();
      const prompt = dialog(document.body)!;
      expect(text(prompt)).toContain("will not recognise the new one");
      // Nothing is notified, because there is nothing to notify over.
      expect(text(prompt)).toContain("no transport to notify over");

      button(prompt, "Cancel").click();
      await settle(target);
      expect((await mockApi.device_status())!.public_key).toBe(
        before!.public_key,
      );
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});
