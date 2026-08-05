/**
 * Sales — orders, invoicing, payments and aged receivables, end to end.
 *
 * The mock's one demo book is personal (`kind: "personal"`), so
 * `render-smoke.test.ts` can only ever exercise the business-book gate for
 * `/sales` — it can never prove the trade UI underneath it actually works.
 * This file is where that UI is proven: it flips the shared mock book to
 * business (the same call Settings › General exposes), drives the screen
 * through real component interactions — never by calling the mock API
 * directly for anything the screen itself is responsible for — and restores
 * the book to personal afterwards so later tests in this file, and this
 * module's own later `it` blocks, see the state they expect.
 *
 * Money is checked in its formatted, tabular-numeral form throughout
 * (through Money.svelte), never as a raw minor-unit number: that pins
 * fmtMoney's arithmetic, not just that a number rendered somewhere.
 *
 * Confirm-before-act is asserted the way destructive-and-secret.test.ts
 * asserts it: a click that opens a dialog is not the same as a click that
 * performs the action, and cancelling the dialog is proven to have done
 * nothing rather than merely proving a dialog appeared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import Sales from "../routes/Sales.svelte";
import { mockApi } from "../lib/api/mock";

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

afterEach(async () => {
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  consoleError.mockRestore();
  vi.useRealTimers();
  document.body.innerHTML = "";
  // The mock dataset is module state shared across this file's suites (and,
  // per Vitest's per-file isolation, only this file's) — put the book back
  // the way every other screen's tests find it.
  const [book] = await mockApi.book_list();
  if (book && book.kind !== "personal") {
    await mockApi.book_set_kind({ book_id: book.id, kind: "personal" });
  }
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

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = buttons(target, label);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one button containing ${JSON.stringify(label)}, found ` +
        `${found.length}: ${found.map(nameOf).join(" / ")}`,
    );
  }
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

function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function select(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}

const input = (target: HTMLElement, label: string): HTMLInputElement =>
  [...target.querySelectorAll("input")].find((i) =>
    (i.getAttribute("aria-label") ?? i.closest("label")?.textContent ?? "").includes(
      label,
    ),
  )!;

const selectField = (target: HTMLElement, label: string): HTMLSelectElement =>
  [...target.querySelectorAll("select")].find((s) =>
    (s.getAttribute("aria-label") ?? s.closest("label")?.textContent ?? "").includes(
      label,
    ),
  )!;

/** Click the row-expander button inside the first `<tr>` whose text contains
 * `needle` — used for the invoices table, where the row's own label (its
 * number) is not known in advance because numbering is a shared sequence
 * across this file's tests. */
function expandRowContaining(target: HTMLElement, needle: string): void {
  const row = [...target.querySelectorAll("tbody tr")].find(
    (tr) =>
      (tr.textContent ?? "").includes(needle) &&
      tr.querySelector("button[aria-expanded]") !== null,
  );
  if (!row) throw new Error(`no row containing ${JSON.stringify(needle)}`);
  (row.querySelector("button[aria-expanded]") as HTMLButtonElement).click();
  flushSync();
}

