/**
 * The four accounting screens: Budgets, Ledger, Reconcile, Reports.
 *
 * The render smoke suite proves these routes render their data. What it
 * cannot prove is the part that makes them *correct* rather than merely
 * present, which is what this file pins:
 *
 *   - Budgets says out loud that a stored `rollover` flag changes nothing.
 *   - Ledger offers no edit on a posted entry, only a reversal, and that
 *     reversal really is the original with debits and credits swapped.
 *   - Reconcile's Undo cancels an API call that has not happened yet —
 *     the only undo that can be honest when `accept: false` is terminal.
 *   - Reports names the tax report from the region profile, and states that
 *     no figure on it has been through an exchange rate.
 *
 * Everything runs against the in-memory mock dataset (src/lib/api/mock.ts):
 * outside Tauri, src/lib/api/client.ts serves every call from it, so no
 * backend, IPC or network is involved. Time is frozen inside the dataset's
 * July 2026 window so the month-scoped screens have data whenever this runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import { api } from "../lib/api/client";
import Budgets from "../routes/Budgets.svelte";
import Ledger from "../routes/Ledger.svelte";
import Reconcile from "../routes/Reconcile.svelte";
import Reports from "../routes/Reports.svelte";

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

let fatal: string[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;
let mounted: Array<() => void> = [];

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
  for (const dispose of mounted.reverse()) dispose();
  mounted = [];
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  consoleError.mockRestore();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function render(component: Component): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, { target });
  mounted.push(() => {
    unmount(instance);
    target.remove();
  });
  return target;
}

/** Drive the event loop until the screen stops changing (see render-smoke). */
async function settle(target: HTMLElement): Promise<void> {
  let previous = "";
  let stable = 0;
  for (let turn = 0; turn < 250; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const busy = target.querySelector('[aria-busy="true"]') !== null;
    const text = target.textContent ?? "";
    stable = !busy && text.length > 0 && text === previous ? stable + 1 : 0;
    previous = text;
    if (stable >= 3) return;
  }
  throw new Error("route never settled after 250 turns");
}

