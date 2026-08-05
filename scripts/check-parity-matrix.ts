#!/usr/bin/env node
// Verify PARITY.md's scores against the code they claim to describe, and
// derive its counts instead of trusting them.
//
// WHY THIS EXISTS. PARITY.md scores 24 capabilities Built / Partial / Not
// built against Xero and Vault22/22seven, and it is scored entirely by hand.
// It has already gone stale for a whole development wave — at one point it
// said "there is no invoicing at all" on a tree that had invoicing — and its
// own summary counts have been hand-typed and wrong before. Nothing verified
// any of it. Three other agents are shipping features as this is written,
// which is exactly why a re-score has to be a build step, not a habit.
//
// The judgement calls ("is this really Built?") cannot be automated. What
// this checks is the falsifiable residue of that judgement:
//
// THE BLIND SPOT, AND IT IS LARGE. Only the Built and Not-built scores are
// falsifiable, so only they are checked. **Partial rows are 13 of the 24, and
// their prose is verified by nothing here.** That is not theoretical: the same
// pass that first added this script also wrote "no screen calls either, so a
// user still cannot trigger a statement import from the app" into the CSV/OFX
// row — false, `routes/Transactions.svelte` calls both `statementImport` and
// `statementPresetList` — and this check passed before and after the sentence
// was corrected. A green run means the scores line up with the code, NOT that
// the sentences beside them are true. Read a Partial row's prose against the
// tree before trusting it; that part is still a human job.
//
//   1. Every citation resolving is already `npm run docs:check`'s job — it
//      mirrors PARITY.md to the docs site and resolves every link in it,
//      repo paths included, against the filesystem. Not duplicated here.
//
//   2. A row scored **Not built** carries `<!-- parity absent="sym,..." -->`
//      naming the symbol(s) whose ABSENCE the score depends on. If a real
//      definition of one now exists anywhere in the source tree, the score is
//      provably stale, and this fails naming the row and where it found it.
//
//   3. A row scored **Built** carries `<!-- parity reachable="sym,..." -->`
//      naming CoreService method(s) it depends on. Each must (a) actually be
//      a `pub fn` on CoreService — a citation of a symbol that does not exist
//      is caught here too — and (b) be reachable from at least one surface,
//      using the exact call-detection this repo's `check-reachable.ts` uses.
//      A Built row whose evidence is unreachable from everywhere is this
//      repo's most-documented failure shape: complete in core, reachable from
//      nowhere.
//
//   4. The summary table's Built/Partial/Not-built counts (and the
//      Xero(N)/Vault22(N)/Total(N) row counts) are DERIVED from the rows
//      below it, and `docs/parity-matrix.json` is generated from the same
//      pass — neither is ever hand-typed again.
//
// Partial rows carry no marker: nothing about "something real ships with a
// named gap" is mechanically checkable, so this does not pretend to check it.
//
// Markers live inline in the Status cell, on the row's own line
// (`**Built**<!-- ... -->`), not on a line of their own — an HTML comment on
// its own line between two `|`-prefixed table rows ends a GFM table, which
// would silently break the very rows this file exists to keep honest.
//
// A "Not built" absence check is only as good as what counts as "exists": it
// requires a real Rust `fn`, a TS/Svelte function-shaped definition, or a
// `CREATE TABLE`, not merely the bare word appearing anywhere (a roadmap
// sentence planning `goal_create` would otherwise flip this red for nothing).
// So the search is restricted to source files (.rs/.ts/.svelte/.sql) and a
// definition-shaped pattern, not a bare grep — the same discipline every
// other gate in this file applies to its own regex.
//
// Usage:
//   node scripts/check-parity-matrix.ts           report drift, exit 1 if any
//   node scripts/check-parity-matrix.ts --list    print every row examined
//   node scripts/check-parity-matrix.ts --write   rewrite the derived counts

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const PARITY_MD = "PARITY.md";
const OUT = "docs/parity-matrix.json";

