// =============================================================================
// EarthScope – main app
// =============================================================================
import { PHENOMENA, LEVELS, DATASETS, CONTEXT_LAYERS, EXAMPLES, WATER_CODES, WATER_LABEL_RULES, SOURCE_NOTES } from './config.js';
import {
  OUT, parseColormap, buildClassifier, makeGrid, classifyPixels, luminance, sarLevels,
  frameStats, combine, overallLevel, sampleDates, dailyDates,
  W_NAMES, buildWaterClassifier, classifyWater, waterBaseline, waterStatus, waterStats,
  waterAgreement, waterConfidence, buildValueClassifier, valueStats
} from './classify.js';
import {
  limiter, fetchCmr, fetchColormapXml, fetchPixels, imageCoverage, tileUrl,
  earthdataSearchUrl, worldviewUrl
} from './nasa.js';
import { graticuleGeoJSON, GRATICULE_RANKS } from './graticule.js';
import { initLayout, revealPanel } from './layout.js';
import { initTour, startTour } from './tour.js';
import { initTerms } from './glossary.js';
import { mergeByDate, detectEvent, phaseOf, phaseTargets, recordsInPeriod, daysBetween } from './events.js';

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
  chart: null,
  showBaseline: false,  // map shows the pre-event water baseline instead of the selected date
  activeEvent: null,    // id of the event selected on the event track
  loadedExample: null   // example whose documented records may apply
};

// ============================================================ map set-up
// A 3D globe (MapLibre globe projection) with an atmosphere, like Google Earth.
const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('esm-map-prefs') || '{}') || {}; } catch { return {}; }
})();
const savePrefs = () => { try { localStorage.setItem('esm-map-prefs', JSON.stringify(prefs)); } catch { /* ignore */ } };

const ATMOSPHERE = {
  'sky-color': '#7fb4ff',
  'horizon-color': '#dceaff',
  'fog-color': '#ffffff',
  'sky-horizon-blend': 0.6,
  'horizon-fog-blend': 0.8,
  'fog-ground-blend': 0.9,
  // full atmosphere glow when you see the whole planet, fading out as you zoom in
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
};

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    projection: { type: prefs.projection === 'mercator' ? 'mercator' : 'globe' },
    sky: ATMOSPHERE,
    light: { anchor: 'map', position: [1.5, 90, 80] },
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
      },
      'esri-ref': {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Labels © Esri'
      }
    },
    layers: [
      { id: 'base-osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
      { id: 'base-esri', type: 'raster', source: 'esri' },
      { id: 'base-esri-ref', type: 'raster', source: 'esri-ref' }
    ]
  },
  center: [10, 15],
  zoom: 1.4,
  maxPitch: 80,
  attributionControl: { compact: true, customAttribution: 'Science data: NASA GIBS / CMR' }
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const mapReady = new Promise(resolve => map.on('load', resolve));

// Keep the map (and timeline drawing) sized to its box when panels move or resize.
let legendTimer = null;
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    map.resize();
    // until the user opens/closes the legend, keep it collapsed on narrow maps
    if (prefs.legendOpen === undefined) { clearTimeout(legendTimer); legendTimer = setTimeout(() => renderLegend(), 150); }
  }).observe($('#map-wrap'));
}

mapReady.then(() => {
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('aoi', { type: 'geojson', data: empty });
  map.addLayer({ id: 'mask-fill', type: 'fill', source: 'mask', paint: { 'fill-color': '#0b1d33', 'fill-opacity': 0.45 } });
  addGraticuleLayers();
  map.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#ff7a00', 'line-width': 3 } });
  map.addLayer({ id: 'aoi-pts', type: 'circle', source: 'aoi', filter: ['==', '$type', 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#ff7a00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  applyBasemap();
  setGraticule($('#graticule').checked);
  setTerrain($('#terrain').checked);
  updateAoi(false);   // init() already started the first fly-to
});

// ---- mouse & touch controls
// Left-drag: pan (MapLibre default) · right-drag: rotate / tilt (MapLibre default)
// Wheel: zoom (unchanged) · middle click: add an AOI point · "Add point" mode: click / tap adds a point.
map.dragRotate.enable();
map.touchZoomRotate.enable();
map.touchPitch.enable();
const canvasBox = map.getCanvasContainer();
canvasBox.addEventListener('contextmenu', e => e.preventDefault());     // right-drag must not open the menu
let middle = null;
canvasBox.addEventListener('mousedown', e => {
  if (e.button !== 1) return;
  e.preventDefault();                                                    // no browser auto-scroll
  middle = { x: e.clientX, y: e.clientY };
});
canvasBox.addEventListener('mouseup', e => {
  if (e.button !== 1 || !middle) return;
  e.preventDefault();
  const moved = Math.hypot(e.clientX - middle.x, e.clientY - middle.y);
  middle = null;
  if (moved > 6) return;
  const r = map.getCanvas().getBoundingClientRect();
  addPointAt(map.unproject([e.clientX - r.left, e.clientY - r.top]));
});
canvasBox.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });   // no paste on Linux

// Left click / tap NEVER adds a point (it only moves the map). Points come from a
// middle click, or from "Add point" mode: a crosshair at the map centre plus an
// explicit "Add point here" button – so panning can never create points by accident.
let picking = false;
function setPickMode(on) {
  picking = on;
  for (const b of [$('#pick-btn'), $('#pick-mode')]) { b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); }
  $('#crosshair').hidden = !on;
  $('#pick-bar').hidden = !on;
  if (on) $('#pick-add').focus();
}
$('#pick-btn').addEventListener('click', () => setPickMode(!picking));
$('#pick-mode').addEventListener('click', () => setPickMode(!picking));
$('#pick-add').addEventListener('click', () => addPointAt(map.getCenter()));
$('#pick-done').addEventListener('click', () => { setPickMode(false); $('#pick-btn').focus(); });
$('#pick-bar').addEventListener('keydown', e => { if (e.key === 'Escape') { setPickMode(false); $('#pick-btn').focus(); } });

