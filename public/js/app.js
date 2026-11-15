// =============================================================================
// Earth Surface Change Monitor – main app
// =============================================================================
import { PHENOMENA, LEVELS, DATASETS, CONTEXT_LAYERS, EXAMPLES } from './config.js';
import {
  OUT, parseColormap, buildClassifier, makeGrid, classifyPixels, luminance, sarLevels,
  markNewWater, frameStats, combine, overallLevel, sampleDates, dailyDates
} from './classify.js';
import {
  limiter, fetchCmr, fetchColormapXml, fetchPixels, imageCoverage, tileUrl,
  earthdataSearchUrl, worldviewUrl
} from './nasa.js';

const $ = sel => document.querySelector(sel);
const fmtKm = v => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  aoi: null,            // { polygon, bbox, kind }
  results: null,        // analysis output
  dates: [],            // union of analysed dates
  dateIdx: 0,
  view: 'classified',
  shown: new Set(),     // dataset ids shown in "NASA original" view
  timer: null,
  chart: null
};

// ============================================================ map set-up
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        attribution: '© OpenStreetMap contributors'
      },
      esri: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
      }
    },
    layers: [
      { id: 'base-osm', type: 'raster', source: 'osm' },
      { id: 'base-esri', type: 'raster', source: 'esri', layout: { visibility: 'none' } }
    ]
  },
  center: [10, 15],
  zoom: 1.6,
  attributionControl: { compact: true, customAttribution: 'Science data: NASA GIBS / CMR' }
});
map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const mapReady = new Promise(resolve => map.on('load', resolve));

