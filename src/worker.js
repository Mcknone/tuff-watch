// =============================================================================
// Cloudflare Worker – serves the web app and relays requests to NASA services.
//
//   /                     -> static files in /public (the app)
//   /api/gibs/wms         -> NASA GIBS WMS GetMap (imagery for map + analysis)
//   /api/gibs/colormap/X  -> NASA GIBS colour map XML for layer X
//   /api/cmr/granules     -> NASA CMR granule search (real acquisition list)
//   /api/health           -> simple status check
//
// Why relay through the Worker? The browser must read image pixels to measure
// change, which only works for same-origin images; the Worker also caches
// NASA responses at Cloudflare's edge so repeated views are fast.
// Only these NASA hosts can be reached – it is not an open proxy.
// =============================================================================

const GIBS = 'https://gibs.earthdata.nasa.gov';
const CMR = 'https://cmr.earthdata.nasa.gov/search';
const CLIENT_ID = 'nasa-space-apps-surface-monitor';

const DAY = 86400;
const LAYER_RE = /^[A-Za-z0-9_.\-]{3,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[A-Za-z0-9_.\-*]{2,80}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405);
    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: CLIENT_ID, time: new Date().toISOString() });
      }
      if (url.pathname === '/api/gibs/wms') return await gibsWms(url, ctx);
      if (url.pathname.startsWith('/api/gibs/colormap/')) return await gibsColormap(url, ctx);
      if (url.pathname === '/api/cmr/granules') return await cmrGranules(url, ctx);
      return json({ error: 'Unknown API route' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 502);
    }
  }
};

// ----------------------------------------------------------------- GIBS WMS
async function gibsWms(url, ctx) {
  const q = url.searchParams;
  const proj = q.get('proj') === '3857' ? '3857' : '4326';
  const layer = q.get('LAYERS') || '';
  const time = q.get('TIME') || '';
  const bbox = (q.get('BBOX') || '').split(',').map(Number);
  const width = Math.min(2048, Math.max(16, parseInt(q.get('WIDTH') || '256', 10)));
  const height = Math.min(2048, Math.max(16, parseInt(q.get('HEIGHT') || '256', 10)));
  if (!LAYER_RE.test(layer)) return json({ error: 'bad layer' }, 400);
  if (time && !DATE_RE.test(time)) return json({ error: 'bad TIME' }, 400);
  if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) return json({ error: 'bad BBOX' }, 400);

  const up = new URL(`${GIBS}/wms/epsg${proj}/best/wms.cgi`);
  const p = up.searchParams;
  p.set('SERVICE', 'WMS');
  p.set('REQUEST', 'GetMap');
  p.set('VERSION', '1.3.0');
  p.set('LAYERS', layer);
  p.set('STYLES', '');
  p.set('CRS', `EPSG:${proj}`);
  p.set('BBOX', bbox.join(','));
  p.set('WIDTH', String(width));
  p.set('HEIGHT', String(height));
  p.set('FORMAT', 'image/png');
  p.set('TRANSPARENT', 'TRUE');
  if (time) p.set('TIME', time);

  // Past dates never change; today's imagery may still be filling in.
  const today = new Date().toISOString().slice(0, 10);
  const ttl = time && time < today ? 30 * DAY : 3600;
  return cachedFetch(up.toString(), ttl, ctx, res => {
    const type = res.headers.get('content-type') || '';
    // GIBS reports problems as XML with HTTP 200 – turn that into a clear error.
    if (!type.startsWith('image/')) return { status: 502, note: 'GIBS returned no image for this layer/date' };
    return null;
  });
}

// --------------------------------------------------------- GIBS colour maps
async function gibsColormap(url, ctx) {
  const layer = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/\.xml$/, '');
  if (!LAYER_RE.test(layer)) return json({ error: 'bad layer' }, 400);
  return cachedFetch(`${GIBS}/colormaps/v1.3/${layer}.xml`, 7 * DAY, ctx);
}

// ------------------------------------------------------------- CMR granules
async function cmrGranules(url, ctx) {
  const q = url.searchParams;
  const name = q.get('short_name') || '';
  const bbox = (q.get('bbox') || '').split(',').map(Number);
  const start = q.get('start') || '', end = q.get('end') || '';
  if (!NAME_RE.test(name)) return json({ error: 'bad short_name' }, 400);
  if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) return json({ error: 'bad bbox' }, 400);
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return json({ error: 'bad dates' }, 400);

  const up = new URL(`${CMR}/granules.json`);
  up.searchParams.set('short_name', name);
  if (name.includes('*')) up.searchParams.set('options[short_name][pattern]', 'true');
  up.searchParams.set('bounding_box', bbox.join(','));
  up.searchParams.set('temporal', `${start}T00:00:00Z,${end}T23:59:59Z`);
  up.searchParams.set('page_size', '2000');
  up.searchParams.set('sort_key', 'start_date');
  const cmrUrl = up.toString();

  const cache = caches.default;
  const cacheKey = new Request(cmrUrl + '&_v=1');
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const res = await fetch(cmrUrl, { headers: { 'Client-Id': CLIENT_ID, Accept: 'application/json' } });
  if (!res.ok) return json({ error: `CMR HTTP ${res.status}`, query: cmrUrl }, 502);
  const body = await res.json();
  const entries = (body.feed && body.feed.entry) || [];
  const granules = entries.map(e => ({
    id: e.id,
    title: e.title || e.producer_granule_id || e.id,
    start: e.time_start,
    collection: e.collection_concept_id
  }));
  const dates = [...new Set(granules.map(g => (g.start || '').slice(0, 10)).filter(Boolean))].sort();
  const out = json({
    hits: parseInt(res.headers.get('CMR-Hits') || String(granules.length), 10),
    returned: granules.length,
    dates,
    collections: [...new Set(granules.map(g => g.collection).filter(Boolean))],
    sample: granules.slice(0, 25),
    query: cmrUrl
  }, 200, { 'Cache-Control': 'public, max-age=3600' });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// ------------------------------------------------------------------ helpers
async function cachedFetch(upstream, ttl, ctx, check) {
  const cache = caches.default;
  const cacheKey = new Request(upstream);
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const res = await fetch(upstream, { headers: { 'User-Agent': CLIENT_ID }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!res.ok) return json({ error: `NASA HTTP ${res.status}`, upstream }, res.status === 404 ? 404 : 502);
  if (check) {
    const problem = check(res);
    if (problem) {
      const text = await res.text();
      return json({ error: problem.note, upstream, detail: text.slice(0, 400) }, problem.status);
    }
  }
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  for (const [k, v] of Object.entries(cors())) headers.set(k, v);
  headers.set('X-Data-Source', new URL(upstream).host);
  const out = new Response(res.body, { status: res.status, headers });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Data-Source'
  };
}

function withCors(res) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors())) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(), ...extra }
  });
}
