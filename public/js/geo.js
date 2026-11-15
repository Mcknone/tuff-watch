// =============================================================================
// Metric geometry (pure functions – no DOM, unit-tested)
//   - WGS84 ⇄ UTM (transverse Mercator, Snyder 1987 series; mm–cm accuracy in a zone)
//   - metric circles, polygon validation, metric area
// OPERA DSWx and DIST products are delivered on 30 m UTM grids (MGRS tiles), so the
// analysis is done in UTM metres rather than in degrees.
// =============================================================================

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const E4 = E2 * E2, E6 = E4 * E2;
const RAD = Math.PI / 180;

export const utmZoneOf = lon => (lon >= 180 ? 60 : Math.min(60, Math.max(1, Math.floor((((lon + 180) % 360) + 360) % 360 / 6) + 1)));
export const utmEpsg = (zone, south) => (south ? 32700 : 32600) + zone;

/** Parse an EPSG code into a CRS description understood by the sampler. */
export function crsFromEpsg(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return { type: 'utm', zone: epsg - 32600, south: false, epsg };
  if (epsg >= 32701 && epsg <= 32760) return { type: 'utm', zone: epsg - 32700, south: true, epsg };
  if (epsg === 4326) return { type: 'geographic', epsg };
  return null;
}

function meridianArc(phi) {
  return A * ((1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256) * phi
    - (3 * E2 / 8 + 3 * E4 / 32 + 45 * E6 / 1024) * Math.sin(2 * phi)
    + (15 * E4 / 256 + 45 * E6 / 1024) * Math.sin(4 * phi)
    - (35 * E6 / 3072) * Math.sin(6 * phi));
}

/** lon/lat (degrees) → UTM [x, y] metres in the given zone; also returns point scale k. */
export function toUtm(lon, lat, zone, south) {
  const phi = lat * RAD, lam = lon * RAD, lam0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = c * (lam - lam0);
  const M = meridianArc(phi);
  const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
  let y = K0 * (M + N * t * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  if (south) y += 10000000;
  const k = K0 * (1 + (1 + C) * Aa * Aa / 2 + (5 - 4 * T + 42 * C + 13 * C * C - 28 * EP2) * Aa ** 4 / 24);
  return [x, y, k];
}

/** UTM metres → [lon, lat] degrees. */
export function fromUtm(x, y, zone, south) {
  const xs = x - 500000, ys = south ? y - 10000000 : y;
  const M = ys / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c;
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5), D = xs / (N1 * K0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = ((zone - 1) * 6 - 180 + 3) * RAD + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lon / RAD, lat / RAD];
}

/** Great-circle distance in metres (for checks and messages). */
export function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, dl = (lat2 - lat1) * RAD, dn = (lon2 - lon1) * RAD;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Circle of `radiusKm` around (lon, lat), built in metres in the local UTM zone and
 * converted back to lon/lat (so the radius is metric everywhere, not a degree offset).
 */
export function metricCircle(lon, lat, radiusKm, n = 72) {
  const zone = utmZoneOf(lon), south = lat < 0;
  const [cx, cy, k] = toUtm(lon, lat, zone, south);
  const r = radiusKm * 1000 * k;               // grid distance = ground distance × scale factor
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push(fromUtm(cx + r * Math.cos(a), cy + r * Math.sin(a), zone, south));
  }
  out[n] = out[0];
  return out;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Does a closed ring cross itself? (ring: [[x,y],…,first]) */
export function selfIntersects(ring) {
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;   // adjacent edges share a vertex
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

/** Area of a lon/lat ring in km², computed in metres in the ring's UTM zone. */
export function ringAreaKm2(ring) {
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length, lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const zone = utmZoneOf(lon0), south = lat0 < 0;
  const pts = ring.map(([lo, la]) => toUtm(lo, la, zone, south));
  const kc = toUtm(lon0, lat0, zone, south)[2];
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return Math.abs(a / 2) / (kc * kc) / 1e6;
}

/**
 * Metric analysis grid over an AOI polygon (lon/lat ring), in the AOI's UTM zone.
 * Cells are aligned to multiples of `cell` metres – the same alignment as OPERA's 30 m
 * MGRS tiles – so nearest-neighbour sampling reads native pixels without shifting them.
 * The grid has the same interface as classify.makeGrid (w, h, mask, rowArea, aoiKm2…).
 */
export function makeMetricGrid(ring, { cell = 30, maxCells = 4e6 } = {}) {
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length, lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const zone = utmZoneOf(lon0), south = lat0 < 0;
  const poly = ring.map(([lo, la]) => toUtm(lo, la, zone, south));
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  let size = cell;
  const span = () => [Math.floor(Math.min(...xs) / size) * size, Math.ceil(Math.max(...xs) / size) * size,
    Math.floor(Math.min(...ys) / size) * size, Math.ceil(Math.max(...ys) / size) * size];
  let [x0, x1, y0, y1] = span();
  const cells0 = ((x1 - x0) / cell) * ((y1 - y0) / cell);
  if (cells0 > maxCells) {                      // very large AOI: sample on a coarser multiple of 30 m
    size = cell * Math.ceil(Math.sqrt(cells0 / maxCells));
    [x0, x1, y0, y1] = span();
  }
  const w = Math.round((x1 - x0) / size), h = Math.round((y1 - y0) / size);
  const mask = new Uint8Array(w * h);
  // scanline fill: for each row centre, find polygon edge crossings
  let aoiPixels = 0;
  for (let j = 0; j < h; j++) {
    const yc = y1 - (j + 0.5) * size;
    const xsCross = [];
    for (let i = 0; i < poly.length - 1; i++) {
      const [xa, ya] = poly[i], [xb, yb] = poly[i + 1];
      if ((ya > yc) !== (yb > yc)) xsCross.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
    }
    xsCross.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xsCross.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xsCross[k] - x0) / size - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xsCross[k + 1] - x0) / size - 0.5));
      for (let i = i0; i <= i1; i++) { mask[j * w + i] = 1; aoiPixels++; }
    }
  }
  const kc = toUtm(lon0, lat0, zone, south)[2];
  const cellKm2 = (size / kc) ** 2 / 1e6;      // ground area of one cell
  const rowArea = new Float64Array(h).fill(cellKm2);
  const corners = [[x0, y1], [x1, y1], [x1, y0], [x0, y0]].map(([x, y]) => fromUtm(x, y, zone, south));
  const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  return {
    kind: 'metric', w, h, mask, rowArea, aoiPixels, aoiKm2: aoiPixels * cellKm2,
    cell: size, native: size === cell, zone, south, epsg: utmEpsg(zone, south),
    x0, y1, corners, bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
  };
}