mapReady.then(() => {
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('aoi', { type: 'geojson', data: empty });
  map.addLayer({ id: 'mask-fill', type: 'fill', source: 'mask', paint: { 'fill-color': '#0b1d33', 'fill-opacity': 0.45 } });
  map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#ff7a00', 'line-width': 3 } });
  map.addLayer({ id: 'aoi-pts', type: 'circle', source: 'aoi', filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#ff7a00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  updateAoi(true);
});

map.on('click', e => {
  if (!$('#pick-mode').checked) return;
  const rows = [...document.querySelectorAll('#coord-body tr')];
  const empty = rows.find(r => !r.querySelector('.lat').value && !r.querySelector('.lon').value);
  if (empty) {
    empty.querySelector('.lat').value = e.lngLat.lat.toFixed(5);
    empty.querySelector('.lon').value = e.lngLat.lng.toFixed(5);
  } else {
    addRow(e.lngLat.lat.toFixed(5), e.lngLat.lng.toFixed(5));
  }
  updateAoi(false);
});

$('#basemap').addEventListener('change', e => {
  map.setLayoutProperty('base-osm', 'visibility', e.target.value === 'osm' ? 'visible' : 'none');
  map.setLayoutProperty('base-esri', 'visibility', e.target.value === 'esri' ? 'visible' : 'none');
});

// ============================================================ coordinate table
function addRow(lat = '', lon = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td></td>
    <td><input class="lat" type="number" step="any" placeholder="-8.30" value="${esc(lat)}"></td>
    <td><input class="lon" type="number" step="any" placeholder="140.40" value="${esc(lon)}"></td>
    <td><button type="button" title="Remove point">✕</button></td>`;
  tr.querySelectorAll('input').forEach(i => i.addEventListener('change', () => updateAoi(false)));
  tr.querySelector('button').addEventListener('click', () => { tr.remove(); renumber(); updateAoi(false); });
  $('#coord-body').appendChild(tr);
  renumber();
}
function renumber() {
  document.querySelectorAll('#coord-body tr').forEach((tr, i) => { tr.firstElementChild.textContent = i + 1; });
}

function readPoints() {
  const pts = [], errors = [];
  document.querySelectorAll('#coord-body tr').forEach((tr, i) => {
    const latI = tr.querySelector('.lat'), lonI = tr.querySelector('.lon');
    latI.classList.remove('invalid'); lonI.classList.remove('invalid');
    if (latI.value === '' && lonI.value === '') return;
    const lat = parseFloat(latI.value), lon = parseFloat(lonI.value);
    if (!(lat >= -90 && lat <= 90)) { latI.classList.add('invalid'); errors.push(`Row ${i + 1}: latitude must be between −90 and 90`); return; }
    if (!(lon >= -180 && lon <= 180)) { lonI.classList.add('invalid'); errors.push(`Row ${i + 1}: longitude must be between −180 and 180`); return; }
    pts.push([lon, lat]);
  });
  return { pts, errors };
}

function buildAoi() {
  const { pts, errors } = readPoints();
  if (errors.length) return { error: errors.join('\n') };
  if (!pts.length) return { error: 'Add at least one coordinate.' };
  let polygon, kind;
  if (pts.length === 1) {
    const km = parseFloat($('#radius').value);
    if (!(km > 0)) return { error: 'Radius must be a positive number of km.' };
    const [lon, lat] = pts[0];
    polygon = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * 2 * Math.PI;
      polygon.push([lon + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
    }
    kind = `circle, ${km} km radius`;
  } else if (pts.length === 2) {
    const [a, b] = pts;
    if (Math.abs(a[0] - b[0]) > 180) return { error: 'This rectangle crosses the 180° line – please split it.' };
    const W = Math.min(a[0], b[0]), E = Math.max(a[0], b[0]), S = Math.min(a[1], b[1]), N = Math.max(a[1], b[1]);
    if (W === E || S === N) return { error: 'The two corners must differ in both latitude and longitude.' };
    polygon = [[W, S], [E, S], [E, N], [W, N], [W, S]];
    kind = 'rectangle';
  } else {
    polygon = [...pts, pts[0]];
    kind = `polygon, ${pts.length} corners`;
  }
  const lons = polygon.map(p => p[0]), lats = polygon.map(p => p[1]);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  if (bbox[2] - bbox[0] > 180) return { error: 'The area crosses the 180° line – please split it.' };
  return { polygon, bbox, kind, points: pts };
}

function approxAreaKm2(poly) {
  const lat0 = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  let a = 0;
  for (let i = 0; i < poly.length - 1; i++) a += poly[i][0] * kx * poly[i + 1][1] * ky - poly[i + 1][0] * kx * poly[i][1] * ky;
  return Math.abs(a / 2);
}

async function updateAoi(fit) {
  const info = $('#aoi-info');
  const aoi = buildAoi();
  await mapReady;
  if (aoi.error) {
    info.className = 'aoi-info err';
    info.textContent = aoi.error;
    state.aoi = null;
    map.getSource('aoi').setData({ type: 'FeatureCollection', features: [] });
    map.getSource('mask').setData({ type: 'FeatureCollection', features: [] });
    return;
  }
  state.aoi = aoi;
  const area = approxAreaKm2(aoi.polygon);
  info.className = 'aoi-info' + (area > 20000 ? ' warn' : '');
  info.textContent = `Area: ${area.toLocaleString(undefined, { maximumFractionDigits: 1 })} km² (${aoi.kind})` +
    (area > 20000 ? ' — large area: detail will be coarse; consider a smaller area.' : '');
  map.getSource('aoi').setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [aoi.polygon] }, properties: {} },
      ...aoi.points.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }))
    ]
  });
  map.getSource('mask').setData({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], [...aoi.polygon].reverse()] },
    properties: {}
  });
  if (fit !== false) map.fitBounds([[aoi.bbox[0], aoi.bbox[1]], [aoi.bbox[2], aoi.bbox[3]]], { padding: 60, duration: 600 });
}

$('#add-row').addEventListener('click', () => addRow());
$('#clear-rows').addEventListener('click', () => { $('#coord-body').innerHTML = ''; addRow(); updateAoi(false); });
$('#radius').addEventListener('change', () => updateAoi(false));

// ============================================================ phenomena + examples
function renderPhenomenaPicker(selected) {
  $('#phenomena').innerHTML = Object.entries(PHENOMENA).map(([id, p]) => {
    const ds = DATASETS.filter(d => d.phenomenon === id);
    const kinds = [...new Set(ds.map(d => d.kind))].join(' + ');
    return `<label class="phen" style="--c:${p.ramp[2]}">
      <input type="checkbox" value="${id}" ${selected.includes(id) ? 'checked' : ''}>
      <span class="ramp">${p.ramp.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      <span>${p.icon} ${p.name}<small>${ds.length} NASA datasets · ${kinds}</small></span>
    </label>`;
  }).join('');
}
const selectedPhenomena = () => [...document.querySelectorAll('#phenomena input:checked')].map(i => i.value);

EXAMPLES.forEach((ex, i) => $('#examples').insertAdjacentHTML('beforeend', `<option value="${i}">${esc(ex.name)}</option>`));
$('#examples').addEventListener('change', e => {
  if (e.target.value === '') return;
  loadExample(EXAMPLES[+e.target.value]);
});
function loadExample(ex) {
  $('#coord-body').innerHTML = '';
  ex.rows.forEach(([lat, lon]) => addRow(lat, lon));
  if (ex.radiusKm) $('#radius').value = ex.radiusKm;
  $('#start').value = ex.start;
  $('#end').value = ex.end;
  renderPhenomenaPicker(ex.phenomena);
  updateAoi(true);
}

CONTEXT_LAYERS.forEach(c => $('#context').insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.name)}</option>`));
$('#context').addEventListener('change', () => renderMapLayers());

// ============================================================ analysis
function setStatus(msg, isErr) { const s = $('#status'); s.textContent = msg; s.className = 'status' + (isErr ? ' err' : ''); }
function setProgress(f) { $('#progress-bar').style.width = `${Math.round(f * 100)}%`; }

$('#analyze').addEventListener('click', analyze);

async function analyze() {
  await updateAoi(false);
  if (!state.aoi) { setStatus('Fix the area of interest first.', true); return; }
  const phen = selectedPhenomena();
  if (!phen.length) { setStatus('Choose at least one phenomenon.', true); return; }
  const start = $('#start').value, end = $('#end').value;
  if (!start || !end) { setStatus('Choose a start and end date.', true); return; }
  if (start > end) { setStatus('The start date must be before the end date.', true); return; }
  if (start > today()) { setStatus('The start date is in the future.', true); return; }
  const endUse = end > today() ? today() : end;
  const n = parseInt($('#samples').value, 10);
  const detail = parseInt($('#detail').value, 10);

  stopPlay();
  $('#analyze').disabled = true;
  setProgress(0.02);
  setStatus('Building analysis grid…');
  const grid = makeGrid(state.aoi.polygon, state.aoi.bbox, detail);
  const datasets = DATASETS.filter(d => phen.includes(d.phenomenon));
  const results = { grid, start, end: endUse, phen, aoi: state.aoi, byId: new Map(), started: new Date().toISOString() };
  state.results = results;
  state.shown = new Set(phen.map(p => DATASETS.find(d => d.phenomenon === p).id));
  datasets.forEach(ds => results.byId.set(ds.id, { ds, status: 'queued', frames: [], errors: [] }));
  showTab('sources');
  renderSources();

  let done = 0;
  const total = datasets.length * (n + 2);
  const tick = () => { done++; setProgress(Math.min(0.98, done / total)); };
  const dsLimit = limiter(3), imgLimit = limiter(4);

  setStatus(`Searching NASA's catalogue for ${datasets.length} datasets…`);
  await Promise.all(datasets.map(ds => dsLimit(() => runDataset(ds, results, n, imgLimit, tick))));

  const live = [...results.byId.values()].filter(r => r.status === 'live');
  state.dates = [...new Set(live.flatMap(r => r.frames.filter(f => f.stats).map(f => f.date)))].sort();
  state.dateIdx = Math.max(0, state.dates.length - 1);
  setProgress(1);
  $('#analyze').disabled = false;
  $('#live-pill').className = 'live-pill ' + (live.length ? 'on' : 'err');

  if (!live.length) {
    setStatus('No NASA imagery could be read for this area and period. Check the Data sources tab for details, or try a wider period.', true);
    renderSources();
    return;
  }
  const failed = results.byId.size - live.length;
  setStatus(`Done: ${live.length} of ${results.byId.size} datasets returned real NASA data` +
    (failed ? ` (${failed} without usable imagery – see Data sources).` : '.') +
    `\nAnalysed ${state.dates.length} dates between ${state.dates[0]} and ${state.dates.at(-1)}.`);
  $('#export-csv').disabled = $('#export-json').disabled = false;
  buildTimeline();
  showTab('findings');
  selectDate(state.dateIdx);
}

async function runDataset(ds, results, n, imgLimit, tick) {
  const r = results.byId.get(ds.id);
  const { grid, start, end } = results;
  try {
    // 1. Real acquisitions from NASA CMR
    r.status = 'searching'; renderSources();
    try {
      r.cmr = await fetchCmr(ds.cmr, grid.bbox, start, end);
    } catch (e) {
      r.errors.push(`NASA catalogue (CMR) search failed: ${e.message}`);
    }
    tick();
    let dates;
    if (ds.dates === 'granules') {
      dates = r.cmr ? r.cmr.dates : dailyDates(start, end, n);
      if (r.cmr && !dates.length) {
        r.status = 'no-data';
        r.errors.push('NASA has no acquisitions of this product over your area in this period.');
        renderSources();
        return;
      }
    } else {
      dates = dailyDates(start, end, n);
    }
    r.acqDates = ds.dates === 'granules' && r.cmr ? r.cmr.dates : dates;
    const picked = sampleDates(dates, n);

    // 2. NASA colour map → classifier
    if (ds.method === 'classes' || ds.method === 'continuous') {
      const xml = await fetchColormapXml(ds.gibs).catch(() => null);
      r.colormap = parseColormap(xml);
      if (!r.colormap) r.errors.push('NASA colour map not available – any coloured pixel counts as "detected" (intensity unknown).');
    }
    r.classifier = buildClassifier(ds, r.colormap);
    r.units = r.colormap ? r.colormap.units : '';
    tick();

    // 3. Images for each date
    r.status = 'loading'; renderSources();
    const frames = await Promise.all(picked.map(date => imgLimit(async () => {
      try {
        const rgba = await fetchPixels(ds.gibs, date, grid);
        const coverage = imageCoverage(rgba, grid);
        if (ds.method === 'sar') return { date, coverage, lum: luminance(rgba, grid) };
        return { date, coverage, levels: classifyPixels(rgba, grid, ds, r.classifier) };
      } catch (e) {
        return { date, error: e.message };
      } finally { tick(); }
    })));
    frames.sort((a, b) => a.date.localeCompare(b.date));

    // 4. Post-processing
    if (ds.method === 'sar') {
      const usable = frames.filter(f => !f.error && f.coverage >= 0.05);
      if (usable.length) {
        const ref = usable[0];
        r.reference = ref.date;
        for (const f of usable) {
          f.levels = sarLevels(ref.lum, f.lum, ds.sarThresholds);
          let s = 0, c = 0;
          for (const v of f.lum) if (v >= 0) { s += v; c++; }
          f.meanLum = c ? s / c : null;
        }
      }
      frames.filter(f => !f.error && f.coverage < 0.05).forEach(f => { f.error = 'radar image does not cover the area'; });
    } else if (ds.newWaterSevere) {
      const ref = frames.find(f => !f.error && f.coverage >= 0.3);
      if (ref) {
        r.reference = ref.date;
        for (const f of frames) if (!f.error && f.date > ref.date) f.levels = markNewWater(ref.levels, f.levels);
      }
    }
    for (const f of frames) if (f.levels) f.stats = frameStats(f.levels, grid);
    r.frames = frames;
    const ok = frames.filter(f => f.stats);
    r.status = ok.length ? 'live' : 'failed';
    if (!ok.length) {
      const first = frames.find(f => f.error);
      r.errors.push(`No usable NASA images (${first ? first.error : 'empty images'}).`);
    }
  } catch (e) {
    r.status = 'failed';
    r.errors.push(e.message);
  }
  renderSources();
}

// ============================================================ summaries
function frameAt(r, date) {
  const ok = r.frames.filter(f => f.stats);
  if (!ok.length) return null;
  let best = ok[0];
  for (const f of ok) if (f.date <= date) best = f;
  return best;
}
const firstFrame = r => r.frames.find(f => f.stats) || null;
const liveResults = () => (state.results ? [...state.results.byId.values()].filter(r => r.status === 'live') : []);

function summarize(pid, date) {
  const grid = state.results.grid;
  const rs = liveResults().filter(r => r.ds.phenomenon === pid);
  if (!rs.length) return null;
  const frames = rs.map(r => frameAt(r, date));
  const { merged, agreeKm2 } = combine(frames.map(f => f.levels), grid);
  const stats = frameStats(merged, grid);
  const firstStats = frameStats(combine(rs.map(r => firstFrame(r).levels), grid).merged, grid);
  return {
    pid, rs, frames, merged, agreeKm2, stats,
    firstDate: rs.map(r => firstFrame(r).date).sort()[0],
    trend: stats.affected - firstStats.affected,
    level: overallLevel(stats, grid.aoiKm2)
  };
}

// ============================================================ timeline
function buildTimeline() {
  const slider = $('#slider');
  slider.min = 0;
  slider.max = Math.max(0, state.dates.length - 1);
  slider.value = state.dateIdx;
  slider.disabled = state.dates.length < 2;
  $('#play').disabled = state.dates.length < 2;
  drawTimelineSvg();
  buildChart();
}

$('#slider').addEventListener('input', e => selectDate(+e.target.value));
$('#play').addEventListener('click', () => (state.timer ? stopPlay() : startPlay()));
function startPlay() {
  $('#play').textContent = '⏸';
  if (state.dateIdx >= state.dates.length - 1) selectDate(0);
  state.timer = setInterval(() => {
    if (state.dateIdx >= state.dates.length - 1) { stopPlay(); return; }
    selectDate(state.dateIdx + 1);
  }, 1400);
}
function stopPlay() { clearInterval(state.timer); state.timer = null; $('#play').textContent = '▶'; }

function selectDate(idx) {
  if (!state.dates.length) return;
  state.dateIdx = Math.max(0, Math.min(idx, state.dates.length - 1));
  const date = state.dates[state.dateIdx];
  $('#slider').value = state.dateIdx;
  $('#tl-date').textContent = date;
  const imaged = liveResults().filter(r => r.frames.some(f => f.stats && f.date === date)).map(r => r.ds.name);
  $('#tl-sub').textContent = imaged.length ? `New images: ${imaged.join(', ')}` : 'Showing the latest image of each dataset';
  drawTimelineSvg();
  if (state.chart) state.chart.update('none');
  renderFindings();
  renderSources();
  renderMapLayers();
  renderLegend();
}

function drawTimelineSvg() {
  const svg = $('#tl-svg');
  const res = state.results;
  if (!res) { svg.innerHTML = ''; return; }
  const W = svg.clientWidth || 600, H = svg.clientHeight || 200;
  const rows = [...res.byId.values()];
  const left = 150, right = 12, top = 22, rowH = Math.min(26, (H - top - 8) / Math.max(rows.length, 1));
  const t0 = Date.parse(res.start), t1 = Date.parse(res.end) + 86400000;
  const x = d => left + ((Date.parse(d) - t0) / (t1 - t0)) * (W - left - right);
  let s = '';
  // month ticks
  const d = new Date(res.start + 'T00:00:00Z'); d.setUTCDate(1);
  const pxPerMonth = (W - left - right) / Math.max((t1 - t0) / (30.44 * 86400000), 0.01);
  const stepMonths = [1, 2, 3, 6, 12, 24].find(m => m * pxPerMonth >= 44) || 24;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  while (d.getTime() <= t1) {
    if (d.getTime() >= t0) {
      const xx = x(d.toISOString().slice(0, 10));
      const lbl = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
      s += `<line x1="${xx}" x2="${xx}" y1="${top - 4}" y2="${H}" stroke="#eef1f5"/>` +
           `<text x="${xx + 2}" y="12" font-size="10" fill="#5b6676">${lbl}</text>`;
    }
    d.setUTCMonth(d.getUTCMonth() + stepMonths);
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    const ramp = PHENOMENA[r.ds.phenomenon].ramp;
    s += `<text x="6" y="${y + 4}" font-size="11" fill="#17202c">${esc(r.ds.name.replace(/^OPERA /, ''))}</text>`;
    s += `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" stroke="#dde2ea"/>`;
    (r.acqDates || []).forEach(a => {
      const xx = x(a);
      s += `<line x1="${xx}" x2="${xx}" y1="${y - 5}" y2="${y + 5}" stroke="${ramp[1]}" stroke-opacity=".55"/>`;
    });
    r.frames.forEach(f => {
      const xx = x(f.date);
      if (f.error || !f.stats) {
        s += `<text x="${xx - 3}" y="${y + 4}" font-size="10" fill="#c0392b"><title>${esc(f.date)}: ${esc(f.error || 'no data')}</title>×</text>`;
      } else {
        const lv = overallLevel(f.stats, res.grid.aoiKm2);
        const fill = lv ? ramp[lv - 1] : '#ffffff';
        s += `<circle cx="${xx}" cy="${y}" r="5" fill="${fill}" stroke="${ramp[3]}" stroke-width="1.5">` +
             `<title>${esc(r.ds.name)} · ${f.date}\n${fmtKm(f.stats.affected)} km² detected (${LEVELS[lv - 1]?.name || 'none'})</title></circle>`;
      }
    });
    if (r.status !== 'live') {
      s += `<text x="${left + 6}" y="${y + 3}" font-size="10" fill="#c0392b" paint-order="stroke" stroke="#fff" stroke-width="3">${r.status === 'no-data' ? 'no NASA acquisitions in this period' : r.status === 'failed' ? 'no usable images' : r.status + '…'}</text>`;
    }
  });
  if (state.dates.length) {
    const xx = x(state.dates[state.dateIdx]);
    s += `<line x1="${xx}" x2="${xx}" y1="${top - 6}" y2="${H}" stroke="#0b5cad" stroke-width="2"/>`;
  }
  s += `<text x="6" y="${H - 4}" font-size="9" fill="#5b6676">thin ticks = NASA acquisitions · circles = analysed (colour = intensity) · × = no image</text>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
  svg.onclick = ev => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - left) / (W - left - right)) * (t1 - t0);
    let best = 0, bd = Infinity;
    state.dates.forEach((dd, i) => { const dt = Math.abs(Date.parse(dd) - t); if (dt < bd) { bd = dt; best = i; } });
    selectDate(best);
  };
}
window.addEventListener('resize', () => drawTimelineSvg());

function buildChart() {
  if (state.chart) state.chart.destroy();
  const labels = state.dates;
  const cursor = {
    id: 'cursor',
    afterDraw(chart) {
      const xs = chart.scales.x;
      if (!xs || !labels.length) return;
      const xx = xs.getPixelForValue(state.dateIdx);
      const c = chart.ctx;
      c.save(); c.strokeStyle = '#0b5cad'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(xx, chart.chartArea.top); c.lineTo(xx, chart.chartArea.bottom); c.stroke(); c.restore();
    }
  };
  const datasets = liveResults().map(r => {
    const ramp = PHENOMENA[r.ds.phenomenon].ramp;
    return {
      label: `${r.ds.name} (${r.ds.kind})`,
      data: labels.map(d => { const f = r.frames.find(ff => ff.stats && ff.date === d); return f ? +f.stats.affected.toFixed(3) : null; }),
      borderColor: ramp[2], backgroundColor: ramp[2],
      borderDash: r.ds.kind === 'SAR' ? [6, 4] : [],
      spanGaps: true, tension: 0.25, pointRadius: 3
    };
  });
  state.chart = new Chart($('#chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } },
        title: { display: true, text: 'Area detected per dataset (km²)', font: { size: 11 } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y} km²` } }
      },
      scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 }, maxRotation: 0, autoSkip: true } } },
      onClick: (e, els, chart) => {
        const idx = chart.scales.x.getValueForPixel(e.x);
        if (Number.isFinite(idx)) selectDate(Math.round(idx));
      }
    },
    plugins: [cursor]
  });
}

