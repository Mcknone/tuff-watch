// Regression tests for the numerical raster pipeline: real GeoTIFF files (synthetic content,
// documented class values, UTM / geographic projections, 30 m pixels) decoded through the
// same functions the app uses: readWindow → sampleGranule → decodeDist / decodeWater.
import assert from 'node:assert/strict';
import { makeTiff, open, tileFor, inBox, rect } from './fixtures.mjs';
import { makeMetricGrid, fromUtm } from '../public/js/geo.js';
import { readWindow, sampleGranule, newTarget, decodeDist, decodeWater, valueHistogram, describeImage } from '../public/js/raster.js';
import * as C from '../public/js/classify.js';
import { WATER_CODES } from '../public/js/config.js';

const W = C.W;
async function sample(grid, tiffBufs, isValid = v => v[0] !== 255) {
  const target = newTarget(grid, tiffBufs[0].length);
  const info = [];
  for (const bands of tiffBufs) {
    const layers = [];
    for (const b of bands) layers.push(await readWindow(await open(b), grid));
    info.push(sampleGranule(grid, layers, target, isValid));
  }
  return { target, info };
}

// ====================================================================== DIST-ALERT
const distGrid = makeMetricGrid(rect(140.38, -8.32, 140.41, -8.29));
assert.equal(distGrid.zone, 54); assert.equal(distGrid.south, true); assert.equal(distGrid.cell, 30); assert.equal(distGrid.native, true);
assert.equal(distGrid.x0 % 30, 0); assert.equal(distGrid.y1 % 30, 0);
const px = distGrid.rowArea[0];
assert.ok(Math.abs(px - 0.0009) < 0.000002, 'one 30 m pixel ≈ 0.0009 km² ' + px);

// regions in grid metres: [x, y, width, height] → [status, VEG-ANOM-MAX]
const REGIONS = [
  [[600, 600, 300, 300], 6, 80],     // 1 confirmed ≥50 %           100 px
  [[1200, 600, 180, 180], 5, 60],    // 2 provisional ≥50 %          36 px
  [[1800, 600, 240, 240], 3, 30],    // 3 confirmed <50 % (low)      64 px
  [[600, 1200, 150, 150], 2, 25],    // 4 provisional <50 % (low)    25 px
  [[1200, 1200, 120, 120], 1, 22],   //   first detection <50 %      16 px
  [[1800, 1200, 30, 30], 3, 35],     // 5 single isolated pixel       1 px
  [[2100, 1200, 60, 30], 6, 70],     // 5 two-pixel patch             2 px
  [[600, 1800, 150, 150], 2, 15],    //   low loss 15 % (< 20 %)     25 px
  [[1200, 1800, 300, 300], 255, 255],// 7 no data / cloud            100 px
  [[1800, 1800, 90, 90], 0, 40],     //   anomaly without DIST alert   9 px
  [[2400, 600, 90, 90], 8, 90],      //   confirmed ≥50 %, finished    9 px
  [[2400, 1800, 60, 60], 4, 255]     //   first ≥50 %, magnitude n/a   4 px
];
const regionAt = (grid, x, y) => REGIONS.find(([box]) => inBox(grid, x, y, box));
const distTile = tileFor(distGrid);
const statusTif = makeTiff({ ...distTile, version: '1.0', value: (x, y) => (regionAt(distGrid, x, y) || [0, 0])[1] });
const anomTif = makeTiff({ ...distTile, value: (x, y) => { const r = regionAt(distGrid, x, y); return r ? r[2] : 3; } });

const { target: dT } = await sample(distGrid, [[statusTif, anomTif]], v => v[0] !== 255 && v[0] <= 8);
const d20 = decodeDist(distGrid, dT.bands[0], dT.bands[1], dT.covered, { minLossPct: 20, minPatchHa: 0 });
const s = d20.stats;
// cases 1–5: every stage and both magnitudes are detected, including below-50 % loss and single pixels
assert.equal(s.byStage.confirmed.high, 100 + 2 + 9, 'confirmed ≥50 %');
assert.equal(s.byStage.provisional.high, 36, 'provisional ≥50 %');
assert.equal(s.byStage.confirmed.low, 64 + 1, 'confirmed <50 % incl. single pixel');
assert.equal(s.byStage.provisional.low, 25, 'provisional <50 %');
assert.equal(s.byStage.first.low, 16, 'first detection <50 %');
assert.equal(s.byStage.first.high, 4, 'kept although its loss magnitude is no data');
assert.equal(s.detectedPx, 111 + 36 + 65 + 25 + 16 + 4);
assert.ok(Math.abs(s.detectedKm2 - s.detectedPx * px) < 1e-9);
assert.equal(s.patches, 9, 'every patch, including 1- and 2-pixel ones');
assert.equal(s.belowLossPx, 25, 'reported, not silently dropped');
assert.equal(s.anomalyOnlyPx, 9);
assert.equal(s.magnitudeUnknownPx, 4);
// case 7: no data is invalid, never "no disturbance"
assert.equal(s.invalidPx, 100);
assert.equal(s.validPx + s.invalidPx + s.missingPx, distGrid.aoiPixels);
assert.ok(s.meanLossPct > 20 && s.lossMax === 90);
// map categories: 1 first/prov <50, 2 first/prov ≥50, 3 confirmed <50, 4 confirmed ≥50
const lvAt = (x, y) => { const i = Math.floor(x / 30), j = Math.floor(y / 30); return d20.levels[j * distGrid.w + i]; };
assert.equal(lvAt(700, 700), 4); assert.equal(lvAt(1250, 650), 2); assert.equal(lvAt(1900, 700), 3); assert.equal(lvAt(650, 1250), 1);
assert.equal(lvAt(1300, 1900), C.OUT, 'no data drawn as unobserved');