function addPointAt(lngLat) {
  const lng = ((lngLat.lng + 540) % 360) - 180;
  const rows = [...document.querySelectorAll('#coord-body tr')];
  const empty = rows.find(r => !r.querySelector('.lat').value && !r.querySelector('.lon').value);
  if (empty) {
    empty.querySelector('.lat').value = lngLat.lat.toFixed(5);
    empty.querySelector('.lon').value = lng.toFixed(5);
  } else {
    addRow(lngLat.lat.toFixed(5), lng.toFixed(5));
  }
  updateAoi(false);
  const n = document.querySelectorAll('#coord-body tr').length;
  const el = document.createElement('div');
  el.className = 'point-pulse';
  const mk = new maplibregl.Marker({ element: el }).setLngLat([lng, lngLat.lat]).addTo(map);
  setTimeout(() => mk.remove(), 1400);
  toast(`Point ${n} added at ${lngLat.lat.toFixed(4)}, ${lng.toFixed(4)}`);
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// control legend (mouse vs touch wording)
const coarse = matchMedia('(pointer: coarse)').matches;
$('#controls-help').innerHTML = coarse
  ? '<b>Map controls</b><span>One finger: move</span><span>Two fingers: zoom, rotate, tilt</span><span>Tapping never adds points. Use <b>Add point</b>: move the map under the crosshair, then press <b>Add point here</b>.</span>'
  : '<b>Map controls</b><span><kbd>Left-drag</kbd> move (clicks never add points)</span><span><kbd>Right-drag</kbd> rotate / tilt</span><span><kbd>Wheel</kbd> zoom</span><span><kbd>Middle-click</kbd> add AOI point</span><span>No middle button? <b>Add point</b> shows a crosshair to place points.</span>';
$('#help-toggle').addEventListener('click', () => {
  const box = $('#controls-help');
  const show = box.hidden;
  box.hidden = !show;
  $('#help-toggle').setAttribute('aria-expanded', String(show));
});

// ---- base map
if (prefs.basemap) $('#basemap').value = prefs.basemap;
function applyBasemap() {
  const v = $('#basemap').value;
  map.setLayoutProperty('base-osm', 'visibility', v === 'osm' ? 'visible' : 'none');
  map.setLayoutProperty('base-esri', 'visibility', v === 'osm' ? 'none' : 'visible');
  map.setLayoutProperty('base-esri-ref', 'visibility', v === 'hybrid' ? 'visible' : 'none');
}
$('#basemap').addEventListener('change', e => {
  prefs.basemap = e.target.value; savePrefs();
  mapReady.then(applyBasemap);
});

// ---- globe / flat projection
function setProjection(type) {
  document.querySelectorAll('[data-proj]').forEach(b => b.classList.toggle('on', b.dataset.proj === type));
  prefs.projection = type; savePrefs();
  mapReady.then(() => map.setProjection({ type }));
}
document.querySelectorAll('[data-proj]').forEach(b => b.addEventListener('click', () => setProjection(b.dataset.proj)));
document.querySelectorAll('[data-proj]').forEach(b => b.classList.toggle('on', b.dataset.proj === (prefs.projection === 'mercator' ? 'mercator' : 'globe')));

// ---- latitude / longitude grid
const GRAT_LINE = r => `grat-line-${r}`, GRAT_LABEL = r => `grat-label-${r}`;
function addGraticuleLayers() {
  map.addSource('graticule', { type: 'geojson', data: graticuleGeoJSON() });
  GRATICULE_RANKS.forEach((rk, r) => {
    map.addLayer({
      id: GRAT_LINE(r), type: 'line', source: 'graticule', minzoom: rk.minzoom,
      filter: ['==', ['get', 'rank'], r],
      layout: { visibility: 'none' },
      paint: {
        'line-color': ['case', ['get', 'major'], '#ffd166', '#ffffff'],
        'line-opacity': ['case', ['get', 'major'], 0.9, r === 0 ? 0.55 : 0.35],
        'line-width': ['case', ['get', 'major'], 1.6, r === 0 ? 1 : 0.7]
      }
    });
    map.addLayer({
      id: GRAT_LABEL(r), type: 'symbol', source: 'graticule', minzoom: rk.minzoom,
      filter: ['==', ['get', 'rank'], r],
      layout: {
        visibility: 'none',
        'symbol-placement': 'line',
        'symbol-spacing': 320,
        'text-field': ['get', 'label'],
        'text-font': ['Open Sans Semibold'],
        'text-size': 11,
        'text-keep-upright': true,
        'text-max-angle': 30
      },
      paint: {
        'text-color': ['case', ['get', 'major'], '#ffd166', '#ffffff'],
        'text-halo-color': 'rgba(4,10,25,.85)',
        'text-halo-width': 1.4
      }
    });
  });
}
function setGraticule(on) {
  GRATICULE_RANKS.forEach((_, r) => {
    map.setLayoutProperty(GRAT_LINE(r), 'visibility', on ? 'visible' : 'none');
    map.setLayoutProperty(GRAT_LABEL(r), 'visibility', on ? 'visible' : 'none');
  });
}
$('#graticule').checked = !!prefs.graticule;
$('#graticule').addEventListener('change', e => {
  prefs.graticule = e.target.checked; savePrefs();
  mapReady.then(() => setGraticule(e.target.checked));
});

// ---- 3D terrain (open elevation tiles from the AWS Terrain Tiles dataset)
function setTerrain(on) {
  if (on) {
    if (!map.getSource('dem')) {
      map.addSource('dem', {
        type: 'raster-dem', tileSize: 256, maxzoom: 14, encoding: 'terrarium',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        attribution: 'Elevation: AWS Terrain Tiles (SRTM, GMTED, ETOPO1)'
      });
    }
    map.setTerrain({ source: 'dem', exaggeration: 1.5 });
    if (map.getPitch() < 30 && map.getZoom() > 6) map.easeTo({ pitch: 55, duration: 900 });
  } else {
    map.setTerrain(null);
  }
}
$('#terrain').checked = !!prefs.terrain;
$('#terrain').addEventListener('change', e => {
  prefs.terrain = e.target.checked; savePrefs();
  mapReady.then(() => setTerrain(e.target.checked));
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

let firstFit = true;
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
  if (fit !== false) {
    // first view: fly in from the whole globe, like Google Earth
    const duration = firstFit ? 3200 : 1200;
    firstFit = false;
    map.fitBounds([[aoi.bbox[0], aoi.bbox[1]], [aoi.bbox[2], aoi.bbox[3]]], { padding: 60, duration, essential: true });
  }
}

$('#add-row').addEventListener('click', () => addRow());
$('#clear-rows').addEventListener('click', () => { $('#coord-body').innerHTML = ''; addRow(); updateAoi(false); });
$('#radius').addEventListener('change', () => updateAoi(false));

// ============================================================ phenomena + examples
function renderPhenomenaPicker(selected) {
  $('#phenomena').innerHTML = Object.entries(PHENOMENA).map(([id, p]) => {
    const ds = DATASETS.filter(d => d.phenomenon === id);
    const kinds = [...new Set(ds.map(d => d.kind))].join(' + ');
    const sw = p.water ? [p.water.normal, p.water.new] : p.ramp;
    const main = ds.filter(d => !d.context).length, ctx = ds.length - main;
    return `<label class="phen" style="--c:${p.water ? p.water.new : p.ramp[2]}">
      <input type="checkbox" value="${id}" ${selected.includes(id) ? 'checked' : ''}>
      <span class="ramp" aria-hidden="true">${sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      <span class="phen-text">${p.name}<small>${main} NASA datasets${ctx ? ` + ${ctx} context` : ''} · ${kinds}</small></span>
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
  state.loadedExample = ex;
  $('#coord-body').innerHTML = '';
  ex.rows.forEach(([lat, lon]) => addRow(lat, lon));
  if (ex.radiusKm) $('#radius').value = ex.radiusKm;
  $('#start').value = ex.start;
  $('#end').value = ex.end;
  $('#event-date').value = ex.eventDate || '';
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
  const eventDate = $('#event-date').value || '';
  if (eventDate && (eventDate <= start || eventDate > endUse)) {
    setStatus('The flood event date must fall after the start date and on or before the end date (or leave it empty).', true);
    return;
  }
  const n = parseInt($('#samples').value, 10);
  const detail = parseInt($('#detail').value, 10);

  stopPlay();
  state.showBaseline = false;
  $('#show-baseline').checked = false;
  $('#analyze').disabled = true;
  setProgress(0.02);
  setStatus('Building analysis grid…');
  const grid = makeGrid(state.aoi.polygon, state.aoi.bbox, detail);
  const datasets = DATASETS.filter(d => phen.includes(d.phenomenon));
  const results = { grid, start, end: endUse, eventDate, phen, aoi: state.aoi, byId: new Map(), started: new Date().toISOString() };
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

  if (!state.dates.length) {
    setStatus('No NASA imagery could be read for this area and period. Check the Data sources tab for details, or try a wider period.', true);
    renderSources();
    return;
  }
  const failed = results.byId.size - live.length;
  setStatus(`Done: ${live.length} of ${results.byId.size} datasets returned real NASA data` +
    (failed ? ` (${failed} without usable imagery – see Data sources).` : '.') +
    `\nAnalysed ${state.dates.length} dates between ${state.dates[0]} and ${state.dates.at(-1)}.`);
  $('#export-csv').disabled = $('#export-json').disabled = false;
  results.events = buildEvents(results);
  state.activeEvent = (results.events.find(e => e.firstAffected) || {}).id || null;
  buildTimeline();
  showTab('findings');
  selectDate(state.dateIdx);
}

/** Sample dates; with a flood event date, keep observations on both sides of it. */
function pickDates(dates, n, eventDate) {
  if (!eventDate) return sampleDates(dates, n);
  const before = dates.filter(d => d < eventDate), after = dates.filter(d => d >= eventDate);
  if (!before.length || !after.length) return sampleDates(dates, n);
  const nb = Math.max(2, Math.floor(n / 3));
  return [...sampleDates(before, nb), ...sampleDates(after, Math.max(2, n - nb))];
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
      dates = dailyDates(start, end, ds.method === 'water' ? Math.max(n, 12) : ds.phenomenon === 'fire' ? Math.max(n, 16) : n);
    }
    // date filtering: never use an observation outside the selected period
    const outside = dates.filter(d => d < start || d > end).length;
    if (outside) {
      dates = dates.filter(d => d >= start && d <= end);
      r.errors.push(`${outside} catalogue date(s) outside the selected period were ignored.`);
      if (!dates.length) { r.status = 'no-data'; r.errors.push('No acquisitions inside the selected period.'); renderSources(); return; }
    }
    r.acqDates = dates;
    const picked = ds.phenomenon === 'water' ? pickDates(dates, n, results.eventDate) : sampleDates(dates, n);

    // 2. NASA colour map → classifier
    if (ds.method !== 'presence' && ds.method !== 'sar') {
      const xml = await fetchColormapXml(ds.gibs).catch(() => null);
      r.colormap = parseColormap(xml);
    }
    if (ds.method === 'water') {
      r.classifier = buildWaterClassifier(r.colormap, WATER_CODES[ds.waterCodes], WATER_LABEL_RULES);
      if (!r.classifier.valid) {
        // Without NASA's class table the colours cannot be interpreted – never guess.
        r.status = 'failed';
        r.errors.push('NASA colour map (class table) not available, so the water classes cannot be read. Dataset not used.');
        tick(); renderSources();
        return;
      }
    } else if (ds.method === 'rain') {
      r.classifier = buildValueClassifier(r.colormap);
      if (!r.classifier.palette.length) {
        r.status = 'failed';
        r.errors.push('NASA colour map not available, so rainfall values cannot be read. Context not shown.');
        tick(); renderSources();
        return;
      }
    } else {
      if ((ds.method === 'classes' || ds.method === 'continuous') && !r.colormap) {
        r.errors.push('NASA colour map not available – any coloured pixel counts as "detected" (intensity unknown).');
      }
      r.classifier = buildClassifier(ds, r.colormap);
    }
    r.units = r.colormap ? r.colormap.units : '';
    tick();

    // 3. Images for each date
    r.status = 'loading'; renderSources();
    const acquired = new Set(r.cmr ? r.cmr.dates : []);
    const frames = await Promise.all(picked.map(date => imgLimit(async () => {
      try {
        const rgba = await fetchPixels(ds.gibs, date, grid);
        const coverage = imageCoverage(rgba, grid);
        if (ds.method === 'sar') return { date, coverage, lum: luminance(rgba, grid) };
        if (ds.method === 'water') return { date, cls: classifyWater(rgba, grid, r.classifier, !r.cmr || acquired.has(date)) };
        if (ds.method === 'rain') return { date, coverage, rain: valueStats(rgba, grid, r.classifier) };
        return { date, coverage, levels: classifyPixels(rgba, grid, ds, r.classifier) };
      } catch (e) {
        return { date, error: e.message };
      } finally { tick(); }
    })));
    frames.sort((a, b) => a.date.localeCompare(b.date));

    // 4. Post-processing
    if (ds.method === 'water') {
      processWater(r, frames, grid, results.eventDate);
    } else if (ds.method === 'sar') {
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
    }
    if (ds.method !== 'water' && ds.method !== 'rain') for (const f of frames) if (f.levels) f.stats = frameStats(f.levels, grid);
    r.frames = frames;
    const ok = frames.filter(f => f.stats || f.rain);
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

/**
 * Water: split observations into a pre-event baseline and later observations, then
 * label every valid water pixel as normal water / newly inundated / baseline unknown.
 * Baseline = observations before the event date; without an event date, the
 * observations up to and including the first one that sees ≥ 30 % of the area.
 */
function processWater(r, frames, grid, eventDate) {
  const n = grid.w * grid.h;
  for (const f of frames) {
    if (f.error) continue;
    const pre = waterStats(f.cls, new Uint8Array(n).fill(OUT), grid);
    f.coverage = pre.coveragePct / 100;
    if (pre.validKm2 <= 0) f.error = 'no valid water observation over the area (no data, cloud or masked)';
  }
  const ok = frames.filter(f => !f.error);
  let baseFrames;
  if (eventDate) baseFrames = ok.filter(f => f.date < eventDate);
  else {
    const k = ok.findIndex(f => f.coverage >= 0.3);
    baseFrames = k >= 0 ? ok.slice(0, k + 1) : [];
  }
  const baseline = baseFrames.length ? waterBaseline(baseFrames.map(f => f.cls), n) : null;
  r.baseline = baseline;
  r.baselineDates = baseFrames.map(f => f.date);
  if (baseline) {
    let known = 0;
    for (let p = 0; p < n; p++) if (grid.mask[p] && baseline[p] !== OUT) known += grid.rowArea[Math.floor(p / grid.w)];
    r.baselineCoverPct = grid.aoiKm2 ? (100 * known) / grid.aoiKm2 : 0;
  } else {
    r.baselineCoverPct = 0;
    r.errors.push(eventDate
      ? 'No valid observation before the event date – newly inundated area cannot be separated from normal water.'
      : 'No observation covered at least 30 % of the area early in the period – no baseline, so new water cannot be identified.');
  }
  const baseSet = new Set(r.baselineDates);
  for (const f of ok) {
    f.role = baseSet.has(f.date) ? 'baseline' : 'post';
    f.status = waterStatus(f.cls, baseline);
    f.stats = waterStats(f.cls, f.status, grid);
  }
  r.mismatches = (r.classifier.info || []).filter(i => i.mismatch);
}

// ============================================================ summaries
const isWater = r => r.ds.method === 'water';
const isRain = r => r.ds.method === 'rain';

function frameAt(r, date) {
  const ok = r.frames.filter(f => f.stats);
  if (!ok.length) return null;
  let best = ok[0];
  for (const f of ok) if (f.date <= date) best = f;
  return best;
}
const firstFrame = r => r.frames.find(f => f.stats) || null;
const liveResults = () => (state.results ? [...state.results.byId.values()].filter(r => r.status === 'live') : []);

/** Intensity-scale phenomena (vegetation, fire, chlorophyll). */
function summarize(pid, date) {
  const grid = state.results.grid;
  const rs = liveResults().filter(r => r.ds.phenomenon === pid && !isWater(r) && !isRain(r));
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

/**
 * Floods. Sensors are NOT averaged: each source keeps its own result; the headline
 * figure comes from the source with the best valid coverage on/before the date
 * (radar preferred on ties, as it is not blocked by cloud). Other sources are used
 * to measure agreement, which feeds the confidence rating.
 */
function summarizeWater(date) {
  const grid = state.results.grid;
  const rs = liveResults().filter(isWater);
  const rain = liveResults().find(isRain) || null;
  const rows = rs.map(r => ({ r, f: frameAt(r, date) })).filter(x => x.f);
  if (!rows.length) return { rs, rows, rain, headline: null };
  const score = x => x.f.stats.coveragePct + (x.r.ds.kind === 'SAR' ? 0.5 : 0) + (x.f.role === 'post' ? 1000 : 0) - (x.r.ds.complementary ? 0.25 : 0);
  const headline = rows.slice().sort((a, b) => score(b) - score(a))[0];
  let agreement = null, agreeWith = null;
  for (const x of rows) {
    if (x === headline || x.r.ds.sensorGroup === headline.r.ds.sensorGroup || x.f.role !== 'post' || headline.f.role !== 'post') continue;
    if (!x.r.baseline || !headline.r.baseline) continue;               // "new" is undefined without a baseline
    // water changes within days: only compare observations made within 3 days of each other
    if (Math.abs(Date.parse(x.f.date) - Date.parse(headline.f.date)) > 3 * 86400000) { x.tooFar = true; continue; }
    const a = waterAgreement(headline.f.status, x.f.status, grid);
    x.agreement = a;
    if (!agreement || a.commonKm2 > agreement.commonKm2) { agreement = a; agreeWith = x; }
  }
  const st = headline.f.stats;
  const confidence = headline.r.baseline
    ? waterConfidence(st, agreement)
    : { level: 'Insufficient data', reasons: ['no pre-event baseline, so new water cannot be separated from normal water'] };
  const sig = st.newKm2 >= Math.max(0.05, 0.005 * st.validKm2);
  let verdict;
  if (headline.f.role === 'baseline') verdict = 'Pre-event baseline';
  else if (confidence.level === 'Insufficient data') verdict = 'Insufficient data';
  else verdict = sig ? 'New water detected' : 'No new water detected';
  let rainInfo = null;
  if (rain) {
    const fr = rain.frames.filter(f => f.rain && f.date <= date);
    if (fr.length) {
      const peak = fr.reduce((a, b) => (b.rain.mean > a.rain.mean ? b : a));
      rainInfo = { peak, count: fr.length };
    }
  }
  return { rs, rows, rain, rainInfo, headline, agreement, agreeWith, confidence, verdict };
}

// ============================================================ events
/**
 * One event per phenomenon, built only from analysed observations:
 *  floods  – a date is affected when a valid source (≥ 25 % coverage, known baseline) shows new water
 *  fires   – a date is affected when VIIRS shows any active-fire pixel
 *  others  – a date is affected when the intensity level is above "none"
 * Reported dates (agency records, the user's flood event date) are attached separately.
 */
const EVENT_KIND = { water: 'flood', fire: 'fire', vegetation: 'change', algae: 'change' };
const EVENT_TITLE = { water: 'Flood', fire: 'Wildfire', vegetation: 'Vegetation loss', algae: 'Algae bloom' };

function observationsFor(pid, res) {
  const obs = [];
  for (const r of res.byId.values()) {
    if (r.status !== 'live' || r.ds.phenomenon !== pid || isRain(r)) continue;
    for (const f of r.frames) {
      if (!f.stats) continue;
      let state, value;
      if (isWater(r)) {
        const st = f.stats;
        const thr = Math.max(0.05, 0.005 * st.validKm2);
        if (st.coveragePct < 25) state = 'unknown';
        else if (f.role === 'baseline') state = 'clear';
        else if (!r.baseline) state = 'unknown';
        else state = st.newKm2 >= thr ? 'affected' : 'clear';
        value = f.role === 'post' ? st.newKm2 : 0;
      } else {
        const lv = overallLevel(f.stats, res.grid.aoiKm2);
        state = r.ds.method === 'presence' ? (f.stats.affected > 0 ? 'affected' : 'clear') : (lv > 0 ? 'affected' : 'clear');
        value = f.stats.affected;
      }
      obs.push({ date: f.date, source: r.ds.name, state, value, coveragePct: f.coverage != null ? f.coverage * 100 : null });
    }
  }
  return obs;
}

function buildEvents(res) {
  const ex = state.loadedExample;
  const sameArea = ex && JSON.stringify(ex.rows.map(([a, b]) => [+a, +b])) ===
    JSON.stringify(readPoints().pts.map(([lon, lat]) => [lat, lon]));
  const records = sameArea ? recordsInPeriod(ex.records, res.start, res.end) : [];
  res.recordsOutside = sameArea ? (ex.records || []).filter(r => !records.includes(r)) : [];
  return res.phen.map(pid => {
    const raw = observationsFor(pid, res);
    const series = mergeByDate(raw);
    const kind = EVENT_KIND[pid] || 'change';
    const ev = detectEvent(series, { kind, periodStart: res.start, periodEnd: res.end, unit: 'km²', recession: kind === 'flood' });
    ev.id = `ev-${pid}`;
    ev.phenomenon = pid;
    ev.title = EVENT_TITLE[pid] || PHENOMENA[pid].short;
    ev.sources = [...new Set(raw.map(o => o.source))];
    ev.supporting = raw.filter(o => o.state === 'affected').map(o => ({ date: o.date, source: o.source, value: +o.value.toFixed(3) }));
    ev.reported = records.filter(r => r.phenomenon === pid).map(r => ({ ...r }));
    if (pid === 'water' && res.eventDate) {
      ev.reported.push({ phenomenon: 'water', type: 'user', date: res.eventDate, label: 'Flood event date entered by the user', source: 'User input (used to split baseline / post-event observations)' });
    }
    ev.valueLabel = kind === 'flood' ? 'newly inundated area' : kind === 'fire' ? 'active-fire pixel area' : 'affected area';
    return ev;
  });
}

const activeEvent = () => (state.results && state.results.events || []).find(e => e.id === state.activeEvent) || null;
const fmtDay = d => { const t = new Date(d + 'T00:00:00Z'); return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };
function windowText(earliest, latest) {
  if (!earliest) return `on or before ${fmtDay(latest)}`;
  if (earliest === latest) return fmtDay(latest);
  return `${fmtDay(earliest)} – ${fmtDay(latest)} <small>(${daysBetween(earliest, latest)}-day window between observations)</small>`;
}

/** Select an event: jump to its "during" observation and sync everything. */
function selectEvent(id, phase = 'during') {
  state.activeEvent = id;
  const ev = activeEvent();
  renderPhaseNav();
  if (!ev) { drawTimelineSvg(); return; }
  goPhase(phase);
}

function goPhase(phase) {
  const ev = activeEvent();
  const t = phaseTargets(ev, state.dates);
  const date = t[phase];
  if (!date) return;
  stopPlay();
  selectDate(state.dates.indexOf(date));
}

function renderPhaseNav() {
  const nav = $('#phase-nav');
  const evs = state.results ? (state.results.events || []).filter(e => e.firstAffected) : [];
  nav.hidden = !evs.length;
  if (!evs.length) return;
  if (!activeEvent() || !activeEvent().firstAffected) state.activeEvent = evs[0].id;
  const sel = $('#event-select');
  sel.innerHTML = evs.map(e => `<option value="${e.id}" ${e.id === state.activeEvent ? 'selected' : ''}>${esc(e.title)}</option>`).join('');
  sel.hidden = evs.length < 2;
  $('#event-single').textContent = evs.length < 2 ? (activeEvent() || evs[0]).title : '';
  const ev = activeEvent();
  const t = phaseTargets(ev, state.dates);
  const cur = phaseOf(ev, state.dates[state.dateIdx]);
  for (const ph of ['before', 'during', 'after']) {
    const b = nav.querySelector(`[data-phase=${ph}]`);
    b.disabled = !t[ph];
    b.classList.toggle('on', cur === ph);
    b.setAttribute('aria-pressed', String(cur === ph));
    b.title = t[ph]
      ? { before: `Last observation before the event (${t.before})`, during: `Peak observed ${ev.valueLabel} (${t.during})`, after: `First observation after the event (${t.after})` }[ph]
      : { before: 'No observation before the event in this period', during: 'No affected observation', after: 'No observation after the event yet – it may be ongoing' }[ph];
  }
}
$('#event-select').addEventListener('change', e => selectEvent(e.target.value));
document.querySelectorAll('#phase-nav [data-phase]').forEach(b => b.addEventListener('click', () => goPhase(b.dataset.phase)));

// ============================================================ timeline
function buildTimeline() {
  const slider = $('#slider');
  slider.min = 0;
  slider.max = Math.max(0, state.dates.length - 1);
  slider.value = state.dateIdx;
  slider.disabled = state.dates.length < 2;
  $('#play').disabled = state.dates.length < 2;
  const hasWater = liveResults().some(isWater);
  $('#baseline-toggle').hidden = !hasWater;
  drawTimelineSvg();
  buildChart();
  renderPhaseNav();
}

$('#slider').addEventListener('input', e => selectDate(+e.target.value));
$('#play').addEventListener('click', () => (state.timer ? stopPlay() : startPlay()));
$('#show-baseline').addEventListener('change', e => { state.showBaseline = e.target.checked; renderMapLayers(); renderLegend(); });
function startPlay() {
  $('#play').textContent = '❚❚';
  $('#play').setAttribute('aria-label', 'Pause');
  if (state.dateIdx >= state.dates.length - 1) selectDate(0);
  state.timer = setInterval(() => {
    if (state.dateIdx >= state.dates.length - 1) { stopPlay(); return; }
    selectDate(state.dateIdx + 1);
  }, 1400);
}
function stopPlay() {
  clearInterval(state.timer); state.timer = null;
  $('#play').textContent = '▶';
  $('#play').setAttribute('aria-label', 'Play through dates');
}

function selectDate(idx) {
  if (!state.dates.length) return;
  state.dateIdx = Math.max(0, Math.min(idx, state.dates.length - 1));
  const date = state.dates[state.dateIdx];
  $('#slider').value = state.dateIdx;
  $('#tl-date').textContent = date;
  const imaged = liveResults().filter(r => r.frames.some(f => f.stats && f.date === date)).map(r => r.ds.name);
  $('#tl-sub').textContent = imaged.length ? `New observations: ${imaged.join(', ')}` : 'Showing the latest observation of each dataset';
  const ev = activeEvent(), ph = phaseOf(ev, date);
  const chip = $('#phase-chip');
  chip.hidden = !ph;
  if (ph) {
    chip.textContent = ph === 'uncertain' ? `${ev.title}: uncertain at this date` : `${ph[0].toUpperCase() + ph.slice(1)} ${ev.title.toLowerCase()}`;
    chip.title = ph === 'uncertain' ? 'This date lies in a window between observations, or after the last observation of an event whose end was not observed.' : '';
    chip.className = `phase-chip ph-${ph}`;
  }
  renderPhaseNav();
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
  const rows = [...res.byId.values()];
  const evs = res.events || [];
  const box = svg.parentElement;
  const left = (box.clientWidth || 600) < 480 ? 112 : 150, right = 12, top = 22;
  const evRowH = 24, evH = evs.length ? 16 + evs.length * evRowH + 8 : 0;    // event track above the satellite tracks
  const dsTop = top + evH;
  const rowH = Math.max(18, Math.min(24, ((box.clientHeight || 200) - dsTop - 26) / Math.max(rows.length, 1)));
  const W = box.clientWidth || 600, H = Math.max(box.clientHeight || 200, Math.ceil(dsTop + rows.length * rowH + 26));
  svg.style.height = `${H}px`;
  const t0 = Date.parse(res.start), t1 = Date.parse(res.end) + 86400000;
  const x = d => left + ((Date.parse(d) - t0) / (t1 - t0)) * (W - left - right);
  const C = { grid: '#eceff3', text: '#5d6877', ink: '#1b2430', line: '#dfe3e8', err: '#b3362b', accent: '#1d5fa6' };
  let s = '';
  // pre-event baseline window
  const baseEnds = rows.filter(r => r.baselineDates && r.baselineDates.length).map(r => r.baselineDates.at(-1));
  const baseEnd = res.eventDate || (baseEnds.length ? baseEnds.sort().at(-1) : null);
  if (baseEnd && rows.some(isWater)) {
    const xe = Math.min(x(baseEnd) + (res.eventDate ? 0 : 3), W - right);
    s += `<rect x="${left}" y="${dsTop - 6}" width="${Math.max(0, xe - left)}" height="${H - dsTop - 10}" fill="#f2f5f8"/>` +
         `<text x="${left + 4}" y="${H - 18}" font-size="9" fill="${C.text}">pre-event baseline</text>`;
    if (res.eventDate) s += `<line x1="${xe}" x2="${xe}" y1="${dsTop - 6}" y2="${H - 10}" stroke="#a8650a" stroke-dasharray="3 3"/><text x="${xe + 3}" y="${H - 18}" font-size="9" fill="#a8650a">event date ${res.eventDate}</text>`;
  }
  // month ticks
  const d = new Date(res.start + 'T00:00:00Z'); d.setUTCDate(1);
  const pxPerMonth = (W - left - right) / Math.max((t1 - t0) / (30.44 * 86400000), 0.01);
  const stepMonths = [1, 2, 3, 6, 12, 24].find(m => m * pxPerMonth >= 44) || 24;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  while (d.getTime() <= t1) {
    if (d.getTime() >= t0) {
      const xx = x(d.toISOString().slice(0, 10));
      const lbl = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
      s += `<line x1="${xx}" x2="${xx}" y1="${top - 4}" y2="${H - 10}" stroke="${C.grid}"/>` +
           `<text x="${xx + 2}" y="12" font-size="10" fill="${C.text}">${lbl}</text>`;
    }
    d.setUTCMonth(d.getUTCMonth() + stepMonths);
  }
  s += eventTrackSvg(evs, { x, left, right, top, W, evRowH, C, t0, t1 });
  if (evs.length) {
    s += `<line x1="0" x2="${W}" y1="${dsTop - 9}" y2="${dsTop - 9}" stroke="${C.line}"/>` +
         `<text x="6" y="${dsTop + 2}" font-size="9" font-weight="600" letter-spacing=".08em" fill="${C.text}">SATELLITE OBSERVATIONS</text>`;
  }
  const wc = PHENOMENA.water.water;
  const maxRain = Math.max(0.1, ...rows.filter(isRain).flatMap(r => r.frames.filter(f => f.rain).map(f => f.rain.mean)));
  rows.forEach((r, i) => {
    const y = dsTop + 8 + i * rowH + rowH / 2;
    const ramp = PHENOMENA[r.ds.phenomenon].ramp;
    s += `<text x="6" y="${y + 4}" font-size="11" fill="${C.ink}">${esc(r.ds.name.replace(/^OPERA /, '').replace(/ \(.*\)$/, ''))}</text>`;
    s += `<line x1="${left}" x2="${W - right}" y1="${y}" y2="${y}" stroke="${C.line}"/>`;
    (r.acqDates || []).forEach(a => {
      const xx = x(a);
      s += `<line x1="${xx}" x2="${xx}" y1="${y - 4}" y2="${y + 4}" stroke="${ramp[1]}" stroke-opacity=".5"/>`;
    });
    r.frames.forEach(f => {
      const xx = x(f.date);
      if (isRain(r) && f.rain) {
        const hgt = Math.max(1, (f.rain.mean / maxRain) * (rowH - 6));
        s += `<rect x="${xx - 2}" y="${y + rowH / 2 - 3 - hgt}" width="4" height="${hgt}" fill="#6b7f99"><title>GPM IMERG · ${f.date}\nArea mean ${f.rain.mean.toFixed(2)} mm/h · max ${f.rain.max.toFixed(1)} mm/h (00:00 UTC snapshot)</title></rect>`;
        return;
      }
      if (f.error || !f.stats) {
        s += `<text x="${xx - 3}" y="${y + 4}" font-size="10" fill="${C.err}"><title>${esc(f.date)}: ${esc(f.error || 'no data')}</title>×</text>`;
      } else if (isWater(r)) {
        const st = f.stats;
        const tip = `${esc(r.ds.name)} · ${f.date}${f.role === 'baseline' ? ' (pre-event baseline)' : ''}\n` +
          `Valid coverage ${st.coveragePct.toFixed(0)} % · water ${fmtKm(st.waterKm2)} km²` +
          (f.role === 'post' ? ` · newly inundated ${fmtKm(st.newKm2)} km²` : '');
        if (f.role === 'baseline') {
          s += `<rect x="${xx - 4.5}" y="${y - 4.5}" width="9" height="9" fill="${wc.normal}" stroke="#2c4a6e"><title>${tip}</title></rect>`;
        } else {
          const weak = st.coveragePct < 25;
          const fill = weak ? '#ffffff' : st.newKm2 >= Math.max(0.05, 0.005 * st.validKm2) ? wc.new : '#ffffff';
          s += `<circle cx="${xx}" cy="${y}" r="5" fill="${fill}" stroke="${weak ? '#9aa3ae' : '#0b4f8a'}" stroke-width="1.5" ${weak ? 'stroke-dasharray="2 2"' : ''}><title>${tip}${weak ? '\nLow coverage – insufficient data' : ''}</title></circle>`;
        }
      } else {
        const lv = overallLevel(f.stats, res.grid.aoiKm2);
        const fill = lv ? ramp[lv - 1] : '#ffffff';
        s += `<circle cx="${xx}" cy="${y}" r="5" fill="${fill}" stroke="${ramp[3]}" stroke-width="1.5">` +
             `<title>${esc(r.ds.name)} · ${f.date}\n${fmtKm(f.stats.affected)} km² detected (${LEVELS[lv - 1]?.name || 'none'})</title></circle>`;
      }
    });
    if (r.status !== 'live') {
      s += `<text x="${left + 6}" y="${y + 3}" font-size="10" fill="${C.err}" paint-order="stroke" stroke="#fff" stroke-width="3">${r.status === 'no-data' ? 'no NASA acquisitions in this period' : r.status === 'failed' ? 'not usable – see Data sources' : r.status + '…'}</text>`;
    }
  });
  if (state.dates.length) {
    const xx = x(state.dates[state.dateIdx]);
    s += `<line x1="${xx}" x2="${xx}" y1="${top - 6}" y2="${H - 10}" stroke="${C.accent}" stroke-width="2"/>`;
  }
  s += `<text x="6" y="${H - 3}" font-size="9" fill="${C.text}">Event track: solid = observed · hatched = date uncertainty window · ▲ peak · ┊ reported date  |  ticks = NASA acquisitions · ● analysed · ■ water baseline · ◌ low coverage · × no image</text>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = s;
  svg.querySelectorAll('[data-ev]').forEach(g => {
    g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectEvent(g.dataset.ev); } });
  });
  svg.onclick = ev => {
    const hit = ev.target.closest && ev.target.closest('[data-ev]');
    if (hit) { selectEvent(hit.dataset.ev); return; }
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const t = t0 + ((px - left) / (W - left - right)) * (t1 - t0);
    let best = 0, bd = Infinity;
    state.dates.forEach((dd, i) => { const dt = Math.abs(Date.parse(dd) - t); if (dt < bd) { bd = dt; best = i; } });
    selectDate(best);
  };
}
/** SVG for the event track: one row per phenomenon. */
function eventTrackSvg(evs, g) {
  if (!evs.length) return '';
  const { x, left, right, top, W, evRowH, C } = g;
  const clampX = d => Math.max(left, Math.min(W - right, x(d)));
  const endX = d => clampX(new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10));   // end of that day
  let s = `<defs><pattern id="ev-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="5" stroke="currentColor" stroke-width="2.2" stroke-opacity=".55"/></pattern>
    <linearGradient id="ev-fade-l"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="ev-fade-r"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity="1"/></linearGradient></defs>`;
  s += `<text x="6" y="${top + 6}" font-size="9" font-weight="600" letter-spacing=".08em" fill="${C.text}">EVENTS</text>`;
  evs.forEach((ev, i) => {
    const y = top + 14 + i * evRowH, h = 12, cy = y + h / 2;
    const col = ev.phenomenon === 'water' ? PHENOMENA.water.water.new : PHENOMENA[ev.phenomenon].ramp[2];
    const active = ev.id === state.activeEvent;
    const statusTxt = { detected: '', ongoing: ' · ongoing', insufficient: ' · uncertain', none: ' · none', 'no-data': ' · no data' }[ev.status];
    s += `<text x="6" y="${cy + 4}" font-size="11" fill="${C.ink}" ${active ? 'font-weight="600"' : ''}>${esc(ev.title)}<tspan fill="${C.text}" font-size="10">${statusTxt}</tspan></text>`;
    if (ev.status === 'none' || ev.status === 'no-data') {
      s += `<text x="${left + 4}" y="${cy + 4}" font-size="10" fill="${C.text}">${ev.status === 'none' ? 'Not detected in any valid observation' : 'No usable observations'}</text>`;
      return;
    }
    const label = ev.status === 'insufficient'
      ? `${ev.title}: uncertain – ${ev.confidenceReasons[0]}`
      : `${ev.title}\nOnset: ${ev.onset.earliest ? `${ev.onset.earliest} → ${ev.onset.latest}` : `on or before ${ev.onset.latest}`}\n` +
        `Peak observed: ${ev.peak.date} (${fmtKm(ev.peak.value)} km²)\nEnd: ${ev.end ? `${ev.end.earliest} → ${ev.end.latest}` : 'not observed (ongoing or unknown)'}\nConfidence in dates: ${ev.confidence}\nClick to view this period`;
    s += `<g data-ev="${ev.id}" tabindex="0" role="button" aria-label="${esc(label.replace(/\n/g, '. '))}" class="ev-band${active ? ' active' : ''}" style="color:${col};cursor:pointer"><title>${esc(label)}</title>`;
    if (ev.status === 'insufficient') {
      const x1 = clampX(ev.band.start), x2 = endX(ev.band.end);
      s += `<rect x="${x1}" y="${y}" width="${Math.max(4, x2 - x1)}" height="${h}" fill="url(#ev-hatch)" style="color:#8a94a3" stroke="#8a94a3" stroke-dasharray="3 2"/>`;
      s += `<text x="${x1 + 4}" y="${cy + 3.5}" font-size="9" fill="${C.ink}" paint-order="stroke" stroke="#fff" stroke-width="3">uncertain – insufficient evidence</text></g>`;
      return;
    }
    const b = ev.band;
    const xs = clampX(b.start), xc1 = clampX(b.coreStart), xc2 = endX(b.coreEnd), xe = endX(b.end);
    // uncertainty windows (hatched) and observed core (solid)
    if (xc1 > xs) s += `<rect x="${xs}" y="${y}" width="${xc1 - xs}" height="${h}" fill="url(#ev-hatch)"/>`;
    if (xe > xc2) s += `<rect x="${xc2}" y="${y}" width="${xe - xc2}" height="${h}" fill="url(#ev-hatch)"/>`;
    s += `<rect x="${xc1}" y="${y}" width="${Math.max(4, xc2 - xc1)}" height="${h}" fill="${col}"/>`;
    if (b.openStart) s += `<rect x="${xs}" y="${y}" width="${Math.min(24, xc1 - xs)}" height="${h}" fill="url(#ev-fade-l)"/><text x="${xs + 1}" y="${cy + 3.5}" font-size="10" fill="${C.text}">‹</text>`;
    if (b.openEnd) s += `<rect x="${Math.max(xc2, xe - 24)}" y="${y}" width="${Math.min(24, xe - xc2)}" height="${h}" fill="url(#ev-fade-r)"/><text x="${xe - 7}" y="${cy + 3.5}" font-size="10" fill="${C.text}">›</text>`;
    if (active) s += `<rect x="${xs - 1}" y="${y - 2}" width="${xe - xs + 2}" height="${h + 4}" fill="none" stroke="${C.ink}" stroke-width="1.2"/>`;
    // markers: onset (first affected), peak, recession, end (first clear after)
    s += `<line x1="${xc1}" x2="${xc1}" y1="${y - 3}" y2="${y + h + 3}" stroke="${C.ink}" stroke-width="1.5"><title>First ${ev.kind === 'fire' ? 'active-fire detection' : 'affected observation'}: ${ev.firstAffected}</title></line>`;
    const px = x(ev.peak.date) + (endX(ev.peak.date) - x(ev.peak.date)) / 2;
    s += `<path d="M${px - 4.5},${y - 1} L${px + 4.5},${y - 1} L${px},${y + 6} Z" fill="${C.ink}"><title>Peak observed ${ev.valueLabel}: ${fmtKm(ev.peak.value)} km² on ${ev.peak.date} (${esc(ev.peak.source)})</title></path>`;
    if (ev.recession && ev.recession.date !== (ev.end && ev.end.latest)) {
      const rx = clampX(ev.recession.date);
      s += `<path d="M${rx - 3.5},${y + h + 1} L${rx + 3.5},${y + h + 1} L${rx},${y + h - 5} Z" fill="${C.text}"><title>Recession observed ${ev.recession.date}: ${esc(ev.recession.basis)}</title></path>`;
    }
    if (ev.end) s += `<line x1="${xe}" x2="${xe}" y1="${y - 3}" y2="${y + h + 3}" stroke="${C.ink}" stroke-width="1.5"><title>First observation after the event: ${ev.end.latest}</title></line>`;
    s += '</g>';
    // reported (documented) dates – separate from satellite evidence
    for (const r of ev.reported || []) {
      const rx = x(r.date);
      if (rx < left || rx > W - right) continue;
      const colr = r.type === 'containment' ? '#2e7a4d' : '#a8650a';
      s += `<g><title>${esc(r.label)} – ${r.date}\nSource: ${esc(r.source)}\n(reported date, not derived from satellite data)</title>` +
           `<line x1="${rx}" x2="${rx}" y1="${y - 4}" y2="${y + h + 4}" stroke="${colr}" stroke-width="1.5" stroke-dasharray="2 2"/>` +
           `<path d="M${rx},${y - 6} l6,2.5 l-6,2.5 Z" fill="${colr}"/></g>`;
    }
  });
  return s;
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => drawTimelineSvg()).observe($('#tl-svg').parentElement);
else window.addEventListener('resize', () => drawTimelineSvg());

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
      c.save(); c.strokeStyle = '#1d5fa6'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(xx, chart.chartArea.top); c.lineTo(xx, chart.chartArea.bottom); c.stroke(); c.restore();
    }
  };
  // shade the selected event: observed period solid, uncertainty windows lighter
  const eventShade = {
    id: 'eventShade',
    beforeDatasetsDraw(chart) {
      const ev = activeEvent();
      const xs = chart.scales.x;
      if (!ev || !ev.band || ev.status === 'insufficient' || !xs) return;
      const px = d => { const i = labels.indexOf(d); return i >= 0 ? xs.getPixelForValue(i) : d < labels[0] ? chart.chartArea.left : chart.chartArea.right; };
      const { top, bottom } = chart.chartArea, c = chart.ctx;
      c.save();
      c.fillStyle = 'rgba(29,95,166,.06)';
      c.fillRect(px(ev.band.start), top, px(ev.band.end) - px(ev.band.start), bottom - top);
      c.fillStyle = 'rgba(29,95,166,.14)';
      c.fillRect(px(ev.band.coreStart), top, Math.max(2, px(ev.band.coreEnd) - px(ev.band.coreStart)), bottom - top);
      c.restore();
    }
  };
  const live = liveResults();
  const datasets = live.filter(r => !isRain(r)).map(r => {
    const ramp = PHENOMENA[r.ds.phenomenon].ramp;
    const water = isWater(r);
    return {
      label: water ? `${r.ds.name} – newly inundated` : `${r.ds.name} (${r.ds.kind})`,
      data: labels.map(d => {
        const f = r.frames.find(ff => ff.stats && ff.date === d);
        if (!f) return null;
        if (water) return f.role === 'post' && f.stats.coveragePct >= 25 ? +f.stats.newKm2.toFixed(3) : null;
        return +f.stats.affected.toFixed(3);
      }),
      borderColor: water ? ramp[2] : ramp[2], backgroundColor: ramp[2],
      borderDash: r.ds.kind === 'SAR' ? [6, 4] : [],
      spanGaps: true, tension: 0.2, pointRadius: 3, borderWidth: 1.5, yAxisID: 'y'
    };
  });
  const rain = live.find(isRain);
  if (rain) {
    datasets.push({
      type: 'bar', label: 'GPM IMERG rain, area mean (mm/h, context)', yAxisID: 'rain',
      data: labels.map(d => { const f = rain.frames.find(ff => ff.rain && ff.date === d); return f ? +f.rain.mean.toFixed(2) : null; }),
      backgroundColor: 'rgba(107,127,153,.35)', borderWidth: 0, barThickness: 6
    });
  }
  const font = { size: 10, family: getComputedStyle(document.body).fontFamily };
  state.chart = new Chart($('#chart'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'nearest', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font } },
        title: { display: true, text: 'Detected area per dataset (km²) – water: newly inundated only', font: { ...font, size: 11 }, color: '#1b2430' },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y}${c.dataset.yAxisID === 'rain' ? ' mm/h' : ' km²'}` } }
      },
      scales: {
        y: { beginAtZero: true, ticks: { font }, grid: { color: '#eceff3' }, title: { display: true, text: 'km²', font } },
        rain: { display: !!rain, position: 'right', beginAtZero: true, ticks: { font }, grid: { display: false }, title: { display: true, text: 'mm/h', font } },
        x: { ticks: { font, maxRotation: 0, autoSkip: true }, grid: { display: false } }
      },
      onClick: (e, els, chart) => {
        const idx = chart.scales.x.getValueForPixel(e.x);
        if (Number.isFinite(idx)) selectDate(Math.round(idx));
      }
    },
    plugins: [eventShade, cursor]
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
      const f = isRain(r) ? r.frames.filter(ff => ff.rain && ff.date <= date).at(-1) : frameAt(r, date);
      if (f) addRaster('gibs-' + r.ds.id, tileUrl(r.ds.gibs, f.date), 0.9);
    }
  } else {
    const url = classifiedImage(date);
    if (url) {
      const [W, S, E, N] = state.results.grid.bbox;
      map.addSource('classified', { type: 'image', url, coordinates: [[W, N], [E, N], [E, S], [W, S]] });
      map.addLayer({ id: 'classified', type: 'raster', source: 'classified', paint: { 'raster-opacity': 0.92, 'raster-resampling': 'nearest' } }, 'mask-fill');
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
  const put = (p, [r, g, b], a) => { img.data[p * 4] = r; img.data[p * 4 + 1] = g; img.data[p * 4 + 2] = b; img.data[p * 4 + 3] = a; };
  const order = state.results.phen.filter(p => p !== 'water').sort((a, b) => PHENOMENA[a].priority - PHENOMENA[b].priority);
  let any = false;
  for (const pid of order) {
    const sum = summarize(pid, date);
    if (!sum) continue;
    const ramp = PHENOMENA[pid].ramp.map(hexToRgb);
    const m = sum.merged;
    for (let p = 0; p < m.length; p++) {
      const lv = m[p];
      if (lv >= 1 && lv <= 4) { put(p, ramp[lv - 1], 235); any = true; }
    }
  }
  // Water: only pixels actually classified as water are drawn (never the whole area).
  if (state.results.phen.includes('water')) {
    const ws = summarizeWater(date);
    const wc = PHENOMENA.water.water;
    const cNormal = hexToRgb(wc.normal), cNew = hexToRgb(wc.new), cUnknown = hexToRgb(wc.unknown), cOut = [128, 136, 146];
    const h = ws.headline;
    if (h) {
      const base = h.r.baseline;
      for (let p = 0; p < grid.w * grid.h; p++) {
        if (!grid.mask[p]) continue;
        if (state.showBaseline) {
          if (base && base[p] === 1) { put(p, cNormal, 230); any = true; }
          else if ((!base || base[p] === OUT) && ((p % grid.w) + Math.floor(p / grid.w)) % 6 < 2 && !img.data[p * 4 + 3]) { put(p, cOut, 110); any = true; }
          continue;
        }
        const st = h.f.status[p];
        if (st === 1) { put(p, cNormal, 225); any = true; }
        else if (st === 2) { put(p, cNew, 245); any = true; }
        else if (st === 3) { put(p, cUnknown, 225); any = true; }
        else if (st === OUT && !img.data[p * 4 + 3] && ((p % grid.w) + Math.floor(p / grid.w)) % 6 < 2) { put(p, cOut, 110); any = true; }
      }
    }
  }
  if (!any) return null;
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

document.querySelectorAll('.seg button[data-view]').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button[data-view]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  state.view = b.dataset.view;
  renderMapLayers();
  renderLegend();
}));

function renderLegend() {
  const el = $('#legend');
  const phen = state.results ? state.results.phen : selectedPhenomena();
  if (state.view === 'original') {
    setLegend(el, state.results
      ? `<h4>NASA original colours</h4><div class="lg-note">NASA's own visualisation of the datasets ticked in Data sources. Switch to <b>Analysed</b> for this app's classification.</div>`
      : '');
    return;
  }
  const scaled = phen.filter(p => p !== 'water');
  const wc = PHENOMENA.water.water;
  const date = state.dates[state.dateIdx];
  let mapNote = '';
  if (phen.includes('water') && state.results && date) {
    const ws = summarizeWater(date);
    if (ws.headline) mapNote = state.showBaseline
      ? `Showing pre-event baseline of ${esc(ws.headline.r.ds.name)} (${esc(ws.headline.r.baselineDates.join(', ') || '—')})`
      : `Water layer: ${esc(ws.headline.r.ds.name)}, ${esc(ws.headline.f.date)}`;
  }
  setLegend(el, `
    ${scaled.length ? `<h4>Change intensity</h4>
    <div class="lg-head"><span></span>${LEVELS.map(l => `<span>${l.name}</span>`).join('')}</div>
    ${scaled.map(pid => {
      const p = PHENOMENA[pid];
      return `<div class="lg-row"><span>${p.short}</span>${p.ramp.map((c, i) => `<span class="sw" style="background:${c}" title="${esc(p.levelHelp[i])}"></span>`).join('')}</div>`;
    }).join('')}` : ''}
    ${phen.includes('water') ? `<h4 ${scaled.length ? 'class="lg-gap"' : ''}>Surface water <span class="term" tabindex="0" data-term="categorical">categories</span></h4>
      <div class="lg-cats">
        <span><i class="sw" style="background:${wc.new}"></i>Newly inundated</span>
        <span><i class="sw" style="background:${wc.normal}"></i>Normal / permanent water</span>
        <span><i class="sw" style="background:${wc.unknown}"></i>Water, no baseline</span>
        <span><i class="sw hatch"></i>Not observed</span>
      </div>${mapNote ? `<div class="lg-note">${mapNote}</div>` : ''}` : ''}
    <div class="lg-note">Orange outline = your area of interest.</div>`);
}

// Collapsible legend; starts collapsed when the map is narrow, then remembers the choice.
function setLegend(el, body) {
  if (!body) { el.innerHTML = ''; return; }
  const open = prefs.legendOpen ?? ($('#map-wrap').clientWidth >= 760);
  el.classList.toggle('closed', !open);
  el.innerHTML = `<button type="button" class="lg-toggle" aria-expanded="${open}">Legend</button><div class="lg-body">${body}</div>`;
  el.querySelector('.lg-toggle').addEventListener('click', () => {
    prefs.legendOpen = el.classList.contains('closed');
    savePrefs();
    renderLegend();
  });
}

// ============================================================ findings panel
const CONF_CLASS = { High: 'c-high', Medium: 'c-med', Low: 'c-low', 'Insufficient data': 'c-none' };

function renderFindings() {
  const el = $('#findings');
  if (!state.results || !state.dates.length) return;
  const date = state.dates[state.dateIdx];
  const grid = state.results.grid;
  el.innerHTML = `<p class="f-context">Area of interest <b>${fmtKm(grid.aoiKm2)} km²</b> · date <b>${date}</b> (latest observation of each dataset on or before this date)</p>` +
    eventSummary(date) +
    state.results.phen.map(pid => (pid === 'water' ? waterFinding(date) : intensityFinding(pid, date))).join('');
  el.querySelectorAll('[data-goto-ev]').forEach(b => b.addEventListener('click', () => selectEvent(b.dataset.gotoEv, b.dataset.phase)));
}

/** Event card for the selected event (top of Findings). */
function eventSummary(date) {
  const evs = state.results.events || [];
  if (!evs.length) return '';
  const ev = activeEvent() || evs.find(e => e.firstAffected) || evs[0];
  const others = evs.filter(e => e !== ev && e.firstAffected);
  const ph = phaseOf(ev, date);
  const CONF = { High: 'c-high', Medium: 'c-med', Low: 'c-low', 'Insufficient data': 'c-none' };
  let body;
  if (!ev.firstAffected) {
    body = `<p class="f-note">${ev.status === 'insufficient'
      ? `<b>Uncertain event period.</b> ${esc(ev.confidenceReasons[0])}. No dates are estimated.`
      : ev.status === 'none' ? 'Not detected in any valid observation in this period.' : 'No usable observations in this period.'}</p>`;
  } else {
    const fireNote = ev.kind === 'fire'
      ? `<p class="f-note">Last satellite detection is <b>not</b> containment. Clouds, smoke and overpass times can hide active fire; containment comes from agency reports.</p>` : '';
    body = `<dl class="facts">
      <dt>Onset</dt><dd>${windowText(ev.onset.earliest, ev.onset.latest)}</dd>
      <dt>${ev.kind === 'fire' ? 'Detections' : 'Observed'}</dt><dd>${fmtDay(ev.firstAffected)} → ${fmtDay(ev.lastAffected)} <small>(${ev.supporting.length} supporting obs.)</small></dd>
      <dt>Peak observed</dt><dd>${fmtKm(ev.peak.value)} km² · ${fmtDay(ev.peak.date)} <small>${esc(ev.peak.source)}</small></dd>
      ${ev.recession ? `<dt>Recession</dt><dd>${fmtDay(ev.recession.date)} <small>${esc(ev.recession.basis)}</small></dd>` : ''}
      <dt>${ev.kind === 'fire' ? 'End of detections' : 'End / recovery'}</dt><dd>${ev.end ? windowText(ev.end.earliest, ev.end.latest) : '<span class="muted">not observed – ongoing or unknown</span>'}</dd>
      ${(ev.reported || []).map(r => `<dt class="reported">${r.type === 'containment' ? 'Containment' : r.type === 'user' ? 'Event date' : 'Reported'}</dt><dd>${fmtDay(r.date)} <small>${esc(r.label)} · ${esc(r.source)} · reported, not satellite-derived</small></dd>`).join('')}
      <dt><span class="term" tabindex="0" data-term="eventconf">Date confidence</span></dt><dd><span class="conf ${CONF[ev.confidence]}">${ev.confidence}</span>
        <details class="why"><summary>Method</summary><p>${esc(ev.method)}</p><ul>${ev.confidenceReasons.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details></dd>
      <dt>Sources</dt><dd><small>${ev.sources.map(esc).join(' · ')}</small></dd>
    </dl>${fireNote}
    <div class="phase-links">${['before', 'during', 'after'].map(p => {
      const t = phaseTargets(ev, state.dates)[p];
      return `<button type="button" class="btn ${ph === p ? 'on' : ''}" data-goto-ev="${ev.id}" data-phase="${p}" ${t ? '' : 'disabled'}>${p[0].toUpperCase() + p.slice(1)}${t ? ` <small>${t}</small>` : ''}</button>`;
    }).join('')}</div>`;
  }
  return `<section class="finding event-card">
    <header class="f-head"><h3>Event · ${esc(ev.title)}</h3><span class="ev-status st-${ev.status}">${{ detected: 'Start and end observed', ongoing: 'Ongoing / end not observed', insufficient: 'Uncertain', none: 'Not detected', 'no-data': 'No data' }[ev.status]}</span></header>
    ${body}
    ${others.length ? `<p class="f-note">Other events: ${others.map(o => `<button type="button" class="btn-link" data-goto-ev="${o.id}" data-phase="during">${esc(o.title)}</button>`).join(' · ')}</p>` : ''}
  </section>`;
}

function intensityFinding(pid, date) {
  const p = PHENOMENA[pid];
  const grid = state.results.grid;
  const sum = summarize(pid, date);
  if (!sum) {
    return `<section class="finding"><header class="f-head"><h3>${p.name}</h3><span class="badge none">No data</span></header>
      <p class="f-note">None of this phenomenon's NASA datasets had usable images for this area and period. See Data sources.</p></section>`;
  }
  const st = sum.stats;
  const lvName = sum.level ? LEVELS[sum.level - 1].name : st.affected > 0 ? 'Below threshold' : 'None detected';
  const badgeStyle = sum.level ? `style="background:${p.ramp[sum.level - 1]};${sum.level <= 1 ? 'color:#1b2430' : ''}"` : '';
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
    return `<span class="chip" title="${esc(r.ds.satellites)}"><b>${esc(r.ds.name)}</b> · ${termFor(r.ds.kind)} · ${f.date} · ${fmtKm(f.stats.affected)} km²</span>`;
  }).join('');
  const agree = sum.rs.length > 1
    ? `<p class="f-agree">Detected by 2+ independent sensors: <b>${fmtKm(sum.agreeKm2)} km²</b> (highest confidence)</p>` : '';
  const observed = sum.rs.some(r => r.ds.method === 'sar')
    ? `Radar intensity = how much the <span class="term" tabindex="0" data-term="backscatter">backscatter</span> dropped compared with the first date (<span class="term" tabindex="0" data-term="change">change detection</span>).` : '';
  return `<section class="finding">
    <header class="f-head"><h3>${p.name}</h3><span class="badge ${sum.level ? '' : 'none'}" ${badgeStyle} title="Highest intensity level covering at least 0.25 km² or 0.5 % of the area">${lvName}</span></header>
    <div class="f-big">${fmtKm(st.affected)} km² <small>detected · ${st.affectedPctOfAoi.toFixed(1)} % of area</small></div>
    <div class="f-trend ${trendCls}">${trendTxt}</div>
    <div class="stack">${stack}</div>
    <table class="levels">${rows}</table>
    ${agree}
    <div class="chips">${chips}</div>
    ${observed ? `<p class="f-note">${observed}</p>` : ''}
  </section>`;
}

