import assert from 'node:assert/strict';
import * as C from '../public/js/classify.js';
import { DATASETS } from '../public/js/config.js';

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

// --- water classes ---
const xmlW = `<ColorMap units=""><ColorMapEntry rgb="255,255,255" label="Not Water"/><ColorMapEntry rgb="0,0,255" label="Open Water"/><ColorMapEntry rgb="180,213,244" label="Partial Surface Water"/><ColorMapEntry rgb="0,255,0" label="Inundated Vegetation"/><ColorMapEntry rgb="10,10,10" label="HAND masked"/></ColorMap>`;
const cw = C.buildClassifier(ds('dswx-s1'), C.parseColormap(xmlW));
const wl = l => cw.info.find(i => i.label === l).level;
assert.deepEqual(['Not Water','Open Water','Partial Surface Water','Inundated Vegetation','HAND masked'].map(wl), [0,3,2,3,C.OUT]);

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
console.log('classify tests: all passed');
