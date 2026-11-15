// =============================================================================
// Classification engine (pure functions – no DOM, testable in Node)
//
// NASA GIBS serves each science product as a coloured image plus a "colour map"
// XML that says which colour means which class or value. We read the image's
// pixels, look each colour up in the colour map, and turn it into:
//    255 = outside area / not observed (cloud, no data, no acquisition)
//    254 = coloured but not in the colour map (unclassified)
//      0 = observed, phenomenon not present
//    1–4 = phenomenon present: Low / Moderate / High / Severe
// =============================================================================

export const OUT = 255;
export const UNCLASSIFIED = 254;

const UNOBSERVED_RE = /cloud|shadow|snow|ice|no ?data|fill|not observed|unobserved|missing|hand[- ]?mask|layover|outside/i;

// ----------------------------------------------------------------- colour maps
function parseAttrs(s) {
  const out = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Parse a GIBS colour map XML (v1.3) into a list of colour entries. */
export function parseColormap(xml) {
  if (!xml || !/<ColorMapEntry/i.test(xml)) return null;
  const legend = new Map();                       // rgb -> tooltip
  const lre = /<LegendEntry\b([^>]*)\/?>/g;
  let m;
  while ((m = lre.exec(xml))) {
    const a = parseAttrs(m[1]);
    if (a.rgb && a.tooltip) legend.set(a.rgb.replace(/\s/g, ''), decodeEntities(a.tooltip));
  }
  const entries = [];
  const ere = /<ColorMapEntry\b([^>]*)\/?>/g;
  while ((m = ere.exec(xml))) {
    const a = parseAttrs(m[1]);
    if (!a.rgb) continue;
    const rgb = a.rgb.replace(/\s/g, '');
    const [r, g, b] = rgb.split(',').map(Number);
    entries.push({
      r, g, b, rgb,
      transparent: a.transparent === 'true',
      nodata: a.nodata === 'true',
      label: decodeEntities(a.label || legend.get(rgb) || ''),
      value: a.value || a.sourceValue || ''
    });
  }
  const units = (xml.match(/<ColorMap\b[^>]*\bunits="([^"]*)"/) || [])[1] || '';
  return entries.length ? { entries, units: decodeEntities(units) } : null;
}

export function firstNumber(s) {
  const m = String(s || '').match(/-?\d+(\.\d+)?(e-?\d+)?/i);
  return m ? parseFloat(m[0]) : null;
}

/**
 * Build a classifier for one dataset.
 * Returns { lookup: Map(rgbKey -> level), info: [{label, rgb, level}], palette: [...] , mode }
 */
export function buildClassifier(ds, colormap) {
  const lookup = new Map();
  const info = [];
  if (ds.method === 'presence' || ds.method === 'sar' || !colormap) {
    return { lookup, info, palette: [], mode: colormap ? ds.method : (ds.method === 'sar' ? 'sar' : 'presence-fallback') };
  }
  const usable = colormap.entries.filter(e => !e.transparent && !e.nodata);
  // First pass: decide unobserved / none / present
  const prelim = usable.map(e => {
    const text = `${e.label} ${e.value}`;
    if (UNOBSERVED_RE.test(e.label)) return { e, kind: 'out' };
    if (ds.method === 'continuous') {
      const v = firstNumber(e.value) ?? firstNumber(e.label);
      if (v === null) return { e, kind: 'present', level: null };
      const t = ds.thresholds;
      const level = v >= t[3] ? 4 : v >= t[2] ? 3 : v >= t[1] ? 2 : v >= t[0] ? 1 : 0;
      return { e, kind: level === 0 ? 'none' : 'present', level };
    }
    if (ds.noneRe && ds.noneRe.test(e.label)) return { e, kind: 'none' };
    const lv = ds.labelLevel ? ds.labelLevel(text) : null;
    return { e, kind: 'present', level: lv };
  });
  // Second pass: anything without a rule gets a level from colour-map order
  const present = prelim.filter(p => p.kind === 'present');
  present.forEach((p, i) => {
    if (p.level == null) p.level = Math.min(4, 1 + Math.floor((i * 4) / Math.max(present.length, 1)));
  });
  for (const p of prelim) {
    const level = p.kind === 'out' ? OUT : p.kind === 'none' ? 0 : p.level;
    lookup.set(key(p.e.r, p.e.g, p.e.b), level);
    info.push({ label: p.e.label || p.e.value, rgb: p.e.rgb, level });
  }
  return { lookup, info, palette: usable, mode: ds.method };
}

function key(r, g, b) { return (r << 16) | (g << 8) | b; }

function nearest(classifier, r, g, b) {
  let best = null, bestD = 3 * 24 * 24;          // tolerate small colour differences
  for (const e of classifier.palette) {
    const d = (e.r - r) ** 2 + (e.g - g) ** 2 + (e.b - b) ** 2;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? classifier.lookup.get(key(best.r, best.g, best.b)) : UNCLASSIFIED;
}

// ------------------------------------------------------------------- the grid
/** Ray-casting point-in-polygon. poly = [[lon,lat], ...] */
export function pointInPolygon(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Analysis grid shared by every dataset (so pixels line up across sensors).
 * bbox = [west, south, east, north]; longSide = pixels on the longer side.
 */
export function makeGrid(polygon, bbox, longSide = 512) {
  const [W, S, E, N] = bbox;
  const midLat = (S + N) / 2;
  const kmX = (E - W) * 111.32 * Math.cos((midLat * Math.PI) / 180);
  const kmY = (N - S) * 110.57;
  let w, h;
  if (kmX >= kmY) { w = longSide; h = Math.max(16, Math.round((longSide * kmY) / kmX)); }
  else { h = longSide; w = Math.max(16, Math.round((longSide * kmX) / kmY)); }
  const mask = new Uint8Array(w * h);
  const rowArea = new Float64Array(h);           // km² of one pixel in each row
  let aoiKm2 = 0, aoiPixels = 0;
  for (let j = 0; j < h; j++) {
    const lat = N - ((j + 0.5) * (N - S)) / h;
    rowArea[j] = ((E - W) / w) * 111.32 * Math.cos((lat * Math.PI) / 180) * ((N - S) / h) * 110.57;
    for (let i = 0; i < w; i++) {
      const lon = W + ((i + 0.5) * (E - W)) / w;
      if (pointInPolygon(lon, lat, polygon)) {
        mask[j * w + i] = 1;
        aoiKm2 += rowArea[j];
        aoiPixels++;
      }
    }
  }
  return { w, h, bbox, mask, rowArea, aoiKm2, aoiPixels };
}

// ------------------------------------------------------------- classification
/** Classify RGBA pixels of a categorical / continuous / presence product. */
export function classifyPixels(rgba, grid, ds, classifier) {
  const { w, h, mask } = grid;
  const out = new Uint8Array(w * h).fill(OUT);
  const transparentLevel = ds.transparentMeans === 'none' || ds.method === 'presence' ? 0 : OUT;
  const cache = new Map();
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    const a = rgba[p * 4 + 3];
    if (a < 16) { out[p] = transparentLevel; continue; }
    if (ds.method === 'presence' || classifier.mode === 'presence-fallback') {
      out[p] = ds.presenceLevel || 2;
      continue;
    }
    const r = rgba[p * 4], g = rgba[p * 4 + 1], b = rgba[p * 4 + 2];
    const k = key(r, g, b);
    let lv = classifier.lookup.get(k);
    if (lv === undefined) {
      lv = cache.get(k);
      if (lv === undefined) { lv = nearest(classifier, r, g, b); cache.set(k, lv); }
    }
    out[p] = lv;
  }
  return out;
}

/** Radar images: brightness per pixel (−1 = no image there). */
export function luminance(rgba, grid) {
  const { w, h, mask } = grid;
  const lum = new Int16Array(w * h).fill(-1);
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || rgba[p * 4 + 3] < 16) continue;
    lum[p] = Math.round(0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2]);
  }
  return lum;
}