function termFor(kind) {
  const k = { SAR: 'SAR', Optical: 'optical', Thermal: 'thermal', 'Ocean colour': 'ocean colour', Precipitation: 'precipitation' }[kind] || kind;
  return kind === 'SAR' ? `<span class="term" tabindex="0" data-term="SAR">SAR</span>` : esc(k);
}

function waterFinding(date) {
  const p = PHENOMENA.water;
  const ws = summarizeWater(date);
  const sensorWord = r => `${esc(r.ds.name)} (${termFor(r.ds.kind)})`;
  if (!ws.headline) {
    return `<section class="finding water"><header class="f-head"><h3>${p.name}</h3><span class="badge none">Insufficient data</span></header>
      <p class="f-note">No usable water observation for this area and period. See Data sources for each product's status.</p>
      ${rainLine(ws)}</section>`;
  }
  const { headline: h, confidence: conf, verdict } = ws;
  const st = h.f.stats;
  const isBase = h.f.role === 'baseline';
  const insufficient = verdict === 'Insufficient data';
  const vClass = verdict === 'New water detected' ? 'v-new' : verdict === 'No new water detected' ? 'v-none' : 'v-na';
  const baseDates = h.r.baselineDates || [];
  const wc = p.water;
  const covBar = `<div class="meter" title="Valid observed share of the area"><i style="width:${Math.min(100, st.coveragePct).toFixed(1)}%"></i></div>`;
  const big = isBase
    ? `<div class="f-big">${fmtKm(st.waterKm2)} km² <small>water in the pre-event baseline</small></div>`
    : insufficient
      ? `<div class="f-big muted">— <small>newly inundated area cannot be determined</small></div>`
      : `<div class="f-big">${fmtKm(st.newKm2)} km² <small>newly inundated · ${st.newPctOfObserved.toFixed(1)} % of the observable area</small></div>`;
  const srcRows = ws.rows.map(x => {
    const s = x.f.stats;
    const ag = x.agreement && x.agreement.agreePct !== null ? `${x.agreement.agreePct.toFixed(0)} %`
      : x === h ? 'reference' : x.tooFar ? '<span title="Observed more than 3 days apart – not compared">n/a</span>' : '—';
    return `<tr class="${x === h ? 'is-head' : ''}"><td>${esc(x.r.ds.name.replace(/^OPERA /, ''))}<small>${termFor(x.r.ds.kind)} · ${esc(x.r.ds.resolution)}</small></td>
      <td>${x.f.date}${x.f.role === 'baseline' ? '<small>baseline</small>' : ''}</td>
      <td class="num">${s.coveragePct.toFixed(0)} %</td><td class="num">${fmtKm(s.waterKm2)}</td>
      <td class="num">${x.f.role === 'post' && x.r.baseline ? fmtKm(s.newKm2) : '—'}</td><td class="num">${ag}</td></tr>`;
  }).join('');
  return `<section class="finding water">
    <header class="f-head"><h3>${p.name}</h3><span class="verdict ${vClass}">${verdict}</span></header>
    ${big}
    <dl class="facts">
      <dt>Water extent</dt><dd>${fmtKm(st.waterKm2)} km² <small>(${st.waterPctOfObserved.toFixed(1)} % of observed)</small></dd>
      <dt><span class="sw-inline" style="background:${wc.normal}"></span>Normal / permanent</dt><dd>${fmtKm(st.normalKm2)} km²</dd>
      <dt><span class="sw-inline" style="background:${wc.new}"></span>Newly inundated</dt><dd>${isBase ? '— (baseline)' : !h.r.baseline ? '— (no baseline)' : `${fmtKm(st.newKm2)} km²`}</dd>
      ${st.unknownKm2 > 0.005 ? `<dt><span class="sw-inline" style="background:${wc.unknown}"></span>Water, no baseline</dt><dd>${fmtKm(st.unknownKm2)} km² <small>not counted as new</small></dd>` : ''}
      ${st.partialKm2 + st.inundatedVegKm2 > 0.005 ? `<dt>of which</dt><dd><small>${st.partialKm2 > 0.005 ? `<span class="term" tabindex="0" data-term="partial">partial water</span> ${fmtKm(st.partialKm2)} km²` : ''}${st.partialKm2 > 0.005 && st.inundatedVegKm2 > 0.005 ? ' · ' : ''}${st.inundatedVegKm2 > 0.005 ? `<span class="term" tabindex="0" data-term="inundated">inundated vegetation</span> ${fmtKm(st.inundatedVegKm2)} km²` : ''}</small></dd>` : ''}
      <dt><span class="term" tabindex="0" data-term="coverage">Valid coverage</span></dt><dd>${st.coveragePct.toFixed(0)} % of area ${covBar}</dd>
      <dt><span class="term" tabindex="0" data-term="confidence">Confidence</span></dt><dd><span class="conf ${CONF_CLASS[conf.level]}">${conf.level}</span>
        <details class="why"><summary>Why?</summary><ul>${conf.reasons.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details></dd>
      <dt><span class="term" tabindex="0" data-term="baseline">Baseline</span></dt><dd>${baseDates.length ? `${baseDates[0]}${baseDates.length > 1 ? ` → ${baseDates.at(-1)}` : ''} <small>(${baseDates.length} obs., ${h.r.baselineCoverPct.toFixed(0)} % of area known)</small>` : '<span class="muted">none</span>'}</dd>
      <dt>Observation</dt><dd>${h.f.date} · ${sensorWord(h.r)}</dd>
    </dl>
    <table class="src-table">
      <thead><tr><th>Source</th><th>Date</th><th class="num">Cover</th><th class="num">Water km²</th><th class="num">New km²</th><th class="num" title="Agreement with the headline source on new/not-new, over pixels both observed">Agree</th></tr></thead>
      <tbody>${srcRows}</tbody>
    </table>
    <p class="f-note">Sensors are compared, not averaged: the headline uses the source with the best valid coverage. Severity is not assigned to floods – there is no defensible severity scale from water extent alone.</p>
    ${rainLine(ws)}
  </section>`;
}

