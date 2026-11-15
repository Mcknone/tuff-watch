// Generates synthetic GeoTIFF fixtures for the browser end-to-end test (tests/e2e_test.py).
// Automated tests only: they are written to a temporary folder and served by the test's
// mock of /api/data – never by the app. Content uses the documented class values.
//   node tests/make_e2e_fixtures.mjs [outdir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTiff } from './fixtures.mjs';
import { toUtm } from '../public/js/geo.js';

const out = process.argv[2] || join(tmpdir(), 'earthscope-e2e-fixtures');
mkdirSync(out, { recursive: true });

// Merauke example AOI centre (circle, 10 km) – UTM zone 54 S
const [cx, cy] = toUtm(140.4, -8.3, 54, true);
const res = 30, size = 800;                                  // 24 km tile, 30 m pixels
const tile = { epsg: 32754, res, width: size, height: size,
  x0: Math.floor((cx - 12000) / res) * res, y0: Math.ceil((cy + 12000) / res) * res };
const DATES = ['2026-05-10', '2026-06-03', '2026-07-01', '2026-08-14', '2026-09-20', '2026-10-30'];
// box relative to the AOI centre, metres: [dx, dy(north), w, h]
const box = (x, y, [dx, dy, w, h]) => x >= cx + dx && x < cx + dx + w && y <= cy + dy && y > cy + dy - h;

let n = 0;
const write = (name, buf) => { writeFileSync(join(out, name), Buffer.from(buf)); n++; };
DATES.forEach((date, k) => {
  // ---- OPERA DIST-ALERT-HLS: VEG-DIST-STATUS + VEG-ANOM-MAX
  const dist = (x, y) => {
    if (k === 4 && box(x, y, [3000, 3000, 900, 900])) return [255, 255];              // no data / cloud
    if (k >= 1 && box(x, y, [-1500, 1500, 600, 600])) return [k === 1 ? 4 : k === 2 ? 5 : 6, 80]; // grows to confirmed ≥50 %
    if (k >= 2 && box(x, y, [1500, 1500, 300, 300])) return [2, 25];                  // provisional, low loss (25 %)
    if (k >= 2 && box(x, y, [1500, -1500, 150, 150])) return [2, 15];                 // very low loss (15 %, below 20 %)
    if (k >= 3 && box(x, y, [-3000, -3000, 30, 30])) return [3, 30];                  // single confirmed pixel
    return [0, 2];
  };
  write(`OPERA_L3_DIST-ALERT-HLS_V1_${date}_VEG-DIST-STATUS.tif`, makeTiff({ ...tile, version: '1.0', value: (x, y) => dist(x, y)[0] }));
  write(`OPERA_L3_DIST-ALERT-HLS_V1_${date}_VEG-ANOM-MAX.tif`, makeTiff({ ...tile, value: (x, y) => dist(x, y)[1] }));
  // ---- OPERA DSWx WTR: a permanent river, new flooding from the 4th date on
  const water = (x, y, sensor) => {
    if (sensor === 'hls' && k === 1 && y > cy) return 253;                           // clouds over the north half
    if (box(x, y, [-6000, 12000, 300, 24000])) return 1;                              // river
    if (k >= 3 && box(x, y, [0, 0, 3000, 3000])) return 1;                            // new flood water
    if (sensor === 's1' && k >= 3 && box(x, y, [3000, 0, 600, 600])) return 3;        // inundated vegetation (radar)
    if (sensor === 's1' && box(x, y, [-4500, -4500, 600, 600])) return 251;           // layover / shadow
    return 0;
  };
  write(`OPERA_L3_DSWX-S1_V1_${date}_B01_WTR.tif`, makeTiff({ ...tile, version: '1.0', value: (x, y) => water(x, y, 's1') }));
  write(`OPERA_L3_DSWX-HLS_V1_${date}_B01_WTR.tif`, makeTiff({ ...tile, version: '1.0', value: (x, y) => water(x, y, 'hls') }));
});
writeFileSync(join(out, 'index.json'), JSON.stringify({ dates: DATES, files: n }));
console.log(`e2e fixtures: ${n} GeoTIFFs in ${out}`);
