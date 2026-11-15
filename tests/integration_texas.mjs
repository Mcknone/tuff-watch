// Real-data integration test: Central Texas (Guadalupe River, Kerr County) flood, July 2025.
// Uses LIVE NASA services only – no fixtures:
//   1. NASA CMR: OPERA DSWx-S1 / DSWx-HLS granules over the area, 20 Jun – 15 Jul 2025
//   2. NASA Earthdata: the B01_WTR GeoTIFF bands (needs EARTHDATA_TOKEN in the environment)
//   3. the app's own modules: metric grid → window read → sampling → decode → baseline → stats
// It never forces a positive result. If NASA is unreachable or no token is set, it reports
// that the integration test COULD NOT RUN and exits with code 2.
//   EARTHDATA_TOKEN=… node tests/integration_texas.mjs
import { fromUrl } from 'geotiff';
import { makeMetricGrid } from '../public/js/geo.js';
import { readWindow, sampleGranule, newTarget, decodeWater, valueHistogram } from '../public/js/raster.js';
import { waterBaseline, waterStatus, waterStats, waterConfidence, floodSignal } from '../public/js/classify.js';
import { WATER_CODES } from '../public/js/config.js';

const AOI = [[-99.20, 30.02], [-99.08, 30.02], [-99.08, 30.10], [-99.20, 30.10], [-99.20, 30.02]];   // Kerrville reach
const START = '2025-06-20', END = '2025-07-15', EVENT = '2025-07-04';
const PRODUCTS = [{ short: 'OPERA_L3_DSWX-S1_V1', codes: 'dswxS1' }, { short: 'OPERA_L3_DSWX-HLS_V1', codes: 'dswxHls' }];
const token = process.env.EARTHDATA_TOKEN;
const couldNotRun = why => { console.log(`INTEGRATION TEST COULD NOT RUN: ${why}`); process.exit(2); };

const grid = makeMetricGrid(AOI);
console.log(`AOI ${grid.aoiKm2.toFixed(1)} km², grid ${grid.w}×${grid.h} @ ${grid.cell} m, EPSG:${grid.epsg}`);

async function cmr(short) {
  const u = new URL('https://cmr.earthdata.nasa.gov/search/granules.json');
  u.searchParams.set('short_name', short);
  u.searchParams.set('bounding_box', [-99.20, 30.02, -99.08, 30.10].join(','));
  u.searchParams.set('temporal', `${START}T00:00:00Z,${END}T23:59:59Z`);
  u.searchParams.set('page_size', '2000');
  const res = await fetch(u, { headers: { 'Client-Id': 'earthscope-integration-test' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`CMR HTTP ${res.status}`);
  return ((await res.json()).feed.entry || []).map(e => ({
    id: e.id, title: e.title, date: e.time_start.slice(0, 10),
    wtr: (e.links || []).map(l => l.href).find(h => /^https:.*_B01_WTR\.tif$/.test(h))
  }));
}

let found;
try { found = await Promise.all(PRODUCTS.map(p => cmr(p.short))); }
catch (e) { couldNotRun(`NASA CMR not reachable from this machine (${e.cause ? e.cause.code || e.cause.message : e.message}).`); }
PRODUCTS.forEach((p, i) => console.log(`${p.short}: ${found[i].length} granules (${[...new Set(found[i].map(g => g.date))].join(', ')})`));
if (!token) couldNotRun('EARTHDATA_TOKEN is not set, so the WTR rasters cannot be downloaded (catalogue results above are real).');

for (const [i, p] of PRODUCTS.entries()) {
  const byDate = new Map();
  for (const g of found[i].filter(g => g.wtr)) { if (!byDate.has(g.date)) byDate.set(g.date, []); byDate.get(g.date).push(g); }
  const frames = [];
  for (const [date, gs] of [...byDate].sort()) {
    const target = newTarget(grid, 1);
    for (const g of gs) {
      try {
        const tiff = await fromUrl(g.wtr, { headers: { Authorization: `Bearer ${token}` } });
        const layer = await readWindow(tiff, grid);
        if (layer.data) sampleGranule(grid, [layer], target, v => { const n = WATER_CODES[p.codes][v[0]]; return !!n && n !== 'invalid'; });
      } catch (e) { console.log(`  ${date} ${g.title}: ${e.message}`); }
    }
    const dec = decodeWater(grid, target.bands[0], target.covered, WATER_CODES[p.codes]);
    frames.push({ date, cls: dec.cls, counts: dec.counts, hist: valueHistogram(grid, target.bands[0], target.covered) });
    console.log(`  ${date}: valid ${dec.counts.validPx} · invalid ${dec.counts.invalidPx} · missing ${dec.counts.missingPx} · raw values ${JSON.stringify(frames.at(-1).hist)}`);
  }
  const pre = frames.filter(f => f.date < EVENT && f.counts.validPx > 0);
  const base = pre.length ? waterBaseline(pre.map(f => f.cls), grid.w * grid.h) : null;
  for (const f of frames.filter(f => f.date >= EVENT)) {
    const st = waterStats(f.cls, waterStatus(f.cls, base), grid);
    const conf = base ? waterConfidence(st, null).level : 'Insufficient data';
    console.log(`  RESULT ${p.short} ${f.date}: coverage ${st.coveragePct.toFixed(0)} % · water ${st.waterKm2.toFixed(3)} km² · new ${st.newKm2.toFixed(3)} km² (${st.newPctOfObserved.toFixed(2)} % of observed) · ${floodSignal(st) ? 'new water detected' : 'no flood signal'} · confidence ${conf}`);
  }
}
console.log('INTEGRATION TEST RAN against live NASA data (see results above).');