function rainLine(ws) {
  if (!ws.rain) return '';
  if (!ws.rainInfo) return `<p class="f-rain">Rainfall context (GPM IMERG): no reading on or before this date.</p>`;
  const pk = ws.rainInfo.peak;
  return `<p class="f-rain"><b>Rainfall context</b> (<span class="term" tabindex="0" data-term="IMERG">GPM IMERG</span>): highest area-mean rate ${pk.rain.mean.toFixed(2)} mm/h on ${pk.date} (max ${pk.rain.max.toFixed(1)} mm/h, ${ws.rainInfo.count} snapshots). Rain shows a flood was possible; it does not prove flooding.</p>`;
}

// ============================================================ data sources panel
function renderSources() {
  const el = $('#sources');
  const res = state.results;
  const notes = `<h4 class="s-section">Other sources evaluated for floods</h4>` + SOURCE_NOTES.map(n =>
    `<div class="s-note"><b>${esc(n.name)}</b> <span class="s-tag">${esc(n.used)}</span><p>${esc(n.why)}</p></div>`).join('');
  if (!res) { el.innerHTML = '<p class="empty">Run an analysis to see which NASA datasets were used.</p>' + notes; return; }
  const date = state.dates[state.dateIdx];
  const statusText = { queued: 'Queued', searching: 'Searching NASA catalogue…', loading: 'Downloading NASA images…', live: 'Live data', failed: 'Not usable', 'no-data': 'No acquisitions' };
  el.innerHTML = `<p class="f-context">Every number comes from these NASA sources. Catalogue counts are live queries to <span class="term" tabindex="0" data-term="CMR">NASA CMR</span>; images are <span class="term" tabindex="0" data-term="GIBS">NASA GIBS</span> visualisations.</p>` +
    [...res.byId.values()].map(r => {
      const ds = r.ds;
      const ramp = PHENOMENA[ds.phenomenon].ramp;
      const ok = r.frames.filter(f => f.stats || f.rain);
      const cur = date ? (isRain(r) ? r.frames.filter(f => f.rain && f.date <= date).at(-1) : frameAt(r, date)) : null;
      const kindCls = ds.kind.split(' ')[0];
      const cmrLine = r.cmr
        ? `CMR catalogue: <b>${r.cmr.hits.toLocaleString()}</b> granules over your area` +
          (r.cmr.dates.length ? ` on <b>${r.cmr.dates.length}</b> days (${r.cmr.dates[0]} → ${r.cmr.dates.at(-1)})` : '') +
          ` · <a href="${esc(r.cmr.query)}" target="_blank" rel="noopener">verify query</a>`
        : (r.status === 'queued' || r.status === 'searching' ? 'CMR catalogue: searching…' : 'CMR catalogue: unavailable');
      let method;
      if (ds.method === 'sar') method = `Method: radar <span class="term" tabindex="0" data-term="backscatter">backscatter</span> darkening vs reference image${r.reference ? ` (${r.reference})` : ''}`;
      else if (ds.method === 'presence') method = 'Method: every NASA fire-detection pixel counts';
      else if (ds.method === 'water') {
        const info = r.classifier ? r.classifier.info : [];
        const used = info.filter(i => i.cls !== OUT).map(i => `${esc(i.label)} → ${W_NAMES[i.cls]}`);
        const excl = info.filter(i => i.cls === OUT).map(i => esc(i.label));
        method = r.classifier
          ? `Method: categorical water classes from NASA's colour map.<br><span class="s-sub">Used: ${used.join(' · ') || '—'}</span><br><span class="s-sub">Excluded as invalid: ${excl.join(' · ') || '—'}</span>` +
            (r.classifier.transparentIsDry ? '<br><span class="s-sub">“Not water” is drawn transparent by NASA, so empty pixels count as dry only on dates with a catalogued acquisition.</span>' : '') +
            (r.baselineDates ? `<br>Baseline: ${r.baselineDates.length ? esc(r.baselineDates.join(', ')) : 'none'}` : '')
          : 'Method: colour map pending';
      } else if (ds.method === 'rain') method = 'Method: area-mean precipitation rate from NASA’s colour map (context only)';
      else method = r.colormap ? `Method: ${r.classifier.info.length} classes read from NASA's colour map${r.units ? ` (${esc(r.units)})` : ''}` : 'Method: colour map pending';
      const curLine = cur ? (isRain(r) ? ` · on map: <b>${cur.date}</b>` : ` · on map: <b>${cur.date}</b> (valid coverage ${(cur.coverage * 100).toFixed(0)} % of area)`) : '';
      return `<article class="source" style="--c:${ramp[2]}">
        <div class="s-head"><span class="kind kind-${kindCls}">${esc(ds.kind)}</span><b>${esc(ds.name)}</b>
          <span class="st st-${r.status}">${statusText[r.status] || r.status}</span></div>
        <div class="s-meta">${esc(ds.product)}<br>${esc(ds.satellites)} · ${esc(ds.agency)} · ${esc(ds.resolution)}</div>
        ${ds.note ? `<div class="s-line s-sub">${esc(ds.note)}</div>` : ''}
        <div class="s-line">${cmrLine}</div>
        <div class="s-line">Analysed: <b>${ok.length}</b> of ${r.frames.length || '–'} dates${curLine}</div>
        <div class="s-line">${method}</div>
        <div class="s-line s-sub">GIBS layer <code>${esc(ds.gibs)}</code> · CMR <code>${esc(ds.cmr)}</code></div>
        ${(r.mismatches || []).map(m => `<div class="s-err">Class value ${esc(m.value)} is labelled “${esc(m.label)}” by NASA; the documented code was used.</div>`).join('')}
        ${r.errors.map(e => `<div class="s-err">${esc(e)}</div>`).join('')}
        ${r.status === 'live' ? `<label class="s-show"><input type="checkbox" data-show="${ds.id}" ${state.shown.has(ds.id) ? 'checked' : ''}> Show NASA original on map (“NASA original” view)</label>` : ''}
        <div class="s-links">
          <a href="${earthdataSearchUrl(ds.cmr)}" target="_blank" rel="noopener">Earthdata Search ↗</a>
          <a href="${worldviewUrl(ds.gibs, cur ? cur.date : res.end, res.grid.bbox)}" target="_blank" rel="noopener">NASA Worldview ↗</a>
        </div>
      </article>`;
    }).join('') + notes;
  el.querySelectorAll('[data-show]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) state.shown.add(cb.dataset.show); else state.shown.delete(cb.dataset.show);
    renderMapLayers();
  }));
}

