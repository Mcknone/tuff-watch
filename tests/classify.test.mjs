import assert from 'node:assert/strict';
import * as C from '../public/js/classify.js';
import { DATASETS, WATER_CODES, WATER_LABEL_RULES } from '../public/js/config.js';

const ds = id => DATASETS.find(d => d.id === id);

// --- colour map parsing (GIBS v1.3 style) ---
const xmlDist = `<?xml version="1.0"?><ColorMaps><ColorMap title="DIST" units="">
<Entries>
<ColorMapEntry rgb="0,0,0" transparent="true" sourceValue="[255]" label="No Data" nodata="true"/>
<ColorMapEntry rgb="18,10,143" transparent="false" sourceValue="[1]" label="First detection (&lt;50%)"/>
<ColorMapEntry rgb="120,0,150" transparent="false" sourceValue="[3]" label="Confirmed (&lt;50%)"/>
<ColorMapEntry rgb="250,120,0" transparent="false" sourceValue="[4]" label="First detection (&#8805;50%)"/>
<ColorMapEntry rgb="200,0,0" transparent="false" sourceValue="[6]" label="Confirmed (&#8805;50%)"/>
<ColorMapEntry rgb="128,128,128" transparent="false" sourceValue="[250]" label="Cloud"/>
</Entries></ColorMap></ColorMaps>`;
const cm = C.parseColormap(xmlDist);
assert.equal(cm.entries.length, 6);
assert.equal(cm.entries[2].label, 'Confirmed (<50%)');
assert.equal(cm.entries[4].label, 'Confirmed (≥50%)');
const cl = C.buildClassifier(ds('dist'), cm);
const lv = l => cl.info.find(i => i.label === l).level;
assert.equal(lv('First detection (<50%)'), 1);
assert.equal(lv('Confirmed (<50%)'), 2);
assert.equal(lv('First detection (≥50%)'), 3);
assert.equal(lv('Confirmed (≥50%)'), 4);
assert.equal(lv('Cloud'), C.OUT);

// --- continuous chlorophyll ---
const xmlC = `<ColorMap units="mg/m^3"><ColorMapEntry rgb="1,1,1" value="[0.3,0.31)" label="0.3"/><ColorMapEntry rgb="2,2,2" value="[2.0,2.1)" label="2"/><ColorMapEntry rgb="3,3,3" value="[8,8.5)" label="8"/><ColorMapEntry rgb="4,4,4" value="[25,26)" label="25"/><ColorMapEntry rgb="5,5,5" value="[60,65)" label="60"/></ColorMap>`;
const cc = C.buildClassifier(ds('pace-chl'), C.parseColormap(xmlC));
assert.deepEqual(cc.info.map(i => i.level), [0,1,2,3,4]);
assert.equal(C.parseColormap(xmlC).units, 'mg/m^3');

// --- grid & pixel classification ---
const square = [[0,0],[0.1,0],[0.1,0.1],[0,0.1],[0,0]];
const g = C.makeGrid(square, [0,0,0.1,0.1], 100);
assert.equal(g.w, 100); assert.ok(Math.abs(g.h - 99) <= 1);
assert.ok(Math.abs(g.aoiKm2 - 11.13*11.06) < 2, 'area ' + g.aoiKm2);
const n = g.w*g.h, rgba = new Uint8ClampedArray(n*4);
// left half: confirmed >=50 (200,0,0); right half transparent; one cloud pixel; one near-colour pixel
for (let p=0;p<n;p++){ const i=p%g.w; if(i<50){rgba.set([200,0,0,255],p*4);} }
rgba.set([128,128,128,255],0); rgba.set([198,3,1,255],4);
const lev = C.classifyPixels(rgba, g, ds('dist'), cl);
assert.equal(lev[0], C.OUT); assert.equal(lev[1], 4); assert.equal(lev[60], 0);
const st = C.frameStats(lev, g);
assert.ok(Math.abs(st.affectedPctOfAoi - 50) < 1.5, 'pct ' + st.affectedPctOfAoi);
assert.equal(C.overallLevel(st, g.aoiKm2), 4);

