#!/usr/bin/env node
// Refuse placeholder implementations and tests that assert nothing.
//
// WHY THIS EXISTS. A test that runs the code and checks no result is worth
// almost exactly nothing, and it is indistinguishable from a real one in every
// summary line: it prints `ok`, it counts toward the total, and it goes green
// on a build that is broken. The same is true of a function body that is
// `todo!()` behind a real-looking signature — the surface exists, the call
// succeeds in the type checker, and the feature does not exist.
//
// Both are the failure mode this codebase has repeatedly produced: layers that
// are individually complete-looking and collectively hollow. Three phases
// shipped foundations reachable from nothing; thirteen mock behaviours
// disagreed with core; a sync test suite once printed `test result: ok` for
// zero tests. None of it was visible in a summary line.
//
// So this checks three things, cheaply and literally:
//
//   1. no `todo!()` / `unimplemented!()` / "not implemented" panics in code
//      that ships (test modules are stripped first — a todo in a fixture is
//      not a shipped stub)
//   2. every Rust `#[test]` body contains at least one real assertion
//   3. every vitest `it(...)` body contains at least one `expect(`
//
// It cannot judge whether an assertion is a GOOD one — only mutation testing
// does that, and this repo does it by hand. What it can do is make the empty
// ones impossible, which is the floor.
//
// Usage:
//   node scripts/check-tests-assert.mjs          fail on any finding
//   node scripts/check-tests-assert.mjs --list   print every test it examined

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const rustFiles = tracked.filter((f) => f.endsWith(".rs"));
const tsTestFiles = tracked.filter((f) => /\.(test|spec)\.(ts|js)$/.test(f));

if (rustFiles.length < 20 || tsTestFiles.length < 3) {
  console.error(
    `check-tests-assert: found ${rustFiles.length} rust files and ${tsTestFiles.length} test ` +
      `files — that is not this repo. Fix the listing rather than trusting an empty sweep.`,
  );
  process.exit(2);
}

/** Strip `#[cfg(test)] mod … { … }` by brace matching. */
function stripTestMods(src) {
  let out = "";
  let i = 0;
  for (;;) {
    const m = /#\[cfg\(test\)\]\s*\nmod \w+ \{/.exec(src.slice(i));
    if (!m) return out + src.slice(i);
    out += src.slice(i, i + m.index);
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

/**
 * Body of the block starting at the first `{` at or after `from`, counting
 * only braces that are actually code.
 *
 * Naive brace counting is wrong here and wrong in a way that hides real
 * findings rather than inventing them: a test containing `"curly } brace"` or
 * a deliberately truncated `r#"{"rate":{"#` never balances, so the body comes
 * back empty and the test reads as asserting nothing. The first version of
 * this script flagged `braces_inside_strings_are_ignored` — a test whose
 * entire subject is that braces inside strings must be ignored.
 *
 * So: skip line and block comments, char literals, ordinary strings with
 * escapes, and Rust raw strings including the `r#"…"#` hash forms.
 */
function blockAt(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    const c = src[j];

    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j);
      if (j < 0) return "";
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      if (end < 0) return "";
      j = end + 1;
      continue;
    }
    // Rust raw string: r"…" or r#"…"# (any number of hashes).
    if (c === "r" && (src[j + 1] === '"' || src[j + 1] === "#")) {
      let k = j + 1;
      let hashes = 0;
      while (src[k] === "#") {
        hashes += 1;
        k += 1;
      }
      if (src[k] === '"') {
        const terminator = '"' + "#".repeat(hashes);
        const end = src.indexOf(terminator, k + 1);
        if (end < 0) return "";
        j = end + terminator.length - 1;
        continue;
      }
    }
    // A lone `'` in Rust is far more often a LIFETIME (`'static`, `'a`) than a
    // char literal, and treating one as an unterminated string swallows the
    // rest of the body — which reported a test containing `'static` as having
    // no assertions. Only treat it as a char literal when it closes within a
    // few characters, which is what a real one always does.
    if (c === "'") {
      const close = src.indexOf("'", j + 1);
      if (close > 0 && close - j <= 4) {
        j = close;
        continue;
      }
      continue; // a lifetime: nothing to skip
    }
    if (c === '"') {
      let k = j + 1;
      while (k < src.length) {
        if (src[k] === "\\") k += 2;
        else if (src[k] === '"') break;
        else k += 1;
      }
      j = k;
      continue;
    }

    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return "";
}

const problems = [];
const examined = [];