// ============================================================ tabs + export
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
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
  const lines = ['phenomenon,dataset,kind,satellites,date,image_coverage_pct,detected_km2,low_km2,moderate_km2,high_km2,severe_km2,pct_of_area,' +
    'water_role,valid_km2,water_km2,normal_water_km2,new_water_km2,new_pct_of_observed,rain_mean_mm_h,gibs_layer,cmr_short_name'];
  const n4 = v => (v == null ? '' : v.toFixed(4));
  for (const r of state.results.byId.values()) {
    for (const f of r.frames) {
      if (!f.stats && !f.rain) continue;
      const s = f.stats || {};
      const water = isWater(r), rain = isRain(r);
      lines.push([r.ds.phenomenon, `"${r.ds.name}"`, r.ds.kind, `"${r.ds.satellites}"`, f.date,
        f.coverage == null ? '' : (f.coverage * 100).toFixed(1),
        water ? n4(s.newKm2) : rain ? '' : n4(s.affected),
        ...[1, 2, 3, 4].map(l => (water || rain ? '' : n4(s.km2[l]))),
        water ? s.newPctOfObserved.toFixed(3) : rain ? '' : s.affectedPctOfAoi.toFixed(3),
        water ? f.role : '', water ? n4(s.validKm2) : '', water ? n4(s.waterKm2) : '', water ? n4(s.normalKm2) : '',
        water ? n4(s.newKm2) : '', water ? s.newPctOfObserved.toFixed(3) : '', rain ? f.rain.mean.toFixed(3) : '',
        r.ds.gibs, r.ds.cmr].join(','));
    }
  }
  download('earthscope-results.csv', lines.join('\n'), 'text/csv');
});