// ============================================================ map layers
const MAP_LAYER_IDS = new Set();
function removeDynamicLayers() {
  for (const id of MAP_LAYER_IDS) {
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  }
  MAP_LAYER_IDS.clear();
}
function addRaster(id, tiles, opacity) {
  map.addSource(id, { type: 'raster', tiles: [tiles], tileSize: 256, attribution: 'NASA GIBS' });
  map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': opacity } }, 'mask-fill');
  MAP_LAYER_IDS.add(id);
}

async function renderMapLayers() {
  await mapReady;
  removeDynamicLayers();
  const date = state.dates[state.dateIdx];
  const ctxId = $('#context').value;
  if (ctxId) {
    const c = CONTEXT_LAYERS.find(cc => cc.id === ctxId);
    addRaster('ctx-' + c.id, tileUrl(c.gibs, date || $('#end').value || today()), 1);
  }
  if (!state.results || !date) return;
  if (state.view === 'original') {
    for (const r of liveResults()) {
      if (!state.shown.has(r.ds.id)) continue;
      const f = frameAt(r, date);
      if (f) addRaster('gibs-' + r.ds.id, tileUrl(r.ds.gibs, f.date), 0.9);
    }
  } else {
    const url = classifiedImage(date);
    if (url) {
      const [W, S, E, N] = state.results.grid.bbox;
      map.addSource('classified', { type: 'image', url, coordinates: [[W, N], [E, N], [E, S], [W, S]] });
      map.addLayer({ id: 'classified', type: 'raster', source: 'classified', paint: { 'raster-opacity': 0.9, 'raster-resampling': 'nearest' } }, 'mask-fill');
      MAP_LAYER_IDS.add('classified');
    }
  }
}

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function classifiedImage(date) {
  const grid = state.results.grid;
  const canvas = document.createElement('canvas');
  canvas.width = grid.w; canvas.height = grid.h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(grid.w, grid.h);
  const order = state.results.phen.slice().sort((a, b) => PHENOMENA[a].priority - PHENOMENA[b].priority);
  let any = false;
  for (const pid of order) {
    const sum = summarize(pid, date);
    if (!sum) continue;
    const ramp = PHENOMENA[pid].ramp.map(hexToRgb);
    const m = sum.merged;
    for (let p = 0; p < m.length; p++) {
      const lv = m[p];
      if (lv >= 1 && lv <= 4) {
        const [r, g, b] = ramp[lv - 1];
        img.data[p * 4] = r; img.data[p * 4 + 1] = g; img.data[p * 4 + 2] = b; img.data[p * 4 + 3] = 235;
        any = true;
      }
    }
  }
  if (!any) return null;
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
  state.view = b.dataset.view;
  renderMapLayers();
  renderLegend();
}));