// --- 1. shipped stubs ------------------------------------------------------
for (const file of rustFiles) {
  const shipped = stripTestMods(read(file));
  for (const [re, what] of [
    [/\btodo!\s*\(/g, "todo!()"],
    [/\bunimplemented!\s*\(/g, "unimplemented!()"],
    [/panic!\s*\(\s*"[^"]*not implemented/gi, 'panic!("not implemented")'],
  ]) {
    for (const m of shipped.matchAll(re)) {
      const line = shipped.slice(0, m.index).split("\n").length;
      problems.push(`${file}:${line}: ${what} in code that ships — a stub behind a real signature`);
    }
  }
}

// --- 2. Rust tests that assert nothing -------------------------------------
// `debug_assert()` is clap's own validity check — the assertion is inside it.
// A helper fn whose name starts with `assert_` counts too: a test that calls
// `assert_balances(&book)` is asserting, and demanding the macro appear
// inline would push people to inline their helpers, which is worse code for
// no gain.
// A FLOOR, not a quality bar. `.unwrap()` counts: unwrapping a Result is a
// real failure path — the test goes red if the call errors — and refusing to
// count it would fail almost every honest round-trip test in the repo while
// teaching people to sprinkle `assert!(true)`. What this catches is a test
// with NO failure path at all, which is the thing that is genuinely worthless.
// Judging whether an assertion is a *good* one is what mutation testing is
// for, and this repo does that by hand.
const RUST_ASSERTION =
  /\bassert!|\bassert_eq!|\bassert_ne!|\bassert_matches!|\bdebug_assert\s*[(<]|\bassert_\w+\s*[(:]|\bunwrap\s*\(\s*\)|\bunwrap_err\s*\(|\bexpect\s*\(|\bexpect_err\s*\(|\bpanic!|\bshould_panic\b|\?;/;

for (const file of rustFiles) {
  const src = read(file);
  for (const m of src.matchAll(/#\[(?:tokio::)?test\]([\s\S]{0,400}?)fn (\w+)/g)) {
    const attrs = m[1];
    const name = m[2];
    const body = blockAt(src, m.index + m[0].length);
    examined.push(`${file}::${name}`);
    if (/#\[ignore\]/.test(attrs)) {
      problems.push(`${file}: test \`${name}\` is #[ignore]d — a test that never runs is not a test`);
      continue;
    }
    // `should_panic` tests assert by not-panicking-elsewhere; the attribute IS
    // the assertion.
    if (/should_panic/.test(attrs)) continue;
    if (!RUST_ASSERTION.test(body)) {
      problems.push(
        `${file}: test \`${name}\` contains no assertion — it runs the code and checks nothing`,
      );
    }
  }
}

// --- 3. vitest/playwright tests that assert nothing -------------------------
for (const file of tsTestFiles) {
  const src = read(file);
  for (const m of src.matchAll(/\b(it|test)(?:\.\w+)?\s*\(\s*(['"`])([\s\S]*?)\2\s*,/g)) {
    const name = m[3].replace(/\s+/g, " ").slice(0, 70);
    // Start at the arrow, not the first `{` — Playwright's
    // `async ({ page }) => {` puts a destructuring pattern in the way, and
    // reading that as the body reported every one of those tests as empty.
    const arrow = src.indexOf("=>", m.index + m[0].length);
    const body = blockAt(src, arrow < 0 ? m.index + m[0].length : arrow);
    examined.push(`${file}::${name}`);
    if (/\.(skip|todo)\s*\(/.test(m[0])) {
      problems.push(`${file}: test "${name}" is skipped — a test that never runs is not a test`);
      continue;
    }
    if (!/\bexpect\s*\(/.test(body)) {
      problems.push(`${file}: test "${name}" contains no expect() — it checks nothing`);
    }
  }
}

if (process.argv.includes("--list")) {
  for (const e of examined) console.log(`  ${e}`);
}

// A sweep that examined almost nothing would report a clean bill of health.
if (examined.length < 300) {
  console.error(
    `check-tests-assert: only examined ${examined.length} tests — this repo has far more. ` +
      `Fix the parser rather than trusting the result.`,
  );
  process.exit(2);
}

if (problems.length) {
  console.error(`check-tests-assert: ${problems.length} finding(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\nA test that asserts nothing passes on a broken build, and a stub behind a real\n" +
      "signature is a feature that does not exist. Neither is visible in a summary line.",
  );
  process.exit(1);
}

console.log(
  `check-tests-assert: ${examined.length} tests examined, every one asserts something; ` +
    `no stubs in shipped code.`,
);
