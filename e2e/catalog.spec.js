import { test, expect } from "./helpers/fixtures.js";
import { seedWorkspace } from "./helpers/seed.js";

test.describe("catalog", () => {
  test("create a product and a variant through the UI", async ({
    app,
    node,
  }) => {
    await seedWorkspace(node, { extraBranches: [] });
    const page = await app.goto("/products");

    await expect(
      page.getByRole("heading", { name: "Products", level: 1 }),
    ).toBeVisible();

    // ── product ───────────────────────────────────────────────────────────
    await page.getByRole("button", { name: "Add Product" }).click();
    const productDialog = page.getByRole("dialog");
    await expect(productDialog.getByText("Add New Product")).toBeVisible();
    await productDialog.locator("#product-name").fill("Claw Hammer");
    await productDialog
      .locator("#product-description")
      .fill("Steel shaft, rubber grip");
    // A category is deliberately NOT chosen: a fresh workspace has none, and
    // creating the first product must not require one.
    await productDialog.getByRole("button", { name: "Create" }).click();

    await expect(productDialog).toBeHidden();
    const row = page.getByRole("row").filter({ hasText: "Claw Hammer" });
    await expect(row).toBeVisible();

    // ── variant ───────────────────────────────────────────────────────────
    await row.getByRole("button", { name: "Add Variation" }).click();
    const variantDialog = page.getByRole("dialog");
    await expect(variantDialog.getByText("Add New Variation")).toBeVisible();
    await variantDialog.locator("#variant-name").fill("16oz");
    await variantDialog.locator("#variant-sku").fill("HAM-16");
    await variantDialog.locator("#variant-price").fill("199.99");
    await variantDialog.locator("#variant-cost").fill("120");
    await variantDialog.getByRole("button", { name: "Create" }).click();
    await expect(variantDialog).toBeHidden();

    // The row badge counts variations without a reload. It pluralises, so the
    // first variation reads "1 variation" (singular) — see product-table.jsx.
    await expect(row).toContainText("1 variation");

    // Expand the product to see the variant itself.
    await row.getByRole("button").first().click();
    // The variant name shares its element with the SKU badge, so match loosely.
    await expect(page.getByText("16oz")).toBeVisible();
    await expect(page.getByText("HAM-16", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Stock: 0/ })).toBeVisible();

    // ── it really persisted to SQLite, not just React state ───────────────
    const products = await node.rows("products");
    expect(products.filter((p) => !p.deleted).map((p) => p.name)).toEqual([
      "Claw Hammer",
    ]);
    const variants = await node.rows("product_variants");
    expect(variants.filter((v) => !v.deleted)).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      name: "16oz",
      sku: "HAM-16",
      price: 199.99,
    });

    // Surviving a reload is the point of an offline-first app.
    await app.reload();
    await expect(
      page.getByRole("row").filter({ hasText: "Claw Hammer" }),
    ).toBeVisible();
  });
});