function renderLegend() {
  const el = $('#legend');
  const phen = state.results ? state.results.phen : selectedPhenomena();
  if (state.view === 'original') {
    el.innerHTML = state.results
      ? `<h4>NASA original colours</h4><div class="lg-note">Showing NASA's own visualisation for the datasets ticked in “Data sources”. Switch to <b>Classified intensity</b> for this app's unified colours.</div>`
      : '';
    return;
  }
  el.innerHTML = `<h4>Phenomenon · intensity</h4>
    <div class="lg-head"><span></span>${LEVELS.map(l => `<span>${l.name}</span>`).join('')}</div>
    ${phen.map(pid => {
      const p = PHENOMENA[pid];
      return `<div class="lg-row"><span>${p.icon} ${p.short}</span>${p.ramp.map((c, i) => `<span class="sw" style="background:${c}" title="${esc(p.levelHelp[i])}"></span>`).join('')}</div>`;
    }).join('')}
    <div class="lg-note">Darker = more intense. Orange outline = your area. Hover a colour for its meaning.</div>`;
}

// ============================================================ findings panel
function renderFindings() {
  const el = $('#findings');
  if (!state.results || !state.dates.length) return;
  const date = state.dates[state.dateIdx];
  const grid = state.results.grid;
  el.innerHTML = `<div class="f-note" style="margin-bottom:8px">Area analysed: <b>${fmtKm(grid.aoiKm2)} km²</b> · showing <b>${date}</b> (latest image of each dataset on or before this date)</div>` +
    state.results.phen.map(pid => {
      const p = PHENOMENA[pid];
      const sum = summarize(pid, date);
      if (!sum) {
        return `<div class="finding" style="--c:${p.ramp[2]}"><div class="f-head"><span>${p.icon}</span><h3>${p.name}</h3><span class="badge none">No data</span></div>
          <div class="f-note">None of this phenomenon's NASA datasets had usable images for this area and period. See <b>Data sources</b>.</div></div>`;
      }
      const st = sum.stats;
      const lvName = sum.level ? LEVELS[sum.level - 1].name : 'None detected';
      const badgeStyle = sum.level ? `style="background:${p.ramp[sum.level - 1]};${sum.level <= 1 ? 'color:#222' : ''}"` : '';
      const trendCls = Math.abs(sum.trend) < 0.01 ? 'flat' : sum.trend > 0 ? 'up' : 'down';
      const mag = Math.abs(sum.trend);
      const trendTxt = trendCls === 'flat' ? `No change since ${sum.firstDate}` :
        `${sum.trend > 0 ? '▲ +' : '▼ −'}${mag < 0.01 ? '<0.01' : fmtKm(mag)} km² since ${sum.firstDate}`;
      const total = Math.max(grid.aoiKm2, 1e-9);
      const stack = [4, 3, 2, 1].map(l => `<i style="width:${(100 * st.km2[l]) / total}%;background:${p.ramp[l - 1]}" title="${LEVELS[l - 1].name}: ${fmtKm(st.km2[l])} km²"></i>`).join('');
      const rows = [4, 3, 2, 1].map(l => `<tr><td><span class="sw" style="background:${p.ramp[l - 1]}"></span></td>
          <td><b>${LEVELS[l - 1].name}</b></td><td class="km">${fmtKm(st.km2[l])} km²</td><td class="help">${esc(p.levelHelp[l - 1])}</td></tr>`).join('');
      const chips = sum.rs.map((r, i) => {
        const f = sum.frames[i];
        return `<span class="chip" title="${esc(r.ds.satellites)}"><b>${esc(r.ds.name)}</b> · ${r.ds.kind} · ${f.date} · ${fmtKm(f.stats.affected)} km²</span>`;
      }).join('');
      const agree = sum.rs.length > 1
        ? `<div class="f-agree">✔ Detected by 2+ independent sensors: <b>${fmtKm(sum.agreeKm2)} km²</b> (highest confidence)</div>` : '';
      const observed = sum.rs.some(r => r.ds.method === 'sar')
        ? 'Radar intensity = how much the radar image darkened vs the first date (backscatter drop).' : '';
      return `<div class="finding" style="--c:${p.ramp[2]}">
        <div class="f-head"><span>${p.icon}</span><h3>${p.name}</h3><span class="badge ${sum.level ? '' : 'none'}" ${badgeStyle}>${lvName}</span></div>
        <div class="f-big">${fmtKm(st.affected)} km² <small>detected · ${st.affectedPctOfAoi.toFixed(1)} % of area</small></div>
        <div class="f-trend ${trendCls}">${trendTxt}</div>
        <div class="stack">${stack}</div>
        <table class="levels">${rows}</table>
        ${agree}
        <div class="chips">${chips}</div>
        <div class="f-note">${observed}</div>
      </div>`;
    }).join('');
}

