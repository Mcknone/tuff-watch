import assert from 'node:assert/strict';
import { metricCircle, haversineM, selfIntersects, ringAreaKm2, makeMetricGrid, toUtm, fromUtm, utmZoneOf, crsFromEpsg } from '../public/js/geo.js';
import { classifyGesture } from '../public/js/pointer.js';

// Vincenty inverse on WGS84 (ellipsoidal reference distance for the checks below)
function vincentyM(lon1, lat1, lon2, lat2) {
  const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f), R = Math.PI / 180;
  const L = (lon2 - lon1) * R, U1 = Math.atan((1 - f) * Math.tan(lat1 * R)), U2 = Math.atan((1 - f) * Math.tan(lat2 * R));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let l = L, lp, sS, cS, sig, sA, c2A, c2S;
  do {
    const sl = Math.sin(l), cl = Math.cos(l);
    sS = Math.sqrt((cU2 * sl) ** 2 + (cU1 * sU2 - sU1 * cU2 * cl) ** 2);
    if (sS === 0) return 0;
    cS = sU1 * sU2 + cU1 * cU2 * cl; sig = Math.atan2(sS, cS);
    sA = cU1 * cU2 * sl / sS; c2A = 1 - sA * sA; c2S = c2A ? cS - 2 * sU1 * sU2 / c2A : 0;
    const C = f / 16 * c2A * (4 + f * (4 - 3 * c2A));
    lp = l; l = L + (1 - C) * f * sA * (sig + C * sS * (c2S + C * cS * (-1 + 2 * c2S * c2S)));
  } while (Math.abs(l - lp) > 1e-12);
  const u2 = c2A * (a * a - b * b) / (b * b);
  const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2))), B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS = B * sS * (c2S + B / 4 * (cS * (-1 + 2 * c2S * c2S) - B / 6 * c2S * (-3 + 4 * sS * sS) * (-3 + 4 * c2S * c2S)));
  return b * A * (sig - dS);
}

// --- one-point AOI: a metric circle (radius in metres, not degrees) at any latitude ---
for (const [lon, lat, km] of [[140.4, -8.3, 10], [-99.14, 30.05, 25], [12, 64, 50], [-60, -70, 5]]) {
  const ring = metricCircle(lon, lat, km);
  assert.equal(ring.length, 73); assert.deepEqual(ring[0], ring.at(-1));
  for (const [x, y] of ring) {
    const d = vincentyM(lon, lat, x, y) / 1000;
    assert.ok(Math.abs(d - km) / km < 0.002, `radius at lat ${lat}: ${d} km vs ${km}`);
  }
  const area = ringAreaKm2(ring);
  assert.ok(Math.abs(area - Math.PI * km * km) / (Math.PI * km * km) < 0.01, `circle area ${area}`);
}
// the old degree-offset circle was ~2× too wide in longitude at 64° N; the metric one is round
const c64 = metricCircle(12, 64, 50);
const eastKm = vincentyM(12, 64, c64[0][0], c64[0][1]) / 1000, northKm = vincentyM(12, 64, c64[18][0], c64[18][1]) / 1000;
assert.ok(Math.abs(eastKm - northKm) < 0.3);

// --- two-point rectangle / multi-point polygon area (metric) ---
const rectRing = [[-99.2, 30.0], [-99.1, 30.0], [-99.1, 30.1], [-99.2, 30.1], [-99.2, 30.0]];
const expected = vincentyM(-99.2, 30.05, -99.1, 30.05) / 1000 * vincentyM(-99.15, 30.0, -99.15, 30.1) / 1000;
assert.ok(Math.abs(ringAreaKm2(rectRing) - expected) / expected < 0.005);

// --- polygon validation: crossing edges are rejected, a proper polygon is not ---
assert.equal(selfIntersects([[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]), true, 'bow-tie');
assert.equal(selfIntersects([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]), false);
assert.equal(selfIntersects([[0, 0], [2, 0], [2, 2], [1, 0.5], [0, 2], [0, 0]]), false, 'concave is fine');

// --- latitude / longitude never swapped: UTM round trip and zone ---
assert.equal(utmZoneOf(-99.14), 14); assert.equal(utmZoneOf(140.4), 54); assert.equal(utmZoneOf(180), 60); assert.equal(utmZoneOf(-180), 1);
const [x, y] = toUtm(-99.14, 30.05, 14, false);
const [lo, la] = fromUtm(x, y, 14, false);
assert.ok(Math.abs(lo + 99.14) < 1e-9 && Math.abs(la - 30.05) < 1e-9);
assert.deepEqual(crsFromEpsg(32754), { type: 'utm', zone: 54, south: true, epsg: 32754 });
assert.equal(crsFromEpsg(4326).type, 'geographic'); assert.equal(crsFromEpsg(3857), null);

// --- metric grid: native 30 m, aligned to the OPERA grid, area matches the polygon ---
const g = makeMetricGrid(metricCircle(140.4, -8.3, 10));
assert.equal(g.cell, 30); assert.equal(g.native, true); assert.equal(g.x0 % 30, 0); assert.equal(g.y1 % 30, 0);
assert.ok(Math.abs(g.aoiKm2 - Math.PI * 100) / (Math.PI * 100) < 0.01, 'grid area ' + g.aoiKm2);
// very large areas are sampled on a coarser multiple of 30 m – and say so
const big = makeMetricGrid(metricCircle(140.4, -8.3, 150), { maxCells: 1e6 });
assert.equal(big.native, false); assert.equal(big.cell % 30, 0);

// --- gestures: one decision per interaction ---
const down = (o = {}) => ({ x: 0, y: 0, t: 0, type: 'mouse', maxMove: 0, ...o });
assert.equal(classifyGesture(down(), { t: 120 }), 'click', 'single intentional click');
assert.equal(classifyGesture(down({ maxMove: 25 }), { t: 300 }), 'drag', 'drag is never a placement');
assert.equal(classifyGesture(down({ maxMove: 5 }), { t: 100 }), 'drag', 'mouse tolerance 4 px');
assert.equal(classifyGesture(down({ type: 'touch', maxMove: 8 }), { t: 150 }), 'click', 'touch tolerance 10 px');
assert.equal(classifyGesture(down(), { t: 1500 }), 'hold');
assert.equal(classifyGesture(down({ type: 'touch' }), { t: 100, multi: true }), 'multi', 'pinch/rotate never adds points');

console.log('geo + gesture tests: all passed');
