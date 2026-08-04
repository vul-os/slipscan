/**
 * Contacts and Catalogue against a business book — the populated path that
 * render-smoke.test.ts deliberately does not cover, because the mock's one
 * seeded book is personal and both screens refuse the route on a personal
 * book (that refusal is what render-smoke pins instead).
 *
 * This file flips the mock's book to `business` once, at the top, and every
 * test below runs against that — the same "module state is shared across the
 * suites in this file" contract destructive-and-secret.test.ts documents.
 * Vitest isolates *files* from each other by default, so this does not leak
 * into render-smoke.test.ts's personal-book assumptions.
 *
 * What is checked, beyond "it renders": the hierarchy (a product with no
 * variant says so and is not sellable; a variant survives its product's
 * deletion attempt once it has traded), role being editable in place on
 * Contacts, and every destructive action asking first — cancelling must
 * leave the row untouched, and the refusal core sends back for traded rows
 * has to read as English, not a raw error string.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import Catalogue from "../routes/Catalogue.svelte";
import Contacts from "../routes/Contacts.svelte";
import { mockApi } from "../lib/api/mock";

let fatal: string[] = [];
let consoleError: MockInstance<typeof console.error>;

function onError(e: ErrorEvent) {
  fatal.push(`window.error: ${e.message}`);
}
function onRejection(e: PromiseRejectionEvent) {
  fatal.push(`unhandledrejection: ${String(e.reason)}`);
}

beforeAll(async () => {
  // The mock's one seeded book, flipped to business — every test in this
  // file is a business book with catalogue/contacts turned on.
  const [book] = await mockApi.book_list();
  await mockApi.book_set_kind({ book_id: book.id, kind: "business" });
});

beforeEach(() => {
  fatal = [];
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
  document.body.innerHTML = "";
});

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

function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flushSync();
}

function fill(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function labelled(target: HTMLElement, label: string): HTMLInputElement {
  const found = [...target.querySelectorAll("input")].find((i) =>
    (i.closest("label")?.textContent ?? "").includes(label),
  );
  if (!found) throw new Error(`no input labelled ${JSON.stringify(label)}`);
  return found;
}

/**
 * Expand a product row by name. Not `button(target, name)`: the row's own
 * Edit/Delete buttons carry the product name in their accessible name too
 * ("Edit Cap", "Delete Cap"), so a plain substring match finds three
 * buttons, not one. Only the expand toggle carries `aria-expanded`.
 */