// ============================================================ data sources panel
function renderSources() {
  const el = $('#sources');
  const res = state.results;
  if (!res) { el.innerHTML = '<div class="empty">Run an analysis to see which NASA datasets were used.</div>'; return; }
  const date = state.dates[state.dateIdx];
  const statusText = { queued: '○ Queued', searching: '◌ Searching NASA catalogue…', loading: '◌ Downloading NASA images…', live: '● LIVE – real data', failed: '✕ No usable images', 'no-data': '✕ No acquisitions' };
  el.innerHTML = `<div class="f-note" style="margin-bottom:8px">Every number in this app comes from these NASA sources. Catalogue counts are live queries to NASA CMR; images are NASA GIBS science visualisations.</div>` +
    [...res.byId.values()].map(r => {
      const ds = r.ds;
      const ramp = PHENOMENA[ds.phenomenon].ramp;
      const ok = r.frames.filter(f => f.stats);
      const cur = date ? frameAt(r, date) : null;
      const kindCls = ds.kind.split(' ')[0];
      const cmrLine = r.cmr
        ? `NASA CMR catalogue: <b>${r.cmr.hits.toLocaleString()}</b> granules over your area` +
          (r.cmr.dates.length ? ` on <b>${r.cmr.dates.length}</b> days (${r.cmr.dates[0]} → ${r.cmr.dates.at(-1)})` : '') +
          ` · <a href="${esc(r.cmr.query)}" target="_blank" rel="noopener">verify query</a>`
        : (r.status === 'queued' || r.status === 'searching' ? 'NASA CMR catalogue: searching…' : 'NASA CMR catalogue: unavailable');
      const method = ds.method === 'sar'
        ? `Method: radar darkening vs reference image${r.reference ? ` (${r.reference})` : ''}`
        : ds.method === 'presence' ? 'Method: every NASA fire detection pixel counts'
        : r.colormap ? `Method: ${r.classifier.info.length} classes read from NASA's colour map${r.units ? ` (${esc(r.units)})` : ''}`
        : 'Method: colour map pending';
      return `<div class="source" style="border-left:5px solid ${ramp[2]}">
        <div class="s-head"><span class="kind kind-${kindCls}">${ds.kind.toUpperCase()}</span><b>${esc(ds.name)}</b>
          <span class="st st-${r.status}">${statusText[r.status] || r.status}</span></div>
        <div class="s-meta">${esc(ds.product)}<br>${esc(ds.satellites)} · ${esc(ds.agency)} · ${esc(ds.resolution)}</div>
        <div class="s-line">${cmrLine}</div>
        <div class="s-line">Analysed: <b>${ok.length}</b> of ${r.frames.length || '–'} dates${cur ? ` · on map: <b>${cur.date}</b> (NASA image covers ${(cur.coverage * 100).toFixed(0)} % of area)` : ''}</div>
        <div class="s-line">${method}</div>
        <div class="s-line" style="color:#5b6676">GIBS layer: <code>${esc(ds.gibs)}</code> · CMR: <code>${esc(ds.cmr)}</code></div>
        ${r.errors.map(e => `<div class="s-err">⚠ ${esc(e)}</div>`).join('')}
        ${r.status === 'live' ? `<label class="s-show"><input type="checkbox" data-show="${ds.id}" ${state.shown.has(ds.id) ? 'checked' : ''}> Show NASA original on map (“NASA original colours” view)</label>` : ''}
        <div class="s-links">
          <a href="${earthdataSearchUrl(ds.cmr)}" target="_blank" rel="noopener">Earthdata Search ↗</a>
          <a href="${worldviewUrl(ds.gibs, cur ? cur.date : res.end, res.grid.bbox)}" target="_blank" rel="noopener">NASA Worldview ↗</a>
        </div>
      </div>`;
    }).join('');
  el.querySelectorAll('[data-show]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) state.shown.add(cb.dataset.show); else state.shown.delete(cb.dataset.show);
    renderMapLayers();
  }));
}