// --- presence (fires) ---
const lf = C.classifyPixels(rgba, g, ds('viirs-fire'), C.buildClassifier(ds('viirs-fire'), null));
assert.equal(lf[1], 3); assert.equal(lf[60], 0);

// --- SAR darkening ---
const ref = new Int16Array([100,100,100,-1,100]), cur = new Int16Array([95,70,10,50,60]);
assert.deepEqual([...C.sarLevels(ref, cur, [18,32,50,75])], [0,1,4,C.OUT,2]);

// --- new water + combine ---
assert.deepEqual([...C.markNewWater(new Uint8Array([0,3,0,255]), new Uint8Array([3,3,2,3]))], [4,3,4,3]);
const g2 = C.makeGrid(square, [0,0,0.1,0.1], 20);
const A = new Uint8Array(g2.w*g2.h).fill(0), B = new Uint8Array(g2.w*g2.h).fill(0);
A[25]=2; B[25]=3; A[26]=1;
const comb = C.combine([A,B], g2);
assert.equal(comb.merged[25], 3); assert.equal(comb.merged[26], 1);
assert.ok(comb.agreeKm2 > 0 && comb.agreeKm2 < 1);

// --- dates ---
assert.deepEqual(C.sampleDates(['a','b','c','d','e'], 3), ['a','c','e']);
assert.deepEqual(C.dailyDates('2025-01-01','2025-01-11',3), ['2025-01-01','2025-01-06','2025-01-11']);
assert.deepEqual(C.dailyDates('2025-01-01','2025-01-02',8), ['2025-01-01','2025-01-02']);

// =========================== surface water (floods) ===========================
const W = C.W;
const wclf = (xml, codes) => C.buildWaterClassifier(C.parseColormap(xml), WATER_CODES[codes], WATER_LABEL_RULES);

// DSWx-HLS-style colour map with documented class values
const xmlHls = `<ColorMap units=""><ColorMapEntry rgb="255,255,255" sourceValue="[0]" label="Not Water"/>
<ColorMapEntry rgb="0,0,255" sourceValue="[1]" label="Open Water"/>
<ColorMapEntry rgb="180,213,244" sourceValue="[2]" label="Partial Surface Water"/>
<ColorMapEntry rgb="0,255,255" sourceValue="[252]" label="Snow/Ice"/>
<ColorMapEntry rgb="175,175,175" sourceValue="[253]" label="Cloud/Cloud Shadow"/>
<ColorMapEntry rgb="0,0,127" sourceValue="[254]" label="Ocean Masked"/>
<ColorMapEntry rgb="0,0,0" transparent="true" nodata="true" sourceValue="[255]" label="Fill"/></ColorMap>`;
const ch = wclf(xmlHls, 'dswxHls');
const cls = l => ch.info.find(i => i.label === l).cls;
assert.equal(cls('Not Water'), W.DRY);
assert.equal(cls('Open Water'), W.OPEN);
assert.equal(cls('Partial Surface Water'), W.PARTIAL);
for (const l of ['Snow/Ice', 'Cloud/Cloud Shadow', 'Ocean Masked', 'Fill']) assert.equal(cls(l), C.OUT, l);
assert.equal(ch.transparentIsDry, false);

// DSWx-S1: inundated vegetation, layover/shadow and HAND masks
const xmlS1 = `<ColorMap><ColorMapEntry rgb="250,250,250" sourceValue="[0]" label="Not Water"/>
<ColorMapEntry rgb="0,0,255" sourceValue="[1]" label="Open Water"/>
<ColorMapEntry rgb="0,128,0" sourceValue="[3]" label="Inundated Vegetation"/>
<ColorMapEntry rgb="90,90,90" sourceValue="[250]" label="HAND Masked"/>
<ColorMapEntry rgb="60,60,60" sourceValue="[251]" label="Layover/Shadow Masked"/></ColorMap>`;
const cs = wclf(xmlS1, 'dswxS1');
assert.deepEqual(cs.info.map(i => i.cls), [W.DRY, W.OPEN, W.INUNDATED_VEG, C.OUT, C.OUT]);

