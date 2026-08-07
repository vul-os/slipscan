#!/usr/bin/env node
// Mirror the captured screenshots out of docs/screenshots/ into the two other
// places the repo serves them from.
//
// Why this exists: the same gallery lives in three directories — docs/
// screenshots/ (the markdown gallery, and where apps/desktop/scripts/
// screenshot.ts writes), assets/screens/ (what README.md and outside
// embedders point at), and site/screenshots/ (what the static site serves).
// screenshot.ts only ever mirrored the first into the second, so site/
// screenshots/ was a hand-copied third set: eleven PNGs that differed from
// docs/screenshots/ by content at identical 2880x1800 dimensions, payments.png
// missing outright, and an orphan hero.png nothing loaded. Nothing signalled
// any of that. Here the mirror is a script, and `--check` fails CI if the
// three fall out of step again.
//
// Regenerating the captures is still screenshot.ts's job (`npm run
// screenshot` in apps/desktop); this only copies what that produced.
//
// Usage:
//   node scripts/sync-screenshots.ts           mirror into both targets
//   node scripts/sync-screenshots.ts --check   exit 1 if a target is stale
//   node scripts/sync-screenshots.ts --quiet   only report changes and errors

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repoRoot, 'docs', 'screenshots');

// Files the source has that a given target deliberately does not want. This is
// an exception, so it is enforced rather than remembered: anything listed here
// is pruned from the target on every run, exactly as an unexpected file is.
//
// site/index.html points its hero at ./screenshots/dashboard.png directly and
// no page or markdown chapter loads hero.png (which is a byte-identical copy
// of dashboard.png), so shipping it would put ~900 kB of dead weight on a
// deployed page. hero-light.png is the same arrangement for the light theme —
// a byte-identical copy of dashboard-light.png that the site never asks for.
interface Target {
  dir: string;
  skip: Set<string>;
}
const TARGETS: Target[] = [
  { dir: join(repoRoot, 'assets', 'screens'), skip: new Set() },
  { dir: join(repoRoot, 'site', 'screenshots'), skip: new Set(['hero.png', 'hero-light.png']) },
];

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const quiet = args.has('--quiet');

const rel = (p: string): string => relative(repoRoot, p);
const log = (...a: unknown[]): void => {
  if (!quiet) console.log(...a);
};

const isPng = (name: string): boolean => name.toLowerCase().endsWith('.png');

async function main(): Promise<void> {
  if (!existsSync(sourceDir)) {
    console.error(`sync-screenshots: no source directory at ${sourceDir}`);
    process.exit(1);
  }

  const sources = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && isPng(e.name))
    .map((e) => e.name)
    .sort();

  if (sources.length === 0) {
    console.error(`sync-screenshots: ${rel(sourceDir)} contains no PNGs`);
    process.exit(1);
  }

  let changed = 0;
  let removed = 0;

  for (const { dir, skip } of TARGETS) {
    const wanted = sources.filter((name) => !skip.has(name));
    await mkdir(dir, { recursive: true });

    for (const name of wanted) {
      const from = join(sourceDir, name);
      const to = join(dir, name);
      const src = await readFile(from);
      const dst = existsSync(to) ? await readFile(to) : null;
      if (dst && dst.equals(src)) continue;
      changed++;
      if (!check) await writeFile(to, src);
      log(`  ${dst === null ? 'new  ' : 'sync '} ${rel(to)}`);
    }

    const keep = new Set(wanted);
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || !isPng(e.name) || keep.has(e.name)) continue;
      const path = join(dir, e.name);
      removed++;
      if (!check) await rm(path);
      log(`  ${check ? 'stale' : 'rm   '} ${rel(path)}`);
    }
  }

  if (check && (changed || removed)) {
    console.error(
      `\nsync-screenshots: the mirrors are out of date (${changed} to copy, ${removed} stale).\n` +
      'Run `npm run screenshots:sync` and commit the result.'
    );
    process.exit(1);
  }

  log(
    changed || removed
      ? `sync-screenshots: ${sources.length} captures, ${changed} written, ${removed} removed.`
      : `sync-screenshots: ${sources.length} captures already mirrored into ${TARGETS.length} directories.`
  );
}

main().catch((err) => {
  console.error('sync-screenshots:', err.message);
  process.exit(1);
});