// ============================================================ tabs + export
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $('#findings').classList.toggle('hidden', name !== 'findings');
  $('#sources').classList.toggle('hidden', name !== 'sources');
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#export-csv').addEventListener('click', () => {
  const lines = ['phenomenon,dataset,kind,satellites,date,image_coverage_pct,detected_km2,low_km2,moderate_km2,high_km2,severe_km2,pct_of_area,gibs_layer,cmr_short_name'];
  for (const r of state.results.byId.values()) {
    for (const f of r.frames) {
      if (!f.stats) continue;
      const s = f.stats;
      lines.push([r.ds.phenomenon, r.ds.name, r.ds.kind, `"${r.ds.satellites}"`, f.date, (f.coverage * 100).toFixed(1),
        s.affected.toFixed(4), ...[1, 2, 3, 4].map(l => s.km2[l].toFixed(4)), s.affectedPctOfAoi.toFixed(3), r.ds.gibs, r.ds.cmr].join(','));
    }
  }
  download('surface-change-results.csv', lines.join('\n'), 'text/csv');
});

$('#export-json').addEventListener('click', () => {
  const res = state.results;
  const out = {
    generated: new Date().toISOString(),
    area: { polygon_lonlat: res.aoi.polygon, bbox: res.grid.bbox, km2: res.grid.aoiKm2 },
    period: { start: res.start, end: res.end },
    datasets: [...res.byId.values()].map(r => ({
      id: r.ds.id, name: r.ds.name, phenomenon: r.ds.phenomenon, kind: r.ds.kind, satellites: r.ds.satellites,
      agency: r.ds.agency, gibs_layer: r.ds.gibs, cmr_short_name: r.ds.cmr, status: r.status, errors: r.errors,
      cmr: r.cmr ? { hits: r.cmr.hits, acquisition_days: r.cmr.dates, query: r.cmr.query } : null,
      frames: r.frames.map(f => ({ date: f.date, error: f.error || null, coverage: f.coverage ?? null, stats: f.stats || null }))
    }))
  };
  download('surface-change-results.json', JSON.stringify(out, null, 2), 'application/json');
});

// ============================================================ start-up
(function init() {
  const end = today();
  const start = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  $('#start').value = start;
  $('#end').value = end;
  $('#start').max = $('#end').max = end;
  renderPhenomenaPicker(['vegetation', 'water']);
  loadExample(EXAMPLES[0]);
  renderLegend();
  renderSources();
  fetch('/api/health').then(r => r.ok && $('#live-pill').classList.add('on')).catch(() => $('#live-pill').classList.add('err'));
})();