/** Radar darkening vs a reference image → levels 0–4. */
export function sarLevels(lumRef, lumCur, thresholds) {
  const out = new Uint8Array(lumCur.length).fill(OUT);
  const [t1, t2, t3, t4] = thresholds;
  for (let p = 0; p < lumCur.length; p++) {
    if (lumRef[p] < 0 || lumCur[p] < 0) continue;
    const d = lumRef[p] - lumCur[p];
    out[p] = d >= t4 ? 4 : d >= t3 ? 3 : d >= t2 ? 2 : d >= t1 ? 1 : 0;
  }
  return out;
}

/** Water: pixels that are water now but were dry at the first date → Severe. */
export function markNewWater(levelsRef, levelsCur) {
  const out = levelsCur.slice();
  for (let p = 0; p < out.length; p++) {
    if (out[p] >= 2 && out[p] <= 3 && levelsRef[p] === 0) out[p] = 4;
  }
  return out;
}

// ---------------------------------------------------------------------- stats
/** Area per level for one classified frame. */
export function frameStats(levels, grid) {
  const { w, h, mask, rowArea, aoiKm2 } = grid;
  const km2 = [0, 0, 0, 0, 0];
  let observed = 0, unclassified = 0;
  for (let j = 0; j < h; j++) {
    const a = rowArea[j];
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      if (!mask[p]) continue;
      const lv = levels[p];
      if (lv === OUT) continue;
      if (lv === UNCLASSIFIED) { unclassified += a; continue; }
      km2[lv] += a;
      observed += a;
    }
  }
  const affected = km2[1] + km2[2] + km2[3] + km2[4];
  return {
    km2,                                  // index 0 = observed/not present, 1..4 = levels
    affected,
    observedKm2: observed,
    observedPct: aoiKm2 ? (100 * observed) / aoiKm2 : 0,
    affectedPctOfAoi: aoiKm2 ? (100 * affected) / aoiKm2 : 0,
    unclassifiedKm2: unclassified
  };
}

