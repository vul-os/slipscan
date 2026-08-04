#!/usr/bin/env node
/**
 * check-site.ts — the gate site/ never had.
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
 *   node scripts/check-site.ts            both path shapes, both pages
 *   node scripts/check-site.ts --quiet     only failures
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Browser, ConsoleMessage, Page, Request as PwRequest, Response as PwResponse } from 'playwright';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(repoRoot, 'site');
const quiet = process.argv.includes('--quiet');

// Playwright lives with the desktop app, which is the only place in this repo
// that already depends on it. Resolving from there keeps this script a
// zero-install addition rather than a second copy of a 100MB dependency.
const require = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'));
let chromium: typeof import('playwright').chromium;
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
interface Shape {
  name: string;
  base: string;
  entry: string;
}

const SHAPES: Shape[] = [
  { name: 'repo root', base: '/', entry: 'index.html' },
  { name: 'deployed', base: '/projects/slipscan/', entry: 'index.html' },
];
const BREAKPOINTS = [360, 768, 1440];

// A run that dies early must fail, not pass by doing nothing. Every shape
// contributes the same fixed number of assertions across the two pages.
const CHECKS_PER_PAGE = 4 + BREAKPOINTS.length;
const EXPECTED_CHECKS = SHAPES.length * 2 * CHECKS_PER_PAGE;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Serve site/ under `base`, 404ing anything outside it — as the real route does. */
function serve(base: string): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0].split('#')[0]);
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
 *
 * Runs inside the page via `page.evaluate`, so it only has DOM globals — no
 * import from this module reaches it, which is why its types are declared
 * loosely (`document`/`location` are ambient DOM globals in this file only
 * because playwright's `evaluate` serialises the function source, not because
 * this script itself runs in a browser).
 */
function collectExternal(): string[] {
  const out = new Set<string>();
  const FETCHED = /^(stylesheet|icon|apple-touch-icon|manifest|preload|prefetch|modulepreload|mask-icon)$/i;
  const push = (v: string | null) => {
    if (v === null) return;
    let u: URL;
    try { u = new URL(v, location.href); } catch { return; }
    if (u.origin !== location.origin && u.protocol !== 'data:' && u.protocol !== 'blob:') out.add(u.origin + '  <- ' + v);
  };
  for (const el of document.querySelectorAll('[src]')) push(el.getAttribute('src'));
  for (const el of document.querySelectorAll('[srcset]')) {
    (el.getAttribute('srcset') ?? '').split(',').forEach((s) => push(s.trim().split(/\s+/)[0]));
  }
  for (const el of document.querySelectorAll('link[href]')) {
    if ((el.getAttribute('rel') || '').split(/\s+/).some((r) => FETCHED.test(r))) push(el.getAttribute('href'));
  }
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    const scan = (rs: CSSRuleList) => {
      for (const r of rs) {
        const grouping = r as CSSGroupingRule;
        if (grouping.cssRules) scan(grouping.cssRules);
        for (const m of (r.cssText || '').matchAll(/url\((['"]?)([^'")]+)\1\)/g)) push(m[2]);
      }
    };
    scan(rules);
  }
  return [...out];
}

async function main() {
  if (!existsSync(siteDir)) { console.error(`check-site: no site/ at ${siteDir}`); process.exit(1); }
  const browser: Browser = await chromium.launch();
  const problems: string[] = [];
  let ran = 0;
  const log = (...a: unknown[]) => { if (!quiet) console.log(...a); };
  const note = (ok: boolean, where: string, msg: string) => {
    ran++;
    if (ok) log(`  ok    ${msg}`);
    else { problems.push(`${where}: ${msg}`); console.log(`  FAIL  ${msg}`); }
  };

  for (const shape of SHAPES) {
    const server = await serve(shape.base);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const page of [shape.entry, 'docs.html']) {
      const url = `${origin}${shape.base}${page}`;
      const where = `${page} @ ${shape.name}`;
      log(`\n${page}  (${shape.name}: ${shape.base})`);

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const pg: Page = await ctx.newPage();
      const failed: string[] = [], bad: string[] = [], errors: string[] = [];
      // `net::ERR_ABORTED` means the request was CANCELLED, not that the
      // resource is missing — flipping an <img> src supersedes the in-flight
      // load for the previous one. It is not evidence of a broken capture
      // path, and counting it made this check fail about one run in four,
      // which is worse than not having it: a gate that fails randomly teaches
      // people to re-run until green. A genuinely missing file still fails,
      // via the >= 400 response check below or a non-aborted error here.
      pg.on('requestfailed', (r: PwRequest) => {
        const why = r.failure()?.errorText ?? '';
        if (why.includes('net::ERR_ABORTED')) return;
        failed.push(`${r.url()} — ${why}`);
      });
      pg.on('response', (r: PwResponse) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
      pg.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') errors.push(m.text()); });
      pg.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));

      await pg.goto(url, { waitUntil: 'networkidle' });
      // Walk the gallery and flip the theme: both fetch lazily, so a broken
      // capture path only shows up if something actually asks for it.
      // Paced, not hammered. Clicking 13 times in one synchronous loop
      // superseded every image before it finished loading, so the walk proved
      // nothing about whether those captures exist — the point of walking it.
      // A beat between clicks lets each one actually load and be checked.
      const shots = await pg.evaluate(() => {
        const next = document.getElementById('galNext');
        return next ? 13 : 0;
      });
      for (let i = 0; i < shots; i++) {
        await pg.evaluate(() => document.getElementById('galNext')?.click());
        await pg.waitForTimeout(120);
      }
      await pg.evaluate(() => { const t = document.getElementById('themeBtn'); if (t) (t as HTMLElement).click(); });
      await pg.waitForTimeout(2500);
      // Every docs chapter, including the built-in one, has to render.
      if (page === 'docs.html') {
        const slugs = await pg.$$eval('.docs-nav a[data-slug]', (as) => as.map((a) => (a as HTMLElement).dataset.slug));
        for (const slug of slugs) {
          await pg.evaluate((s) => { location.hash = '#' + s; }, slug);
          await pg.waitForFunction(() => {
            const c = document.getElementById('content');
            return c && c.textContent!.trim() !== 'Loading…' && c.textContent!.length > 200;
          }, null, { timeout: 8000 }).catch(() => errors.push(`docs chapter "${slug}" never rendered`));
          const err = await pg.$('.docs-error');
          if (err) errors.push(`docs chapter "${slug}" rendered an error box`);
        }
      }
      await pg.evaluate(() => { const t = document.getElementById('themeBtn'); if (t) (t as HTMLElement).click(); });
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
