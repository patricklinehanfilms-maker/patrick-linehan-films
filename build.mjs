#!/usr/bin/env node
/**
 * Build step for patrick-linehan-films.
 *
 * `site/` is written by Claude Design and is NEVER edited by hand.
 * `static/` is ours — assets Claude Design knows nothing about.
 *
 * The game at play/ is the exception: Claude Design owns it now and ships it in
 * every export, so site/play/ is authoritative and static/ must not shadow it —
 * otherwise a fix made in Design would be silently discarded here.
 * This script merges both into `dist/`, which Cloudflare Pages serves.
 *
 * Re-exporting from Claude Design therefore costs nothing: every fix below is
 * re-applied automatically on each deploy.
 *
 *   1. site/ -> dist/           (the export)
 *   2. static/ -> dist/          (our assets: og-image, etc.)
 *   3. vendor React/ReactDOM/Babel from node_modules into dist/vendor/
 *      so the live site never depends on unpkg.com being up
 *   4. point the runtime at those via window.__resources — the runtime's own
 *      override hook (see cdnScriptFor in support.js). No generated code is patched.
 *   5. inject favicons, canonical URL, and Open Graph / Twitter tags
 *   6. strip campaign tags (utm_*, fbclid, …) from the address bar on load
 *   7. serve play/index.html as the 404 page too
 *
 * Design rule: never fail the build over a hardening step. If something can't be
 * applied we log it loudly and carry on, so the worst case is the site deploys
 * exactly as Claude Design exported it.
 */

import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'site');
const STATIC = path.join(ROOT, 'static');
const OUT = path.join(ROOT, 'dist');
const VENDOR_DIR = path.join(OUT, 'vendor');

const SITE_URL = 'https://patrickjlinehan.com';
const TITLE = 'Patrick Linehan Films — Director';
const DESCRIPTION =
  'Emmy and Clio award-winning director. Music video, documentary and narrative, based in Brooklyn.';

const log = (...a) => console.log('[build]', ...a);
const warn = (...a) => console.warn('[build] WARNING:', ...a);

// ------------------------------------------------------------------ 1. + 2.

if (!existsSync(SRC)) {
  console.error('[build] FATAL: no site/ directory found. Nothing to build.');
  process.exit(1);
}
await cp(SRC, OUT, { recursive: true });
log('copied site/ -> dist/');

if (existsSync(STATIC)) {
  // Skip static/play — Claude Design owns the game and ships it in site/play/.
  // Copying ours over it would throw away edits made in Design.
  const skipPlay = (src) => {
    const rel = path.relative(STATIC, src);
    return !(rel === 'play' || rel.startsWith('play' + path.sep));
  };
  await cp(STATIC, OUT, { recursive: true, filter: skipPlay });
  log('copied static/ -> dist/ (play/ left to Claude Design)');
} else {
  log('no static/ directory — skipping');
}

// ------------------------------------------------------------- 3. + 4. vendor

const supportPath = path.join(OUT, 'support.js');
const resourceMap = {};

