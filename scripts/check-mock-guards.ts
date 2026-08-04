#!/usr/bin/env node
// Compare core's validation guards against the desktop mock's, per operation.
//
// WHY THIS EXISTS. `apps/desktop/src/lib/api/mock.ts` is a hand-written stand-in
// for the real service, used whenever the app runs outside Tauri — which is how
// screens get developed. Every mock was internally consistent and separately
// tested, and six of them still disagreed with core:
//
//   product_delete        mock refused whenever the product had variants;
//                         core CASCADES them away instead
//   product_variant_delete mock had no guard; core RESTRICTs a traded variant
//   sales_order_confirm   mock allowed confirming a stock-tracked order with
//                         no location; core refuses
//   po_item_update        mock allowed editing a cancelled order's line
//   stock_movement_record mock missed the cross-book and ref_kind guards
//
// A screen written against a mock that is wrong looks tested and behaves
// differently in the real app, which is the worst way to be wrong. Nothing
// compared the two, so nothing found it until someone read both.
//
// This cannot check that the guards MEAN the same thing — only a differential
// test could, and the two sides are different languages. What it does is make
// the counts visible and frozen: if core gains or loses a guard on an operation
// the mock implements, this fails and names it, and somebody goes and looks.
// That is the trigger that was missing.
//
// A KNOWN BLIND SPOT, stated so the numbers are not over-read: the mock throws
// from shared helpers too (`requireDraft`, `requireOrder`, `requireVariant`),
// and a per-operation count cannot see those. So a row where the mock's number
// is lower is a prompt to go and read, not proof of a missing guard — several
// are helpers doing the work. Reading the flagged rows is exactly how the
// invoice_issue gap was found; treating the number as a verdict would have
// produced a pile of phantom fixes instead.
//
// Usage:
//   node scripts/check-mock-guards.ts           fail on drift
//   node scripts/check-mock-guards.ts --list    print the comparison table
//   node scripts/check-mock-guards.ts --write   re-record the baseline

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const BASELINE = "docs/mock-guards.json";

/** [core CoreError::Validation count, mock throw-new-Error count]. */
type GuardCounts = [core: number, mock: number];

interface MockGuardsBaseline {
  "//": string[];
  operations: Record<string, GuardCounts>;
}

interface GuardRow {
  name: string;
  core: number;
  mock: number;
}

interface NamedSpan {
  name: string;
  at: number;
}

/** Core: `pub fn name(` … up to the next one, counting Validation guards. */
function coreGuards(): Map<string, number> {
  const src = read("crates/slipscan-core/src/service.rs");
  // The capture group is mandatory in the pattern, so it is always present
  // when a match is found; filtered here only to satisfy the element type.
  const starts: NamedSpan[] = [...src.matchAll(/^ {4}pub fn (\w+)/gm)]
    .filter((m) => m[1] !== undefined)
    .map((m) => ({
      name: m[1]!,
      at: m.index!,
    }));
  if (starts.length < 100) {
    console.error(
      `check-mock-guards: parsed only ${starts.length} service fns — fix the parser rather than ` +
        `trusting a comparison against almost nothing.`,
    );
    process.exit(2);
  }
  const out = new Map<string, number>();
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : src.length;
    const body = src.slice(s.at, end);
    out.set(s.name, (body.match(/CoreError::Validation/g) ?? []).length);
  });
  return out;
}

/** Mock: `name: async (` … up to the next top-level entry, counting throws. */
function mockGuards(): Map<string, number> {
  const src = read("apps/desktop/src/lib/api/mock.ts");
  // Same guarantee as coreGuards(): the capture group is mandatory.
  const starts: NamedSpan[] = [...src.matchAll(/^ {2}(\w+): async \(/gm)]
    .filter((m) => m[1] !== undefined)
    .map((m) => ({
      name: m[1]!,
      at: m.index!,
    }));
  if (starts.length < 80) {
    console.error(
      `check-mock-guards: parsed only ${starts.length} mock operations — fix the parser.`,
    );
    process.exit(2);
  }
  const out = new Map<string, number>();
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : src.length;
    const body = src.slice(s.at, end);
    out.set(s.name, (body.match(/throw new Error/g) ?? []).length);
  });
  return out;
}

const core = coreGuards();
const mock = mockGuards();

// Only operations the mock actually implements are comparable. A command with
// no mock is a separate question — `check-parity.ts` owns that one.
const rows: GuardRow[] = [...mock.keys()]
  .filter((name) => core.has(name))
  .map((name) => ({ name, core: core.get(name)!, mock: mock.get(name)! }))
  .filter((r) => r.core > 0 || r.mock > 0)
  .sort((a, b) => a.name.localeCompare(b.name));

if (process.argv.includes("--list")) {
  console.log("  operation".padEnd(38), "core", "mock");
  for (const r of rows) {
    const flag = r.core === r.mock ? "" : "   <- differs";
    console.log(`  ${r.name.padEnd(36)} ${String(r.core).padStart(4)} ${String(r.mock).padStart(4)}${flag}`);
  }
}

const current: Record<string, GuardCounts> = Object.fromEntries(
  rows.map((r) => [r.name, [r.core, r.mock] as GuardCounts]),
);

if (process.argv.includes("--write")) {
  writeFileSync(
    join(ROOT, BASELINE),
    `${JSON.stringify(
      {
        "//": [
          "Guard counts per operation: [core CoreError::Validation, mock throw new Error].",
          "Generated by scripts/check-mock-guards.ts --write.",
          "",
          "Counts, not meanings — only a differential test could compare behaviour, and the",
          "two sides are different languages. The point is the TRIGGER: if core gains or",
          "loses a guard on an operation the mock implements, CI fails and names it, and",
          "somebody goes and checks whether the mock still agrees. Six divergences shipped",
          "before this existed, every one of them in a mock that was internally consistent",
          "and separately tested.",
          "",
          "A row where the two numbers differ is not automatically wrong — a mock cannot",
          "check a database FK, and core cannot check what only the mock models. It is",
          "recorded so the difference is deliberate rather than unnoticed.",
        ],
        operations: current,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`check-mock-guards: recorded ${rows.length} comparable operations.`);
  process.exit(0);
}

if (!existsSync(join(ROOT, BASELINE))) {
  console.error(`check-mock-guards: no ${BASELINE}; create it with --write.`);
  process.exit(2);
}
const baselineFile = JSON.parse(read(BASELINE)) as Partial<MockGuardsBaseline>;
const baseline: Record<string, GuardCounts> = baselineFile.operations ?? {};
const problems: string[] = [];
for (const [name, [c, m]] of Object.entries(current)) {
  const was = baseline[name];
  if (!was) {
    problems.push(`${name}: new comparable operation (core ${c}, mock ${m}) — check the mock agrees`);
  } else if (was[0] !== c || was[1] !== m) {
    problems.push(
      `${name}: guards moved core ${was[0]}->${c}, mock ${was[1]}->${m} — does the mock still match core?`,
    );
  }
}
for (const name of Object.keys(baseline)) {
  if (!(name in current)) problems.push(`${name}: no longer comparable (renamed or removed?)`);
}

if (problems.length) {
  console.error("check-mock-guards: guard counts moved since the baseline:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nThis is a prompt, not a verdict: read both sides, and if they still agree,\n" +
      "re-record with `npm run mock-guards:sync`.",
  );
  process.exit(1);
}

console.log(
  `check-mock-guards: ${rows.length} operations compared against core, none moved since the baseline.`,
);
