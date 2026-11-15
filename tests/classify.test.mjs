import assert from 'node:assert/strict';
import * as C from '../public/js/classify.js';
import { DATASETS } from '../public/js/config.js';

const ds = id => DATASETS.find(d => d.id === id);
const W = C.W;

// --- colour maps (still used for imagery-based indicators: chlorophyll, rainfall) ---
const xmlC = `<ColorMap units="mg/m^3"><ColorMapEntry rgb="1,1,1" value="[0.3,0.31)" label="0.3"/><ColorMapEntry rgb="2,2,2" value="[2.0,2.1)" label="2"/><ColorMapEntry rgb="3,3,3" value="[8,8.5)" label="8"/><ColorMapEntry rgb="4,4,4" value="[25,26)" label="25"/><ColorMapEntry rgb="5,5,5" value="[60,65)" label="60"/></ColorMap>`;
const cmC = C.parseColormap(xmlC);
assert.equal(cmC.units, 'mg/m^3');
assert.deepEqual(C.buildClassifier(ds('pace-chl'), cmC).info.map(i => i.level), [0, 1, 2, 3, 4]);
const xmlEnt = `<ColorMap><ColorMapEntry rgb="9,9,9" label="Confirmed (&lt;50%)"/><ColorMapEntry rgb="8,8,8" label="Confirmed (&#8805;50%)"/></ColorMap>`;
assert.deepEqual(C.parseColormap(xmlEnt).entries.map(e => e.label), ['Confirmed (<50%)', 'Confirmed (≥50%)']);

// --- degree grid & imagery classification (fire presence) ---
const square = [[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1], [0, 0]];
const g = C.makeGrid(square, [0, 0, 0.1, 0.1], 100);
assert.equal(g.w, 100);
assert.ok(Math.abs(g.aoiKm2 - 11.13 * 11.06) < 2, 'area ' + g.aoiKm2);
const n = g.w * g.h, rgba = new Uint8ClampedArray(n * 4);
for (let p = 0; p < n; p++) if (p % g.w < 50) rgba.set([200, 0, 0, 255], p * 4);
const lf = C.classifyPixels(rgba, g, ds('viirs-fire'), C.buildClassifier(ds('viirs-fire'), null));
assert.equal(lf[1], 3); assert.equal(lf[60], 0);
const st = C.frameStats(lf, g);
assert.ok(Math.abs(st.affectedPctOfAoi - 50) < 1.5);

// overallLevel: highest level present – no hidden minimum area
const tiny = { km2: [10, 0, 0.001, 0, 0] };
assert.equal(C.overallLevel(tiny), 2);
assert.equal(C.overallLevel({ km2: [10, 0, 0, 0, 0] }), 0);

// --- SAR darkening indicator ---
const ref = new Int16Array([100, 100, 100, -1, 100]), cur = new Int16Array([95, 70, 10, 50, 60]);
assert.deepEqual([...C.sarLevels(ref, cur, [18, 32, 50, 75])], [0, 1, 4, C.OUT, 2]);

// --- combine (imagery indicators) ---
const g2 = C.makeGrid(square, [0, 0, 0.1, 0.1], 20);
const A = new Uint8Array(g2.w * g2.h).fill(0), B = new Uint8Array(g2.w * g2.h).fill(0);
A[25] = 2; B[25] = 3; A[26] = 1;
const comb = C.combine([A, B], g2);
assert.equal(comb.merged[25], 3); assert.equal(comb.merged[26], 1);

// --- dates ---
assert.deepEqual(C.sampleDates(['a', 'b', 'c', 'd', 'e'], 3), ['a', 'c', 'e']);
assert.deepEqual(C.dailyDates('2025-01-01', '2025-01-11', 3), ['2025-01-01', '2025-01-06', '2025-01-11']);

// =========================== water statistics on class arrays ===========================
// (the classes themselves come from WTR rasters – see raster.test.mjs)
const gw = C.makeGrid(square, [0, 0, 0.1, 0.1], 100);
const N = gw.w * gw.h;
const cls = fn => { const a = new Uint8Array(N); for (let p = 0; p < N; p++) a[p] = fn(p % gw.w, Math.floor(p / gw.w)); return a; };
const pct = v => (100 * v) / gw.aoiKm2;

