#!/usr/bin/env node
// Report every public CoreService method that no production surface can reach.
//
// WHY THIS EXISTS. Phases 6.2, 6.3a and 6.3b shipped contacts, the product
// catalogue and the stock ledger — schema, repo layer, service layer, tests,
// all finished — and then wired **almost none of it to anything**. Of core's 7
// contact operations 1 is reachable; of 16 catalogue operations 1; of 9 stock
// operations 0. Meanwhile 6.4 and 6.5 wired every one of their ~38 operations
// to all three surfaces — onto foundations a user cannot create a row in. An
// order needs a contact_id and a stock line needs a variant_id, and no surface
// could produce either, so the features were unusable end to end while every
// test, every count and every doc read green.
//
// Nothing detected that, because each layer was individually complete. It is
// only visible by asking the whole-product question this script asks: can a
// user actually get at this?
//
// Test code is stripped before matching. A method called only from a
// `#[cfg(test)] mod` is exactly the thing that looks reachable and is not —
// counting those is how this stayed invisible through four phases.
//
// Usage:
//   node scripts/check-reachable.mjs            report, exit 1 if worse than the baseline
//   node scripts/check-reachable.mjs --list     print the full reachability table
//   node scripts/check-reachable.mjs --write    record the current counts as the baseline

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const BASELINE = "docs/reachability.json";

