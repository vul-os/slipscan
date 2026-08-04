// Device identity and pairing, driven in a real browser.
//
// Identity and pairing shipped reachable only from the CLI and the HTTP
// surface; Settings › Devices is the desktop surface for them. Two things make
// this worth a browser test rather than only a jsdom one:
//
//   * the pairing ceremony is a *sequence a person walks* — mint, carry, type
//     nine words, carry back, type nine words — and each step is a claim the
//     product makes about what authenticates a pairing;
//   * the tab lives behind the Settings tab strip, so the real bundle's tab
//     switching is part of the path.
//
// No backend: outside Tauri every call is served by src/lib/api/mock.ts. The
// harness is one device and pairing with yourself is refused (by core, and by
// the mock), so the counterpart's blobs come from that module's own
// `mockForeignInvite` / `mockForeignAcceptance` — a human carrying a blob
// across the room, simulated. They are imported through the page so the test
// and the app share one module instance, and therefore one dataset.

import { expect, test, type Locator, type Page } from "@playwright/test";

const FROZEN_NOW = new Date("2026-07-20T09:00:00Z");

/** The shape `mockForeignInvite` / `mockForeignAcceptance` return — see src/lib/api/mock.ts. */
interface MockPairingBlob {
  blob: string;
  keyname: string;
}

/**
 * The mock module's shape, resolved through this file's own relative path
 * (which tsc can follow) rather than the browser-root path the evaluate()
 * calls below actually import at runtime ("/src/..." — how Vite serves the
 * project root, which is not a path relative to this file and so is not
 * something ordinary module resolution can find).
 */
type MockApi = typeof import("../../lib/api/mock");

