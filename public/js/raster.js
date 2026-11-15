// =============================================================================
// Numerical product rasters (OPERA DIST-ALERT, DSWx, MODIS flood)
//
// The scientific numbers come from the products' own GeoTIFF bands, decoded with
// the documented class values – never from GIBS display colours. GIBS stays in use
// for visualisation only.
//
// Pipeline per acquisition date:
//   granules (CMR) → band GeoTIFF (COG, HTTP range reads) → window around the AOI
//   → nearest-neighbour sampling onto the metric analysis grid (no interpolation of
//     categorical values; overlapping granules never counted twice)
//   → decode classes / values → per-pixel result + diagnostics
// Pure functions except readWindow(), which takes an already-opened GeoTIFF object.
// =============================================================================
import { crsFromEpsg, toUtm, fromUtm } from './geo.js';
import { OUT, W } from './classify.js';

export const MISSING = 255;     // grid cell not covered by any raster

// ---------------------------------------------------------------- GeoTIFF reading
/** Extract CRS, geotransform, no-data and product metadata from the first image. */
export function describeImage(image) {
  const keys = image.getGeoKeys() || {};
  const epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || null;
  const crs = epsg ? crsFromEpsg(epsg) : null;
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  const fd = image.fileDirectory || {};
  const meta = parseGdalMetadata(fd.GDAL_METADATA);
  return {
    epsg, crs, x0: ox, y0: oy, resX: rx, resY: ry,
    width: image.getWidth(), height: image.getHeight(),
    nodata: image.getGDALNoData(),
    productVersion: meta.PRODUCT_VERSION || meta.product_version || meta.VERSION || meta.version || null,
    meta
  };
}

export function parseGdalMetadata(xml) {
  const out = {};
  if (!xml) return out;
  const re = /<Item\s+name="([^"]+)"[^>]*>([^<]*)<\/Item>/g;
  let m;
  while ((m = re.exec(String(xml)))) if (!(m[1] in out)) out[m[1]] = m[2];
  return out;
}

/** Convert a grid cell centre to the raster CRS. Returns [x, y] or null. */
function cellToCrs(grid, i, j, crs, sameZone) {
  const x = grid.x0 + (i + 0.5) * grid.cell, y = grid.y1 - (j + 0.5) * grid.cell;
  if (sameZone) return crs.south === grid.south ? [x, y] : [x, y + (crs.south ? 10000000 : -10000000)];
  const [lon, lat] = fromUtm(x, y, grid.zone, grid.south);
  if (crs.type === 'geographic') return [lon, lat];
  const p = toUtm(lon, lat, crs.zone, crs.south);
  return [p[0], p[1]];
}

/** Pixel window [c0, r0, c1, r1) of the raster that covers the grid (with a 1-pixel margin). */
export function windowFor(grid, d) {
  if (!d.crs) return null;
  const sameZone = d.crs.type === 'utm' && d.crs.zone === grid.zone;
  const pts = [];
  for (const fi of [0, 0.5, 1]) for (const fj of [0, 0.5, 1]) {
    const i = fi * grid.w - 0.5, j = fj * grid.h - 0.5;
    pts.push(cellToCrs(grid, i, j, d.crs, sameZone));
  }
  const cols = pts.map(p => (p[0] - d.x0) / d.resX), rows = pts.map(p => (p[1] - d.y0) / d.resY);
  const c0 = Math.max(0, Math.floor(Math.min(...cols)) - 1), c1 = Math.min(d.width, Math.ceil(Math.max(...cols)) + 1);
  const r0 = Math.max(0, Math.floor(Math.min(...rows)) - 1), r1 = Math.min(d.height, Math.ceil(Math.max(...rows)) + 1);
  if (c1 <= c0 || r1 <= r0) return null;
  return [c0, r0, c1, r1];
}

/** Read one band window covering the grid. tiff: a geotiff.js GeoTIFF. */
export async function readWindow(tiff, grid, opts = {}) {
  const image = await tiff.getImage();
  const d = describeImage(image);
  if (!d.crs) throw Object.assign(new Error(`unsupported or missing CRS (EPSG ${d.epsg})`), { kind: 'malformed' });
  if (!(d.resX > 0) || !(d.resY < 0)) throw Object.assign(new Error('unexpected raster geotransform'), { kind: 'malformed' });
  const win = windowFor(grid, d);
  if (!win) return { ...d, window: null, data: null };
  const r = await image.readRasters({ window: win, samples: [0], interleave: false, signal: opts.signal });
  return { ...d, window: win, data: r[0], wWidth: win[2] - win[0], wHeight: win[3] - win[1] };
}

// ---------------------------------------------------------------- sampling
/**
 * Nearest-neighbour sample one granule's band windows into grid-sized arrays.
 * layers: [{ ...readWindow result }] – one per band, all from the SAME granule.
 * target: { bands: [Uint8Array per band], covered: Uint8Array, filled: Uint8Array }
 * isValid(values[]) decides whether this granule's value should fill the cell; a cell
 * already filled with a valid value by an earlier granule is never overwritten, so
 * overlapping granules (MGRS tile overlap, same-day passes) are not double counted.
 * Returns the number of AOI cells this granule covers and the number it filled.
 */
