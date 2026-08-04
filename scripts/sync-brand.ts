#!/usr/bin/env node
// Mirror the brand masters in brand/ out to every place this repo serves
// them from.
//
// Why this exists: the mark and wordmarks were duplicated by hand across
// five tracked locations — brand/logo.svg (README calls it the source of
// truth), assets/brand/ (README + docs/ARCHITECTURE.md), site/assets/brand/
// (site/index.html + site/docs.html, a copy of the above plus its own
// logo.svg), apps/desktop/src/assets/ (Sidebar.svelte), and
// apps/desktop/public/logo-mark.svg (the Tauri window/tab favicon). They
// were byte-identical, but nothing kept them that way: five hand-maintained
// copies, no sync step, no gate. Here the mirror is a script, and `--check`
// fails CI if a destination falls out of step with its master again — same
// mechanism as sync-screenshots.ts, applied to brand/ instead of
// docs/screenshots/.
//
// A destination's filename does not always match its master: apps/desktop's
// favicon is served as logo-mark.svg (Vite public dir + Sidebar's raw
// import), and site/assets/brand/favicon.svg is the same drawing under the
// name browsers expect — both are byte-identical to brand/logo.svg, so both
// are just renamed copies of it, not separate artwork.
//
// The eight rendered PNGs (apple-touch-icon.png, favicon-16.png,
// favicon-32.png, icon-192.png, icon-512.png, icon-maskable-192.png,
// icon-maskable-512.png, og-card.png) are handled one step short of the SVGs,
// deliberately. Nothing in this repo records at what size, padding or export
// tool they were rendered from the mark, so this script does NOT regenerate
// them — claiming it could would invent a provenance they do not have, and
// re-rendering with whatever ImageMagick happens to be installed would churn
// bytes and could silently change the artwork.
//
// But each one exists TWICE (assets/brand/ and site/assets/brand/), and those
// two copies drifting apart is a real, checkable failure independent of how
// either was produced. So assets/brand/ is treated as canonical *for the
// pair* — a strictly weaker claim than "master": it says the site's copy must
// equal the repo's copy, not that either was derived from brand/logo.svg.
// Re-rendering an icon stays a human decision; keeping the two in step does
// not.
//
// Usage:
//   node scripts/sync-brand.ts           mirror masters into every destination
//   node scripts/sync-brand.ts --check   exit 1 if a destination is stale
//   node scripts/sync-brand.ts --quiet   only report changes and errors

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const masterDir = join(repoRoot, 'brand');

interface Copy {
  master: string; // filename inside brand/
  dest: string; // path relative to repo root, own filename included
}

const COPIES: Copy[] = [
  // logo.svg — the mark. Used as-is, as a renamed favicon, and as
  // apps/desktop's /logo-mark.svg (src asset + Vite public favicon).
  { master: 'logo.svg', dest: 'assets/brand/favicon.svg' },
  { master: 'logo.svg', dest: 'site/assets/brand/logo.svg' },
  { master: 'logo.svg', dest: 'site/assets/brand/favicon.svg' },
  { master: 'logo.svg', dest: 'apps/desktop/src/assets/logo-mark.svg' },
  { master: 'logo.svg', dest: 'apps/desktop/public/logo-mark.svg' },

  // logo-wordmark.svg — README hero, site header/hero/footer, desktop
  // sidebar (light theme).
  { master: 'logo-wordmark.svg', dest: 'assets/brand/logo-wordmark.svg' },
  { master: 'logo-wordmark.svg', dest: 'site/assets/brand/logo-wordmark.svg' },
  { master: 'logo-wordmark.svg', dest: 'apps/desktop/src/assets/logo-wordmark.svg' },

  // logo-wordmark-dark.svg — same set, dark theme.
  { master: 'logo-wordmark-dark.svg', dest: 'assets/brand/logo-wordmark-dark.svg' },
  { master: 'logo-wordmark-dark.svg', dest: 'site/assets/brand/logo-wordmark-dark.svg' },
  { master: 'logo-wordmark-dark.svg', dest: 'apps/desktop/src/assets/logo-wordmark-dark.svg' },
];