async function makeBusiness(): Promise<{ bookId: string; contactId: string }> {
  const [book] = await mockApi.book_list();
  await mockApi.book_set_kind({ book_id: book!.id, kind: "business" });
  const contact = await mockApi.contact_add({
    book_id: book!.id,
    role: "customer",
    name: "Karoo Wholesale",
    payment_terms_days: 14,
  });
  return { bookId: book!.id, contactId: contact.id };
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

describe("sales · a personal book", () => {
  it("says plainly that trade is hidden, and does not render any order UI", async () => {
    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      const rendered = text(target);

      expect(rendered).toContain("Sales is a business-book feature");
      expect(rendered).toContain("Personal is a personal book");
      expect(rendered).toContain("Open Settings › General");

      // The gate, not a half-rendered trade screen underneath it.
      expect(target.querySelector('[role="tablist"]')).toBeNull();
      expect(rendered).not.toContain("New order");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// the full flow: draft -> lines -> confirm -> invoice -> payment -> aged
// ---------------------------------------------------------------------------

describe("sales · a business book, the whole workflow", () => {
  it("drafts an order, confirms it, issues an invoice and records a payment", async () => {
    const { contactId } = await makeBusiness();

    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      expect(target.querySelector('[role="tablist"]'), "gate still showing on a business book")
        .not.toBeNull();

      // -- create a draft order -------------------------------------------
      buttons(target, "New order")[0]!.click();
      await settle(target);
      let d = dialog(target)!;
      select(selectField(d, "Customer"), contactId);
      button(target, "Create draft").click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("Karoo Wholesale");
      expect(text(target)).toContain("draft");

      // The new order auto-expands with an empty line editor.
      expect(text(target)).toContain("No lines yet");
      expect(
        buttons(target, "Confirm order").at(0)!.disabled,
        "confirming an order with no lines must be refused",
      ).toBe(true);

      // -- add a free-text line ---------------------------------------------
      fill(input(target, "Description for new line"), "Consulting — July");
      fill(input(target, "Quantity for new line"), "2");
      fill(input(target, "Unit price for new line"), "150.00");
      button(target, "Add line").click();
      await settle(target);

      expect(text(target)).toContain("Consulting — July");
      // 2 x R150 = R300 net (the subtotal, tax excluded), plus 15% VAT
      // (the demo book's active standard rate) = R345 total — both derived
      // from `sales_order_totals`, never a number this test computed itself.
      expect(text(target)).toContain("R 300.00");
      expect(text(target)).toContain("R 345.00");

      // -- confirm ------------------------------------------------------------
      // The row's own trigger and the confirm dialog's button share the
      // label "Confirm order" by design (the dialog names the exact action
      // it is about to take) — `.at(-1)` reaches the dialog's, which is
      // appended after the row's in the DOM.
      expect(buttons(target, "Confirm order").at(0)!.disabled).toBe(false);
      buttons(target, "Confirm order").at(0)!.click();
      await settle(target);
      const confirmPrompt = dialog(target)!;
      expect(text(confirmPrompt)).toContain("deducts stock");
      expect(text(confirmPrompt)).toContain("posts revenue, VAT and cost of goods");
      buttons(target, "Confirm order").at(-1)!.click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("confirmed");
      // A confirmed order's lines are read-only: no quantity input remains.
      expect(
        [...target.querySelectorAll("input")].some((i) =>
          (i.getAttribute("aria-label") ?? "").includes("Quantity for Consulting"),
        ),
      ).toBe(false);

      // -- issue an invoice from it -------------------------------------------
      button(target, "Issue invoice").click();
      await settle(target);
      const issueDialog = dialog(target)!;
      expect(text(issueDialog)).toContain("numbered and immutable");
      buttons(target, "Issue invoice").at(-1)!.click();
      await settle(target);
      expect(text(target)).toContain("issued, due");

      button(target, "View in Invoices").click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(
        target.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
      ).toBe("Invoices");
      expect(text(target)).toContain("Karoo Wholesale");
      expect(text(target)).toContain("unpaid");
      expect(text(target)).toContain("R 345.00");

      // Never an edit affordance on an issued invoice, anywhere on screen.
      for (const control of target.querySelectorAll("button")) {
        expect(nameOf(control).toLowerCase()).not.toMatch(/^edit|^update line/);
      }

      // -- record a full payment -----------------------------------------------
      expandRowContaining(target, "Karoo Wholesale");
      await settle(target);
      expect(text(target)).toContain("No payments recorded");
      button(target, "Record payment").click();
      await settle(target);
      const payDialog = dialog(target)!;
      // Defaults to the full amount due.
      expect(input(payDialog, "Amount").value).toBe("345.00");
      buttons(target, "Record payment").at(-1)!.click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("Paid in full");
      expect(text(target)).toContain("paid");
      expect(text(target)).not.toContain("unpaid");

      // -- aged receivables now shows nothing outstanding ------------------
      button(target, "Aged receivables").click();
      await settle(target);
      expect(text(target)).toContain("Nothing outstanding");

      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// stock-tracked lines need a location before an order can confirm
// ---------------------------------------------------------------------------

describe("sales · a stock-tracked line needs a location to confirm", () => {
  it("refuses to confirm until a location is set, then succeeds", async () => {
    const { bookId, contactId } = await makeBusiness();
    const location = await mockApi.location_create({
      book_id: bookId,
      name: "Main warehouse",
    });
    const category = await mockApi.product_category_create({
      book_id: bookId,
      name: "Hardware",
    });
    const product = await mockApi.product_create({
      book_id: bookId,
      product_category_id: category.id,
      name: "Bolt, M8",
    });
    const variant = await mockApi.product_variant_add({
      product_id: product.id,
      sku: "BOLT-M8",
      name: "Bolt, M8 · box of 100",
      price_minor: 9_900,
      currency: "ZAR",
    });
    await mockApi.stock_movement_record({
      variant_id: variant.id,
      location_id: location.id,
      qty_delta: 50,
      kind: "adjustment",
      note: "opening stock",
    });

    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);

      buttons(target, "New order")[0]!.click();
      await settle(target);
      select(selectField(dialog(target)!, "Customer"), contactId);
      button(target, "Create draft").click();
      await settle(target);

      // Pick the variant line; price/description prefill from it.
      select(selectField(target, "Variant for new line"), variant.id);
      await settle(target);
      fill(input(target, "Quantity for new line"), "3");
      button(target, "Add line").click();
      await settle(target);
      expect(text(target)).toContain("stock-tracked");

      const confirmBtn = buttons(target, "Confirm order").at(0)!;
      expect(confirmBtn.disabled, "no location set yet").toBe(true);
      expect(confirmBtn.title).toContain("location");

      // Set the location, and the same button becomes usable.
      select(selectField(target, "Location for order"), location.id);
      await settle(target);
      expect(buttons(target, "Confirm order").at(0)!.disabled).toBe(false);

      buttons(target, "Confirm order").at(0)!.click();
      await settle(target);
      buttons(target, "Confirm order").at(-1)!.click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("confirmed");

      // NOT asserted: that on-hand actually dropped by 3. mock.ts says so
      // explicitly — "confirming an order does not move stock … this mock
      // has no stock ledger at all" — so a passing assertion here would be
      // exactly the kind of green screen that proves nothing about the real
      // stock deduction `sales_order_confirm` performs server-side. What
      // this test proves instead is the client-side guard: the button stays
      // disabled, with a reason, until a location exists to confirm against.
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// destructive actions ask first, and cancelling them does nothing
// ---------------------------------------------------------------------------

describe("sales · cancelling and deleting ask first", () => {
  it("cancelling a draft order via Escape leaves it exactly as it was", async () => {
    const { contactId } = await makeBusiness();
    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      buttons(target, "New order")[0]!.click();
      await settle(target);
      select(selectField(dialog(target)!, "Customer"), contactId);
      button(target, "Create draft").click();
      await settle(target);
      expect(text(target)).toContain("draft");

      button(target, "Cancel").click();
      await settle(target);
      const prompt = dialog(target)!;
      expect(text(prompt)).toContain("Cancel order");
      expect(nameOf(document.activeElement!)).toBe("Cancel");

      prompt.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await settle(target);
      expect(dialog(target)).toBeNull();
      // Still draft: the first click asked, it did not act.
      expect(text(target)).toContain("draft");
      expect(text(target)).not.toContain("cancelled");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("deleting a draft is a separate, type-nothing confirm that removes it once accepted", async () => {
    const { bookId, contactId } = await makeBusiness();
    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      buttons(target, "New order")[0]!.click();
      await settle(target);
      select(selectField(dialog(target)!, "Customer"), contactId);
      button(target, "Create draft").click();
      await settle(target);

      // Earlier suites in this file leave their own orders behind (module
      // state, shared within this file — see the file docstring), so "the
      // list is empty" is not the property to prove; "this specific order
      // is gone" is. `sales_order_list` is sorted newest-number-first, so
      // the freshest row is the one this test just created.
      const before = await mockApi.sales_order_list({ book_id: bookId });
      const created = before[0]!;
      expect(created.status).toBe("draft");

      button(target, "Delete draft").click();
      await settle(target);
      const prompt = dialog(target)!;
      expect(text(prompt)).toContain("removes the order and its lines outright");

      buttons(target, "Delete draft").at(-1)!.click();
      await settle(target);
      expect(dialog(target)).toBeNull();

      const after = await mockApi.sales_order_list({ book_id: bookId });
      expect(after.find((o) => o.id === created.id)).toBeUndefined();
      expect(after).toHaveLength(before.length - 1);
      expect(text(target)).not.toContain(`#${created.number}`);
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// quotes: draft -> send -> accept converts into a new draft sales order
// ---------------------------------------------------------------------------

describe("sales · quotes", () => {
  it("drafts a quote, sends it, and accepting hands off a new draft order to Orders", async () => {
    const { contactId } = await makeBusiness();
    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      // Quotes is the default tab — no click needed to reach it.
      expect(
        target.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
      ).toBe("Quotes");

      // -- create a draft quote ---------------------------------------------
      buttons(target, "New quote")[0]!.click();
      await settle(target);
      const createDialog = dialog(target)!;
      select(selectField(createDialog, "Customer"), contactId);
      button(target, "Create draft").click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("Karoo Wholesale");
      expect(text(target)).toContain("draft");

      // The new quote auto-expands with an empty line editor, and sending is
      // refused with no lines.
      expect(text(target)).toContain("No lines yet");
      expect(
        buttons(target, "Send quote").at(0)!.disabled,
        "sending a quote with no lines must be refused",
      ).toBe(true);

      // -- add a free-text line -----------------------------------------------
      fill(input(target, "Description for new line"), "Fleet servicing — Q3");
      fill(input(target, "Quantity for new line"), "2");
      fill(input(target, "Unit price for new line"), "150.00");
      button(target, "Add line").click();
      await settle(target);

      expect(text(target)).toContain("Fleet servicing — Q3");
      // 2 x R150 = R300 net, plus 15% VAT = R345 — both derived from
      // `quote_totals`, never a number this test computed itself.
      expect(text(target)).toContain("R 300.00");
      expect(text(target)).toContain("R 345.00");

      // -- send -----------------------------------------------------------
      expect(buttons(target, "Send quote").at(0)!.disabled).toBe(false);
      buttons(target, "Send quote").at(0)!.click();
      await settle(target);
      const sendPrompt = dialog(target)!;
      expect(text(sendPrompt)).toContain("no longer be edited once sent");
      buttons(target, "Send quote").at(-1)!.click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("sent");

      // A sent quote's lines are read-only: no quantity input remains.
      expect(
        [...target.querySelectorAll("input")].some((i) =>
          (i.getAttribute("aria-label") ?? "").includes("Quantity for Fleet servicing"),
        ),
      ).toBe(false);

      // -- accept: hands off a brand-new draft order --------------------------
      button(target, "Accept").click();
      await settle(target);
      const acceptDialog = dialog(target)!;
      expect(text(acceptDialog)).toContain("brand-new draft sales order");
      buttons(target, "Accept").at(-1)!.click();
      await settle(target);
      expect(text(target)).toContain("Created sales order #");

      button(target, "View in Orders").click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(
        target.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim(),
      ).toBe("Orders");
      expect(text(target)).toContain("Karoo Wholesale");
      expect(text(target)).toContain("draft");
      expect(text(target)).toContain("Fleet servicing — Q3");
      // Accepting only drafts the order — it does not confirm it, so no
      // stock or ledger posting has happened yet.
      expect(text(target)).not.toContain("confirmed");

      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 30_000);

  it("Decline, Accept and Let it expire are only offered once a quote is sent, and declining asks first", async () => {
    const { contactId } = await makeBusiness();
    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      buttons(target, "New quote")[0]!.click();
      await settle(target);
      select(selectField(dialog(target)!, "Customer"), contactId);
      button(target, "Create draft").click();
      await settle(target);

      // Neither Decline nor Accept nor "Let it expire" exist on a draft —
      // only Send and Delete draft do.
      expect(buttons(target, "Decline")).toHaveLength(0);
      expect(buttons(target, "Accept")).toHaveLength(0);
      expect(buttons(target, "Let it expire")).toHaveLength(0);

      fill(input(target, "Description for new line"), "Consulting");
      fill(input(target, "Quantity for new line"), "1");
      fill(input(target, "Unit price for new line"), "100.00");
      button(target, "Add line").click();
      await settle(target);
      buttons(target, "Send quote").at(0)!.click();
      await settle(target);
      buttons(target, "Send quote").at(-1)!.click();
      await settle(target);

      button(target, "Decline").click();
      await settle(target);
      buttons(target, "Decline quote").at(-1)!.click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("declined");
      // Once declined, no further status action remains.
      expect(buttons(target, "Accept")).toHaveLength(0);
      expect(buttons(target, "Decline")).toHaveLength(0);

      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// a due date before the issue date is refused, not silently clamped
// ---------------------------------------------------------------------------

describe("sales · a standalone invoice cannot be due before it is issued", () => {
  it("refuses the submission and explains why", async () => {
    const { contactId } = await makeBusiness();
    const { target, dispose } = render(Sales as Component);
    try {
      await settle(target);
      button(target, "Invoices").click();
      await settle(target);

      buttons(target, "New invoice")[0]!.click();
      await settle(target);
      const d = dialog(target)!;
      select(selectField(d, "Customer"), contactId);
      fill(input(d, "Issue date"), "2026-07-20");
      fill(input(d, "Due date"), "2026-07-01");
      fill(input(d, "Description"), "Retainer — July");
      fill(input(d, "Unit price"), "500.00");

      button(target, "Issue invoice").click();
      await settle(target);
      expect(text(dialog(target)!)).toContain(
        "the due date cannot be before the issue date",
      );
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});