/** Collapse whitespace: Intl puts U+00A0 inside formatted money. */
function text(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

const accessibleName = (el: Element) =>
  (el.getAttribute("aria-label") ?? el.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim();

function buttons(target: HTMLElement, label: string | RegExp): HTMLButtonElement[] {
  return [...target.querySelectorAll("button")].filter((b) =>
    typeof label === "string"
      ? accessibleName(b).includes(label)
      : label.test(accessibleName(b)),
  );
}

function button(target: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const found = buttons(target, label);
  if (found.length === 0)
    throw new Error(`no button named ${String(label)}`);
  return found[0]!;
}

async function click(target: HTMLElement, el: HTMLElement) {
  el.click();
  await settle(target);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("Budgets", () => {
  it("says a stored rollover flag changes none of the numbers", async () => {
    const target = render(Budgets as Component);
    await settle(target);
    const rendered = text(target);

    // The mock's Household budget carries rollover: true. The chip must not
    // read as a working feature, and the reason must be on screen.
    expect(rendered).toContain("rollover: not applied");
    expect(rendered).toContain("Rollover is recorded, not applied.");
    expect(rendered).toContain("no number on this screen uses it");
    // Named next month, so "does not carry into <month>" is concrete.
    expect(rendered).toContain("August 2026");
    expect(fatal).toEqual([]);
  }, 20_000);

  it("drills a budget down to the transactions that spent it", async () => {
    const target = render(Budgets as Component);
    await settle(target);

    const row = button(target, "Groceries");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await click(target, row);
    expect(row.getAttribute("aria-expanded")).toBe("true");

    const panel = document.getElementById(row.getAttribute("aria-controls")!);
    expect(panel, "the row's aria-controls target does not exist").not.toBeNull();
    const lines = text(panel);
    // Real transactions from the mock's July groceries, and a listed total
    // that agrees with the burn shown on the row itself.
    expect(lines).toContain("Woolworths");
    expect(lines).toContain("R 842.35");
    expect(lines).toContain("3 transactions · R 1,893.05 listed");
    // Agreement means no discrepancy note.
    expect(lines).not.toContain("computed by core over the same period");
    expect(fatal).toEqual([]);
  }, 20_000);

  it("steps months from the stepper and with the arrow keys", async () => {
    const target = render(Budgets as Component);
    await settle(target);
    expect(text(target)).toContain("July 2026");

    await click(target, button(target, "Previous month"));
    expect(text(target)).toContain("June 2026");

    // The arrows are an accelerator on the group, not the only way through.
    const group = target.querySelector<HTMLElement>('[role="group"]')!;
    group.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await settle(target);
    expect(text(target)).toContain("July 2026");
    expect(fatal).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

describe("Ledger", () => {
  it("formats journal money on a cold load, with no cached data", async () => {
    // Regression: the book currency used to be derived from `data`, which
    // stays an unresolved promise for the whole first visit — so it was ""
    // and Intl.NumberFormat threw `Invalid currency code` mid-render, leaving
    // the Journal tab showing the previous tab's markup.
    const target = render(Ledger as Component);
    await settle(target);

    const journalTab = [...target.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (t) => text(t) === "Journal",
    )!;
    await click(target, journalTab);

    expect(journalTab.getAttribute("aria-selected")).toBe("true");
    const panel = target.querySelector('[role="tabpanel"]')!;
    expect(panel.id).toBe("ledger-panel-journal");
    const rendered = text(panel);
    expect(rendered).toContain("Eskom prepaid electricity");
    expect(rendered).toContain("R 950.00");
    expect(fatal).toEqual([]);
  }, 20_000);

  it("offers no edit on a posted entry — only a reversal", async () => {
    const target = render(Ledger as Component);
    await settle(target);
    await click(
      target,
      [...target.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (t) => text(t) === "Journal",
      )!,
    );

    expect(text(target)).toContain("Posted entries are immutable.");
    // The button that must not exist, by any of its usual names.
    expect(buttons(target, /^(Edit|Delete|Remove entry)/)).toHaveLength(0);
    expect(buttons(target, /^Reverse/).length).toBeGreaterThan(0);
    expect(fatal).toEqual([]);
  }, 20_000);

  it("pre-fills a reversal as the original with debits and credits swapped", async () => {
    const target = render(Ledger as Component);
    await settle(target);
    await click(
      target,
      [...target.querySelectorAll<HTMLElement>('[role="tab"]')].find(
        (t) => text(t) === "Journal",
      )!,
    );
    await click(target, button(target, "Reverse “Eskom prepaid electricity”"));

    const form = target.querySelector("form")!;
    expect(text(form)).toContain("Reversing entry");
    expect(text(form)).toContain("the original is not modified");
    expect(text(form)).toContain("balanced");

    const memo = form.querySelector<HTMLInputElement>(
      'input:not([type="date"])',
    )!;
    expect(memo.value).toBe("Reversal — Eskom prepaid electricity");

    // The mock entry is 826.09 Dr / 123.91 Dr / 950.00 Cr. Swapped, that is
    // 826.09 Cr / 123.91 Cr / 950.00 Dr — three lines, still balanced.
    const debits = [
      ...form.querySelectorAll<HTMLInputElement>('input[aria-label^="Debit"]'),
    ].map((i) => i.value);
    const credits = [
      ...form.querySelectorAll<HTMLInputElement>('input[aria-label^="Credit"]'),
    ].map((i) => i.value);
    expect(debits).toEqual(["", "", "950.00"]);
    expect(credits).toEqual(["826.09", "123.91", ""]);
    expect(fatal).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

describe("Reconcile", () => {
  it("holds a decision, and Undo cancels the call rather than reversing it", async () => {
    const confirm = vi.spyOn(api, "reconConfirm");
    const target = render(Reconcile as Component);
    await settle(target);

    const before = target.querySelectorAll('li[tabindex="0"]').length;
    expect(before).toBeGreaterThan(0);

    await click(target, button(target, /^Confirm match with/));

    // The row has left the queue and nothing has been sent: `accept: false`
    // is terminal in core, so an undo that fires afterwards cannot exist.
    expect(target.querySelectorAll('li[tabindex="0"]')).toHaveLength(before - 1);
    expect(confirm).not.toHaveBeenCalled();
    expect(text(target)).toContain("sending in a moment");
    // It shows as matched meanwhile, flagged as still reversible.
    expect(text(target)).toContain("undoable");

    await click(target, button(target, "Undo"));
    expect(target.querySelectorAll('li[tabindex="0"]')).toHaveLength(before);
    expect(confirm).not.toHaveBeenCalled();
    expect(fatal).toEqual([]);
  }, 20_000);

  it("sends the held decision on Apply now", async () => {
    const confirm = vi.spyOn(api, "reconConfirm");
    const target = render(Reconcile as Component);
    await settle(target);

    await click(target, button(target, /^Reject match with/));
    expect(confirm).not.toHaveBeenCalled();

    await click(target, button(target, "Apply now"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0]).toMatchObject({ accept: false });
    // The banner goes once the batch is gone.
    expect(text(target)).not.toContain("sending in a moment");
    expect(fatal).toEqual([]);
  }, 20_000);

  it("shows the evidence behind a score without claiming to be the matcher", async () => {
    const target = render(Reconcile as Component);
    await settle(target);
    const rendered = text(target);

    expect(rendered).toContain("Amounts agree to the cent");
    expect(rendered).toContain("appears in the bank description");
    // The score stays core's, and the limits of this view are stated.
    expect(rendered).toContain("The percentage is the matcher's own score.");
    expect(rendered).toContain("those dates are not part of what it returns");
    expect(fatal).toEqual([]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

describe("Reports", () => {
  it("names the tax report from the region profile, not from code", async () => {
    const target = render(Reports as Component);
    await settle(target);
    const rendered = text(target);

    // VAT201 is the za profile's label; every box label is the profile's too.
    expect(rendered).toContain("VAT201");
    expect(rendered).toContain("Output VAT");
    expect(rendered).toContain("Input VAT");
    expect(rendered).toContain("come from this book's region profile");
    expect(rendered).toContain("South Africa");
    expect(fatal).toEqual([]);
  }, 20_000);

  it("states that no figure on it has been through an exchange rate", async () => {
    const target = render(Reports as Component);
    await settle(target);
    const rendered = text(target);

    expect(rendered).toContain("Exchange rates");
    expect(rendered).toContain("Nothing here is converted.");
    expect(rendered).toContain("Converted report views are not built yet.");
    // FX is opt-in and the mock starts unconfigured; that is reported as such
    // rather than as an empty rate table.
    expect(rendered).toContain("not configured");
    expect(fatal).toEqual([]);
  }, 20_000);

  it("scopes the period from one range control", async () => {
    const target = render(Reports as Component);
    await settle(target);

    const picker = target.querySelector<HTMLElement>(
      '[role="group"][aria-label="Report period"]',
    );
    expect(picker, "Reports no longer has a single period control").not.toBeNull();
    // Opens on a preset rather than a custom range nobody chose.
    const pressed = [...picker!.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    expect(pressed.map((b) => text(b))).toEqual(["This month"]);

    await click(target, button(target, "Last month"));
    expect(text(target)).toContain("Jun 1, 2026 – Jun 30, 2026");
    expect(fatal).toEqual([]);
  }, 20_000);
});