/** Open Settings and switch to the Devices tab. */
async function openDevices(page: Page): Promise<Locator> {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto("/#/settings", { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(
      () => document.querySelectorAll('[aria-busy="true"]').length === 0,
      null,
      { timeout: 15_000 },
    )
    .catch(() => {
      throw new Error("settings never finished loading (skeletons remain)");
    });
  await page.getByRole("tab", { name: "Devices" }).click();
  return page.locator("main");
}

/**
 * Both helpers below import the mock module *inside the browser*, by its
 * browser-root path ("/src/..." — how Vite serves the project root), so the
 * test and the app share one module instance and therefore one dataset (see
 * the file banner). That path is not relative to this file, so ordinary
 * module resolution can't type it; concatenating it rather than writing one
 * string literal keeps tsc from trying (and failing) to statically resolve
 * that runtime-only specifier itself, and the explicit cast to `MockApi`
 * (resolved through this file's own relative path instead) gives the awaited
 * result its real type regardless — nothing here falls back to `any`.
 */
const MOCK_MODULE_PATH = "/src/lib/api/mock" + ".ts";

/** An invite as though another device minted it. */
const foreignInvite = (page: Page, label: string): Promise<MockPairingBlob> =>
  page.evaluate(
    ([path, l]) =>
      (import(/* @vite-ignore */ path) as Promise<MockApi>).then((m) =>
        m.mockForeignInvite(l),
      ),
    [MOCK_MODULE_PATH, label] as const,
  );

/** The answer the other device would carry back to `blob`. */
const foreignAcceptance = (
  page: Page,
  blob: string,
): Promise<MockPairingBlob> =>
  page.evaluate(
    ([path, b]) =>
      (import(/* @vite-ignore */ path) as Promise<MockApi>).then((m) =>
        m.mockForeignAcceptance(b),
      ),
    [MOCK_MODULE_PATH, blob] as const,
  );

function watchForErrors(page: Page): {
  pageErrors: string[];
  consoleErrors: string[];
} {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  return { pageErrors, consoleErrors };
}

test("the devices tab leads with the fact that nothing syncs", async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = watchForErrors(page);
  const main = await openDevices(page);

  // The disclaimer is the feature. A paired row with a green dot is exactly
  // what a person reads as "my data is on both machines".
  await expect(main).toContainText("Nothing syncs between devices yet");
  await expect(main).toContainText("no replication log, no transport");

  // No accounts, said plainly — the thing everyone assumes must exist.
  await expect(main).toContainText(
    "no email, no password, no username, no login",
  );

  // This device, with the nine-word key-name given room, and its job stated
  // where it is shown.
  await expect(main).toContainText("This device's key-name");
  await expect(main).toContainText("is the authentication");
  await expect(main).toContainText("Alex's laptop");

  // Peers, tombstone included, and no invented liveness.
  await expect(main).toContainText("home server");
  await expect(main).toContainText("revoked");
  await expect(main).toContainText("never when a device was last seen");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
  expect(consoleErrors, consoleErrors.join(" | ")).toHaveLength(0);
});

test("pairing is a sequence of hand-carried blobs and one typed comparison", async ({
  page,
}) => {
  const { pageErrors, consoleErrors } = watchForErrors(page);
  const main = await openDevices(page);

  // 1. Mint an invite. The blob is a credential, and the screen says so where
  //    it is shown rather than in a footnote.
  await page.getByRole("button", { name: "Create invite" }).click();
  const inviteBox = page.getByLabel(
    "Pairing invite to carry to the other device",
  );
  await expect(inviteBox).toBeVisible();
  const blob = await inviteBox.inputValue();
  expect(blob.startsWith("ss-pair1.")).toBe(true);
  await expect(main).toContainText("Treat this like a password until it is used");
  await expect(main).toContainText("single-use claim token");
  // It can be withdrawn — the answer to "that went to the wrong window".
  await expect(page.getByRole("button", { name: "Withdraw" }).first()).toBeVisible();

  // 2. The other device answers. Bringing the answer back is not enough on its
  //    own: the action stays inert until the key-name is typed, because that
  //    comparison is the whole authentication.
  const answer = await foreignAcceptance(page, blob);
  await page.getByLabel("Acceptance blob from the other device").fill(answer.blob);
  const pair = page.getByRole("button", { name: "Compare and pair" }).first();
  await expect(pair).toBeDisabled();

  // 3. A wrong key-name is refused, and pins nothing.
  const impostor = await foreignInvite(page, "not the right device");
  const keynameField = page
    .getByPlaceholder("nine words, exactly as they appear there")
    .first();
  await keynameField.fill(impostor.keyname);
  await pair.click();
  await expect(main).toContainText("key-name mismatch");
  await expect(main).not.toContainText("Paired with");

  // 4. The right one pairs — and the success message immediately says what did
  //    *not* just happen.
  await keynameField.fill(answer.keyname);
  await pair.click();
  await expect(main).toContainText("Paired with");
  await expect(main).toContainText("there is no sync to start");
  // The spent blob is off the screen.
  await expect(main).not.toContainText(blob);
  // And the invite it answered is burnt rather than left live.
  await expect(main).toContainText("redeemed");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
  expect(consoleErrors, consoleErrors.join(" | ")).toHaveLength(0);
});

test("the accept side refuses a substituted invite", async ({ page }) => {
  const { pageErrors } = watchForErrors(page);
  const main = await openDevices(page);

  // The invite the user was actually sent…
  const genuine = await foreignInvite(page, "phone");
  // …and the one an attacker swapped in. It is signed perfectly well under its
  // own key; nothing about the bytes gives it away. Only the nine words do.
  const substituted = await foreignInvite(page, "phone");

  await page
    .getByLabel("Pairing invite from the other device")
    .fill(substituted.blob);
  const keyname = page
    .getByPlaceholder("nine words, exactly as they appear there")
    .last();
  await keyname.fill(genuine.keyname);
  await page.getByRole("button", { name: "Compare and pair" }).last().click();

  await expect(main).toContainText("key-name mismatch");
  await expect(main).not.toContainText("carry this answer back");

  // The genuine invite still pairs, so the refusal was the comparison and not
  // the screen being broken.
  await page
    .getByLabel("Pairing invite from the other device")
    .fill(genuine.blob);
  await keyname.fill(genuine.keyname);
  await page.getByRole("button", { name: "Compare and pair" }).last().click();
  await expect(main).toContainText("carry this answer back");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
});

test("bank-alert email says the engine ships and the bank patterns do not", async ({
  page,
}) => {
  const { pageErrors } = watchForErrors(page);
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.goto("/#/settings", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Connections" }).click();
  const main = page.locator("main");

  await expect(main).toContainText("Bank-alert emails");
  // The caveat that makes the rest true.
  await expect(main).toContainText("No bank patterns ship with SlipScan");
  await expect(main).toContainText("No mailrules pack for your bank");
  // The command, with an account already in it.
  await expect(main).toContainText("slipscan mail-sync --alerts --account");
  // Multi-account routing exists in the library and nothing calls it.
  await expect(main).toContainText("One account per run");
  await expect(main).toContainText("not wired to anything");
  // And the mailbox form above is not this sync's configuration.
  await expect(main).toContainText("mail.imap.config");

  expect(pageErrors, pageErrors.join(" | ")).toHaveLength(0);
});