function openProduct(target: HTMLElement, name: string): void {
  const toggle = [
    ...target.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ].find((b) => nameOf(b).includes(name));
  if (!toggle) throw new Error(`no expandable product row for ${JSON.stringify(name)}`);
  toggle.click();
  flushSync();
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

describe("contacts · a business book", () => {
  it("opens on the honest empty state, and the hierarchy claim is not idle", async () => {
    const { target, dispose } = render(Contacts as Component);
    try {
      await settle(target);
      expect(target.querySelector("h1")?.textContent?.trim()).toBe("Contacts");
      expect(text(target)).toContain("No contacts yet");
      // The refusal copy from the personal-book state must not leak in.
      expect(text(target)).not.toContain("is for business books");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("creates a contact, edits its role in place, and both lists see a 'both'", async () => {
    const { target, dispose } = render(Contacts as Component);
    try {
      await settle(target);

      button(target, "New contact").click();
      await settle(target);
      fill(labelled(dialog(target)!, "Name"), "Acme Wholesale");
      // Role defaults to Customer; the radio group is the primary control.
      button(dialog(target)!, "Customer & supplier").click();
      button(target, "Add contact").click();
      await settle(target);

      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("Acme Wholesale");

      // Both counts include it: the model this screen exists to make
      // legible — one contact, both roles.
      const customerTab = button(target, "Customers");
      const supplierTab = button(target, "Suppliers");
      expect(nameOf(customerTab)).toContain("1");
      expect(nameOf(supplierTab)).toContain("1");

      // The role select is right there in the row, not behind a dialog.
      const roleSelect = target.querySelector<HTMLSelectElement>(
        'select[aria-label="Role for Acme Wholesale"]',
      )!;
      expect(roleSelect.value).toBe("both");
      roleSelect.value = "supplier";
      roleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(target);

      const updated = (await mockApi.contact_list({
        book_id: (await mockApi.book_list())[0]!.id,
      })).find((c) => c.name === "Acme Wholesale")!;
      expect(updated.role).toBe("supplier");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("asks before removing, and a contact with trade history is refused in English", async () => {
    const book = (await mockApi.book_list())[0]!;
    await mockApi.contact_add({
      book_id: book.id,
      role: "customer",
      name: "No History Ltd",
    });
    const traded = await mockApi.contact_add({
      book_id: book.id,
      role: "supplier",
      name: "Old Supplier Co",
    });
    await mockApi.po_create({
      book_id: book.id,
      supplier_id: traded.id,
      location_id: "loc-1",
      po_number: `PO-CT-${traded.id.slice(-4)}`,
      order_date: "2026-01-05",
      currency: book.currency,
    });

    const { target, dispose } = render(Contacts as Component);
    try {
      await settle(target);
      expect(text(target)).toContain("No History Ltd");
      expect(text(target)).toContain("Old Supplier Co");

      // Removing the traded one: the confirm asks, and the refusal is a
      // sentence, not `Error: this contact has orders or invoices...`.
      target
        .querySelector<HTMLButtonElement>('[aria-label="Remove Old Supplier Co"]')!
        .click();
      await settle(target);
      const prompt = dialog(target)!;
      expect(text(prompt)).toContain("Remove Old Supplier Co?");
      button(prompt, "Remove contact").click();
      await settle(target);
      expect(text(dialog(target)!)).toContain("orders or invoices against it");
      expect(text(dialog(target)!)).not.toMatch(/^Error:/);
      press(dialog(target)!, "Escape");
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).toContain("Old Supplier Co");

      // Removing the untraded one: the first click only asks; cancelling
      // leaves it in place; confirming actually removes it.
      const freeRemove = target.querySelector<HTMLButtonElement>(
        '[aria-label="Remove No History Ltd"]',
      )!;
      freeRemove.click();
      await settle(target);
      expect(nameOf(document.activeElement!)).toBe("Cancel");
      press(dialog(target)!, "Escape");
      await settle(target);
      expect(text(target)).toContain("No History Ltd");

      freeRemove.click();
      await settle(target);
      button(dialog(target)!, "Remove contact").click();
      await settle(target);
      expect(dialog(target)).toBeNull();
      expect(text(target)).not.toContain("No History Ltd");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

describe("catalogue · a business book", () => {
  it("opens on the honest empty state", async () => {
    const book = (await mockApi.book_list())[0]!;
    // Clean slate: an earlier test in this file may have left rows behind.
    for (const p of await mockApi.product_list({ book_id: book.id })) {
      await mockApi.product_delete({ id: p.id }).catch(() => {});
    }
    const { target, dispose } = render(Catalogue as Component);
    try {
      await settle(target);
      expect(target.querySelector("h1")?.textContent?.trim()).toBe("Catalogue");
      expect(text(target)).toContain("No products yet");
      expect(text(target)).not.toContain("is for business books");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("makes the product/variant hierarchy legible: a product with no variant is not sellable", async () => {
    const { target, dispose } = render(Catalogue as Component);
    try {
      await settle(target);

      button(target, "New product").click();
      await settle(target);
      fill(labelled(dialog(target)!, "Name"), "T-shirt");
      button(target, "Add product").click();
      await settle(target);

      expect(text(target)).toContain("T-shirt");
      expect(text(target)).toContain("not sellable yet");
      expect(text(target)).toContain("0 variants");

      // Expand it and add a variant — the SKU, price and reorder point that
      // stock and every order line actually reference.
      openProduct(target, "T-shirt");
      await settle(target);
      button(target, "Add variant").click();
      await settle(target);

      const form = target.querySelector("form")!;
      fill(labelled(form, "SKU"), "TS-BLU-L");
      fill(labelled(form, "Name"), "Blue / L");
      fill(labelled(form, "Price"), "199.00");
      fill(labelled(form, "Cost price"), "80.00");
      button(target, "Add variant").click();
      await settle(target);

      expect(text(target)).toContain("TS-BLU-L");
      expect(text(target)).toContain("Blue / L");
      expect(text(target)).not.toContain("not sellable yet");
      expect(text(target)).toContain("1 variant");
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);

  it("refuses to delete a traded variant or its product, in English, and a category delete leaves the product uncategorised", async () => {
    const book = (await mockApi.book_list())[0]!;
    const cat = await mockApi.product_category_create({
      book_id: book.id,
      name: "Apparel",
    });
    const product = await mockApi.product_create({
      book_id: book.id,
      name: "Cap",
      product_category_id: cat.id,
    });
    const variant = await mockApi.product_variant_add({
      product_id: product.id,
      sku: "CAP-01",
      name: "One size",
      currency: book.currency,
      price_minor: 15000,
    });
    await mockApi.stock_movement_record({
      variant_id: variant.id,
      location_id: "loc-1",
      qty_delta: 5,
      kind: "receipt",
    });

    const { target, dispose } = render(Catalogue as Component);
    try {
      await settle(target);
      expect(text(target)).toContain("Cap");
      expect(text(target)).toContain("Apparel");

      // The product delete is refused because a variant underneath it has
      // traded — the cascade rule, made visible.
      button(target, "Delete Cap").click();
      await settle(target);
      expect(text(dialog(target)!)).toContain("This also deletes its 1 variant");
      button(dialog(target)!, "Delete product").click();
      await settle(target);
      expect(text(dialog(target)!)).toContain(
        "stock movements or order lines against it",
      );
      expect(text(dialog(target)!)).not.toMatch(/^Error:/);
      press(dialog(target)!, "Escape");
      await settle(target);
      expect(text(target)).toContain("Cap");

      // Deleting the variant directly is refused the same way.
      openProduct(target, "Cap");
      await settle(target);
      button(target, "Delete variant One size").click();
      await settle(target);
      button(dialog(target)!, "Delete variant").click();
      await settle(target);
      expect(text(dialog(target)!)).toContain("trade history");
      press(dialog(target)!, "Escape");
      await settle(target);
      expect(text(target)).toContain("One size");

      // Deleting the category leaves the product behind, uncategorised.
      button(target, "Categories").click();
      await settle(target);
      button(dialog(target)!, "Delete category Apparel").click();
      await settle(target);
      button(dialog(target)!, "Delete category").click();
      await settle(target);
      expect(dialog(target)).toBeNull();

      const after = await mockApi.product_get({ id: product.id });
      expect(after.product_category_id).toBeNull();
      expect(fatal, fatal.join(" | ")).toEqual([]);
    } finally {
      dispose();
    }
  }, 20_000);
});