export function sampleGranule(grid, layers, target, isValid) {
  const L0 = layers[0];
  if (!L0.data) return { inside: 0, filled: 0 };
  const crs = L0.crs;
  const sameZone = crs.type === 'utm' && crs.zone === grid.zone;
  const [c0, r0] = L0.window;
  let inside = 0, filled = 0;
  const vals = new Array(layers.length);
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      const p = j * grid.w + i;
      if (!grid.mask[p]) continue;
      const q = cellToCrs(grid, i, j, crs, sameZone);
      const col = Math.floor((q[0] - L0.x0) / L0.resX) - c0;
      const row = Math.floor((q[1] - L0.y0) / L0.resY) - r0;
      if (col < 0 || row < 0 || col >= L0.wWidth || row >= L0.wHeight) continue;
      inside++;
      if (target.filled[p]) continue;
      for (let b = 0; b < layers.length; b++) {
        const Lb = layers[b];
        vals[b] = Lb.data ? Lb.data[row * Lb.wWidth + col] : MISSING;
      }
      // first granule that covers the cell records its (possibly invalid) values;
      // a later granule may replace them only with VALID values
      if (!target.covered[p] || isValid(vals)) {
        for (let b = 0; b < layers.length; b++) target.bands[b][p] = vals[b] > 255 ? 255 : vals[b];
        target.covered[p] = 1;
      }
      if (isValid(vals)) { target.filled[p] = 1; filled++; }
    }
  }
  return { inside, filled };
}

export function newTarget(grid, nBands) {
  const n = grid.w * grid.h;
  return { bands: Array.from({ length: nBands }, () => new Uint8Array(n).fill(MISSING)), covered: new Uint8Array(n), filled: new Uint8Array(n) };
}

/** Raw value histogram inside the AOI (diagnostics: shows exactly what the product contained). */
export function valueHistogram(grid, values, covered) {
  const h = {};
  for (let p = 0; p < values.length; p++) {
    if (!grid.mask[p] || !covered[p]) continue;
    h[values[p]] = (h[values[p]] || 0) + 1;
  }
  return h;
}

// ---------------------------------------------------------------- DIST-ALERT
// VEG-DIST-STATUS (OPERA DIST-ALERT-HLS v1) and GEN-DIST-STATUS (DIST-ALERT-S1) values:
//   0 no disturbance · 1 first <50 % · 2 provisional <50 % · 3 confirmed <50 %
//   4 first ≥50 % · 5 provisional ≥50 % · 6 confirmed ≥50 %
//   7 confirmed <50 % finished · 8 confirmed ≥50 % finished · 255 no data
export const DIST_STATUS = {
  0: { stage: 'none' },
  1: { stage: 'first', mag: 'low' }, 2: { stage: 'provisional', mag: 'low' }, 3: { stage: 'confirmed', mag: 'low' },
  4: { stage: 'first', mag: 'high' }, 5: { stage: 'provisional', mag: 'high' }, 6: { stage: 'confirmed', mag: 'high' },
  7: { stage: 'confirmed', mag: 'low', finished: true }, 8: { stage: 'confirmed', mag: 'high', finished: true }
};
export const DIST_STATUS_NAMES = {
  0: 'no disturbance', 1: 'first detection <50 %', 2: 'provisional <50 %', 3: 'confirmed <50 %',
  4: 'first detection ≥50 %', 5: 'provisional ≥50 %', 6: 'confirmed ≥50 %',
  7: 'confirmed <50 %, finished', 8: 'confirmed ≥50 %, finished', 255: 'no data'
};
// map / chart category per detected pixel: 1 first|provisional <50, 2 first|provisional ≥50, 3 confirmed <50, 4 confirmed ≥50
const DIST_CAT = { 1: 1, 2: 1, 4: 2, 5: 2, 3: 3, 7: 3, 6: 4, 8: 4 };

/**
 * Decode DIST-ALERT status (+ optional loss anomaly, 0–100 %, 255 = no data).
 * opts.minLossPct  – minimum vegetation-cover loss per pixel (analysis setting, applied to
 *                    the anomaly band when present; status-only products are not filtered)
 * opts.minPatchHa  – minimum connected patch size; 0 = keep every detected pixel
 * Returns per-cell categories and statistics. Nothing is dropped silently: pixels
 * removed by either setting are counted and reported.
 */
