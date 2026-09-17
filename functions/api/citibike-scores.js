// Shared leaderboard for Citi Bike Surfer (the game inside the birthday invite).
// Cloudflare Pages Function at /api/citibike-scores, same origin as the game.
// Needs a KV binding named CITIBIKE_SCORES on the Pages project.

const LAST = 45;   // blocks from Central Park South to W 14 St
const KEEP = 50;   // entries kept on the board

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const sortBoard = (a, b) => b.blocks - a.blocks || a.at - b.at;

async function readTop(env) {
  return (await env.CITIBIKE_SCORES.get('top', { type: 'json' })) || [];
}

export async function onRequestGet({ env }) {
  if (!env.CITIBIKE_SCORES) return json({ error: 'leaderboard not configured' }, 503);
  return json({ top: await readTop(env) });
}

export async function onRequestPost({ request, env }) {
  if (!env.CITIBIKE_SCORES) return json({ error: 'leaderboard not configured' }, 503);

  // Only accept posts from the site itself.
  const origin = request.headers.get('Origin') || '';
  const self = new URL(request.url).origin;
  const allowed = [self, 'https://patrickjlinehan.com', 'https://www.patrickjlinehan.com'];
  if (!allowed.includes(origin)) return json({ error: 'forbidden' }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }

  // Full name: letters, spaces, apostrophes, periods, hyphens; at least two words.
  const name = String(body.name || '').replace(/[^\p{L}\p{M} '.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const blocks = Math.floor(Number(body.blocks));
  const ms = Math.floor(Number(body.ms));

  // Sanity checks: a block takes roughly 1 to 2.5 seconds to ride.
  const valid = name.length >= 3 && name.split(' ').length >= 2
    && Number.isFinite(blocks) && blocks >= 1 && blocks <= LAST
    && Number.isFinite(ms) && ms >= blocks * 800 && ms <= 30 * 60 * 1000;
  if (!valid) return json({ error: 'invalid score' }, 400);

  const entry = { name, blocks, at: Date.now() };
  const top = await readTop(env);
  top.push(entry);
  top.sort(sortBoard);
  const kept = top.slice(0, KEEP);
  await env.CITIBIKE_SCORES.put('top', JSON.stringify(kept));

  const idx = kept.indexOf(entry);
  return json({ top: kept, entry, rank: idx < 0 ? null : idx + 1 });
}
