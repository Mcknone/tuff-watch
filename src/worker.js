// =============================================================================
// Cloudflare Worker – serves the web app and relays requests to NASA services.
//
//   /                     -> static files in /public (the app)
//   /api/gibs/wms         -> NASA GIBS WMS GetMap (imagery for map + analysis)
//   /api/gibs/colormap/X  -> NASA GIBS colour map XML for layer X
//   /api/cmr/granules     -> NASA CMR granule search (real acquisition list, paginated,
//                            with band download links and collection version)
//   /api/data?url=…       -> authenticated, range-capable relay for NASA Earthdata files
//                            (OPERA / LANCE GeoTIFFs). Needs the EARTHDATA_TOKEN secret:
//                            `npx wrangler secret put EARTHDATA_TOKEN`
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
const BAND_RE = /^[A-Za-z0-9_.\-*]{1,40}$/;
const CMR_PAGE = 2000, CMR_MAX_PAGES = 10;            // up to 20 000 granules, then report truncation

// Earthdata-protected file hosts the data relay may fetch from (exact prefixes).
const DATA_PREFIXES = [
  'https://data.lpdaac.earthdatacloud.nasa.gov/',
  'https://archive.podaac.earthdata.nasa.gov/',
  'https://datapool.asf.alaska.edu/',
  'https://cumulus.asf.alaska.edu/',
  'https://nrt3.modaps.eosdis.nasa.gov/',
  'https://nrt4.modaps.eosdis.nasa.gov/'
];
// The Earthdata token is only ever sent to these NASA / DAAC hosts (never to a CDN redirect).
const AUTH_HOST_RE = /(^|\.)(earthdata\.nasa\.gov|earthdatacloud\.nasa\.gov|eosdis\.nasa\.gov|asf\.alaska\.edu)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'GET only' }, 405);
    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: CLIENT_ID, time: new Date().toISOString() });
      }
      if (url.pathname === '/api/gibs/wms') return await gibsWms(url, ctx);
      if (url.pathname.startsWith('/api/gibs/colormap/')) return await gibsColormap(url, ctx);
      if (url.pathname === '/api/cmr/granules') return await cmrGranules(url, ctx);
      if (url.pathname === '/api/data') return await dataRelay(request, url, env);
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
// Paginates with CMR-Search-After so long periods are not silently cut at one page.
// With `bands=A,B` each granule also lists its HTTPS download links for those bands
// (file names ending in _A.tif / _B.tif; `*.tif` = any GeoTIFF).
async function cmrGranules(url, ctx) {
  const q = url.searchParams;
  const name = q.get('short_name') || '';
  const bbox = (q.get('bbox') || '').split(',').map(Number);
  const start = q.get('start') || '', end = q.get('end') || '';
  const bands = (q.get('bands') || '').split(',').filter(Boolean);
  if (!NAME_RE.test(name)) return json({ error: 'bad short_name' }, 400);
  if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) return json({ error: 'bad bbox' }, 400);
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return json({ error: 'bad dates' }, 400);
  if (bands.length > 4 || bands.some(b => !BAND_RE.test(b))) return json({ error: 'bad bands' }, 400);

  const up = new URL(`${CMR}/granules.json`);
  up.searchParams.set('short_name', name);
  if (name.includes('*')) up.searchParams.set('options[short_name][pattern]', 'true');
  up.searchParams.set('bounding_box', bbox.join(','));
  up.searchParams.set('temporal', `${start}T00:00:00Z,${end}T23:59:59Z`);
  up.searchParams.set('page_size', String(CMR_PAGE));
  up.searchParams.set('sort_key', 'start_date');
  const cmrUrl = up.toString();

  const cache = caches.default;
  const cacheKey = new Request(cmrUrl + '&_v=2&bands=' + encodeURIComponent(bands.join(',')));
  const hit = await cache.match(cacheKey);
  if (hit) return withCors(hit);

  const entries = [];
  let hits = null, searchAfter = null, pages = 0;
  do {
    const headers = { 'Client-Id': CLIENT_ID, Accept: 'application/json' };
    if (searchAfter) headers['CMR-Search-After'] = searchAfter;
    const res = await fetch(cmrUrl, { headers, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return json({ error: `CMR HTTP ${res.status}`, kind: 'http', query: cmrUrl }, 502);
    const body = await res.json();
    const page = (body.feed && body.feed.entry) || [];
    entries.push(...page);
    if (hits === null) hits = parseInt(res.headers.get('CMR-Hits') || String(page.length), 10);
    searchAfter = res.headers.get('CMR-Search-After');
    pages++;
    if (page.length < CMR_PAGE) break;
  } while (searchAfter && pages < CMR_MAX_PAGES);

  const pickLinks = e => {
    if (!bands.length) return [];
    const hrefs = (e.links || []).map(l => l.href).filter(h => typeof h === 'string' && h.startsWith('https://') && /\.tiff?$/i.test(h));
    return bands.map(b => (b === '*.tif' ? hrefs[0] : hrefs.find(h => h.endsWith(`_${b}.tif`) || h.endsWith(`_${b}.tiff`))) || null);
  };
  const granules = entries.map(e => ({
    id: e.id,
    title: e.title || e.producer_granule_id || e.id,
    start: e.time_start,
    date: (e.time_start || '').slice(0, 10),
    collection: e.collection_concept_id,
    links: pickLinks(e),
    boxes: e.boxes || null,
    polygons: e.polygons ? e.polygons.slice(0, 1) : null
  }));
  const dates = [...new Set(granules.map(g => g.date).filter(Boolean))].sort();
  const collections = [...new Set(granules.map(g => g.collection).filter(Boolean))];
  const collectionInfo = await collectionMeta(collections.slice(0, 3));
  const out = json({
    hits, returned: granules.length, truncated: hits > granules.length, pages,
    dates, collections, collectionInfo,
    granules: bands.length ? granules : undefined,
    sample: granules.slice(0, 25).map(({ links, boxes, polygons, ...g }) => g),
    query: cmrUrl
  }, 200, { 'Cache-Control': 'public, max-age=3600' });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

/** Short name + version of each collection (so results state the exact product version). */
async function collectionMeta(ids) {
  if (!ids.length) return [];
  try {
    const u = new URL(`${CMR}/collections.json`);
    ids.forEach(id => u.searchParams.append('concept_id[]', id));
    const res = await fetch(u.toString(), { headers: { 'Client-Id': CLIENT_ID, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return ids.map(id => ({ id }));
    const body = await res.json();
    return ((body.feed && body.feed.entry) || []).map(c => ({ id: c.id, shortName: c.short_name, version: c.version_id, title: c.dataset_id }));
  } catch {
    return ids.map(id => ({ id }));
  }
}

// ------------------------------------------------------------- data relay
// Range-capable relay for Earthdata-protected GeoTIFFs. The token stays on the server,
// is sent only to NASA/DAAC hosts, and redirects (to signed CDN URLs) are followed
// manually so the token is never forwarded to them. Errors come back as JSON with a
// `kind` (auth-config | auth | timeout | http | bad-url) so the app can show a data error.
async function dataRelay(request, url, env) {
  const target = url.searchParams.get('url') || '';
  if (!DATA_PREFIXES.some(p => target.startsWith(p)) || target.includes('..') || !/\.tiff?$/i.test(target.split('?')[0])) {
    return json({ error: 'URL not allowed (only NASA Earthdata GeoTIFFs)', kind: 'bad-url' }, 400);
  }
  const token = env && env.EARTHDATA_TOKEN;
  if (!token) return json({ error: 'NASA Earthdata access is not configured on this server (secret EARTHDATA_TOKEN missing).', kind: 'auth-config' }, 503);
  const range = request.headers.get('Range');
  let next = target;
  for (let hop = 0; hop < 6; hop++) {
    const host = new URL(next).hostname;
    const headers = { 'User-Agent': CLIENT_ID };
    if (range) headers.Range = range;
    if (AUTH_HOST_RE.test(host)) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(next, { method: request.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return json({ error: timeout ? 'NASA Earthdata did not answer in time' : `network error: ${e.message}`, kind: timeout ? 'timeout' : 'http' }, timeout ? 504 : 502);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      next = new URL(res.headers.get('location'), next).toString();
      if (/urs\.earthdata\.nasa\.gov\/oauth/.test(next)) {
        return json({ error: 'NASA Earthdata rejected the token (login required).', kind: 'auth' }, 401);
      }
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      return json({ error: `NASA Earthdata refused access (HTTP ${res.status}) – check the token and that the application is authorised.`, kind: 'auth' }, res.status);
    }
    if (!res.ok) return json({ error: `NASA data server HTTP ${res.status}`, kind: 'http' }, 502);
    const type = res.headers.get('content-type') || '';
    if (/text\/html/i.test(type)) return json({ error: 'NASA Earthdata returned a login page instead of data.', kind: 'auth' }, 401);
    const outHeaders = new Headers(cors());
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = res.headers.get(h);
      if (v) outHeaders.set(h, v);
    }
    outHeaders.set('Cache-Control', 'private, max-age=3600');
    outHeaders.set('X-Data-Source', new URL(target).host);
    return new Response(res.body, { status: res.status, headers: outHeaders });
  }
  return json({ error: 'too many redirects from NASA Earthdata', kind: 'http' }, 502);
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
    'Access-Control-Expose-Headers': 'X-Data-Source, Content-Range, Accept-Ranges, Content-Length',
    'Access-Control-Allow-Headers': 'Range'
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
