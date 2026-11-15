// =============================================================================
// NASA data access (through the Cloudflare Worker at /api/*)
// =============================================================================

/** Run async jobs with at most `n` at a time. */
export function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

async function errorText(res) {
  try { const j = await res.json(); return j.error || `HTTP ${res.status}`; }
  catch { return `HTTP ${res.status}`; }
}

/** Real acquisitions over the area from NASA CMR. bbox = [W,S,E,N] */
export async function fetchCmr(shortName, bbox, start, end) {
  const q = new URLSearchParams({ short_name: shortName, bbox: bbox.map(v => v.toFixed(5)).join(','), start, end });
  const res = await fetch(`/api/cmr/granules?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  return res.json();
}

/** GIBS colour map XML text, or null if NASA has none for this layer. */
export async function fetchColormapXml(layer) {
  const res = await fetch(`/api/gibs/colormap/${encodeURIComponent(layer)}.xml`);
  if (!res.ok) return null;
  return res.text();
}

/** Download one GIBS image for the analysis grid and return its RGBA pixels. */
export async function fetchPixels(layer, date, grid) {
  const [W, S, E, N] = grid.bbox;
  const q = new URLSearchParams({
    proj: '4326', LAYERS: layer, TIME: date,
    BBOX: [S, W, N, E].map(v => v.toFixed(6)).join(','),   // WMS 1.3.0 + EPSG:4326 = lat,lon order
    WIDTH: String(grid.w), HEIGHT: String(grid.h)
  });
  const res = await fetch(`/api/gibs/wms?${q}`);
  if (!res.ok) throw new Error(await errorText(res));
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(grid.w, grid.h)
    : Object.assign(document.createElement('canvas'), { width: grid.w, height: grid.h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, grid.w, grid.h);
  ctx.drawImage(bmp, 0, 0, grid.w, grid.h);
  if (bmp.close) bmp.close();
  return ctx.getImageData(0, 0, grid.w, grid.h).data;
}

/** Share of the area where NASA's image has any pixels (0–1). */
export function imageCoverage(rgba, grid) {
  let n = 0;
  for (let p = 0; p < grid.w * grid.h; p++) if (grid.mask[p] && rgba[p * 4 + 3] >= 16) n++;
  return grid.aoiPixels ? n / grid.aoiPixels : 0;
}

/** Map tile URL template (MapLibre fills in {bbox-epsg-3857}). */
export function tileUrl(layer, date) {
  const t = date ? `&TIME=${date}` : '';
  return `${location.origin}/api/gibs/wms?proj=3857&LAYERS=${encodeURIComponent(layer)}${t}` +
         `&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256`;
}

export function earthdataSearchUrl(shortName) {
  return `https://search.earthdata.nasa.gov/search?q=${encodeURIComponent(shortName.replace(/\*/g, ' ').trim())}`;
}

export function worldviewUrl(layer, date, bbox) {
  const v = bbox.map(x => x.toFixed(4)).join(',');
  return `https://worldview.earthdata.nasa.gov/?v=${v}&l=${encodeURIComponent(layer)}&t=${date || ''}`;
}

// ---------------------------------------------------------------- numerical rasters
/** A failed data request. kind: retrieval | auth | auth-config | timeout | malformed | missing-band | processing */
export class DataError extends Error {
  constructor(message, kind = 'retrieval') { super(message); this.kind = kind; }
}

/** CMR granules over the area with download links for the requested bands. */
export async function fetchGranules(shortName, bbox, start, end, bands) {
  const q = new URLSearchParams({ short_name: shortName, bbox: bbox.map(v => v.toFixed(5)).join(','), start, end, bands: bands.join(',') });
  let res;
  try { res = await fetch(`/api/cmr/granules?${q}`); }
  catch (e) { throw new DataError(`NASA catalogue (CMR) unreachable: ${e.message}`, 'retrieval'); }
  if (!res.ok) throw new DataError(`NASA catalogue (CMR) search failed: ${await errorText(res)}`, 'retrieval');
  return res.json();
}

export const dataUrl = url => `/api/data?url=${encodeURIComponent(url)}`;

/** Reject after ms with a timeout DataError. */
export function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new DataError(`${what} timed out after ${ms / 1000} s`, 'timeout')), ms); })
  ]);
}

/**
 * Open a NASA GeoTIFF through the server relay (HTTP range requests). A first small
 * range read surfaces authentication / HTTP errors as DataError instead of a broken parse.
 */
export async function openRemoteTiff(url) {
  let probe;
  try { probe = await withTimeout(fetch(dataUrl(url), { headers: { Range: 'bytes=0-1023' } }), 45000, 'NASA data request'); }
  catch (e) { if (e instanceof DataError) throw e; throw new DataError(`NASA data request failed: ${e.message}`, 'retrieval'); }
  if (!probe.ok) {
    let body = {};
    try { body = await probe.json(); } catch { /* not JSON */ }
    throw new DataError(body.error || `NASA data request HTTP ${probe.status}`, body.kind || 'retrieval');
  }
  const head = new Uint8Array(await probe.arrayBuffer());
  const magic = head.length >= 4 && ((head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d));
  if (!magic) throw new DataError('the file returned by NASA is not a GeoTIFF', 'malformed');
  if (typeof GeoTIFF === 'undefined') throw new DataError('GeoTIFF reader library not loaded', 'processing');
  try {
    return await withTimeout(GeoTIFF.fromUrl(dataUrl(url), { allowFullFile: false, cacheSize: 200 }), 45000, 'Opening the GeoTIFF');
  } catch (e) {
    if (e instanceof DataError) throw e;
    throw new DataError(`could not read the GeoTIFF: ${e.message}`, 'malformed');
  }
}
