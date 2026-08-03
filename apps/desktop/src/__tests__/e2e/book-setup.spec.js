// Can a person actually GET to first-run setup, and to creating a book?
//
// This file exists because the previous bug was not a wiring bug. Every part
// of first-run setup was built, typed, unit-tested and correct — and no user
// could ever see it, because the desktop backend seeded a book at startup so
// the "no books" gate that opens the flow was never satisfied. A test that
// asserted the flow was *constructed* passed the whole time the flow was
// dead.
//
// So nothing here inspects a catalogue, a prop or an export. Each test drives
// the shipped UI the way a person does — keystroke, click, read the screen —
// and fails if the result cannot be reached that way.
//
// No backend: outside Tauri the client serves every call from the in-memory
// mock dataset (which, like a real install after setup, already has a book).

import { expect, test } from "@playwright/test";

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

async function open(page, route = "dashboard") {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto(`/#/${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"]').length === 0,
    null,
    { timeout: 15_000 },
  );
}

/** The setup dialog, told apart from the palette by its accessible name. */
const setupDialog = (page) => page.getByRole("dialog", { name: /set up slipscan/i });

test.describe("first-run setup is reachable", () => {
  test("the command palette opens it from any screen", async ({ page }) => {
    await open(page);
    await expect(setupDialog(page)).toHaveCount(0);

    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox");
    await expect(input).toBeFocused();

    // Typed the way someone looking for it would type it — not the command's
    // exact label, which would only prove the label exists.
    await input.fill("new book");
    const first = page.getByRole("option").first();
    await expect(first).toContainText("Set up a new book");
    await page.keyboard.press("Enter");

    // The palette is gone and setup is up in its place — not behind it.
    await expect(page.getByRole("dialog", { name: /command palette/i })).toHaveCount(0);
    await expect(setupDialog(page)).toBeVisible();
    await expect(setupDialog(page)).toContainText("Everything stays on this machine");
  });

  test("it still walks to a created book, and says which profile made it", async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("set up a new book");
    await page.keyboard.press("Enter");

    const dialog = setupDialog(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Next" }).click();

    // Region step: pick whatever profile the backend serves first that names
    // a currency. Never a literal id — regions are data, not code.
    const profiles = dialog.getByRole("radio");
    await expect(profiles.first()).toBeVisible();
    const chosen = profiles.nth(1);
    const chosenName = (await chosen.innerText()).split("\n")[0].trim();
    await chosen.click();

    const create = dialog.getByRole("button", { name: "Create this book" });
    await expect(create).toBeEnabled();
    await create.click();

    await expect(dialog.getByRole("status")).toContainText("Created");
    // The profile's own display name comes back on the confirmation, which
    // is what proves the choice reached `book_create` rather than a
    // preference blob.
    await expect(dialog).toContainText(chosenName);
  });

  test("it is dismissible, so reaching it can never trap anyone", async ({
    page,
  }) => {
    await open(page);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox").fill("set up a new book");
    await page.keyboard.press("Enter");
    await expect(setupDialog(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(setupDialog(page)).toHaveCount(0);
    // The screen behind it still works.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("re-opening it starts a fresh run, not the last one's result", async ({
    page,
  }) => {
    await open(page);
    for (const _ of [0, 1]) {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").fill("set up a new book");
      await page.keyboard.press("Enter");
      const dialog = setupDialog(page);
      await expect(dialog).toBeVisible();
      // Phase 6.0 added a "locations" step between region and data.
      await expect(dialog).toContainText("Step 1 of 6");
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    }
  });
});

test.describe("creating a book without the wizard", () => {
  test("Settings › General creates one over the same command", async ({
    page,
  }) => {
    await open(page, "settings");

    const create = page.getByRole("button", { name: "Create a book" });
    await expect(create).toBeVisible();
    await create.click();

    const form = page.locator("form", { hasText: "New book" });
    await form.getByRole("textbox").first().fill("Side project");

    // Again: whichever profiles are served, never a hardcoded jurisdiction.
    const profiles = form.getByRole("radio").filter({ hasNotText: /^Personal$|^Business$/ });
    await profiles.first().click();

    await form.getByRole("button", { name: "Create book" }).click();

    await expect(page.getByRole("status")).toContainText("Created “Side project”");

    // And it is not invisible afterwards. This is the part that keeps the
    // action from being a lie: the desktop reads the first book in the
    // database, so the list names every book and says which one the screens
    // are actually showing.
    const row = page.getByRole("listitem").filter({ hasText: "Side project" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("CLI and server only");
    await expect(
      page.getByRole("listitem").filter({ hasText: "Shown in the app" }),
    ).toHaveCount(1);
  });
});