/** Remove `#[cfg(test)] mod … { … }` blocks by brace matching. */
function stripTests(src) {
  let out = "";
  let i = 0;
  for (;;) {
    const m = /#\[cfg\(test\)\]\s*\nmod \w+ \{/.exec(src.slice(i));
    if (!m) return out + src.slice(i);
    const start = i + m.index;
    out += src.slice(i, start);
    let depth = 0;
    let j = i + m.index + m[0].length - 1;
    for (; j < src.length; j += 1) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
}

const core = stripTests(read("crates/slipscan-core/src/service.rs"));
const methods = [
  ...new Set([...core.matchAll(/^ {4}pub fn (\w+)/gm)].map((m) => m[1])),
].sort();

if (methods.length < 100) {
  console.error(
    `check-reachable: found only ${methods.length} public CoreService methods — that is not this ` +
      `service. Fix the parser rather than lowering the floor; a parse that finds nothing would ` +
      `otherwise report perfect reachability.`,
  );
  process.exit(2);
}

const surfaces = {
  cli: stripTests(read("crates/slipscan-cli/src/main.rs")),
  http:
    stripTests(read("crates/slipscan-server/src/routes.rs")) +
    "\n" +
    stripTests(read("crates/slipscan-server/src/ops.rs")),
  ipc:
    stripTests(read("apps/desktop/src-tauri/src/commands.rs")) +
    "\n" +
    stripTests(read("apps/desktop/src-tauri/src/lib.rs")),
};

// Not every public method is meant to be a user-facing operation. Some are
// library API that sibling crates call — `set_read_only` is how `datadir`
// performs a safe data move, `settings_use_secret` is how `slipscan-ingest`
// borrows a credential without copying it. Counting those as unreachable
// capabilities puts false entries in the baseline, and a list with false
// entries is one people learn to skim. They get their own bucket: consumed,
// just not by a surface.
const INTERNAL_CONSUMERS = [
  "crates/slipscan-core/src/datadir.rs",
  "crates/slipscan-ingest/src/vault.rs",
  "crates/slipscan-ingest/src/import.rs",
  "crates/slipscan-ingest/src/pay.rs",
  "crates/slipscan-ingest/src/watch.rs",
  "crates/slipscan-ingest/src/packs.rs",
]
  .map((f) => {
    try {
      return stripTests(read(f));
    } catch {
      return "";
    }
  })
  .join("\n");

// A core method is reached by being CALLED on the service — `svc.foo(…)` — or,
// for the constructors, as `CoreService::foo(…)`. Match exactly that.
//
// Two wrong versions preceded this one, and the second was worse than the
// first. Matching `.foo(` alone missed the constructors. "Mentions the name
// anywhere" fixed that and quietly broke the check: `ops.rs` defines its own
// `pub fn report_balance_sheet(service, book_id)` that never calls core's
// method of that name — it rebuilds the report from the trial balance — so the
// bare name appeared in a surface and core's method was scored reachable while
// nothing on earth called it. A same-named shadow is precisely the case a
// name-mention test cannot see, and it hid a real defect for an hour.
const table = methods.map((name) => {
  const called = new RegExp(`\\.${name}\\s*\\(`);
  const constructed = new RegExp(`CoreService::${name}\\s*\\(`);
  return {
    name,
    on: Object.keys(surfaces).filter(
      (k) => called.test(surfaces[k]) || constructed.test(surfaces[k]),
    ),
  };
});
const noSurface = table.filter((r) => r.on.length === 0).map((r) => r.name);
// Split "no surface" into genuinely unused and internal-library-only.
const internalOnly = noSurface.filter((n) =>
  new RegExp(`\\.${n}\\s*\\(`).test(INTERNAL_CONSUMERS),
);
const unreachable = noSurface.filter((n) => !internalOnly.includes(n));

// Group by the prefix before the first underscore — close enough to a domain.
const byDomain = {};
for (const name of unreachable) {
  const key = name.split("_")[0];
  (byDomain[key] ??= []).push(name);
}

if (process.argv.includes("--list")) {
  for (const { name, on } of table) {
    console.log(`  ${on.length ? on.join(",").padEnd(12) : "UNREACHABLE ".padEnd(12)} ${name}`);
  }
}

const current = {
  total: methods.length,
  unreachable: unreachable.length,
  methods: unreachable,
  // Recorded too, so that widening INTERNAL_CONSUMERS shows up as drift. That
  // list is hand-maintained, and a hand-maintained allowlist in front of a
  // gate is the obvious way to make the gate quietly stop counting things:
  // point it at service.rs itself and every gap becomes "internal".
  internalOnly,
};

if (process.argv.includes("--write")) {
  writeFileSync(
    join(ROOT, BASELINE),
    `${JSON.stringify(
      {
        "//": [
          "Public CoreService methods that no production surface (CLI, HTTP, desktop IPC)",
          "can reach. Generated by scripts/check-reachable.mjs --write.",
          "",
          "This is a RATCHET, not a target: CI fails if the count grows, so a new feature",
          "cannot land its service layer and quietly skip its surface. Shrinking it is the",
          "work; re-record with --write when you do.",
        ],
        ...current,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`check-reachable: recorded ${unreachable.length} unreachable of ${methods.length}.`);
  process.exit(0);
}

if (!existsSync(join(ROOT, BASELINE))) {
  console.error(`check-reachable: no ${BASELINE}; create it with --write.`);
  process.exit(2);
}
const baseline = JSON.parse(read(BASELINE));
const added = unreachable.filter((m) => !baseline.methods.includes(m));
const fixed = baseline.methods.filter((m) => !unreachable.includes(m));
const baselineInternal = baseline.internalOnly ?? [];
const newlyInternal = internalOnly.filter((m) => !baselineInternal.includes(m));

console.log(
  `check-reachable: ${unreachable.length} of ${methods.length} public core methods are on no ` +
    `surface (baseline ${baseline.unreachable}); ${internalOnly.length} more are internal library ` +
    `API consumed by a sibling crate.`,
);
for (const [domain, names] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${domain.padEnd(12)} ${String(names.length).padStart(2)}  ${names.join(", ")}`);
}

if (fixed.length) {
  console.log(`\n  now reachable (${fixed.length}): ${fixed.join(", ")}`);
  console.log(`  re-record the baseline: node scripts/check-reachable.mjs --write`);
}
if (newlyInternal.length) {
  console.error(
    `\ncheck-reachable: ${newlyInternal.length} method(s) newly classified as internal library ` +
      `API: ${newlyInternal.join(", ")}\n` +
      `  That classification is what stops them being counted as gaps, so it has to be a` +
      ` deliberate\n  change, not a side effect of widening INTERNAL_CONSUMERS. Confirm each is` +
      ` genuinely called by\n  a sibling crate rather than by a user-facing surface, then re-record` +
      ` with --write.`,
  );
  process.exit(1);
}
if (added.length) {
  console.error(
    `\ncheck-reachable: ${added.length} newly unreachable method(s): ${added.join(", ")}\n` +
      `  A service method with no CLI command, no HTTP route and no IPC command cannot be used by\n` +
      `  anyone. Wire it to a surface, or if it is genuinely internal, make it non-pub.`,
  );
  process.exit(1);
}
if (fixed.length) {
  console.error(
    `\ncheck-reachable: the baseline is stale — ${fixed.length} method(s) are now reachable.\n` +
      `  Re-record it so the ratchet tightens: node scripts/check-reachable.mjs --write`,
  );
  process.exit(1);
}
