// Statement import (ROADMAP.md Phase 3/4.95): "the desktop cannot run a
// preset import" was the exact gap — the CLI's `slipscan import --preset`
// had no desktop equivalent, so a statement file dropped in the app was
// stored and never parsed. This exercises the desktop wiring end to end:
// pick a preset and an account, hand over a file, and see what was actually
// imported (and, on a second pass, what was skipped as a duplicate) —
// against the real Transactions screen, not a unit of the dialog in
// isolation.
//
// No backend: outside Tauri the client serves every call from the in-memory
// mock dataset, same as every other e2e spec here. The mock does not parse
// the CSV's real bytes (neither does `document_import`'s mock) — it
// fabricates a small, deterministic batch of lines keyed by
// (account, date, description), which is enough to prove the dialog's
// wiring (preset catalog load, account/file selection, the result summary,
// and the dedupe-on-repeat behaviour) without duplicating a CSV parser in
// TypeScript.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/#/transactions", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
    null,
    { timeout: 15_000 },
  );
}

function writeCsv(): string {
  const dir = mkdtempSync(join(tmpdir(), "slipscan-e2e-statement-"));
  const path = join(dir, "statement.csv");
  writeFileSync(
    path,
    "Date,Description,Amount\n2026-07-01,COFFEE SHOP,-45.00\n2026-07-02,SALARY,12000.00\n",
  );
  return path;
}

test.describe("statement import", () => {
  test("picks a preset and an account, imports a file, and shows what landed", async ({
    page,
  }) => {
    await open(page);

    await page.getByRole("button", { name: "Import statement" }).click();
    const dialog = page.getByRole("dialog", { name: "Import a bank statement" });
    await expect(dialog).toBeVisible();

    // The catalog loads asynchronously (statementPresetList) — grouped by
    // region, SA banks before the generic family.
    const presetSelect = dialog.getByLabel("Statement preset");
    await expect(presetSelect.locator("option")).not.toHaveCount(0);
    await expect(presetSelect.locator('optgroup[label="South Africa"]')).toHaveCount(1);
    await presetSelect.selectOption("generic-iso");

    const accountSelect = dialog.getByLabel("Account for imported transactions");
    await accountSelect.selectOption({ index: 1 });

    const csvPath = writeCsv();
    await page
      .locator('input[type="file"][accept*="csv"]')
      .setInputFiles(csvPath);
    await expect(
      dialog.getByRole("button", { name: /statement\.csv/ }),
    ).toBeVisible();

    const importButton = dialog.getByRole("button", { name: "Import" });
    await expect(importButton).toBeEnabled();
    await importButton.click();

    // The result summary — real counts, not a static "done" message.
    // (`\s+` rather than a literal space: the source paragraph wraps across
    // lines, and Playwright's regex text matching does not collapse that
    // whitespace the way its plain-string matching does.)
    await expect(dialog.getByText(/3\s+transactions\s+imported/)).toBeVisible();
    await expect(dialog.getByText(/0\s+duplicates\s+skipped/)).toBeVisible();
    await expect(dialog.getByText(/statement\.csv\s+line\s+1/)).toBeVisible();

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    // Not only the dialog's own summary — the screen behind it actually
    // reflects the import once it closes.
    await expect(
      page.getByText(/statement\.csv\s+line\s+1/).first(),
    ).toBeVisible();
  });

  test("an overlapping re-import dedupes rather than silently repeating the books", async ({
    page,
  }) => {
    await open(page);
    const csvPath = writeCsv();

    async function runImport() {
      await page.getByRole("button", { name: "Import statement" }).click();
      const dialog = page.getByRole("dialog", { name: "Import a bank statement" });
      await dialog.getByLabel("Statement preset").selectOption("generic-iso");
      await dialog
        .getByLabel("Account for imported transactions")
        .selectOption({ index: 1 });
      await page
        .locator('input[type="file"][accept*="csv"]')
        .setInputFiles(csvPath);
      await dialog.getByRole("button", { name: "Import" }).click();
      return dialog;
    }

    const first = await runImport();
    await expect(first.getByText(/3\s+transactions\s+imported/)).toBeVisible();
    await first.getByRole("button", { name: "Done" }).click();
    await expect(first).toBeHidden();

    // The same file, same preset, same account — the normal case for a
    // bank export downloaded twice — must dedupe every line, not refuse
    // and not double the books.
    const second = await runImport();
    await expect(second.getByText(/0\s+transactions\s+imported/)).toBeVisible();
    await expect(second.getByText(/3\s+duplicates\s+skipped/)).toBeVisible();
  });

  test("the CLI-only gaps are named honestly in the dialog copy", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Import statement" }).click();
    const dialog = page.getByRole("dialog", { name: "Import a bank statement" });
    await expect(dialog.getByText(/custom\s+column\s+mapping/)).toBeVisible();
    await expect(
      dialog.getByText(/OFX\s+statements\s+are\s+not\s+parsed/),
    ).toBeVisible();
  });
});