// sensitivity: a lower loss threshold includes the 15 % pixels; nothing else changes
const d10 = decodeDist(distGrid, dT.bands[0], dT.bands[1], dT.covered, { minLossPct: 10, minPatchHa: 0 }).stats;
assert.equal(d10.byStage.provisional.low, 50); assert.equal(d10.belowLossPx, 0);
const d50 = decodeDist(distGrid, dT.bands[0], dT.bands[1], dT.covered, { minLossPct: 50, minPatchHa: 0 }).stats;
assert.equal(d50.byStage.confirmed.low, 0); assert.equal(d50.byStage.confirmed.high, 111);
// minimum patch size is a separate, explicit setting (0.5 ha ≈ 5.6 px) – removed pixels are counted
const dp = decodeDist(distGrid, dT.bands[0], dT.bands[1], dT.covered, { minLossPct: 20, minPatchHa: 0.5 }).stats;
assert.equal(dp.smallPatchPx, 1 + 2 + 4); assert.equal(dp.detectedPx, s.detectedPx - 7);
// status-only product (DIST-ALERT-S1 GEN-DIST-STATUS): no anomaly band, the loss setting does not apply
const dS1 = decodeDist(distGrid, dT.bands[0], null, dT.covered, { minLossPct: 20, minPatchHa: 0 }).stats;
assert.equal(dS1.detectedPx, s.detectedPx + 25);

// case 6: no disturbance anywhere
const zeroTif = makeTiff({ ...distTile, value: () => 0 });
const { target: zT } = await sample(distGrid, [[zeroTif]]);
const dz = decodeDist(distGrid, zT.bands[0], null, zT.covered, {}).stats;
assert.equal(dz.detectedPx, 0); assert.equal(dz.validPx, distGrid.aoiPixels); assert.equal(dz.coveragePct > 99, true);
// case 7b: whole scene no data / clouds → no valid pixels (the app reports Insufficient data)
const ndTif = makeTiff({ ...distTile, value: () => 255 });
const { target: nT } = await sample(distGrid, [[ndTif]]);
const dn = decodeDist(distGrid, nT.bands[0], null, nT.covered, {}).stats;
assert.equal(dn.validPx, 0); assert.equal(dn.detectedPx, 0); assert.equal(dn.invalidPx, distGrid.aoiPixels);

// histogram shows the raw values that were in the file
const hist = valueHistogram(distGrid, dT.bands[0], dT.covered);
assert.equal(hist[6], 102); assert.equal(hist[255], 100);
assert.equal(describeImage(await (await open(statusTif)).getImage()).productVersion, '1.0');

// overlapping granules (MGRS tile overlap / same-day passes) are never counted twice
const { target: oT, info } = await sample(distGrid, [[statusTif, anomTif], [statusTif, anomTif]], v => v[0] !== 255 && v[0] <= 8);
assert.equal(info[1].filled, 0, 'an identical overlapping granule adds nothing (its no-data block is still no data)');
const dov = decodeDist(distGrid, oT.bands[0], oT.bands[1], oT.covered, { minLossPct: 20 }).stats;
assert.equal(dov.detectedPx, s.detectedPx);
// … and a valid value from a later granule replaces an invalid one (cloud in the first)
const half = makeTiff({ ...distTile, value: (x, y) => (inBox(distGrid, x, y, [0, 0, 1500, 4000]) ? 255 : 0) });
const full6 = makeTiff({ ...distTile, value: () => 6 });
const { target: mT } = await sample(distGrid, [[half], [full6]], v => v[0] !== 255 && v[0] <= 8);
const dm = decodeDist(distGrid, mT.bands[0], null, mT.covered, {}).stats;
assert.equal(dm.invalidPx, 0); assert.ok(dm.detectedPx > 0 && dm.detectedPx < distGrid.aoiPixels);

