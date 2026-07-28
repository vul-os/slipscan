/**
 * Builds the binaries the suite drives, once, before it runs — so every spec
 * exercises exactly what ships.
 *
 * There are two, because the shared DMTAP sync engine is an opt-in build:
 *
 *   flowstock        the default build, what a release ships (built-in CRDT)
 *   flowstock-dmtap  the same thing plus `-tags dmtap`, driven only by
 *                    substrate-sync.spec.js
 *
 * Without the second one that spec cannot run at all: it starts nodes with
 * FLOWSTOCK_SUBSTRATE_SYNC=1, and a binary with no engine compiled in exits at
 * startup rather than pretend. Rebuilds are skipped when both binaries are
 * newer than every source file, which keeps the edit/run loop fast; set
 * FLOWSTOCK_SKIP_BUILD=1 to force-skip, or point FLOWSTOCK_BIN /
 * FLOWSTOCK_DMTAP_BIN at prebuilt binaries (CI builds them as its own step).
 */

import { execSync } from "child_process";
import { existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { BIN, DMTAP_BIN, ROOT } from "./helpers/node.js";

const SOURCE_DIRS = ["src", "backend"];
const SOURCE_FILES = [
  "index.html",
  "package.json",
  "vite.config.js",
  "tailwind.config.js",
  "go.mod",
];
const IGNORED = new Set(["node_modules", "dist", ".git"]);

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = st.mtimeMs;
  for (const entry of readdirSync(path)) {
    if (IGNORED.has(entry)) continue;
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

export default function globalSetup() {
  if (process.env.FLOWSTOCK_SKIP_BUILD === "1") {
    for (const bin of [BIN, DMTAP_BIN]) {
      if (!existsSync(bin)) {
        throw new Error(`FLOWSTOCK_SKIP_BUILD=1 but no binary at ${bin}`);
      }
    }
    return;
  }

  if (existsSync(BIN) && existsSync(DMTAP_BIN)) {
    const binAge = Math.min(statSync(BIN).mtimeMs, statSync(DMTAP_BIN).mtimeMs);
    const srcAge = Math.max(
      ...SOURCE_DIRS.map((d) => newestMtime(join(ROOT, d))),
      ...SOURCE_FILES.map((f) => newestMtime(join(ROOT, f))),
    );
    if (binAge >= srcAge) {
      console.log("e2e: reusing up-to-date flowstock binaries");
      return;
    }
  }

  console.log("e2e: building flowstock (frontend embedded)…");
  execSync("npm run build:all", { cwd: ROOT, stdio: "inherit" });
  console.log(
    "e2e: building flowstock-dmtap (frontend embedded, -tags dmtap)…",
  );
  execSync("npm run build:dmtap", { cwd: ROOT, stdio: "inherit" });
}
