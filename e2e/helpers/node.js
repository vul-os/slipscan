/**
 * FlowStock E2E node harness.
 *
 * Every test drives the REAL Go binary: a single self-contained `flowstock`
 * process with the frontend embedded, pointed at a throwaway data dir via
 * FLOWSTOCK_DATA_DIR and a free port via FLOWSTOCK_PORT. Nothing is mocked and
 * nothing is shared between tests, so specs can run in parallel and a two-node
 * sync test is just two of these.
 *
 * Deliberately NOT the demo driver: the browser only falls back to seeded
 * in-memory data when served from the Vite dev server on port 5173 (see
 * src/services/api.js). Served by the Go binary on any other port, the UI uses
 * the HTTP driver and everything is real — SQLite, the oplog, the sync mesh.
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "fs";
import { tmpdir } from "os";
import net from "net";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", "..");
export const BIN = process.env.FLOWSTOCK_BIN || join(ROOT, "flowstock");

// The shared DMTAP sync engine is an opt-in build (`-tags dmtap`), so the
// default binary cannot run it — forcing FLOWSTOCK_SUBSTRATE_SYNC=1 on it is
// fatal at startup, by design. substrate-sync.spec.js therefore drives a second
// binary, built alongside the first by global-setup.js.
export const DMTAP_BIN =
  process.env.FLOWSTOCK_DMTAP_BIN || join(ROOT, "flowstock-dmtap");

/** Ask the OS for a free port. */
async function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * A running FlowStock instance plus a thin API client for it. The client is
 * used for arrange/assert steps that are not the subject of a test (seeding a
 * catalog, reading back the ledger); the flows under test are driven through
 * the browser.
 */
export class FlowStockNode {
  constructor({ port, dataDir, proc }) {
    this.port = port;
    this.dataDir = dataDir;
    this.proc = proc;
    this.baseURL = `http://127.0.0.1:${port}`;
    this.logs = [];
  }