// ====================================================================== DSWx floods
const fGrid = makeMetricGrid(rect(-99.16, 30.03, -99.12, 30.07));      // Central Texas, UTM 14N
assert.equal(fGrid.epsg, 32614);
const fTile = tileFor(fGrid);
const RIVER = [300, 0, 150, 99999], FLOOD = [450, 0, 900, 2400], IV = [1500, 0, 300, 1200];
const wtr = fn => makeTiff({ ...fTile, value: (x, y) => fn(x, y) });
const river = (x, y) => inBox(fGrid, x, y, RIVER);
const dec = async (buf, codes) => {
  const { target } = await sample(fGrid, [[buf]], v => { const n = WATER_CODES[codes][v[0]]; return !!n && n !== 'invalid'; });
  return decodeWater(fGrid, target.bands[0], target.covered, WATER_CODES[codes]);
};
const fpx = fGrid.rowArea[0];
const near = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, b), `${a} vs ${b}`);
const boxPx = (box) => { let n = 0; for (let j = 0; j < fGrid.h; j++) for (let i = 0; i < fGrid.w; i++) { const p = j * fGrid.w + i; if (fGrid.mask[p] && inBox(fGrid, fGrid.x0 + (i + 0.5) * 30, fGrid.y1 - (j + 0.5) * 30, box)) n++; } return n; };
const riverPx = boxPx(RIVER);

// multi-observation pre-event baseline (two optical observations)
const b1 = await dec(wtr((x, y) => (river(x, y) ? 1 : 0)), 'dswxHls');
const b2 = await dec(wtr((x, y) => (river(x, y) ? 1 : 0)), 'dswxHls');
const base = C.waterBaseline([b1.cls, b2.cls], fGrid.w * fGrid.h);

// 1. known flood: newly inundated pixels (+ inundated vegetation seen by radar)
const post = await dec(wtr((x, y) => (river(x, y) ? 1 : inBox(fGrid, x, y, IV) ? 3 : inBox(fGrid, x, y, FLOOD) ? 1 : 0)), 'dswxS1');
const st1 = C.waterStats(post.cls, C.waterStatus(post.cls, base), fGrid);
const floodOnly = boxPx(FLOOD);                      // IV box lies beside the flood box
near(st1.newKm2 / fpx, floodOnly + boxPx(IV), 0.001);
near(st1.normalKm2 / fpx, riverPx, 0.001);
near(st1.inundatedVegKm2 / fpx, boxPx(IV), 0.001);
assert.equal(C.floodSignal(st1), true);
assert.ok(st1.newPctOfObserved < 50, 'the whole AOI is not flooded');

// 2. permanent river, no new flood
const same = await dec(wtr((x, y) => (river(x, y) ? 1 : 0)), 'dswxS1');
const st2 = C.waterStats(same.cls, C.waterStatus(same.cls, base), fGrid);
assert.equal(st2.newKm2, 0); near(st2.normalKm2 / fpx, riverPx, 0.001); assert.equal(C.floodSignal(st2), false);

// 3. partial surface water: a category in the water extent, never a severity level
const part = await dec(wtr((x, y) => (river(x, y) ? 1 : inBox(fGrid, x, y, [900, 600, 300, 300]) ? 2 : 0)), 'dswxHls');
const st3 = C.waterStats(part.cls, C.waterStatus(part.cls, base), fGrid);
near(st3.partialKm2 / fpx, boxPx([900, 600, 300, 300]), 0.001);
near(st3.newKm2, st3.partialKm2, 0.001);

// 4. inundated vegetation only in radar; optical sees dry there – not a disagreement
const optical = await dec(wtr((x, y) => (river(x, y) || (inBox(fGrid, x, y, FLOOD) && !inBox(fGrid, x, y, IV)) ? 1 : 0)), 'dswxHls');
const sr = C.waterStatus(post.cls, base), so = C.waterStatus(optical.cls, base);
assert.ok(C.waterAgreement(sr, so, fGrid, post.cls, optical.cls).agreePct > 99.9);

// 5. cloud-covered optical observation: clouds excluded, coverage reported, never water
const cloudy = await dec(wtr((x, y) => (inBox(fGrid, x, y, [0, 0, 99999, 2200]) ? 253 : river(x, y) ? 1 : 0)), 'dswxHls');
assert.ok(cloudy.counts.invalidPx > 0 && cloudy.counts.waterPx < riverPx);
const st5 = C.waterStats(cloudy.cls, C.waterStatus(cloudy.cls, base), fGrid);
assert.ok(st5.coveragePct > 30 && st5.coveragePct < 70, 'coverage ' + st5.coveragePct);
assert.equal(st5.newKm2, 0);
// snow/ice (252), ocean mask (254) and fill (255) are invalid too
const hlsInvalid = await dec(wtr((x, y) => (inBox(fGrid, x, y, [0, 0, 1000, 99999]) ? 252 : inBox(fGrid, x, y, [1000, 0, 1000, 99999]) ? 254 : 255)), 'dswxHls');
assert.equal(hlsInvalid.counts.validPx, 0);

