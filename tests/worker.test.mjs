import assert from 'node:assert/strict';
const store = new Map();
globalThis.caches = { default: { match: async r => store.get(r.url)?.clone(), put: async (r, res) => { store.set(r.url, res); } } };
const calls = [];
globalThis.fetch = async (u, opts) => {
  u = String(u); calls.push(u);
  if (u.includes('wms.cgi') && u.includes('TIME=2099')) return new Response('<ServiceException/>', { headers: { 'content-type': 'text/xml' } });
  if (u.includes('wms.cgi')) return new Response(new Uint8Array([137,80,78,71]), { headers: { 'content-type': 'image/png' } });
  if (u.includes('/colormaps/')) return u.includes('Missing') ? new Response('nf', { status: 404 }) : new Response('<ColorMapEntry rgb="1,2,3" label="x"/>', { headers: { 'content-type': 'text/xml' } });
  if (u.includes('granules.json')) return new Response(JSON.stringify({ feed: { entry: [
    { id: 'G1', title: 'a', time_start: '2026-06-20T01:00:00Z', collection_concept_id: 'C1' },
    { id: 'G2', title: 'b', time_start: '2026-06-20T01:05:00Z', collection_concept_id: 'C1' },
    { id: 'G3', title: 'c', time_start: '2026-07-02T01:00:00Z', collection_concept_id: 'C2' } ] } }),
    { headers: { 'content-type': 'application/json', 'CMR-Hits': '3' } });
  throw new Error('unexpected ' + u);
};
const worker = (await import('../src/worker.js')).default;
const ctx = { waitUntil: p => p };
const env = { ASSETS: { fetch: async () => new Response('index') } };
const get = path => worker.fetch(new Request('https://app.test' + path), env, ctx);

assert.equal(await (await get('/')).text(), 'index');
let r = await get('/api/health'); assert.equal((await r.json()).ok, true);

r = await get('/api/gibs/wms?proj=4326&LAYERS=OPERA_L3_DIST-ALERT-HLS_Color_Index&TIME=2026-06-20&BBOX=-8.4,140.3,-8.2,140.5&WIDTH=512&HEIGHT=500');
assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
assert.equal(r.headers.get('access-control-allow-origin'), '*');
const up = calls.at(-1);
assert.ok(up.startsWith('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?'));
assert.ok(up.includes('CRS=EPSG%3A4326') && up.includes('TIME=2026-06-20') && up.includes('WIDTH=512'));
// cached second time
const n = calls.length; await get('/api/gibs/wms?proj=4326&LAYERS=OPERA_L3_DIST-ALERT-HLS_Color_Index&TIME=2026-06-20&BBOX=-8.4,140.3,-8.2,140.5&WIDTH=512&HEIGHT=500');
assert.equal(calls.length, n, 'served from cache');

r = await get('/api/gibs/wms?LAYERS=X_Y&TIME=2099-01-01&BBOX=0,0,1,1'); assert.equal(r.status, 502);
r = await get('/api/gibs/wms?LAYERS=bad layer&BBOX=0,0,1,1'); assert.equal(r.status, 400);
r = await get('/api/gibs/wms?LAYERS=OK_L&BBOX=0,0,1'); assert.equal(r.status, 400);
r = await get('/api/gibs/wms?proj=3857&LAYERS=OK_L&BBOX=1,2,3,4&WIDTH=99999'); assert.equal(r.status, 200);
assert.ok(calls.at(-1).includes('epsg3857') && calls.at(-1).includes('WIDTH=2048'));

r = await get('/api/gibs/colormap/OPERA_L3_Dynamic_Surface_Water_Extent-HLS.xml'); assert.equal(r.status, 200);
assert.ok(calls.at(-1).endsWith('/colormaps/v1.3/OPERA_L3_Dynamic_Surface_Water_Extent-HLS.xml'));
r = await get('/api/gibs/colormap/Missing_Layer'); assert.equal(r.status, 404);
r = await get('/api/gibs/colormap/..%2F..%2Fetc'); assert.equal(r.status, 400);

r = await get('/api/cmr/granules?short_name=NISAR_L2*GCOV*&bbox=140.3,-8.4,140.5,-8.2&start=2026-06-01&end=2026-11-10');
const j = await r.json();
assert.equal(j.hits, 3); assert.deepEqual(j.dates, ['2026-06-20','2026-07-02']); assert.deepEqual(j.collections, ['C1','C2']);
assert.ok(j.query.includes('options%5Bshort_name%5D%5Bpattern%5D=true'));
assert.ok(j.query.includes('temporal=2026-06-01T00%3A00%3A00Z%2C2026-11-10T23%3A59%3A59Z'));
r = await get('/api/cmr/granules?short_name=X;drop&bbox=1,2,3,4&start=2026-01-01&end=2026-01-02'); assert.equal(r.status, 400);
r = await get('/api/nope'); assert.equal(r.status, 404);
r = await worker.fetch(new Request('https://app.test/api/health', { method: 'POST' }), env, ctx); assert.equal(r.status, 405);
console.log('worker tests: all passed');
