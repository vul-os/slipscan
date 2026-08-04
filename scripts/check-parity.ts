#!/usr/bin/env node
// Verify docs/parity.json against the code it claims to describe.
//
// WHY THIS EXISTS. parity.json enumerates three surfaces — HTTP routes, desktop
// IPC commands, and the client.ts wrappers over them — and API.md quotes its
// counts as fact. Nothing checked either against the source, and both drifted
// the moment anything shipped: a whole feature (Phase 6.5 sales & invoicing)
// landed 21 IPC commands with no client wrapper and nobody noticed, and the
// counts sat three features stale while reading as current. A hand-maintained
// inventory of generated-looking facts is a document that is wrong by default.
//
// It derives each surface from the source rather than trusting the file, so the
// failure mode is a red build rather than a confident, wrong number.
//
// The parsing is deliberately literal — no Rust or TS parser, just the exact
// registration forms these files use — and every parse asserts it found a
// plausible number of things. A regex that silently matches nothing is the
// standard way a check like this passes while verifying nothing, so an
// implausible count is a hard failure here, not a shrug.
//
// Usage:
//   node scripts/check-parity.ts           report drift, exit 1 if any
//   node scripts/check-parity.ts --write   rewrite parity.json's lists/counts

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

interface CountedList {
  count: number;
}

interface ParityFile {
  "//": string[];
  http: CountedList & { prefix: string; routes: string[]; public: string[]; aliases: Record<string, string> };
  ipc: CountedList & { commands: string[] };
  client: CountedList & { calls: string[] };
  renames: Record<string, string>;
  missing_from_ipc: CountedList & { operations: string[] };
  desktop_only: CountedList & { commands: string[] };
  missing_from_client?: CountedList & { operations: string[] };
}

/** A parse that finds far too little has failed, not succeeded. */
function atLeast<T>(what: string, list: T[], floor: number): T[] {
  if (list.length < floor) {
    console.error(
      `check-parity: parsing ${what} found only ${list.length} (expected >= ${floor}).\n` +
        `  The registration form probably changed. Fix the parser — do NOT lower this floor,\n` +
        `  which would turn this check into one that passes while reading nothing.`,
    );
    process.exit(2);
  }
  return list;
}