type Status = "Built" | "Partial" | "Not built";
type Axis = "xero" | "vault22";

interface Row {
  axis: Axis;
  name: string;
  status: Status;
  line: number;
  reachable: string[];
  absent: string[];
}

interface Counts {
  total: number;
  built: number;
  partial: number;
  not_built: number;
}

interface ParityMatrixFile {
  "//": string[];
  counts: { xero: Counts; vault22: Counts; total: Counts };
  rows: { axis: Axis; name: string; status: Status; reachable: string[]; absent: string[] }[];
}

// A parse that finds far too few rows has failed, not scored a small file.
// 24 is the row count PARITY.md carries as of this writing; the floor is
// conservative on purpose (see check-reachable.ts's identical reasoning) —
// it exists to catch a broken parser, not to pin the count forever.
const MIN_ROWS = 24;

// --- 1. parse PARITY.md's two capability tables -----------------------------

const md = read(PARITY_MD);
const lines = md.split("\n");

/** Byte range of a `## A. ...` / `## B. ...` section: [heading line, next `## ` heading). */
function section(headingRe: RegExp): { start: number; end: number } {
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) {
    console.error(`check-parity-matrix: no heading matching ${headingRe} in ${PARITY_MD}`);
    process.exit(2);
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

const xeroSection = section(/^## A\. Xero axis/);
const vault22Section = section(/^## B\. Vault22/);

// Capability rows only: `| **Name** | **Status**<!-- optional marker --> | ...`.
// The header (`| Capability | Status | ... |`) and delimiter (`|---|---|...`)
// rows do not have `**Bold**` in both of the first two cells, so they never
// match this — no separate skip logic needed for them.
const ROW_RE =
  /^\|\s*\*\*(.+?)\*\*\s*\|\s*\*\*(Built|Partial|Not built)\*\*(<!--\s*parity\s+([^>]*?)\s*-->)?\s*\|/;

/** `reachable="a,b"` / `absent="a,b"` -> the parsed symbol list for that key. */
function markerSymbols(attrs: string | undefined, key: "reachable" | "absent"): string[] {
  if (!attrs) return [];
  const m = new RegExp(`${key}="([^"]*)"`).exec(attrs);
  if (!m || m[1] === undefined) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRows(axis: Axis, range: { start: number; end: number }): Row[] {
  const out: Row[] = [];
  for (let i = range.start; i < range.end; i += 1) {
    const m = ROW_RE.exec(lines[i]!);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    out.push({
      axis,
      name: m[1],
      status: m[2] as Status,
      line: i + 1,
      reachable: markerSymbols(m[4], "reachable"),
      absent: markerSymbols(m[4], "absent"),
    });
  }
  return out;
}

const rows = [...parseRows("xero", xeroSection), ...parseRows("vault22", vault22Section)];

if (process.argv.includes("--list")) {
  for (const r of rows) {
    const tag = r.reachable.length
      ? `reachable=${r.reachable.join(",")}`
      : r.absent.length
        ? `absent=${r.absent.join(",")}`
        : "";
    console.log(`  ${PARITY_MD}:${r.line}  [${r.axis}]  ${r.status.padEnd(9)} ${r.name}  ${tag}`);
  }
}

// The floor this whole file exists to enforce on itself: a parser that
// silently matched nothing would otherwise print a clean, meaningless PASS —
// the exact failure this repo has hit ~22 times elsewhere.
if (rows.length < MIN_ROWS) {
  console.error(
    `check-parity-matrix: parsed only ${rows.length} capability rows out of ${PARITY_MD} — ` +
      `expected at least ${MIN_ROWS}. Fix the parser (row shape probably changed) rather than ` +
      `lowering this floor, which would turn the check into one that examines nothing and passes.`,
  );
  process.exit(2);
}

const problems: string[] = [];

// --- 2. every "Not built" row must cite no implementation --------------------

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((f) => /\.(rs|ts|svelte|sql)$/.test(f));

if (tracked.length < 200) {
  console.error(
    `check-parity-matrix: only ${tracked.length} source files tracked — that is not this repo. ` +
      `Fix the file listing rather than trusting an empty sweep.`,
  );
  process.exit(2);
}

interface Definition {
  file: string;
  line: number;
}

/** Where `symbol` is DEFINED in the tracked source tree, if anywhere.
 *
 * Definition-shaped only, deliberately: a bare `grep` for the name would flag
 * a roadmap sentence or a code comment that merely plans the feature, which
 * is exactly the false alarm that trains people to stop reading this gate's
 * output. Rust `fn NAME(`, TS/Svelte `function NAME(` / `const NAME =` /
 * object-method-shorthand `NAME: (` or `NAME: async (`, and SQL
 * `CREATE TABLE NAME` are the shapes every real implementation in this repo
 * actually takes (see check-reachable.ts and check-mock-guards.ts, which key
 * off the same shapes for the opposite question). */
function findDefinition(symbol: string): Definition | null {
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defRe = new RegExp(
    `\\bfn\\s+${esc}\\s*[(<]` + // Rust
      `|\\bfunction\\s+${esc}\\s*\\(` + // TS function decl
      `|\\bconst\\s+${esc}\\s*[:=]` + // TS const (incl. arrow fns)
      `|\\b${esc}\\s*:\\s*(?:async\\s+)?\\(` + // object-method shorthand (mock.ts style)
      `|\\bcreate\\s+table\\s+${esc}\\b`, // SQL
    "i",
  );
  for (const file of tracked) {
    const src = read(file);
    const m = defRe.exec(src);
    if (m) return { file, line: src.slice(0, m.index).split("\n").length };
  }
  return null;
}

let absentChecked = 0;
for (const row of rows) {
  if (row.status !== "Not built") continue;
  if (row.absent.length === 0) {
    problems.push(
      `${PARITY_MD}:${row.line}: "${row.name}" is scored Not built with no ` +
        `<!-- parity absent="..." --> marker — nothing names what its score depends on being absent`,
    );
    continue;
  }
  for (const symbol of row.absent) {
    absentChecked += 1;
    const found = findDefinition(symbol);
    if (found) {
      problems.push(
        `${PARITY_MD}:${row.line}: "${row.name}" is scored Not built and cites the absence of ` +
          `\`${symbol}\`, but it is now defined at ${found.file}:${found.line} — the score is stale`,
      );
    }
  }
}

// --- 3. every "Built" row must be reachable ----------------------------------

/** Strip `#[cfg(test)] mod … { … }` by brace matching — a method called only
 * from a test module is exactly the thing that looks reachable and is not.
 * Identical to check-reachable.ts's stripTests, duplicated rather than
 * imported: every gate script in this repo is a standalone, dependency-free
 * file, and importing another gate's module would run its top-level
 * side-effecting checks (and its `process.exit`s) as a side effect of this
 * one starting up. */
function stripTests(src: string): string {
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

const coreSrc = stripTests(read("crates/slipscan-core/src/service.rs"));
const coreMethods = new Set(
  [...coreSrc.matchAll(/^ {4}pub fn (\w+)/gm)].map((m) => m[1]).filter((s): s is string => Boolean(s)),
);
if (coreMethods.size < 100) {
  console.error(
    `check-parity-matrix: found only ${coreMethods.size} public CoreService methods — that is not ` +
      `this service. Fix the parser rather than trusting a reachability check against almost nothing.`,
  );
  process.exit(2);
}

const surfaces: Record<string, string> = {
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

/** Same call-detection as check-reachable.ts: `.name(` or `CoreService::name(`. */
function reachableFrom(name: string): string[] {
  const called = new RegExp(`\\.${name}\\s*\\(`);
  const constructed = new RegExp(`CoreService::${name}\\s*\\(`);
  return Object.entries(surfaces)
    .filter(([, src]) => called.test(src) || constructed.test(src))
    .map(([k]) => k);
}

let reachableChecked = 0;
for (const row of rows) {
  if (row.status !== "Built") continue;
  if (row.reachable.length === 0) {
    problems.push(
      `${PARITY_MD}:${row.line}: "${row.name}" is scored Built with no ` +
        `<!-- parity reachable="..." --> marker — nothing names what evidence the score rests on`,
    );
    continue;
  }
  for (const symbol of row.reachable) {
    reachableChecked += 1;
    if (!coreMethods.has(symbol)) {
      problems.push(
        `${PARITY_MD}:${row.line}: "${row.name}" cites \`${symbol}\` as reachable evidence, but it ` +
          `is not a public CoreService method (crates/slipscan-core/src/service.rs) — the citation ` +
          `does not resolve`,
      );
      continue;
    }
    const on = reachableFrom(symbol);
    if (on.length === 0) {
      problems.push(
        `${PARITY_MD}:${row.line}: "${row.name}" is scored Built on \`${symbol}\`, but no surface ` +
          `(CLI, HTTP, desktop IPC) calls it — complete in core, reachable from nowhere is this ` +
          `repo's own worst-documented defect`,
      );
    }
  }
}

// --- 4. derive the counts, never type them -----------------------------------

function tally(rs: Row[]): Counts {
  return {
    total: rs.length,
    built: rs.filter((r) => r.status === "Built").length,
    partial: rs.filter((r) => r.status === "Partial").length,
    not_built: rs.filter((r) => r.status === "Not built").length,
  };
}

const xeroRows = rows.filter((r) => r.axis === "xero");
const vault22Rows = rows.filter((r) => r.axis === "vault22");
const counts = { xero: tally(xeroRows), vault22: tally(vault22Rows), total: tally(rows) };

// The summary table right under the front-page headline:
//   | | Built | Partial | Not built |
//   |---|---:|---:|---:|
//   | **Xero axis** (14) | 2 | 7 | 5 |
//   | **Vault22 / 22seven axis** (10) | 3 | 5 | 2 |
//   | **Total** (24) | **5** | **12** | **7** |
const SUMMARY_RE = {
  xero: /^\| \*\*Xero axis\*\* \((\d+)\) \| (\d+) \| (\d+) \| (\d+) \|$/,
  vault22: /^\| \*\*Vault22 \/ 22seven axis\*\* \((\d+)\) \| (\d+) \| (\d+) \| (\d+) \|$/,
  total: /^\| \*\*Total\*\* \((\d+)\) \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|$/,
};

function summaryLine(key: keyof typeof SUMMARY_RE): { line: number; parsed: [number, number, number, number] } {
  const idx = lines.findIndex((l) => SUMMARY_RE[key].test(l));
  if (idx === -1) {
    console.error(
      `check-parity-matrix: no "${key}" row found in the summary table at the top of ${PARITY_MD} — ` +
        `its format probably changed. Fix the parser rather than skipping the check.`,
    );
    process.exit(2);
  }
  const m = SUMMARY_RE[key].exec(lines[idx]!)!;
  return {
    line: idx,
    parsed: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])],
  };
}

const xeroSummary = summaryLine("xero");
const vault22Summary = summaryLine("vault22");
const totalSummary = summaryLine("total");

function checkSummary(
  label: string,
  summary: { parsed: [number, number, number, number] },
  actual: Counts,
): void {
  const [rowCount, built, partial, notBuilt] = summary.parsed;
  if (rowCount !== actual.total)
    problems.push(`summary table: ${label} says (${rowCount}) rows, the doc has ${actual.total}`);
  if (built !== actual.built)
    problems.push(`summary table: ${label} Built says ${built}, rows say ${actual.built}`);
  if (partial !== actual.partial)
    problems.push(`summary table: ${label} Partial says ${partial}, rows say ${actual.partial}`);
  if (notBuilt !== actual.not_built)
    problems.push(`summary table: ${label} Not built says ${notBuilt}, rows say ${actual.not_built}`);
}

checkSummary("Xero axis", xeroSummary, counts.xero);
checkSummary("Vault22 axis", vault22Summary, counts.vault22);
checkSummary("Total", totalSummary, counts.total);

// --- --write: rewrite the summary table + docs/parity-matrix.json -----------

if (process.argv.includes("--write")) {
  const newLines = [...lines];
  newLines[xeroSummary.line] =
    `| **Xero axis** (${counts.xero.total}) | ${counts.xero.built} | ${counts.xero.partial} | ${counts.xero.not_built} |`;
  newLines[vault22Summary.line] =
    `| **Vault22 / 22seven axis** (${counts.vault22.total}) | ${counts.vault22.built} | ${counts.vault22.partial} | ${counts.vault22.not_built} |`;
  newLines[totalSummary.line] =
    `| **Total** (${counts.total.total}) | **${counts.total.built}** | **${counts.total.partial}** | **${counts.total.not_built}** |`;
  writeFileSync(join(ROOT, PARITY_MD), newLines.join("\n"));

  const out: ParityMatrixFile = {
    "//": [
      "Derived from PARITY.md's own rows by scripts/check-parity-matrix.ts --write.",
      "DO NOT hand-edit -- counts here were hand-maintained and wrong before this existed.",
      "`npm run parity-matrix:check` fails CI if this drifts from PARITY.md.",
    ],
    counts,
    rows: rows.map((r) => ({
      axis: r.axis,
      name: r.name,
      status: r.status,
      reachable: r.reachable,
      absent: r.absent,
    })),
  };
  writeFileSync(join(ROOT, OUT), `${JSON.stringify(out, null, 2)}\n`);

  console.log(
    `check-parity-matrix: wrote ${PARITY_MD} summary table and ${OUT} — ` +
      `${counts.total.total} rows (${counts.total.built} built, ${counts.total.partial} partial, ` +
      `${counts.total.not_built} not built).`,
  );
  process.exit(0);
}

// docs/parity-matrix.json must also agree, in --check mode, with what --write
// would produce — the same drift check.ts pattern check-parity.ts uses for
// docs/parity.json.
if (!existsSync(join(ROOT, OUT))) {
  problems.push(`${OUT} does not exist; create it with \`npm run parity-matrix:sync\``);
} else {
  const existing = JSON.parse(read(OUT)) as Partial<ParityMatrixFile>;
  const expected = JSON.stringify(counts);
  const actual = JSON.stringify(existing.counts);
  if (expected !== actual) {
    problems.push(
      `${OUT} counts do not match ${PARITY_MD}'s rows (expected ${expected}, file has ${actual})`,
    );
  }
  const expectedRows = JSON.stringify(
    rows.map((r) => ({ axis: r.axis, name: r.name, status: r.status, reachable: r.reachable, absent: r.absent })),
  );
  const actualRows = JSON.stringify(existing.rows ?? []);
  if (expectedRows !== actualRows) {
    problems.push(`${OUT} row list does not match ${PARITY_MD} — re-derive with \`npm run parity-matrix:sync\``);
  }
}

if (problems.length) {
  console.error(`check-parity-matrix: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nA stale marker is a stale score. Fix the row (and its marker) to match the code, then re-run;\n" +
      "if only the counts moved, re-derive them with `npm run parity-matrix:sync`.",
  );
  process.exit(1);
}

console.log(
  `check-parity-matrix: ${rows.length} rows examined (${counts.total.built} built, ` +
    `${counts.total.partial} partial, ${counts.total.not_built} not built) — ` +
    `${reachableChecked} reachable citation(s) and ${absentChecked} absence citation(s) all hold; ` +
    `summary counts and ${OUT} agree.`,
);
