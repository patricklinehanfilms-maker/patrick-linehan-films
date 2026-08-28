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
 *   7. lang="en", JSON-LD (Person + the films), and a sitemap — the page is
 *      client-rendered, so without this a crawler sees an empty document
 *   8. canonical + share tags on play/
 *   9. serve play/index.html as the 404 page too
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


// ------------------------------------------------------- 7. lang + JSON-LD
// The homepage is rendered entirely in the browser: the export's <body> holds
// styles and a JSX blob, and every film title only exists after Babel runs. Google
// will usually render it on a second pass, but nothing else will. Structured data
// is static text, so it says who this is and what the work is without any JS.

if (!/<html[^>]*\blang=/i.test(html)) {
  html = html.replace(/<html(\s|>)/i, '<html lang="en"$1');
  injected.push('lang="en"');
}

// Pull the film list straight out of the export so it can never drift from the
// site. If Claude Design changes the shape, we log it and skip — never guess.
function readFilms(src) {
  const idsMatch = src.match(/const\s+VIDEO_IDS\s*=\s*(\[[^\]]*\])/);
  const ovStart = src.indexOf('const OVERRIDES');
  if (!idsMatch || ovStart === -1) return null;
  const open = src.indexOf('{', ovStart);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end === -1) return null;
  try {
    const ids = JSON.parse(idsMatch[1]);
    const overrides = JSON.parse(src.slice(open, end + 1));
    return ids.map(id => ({ id, ...(overrides[id] || {}) })).filter(f => f.title);
  } catch { return null; }
}

const films = readFilms(html);
if (!films) {
  warn('could not read VIDEO_IDS/OVERRIDES from the export — skipping film structured data');
} else if (!/application\/ld\+json/.test(html)) {
  const person = {
    '@type': 'Person',
    '@id': `${SITE_URL}/#person`,
    name: 'Patrick Linehan',
    jobTitle: 'Director',
    description: DESCRIPTION,
    url: `${SITE_URL}/`,
    address: { '@type': 'PostalAddress', addressLocality: 'Brooklyn', addressRegion: 'NY', addressCountry: 'US' },
    knowsAbout: ['Music video direction', 'Documentary', 'Narrative film', 'Commercial direction'],
  };
  const work = films.map((f, i) => ({
    '@type': 'ListItem',
    position: i + 1,
    item: {
      '@type': 'VideoObject',
      name: f.title,
      // year alone is not a valid ISO date, so uploadDate is deliberately absent
      // rather than invented. Add real dates and Google can show video results.
      ...(f.desc ? { description: f.desc } : {}),
      ...(f.kind ? { genre: f.kind } : {}),
      ...(f.year ? { copyrightYear: f.year } : {}),
      thumbnailUrl: `https://i.ytimg.com/vi/${f.id}/maxresdefault.jpg`,
      embedUrl: `https://www.youtube.com/embed/${f.id}`,
      url: `https://www.youtube.com/watch?v=${f.id}`,
      director: { '@type': 'Person', name: 'Patrick Linehan' },
    },
  }));
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      person,
      { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, url: `${SITE_URL}/`,
        name: 'Patrick Linehan Films', inLanguage: 'en',
        publisher: { '@id': `${SITE_URL}/#person` } },
      { '@type': 'ItemList', name: 'Films directed by Patrick Linehan',
        numberOfItems: work.length, itemListElement: work },
    ],
  };
  // '<' must be escaped or a '</script>' inside any description ends the block early
  const ld = JSON.stringify(graph).replace(/</g, '\\u003c');
  html = html.replace(/<\/title>/i,
    `</title>\n<script type="application/ld+json">${ld}</script>`);
  injected.push(`JSON-LD (person + ${work.length} films)`);
} else {
  log('JSON-LD already present in export — leaving as-is');
}

await writeFile(indexPath, html);
log(injected.length ? `injected: ${injected.join(', ')}` : 'no injections needed');

// ---------------------------------------------- 8. play/ head + 9. sitemap

// The game is a real page people link to, so it deserves its own canonical and
// share card rather than borrowing whatever the scraper guesses.
const playPath = path.join(OUT, 'play', 'index.html');
if (existsSync(playPath)) {
  let playHtml = await readFile(playPath, 'utf8');
  if (!/rel=["']canonical["']/i.test(playHtml)) {
    const PLAY_TITLE = 'Asterisk Run — Patrick Linehan Films';
    const PLAY_DESC =
      'Jump the running mark over the asterisks. A small game on Patrick Linehan Films.';
    const head = [
      `<link rel="canonical" href="${SITE_URL}/play/">`,
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="Patrick Linehan Films">`,
      `<meta property="og:title" content="${PLAY_TITLE}">`,
      `<meta property="og:description" content="${PLAY_DESC}">`,
      `<meta property="og:url" content="${SITE_URL}/play/">`,
      `<meta property="og:image" content="${SITE_URL}/og-image.jpg">`,
      `<meta name="twitter:card" content="summary_large_image">`,
      `<meta name="twitter:title" content="${PLAY_TITLE}">`,
      `<meta name="twitter:description" content="${PLAY_DESC}">`,
      `<meta name="twitter:image" content="${SITE_URL}/og-image.jpg">`,
    ].join('\n');
    playHtml = playHtml.replace(/<\/title>/i, `</title>\n${head}`);
    await writeFile(playPath, playHtml);
    log('injected canonical + share tags into play/index.html');
  } else {
    log('play/ already has a canonical — leaving as-is');
  }
} else {
  warn('play/index.html missing — no canonical or share tags written for the game');
}

// robots.txt is served by Cloudflare, not from this repo, so it is left alone —
// submit the sitemap in Search Console instead.
const today = new Date().toISOString().slice(0, 10);
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  [[`${SITE_URL}/`, '1.0'], [`${SITE_URL}/play/`, '0.3']]
    .map(([loc, pri]) =>
      `  <url><loc>${loc}</loc><lastmod>${today}</lastmod><priority>${pri}</priority></url>`)
    .join('\n') +
  `\n</urlset>\n`;
await writeFile(path.join(OUT, 'sitemap.xml'), sitemap);
log('wrote sitemap.xml');

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