export function decodeDist(grid, status, anom, covered, opts = {}) {
  const minLoss = opts.minLossPct ?? 0, minPatchHa = opts.minPatchHa ?? 0;
  const n = grid.w * grid.h, cellKm2 = grid.rowArea[0];
  const levels = new Uint8Array(n).fill(OUT);
  const det = new Uint8Array(n);
  const s = {
    validPx: 0, invalidPx: 0, missingPx: 0, unrecognisedPx: 0, detectedPx: 0,
    belowLossPx: 0, anomalyOnlyPx: 0, magnitudeUnknownPx: 0, smallPatchPx: 0,
    byStage: { first: { low: 0, high: 0 }, provisional: { low: 0, high: 0 }, confirmed: { low: 0, high: 0 } },
    lossSum: 0, lossN: 0, lossMax: null, patches: 0, minLossPct: minLoss, minPatchHa
  };
  for (let p = 0; p < n; p++) {
    if (!grid.mask[p]) continue;
    if (!covered[p]) { s.missingPx++; continue; }
    const v = status[p];
    if (v === 255) { s.invalidPx++; continue; }
    const cls = DIST_STATUS[v];
    if (!cls) { s.invalidPx++; s.unrecognisedPx++; continue; }
    s.validPx++;
    const a = anom ? anom[p] : null;
    const aOk = a !== null && a !== 255 && a <= 100;
    if (cls.stage === 'none') {
      levels[p] = 0;
      if (aOk && minLoss > 0 && a >= minLoss) s.anomalyOnlyPx++;
      continue;
    }
    if (anom && aOk && a < minLoss) { s.belowLossPx++; levels[p] = 0; continue; }
    if (anom && !aOk) s.magnitudeUnknownPx++;
    det[p] = 1;
  }
  // connected patches (8-neighbour) – only used to report patch sizes and, if the user
  // asked for it, to drop patches smaller than minPatchHa
  const lab = new Int32Array(n).fill(-1);
  const minPatchPx = minPatchHa > 0 ? (minPatchHa / 100) / cellKm2 : 0;
  const stack = [];
  for (let p = 0; p < n; p++) {
    if (!det[p] || lab[p] >= 0) continue;
    const members = [];
    stack.push(p); lab[p] = s.patches;
    while (stack.length) {
      const q = stack.pop(); members.push(q);
      const qi = q % grid.w, qj = (q / grid.w) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = qi + di, nj = qj + dj;
        if (ni < 0 || nj < 0 || ni >= grid.w || nj >= grid.h) continue;
        const r = nj * grid.w + ni;
        if (det[r] && lab[r] < 0) { lab[r] = s.patches; stack.push(r); }
      }
    }
    s.patches++;
    const keep = members.length >= minPatchPx;
    for (const q of members) {
      if (!keep) { s.smallPatchPx++; levels[q] = 0; continue; }
      const v = status[q], cls = DIST_STATUS[v];
      s.detectedPx++;
      s.byStage[cls.stage][cls.mag]++;
      levels[q] = DIST_CAT[v];
      const a = anom ? anom[q] : 255;
      if (a !== 255 && a <= 100) { s.lossSum += a; s.lossN++; s.lossMax = s.lossMax === null ? a : Math.max(s.lossMax, a); }
    }
  }
  const km = px => px * cellKm2;
  const st = {
    ...s,
    validKm2: km(s.validPx), invalidKm2: km(s.invalidPx), missingKm2: km(s.missingPx),
    detectedKm2: km(s.detectedPx), belowLossKm2: km(s.belowLossPx), anomalyOnlyKm2: km(s.anomalyOnlyPx),
    smallPatchKm2: km(s.smallPatchPx),
    stageKm2: Object.fromEntries(Object.entries(s.byStage).map(([k, v]) => [k, { low: km(v.low), high: km(v.high) }])),
    meanLossPct: s.lossN ? s.lossSum / s.lossN : null,
    coveragePct: grid.aoiKm2 ? (100 * km(s.validPx)) / grid.aoiKm2 : 0,
    detectedPctOfValid: s.validPx ? (100 * s.detectedPx) / s.validPx : 0
  };
  st.affected = st.detectedKm2;                    // generic field (chart, export)
  st.km2 = [km(s.validPx - s.detectedPx), 0, 0, 0, 0];
  for (let p = 0; p < n; p++) if (levels[p] >= 1 && levels[p] <= 4) st.km2[levels[p]] += cellKm2;
  return { levels, stats: st };
}

// ---------------------------------------------------------------- DSWx / MODIS flood
/**
 * Decode a water-classification band (WTR) with a documented class table
 * ({value: 'dry'|'open'|'partial'|'inundated_veg'|'reference'|'flood'|'invalid'}).
 * Values missing from the table are INVALID and counted as unrecognised.
 */
const W_BY_NAME = { dry: W.DRY, open: W.OPEN, partial: W.PARTIAL, inundated_veg: W.INUNDATED_VEG, flood: W.FLOOD, reference: W.REFERENCE };
export function decodeWater(grid, values, covered, table) {
  const n = grid.w * grid.h;
  const cls = new Uint8Array(n).fill(OUT);
  const c = { validPx: 0, invalidPx: 0, missingPx: 0, unrecognisedPx: 0, waterPx: 0 };
  for (let p = 0; p < n; p++) {
    if (!grid.mask[p]) continue;
    if (!covered[p]) { c.missingPx++; continue; }
    const name = table[values[p]];
    if (!name) { c.invalidPx++; c.unrecognisedPx++; continue; }
    if (name === 'invalid') { c.invalidPx++; continue; }
    cls[p] = W_BY_NAME[name];
    c.validPx++;
    if (cls[p] !== W.DRY) c.waterPx++;
  }
  return { cls, counts: c };
}
