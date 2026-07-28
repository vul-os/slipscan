#!/usr/bin/env node
// Copy the repo's markdown docs into site/docs/ for the docs viewer, and audit
// every link they contain against what the site actually serves.
//
// Why this exists: the docs viewer (site/docs.html) fetches markdown at
// runtime, so the site needs its own copy of every chapter. That copy used to
// be made by hand, and it quietly drifted: the published api.md was missing
// the whole household-member report block, selfhost.md still showed a 0.1.0
// /health response against a 0.2.0 repo, and roadmap.md did not know
// slipscan-sync existed. Readers of the site were served stale text with no
// signal that it was stale. Here the copy is a script, it is the only way the
// files get there, and `--check` fails CI if someone edits docs/ without
// re-running it.
//
// The chapters are still a pure copy — no content transform. site/docs.html
// rewrites relative targets at render time instead, because doing it here too
// would only give the two mechanisms a chance to disagree. What this script
// does instead is *audit* that render-time rewrite: it extracts the viewer's
// own resolver (the `@shared:docs-links` block in site/docs.html) and runs it
// over every link in every chapter, then checks that each resolved target is
// something the site can serve. Nothing is re-implemented here, so the audit
// cannot drift away from the viewer.
//
// That audit exists because five links were dead on the published site while
// every gate was green: docs/API.md and docs/ARCHITECTURE.md pointed at
// `parity.json`, CONTRIBUTING.md at `LICENSE-MIT` and `LICENSE-APACHE`, and
// GETTING-STARTED.md at `../README.md#features`. None of those are `.md` files
// in the viewer's chapter list, so the old render-time rewrite left them alone
// and the browser resolved them against site/, where they do not exist. Nine
// more in-page `#anchor` links were dead for a second reason: marked v16 emits
// no heading ids, and the viewer read the bare anchor as a chapter slug.
//
// Alongside the chapters this also mirrors the data files the docs cite by
// name (ASSETS below), so the site serves the actual bytes.
//
// Usage:
//   node scripts/sync-docs.mjs           copy docs/*.md  -> site/docs/*.md
//   node scripts/sync-docs.mjs --check   exit 1 if the copies are out of date
//   node scripts/sync-docs.mjs --quiet   only report changes and errors

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(repoRoot, 'docs');
const siteDir = join(repoRoot, 'site');
const siteDocsDir = join(siteDir, 'docs');
const viewerPath = join(siteDir, 'docs.html');

// Root-level markdown that the docs viewer also serves. Keyed by source path
// relative to the repo root; the value is the slug it lands under.
//
// PARITY.md lands on slug `parity`, i.e. site/docs/parity.md, next to the
// mirrored site/docs/parity.json below. The two are unrelated — the chapter is
// feature parity vs Xero/Vault22, the data file is IPC-vs-HTTP surface parity —
// but they cannot collide: resolveDocsLink sends `*.md` targets to the chapter
// map and everything else to DOC_ASSETS, so each name resolves one way only.
const EXTRA = {
  'CHANGELOG.md': 'changelog',
  'ROADMAP.md': 'roadmap',
  'PARITY.md': 'parity',
  'CONTRIBUTING.md': 'contributing',
  'SECURITY.md': 'security',
};

// Non-markdown files the chapters link to by name and that the site therefore
// has to serve. Source path relative to the repo root -> name served under
// ./docs/. site/docs.html has to agree (its DOC_ASSETS); --check enforces that.
//
// parity.json earns a copy rather than a link to GitHub because it is not a
// reference, it is content: API.md calls it "the three sets ... machine-
// readable", so a reader following that sentence wants the bytes. The two
// LICENSE files deliberately do not get the same treatment — a licence's
// canonical home is the repo root, site/LICENSE.txt already carries the MIT
// text, and a third copy of each is a thing that can go stale silently. Those
// resolve to the repo instead.
const ASSETS = {
  'docs/parity.json': 'parity.json',
};

// Links that reach a published chapter but name a heading that is no longer in
// it. These are not dead — the viewer still lands the reader on the right
// chapter — but they no longer land on the right section, and the fix belongs
// in docs/*.md, which this script does not own. Listing one here is a ratchet,
// not an escape hatch: an entry that no longer applies fails this gate just as
// loudly as a new stale anchor does, so the list cannot quietly rot.
const KNOWN_STALE_ANCHORS = [];

const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const quiet = args.has('--quiet');

/** `GETTING-STARTED.md` -> `getting-started.md` */
const slugFor = (name) => name.replace(/\.md$/i, '').toLowerCase() + '.md';

const rel = (p) => relative(repoRoot, p);
const log = (...a) => { if (!quiet) console.log(...a); };

