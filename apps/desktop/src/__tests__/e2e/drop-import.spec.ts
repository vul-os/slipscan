// Drag-and-drop capture (ROADMAP.md "Phase 2 ... Slip/receipt capture").
//
// DropCapture.svelte uses the Tauri webview's own drag-drop event for real
// file paths in the packaged app (see its own doc comment for why a plain
// DOM `ondrop` cannot be trusted there), and falls back to standard DOM drag
// events outside Tauri — which is exactly the environment these specs run
// in (no `__TAURI_INTERNALS__`), so this is exercising the same fallback a
// person running `vite dev` in a browser would hit, and it is real coverage
// of the browser-facing half of the feature: the overlay actually shows, the
// import actually reaches the document list (not just a class name), and an
// unsupported type is actually refused with the file's name in the reason.
//
// No backend: outside Tauri the client serves every call from the in-memory
// mock dataset, the same property every other e2e spec relies on.

import { expect, test, type Page } from "@playwright/test";

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

async function open(page: Page, route = "dashboard"): Promise<void> {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(`/#/${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
    null,
    { timeout: 15_000 },
  );
}

interface DropFile {
  name: string;
  type: string;
  content: string;
}

/** Builds a real `DataTransfer` with real `File`s inside the page, the
 * documented Playwright technique for testing HTML5 file drag-and-drop —
 * a `DataTransfer` cannot cross the Node/browser boundary any other way. */
async function dataTransferWith(page: Page, files: DropFile[]) {
  return page.evaluateHandle((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([f.content], f.name, { type: f.type }));
    return dt;
  }, files);
}

test.describe("drag-and-drop capture", () => {
  test("shows a visible drop target while dragging, then imports on drop", async ({
    page,
  }) => {
    await open(page, "dashboard");
    const overlay = page.getByTestId("drop-overlay");
    await expect(overlay).toHaveCount(0);

    const dataTransfer = await dataTransferWith(page, [
      { name: "e2e-drop-slip.pdf", type: "application/pdf", content: "fake pdf bytes" },
    ]);

    // Entering shows the target before anything is dropped — the user has
    // to be able to see a drop will land.
    await page.dispatchEvent("body", "dragenter", { dataTransfer });
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Drop to import");

    await page.dispatchEvent("body", "drop", { dataTransfer });
    await expect(overlay).toHaveCount(0);

    // A drop anywhere (this fired from Dashboard) routes to Receipts and the
    // import actually lands there — not a class name, the real document.
    await expect(page).toHaveURL(/#\/receipts$/);
    await expect(page.getByText("e2e-drop-slip.pdf")).toBeVisible();
  });

  test("imports multiple dropped files in one go", async ({ page }) => {
    await open(page, "receipts");
    const dataTransfer = await dataTransferWith(page, [
      { name: "e2e-multi-a.jpg", type: "image/jpeg", content: "one" },
      { name: "e2e-multi-b.png", type: "image/png", content: "two" },
    ]);
    await page.dispatchEvent("body", "dragenter", { dataTransfer });
    await page.dispatchEvent("body", "drop", { dataTransfer });

    await expect(page.getByText("e2e-multi-a.jpg")).toBeVisible();
    await expect(page.getByText("e2e-multi-b.png")).toBeVisible();
  });

  test("rejects an unsupported file with a clear reason, and the file picker still works", async ({
    page,
  }) => {
    await open(page, "receipts");
    const dataTransfer = await dataTransferWith(page, [
      {
        name: "e2e-drop-notes.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        content: "not a receipt",
      },
    ]);
    await page.dispatchEvent("body", "dragenter", { dataTransfer });
    await page.dispatchEvent("body", "drop", { dataTransfer });

    const alert = page.getByRole("alert").filter({ hasText: "e2e-drop-notes.docx" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("not a file type SlipScan can import");

    // Drag-and-drop is not the only way in — the picker button is untouched.
    // (Scoped to the main content: the sidebar has its own "Import receipt"
    // quick action with the same accessible name.)
    const picker = page.locator("#main").getByRole("button", { name: "Import receipt" });
    await expect(picker).toBeVisible();
    await expect(picker).toBeEnabled();
  });
});