$('#export-json').addEventListener('click', () => {
  const res = state.results;
  const date = state.dates[state.dateIdx];
  const ws = res.phen.includes('water') && date ? summarizeWater(date) : null;
  const out = {
    generated: new Date().toISOString(),
    area: { polygon_lonlat: res.aoi.polygon, bbox: res.grid.bbox, km2: res.grid.aoiKm2 },
    period: { start: res.start, end: res.end, flood_event_date: res.eventDate || null },
    events: (res.events || []).map(e => ({
      id: e.id, phenomenon: e.phenomenon, title: e.title, status: e.status,
      onset_window: e.onset ? { earliest: e.onset.earliest, latest: e.onset.latest, basis: e.onset.basis } : null,
      first_affected_observation: e.firstAffected, last_affected_observation: e.lastAffected,
      last_unaffected_before: e.lastClearBefore, first_unaffected_after: e.firstClearAfter,
      peak: e.peak, recession: e.recession,
      end_window: e.end ? { earliest: e.end.earliest, latest: e.end.latest, basis: e.end.basis } : null,
      confidence: e.confidence, confidence_reasons: e.confidenceReasons, date_estimation_method: e.method,
      sources: e.sources, supporting_observations: e.supporting, all_observations: e.observations,
      reported_records: e.reported
    })),
    reported_records_outside_period: res.recordsOutside || [],
    flood_summary: ws && ws.headline ? {
      date, verdict: ws.verdict, confidence: ws.confidence.level, confidence_reasons: ws.confidence.reasons,
      headline_source: ws.headline.r.ds.name, observation_date: ws.headline.f.date,
      newly_inundated_km2: ws.headline.f.role === 'post' ? ws.headline.f.stats.newKm2 : null,
      new_pct_of_observed: ws.headline.f.role === 'post' ? ws.headline.f.stats.newPctOfObserved : null,
      normal_water_km2: ws.headline.f.stats.normalKm2, water_km2: ws.headline.f.stats.waterKm2,
      valid_coverage_pct: ws.headline.f.stats.coveragePct, baseline_dates: ws.headline.r.baselineDates
    } : null,
    datasets: [...res.byId.values()].map(r => ({
      id: r.ds.id, name: r.ds.name, phenomenon: r.ds.phenomenon, kind: r.ds.kind, satellites: r.ds.satellites,
      agency: r.ds.agency, gibs_layer: r.ds.gibs, cmr_short_name: r.ds.cmr, status: r.status, errors: r.errors,
      cmr: r.cmr ? { hits: r.cmr.hits, acquisition_days: r.cmr.dates, query: r.cmr.query } : null,
      water_classes: isWater(r) && r.classifier ? r.classifier.info.map(i => ({ label: i.label, value: i.value, class: i.cls === OUT ? 'invalid' : W_NAMES[i.cls] })) : undefined,
      baseline_dates: r.baselineDates,
      frames: r.frames.map(f => ({ date: f.date, role: f.role, error: f.error || null, coverage: f.coverage ?? null, stats: f.stats || null, rain_mm_h: f.rain || undefined }))
    }))
  };
  download('earthscope-results.json', JSON.stringify(out, null, 2), 'application/json');
});