// labels that mention confidence: confidence never changes the class
const xmlConf = `<ColorMap><ColorMapEntry rgb="1,1,1" label="Not Water (moderate confidence)"/><ColorMapEntry rgb="2,2,200" label="Water - moderate confidence"/><ColorMapEntry rgb="9,9,9" label="Something undocumented"/></ColorMap>`;
const cc2 = C.buildWaterClassifier(C.parseColormap(xmlConf), null, WATER_LABEL_RULES);
assert.deepEqual(cc2.info.map(i => i.cls), [W.DRY, W.OPEN, C.OUT], 'unknown class is excluded, never water');

// MODIS flood product: reference / recurring water is normal, "flood" is new by the product
const xmlM = `<ColorMap><ColorMapEntry rgb="200,200,200" sourceValue="[0]" label="No Water"/><ColorMapEntry rgb="0,0,200" sourceValue="[1]" label="Surface Water"/>
<ColorMapEntry rgb="100,100,255" sourceValue="[2]" label="Recurring Flood"/><ColorMapEntry rgb="255,0,0" sourceValue="[3]" label="Flood"/>
<ColorMapEntry rgb="0,0,0" sourceValue="[255]" label="Insufficient Data"/></ColorMap>`;
assert.deepEqual(wclf(xmlM, 'mcdwd').info.map(i => i.cls), [W.DRY, W.REFERENCE, W.REFERENCE, W.FLOOD, C.OUT]);

// strict colour matching: a resampled blend of white + blue is NOT "partial water"
assert.equal(C.matchWaterColour(ch, 0, 0, 255), W.OPEN);
assert.equal(C.matchWaterColour(ch, 4, 3, 250), W.OPEN);
assert.equal(C.matchWaterColour(ch, 128, 128, 255), C.UNCLASSIFIED);
assert.equal(C.matchWaterColour(ch, 175, 175, 175), C.OUT);

// --- full pipeline on a synthetic area -------------------------------------------
const gw = C.makeGrid(square, [0, 0, 0.1, 0.1], 100);
const N = gw.w * gw.h;
const paint = fn => { const a = new Uint8ClampedArray(N * 4); for (let p = 0; p < N; p++) a.set(fn(p % gw.w, Math.floor(p / gw.w)), p * 4); return a; };
const WHITE = [255, 255, 255, 255], BLUE = [0, 0, 255, 255], CLOUD = [175, 175, 175, 255], NONE = [0, 0, 0, 0];
// baseline: a river in columns 0-9, everything else dry
const before = C.classifyWater(paint(i => (i < 10 ? BLUE : WHITE)), gw, ch);
// after: river + flood in columns 10-29; columns 80-99 cloud; rows 0-9 no data
const after = C.classifyWater(paint((i, j) => (j < 10 ? NONE : i >= 80 ? CLOUD : i < 30 ? BLUE : WHITE)), gw, ch);
const base = C.waterBaseline([before], N);
const status = C.waterStatus(after, base);
const sa = C.waterStats(after, status, gw);
const pctOfAoi = v => (100 * v) / gw.aoiKm2;
// valid = 80 % of columns × 90 % of rows = 72 % of area
assert.ok(Math.abs(sa.coveragePct - 72) < 2, 'coverage ' + sa.coveragePct);
// new water = columns 10-29 (20 %) × 90 % rows = 18 % of area; normal = 10 % × 90 % = 9 %
assert.ok(Math.abs(pctOfAoi(sa.newKm2) - 18) < 1.5, 'new ' + pctOfAoi(sa.newKm2));
assert.ok(Math.abs(pctOfAoi(sa.normalKm2) - 9) < 1, 'normal ' + pctOfAoi(sa.normalKm2));
// % is of the OBSERVED area: 18 / 72 = 25 %
assert.ok(Math.abs(sa.newPctOfObserved - 25) < 2, 'new % of observed ' + sa.newPctOfObserved);
// clouds and missing data are never water
assert.equal(status[gw.w * 50 + 90], C.OUT);
assert.equal(status[gw.w * 2 + 15], C.OUT);