// 6. radar masks and undocumented values are invalid (and the undocumented ones are reported)
const masks = await dec(wtr((x, y) => (inBox(fGrid, x, y, [0, 0, 1000, 99999]) ? 250 : inBox(fGrid, x, y, [1000, 0, 1000, 99999]) ? 251
  : inBox(fGrid, x, y, [2000, 0, 300, 99999]) ? 2 : inBox(fGrid, x, y, [2300, 0, 300, 99999]) ? 252 : 0)), 'dswxS1');
assert.ok(masks.counts.invalidPx > 0 && masks.counts.unrecognisedPx > 0);
assert.equal(masks.counts.waterPx, 0, 'S1 value 2 is not documented for DSWx-S1 and is not counted as water');

// 7. no acquisition over the area: the raster does not intersect → nothing valid, insufficient data
const far = makeTiff({ ...fTile, x0: fTile.x0 + 50000, value: () => 1 });
const { target: farT, info: farI } = await sample(fGrid, [[far]], v => v[0] !== 255);
assert.equal(farI[0].inside, 0);
const farD = decodeWater(fGrid, farT.bands[0], farT.covered, WATER_CODES.dswxS1);
assert.equal(farD.counts.validPx, 0); assert.equal(farD.counts.missingPx, fGrid.aoiPixels);
const st7 = C.waterStats(farD.cls, C.waterStatus(farD.cls, base), fGrid);
assert.equal(C.waterConfidence(st7, null).level, 'Insufficient data', 'missing data is never "no flood"');

// 8. valid observations showing no new flooding
const dry = await dec(wtr((x, y) => (river(x, y) ? 1 : 0)), 'dswxHls');
const st8 = C.waterStats(dry.cls, C.waterStatus(dry.cls, base), fGrid);
assert.equal(st8.newKm2, 0); assert.notEqual(C.waterConfidence(st8, null).level, 'Insufficient data');

// baseline selection never includes observations on/after the event date
const frames = [{ date: '2025-06-20' }, { date: '2025-07-02' }, { date: '2025-07-04' }, { date: '2025-07-06' }];
assert.deepEqual(C.baselineFrames(frames, '2025-07-04').map(f => f.date), ['2025-06-20', '2025-07-02']);

// ====================================================================== projections
// cross-zone: AOI on the 144°E zone boundary (grid in zone 54) read from a zone-55 raster
const xGrid = makeMetricGrid(rect(143.985, -8.31, 144.015, -8.29));
assert.equal(xGrid.zone, 54);
const z55 = { epsg: 32755, res: 30 };
const [cx, cy] = (await import('../public/js/geo.js')).toUtm(144, -8.3, 55, true);
const xTif = makeTiff({ ...z55, x0: Math.floor((cx - 3000) / 30) * 30, y0: Math.ceil((cy + 2500) / 30) * 30, width: 220, height: 180,
  value: (x, y) => (fromUtm(x, y, 55, true)[0] < 144 ? 1 : 0) });
const { target: xT } = await sample(xGrid, [[xTif]], v => v[0] !== 255);
const xD = decodeWater(xGrid, xT.bands[0], xT.covered, WATER_CODES.dswxS1);
assert.ok(xD.counts.validPx > 0.95 * xGrid.aoiPixels, 'reprojected sampling covers the AOI');
near(xD.counts.waterPx / xD.counts.validPx, 0.5, 0.05);

// geographic (EPSG:4326) raster, e.g. the MODIS flood product
const gTif = makeTiff({ epsg: 4326, x0: 140.3, y0: -8.2, res: 0.0025, width: 80, height: 80, value: (lon) => (lon < 140.395 ? 3 : 0) });
const { target: gT } = await sample(distGrid, [[gTif]], v => v[0] !== 255);
const gD = decodeWater(distGrid, gT.bands[0], gT.covered, WATER_CODES.mcdwd);
const gS = C.waterStats(gD.cls, C.waterStatus(gD.cls, null), distGrid);
near(gS.newKm2 / gS.validKm2, 0.5, 0.06);

// malformed file / missing CRS is an error, not an empty result
await assert.rejects(open(new ArrayBuffer(16)));
const noCrs = makeTiff({ ...distTile, epsg: 99999, value: () => 0 });
await assert.rejects(readWindow(await open(noCrs), distGrid), /CRS/);

console.log('raster tests: all passed');
