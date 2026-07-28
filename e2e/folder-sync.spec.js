/**
 * The zero-infrastructure path: no node dials another. Each writes only its own
 * ops-<node_id>.jsonl into a shared folder and imports everyone else's — the
 * folder could be Dropbox, a NAS mount, or a USB stick walked between shops.
 *
 * To prove the *folder* is doing the work, the network peers created during
 * pairing are deleted first, so there is nothing left to dial.
 */

import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FlowStockNode, pairNodes } from "./helpers/node.js";
import { seedProduct, onHand } from "./helpers/seed.js";

test.describe("folder sync", () => {
  test.slow();

  let a, b, shared;

  test.beforeEach(async () => {
    [a, b] = await Promise.all([FlowStockNode.start(), FlowStockNode.start()]);
    shared = mkdtempSync(join(tmpdir(), "flowstock-folder-"));
  });

  test.afterEach(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
    rmSync(shared, { recursive: true, force: true });
  });

  test("two nodes converge through a shared folder with no network peer", async ({
    browser,
  }) => {
    await a.setup("Khumalo Hardware", "Head Office");
    const item = await seedProduct(a);
    await pairNodes(a, b, "Cape Town");
    await b.syncNow();

    // Cut the network path entirely — from here only files can carry data.
    for (const node of [a, b]) {
      for (const peer of await node.peers()) {
        await node.req("DELETE", `/api/peers/${peer.id}`);
      }
      expect(await node.peers()).toEqual([]);
      await node.setSyncSettings({
        listen: false,
        port: String(node.port),
        bind_addr: "127.0.0.1",
        secret: "",
        folder: shared,
      });
    }

    const branchA = await a.branchId("Head Office");
    const branchB = await b.branchId("Cape Town");

    // Divergent edits, both offline from each other.
    await a.adjustStock({
      variantId: item.variantId,
      branchId: branchA,
      qtyDelta: 9,
      note: "A via folder",
    });
    await b.adjustStock({
      variantId: item.variantId,
      branchId: branchB,
      qtyDelta: 6,
      note: "B via folder",
    });

    // Round one: each exports its own log and imports whatever is already there.
    const expA = await a.folderSync();
    const expB = await b.folderSync();
    expect(expA.exported).toBeGreaterThan(0);
    expect(expB.exported).toBeGreaterThan(0);

    // One file per node, named for its author — so nothing ever write-conflicts.
    const files = readdirSync(shared).sort();
    expect(files).toHaveLength(2);
    // A fresh node's id is its lowercase-hex Ed25519 public key (store.Open);
    // databases created before that change kept their uppercase ULID. Accept
    // either — the claim under test is one file per author, not the id's
    // alphabet.
    expect(files.every((f) => /^ops-[A-Za-z0-9]+\.jsonl$/.test(f))).toBe(true);
    const bootA = await a.bootstrap();
    expect(files).toContain(`ops-${bootA.node_id}.jsonl`);

    // Round two: A now picks up B's file (B's export landed after A's import).
    await a.folderSync();

    // Converged, with both movements surviving.
    const [levelsA, levelsB] = await Promise.all([
      a.stockLevels(),
      b.stockLevels(),
    ]);
    for (const levels of [levelsA, levelsB]) {
      expect(onHand(levels, item.variantId, branchA)).toBe(9);
      expect(onHand(levels, item.variantId, branchB)).toBe(6);
    }

    // Visible in both browsers, with no peer configured anywhere.
    for (const node of [a, b]) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(`${node.baseURL}/#/stock`, {
        waitUntil: "domcontentloaded",
      });
      const ledger = page.getByRole("table").nth(1);
      await expect(
        ledger.getByRole("row").filter({ hasText: "A via folder" }),
      ).toBeVisible();
      await expect(
        ledger.getByRole("row").filter({ hasText: "B via folder" }),
      ).toBeVisible();
      await ctx.close();
    }

    // Re-running is idempotent: replaying the same logs changes nothing.
    const before = (await a.rows("stock_movements")).length;
    await a.folderSync();
    await a.folderSync();
    expect((await a.rows("stock_movements")).length).toBe(before);
  });

  test("folder sync is refused when no folder is configured", async () => {
    await a.setup("Khumalo Hardware", "Head Office");
    await expect(a.folderSync()).rejects.toThrow(/no sync folder configured/);
  });
});
