/**
 * Shared-component sweep.
 *
 * These are the pieces every screen composes from, so a defect here is a
 * defect on eleven screens at once. Two of them are new — ConfirmDialog and
 * DateRangePicker — and exist precisely so three route agents do not each
 * hand-roll a prompt and a range control that disagree with each other.
 *
 * The bar each one is held to: a consistent API, correct ARIA, and the
 * behaviour that is easy to get wrong and invisible in a screenshot —
 * where focus lands, what Escape does, whether a bad value is announced or
 * silently swallowed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount, type Component } from "svelte";
import Badge from "../lib/components/Badge.svelte";
import ConfirmDialog from "../lib/components/ConfirmDialog.svelte";
import DateRangePicker from "../lib/components/DateRangePicker.svelte";
import Dialog from "../lib/components/Dialog.svelte";
import EmptyState from "../lib/components/EmptyState.svelte";
import MemberAvatar from "../lib/components/MemberAvatar.svelte";
import Money from "../lib/components/Money.svelte";
import PageHeader from "../lib/components/PageHeader.svelte";
import Skeleton from "../lib/components/Skeleton.svelte";
import StatCard from "../lib/components/StatCard.svelte";
import {
  datePresets,
  isIsoDate,
  matchPreset,
  rangeDays,
  rangeError,
} from "../lib/util/daterange";
import { contrast } from "./helpers/color";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let mounted: Array<() => void> = [];

function render<P extends Record<string, unknown>>(
  component: Component,
  props?: P,
): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const instance = mount(component, {
    target,
    props: (props ?? {}) as Record<string, unknown>,
  });
  mounted.push(() => {
    void unmount(instance);
    target.remove();
  });
  return target;
}

afterEach(() => {
  for (const dispose of mounted.reverse()) dispose();
  mounted = [];
  document.body.innerHTML = "";
});

const flat = (el: Element | null | undefined) =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

function press(key: string, init: KeyboardEventInit = {}, target?: EventTarget) {
  (target ?? document.activeElement ?? window).dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  flushSync();
}

// ---------------------------------------------------------------------------
// Dialog — the primitive the other overlays are built on
// ---------------------------------------------------------------------------

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(Dialog as Component, { open: false, title: "Shut", children: null });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("names and describes itself from real markup", () => {
    render(Dialog as Component, {
      open: true,
      title: "Move the data folder",
      description: "One folder holds everything durable.",
    });
    flushSync();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      flat(document.getElementById(dialog.getAttribute("aria-labelledby")!)),
    ).toContain("Move the data folder");
    expect(
      flat(document.getElementById(dialog.getAttribute("aria-describedby")!)),
    ).toContain("One folder holds everything durable.");
  });

  it("offers the scrim as a named close control, outside the tab order", () => {
    render(Dialog as Component, { open: true, title: "Closable" });
    flushSync();
    const scrim = document.querySelector<HTMLButtonElement>(".scrim-hit")!;
    expect(scrim.tagName).toBe("BUTTON");
    expect(scrim.tabIndex).toBe(-1);
    expect(scrim.getAttribute("aria-label")).toContain("Close");
  });

  it("says a non-dismissible dialog must be answered, and does not close", () => {
    let closes = 0;
    render(Dialog as Component, {
      open: true,
      title: "Committed",
      dismissible: false,
      onclose: () => closes++,
    });
    flushSync();
    expect(
      document.querySelector(".scrim-hit")!.getAttribute("aria-label"),
    ).toContain("must be answered");
    document.querySelector<HTMLElement>(".scrim-hit")!.click();
    press("Escape", {}, document.querySelector('[role="dialog"]')!);
    expect(closes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

describe("ConfirmDialog", () => {
  const buttons = () => [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ];
  const byText = (label: string) =>
    buttons().find((b) => flat(b).includes(label));

  it("puts focus on Confirm for an ordinary prompt", async () => {
    render(ConfirmDialog as Component, {
      open: true,
      title: "Run matching?",
      confirmLabel: "Run matching",
      onconfirm: () => {},
      oncancel: () => {},
    });
    flushSync();
    await tick();
    expect(flat(document.activeElement)).toContain("Run matching");
  });

  it("puts focus on Cancel for a destructive one", async () => {
    // The whole point: a stray Enter on a danger prompt must not destroy
    // anything. Focus starts on the way out, not on the irreversible button.
    render(ConfirmDialog as Component, {
      open: true,
      title: "Remove Alex?",
      tone: "danger",
      confirmLabel: "Remove member",
      onconfirm: () => {},
      oncancel: () => {},
    });
    flushSync();
    await tick();
    expect(flat(document.activeElement)).toContain("Cancel");
    expect(byText("Remove member")!.className).toContain("btn-destructive");
  });

  it("gates the truly unrecoverable behind typing the exact phrase", async () => {
    let confirms = 0;
    render(ConfirmDialog as Component, {
      open: true,
      title: "Revoke signing secret?",
      confirmPhrase: "webhook-prod",
      tone: "danger",
      confirmLabel: "Revoke",
      onconfirm: () => confirms++,
      oncancel: () => {},
    });
    flushSync();
    await tick();

    const confirm = byText("Revoke")!;
    const input = document.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(document.activeElement).toBe(input);
    expect(confirm.disabled).toBe(true);

    input.value = "webhook-pro";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(confirm.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // Enter while the phrase is wrong must not slip past the gate either.
    press("Enter", {}, input);
    expect(confirms).toBe(0);

    input.value = "webhook-prod";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(confirm.disabled).toBe(false);
    press("Enter", {}, input);
    expect(confirms).toBe(1);
  });

  it("shows a failure inside the prompt instead of swallowing it", () => {
    render(ConfirmDialog as Component, {
      open: true,
      title: "Remove endpoint?",
      tone: "danger",
      error: "endpoint has queued deliveries",
      onconfirm: () => {},
      oncancel: () => {},
    });
    flushSync();
    const alert = document.querySelector('[role="alert"]')!;
    expect(flat(alert)).toContain("endpoint has queued deliveries");
  });

  it("cannot be abandoned mid-flight", () => {
    let cancels = 0;
    let confirms = 0;
    render(ConfirmDialog as Component, {
      open: true,
      title: "Moving…",
      busy: true,
      onconfirm: () => confirms++,
      oncancel: () => cancels++,
    });
    flushSync();
    const panelButtons = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ];
    expect(panelButtons.length).toBeGreaterThan(0);
    for (const b of panelButtons) expect(b.disabled).toBe(true);
    press("Escape", {}, document.querySelector('[role="dialog"]')!);
    expect(cancels).toBe(0);
    expect(confirms).toBe(0);
    expect(flat(document.querySelector('[role="dialog"]'))).toContain("Working…");
  });
});

// ---------------------------------------------------------------------------
// date ranges
// ---------------------------------------------------------------------------

describe("date-range logic", () => {
  const NOW = new Date("2026-07-20T09:00:00Z");

  it("builds calendar-month presets, not rolling day windows", () => {
    const byId = new Map(datePresets(NOW).map((p) => [p.id, p.range]));
    // "Last month" is a whole calendar month, start to end.
    const last = byId.get("last-month")!;
    expect(last.from.endsWith("-01")).toBe(true);
    expect(last.to.slice(0, 7)).toBe(last.from.slice(0, 7));
    // Three months means three months from a 1st, not 90 days.
    expect(byId.get("last-3-months")!.from.endsWith("-01")).toBe(true);
    expect(byId.get("year-to-date")!.from.endsWith("-01-01")).toBe(true);
    const lastYear = byId.get("last-year")!;
    expect(lastYear.from.endsWith("-01-01")).toBe(true);
    expect(lastYear.to.endsWith("-12-31")).toBe(true);
  });

  it("recognises its own presets and nothing else", () => {
    for (const preset of datePresets(NOW)) {
      expect(matchPreset(preset.range, NOW)).toBe(preset.id);
    }
    expect(matchPreset({ from: "2026-03-07", to: "2026-04-02" }, NOW)).toBeNull();
  });

  it("says why a range is unusable rather than just refusing", () => {
    expect(rangeError({ from: "2026-01-01", to: "2026-01-31" })).toBeNull();
    expect(rangeError({ from: "2026-01-31", to: "2026-01-01" })).toMatch(/after/);
    expect(rangeError({ from: "nonsense", to: "2026-01-01" })).toMatch(/Start/);
    expect(rangeError({ from: "2026-01-01", to: "2026-02-30" })).toMatch(/End/);
  });

  it("validates real calendar dates, leap years included", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-1")).toBe(false);
  });

  it("counts days inclusively", () => {
    expect(rangeDays({ from: "2026-07-01", to: "2026-07-31" })).toBe(31);
    expect(rangeDays({ from: "2026-07-01", to: "2026-07-01" })).toBe(1);
    expect(rangeDays({ from: "2026-07-31", to: "2026-07-01" })).toBe(0);
  });
});

describe("DateRangePicker", () => {
  const NOW = new Date("2026-07-20T09:00:00Z");

  it("marks the preset the current range already is", () => {
    const thisMonth = datePresets(NOW).find((p) => p.id === "this-month")!;
    render(DateRangePicker as Component, {
      from: thisMonth.range.from,
      to: thisMonth.range.to,
      now: NOW,
      onchange: () => {},
    });
    flushSync();
    const pressed = [...document.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-pressed") === "true",
    );
    expect(pressed).toHaveLength(1);
    expect(flat(pressed[0])).toBe("This month");
  });

  it("emits the preset's range when one is clicked", () => {
    const emitted: Array<{ from: string; to: string }> = [];
    render(DateRangePicker as Component, {
      from: "2026-07-01",
      to: "2026-07-20",
      now: NOW,
      onchange: (r: { from: string; to: string }) => emitted.push(r),
    });
    flushSync();
    const lastMonth = datePresets(NOW).find((p) => p.id === "last-month")!;
    [...document.querySelectorAll("button")]
      .find((b) => flat(b) === "Last month")!
      .click();
    flushSync();
    expect(emitted).toEqual([lastMonth.range]);
  });

  it("announces an inverted range instead of quietly ignoring it", () => {
    const emitted: unknown[] = [];
    render(DateRangePicker as Component, {
      from: "2026-07-31",
      to: "2026-07-01",
      now: NOW,
      onchange: (r: unknown) => emitted.push(r),
    });
    flushSync();
    expect(flat(document.querySelector('[role="alert"]'))).toMatch(/after/);
    for (const input of document.querySelectorAll("input")) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    expect(emitted).toEqual([]);
  });

  it("names both fields and the group for a screen reader", () => {
    render(DateRangePicker as Component, {
      from: "2026-07-01",
      to: "2026-07-20",
      now: NOW,
      label: "Reporting period",
      onchange: () => {},
    });
    flushSync();
    const group = document.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Reporting period");
    const labels = [...document.querySelectorAll("input")].map((i) =>
      i.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Reporting period start", "Reporting period end"]);
  });
});

// ---------------------------------------------------------------------------
// the existing shared set
// ---------------------------------------------------------------------------

describe("shared components", () => {
  it("Money keeps integer minor units exact and de-emphasises the cents", () => {
    const target = render(Money as Component, {
      amount: -84_235,
      currency: "ZAR",
    });
    flushSync();
    expect(flat(target)).toBe("−R 842.35".replace(/\s+/g, " "));
    // The fraction is a separate span so it can be quietened typographically.
    expect(target.querySelector(".money-frac")?.textContent).toBe(".35");
    // Every number in the product is mono and tabular.
    expect(target.querySelector(".num")).not.toBeNull();
  });

  it("Money renders a zero-decimal currency with no fraction at all", () => {
    const target = render(Money as Component, { amount: 1234, currency: "JPY" });
    flushSync();
    expect(target.querySelector(".money-frac")).toBeNull();
    expect(flat(target)).toContain("1,234");
  });

  it("Money can show an explicit sign for income", () => {
    const target = render(Money as Component, {
      amount: 4_550_000,
      currency: "ZAR",
      signed: true,
      colored: true,
    });
    flushSync();
    expect(flat(target).startsWith("+")).toBe(true);
    expect(target.querySelector(".num")!.className).toContain("text-success");
  });

  it("Skeleton announces itself as busy, which is what tests wait on", () => {
    const target = render(Skeleton as Component, { rows: 3 });
    flushSync();
    const status = target.querySelector('[aria-busy="true"]')!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-label")).toBe("Loading");
    expect(target.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("Badge renders every tone with a label, and the dot is optional", () => {
    for (const tone of ["neutral", "success", "warning", "danger", "accent"]) {
      const target = render(Badge as Component, { tone, label: tone });
      flushSync();
      expect(flat(target)).toBe(tone);
    }
    const noDot = render(Badge as Component, { label: "ZA", dot: false });
    flushSync();
    expect(noDot.querySelectorAll("span span")).toHaveLength(0);
  });

  it("EmptyState leads with a heading and carries its actions", () => {
    const target = render(EmptyState as Component, {
      title: "All square",
      body: "No unmatched slips right now.",
      hint: "Press G then C",
    });
    flushSync();
    expect(target.querySelector("h3")?.textContent).toBe("All square");
    expect(flat(target)).toContain("Press G then C");
    // The brand slash is decoration, never announced.
    expect(target.querySelector(".slash-mark")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("PageHeader gives every screen exactly one h1", () => {
    const target = render(PageHeader as Component, {
      eyebrow: "Documents ↔ transactions",
      title: "Reconcile",
      subtitle: "Confirm the good ones.",
    });
    flushSync();
    expect(target.querySelectorAll("h1")).toHaveLength(1);
    expect(target.querySelector("h1")?.textContent?.trim()).toBe("Reconcile");
  });

  it("StatCard renders money at display scale and a plain value otherwise", () => {
    const money = render(StatCard as Component, {
      label: "Net balance",
      amount: 5_684_422,
      currency: "ZAR",
    });
    flushSync();
    expect(money.querySelector(".num-display")).not.toBeNull();
    expect(flat(money)).toContain("56,844.22");

    const count = render(StatCard as Component, {
      label: "Accounts",
      value: "4 accounts",
    });
    flushSync();
    expect(flat(count)).toContain("4 accounts");
  });

  it("MemberAvatar picks an initial ink that clears AA on any swatch", () => {
    // The colour is stored verbatim and core never interprets it, so the
    // component has to compute this per swatch rather than assume.
    for (const colour of ["#ffffff", "#000000", "#c8ff00", "#3b5bdb", "#c05a52"]) {
      const target = render(MemberAvatar as Component, {
        member: { id: "m", label: "Alex", initial: "A", colour },
      });
      flushSync();
      const style = target.querySelector<HTMLElement>("span")!.style;
      expect(contrast(style.color || "#000000", colour)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("MemberAvatar has a named placeholder for unattributed rows", () => {
    const target = render(MemberAvatar as Component, { member: null });
    flushSync();
    expect(target.querySelector("span")?.getAttribute("title")).toBe(
      "Unattributed",
    );
  });
});