if (existsSync(supportPath)) {
  const support = await readFile(supportPath, 'utf8');
  const CDN_RE = /https:\/\/unpkg\.com\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/([^"'\s)]+)/g;
  const found = [...new Set([...support.matchAll(CDN_RE)].map(m => m[0]))];

  if (!found.length) {
    log('no unpkg URLs in support.js — nothing to vendor (runtime may have changed)');
  } else {
    await mkdir(VENDOR_DIR, { recursive: true });
  }

  for (const url of found) {
    const [, pkg, wantedVersion, subpath] = new RegExp(CDN_RE.source).exec(url);
    const localSource = path.join(ROOT, 'node_modules', pkg, subpath);
    try {
      await access(localSource);
    } catch {
      warn(
        `could not vendor ${pkg}@${wantedVersion} — ${path.relative(ROOT, localSource)} missing. ` +
        `Leaving the unpkg URL. Add "${pkg}": "${wantedVersion}" to package.json to fix.`
      );
      continue;
    }
    try {
      const installed = JSON.parse(
        await readFile(path.join(ROOT, 'node_modules', pkg, 'package.json'), 'utf8')
      ).version;
      if (installed !== wantedVersion) {
        warn(`version drift for ${pkg}: runtime wants ${wantedVersion}, installed ${installed}.`);
      }
    } catch { /* best effort */ }

    const fileName = path.basename(subpath);
    await cp(localSource, path.join(VENDOR_DIR, fileName));
    resourceMap[url] = `/vendor/${fileName}`;
    log(`vendored ${pkg}@${wantedVersion} -> /vendor/${fileName}`);
  }
} else {
  warn('no dist/support.js — skipping CDN vendoring');
}

// ------------------------------------------------------------ 5. rewrite head

const indexPath = path.join(OUT, 'index.html');
if (!existsSync(indexPath)) {
  console.error('[build] FATAL: dist/index.html missing.');
  process.exit(1);
}
let html = await readFile(indexPath, 'utf8');
const injected = [];

const FAVICONS = [
  '<link rel="icon" href="/favicon.ico" sizes="any">',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
].join('\n');

// Link previews (iMessage, WhatsApp, Slack, X, Facebook, LinkedIn all read these).
// og:image MUST be absolute — relative paths are silently ignored by every scraper.
const SOCIAL = [
  `<link rel="canonical" href="${SITE_URL}/">`,
  `<meta name="description" content="${DESCRIPTION}">`,
  `<meta property="og:type" content="website">`,
  `<meta property="og:site_name" content="Patrick Linehan Films">`,
  `<meta property="og:title" content="${TITLE}">`,
  `<meta property="og:description" content="${DESCRIPTION}">`,
  `<meta property="og:url" content="${SITE_URL}/">`,
  `<meta property="og:image" content="${SITE_URL}/og-image.jpg">`,
  `<meta property="og:image:type" content="image/jpeg">`,
  `<meta property="og:image:width" content="1200">`,
  `<meta property="og:image:height" content="630">`,
  `<meta property="og:image:alt" content="Patrick Linehan Films">`,
  `<meta name="twitter:card" content="summary_large_image">`,
  `<meta name="twitter:title" content="${TITLE}">`,
  `<meta name="twitter:description" content="${DESCRIPTION}">`,
  `<meta name="twitter:image" content="${SITE_URL}/og-image.jpg">`,
].join('\n');

if (!/rel=["']icon["']/i.test(html)) {
  html = html.replace(/<\/title>/i, `</title>\n${FAVICONS}`);
  injected.push('favicon links');
} else {
  log('favicon links already present in export — leaving as-is');
}

if (!/property=["']og:/i.test(html)) {
  html = html.replace(/<\/title>/i, `</title>\n${SOCIAL}`);
  injected.push('social + canonical tags');
} else {
  log('og: tags already present in export — leaving as-is');
}

// Links shared from Instagram's link-in-bio arrive as
// patrickjlinehan.com/?utm_source=ig&utm_medium=social&... — the site ignores them,
// but they look untidy when the link gets passed on by text. Tidy the address bar
// after load; the link itself still works exactly as before.
const CLEAN_URL = `<script>(function(){try{` +
  `var u=new URL(location.href),p=u.searchParams,c=false;` +
  `['utm_source','utm_medium','utm_campaign','utm_term','utm_content',` +
  `'fbclid','gclid','igshid','mc_cid','mc_eid','ref','ref_src'].forEach(function(k){` +
  `if(p.has(k)){p.delete(k);c=true;}});` +
  `if(c&&history.replaceState){var q=p.toString();` +
  `history.replaceState(null,'',u.pathname+(q?'?'+q:'')+u.hash);}` +
  `}catch(e){}})();</script>`;

if (!/utm_source/.test(html)) {
  html = html.replace(/<\/title>/i, `</title>\n${CLEAN_URL}`);
  injected.push('campaign-tag cleanup');
} else {
  log('campaign-tag cleanup already present — leaving as-is');
}

if (!existsSync(path.join(OUT, 'og-image.jpg'))) {
  warn('og-image.jpg is not in dist/ — link previews will show no image. Expected static/og-image.jpg');
}

if (Object.keys(resourceMap).length) {
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

// ------------------------------------------------------------------ 7. 404
// Chrome's runner is its offline page; ours is the not-found page. One source
// file in static/play/, served at /play/ and again as the 404.
const playPage = path.join(OUT, 'play', 'index.html');
if (existsSync(playPage)) {
  await cp(playPage, path.join(OUT, '404.html'));
  log('play/index.html -> 404.html');
} else {
  warn('site/play/index.html missing from the export — no custom 404 page written');
}

log('done. Serve dist/');
