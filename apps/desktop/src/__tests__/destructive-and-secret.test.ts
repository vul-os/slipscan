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
 * The honesty caveats are pinned here for the same reason. "Bank-alert email
 * parsing is not wired" and "retrying stops at the cap" are load-bearing
 * claims about what the product does; upgrading either one is a two-word edit
 * that no type-check or build would notice.
 *
 * Time is frozen inside the mock's July 2026 window, matching render-smoke.
 *
 * NOTE: the mock dataset is module state shared with the other suites, so
 * everything here either cancels out of the destructive path or performs an
 * operation the mock does not mutate (rotation returns a fresh secret and
 * changes nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import Household from "../routes/Household.svelte";
import Packs from "../routes/Packs.svelte";
import Payments from "../routes/Payments.svelte";
import Settings from "../routes/Settings.svelte";
import Vault from "../routes/settings/Vault.svelte";

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

let fatal: string[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;

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
      unmount(instance);
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
  it("does not present bank-alert email as a source of detections", async () => {
    const { target, dispose } = render(Payments as Component);
    try {
      await settle(target);
      const rendered = text(target);

      // The caveat, in as many words. Detection fires inside
      // transaction_create, and the sources that reach it today are two.
      expect(rendered).toContain("statement imports and entries you make");
      expect(rendered).toContain(
        "Reading a payment out of a bank-alert email is not implemented",
      );

      // And the claim that was there before must not come back. Pointing at
      // a settings tab as the way to make email trigger a watch describes a
      // pipeline that does not exist.
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
      // from pay_matches (migration 0400_shapepay), so the match and its
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