// --- HTTP routes -----------------------------------------------------------
// `.route("/name", post(handler))`, including the multi-line form where the
// path sits on its own line. Matching only single-line `.route("` misses six of
// them, which is how "141 routes" was ever written down.
function httpRoutes(): string[] {
  const src = read("crates/slipscan-server/src/routes.rs");
  // The capture group is mandatory in the pattern, so it is always present
  // when a match is found; filtered here only to satisfy the element type.
  const found = [...src.matchAll(/\.route\(\s*"\/([a-z0-9_]+)"/g)]
    .map((m) => m[1])
    .filter((s): s is string => Boolean(s));
  atLeast("HTTP routes", found, 100);
  // `/health` is public and outside the versioned surface; parity.json counts
  // the /api/v1 operations, and API.md names /health separately.
  return [...new Set(found)].filter((r) => r !== "health").sort();
}

// --- desktop IPC commands --------------------------------------------------
// The single `tauri::generate_handler![...]` list in lib.rs is the only thing
// that actually registers a command, so it is the only honest source.
function ipcCommands(): string[] {
  const src = read("apps/desktop/src-tauri/src/lib.rs");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(src);
  // The capture group is mandatory in the pattern, so if `block` matched at
  // all, `block[1]` is always present — but the array type is `string |
  // undefined` per element, so this still has to be checked explicitly.
  if (!block || block[1] === undefined) {
    console.error("check-parity: no generate_handler![...] block in lib.rs");
    process.exit(2);
  }
  const found = block[1]
    .replace(/\/\/[^\n]*/g, "")
    .split(",")
    .map((s) => s.trim().split("::").pop())
    .filter((s): s is string => Boolean(s));
  atLeast("IPC commands", found, 100);
  return [...new Set(found)].sort();
}

// --- client.ts wrappers ----------------------------------------------------
// Every wrapper reaches the backend through `call("command_name", …)`.
function clientCalls(): string[] {
  const src = read("apps/desktop/src/lib/api/client.ts");
  // Same guarantee as httpRoutes(): the capture group is mandatory.
  const found = [...src.matchAll(/\bcall\(\s*"([a-z0-9_]+)"/g)]
    .map((m) => m[1])
    .filter((s): s is string => Boolean(s));
  atLeast("client.ts wrappers", found, 100);
  return [...new Set(found)].sort();
}

// --- compare ---------------------------------------------------------------
const routes = httpRoutes();
const commands = ipcCommands();
const calls = clientCalls();

const parityPath = "docs/parity.json";
const parity = JSON.parse(read(parityPath)) as ParityFile;

// Two deliberate name mismatches the file already documents, and both have to
// be honoured or this check invents drift that is not there:
//
//   renames  an IPC command whose HTTP route is spelled differently
//            (`report_vat_summary` is the desktop's name for `report_tax`)
//   aliases  a route kept as a deprecated second spelling of another route
//            (`report_vat` -> `report_tax`), which is why API.md says 144
//            routes but 143 distinct handlers
const renames: Record<string, string> = parity.renames ?? {};
const aliases: Record<string, string> = parity.http?.aliases ?? {};
const httpNameOf = (command: string): string => renames[command] ?? command;
const canonicalRoute = (route: string): string => aliases[route] ?? route;

// `health` is registered as an IPC command, wrapped in client.ts like any
// other, and also served as a public route — but `httpRoutes()` drops it,
// because parity.json counts the /api/v1 surface and API.md names /health
// separately. Without this it would look desktop-only, which is an artefact of
// that filtering rather than real drift. It is genuinely wrapped, so it needs
// no exemption on the client axis.
const NOT_DRIFT = new Set(["health"]);

const routeTargets = new Set(routes.map(canonicalRoute));
const commandTargets = new Set(commands.map(httpNameOf));

const missingFromClient = commands
  .filter((c) => !calls.includes(c) && !NOT_DRIFT.has(c))
  .sort();
const missingFromIpc = [...new Set(routes.map(canonicalRoute))]
  .filter((r) => !commandTargets.has(r))
  .sort();
const desktopOnly = commands
  .filter((c) => !NOT_DRIFT.has(c) && !routeTargets.has(httpNameOf(c)))
  .sort();

type ExpectedEntry = [actual: string[], listed: string[], count: number];

const expected: Record<string, ExpectedEntry> = {
  "http.routes": [routes, parity.http.routes, parity.http.count],
  "ipc.commands": [commands, parity.ipc.commands, parity.ipc.count],
  "client.calls": [calls, parity.client.calls, parity.client.count],
  "missing_from_ipc.operations": [
    missingFromIpc,
    parity.missing_from_ipc.operations,
    parity.missing_from_ipc.count,
  ],
  "desktop_only.commands": [
    desktopOnly,
    parity.desktop_only.commands,
    parity.desktop_only.count,
  ],
  "missing_from_client.operations": [
    missingFromClient,
    parity.missing_from_client?.operations ?? [],
    parity.missing_from_client?.count ?? 0,
  ],
};

const problems: string[] = [];
for (const [label, [actual, listed, count]] of Object.entries(expected)) {
  const only = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const missing = only(actual, listed);
  const extra = only(listed, actual);
  if (missing.length) problems.push(`${label}: in the code but not listed — ${missing.join(", ")}`);
  if (extra.length) problems.push(`${label}: listed but not in the code — ${extra.join(", ")}`);
  if (count !== listed.length)
    problems.push(`${label}: count says ${count}, list holds ${listed.length}`);
}

// The arithmetic API.md states as fact.
if (calls.length + missingFromClient.length !== commands.length) {
  problems.push(
    `client wrappers (${calls.length}) + unwrapped (${missingFromClient.length}) != commands (${commands.length})`,
  );
}

if (process.argv.includes("--write")) {
  parity.http.routes = routes;
  parity.http.count = routes.length;
  parity.ipc.commands = commands;
  parity.ipc.count = commands.length;
  parity.client.calls = calls;
  parity.client.count = calls.length;
  parity.missing_from_ipc.operations = missingFromIpc;
  parity.missing_from_ipc.count = missingFromIpc.length;
  parity.desktop_only.commands = desktopOnly;
  parity.desktop_only.count = desktopOnly.length;
  parity.missing_from_client = {
    count: missingFromClient.length,
    operations: missingFromClient,
  };
  writeFileSync(join(ROOT, parityPath), `${JSON.stringify(parity, null, 2)}\n`);
  console.log(
    `check-parity: wrote ${parityPath} — ${routes.length} routes, ${commands.length} IPC commands, ` +
      `${calls.length} client wrappers, ${missingFromClient.length} unwrapped.`,
  );
  process.exit(0);
}

if (problems.length) {
  console.error("check-parity: docs/parity.json does not match the code:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nRe-derive it with: node scripts/check-parity.ts --write");
  console.error("Then check docs/API.md, which quotes these counts in prose.");
  process.exit(1);
}

console.log(
  `check-parity: ${routes.length} HTTP routes, ${commands.length} IPC commands, ` +
    `${calls.length} client wrappers (${missingFromClient.length} unwrapped) — parity.json agrees.`,
);