// multi-observation baseline: water in ≥ half the valid observations = permanent (1),
// in some = occasional (2), never = dry (0), never valid = 255
const b1 = cls(i => (i < 10 ? W.OPEN : W.DRY)), b2 = cls(i => (i < 10 ? W.OPEN : i < 12 ? W.OPEN : W.DRY)), b3 = cls(i => (i < 10 ? W.OPEN : i < 70 ? W.DRY : C.OUT));
const base = C.waterBaseline([b1, b2, b3], N);
assert.equal(base[5], 1); assert.equal(base[11], 2); assert.equal(base[50], 0);
assert.equal(C.waterBaseline([cls(() => C.OUT)], N)[0], C.OUT);

// flood: river (0-9) + new water (10-29), cloud on 80-99, no data on rows 0-9
const after = cls((i, j) => (j < 10 ? C.OUT : i >= 80 ? C.OUT : i < 30 ? W.OPEN : W.DRY));
const status = C.waterStatus(after, base);
const sa = C.waterStats(after, status, gw);
assert.ok(Math.abs(sa.coveragePct - 72) < 2, 'coverage ' + sa.coveragePct);
// columns 10-11 were occasionally wet in the baseline → normal, not new
assert.ok(Math.abs(pct(sa.newKm2) - 18 * 0.9) < 1.5, 'new ' + pct(sa.newKm2));
assert.ok(Math.abs(pct(sa.normalKm2) - 12 * 0.9) < 1, 'normal ' + pct(sa.normalKm2));
assert.ok(Math.abs(sa.newPctOfObserved - (16.2 / 72) * 100) < 2);
assert.equal(C.floodSignal(sa), true);

// a handful of new-water pixels never makes the area "flooded"
const few = cls((i, j) => (i < 10 || (i === 50 && j < 3) ? W.OPEN : W.DRY));
const sf = C.waterStats(few, C.waterStatus(few, base), gw);
assert.ok(sf.newKm2 > 0); assert.equal(C.floodSignal(sf), false);

// no valid observation → insufficient, never "no flood"
const none = cls(() => C.OUT);
const sn = C.waterStats(none, C.waterStatus(none, base), gw);
assert.equal(sn.validKm2, 0); assert.equal(sn.newKm2, 0);
assert.equal(C.waterConfidence(sn, null).level, 'Insufficient data');

// no baseline → water is "unknown", never new
const sNoBase = C.waterStats(after, C.waterStatus(after, null), gw);
assert.equal(sNoBase.newKm2, 0); assert.ok(sNoBase.unknownKm2 > 0);

// MODIS flood product classes: FLOOD is new by the product's own reference, REFERENCE is normal
const modis = cls(i => (i < 5 ? W.REFERENCE : i < 8 ? W.FLOOD : W.DRY));
const sm = C.waterStats(modis, C.waterStatus(modis, null), gw);
assert.ok(sm.newKm2 > 0 && sm.normalKm2 > 0 && sm.unknownKm2 === 0);

// --- agreement & confidence: inundated vegetation is not a radar/optical disagreement ---
const radar = cls(i => (i < 30 ? W.OPEN : i < 40 ? W.INUNDATED_VEG : W.DRY));
const optical = cls(i => (i < 30 ? W.OPEN : W.DRY));
const sr = C.waterStatus(radar, base), so = C.waterStatus(optical, base);
assert.ok(C.waterAgreement(sr, so, gw).agreePct < 95, 'without IV exclusion they disagree');
assert.ok(C.waterAgreement(sr, so, gw, radar, optical).agreePct > 99, 'IV pixels excluded from comparison');
const full = C.waterStats(optical, so, gw);
assert.equal(C.waterConfidence(full, C.waterAgreement(sr, so, gw, radar, optical)).level, 'High');
assert.equal(C.waterConfidence(full, null).level, 'Medium');
assert.equal(C.waterConfidence({ ...full, coveragePct: 20 }, null).level, 'Insufficient data');

// --- rainfall context (imagery) ---
const xmlR = `<ColorMap units="mm/h"><ColorMapEntry rgb="0,0,0" transparent="true" nodata="true" label="No Data"/><ColorMapEntry rgb="10,10,200" value="[1,2)" label="1"/><ColorMapEntry rgb="200,10,10" value="[10,20)" label="10"/></ColorMap>`;
const rc = C.buildValueClassifier(C.parseColormap(xmlR));
const img = new Uint8ClampedArray(N * 4);
for (let p = 0; p < N; p++) if (p % gw.w < 50) img.set([200, 10, 10, 255], p * 4);
const rs = C.valueStats(img, gw, rc);
assert.ok(Math.abs(rs.mean - 5) < 0.3, 'rain mean ' + rs.mean);

console.log('classify tests: all passed');