/** Combine several datasets of the same phenomenon: max level per pixel + agreement. */
export function combine(levelArrays, grid) {
  const n = grid.w * grid.h;
  const merged = new Uint8Array(n).fill(OUT);
  let agreeKm2 = 0;
  for (let p = 0; p < n; p++) {
    if (!grid.mask[p]) continue;
    let best = OUT, hits = 0;
    for (const arr of levelArrays) {
      const lv = arr[p];
      if (lv === OUT || lv === UNCLASSIFIED) continue;
      if (best === OUT || lv > best) best = lv;
      if (lv >= 1) hits++;
    }
    merged[p] = best;
    if (hits >= 2) agreeKm2 += grid.rowArea[Math.floor(p / grid.w)];
  }
  return { merged, agreeKm2 };
}

/** Overall severity badge for a phenomenon: highest level covering ≥0.5 % of area or ≥0.25 km². */
export function overallLevel(stats, aoiKm2) {
  for (let lv = 4; lv >= 1; lv--) {
    const a = stats.km2[lv];
    if (a >= 0.25 || (aoiKm2 && a / aoiKm2 >= 0.005)) return lv;
  }
  return 0;
}

/** Pick n dates spread evenly through a sorted list, always keeping first and last. */
export function sampleDates(dates, n) {
  if (dates.length <= n) return dates.slice();
  const out = [];
  for (let k = 0; k < n; k++) out.push(dates[Math.round((k * (dates.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

/** Evenly spaced days between start and end (inclusive). */
export function dailyDates(start, end, n) {
  const a = Date.parse(start + 'T00:00:00Z'), b = Date.parse(end + 'T00:00:00Z');
  if (!(b >= a)) return [];
  const days = Math.round((b - a) / 86400000);
  const count = Math.min(n, days + 1);
  const out = [];
  for (let k = 0; k < count; k++) {
    const t = a + Math.round((k * days) / Math.max(count - 1, 1)) * 86400000;
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return [...new Set(out)];
}

// =============================================================================
// Surface water (floods)
// Water products are CATEGORICAL. Each pixel gets one class code:
//   OUT (255) = not a valid observation (no data, cloud, shadow, layover, mask,
//               colour not in the product's colour map, or no image at all)
//   W.* below = a valid observation
// Confidence is computed separately, per analysis, from coverage, baseline and
// agreement between independent sensors – it is never mixed into the class.
// =============================================================================
export const W = { DRY: 0, OPEN: 1, PARTIAL: 2, INUNDATED_VEG: 3, FLOOD: 4, REFERENCE: 5 };
const W_BY_NAME = { dry: W.DRY, open: W.OPEN, partial: W.PARTIAL, inundated_veg: W.INUNDATED_VEG, flood: W.FLOOD, reference: W.REFERENCE, invalid: OUT };
export const W_NAMES = ['not water', 'open water', 'partial surface water', 'inundated vegetation', 'flood (product-flagged)', 'reference / recurring water'];

export const isWaterClass = c => c >= W.OPEN && c <= W.REFERENCE;

/** Integer class code from a colour-map value such as "[1]" or "1". */
function classCode(v) {
  const m = String(v || '').trim().match(/^\[?\s*(-?\d+)\s*\]?$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Map a product's colour map to water classes.
 * codes: documented {classValue: name}; rules: [[regex, name], …] for labels.
 * Unknown classes become OUT – they are never guessed to be water.
 */
export function buildWaterClassifier(colormap, codes, rules) {
  const lookup = new Map(), info = [], palette = [];
  let transparentClass = OUT, transparentIsDry = false;
  for (const e of (colormap ? colormap.entries : [])) {
    const code = classCode(e.value);
    const byCode = code !== null && codes && code in codes ? codes[code] : null;
    const rule = rules.find(([re]) => re.test(e.label || ''));
    const byLabel = rule ? rule[1] : null;
    // value is authoritative; a label that says "invalid" (cloud, mask…) always wins
    let name = byCode || byLabel || 'invalid';
    if (byLabel === 'invalid') name = 'invalid';
    if (e.nodata) name = 'invalid';
    const cls = W_BY_NAME[name];
    info.push({ label: e.label || e.value, value: e.value, rgb: e.rgb, cls, name, transparent: e.transparent,
      mismatch: !!(byCode && byLabel && byCode !== byLabel) });
    if (e.transparent) {
      // Some visualisations draw "not water" as transparent; then empty pixels are dry,
      // but only where an acquisition exists (checked by the caller).
      if (cls === W.DRY) { transparentClass = W.DRY; transparentIsDry = true; }
      continue;
    }
    lookup.set(key(e.r, e.g, e.b), cls);
    palette.push({ r: e.r, g: e.g, b: e.b, cls });
  }
  return { lookup, info, palette, transparentClass, transparentIsDry, valid: info.some(i => i.cls !== OUT) };
}

/**
 * Strict colour lookup. GIBS resamples imagery, so edge pixels can be a blend of two
 * class colours (e.g. "not water" + "open water" ≈ "partial water"). A blended colour is
 * NOT re-labelled as the nearest class: anything that is not within a small tolerance of
 * exactly one class colour is treated as unclassified (excluded).
 */
export function matchWaterColour(clf, r, g, b, tol = 12) {
  const exact = clf.lookup.get(key(r, g, b));
  if (exact !== undefined) return exact;
  let best = null, bestD = Infinity, second = Infinity;
  for (const e of clf.palette) {
    const d = Math.max(Math.abs(e.r - r), Math.abs(e.g - g), Math.abs(e.b - b));
    if (d < bestD) { second = bestD; bestD = d; best = e; } else if (d < second) second = d;
  }
  if (!best || bestD > tol || second <= bestD + 4) return UNCLASSIFIED;
  return best.cls;
}

/** Classify a water image. `acquired`: an acquisition exists for this date (from CMR). */
export function classifyWater(rgba, grid, clf, acquired = true) {
  const { w, h, mask } = grid;
  const out = new Uint8Array(w * h).fill(OUT);
  const cache = new Map();
  for (let p = 0; p < w * h; p++) {
    if (!mask[p]) continue;
    if (rgba[p * 4 + 3] < 128) {                 // empty / semi-transparent edge
      out[p] = clf.transparentIsDry && acquired && rgba[p * 4 + 3] < 16 ? W.DRY : OUT;
      continue;
    }
    const k = key(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
    let c = cache.get(k);
    if (c === undefined) { c = matchWaterColour(clf, rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]); cache.set(k, c); }
    out[p] = c;
  }
  return out;
}

/**
 * Pre-event baseline from one or more classified observations.
 * Per pixel: 1 = water was seen, 0 = valid and always dry, 255 = never validly observed.
 */
export function waterBaseline(classArrays, n) {
  const base = new Uint8Array(n).fill(OUT);
  for (const arr of classArrays) {
    for (let p = 0; p < n; p++) {
      const c = arr[p];
      if (c === OUT || c === UNCLASSIFIED) continue;
      if (isWaterClass(c) && c !== W.FLOOD) base[p] = 1;
      else if (base[p] === OUT) base[p] = 0;
    }
  }
  return base;
}

/**
 * Per-pixel status of one observation against the baseline:
 *   0 dry · 1 normal water · 2 newly inundated · 3 water, baseline unknown · OUT invalid
 * A product-flagged flood class (MODIS "unusual flood") is new water by the product's own
 * reference; its reference/recurring class is normal water.
 */
export function waterStatus(classes, baseline) {
  const out = new Uint8Array(classes.length).fill(OUT);
  for (let p = 0; p < classes.length; p++) {
    const c = classes[p];
    if (c === OUT || c === UNCLASSIFIED) continue;
    if (!isWaterClass(c)) { out[p] = 0; continue; }
    if (c === W.FLOOD) { out[p] = 2; continue; }
    if (c === W.REFERENCE) { out[p] = 1; continue; }
    const b = baseline ? baseline[p] : OUT;
    out[p] = b === 1 ? 1 : b === 0 ? 2 : 3;
  }
  return out;
}

/** Areas (km²) for one water observation. Percentages use the VALID observed area. */
export function waterStats(classes, status, grid) {
  const { w, h, mask, rowArea, aoiKm2 } = grid;
  const s = { validKm2: 0, unclassifiedKm2: 0, dryKm2: 0, waterKm2: 0, openKm2: 0, partialKm2: 0, inundatedVegKm2: 0,
    normalKm2: 0, newKm2: 0, unknownKm2: 0, baselineKnownKm2: 0 };
  for (let j = 0; j < h; j++) {
    const a = rowArea[j];
    for (let i = 0; i < w; i++) {
      const p = j * w + i;
      if (!mask[p]) continue;
      const c = classes[p];
      if (c === UNCLASSIFIED) { s.unclassifiedKm2 += a; continue; }
      if (c === OUT) continue;
      s.validKm2 += a;
      if (c === W.OPEN || c === W.FLOOD || c === W.REFERENCE) s.openKm2 += a;
      else if (c === W.PARTIAL) s.partialKm2 += a;
      else if (c === W.INUNDATED_VEG) s.inundatedVegKm2 += a;
      else s.dryKm2 += a;
      const st = status[p];
      if (st === 1) s.normalKm2 += a;
      else if (st === 2) s.newKm2 += a;
      else if (st === 3) s.unknownKm2 += a;
      if (st !== 3) s.baselineKnownKm2 += a;
    }
  }
  s.waterKm2 = s.openKm2 + s.partialKm2 + s.inundatedVegKm2;
  s.coveragePct = aoiKm2 ? (100 * s.validKm2) / aoiKm2 : 0;
  s.newPctOfObserved = s.validKm2 ? (100 * s.newKm2) / s.validKm2 : 0;
  s.waterPctOfObserved = s.validKm2 ? (100 * s.waterKm2) / s.validKm2 : 0;
  s.baselineKnownPct = s.validKm2 ? (100 * s.baselineKnownKm2) / s.validKm2 : 0;
  s.affected = s.newKm2;                          // generic field used by chart/export
  return s;
}

/**
 * Agreement of two independent sensors on "newly inundated or not", over pixels that
 * both observed validly and whose baseline is known in both.
 */
export function waterAgreement(statusA, statusB, grid) {
  let common = 0, agree = 0, bothNew = 0, eitherNew = 0;
  for (let j = 0; j < grid.h; j++) {
    const a = grid.rowArea[j];
    for (let i = 0; i < grid.w; i++) {
      const p = j * grid.w + i;
      if (!grid.mask[p]) continue;
      const x = statusA[p], y = statusB[p];
      if (x === OUT || y === OUT || x === 3 || y === 3) continue;
      common += a;
      const nx = x === 2, ny = y === 2;
      if (nx === ny) agree += a;
      if (nx && ny) bothNew += a;
      if (nx || ny) eitherNew += a;
    }
  }
  return {
    commonKm2: common,
    commonPct: grid.aoiKm2 ? (100 * common) / grid.aoiKm2 : 0,
    agreePct: common ? (100 * agree) / common : null,
    bothNewKm2: bothNew,
    newOverlapPct: eitherNew ? (100 * bothNew) / eitherNew : null
  };
}

/**
 * Confidence of a flood result. Documented rules (also shown in the app):
 *  - Insufficient data: valid coverage < 25 % of the area, or < 25 % of the observed
 *    pixels have a known pre-event baseline.
 *  - High: coverage ≥ 70 %, baseline known for ≥ 70 %, AND a second, independent sensor
 *    observed ≥ 10 % of the area in common and agrees on ≥ 80 % of it.
 *  - Medium: coverage ≥ 50 % and baseline known for ≥ 50 %.
 *  - Low: anything else.
 *  - A second sensor that disagrees (< 60 % agreement on ≥ 10 % common area) lowers it one step.
 */
export function waterConfidence(stats, agreement) {
  const reasons = [];
  const cov = stats.coveragePct, base = stats.baselineKnownPct;
  reasons.push(`valid observations cover ${cov.toFixed(0)} % of the area`);
  reasons.push(`pre-event baseline known for ${base.toFixed(0)} % of observed pixels`);
  if (cov < 25 || base < 25) {
    reasons.push(cov < 25 ? 'too little of the area was observed' : 'no usable pre-event observation for most pixels');
    return { level: 'Insufficient data', reasons };
  }
  const second = agreement && agreement.commonPct >= 10 && agreement.agreePct !== null;
  let level = 'Low';
  if (cov >= 70 && base >= 70 && second && agreement.agreePct >= 80) level = 'High';
  else if (cov >= 50 && base >= 50) level = 'Medium';
  if (second) {
    reasons.push(`independent sensor agrees on ${agreement.agreePct.toFixed(0)} % of ${agreement.commonPct.toFixed(0)} % commonly observed area`);
    if (agreement.agreePct < 60) {
      level = level === 'High' ? 'Medium' : level === 'Medium' ? 'Low' : level;
      reasons.push('sensors disagree – confidence lowered');
    }
  } else {
    reasons.push('no second independent sensor observed the same pixels');
  }
  return { level, reasons };
}

/** Continuous product (e.g. rainfall): colour → numeric value from the colour map. */
export function buildValueClassifier(colormap) {
  const palette = [];
  for (const e of (colormap ? colormap.entries : [])) {
    if (e.transparent || e.nodata || UNOBSERVED_RE.test(e.label)) continue;
    const v = firstNumber(e.value) ?? firstNumber(e.label);
    if (v !== null) palette.push({ r: e.r, g: e.g, b: e.b, v });
  }
  return { palette };
}

/** Mean and max value inside the area (pixels with no data are skipped). */
export function valueStats(rgba, grid, clf) {
  let sum = 0, area = 0, max = null, valid = 0;
  for (let j = 0; j < grid.h; j++) {
    const a = grid.rowArea[j];
    for (let i = 0; i < grid.w; i++) {
      const p = j * grid.w + i;
      if (!grid.mask[p]) continue;
      if (rgba[p * 4 + 3] < 128) { valid += a; continue; }   // drawn transparent = no rain
      let best = null, bd = 3 * 20 * 20;
      for (const e of clf.palette) {
        const d = (e.r - rgba[p * 4]) ** 2 + (e.g - rgba[p * 4 + 1]) ** 2 + (e.b - rgba[p * 4 + 2]) ** 2;
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) continue;
      valid += a; sum += best.v * a; area += a;
      if (max === null || best.v > max) max = best.v;
    }
  }
  return { mean: valid ? sum / valid : null, max: max ?? 0, wetPct: valid ? (100 * area) / valid : 0, validKm2: valid };
}