// ============================================================ start-up
// ============================================================ guided tour
const panelHas = sel => () => document.querySelector(sel);
initTour([
  { title: 'Welcome to EarthScope',
    body: `<p>EarthScope measures change on Earth’s surface – vegetation loss, flooding, fires and algae blooms – from NASA radar and optical satellites.</p>
      <p>Every number comes from real NASA observations. This tour shows the eight steps of an analysis. Use the arrow keys or the buttons; press Esc to leave.</p>` },
  { title: 'Choose an area of interest', target: panelHas('#card-aoi'), before: () => revealPanel('panel-controls'),
    body: `<p>Type latitude and longitude, or pick a ready-made example. One point makes a circle, two a rectangle, three or more a polygon.</p>
      <p>You can also <b>middle-click</b> the map, or use <b>Add point</b>: move the map under the crosshair and press <b>Add point here</b>. Ordinary clicks never add points.</p>` },
  { title: 'Set the date range', target: panelHas('#card-time'), before: () => revealPanel('panel-controls'),
    body: `<p>Pick the period to analyse. For floods, set the <b>flood event date</b>: observations before it form the pre-event baseline, so permanent rivers and lakes are not counted as flooding.</p>` },
  { title: 'Select phenomena', target: panelHas('#card-phen'), before: () => revealPanel('panel-controls'),
    body: `<p>Each phenomenon uses several independent NASA products. Then press <b>Analyse with NASA data</b>.</p>` },
  { title: 'Explore the map and its layers', target: panelHas('#map-wrap'),
    body: `<p><b>Analysed</b> shows this app’s classification; <b>NASA original</b> shows NASA’s own imagery. Switch base map, add context imagery, the lat/lon grid or 3D terrain.</p>
      <p>Left-drag moves, right-drag rotates and tilts, the wheel zooms. The <b>?</b> button lists all controls.</p>` },
  { title: 'Read findings, severity and confidence', target: panelHas('#panel-results'),
    before: () => { revealPanel('panel-results'); showTab('findings'); },
    body: `<p>Vegetation, fire and chlorophyll show an intensity level (Low → Severe).</p>
      <p>Floods are reported differently: <b>newly inundated area</b>, normal water, valid coverage and a separate <b>confidence</b> rating. If the satellites did not see enough, it says <b>Insufficient data</b>.</p>` },
  { title: 'Use the event timeline', target: panelHas('#panel-timeline'), before: () => revealPanel('panel-timeline'),
    body: `<p>The <b>event track</b> shows when each event happened according to the observations: solid = observed, hatched = the window in which the start or end must lie. ▲ marks the peak; dashed flags are officially reported dates.</p>
      <p>Click a band, or use <b>Before / During / After</b>, to jump there – map, findings and chart follow. Below are the satellite tracks: ticks are acquisitions, circles analysed dates.</p>` },
  { title: 'Check data sources and export', target: panelHas('#panel-results'),
    before: () => { revealPanel('panel-results'); showTab('sources'); },
    body: `<p><b>Data sources</b> lists every NASA product used, its acquisitions, the classes read from it and anything excluded – with links to verify in Earthdata Search and Worldview.</p>
      <p>Download every number as <b>CSV</b> or <b>JSON</b>.</p>` }
]);
$('#tour-btn').addEventListener('click', startTour);

(function init() {
  initLayout(() => { if (state.chart) state.chart.resize(); });
  initTerms();
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