// See the header comment: rendered outputs with no in-repo provenance, but
// each present in two places that must agree. Listed (not discovered) so a
// run reports an exact count rather than a vague "some PNGs" — and so a file
// dropping off this list is a diff someone has to justify, not a silent
// narrowing of what gets checked.
const RASTER_NAMES = [
  'apple-touch-icon.png',
  'favicon-16.png',
  'favicon-32.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'og-card.png',
];

const RASTER_COPIES: Copy[] = RASTER_NAMES.map((name) => ({
  master: `assets/brand/${name}`,
  dest: `site/assets/brand/${name}`,
}));

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const quiet = args.has('--quiet');

const rel = (p: string): string => relative(repoRoot, p);
const log = (...a: unknown[]): void => {
  if (!quiet) console.log(...a);
};

async function main(): Promise<void> {
  if (!existsSync(masterDir)) {
    console.error(`sync-brand: no master directory at ${rel(masterDir)}`);
    process.exit(1);
  }

  const masters = [...new Set(COPIES.map((c) => c.master))].sort();
  for (const name of masters) {
    if (!existsSync(join(masterDir, name))) {
      console.error(`sync-brand: master brand/${name} does not exist`);
      process.exit(1);
    }
  }

  // Coverage floor: a check that silently iterates an empty list prints
  // PASS having examined nothing. COPIES is a static list, not a directory
  // scan, so this can only trip if someone empties it by mistake — that is
  // exactly the case it exists to catch.
  if (COPIES.length === 0) {
    console.error('sync-brand: COPIES is empty — nothing would be checked');
    process.exit(1);
  }

  // Rasters are mirrored the same way; only where their source lives differs
  // (assets/brand/ rather than brand/), so resolving that is the one thing
  // the two passes do not share.
  const mirror = async (
    copies: Copy[],
    resolveMaster: (m: string) => string,
    label: (m: string) => string
  ): Promise<number> => {
    let n = 0;
    for (const { master, dest } of copies) {
      const from = resolveMaster(master);
      if (!existsSync(from)) {
        console.error(`sync-brand: source ${rel(from)} does not exist`);
        process.exit(1);
      }
      const to = join(repoRoot, dest);
      const src = await readFile(from);
      const dst = existsSync(to) ? await readFile(to) : null;
      if (dst && dst.equals(src)) continue;
      n++;
      if (!check) {
        await mkdir(dirname(to), { recursive: true });
        await writeFile(to, src);
      }
      log(`  ${dst === null ? 'new  ' : 'sync '} ${rel(to)}  (from ${label(master)})`);
    }
    return n;
  };

  const changed = await mirror(
    COPIES,
    (m) => join(masterDir, m),
    (m) => `brand/${m}`
  );
  const rasterChanged = await mirror(
    RASTER_COPIES,
    (m) => join(repoRoot, m),
    (m) => m
  );

  const total = COPIES.length + RASTER_COPIES.length;
  if (check && changed + rasterChanged) {
    console.error(
      `\nsync-brand: ${changed + rasterChanged} of ${total} destinations have drifted from their source.\n` +
      'Run `npm run brand:sync` and commit the result.'
    );
    process.exit(1);
  }

  log(
    changed + rasterChanged
      ? `sync-brand: ${masters.length} masters, ${total} destinations checked, ${changed + rasterChanged} written.`
      : `sync-brand: ${masters.length} masters, ${total} destinations already mirrored.`
  );
  log(
    `sync-brand: ${RASTER_COPIES.length} rendered PNGs mirrored but never regenerated ` +
    '(no in-repo provenance — see header comment).'
  );
}

main().catch((err) => {
  console.error('sync-brand:', err.message);
  process.exit(1);
});