  /**
   * Boot a node on a free port against a fresh temp data dir. `opts.bin`
   * selects a different build (DMTAP_BIN); everything else is the default one.
   */
  static async start(opts = {}) {
    const bin = opts.bin || BIN;
    if (!existsSync(bin)) {
      throw new Error(
        `flowstock binary not found at ${bin} — run \`npm run build:all\` (global setup does this automatically)`,
      );
    }
    const port = opts.port || (await freePort());
    const dataDir =
      opts.dataDir || mkdtempSync(join(tmpdir(), "flowstock-e2e-"));
    const proc = spawn(bin, [], {
      cwd: dataDir, // keeps config-file discovery away from the repo
      env: {
        ...process.env,
        FLOWSTOCK_DATA_DIR: dataDir,
        FLOWSTOCK_PORT: String(port),
        FLOWSTOCK_HOST: "127.0.0.1",
        // Per-node environment, for the flags a test needs to set on the real
        // process rather than simulate (FLOWSTOCK_SUBSTRATE_SYNC).
        ...(opts.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const node = new FlowStockNode({ port, dataDir, proc });
    proc.stdout.on("data", (d) => node.logs.push(String(d)));
    proc.stderr.on("data", (d) => node.logs.push(String(d)));
    proc.on("exit", (code) => {
      node.exited = code;
    });
    await node.waitReady();
    return node;
  }

  async waitReady(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited !== undefined) {
        throw new Error(
          `flowstock exited early (code ${this.exited}):\n${this.logs.join("")}`,
        );
      }
      try {
        const res = await fetch(`${this.baseURL}/api/bootstrap`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `flowstock did not become ready on ${this.baseURL}:\n${this.logs.join("")}`,
    );
  }

  async stop() {
    if (this.proc && this.exited === undefined) {
      this.proc.kill("SIGTERM");
      const deadline = Date.now() + 5000;
      while (this.exited === undefined && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (this.exited === undefined) this.proc.kill("SIGKILL");
    }
    if (this.dataDir && !process.env.FLOWSTOCK_KEEP_DATA) {
      rmSync(this.dataDir, { recursive: true, force: true });
    }
  }

  // ── HTTP client ───────────────────────────────────────────────────────────

  async req(method, path, body) {
    const res = await fetch(`${this.baseURL}${path}`, {
      method,
      headers:
        body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} → ${res.status}: ${text.trim()}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  bootstrap() {
    return this.req("GET", "/api/bootstrap");
  }

  setup(businessName, branchName) {
    return this.req("POST", "/api/setup", {
      business_name: businessName,
      branch_name: branchName,
    });
  }

  join({ url, secret, businessName = "", branchName }) {
    return this.req("POST", "/api/workspace/join", {
      url,
      secret,
      business_name: businessName,
      branch_name: branchName,
    });
  }

  rows(tbl) {
    return this.req("GET", `/api/rows/${tbl}`);
  }

  putRow(tbl, data, id = "") {
    return this.req("POST", `/api/rows/${tbl}`, { id, data });
  }

  stockLevels() {
    return this.req("GET", "/api/stock/levels");
  }

  adjustStock({ variantId, branchId, qtyDelta, kind = "receive", note = "" }) {
    return this.req("POST", "/api/stock/adjust", {
      variant_id: variantId,
      branch_id: branchId,
      qty_delta: qtyDelta,
      kind,
      note,
    });
  }

  syncSettings() {
    return this.req("GET", "/api/sync/settings");
  }

  /**
   * The shared sync engine's status, including `state_root` — the content
   * address of this replica's whole observable state (SYNC.md §6.1). Two
   * converged branches agree on it byte for byte.
   */
  substrate() {
    return this.req("GET", "/api/substrate");
  }

  setSyncSettings(patch) {
    return this.req("POST", "/api/sync/settings", patch);
  }

  newSecret() {
    return this.req("GET", "/api/sync/secret/new").then((r) => r.secret);
  }

  peers() {
    return this.req("GET", "/api/peers");
  }

  /**
   * Trigger a sync round explicitly. The product also syncs on a 60s
   * background timer; tests never wait for it — they drive this, so timing is
   * deterministic and the suite stays fast.
   */
  syncNow(peerId = "") {
    return this.req("POST", "/api/sync/now", { peer_id: peerId });
  }

  folderSync() {
    return this.req("POST", "/api/sync/folder", {});
  }

  /** Branch id by name, from this node's view of the workspace. */
  async branchId(name) {
    const branches = await this.rows("branches");
    const b = branches.find((x) => x.name === name && !x.deleted);
    if (!b) {
      throw new Error(
        `no branch named ${JSON.stringify(name)} on ${this.baseURL} (have: ${branches
          .map((x) => x.name)
          .join(", ")})`,
      );
    }
    return b.id;
  }
}

/**
 * Pair two nodes the way a real second branch is onboarded: the first node
 * publishes a shared secret, the second joins with it over the mesh (which
 * enrolls Ed25519 keys both ways). Returns the secret.
 */
export async function pairNodes(a, b, branchName) {
  const secret = await a.newSecret();
  await a.setSyncSettings({
    listen: true,
    port: String(a.port),
    bind_addr: "127.0.0.1",
    secret,
  });
  await b.join({ url: a.baseURL, secret, branchName });
  return secret;
}

/** Wait until `fn()` returns truthy, polling. No arbitrary sleeps. */
export async function until(
  fn,
  { timeout = 10000, interval = 50, message } = {},
) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${message || "condition"} (last: ${JSON.stringify(last)})`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Number of files in a dir (used by the folder-sync spec). */
export function dirFiles(dir) {
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function isFresherThan(target, sources) {
  if (!existsSync(target)) return false;
  const t = statSync(target).mtimeMs;
  return sources.every((s) => !existsSync(s) || statSync(s).mtimeMs <= t);
}
