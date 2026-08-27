#!/usr/bin/env node
/**
 * Build step for patrick-linehan-films.
 *
 * `site/` is written by Claude Design and is NEVER edited by hand.
 * This script treats it as read-only input and produces `dist/`, which is
 * what Cloudflare Pages serves. Re-exporting from Claude Design therefore
 * costs nothing — every fix below is re-applied automatically on each deploy.
 *
 * What it does:
 *   1. Copies site/ -> dist/
 *   2. Vendors React / ReactDOM / Babel out of node_modules into dist/vendor/
 *      so the live site does not depend on unpkg.com being up.
 *   3. Points the runtime at those local copies via window.__resources, which
 *      is the runtime's own documented override hook (see cdnScriptFor in
 *      support.js) — no generated code is patched.
 *   4. Injects favicon <link> tags.
 *
 * Design rule: never fail the build over a hardening step. If something can't
 * be vendored we log it loudly and leave the original CDN URL in place, so the
 * worst case is the site deploys exactly as it does today.
 */

import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'dist');
const VENDOR_DIR = path.join(OUT, 'vendor');

const log = (...a) => console.log('[build]', ...a);
const warn = (...a) => console.warn('[build] WARNING:', ...a);

// ---------------------------------------------------------------- 1. copy

if (!existsSync(SRC)) {
  console.error('[build] FATAL: no site/ directory found. Nothing to build.');
  process.exit(1);
}

await cp(SRC, OUT, { recursive: true });
log(`copied site/ -> dist/`);

// ------------------------------------------------------- 2. vendor the CDN

const supportPath = path.join(OUT, 'support.js');
/** @type {Record<string,string>} maps original CDN url -> local path */
const resourceMap = {};

if (existsSync(supportPath)) {
  const support = await readFile(supportPath, 'utf8');

  // e.g. https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js
  const CDN_RE = /https:\/\/unpkg\.com\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/([^"'\s)]+)/g;
  const found = [...new Set([...support.matchAll(CDN_RE)].map(m => m[0]))];

  if (found.length === 0) {
    log('no unpkg URLs found in support.js — nothing to vendor (runtime may have changed)');
  } else {
    await mkdir(VENDOR_DIR, { recursive: true });
  }

  for (const url of found) {
    CDN_RE.lastIndex = 0;
    const [, pkg, wantedVersion, subpath] = new RegExp(CDN_RE.source).exec(url);
    const localSource = path.join(ROOT, 'node_modules', pkg, subpath);

    try {
      await access(localSource);
    } catch {
      warn(
        `could not vendor ${pkg}@${wantedVersion} — ${path.relative(ROOT, localSource)} is missing. ` +
        `Leaving the unpkg URL in place. Add "${pkg}": "${wantedVersion}" to package.json to fix.`
      );
      continue;
    }

    // Flag drift between what the runtime asks for and what we installed.
    try {
      const installed = JSON.parse(
        await readFile(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')
      ).version;
      if (installed !== wantedVersion) {
        warn(
          `version drift for ${pkg}: runtime wants ${wantedVersion}, package.json pins ${installed}. ` +
          `Vendoring ${installed}. Update package.json if Claude Design bumped its runtime.`
        );
      }
    } catch { /* version check is best-effort */ }

    const fileName = path.basename(subpath);
    await cp(localSource, path.join(VENDOR_DIR, fileName));
    resourceMap[url] = `/vendor/${fileName}`;
    log(`vendored ${pkg}@${wantedVersion} -> /vendor/${fileName}`);
  }
} else {
  warn('no dist/support.js — skipping CDN vendoring');
}

// ------------------------------------------------ 3. + 4. rewrite index.html

const indexPath = path.join(OUT, 'index.html');
if (!existsSync(indexPath)) {
  console.error('[build] FATAL: dist/index.html missing.');
  process.exit(1);
}

let html = await readFile(indexPath, 'utf8');

const FAVICON_TAGS = [
  '<link rel="icon" href="/favicon.ico" sizes="any">',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
].join('\n');

const injected = [];

// Favicons — skip if a fresh export already carries them.
if (!/rel=["']icon["']/i.test(html)) {
  html = html.replace(/<\/title>/i, `</title>\n${FAVICON_TAGS}`);
  injected.push('favicon links');
} else {
  log('favicon links already present in export — leaving as-is');
}

// Resource overrides must be defined before support.js runs.
if (Object.keys(resourceMap).length > 0) {
  const tag =
    `<script>window.__resources=Object.assign(window.__resources||{},` +
    `${JSON.stringify(resourceMap)});</script>`;

  const supportTag = /<script[^>]*src=["'][^"']*support\.js["'][^>]*>\s*<\/script>/i;
  if (supportTag.test(html)) {
    html = html.replace(supportTag, m => `${tag}\n${m}`);
    injected.push(`${Object.keys(resourceMap).length} local resource overrides`);
  } else {
    warn('could not find the support.js <script> tag — CDN overrides NOT applied');
  }
}

await writeFile(indexPath, html);

log(injected.length ? `injected: ${injected.join(', ')}` : 'no injections needed');
log('done. Serve dist/');
