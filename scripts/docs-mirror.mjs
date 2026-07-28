#!/usr/bin/env node
/**
 * docs-mirror.mjs — keep the published docs from contradicting the repo's docs.
 *
 * `site/` is FlowStock's own product site: self-contained static HTML that
 * `site/docs.html` renders by fetching markdown from `site/docs/` at runtime.
 * vulos-static collects `site/` at build time (its `public/products/flowstock/`
 * is gitignored), so this repo — not that one — is the source of what gets
 * served at /products/flowstock/docs.html.
 *
 * That made `site/docs/` a hand-maintained second copy of `docs/`, and it
 * drifted: the published SYNC page described sync as bearer-secret
 * authenticated long after the code moved to mutual Ed25519, and omitted the
 * `org_id` workspace isolation entirely. A published security claim that is
 * wrong in the *weaker* direction is the worst kind of doc bug — a reader plans
 * their threat model around it.
 *
 * So the mirror is no longer maintained by hand. Every page `site/docs.html`
 * publishes must be a byte-identical copy of the file of the same name in
 * `docs/`, and this script is the gate:
 *
 *   node scripts/docs-mirror.mjs --check   # npm run docs:check  (CI)
 *   node scripts/docs-mirror.mjs --write   # npm run docs:sync   (after editing docs/)
 *
 * ── How it fails ──────────────────────────────────────────────────────────
 * It fails closed and it never skips. Both trees are inside this repo, so
 * there is no "nothing to compare against" state to tolerate: a missing
 * docs.html, an unparseable DOCS manifest, a manifest with fewer entries than
 * MIN_PUBLISHED, a missing source, a missing mirror, differing bytes, or an
 * unaccounted-for file in site/docs/ are all exit 1. The count of pages
 * actually compared is asserted against the manifest and printed, so the gate
 * cannot report success for work it did not do.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = join(repoRoot, "docs");
const SITE_DIR = join(repoRoot, "site");
const SITE_DOCS_DIR = join(SITE_DIR, "docs");
const DOCS_HTML = join(SITE_DIR, "docs.html");

/**
 * The published set is expected to be at least this big. It is a floor, not an
 * equality: adding a page to site/docs.html raises the real count and this
 * still passes, but silently *dropping* pages — the failure mode where a gate
 * keeps passing while covering less and less — trips it.
 */
const MIN_PUBLISHED = 5;

const mode = process.argv.includes("--write")
  ? "write"
  : process.argv.includes("--check")
    ? "check"
    : "check";

const problems = [];
const fail = (msg) => problems.push(msg);

/** Parse the DOCS manifest out of site/docs.html — the list of pages the site actually publishes. */
function publishedDocs() {
  if (!existsSync(DOCS_HTML)) {
    fail(
      `${rel(DOCS_HTML)} does not exist — cannot tell which docs the site publishes`,
    );
    return [];
  }
  const html = readFileSync(DOCS_HTML, "utf8");
  const start = html.indexOf("const DOCS = [");
  if (start === -1) {
    fail(
      `${rel(DOCS_HTML)} has no \`const DOCS = [\` manifest; this gate reads it to know what is published`,
    );
    return [];
  }
  const end = html.indexOf("];", start);
  if (end === -1) {
    fail(
      `${rel(DOCS_HTML)}: the \`const DOCS = [\` manifest is not terminated by \`];\``,
    );
    return [];
  }
  const block = html.slice(start, end);

  const out = [];
  const entry =
    /\{[^{}]*?"slug"\s*:\s*"([^"]+)"[^{}]*?"path"\s*:\s*"([^"]+)"[^{}]*?\}/g;
  for (const m of block.matchAll(entry)) {
    const [, slug, path] = m;
    if (!path.startsWith("./docs/") || !path.endsWith(".md")) {
      fail(
        `${rel(DOCS_HTML)}: page "${slug}" loads ${path}, which is not a ./docs/*.md path — ` +
          `this gate only knows how to mirror ./docs/*.md`,
      );
      continue;
    }
    out.push({ slug, file: basename(path) });
  }
  return out;
}

const rel = (p) => p.slice(repoRoot.length + 1);

const docs = publishedDocs();

if (!problems.length && docs.length < MIN_PUBLISHED) {
  fail(
    `${rel(DOCS_HTML)} publishes ${docs.length} page(s); expected at least ${MIN_PUBLISHED}. ` +
      `Pages were removed from the site, or the manifest stopped parsing — either way this ` +
      `gate would silently be checking less than it was written to check. ` +
      `If the removal is intended, lower MIN_PUBLISHED in ${rel(fileURLToPath(import.meta.url))} deliberately.`,
  );
}

let compared = 0;
let written = 0;