// regression: an image that is entirely transparent (no acquisition) is NOT dry or flooded
const empty = C.classifyWater(paint(() => NONE), gw, ch);
const se = C.waterStats(empty, C.waterStatus(empty, base), gw);
assert.equal(se.validKm2, 0); assert.equal(se.newKm2, 0); assert.equal(se.waterKm2, 0);
assert.equal(C.waterConfidence(se, null).level, 'Insufficient data');

// regression: a resampled blend of "not water" white and "open water" blue (190,190,255).
// The old nearest-colour matcher (tolerance 3·24²) mapped it to "Partial Surface Water" =
// level 2 "Moderate", which coloured whole areas as moderately flooded.
const blended = C.classifyWater(paint(() => [190, 190, 255, 255]), gw, ch);
const oldLevel = C.classifyPixels(paint(() => [190, 190, 255, 255]), gw, { method: "classes" }, C.buildClassifier({ method: "classes", labelLevel: l => (/partial/i.test(l) ? 2 : /water/i.test(l) ? 3 : null), noneRe: /not water/i }, C.parseColormap(xmlHls)));
assert.equal(oldLevel[gw.w * 50 + 50], 2, "old pipeline: blend became Moderate");
const sb = C.waterStats(blended, C.waterStatus(blended, base), gw);
assert.equal(sb.waterKm2, 0, 'blended colours are unclassified, not water');
assert.ok(sb.unclassifiedKm2 > 0.9 * gw.aoiKm2);

// transparent "not water" visualisations count as dry only where an acquisition exists
const xmlT = xmlHls.replace('rgb="255,255,255" sourceValue="[0]"', 'rgb="255,255,255" transparent="true" sourceValue="[0]"');
const ct = wclf(xmlT, 'dswxHls');
assert.equal(ct.transparentIsDry, true);
assert.equal(C.classifyWater(paint(() => NONE), gw, ct, true)[gw.w * 50 + 50], W.DRY);
assert.equal(C.classifyWater(paint(() => NONE), gw, ct, false)[gw.w * 50 + 50], C.OUT);

// no baseline → water is "unknown", never new
const sNoBase = C.waterStats(after, C.waterStatus(after, null), gw);
assert.equal(sNoBase.newKm2, 0);
assert.ok(sNoBase.unknownKm2 > 0);

// --- agreement & confidence -------------------------------------------------------
const after2 = C.classifyWater(paint((i, j) => (i < 30 ? BLUE : WHITE)), gw, ch);   // second sensor, no clouds
const st2 = C.waterStatus(after2, base);
const ag = C.waterAgreement(status, st2, gw);
assert.ok(ag.agreePct > 99, 'agree ' + ag.agreePct);
assert.equal(C.waterConfidence(sa, ag).level, 'High');
assert.equal(C.waterConfidence(sa, null).level, 'Medium');
const lowCov = { ...sa, coveragePct: 20 };
assert.equal(C.waterConfidence(lowCov, ag).level, 'Insufficient data');
const disagree = C.waterAgreement(status, C.waterStatus(C.classifyWater(paint(i => (i >= 30 && i < 80 ? BLUE : WHITE)), gw, ch), base), gw);
assert.ok(disagree.agreePct < 60);
assert.equal(C.waterConfidence(sa, disagree).level, 'Low');

// --- rainfall context ------------------------------------------------------------
const xmlR = `<ColorMap units="mm/h"><ColorMapEntry rgb="0,0,0" transparent="true" nodata="true" label="No Data"/><ColorMapEntry rgb="10,10,200" value="[1,2)" label="1"/><ColorMapEntry rgb="200,10,10" value="[10,20)" label="10"/></ColorMap>`;
const rc = C.buildValueClassifier(C.parseColormap(xmlR));
const rs = C.valueStats(paint(i => (i < 50 ? [200, 10, 10, 255] : NONE)), gw, rc);
assert.ok(Math.abs(rs.mean - 5) < 0.3, 'rain mean ' + rs.mean);
assert.equal(rs.max, 10);

console.log('classify tests: all passed');
