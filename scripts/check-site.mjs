#!/usr/bin/env node
/**
 * check-site.mjs — the gate site/ never had.
 *
 * `docs:check` proves the chapters are mirrored and their links resolve, and
 * `screenshots:check` proves the captures are in step. Nothing proved the two
 * pages themselves: that they load clean, that they fetch nothing from a third
 * party, and — the one that actually bites — that every relative path resolves
 * BOTH at `./` in this repo AND under the deployed base path, because
 * vulos-static/scripts/collect-repo-landings.mjs copies site/ verbatim into
 * `public/projects/slipscan/` and only renames the entry file to landing.html.
 * A path that works in one shape and not the other ships broken and silent.
 *
 * The suite already had the pieces, in three different repos:
 *   evermesh/tools/site/check.mjs   headless chromium, console + request guards
 *   wibbly/scripts/verify-demo.mjs  serve under the real deploy prefix, not root
 *   zana/tests/test_site.py         no third-party origin, every ref on disk
 * This is those three, for this repo, in one pass.
 *
 * Usage:
 *   node scripts/check-site.mjs            both path shapes, both pages
 *   node scripts/check-site.mjs --quiet     only failures
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(repoRoot, 'site');
const quiet = process.argv.includes('--quiet');

// Playwright lives with the desktop app, which is the only place in this repo
// that already depends on it. Resolving from there keeps this script a
// zero-install addition rather than a second copy of a 100MB dependency.
const require = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(
    'check-site: playwright is not installed. Run `npm install` in apps/desktop ' +
    '(it is already a devDependency there), then re-run this.'
  );
  process.exit(1);
}

// The deployed shape. collect-repo-landings.mjs writes public/projects/<slug>/,
// which Astro serves at /projects/slipscan/. Root is the repo shape.
const SHAPES = [
  { name: 'repo root', base: '/', entry: 'index.html' },
  { name: 'deployed', base: '/projects/slipscan/', entry: 'index.html' },
];
const BREAKPOINTS = [360, 768, 1440];

// A run that dies early must fail, not pass by doing nothing. Every shape
// contributes the same fixed number of assertions across the two pages.
const CHECKS_PER_PAGE = 4 + BREAKPOINTS.length;
const EXPECTED_CHECKS = SHAPES.length * 2 * CHECKS_PER_PAGE;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Serve site/ under `base`, 404ing anything outside it — as the real route does. */
function serve(base) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (!path.startsWith(base)) { res.writeHead(404); res.end('outside base'); return; }
    const file = normalize(join(siteDir, path.slice(base.length - 1)));
    if (!file.startsWith(normalize(siteDir))) { res.writeHead(403); res.end(); return; }
    try {
      const s = await stat(file);
      const target = s.isDirectory() ? join(file, 'index.html') : file;
      res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' });
      res.end(await readFile(target));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 ' + path);
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/**
 * Subresource origins this page actually reaches for. <a href> is navigation
 * and rel=canonical/og:url are metadata a scraper reads — neither is a fetch,
 * and both are REQUIRED to be absolute, so counting them would make the
 * self-containment rule impossible to satisfy.
 */
function collectExternal() {
  const out = new Set();
  const FETCHED = /^(stylesheet|icon|apple-touch-icon|manifest|preload|prefetch|modulepreload|mask-icon)$/i;
  const push = (v) => {
    let u; try { u = new URL(v, location.href); } catch { return; }
    if (u.origin !== location.origin && u.protocol !== 'data:' && u.protocol !== 'blob:') out.add(u.origin + '  <- ' + v);
  };
  for (const el of document.querySelectorAll('[src]')) push(el.getAttribute('src'));
  for (const el of document.querySelectorAll('[srcset]')) {
    el.getAttribute('srcset').split(',').forEach((s) => push(s.trim().split(/\s+/)[0]));
  }
  for (const el of document.querySelectorAll('link[href]')) {
    if ((el.getAttribute('rel') || '').split(/\s+/).some((r) => FETCHED.test(r))) push(el.getAttribute('href'));
  }
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const scan = (rs) => {
      for (const r of rs) {
        if (r.cssRules) scan(r.cssRules);
        for (const m of (r.cssText || '').matchAll(/url\((['"]?)([^'")]+)\1\)/g)) push(m[2]);
      }
    };
    scan(rules);
  }
  return [...out];
}

async function main() {
  if (!existsSync(siteDir)) { console.error(`check-site: no site/ at ${siteDir}`); process.exit(1); }
  const browser = await chromium.launch();
  const problems = [];
  let ran = 0;
  const log = (...a) => { if (!quiet) console.log(...a); };
  const note = (ok, where, msg) => {
    ran++;
    if (ok) log(`  ok    ${msg}`);
    else { problems.push(`${where}: ${msg}`); console.log(`  FAIL  ${msg}`); }
  };

  for (const shape of SHAPES) {
    const server = await serve(shape.base);
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const page of [shape.entry, 'docs.html']) {
      const url = `${origin}${shape.base}${page}`;
      const where = `${page} @ ${shape.name}`;
      log(`\n${page}  (${shape.name}: ${shape.base})`);

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const pg = await ctx.newPage();
      const failed = [], bad = [], errors = [];
      pg.on('requestfailed', (r) => failed.push(`${r.url()} — ${r.failure()?.errorText}`));
      pg.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
      pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      pg.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

      await pg.goto(url, { waitUntil: 'networkidle' });
      // Walk the gallery and flip the theme: both fetch lazily, so a broken
      // capture path only shows up if something actually asks for it.
      await pg.evaluate(() => {
        const next = document.getElementById('galNext');
        if (next) for (let i = 0; i < 13; i++) next.click();
        const t = document.getElementById('themeBtn'); if (t) t.click();
      });
      await pg.waitForTimeout(2500);
      // Every docs chapter, including the built-in one, has to render.
      if (page === 'docs.html') {
        const slugs = await pg.$$eval('.docs-nav a[data-slug]', (as) => as.map((a) => a.dataset.slug));
        for (const slug of slugs) {
          await pg.evaluate((s) => { location.hash = '#' + s; }, slug);
          await pg.waitForFunction(() => {
            const c = document.getElementById('content');
            return c && c.textContent.trim() !== 'Loading…' && c.textContent.length > 200;
          }, null, { timeout: 8000 }).catch(() => errors.push(`docs chapter "${slug}" never rendered`));
          const err = await pg.$('.docs-error');
          if (err) errors.push(`docs chapter "${slug}" rendered an error box`);
        }
      }
      await pg.evaluate(() => { const t = document.getElementById('themeBtn'); if (t) t.click(); });
      await pg.waitForTimeout(1200);

      note(failed.length === 0, where, `no failed requests${failed.length ? ' — ' + failed.join('; ') : ''}`);
      note(bad.length === 0, where, `no response >= 400${bad.length ? ' — ' + bad.join('; ') : ''}`);
      note(errors.length === 0, where, `no console or page error${errors.length ? ' — ' + errors.join('; ') : ''}`);

      const ext = await pg.evaluate(collectExternal);
      note(ext.length === 0, where, `self-contained: no external subresource origin${ext.length ? ' — ' + ext.join('; ') : ''}`);

      for (const w of BREAKPOINTS) {
        await pg.setViewportSize({ width: w, height: 900 });
        await pg.waitForTimeout(300);
        const m = await pg.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        note(m.sw <= m.cw, where, `no horizontal scroll @${w} (scrollWidth ${m.sw} <= clientWidth ${m.cw})`);
      }
      await ctx.close();
    }
    server.close();
  }
  await browser.close();

  if (ran !== EXPECTED_CHECKS) {
    problems.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran — the run did not complete`);
  }
  if (problems.length) {
    console.error(`\ncheck-site: ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n` +
      problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`\ncheck-site: ${ran} checks passed — ${relative(repoRoot, siteDir)}/ loads clean, ` +
    `fetches nothing off-origin, and resolves at both ./ and /projects/slipscan/.`);
}

main().catch((e) => { console.error('check-site:', e); process.exit(1); });