async function collect() {
  const out = [];

  // Only docs/*.md itself — not subdirectories (docs/screenshots/ is images,
  // mirrored separately by scripts/sync-screenshots.mjs).
  const entries = await readdir(docsDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    out.push({ kind: 'chapter', from: join(docsDir, e.name), to: join(siteDocsDir, slugFor(e.name)) });
  }

  for (const [src, slug] of Object.entries(EXTRA)) {
    const from = join(repoRoot, src);
    if (existsSync(from)) out.push({ kind: 'chapter', from, to: join(siteDocsDir, `${slug}.md`) });
  }

  for (const [src, name] of Object.entries(ASSETS)) {
    const from = join(repoRoot, src);
    if (existsSync(from)) out.push({ kind: 'asset', from, to: join(siteDocsDir, name) });
  }

  return out.sort((a, b) => a.to.localeCompare(b.to));
}

// ---------------------------------------------------------------------------
// The viewer's own link resolver, loaded out of site/docs.html
// ---------------------------------------------------------------------------

/**
 * Pull the `@shared:docs-links` block out of site/docs.html and evaluate it, so
 * the audit below resolves links with the exact code the browser runs. Throws
 * rather than degrading: an audit that silently stopped matching the viewer
 * would be worse than no audit.
 */
async function loadViewer() {
  if (!existsSync(viewerPath)) throw new Error(`no viewer at ${rel(viewerPath)}`);
  const html = await readFile(viewerPath, 'utf8');

  const block = html.match(/\/\* @shared:docs-links[^]*?\*\/([^]*?)\/\* @end:docs-links \*\//);
  if (!block) {
    throw new Error(
      `${rel(viewerPath)} has no /* @shared:docs-links */ … /* @end:docs-links */ block — ` +
      'the link audit resolves targets with the viewer\'s own code and cannot run without it'
    );
  }

  const source = `${block[1]}\nexport { REPO_BLOB, REPO_RAW, DOC_ASSETS, slugifyHeading, headingId, resolveDocsLink };`;
  const shared = await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);

  // The viewer's chapter list, in its own words.
  const docs = [...html.matchAll(/\{\s*"slug"\s*:\s*"([^"]+)"\s*,\s*"title"\s*:\s*"[^"]*"\s*,\s*"path"\s*:\s*"\.\/docs\/([^"]+)"\s*\}/g)]
    .map((m) => ({ slug: m[1], file: m[2] }));
  if (docs.length === 0) throw new Error(`${rel(viewerPath)} has no recognisable DOCS array`);

  return { shared, docs };
}

// ---------------------------------------------------------------------------
// Link audit
// ---------------------------------------------------------------------------

/** Markdown inline syntax -> the text content the browser will see in a heading. */
const inlineText = (s) => s
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/[`*~]/g, '')
  .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
  .trim();

/**
 * Blank out code so it is not scanned as markup — a `[foo](bar)` in a shell
 * sample is not a link. Replacement keeps byte length and newlines, so indices
 * into the result still point at the right line of the original.
 */
const stripCode = (md) => md
  .replace(/^([ \t]*)(```+|~~~+)[^\n]*\n[^]*?\n\1?\2[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

/** Every id a chapter will actually have in the DOM once the viewer renders it. */
function anchorIds(md, headingId) {
  const text = stripCode(md);
  const ids = new Set();
  const seen = new Map();

  for (const line of text.split('\n')) {
    const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) ids.add(headingId(inlineText(h[2]), seen));
  }

  // Explicit HTML anchors count too. docs/THREAT-MODEL.md marks a numbered list
  // item with `<a id="self-host-mode"></a>` because it has no heading of its
  // own, and marked passes raw HTML straight through — so the browser really
  // does have that id, and treating it as missing would be a false alarm.
  for (const m of text.matchAll(/<[a-z][a-z0-9-]*\b[^>]*?\b(?:id|name)="([^"]+)"/gi)) ids.add(m[1]);

  return ids;
}

/** Every link and image target in a markdown file, with its line number. */
function targets(md) {
  const out = [];
  const push = (line, isImage, href) => out.push({ line, isImage, href });
  const lineOf = (index) => md.slice(0, index).split('\n').length;
  const scan = stripCode(md);

  for (const m of scan.matchAll(/(!?)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    push(lineOf(m.index), m[1] === '!', m[3]);
  }
  for (const m of scan.matchAll(/<img\b[^>]*?\bsrc="([^"]*)"/gi)) push(lineOf(m.index), true, m[1]);
  for (const m of scan.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/gi)) push(lineOf(m.index), false, m[1]);
  // Reference-style definitions: [label]: target
  for (const m of scan.matchAll(/^ {0,3}\[[^\]]+\]:\s*(\S+)/gm)) push(lineOf(m.index), false, m[1]);

  return out;
}

