#!/usr/bin/env node
// Fail if a tracked source file contains a raw NUL byte.
//
// WHY THIS EXISTS. `apps/desktop/src/routes/Household.svelte` carried four of
// them — deliberate sentinel prefixes on map keys (`"\0unattributed"`, so the
// key can never collide with a real UUID), but written as literal bytes rather
// than the `\0` escape. The technique is fine; the encoding was not.
//
// A single NUL makes the whole file *binary* to every standard text tool.
// `file` reports "data", and grep skips it silently — not with a warning, just
// no matches. Every grep-based audit of this repo had been quietly excluding
// that file, and the way it finally surfaced was a type error from
// svelte-check, which reads files properly. A source file no search can see is
// worse than a wrong one: it is invisible to the tools used to find wrong ones.
//
// The fix is always the same — write the escape (`\0`) instead of the byte.
// Identical value at runtime, and the file stays greppable.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Formats that are legitimately binary and tracked as such.
const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".ico", ".icns", ".gif", ".webp", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".zip", ".sqlite", ".wasm",
]);

interface Offender {
  file: string;
  count: number;
}

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((f) => !BINARY.has(extname(f).toLowerCase()));

if (files.length < 100) {
  console.error(
    `check-source-text: only ${files.length} tracked files found — that is not this repo.\n` +
      `  Something is wrong with the listing; failing rather than reporting a clean scan.`,
  );
  process.exit(2);
}

const offenders: Offender[] = [];
for (const file of files) {
  const raw = readFileSync(join(ROOT, file));
  let count = 0;
  for (const byte of raw) if (byte === 0) count += 1;
  if (count) offenders.push({ file, count });
}

if (offenders.length) {
  console.error("check-source-text: raw NUL bytes in tracked source files:\n");
  for (const { file, count } of offenders) {
    console.error(`  - ${file}: ${count} NUL byte(s)`);
  }
  console.error(
    "\nA NUL makes the file binary to grep and every other text tool, which will\n" +
      "then skip it silently. If the NUL is intentional (a sentinel key prefix),\n" +
      "write it as the escape \\0 in a string literal instead of the raw byte —\n" +
      "same value at runtime, and the file stays searchable.",
  );
  process.exit(1);
}

console.log(`check-source-text: ${files.length} tracked files, none binary-by-accident.`);