for (const { slug, file } of docs) {
  const src = join(DOCS_DIR, file);
  const dst = join(SITE_DOCS_DIR, file);

  if (!existsSync(src)) {
    fail(
      `site page "${slug}" needs ${rel(src)}, which does not exist. ` +
        `The published docs are mirrored from docs/ — write the page there, not in site/docs/.`,
    );
    continue;
  }
  const want = readFileSync(src);

  if (!existsSync(dst)) {
    if (mode === "write") {
      writeFileSync(dst, want);
      written++;
      compared++;
      continue;
    }
    fail(
      `${rel(dst)} is missing but is published as "${slug}" — run \`npm run docs:sync\``,
    );
    continue;
  }

  const got = readFileSync(dst);
  if (!want.equals(got)) {
    if (mode === "write") {
      writeFileSync(dst, want);
      written++;
      compared++;
      continue;
    }
    fail(
      `${rel(dst)} differs from ${rel(src)} (${got.length} vs ${want.length} bytes). ` +
        `The published copy must never state something the repo's docs do not — ` +
        `edit ${rel(src)}, then run \`npm run docs:sync\`.`,
    );
    continue;
  }
  compared++;
}

// Nothing may sit in site/docs/ that the site does not publish from docs/: an
// orphan is exactly the hand-maintained page this gate exists to prevent.
if (existsSync(SITE_DOCS_DIR)) {
  const publishedFiles = new Set(docs.map((d) => d.file));
  for (const name of readdirSync(SITE_DOCS_DIR)) {
    if (!name.endsWith(".md")) continue;
    if (publishedFiles.has(name)) continue;
    fail(
      `${rel(join(SITE_DOCS_DIR, name))} is not published by ${rel(DOCS_HTML)} and is not mirrored from docs/. ` +
        `Publish it (add it to the DOCS manifest, with the page living in docs/) or delete it.`,
    );
  }
} else {
  fail(`${rel(SITE_DOCS_DIR)} does not exist`);
}

/**
 * The site shell pages (`site/*.html`) are hand-authored — there is no file in
 * docs/ to mirror them from — so they get a narrower guard: claims that were
 * published here and were *wrong*. Both of these actually shipped. Add a row
 * when a shell page is corrected, so the correction cannot be undone silently.
 */
const BANNED_CLAIMS = [
  {
    re: /bearer/i,
    why: "sync authenticates with mutual Ed25519 signatures (the shared secret only bootstraps pairing) — see docs/SYNC.md, 'Transport & security'",
  },
  {
    re: /~?\s?15\s?MB/i,
    why: "the measured linux/amd64 release binary is 12,005,560 bytes (11.45 MiB, ~12 MB) — see third_party/dmtapsync/VENDOR.md",
  },
];
const MIN_SHELL_PAGES = 2;

let shellPages = 0;
for (const name of existsSync(SITE_DIR) ? readdirSync(SITE_DIR) : []) {
  if (!name.endsWith(".html")) continue;
  shellPages++;
  const text = readFileSync(join(SITE_DIR, name), "utf8");
  for (const { re, why } of BANNED_CLAIMS) {
    const hit = text.match(re);
    if (hit)
      fail(
        `site/${name} contains the published-and-wrong claim ${JSON.stringify(hit[0])}: ${why}`,
      );
  }
}
if (shellPages < MIN_SHELL_PAGES) {
  fail(
    `scanned ${shellPages} shell page(s) under ${rel(SITE_DIR)}; expected at least ${MIN_SHELL_PAGES} ` +
      `(index.html and docs.html). The stale-claim scan checked almost nothing.`,
  );
}

// Coverage assertion: every page the manifest declares must have been compared.
if (!problems.length && compared !== docs.length) {
  fail(
    `only ${compared} of ${docs.length} published pages were compared — the gate did not do its whole job`,
  );
}

if (problems.length) {
  console.error(`docs:${mode} FAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    `\nCompared ${compared} of ${docs.length} published page(s) before failing.\n` +
      `docs/ is the source; site/docs/ is a byte-identical published mirror of it.\n`,
  );
  process.exit(1);
}

const names = docs.map((d) => d.file).join(", ");
if (mode === "write") {
  console.log(
    `docs:sync OK — ${compared}/${docs.length} published page(s) mirrored from docs/ (${written} rewritten): ${names}`,
  );
} else {
  console.log(
    `docs:check OK — ${compared}/${docs.length} published page(s) byte-identical to docs/: ${names}`,
  );
}
console.log(
  `  (${shellPages} site shell page(s) scanned for ${BANNED_CLAIMS.length} known-wrong published claim(s))`,
);

// Pages that live in docs/ but are not published are fine (they are developer
// docs), but say so — an unpublished page is invisible to every reader of the
// site, and that should be a decision rather than an oversight.
const unpublished = readdirSync(DOCS_DIR)
  .filter((n) => n.endsWith(".md"))
  .filter((n) => !docs.some((d) => d.file === n));
if (unpublished.length) {
  console.log(
    `  (not published on the site, developer docs only: ${unpublished.join(", ")})`,
  );
}