/** A repo path is only servable if it stays inside the repo. */
function insideRepo(path) {
  const abs = resolve(repoRoot, path);
  return abs === repoRoot || abs.startsWith(repoRoot + sep);
}

/**
 * Resolve every link in every published chapter with the viewer's own resolver
 * and confirm the result is something the site can actually serve.
 *
 * Fails closed: each resolved target must match a branch below, and the
 * `default` case rejects anything else, so a resolver that grows a new kind
 * fails the gate instead of being waved through.
 */
function auditLinks(chapters, { shared, docs }) {
  const { resolveDocsLink, headingId, DOC_ASSETS } = shared;
  const fileToSlug = Object.fromEntries(docs.map((d) => [d.file.toLowerCase(), d.slug]));
  const published = new Set(docs.map((d) => d.slug));
  const anchors = new Map();
  for (const c of chapters) anchors.set(c.slug, anchorIds(c.text, headingId));

  const dead = [];
  const tolerated = new Set();
  for (const chapter of chapters) {
    const fail = (t, why) => dead.push({ chapter: chapter.slug, ...t, why });

    for (const t of targets(chapter.text)) {
      const r = resolveDocsLink(t.href, { slug: chapter.slug, docs: fileToSlug, isImage: t.isImage });
      switch (r.kind) {
        case 'external':
          // Not fetched — a gate that needs the network is a gate that flakes.
          // The shape is still checked, so a typo'd scheme cannot pass as one.
          if (!/^(?:https?:\/\/|mailto:)/i.test(r.href)) fail(t, `unsupported scheme in "${r.href}"`);
          break;

        case 'chapter': {
          if (!published.has(r.slug)) { fail(t, `no published chapter "${r.slug}"`); break; }
          if (!r.anchor || anchors.get(r.slug).has(r.anchor)) break;
          const known = KNOWN_STALE_ANCHORS.findIndex(
            (k) => k.from === chapter.source && k.slug === r.slug && k.anchor === r.anchor
          );
          if (known === -1) fail(t, `chapter "${r.slug}" has no anchor "#${r.anchor}"`);
          else tolerated.add(known);
          break;
        }

        case 'screenshot':
          if (!existsSync(join(siteDir, 'screenshots', r.file))) {
            fail(t, `site/screenshots/${r.file} is not served (run \`npm run screenshots:sync\`)`);
          }
          break;

        case 'asset':
          if (!Object.prototype.hasOwnProperty.call(DOC_ASSETS, r.file)) fail(t, `"${r.file}" is not a mirrored asset`);
          else if (!existsSync(join(siteDocsDir, r.file))) fail(t, `site/docs/${r.file} is not served`);
          break;

        case 'repo':
          // The fallback points at the file in the repo, which only helps if the
          // file is there — so that is checked too, and a bad target still fails.
          if (!insideRepo(r.path)) fail(t, `"${r.path}" escapes the repo`);
          else if (!existsSync(join(repoRoot, r.path))) fail(t, `${r.path} does not exist in the repo`);
          else if (r.anchor && /\.md$/i.test(r.path)) {
            const ids = anchorIds(readFileSync(join(repoRoot, r.path), 'utf8'), headingId);
            if (!ids.has(r.anchor)) fail(t, `${r.path} has no anchor "#${r.anchor}"`);
          }
          break;

        default:
          fail(t, r.why || `unresolved target (kind "${r.kind}")`);
      }
    }
  }

  // The other half of the ratchet: an allowance nobody needed means the doc was
  // fixed, and the entry has to go with it.
  return {
    dead,
    obsolete: KNOWN_STALE_ANCHORS.filter((_, i) => !tolerated.has(i)),
    tolerated: [...tolerated].map((i) => KNOWN_STALE_ANCHORS[i]),
  };
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(docsDir)) {
    console.error(`sync-docs: no docs/ directory at ${docsDir}`);
    process.exit(1);
  }

  const files = await collect();
  if (files.filter((f) => f.kind === 'chapter').length === 0) {
    console.error('sync-docs: docs/ contains no markdown files');
    process.exit(1);
  }

  const missingAssets = Object.keys(ASSETS).filter((src) => !existsSync(join(repoRoot, src)));
  if (missingAssets.length) {
    console.error(`sync-docs: missing source asset(s): ${missingAssets.join(', ')}`);
    process.exit(1);
  }

  await mkdir(siteDocsDir, { recursive: true });

  const expected = new Set(files.map((f) => f.to));
  const stale = [];
  let changed = 0;

  // Remove copies whose source has gone away, so a deleted chapter — or a
  // retired data file — cannot linger on the site. site/docs/ is written only
  // by this script, so anything unexpected in it is by definition stale.
  for (const e of await readdir(siteDocsDir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(siteDocsDir, e.name);
    if (expected.has(path)) continue;
    stale.push(path);
    if (!check) await rm(path);
  }

  for (const { from, to } of files) {
    const src = await readFile(from, 'utf8');
    const dst = existsSync(to) ? await readFile(to, 'utf8') : null;
    if (dst === src) continue;
    changed++;
    if (!check) await writeFile(to, src);
    log(`  ${dst === null ? 'new  ' : 'sync '} ${rel(to)}`);
  }

  for (const path of stale) {
    log(`  ${check ? 'stale' : 'rm   '} ${rel(path)}`);
  }

  const { shared, docs } = await loadViewer();

  // A chapter can be copied here perfectly and still be unreachable, because
  // the viewer's own chapter list is a hand-written array in site/docs.html.
  // CONTRIBUTING.md and SECURITY.md were unreachable for exactly that reason —
  // they existed in the repo and were simply never added to the viewer.
  // Copying without linking is the same failure this script exists to stop,
  // so the two are checked against each other, in both directions.
  const publishedFiles = new Set(
    files.filter((f) => f.kind === 'chapter').map((f) => f.to.slice(siteDocsDir.length + 1))
  );
  const linkedFiles = new Set(docs.map((d) => d.file));
  const problems = [];
  for (const name of publishedFiles) {
    if (!linkedFiles.has(name)) problems.push(`site/docs.html does not link published chapter site/docs/${name}`);
  }
  for (const name of linkedFiles) {
    if (!publishedFiles.has(name)) problems.push(`site/docs.html lists ./docs/${name}, which this script does not publish`);
  }
  // The viewer's DOC_ASSETS and this script's ASSETS describe the same set of
  // mirrored data files from two sides; if they disagree, one of them 404s.
  const mirrored = new Set(Object.values(ASSETS));
  const declared = new Set(Object.keys(shared.DOC_ASSETS));
  for (const name of mirrored) if (!declared.has(name)) problems.push(`site/docs.html DOC_ASSETS is missing "${name}"`);
  for (const name of declared) if (!mirrored.has(name)) problems.push(`site/docs.html DOC_ASSETS declares "${name}", which this script does not mirror`);

  if (problems.length) {
    console.error(`\nsync-docs: the viewer and the published files disagree:\n` +
      problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }

  // Audit the content that will be served: in --check that is the source, which
  // is byte-identical to site/docs/ whenever the freshness check below passes,
  // and is the right thing to read when it does not.
  const chapters = [];
  for (const f of files) {
    if (f.kind !== 'chapter') continue;
    const name = f.to.slice(siteDocsDir.length + 1);
    chapters.push({ slug: name.replace(/\.md$/i, ''), source: rel(f.from), text: await readFile(f.from, 'utf8') });
  }

  const { dead, obsolete, tolerated } = auditLinks(chapters, { shared, docs });
  if (dead.length) {
    console.error(
      `\nsync-docs: ${dead.length} link(s) would not resolve on the published site:\n` +
      dead.map((d) => {
        const src = chapters.find((c) => c.slug === d.chapter).source;
        return `  - ${src}:${d.line}  ${d.isImage ? '!' : ''}[…](${d.href})  — ${d.why}`;
      }).join('\n') +
      '\nFix the target, publish it, or point it at the repo.'
    );
    process.exit(1);
  }
  if (obsolete.length) {
    console.error(
      `\nsync-docs: ${obsolete.length} KNOWN_STALE_ANCHORS entr(y/ies) no longer apply:\n` +
      obsolete.map((k) => `  - ${k.from} -> #${k.slug}:${k.anchor}`).join('\n') +
      '\nThe anchor resolves now — delete the entry from scripts/sync-docs.mjs.'
    );
    process.exit(1);
  }
  for (const k of tolerated) {
    log(`  stale-anchor  ${k.from} -> #${k.slug}:${k.anchor} — ${k.note}`);
  }

  if (check && (changed || stale.length)) {
    console.error(
      `\nsync-docs: site/docs is out of date (${changed} to copy, ${stale.length} stale).\n` +
      'Run `npm run docs:sync` and commit the result.'
    );
    process.exit(1);
  }

  const linkCount = chapters.reduce((n, c) => n + targets(c.text).length, 0);
  log(
    (changed || stale.length
      ? `sync-docs: ${files.length} files, ${changed} written, ${stale.length} removed`
      : `sync-docs: ${files.length} files already up to date`) +
    ` — ${linkCount} links across ${chapters.length} chapters all resolve.`
  );
}

main().catch((err) => {
  console.error('sync-docs:', err.message);
  process.exit(1);
});
