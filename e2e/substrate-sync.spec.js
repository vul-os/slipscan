/**
 * The same two-node convergence claim as sync-two-node.spec.js, proven with the
 * shared DMTAP sync engine deciding the merges instead of FlowStock's own CRDT.
 *
 * Two real processes with FLOWSTOCK_SUBSTRATE_SYNC=1, separate databases,
 * separate ports, edited while apart, then synced. Two things are asserted that
 * the built-in engine cannot offer:
 *
 *  1. `state_root` — the content address of each replica's whole observable
 *     state (SYNC.md §6.1). Comparing it is strictly stronger than comparing
 *     rendered rows: it covers every register, every set element and every
 *     tombstone, including the ones no screen displays. Two branches that agree
 *     on 33 bytes agree about everything.
 *  2. That the engine is actually the one deciding — `minted` and `ingested`
 *     both non-zero — so a regression that silently fell back to the built-in
 *     path fails here instead of passing quietly.
 */

import { test, expect } from "@playwright/test";
import { FlowStockNode, DMTAP_BIN, pairNodes } from "./helpers/node.js";
import { seedProduct, onHand } from "./helpers/seed.js";

// The engine is an opt-in build, so this is the only spec that does not drive
// the default binary: it drives flowstock-dmtap, built alongside it by
// global-setup.js. The default build has no engine compiled in and exits at
// startup when FLOWSTOCK_SUBSTRATE_SYNC=1 forces one on, which is the intended
// behaviour and would fail every test below with a confusing message.
const SUBSTRATE = { FLOWSTOCK_SUBSTRATE_SYNC: "1" };
const startNode = () => FlowStockNode.start({ bin: DMTAP_BIN, env: SUBSTRATE });

test.describe("two-node sync on the shared substrate engine", () => {
  test.slow(); // two processes, each compiling the engine at startup

  let a, b;

  test.beforeEach(async () => {
    [a, b] = await Promise.all([startNode(), startNode()]);
  });

  test.afterEach(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
  });

  test("the engine is the merge authority, not a passenger", async () => {
    const status = await a.substrate();
    expect(status.enabled).toBe(true);
    expect(status.state_root).toMatch(/^[0-9a-f]{66}$/); // 33 bytes, hex

    // A fresh node has no history, so both replicas start from the same root.
    expect((await b.substrate()).state_root).toBe(status.state_root);

    await a.setup("Khumalo Hardware", "Head Office");
    const after = await a.substrate();
    expect(after.minted).toBeGreaterThan(0);
    expect(after.state_root).not.toBe(status.state_root);
  });

  test("divergent offline edits converge to a byte-identical state root", async ({
    browser,
  }) => {
    await a.setup("Khumalo Hardware", "Head Office");
    const item = await seedProduct(a);
    await pairNodes(a, b, "Cape Town");
    await b.syncNow();

    const branchA = await a.branchId("Head Office");
    const branchB = await b.branchId("Cape Town");

    // ── both branches trade while apart ──────────────────────────────────
    await a.putRow("products", { name: "Tape Measure" });
    await b.putRow("products", { name: "Spirit Level" });

    // Concurrent movements at the SAME branch: the case a last-writer-wins
    // store silently drops one of, and the reason the ledger is an OR-Set
    // (§4.3) rather than a register.
    await a.adjustStock({
      variantId: item.variantId,
      branchId: branchA,
      qtyDelta: 5,
      note: "A count fix",
    });
    await b.adjustStock({
      variantId: item.variantId,
      branchId: branchA,
      qtyDelta: 3,
      note: "B count fix",
    });
    await a.adjustStock({
      variantId: item.variantId,
      branchId: branchA,
      qtyDelta: 10,
      note: "A receipt",
    });
    await b.adjustStock({
      variantId: item.variantId,
      branchId: branchB,
      qtyDelta: 7,
      note: "B receipt",
    });

    // Apart, they disagree — including about the state root.
    expect((await a.substrate()).state_root).not.toBe(
      (await b.substrate()).state_root,
    );

    // ── they meet ────────────────────────────────────────────────────────
    const results = await b.syncNow();
    expect(results[0]).toMatchObject({ ok: true });
    await a.syncNow();

    // ── the strong assertion ─────────────────────────────────────────────
    const [rootA, rootB] = await Promise.all([a.substrate(), b.substrate()]);
    expect(rootA.state_root).toBe(rootB.state_root);

    // Every op crossed as a signed envelope: nothing was merged by the
    // built-in algebra behind the engine's back.
    for (const s of [rootA, rootB]) {
      expect(s.minted).toBeGreaterThan(0);
      expect(s.ingested).toBeGreaterThan(s.minted);
      expect(s.legacy_ops).toBe(0);
      expect(s.refused).toBe(0);
    }

    // ── and the numbers a shopkeeper actually reads ──────────────────────
    const [levelsA, levelsB] = await Promise.all([
      a.stockLevels(),
      b.stockLevels(),
    ]);
    // Head Office = 5 + 3 + 10 = 18 — neither count fix was lost.
    expect(onHand(levelsA, item.variantId, branchA)).toBe(18);
    expect(onHand(levelsB, item.variantId, branchA)).toBe(18);
    expect(onHand(levelsA, item.variantId, branchB)).toBe(7);
    expect(onHand(levelsB, item.variantId, branchB)).toBe(7);

    const names = async (n) =>
      (await n.rows("products"))
        .filter((p) => !p.deleted)
        .map((p) => p.name)
        .sort();
    expect(await names(a)).toEqual([
      "Claw Hammer",
      "Spirit Level",
      "Tape Measure",
    ]);
    expect(await names(b)).toEqual(await names(a));

    // Finally, the UI both branches see.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const node of [a, b]) {
      await page.goto(`${node.baseURL}/#/stock`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        page
          .getByRole("table")
          .first()
          .getByRole("row")
          .filter({ hasText: "HAM-16" }),
      ).toContainText("18");
    }
    await ctx.close();
  });

  test("a deleted product is restored by an ordinary re-create", async () => {
    // The §4.10 selection test, from the browser's side of the API: FlowStock
    // deletes with the same write that creates, so the delete must not be a
    // death certificate. If it were, this product would stay invisible on every
    // replica after the re-create — converged, and wrong, with no error.
    await a.setup("Khumalo Hardware", "Head Office");
    await pairNodes(a, b, "Cape Town");

    const created = await a.putRow("products", { name: "Seasonal Item" });
    await b.syncNow();
    expect((await b.rows("products")).map((p) => p.name)).toContain(
      "Seasonal Item",
    );

    await a.req("DELETE", `/api/rows/products/${created.id}`);
    await b.syncNow();
    expect((await b.rows("products")).map((p) => p.name)).not.toContain(
      "Seasonal Item",
    );

    await a.putRow("products", { name: "Seasonal Item (back)" }, created.id);
    await b.syncNow();
    expect((await b.rows("products")).map((p) => p.name)).toContain(
      "Seasonal Item (back)",
    );

    expect((await a.substrate()).state_root).toBe(
      (await b.substrate()).state_root,
    );
  });
});
