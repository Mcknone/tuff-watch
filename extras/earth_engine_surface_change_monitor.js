/*****************************************************************************
 * NASA Space Apps – Earth Surface Change Monitor  (Google Earth Engine)
 *
 * HOW TO USE
 *   1. Open https://code.earthengine.google.com, paste this whole script, Run.
 *   2. Pick a phenomenon, type coordinates (or tick "Add points by clicking
 *      the map"), choose BEFORE and AFTER dates, press "Run analysis".
 *
 * AREA RULES (coordinates in decimal degrees, latitude first)
 *   1 point   -> circle with the radius you choose
 *   2 points  -> rectangle (opposite corners)
 *   3+ points -> polygon (enter corners in order around the shape)
 *
 * DATA
 *   SAR      : choose one in the panel:
 *              - Sentinel-1 GRD (C-band, ESA, in dB in Earth Engine)
 *              - NASA OPERA RTC-S1 (Sentinel-1 terrain-corrected by NASA JPL)
 *              - NISAR L-band GCOV (NASA-ISRO) - GeoTIFFs you made with
 *                nisar_to_geotiff.py and uploaded as Earth Engine assets
 *   Optical  : Sentinel-2 SR (only for algae – SAR is weak at seeing algae)
 *   Helpers  : Hansen Global Forest Change, JRC Global Surface Water, SRTM
 *****************************************************************************/

// ===================== 1. PHENOMENON SETTINGS ===============================
var PHENOMENA = {
  'Deforestation (SAR)': {
    sensor: 'S1', band: 'VH', threshold: -3, color: 'ff0000',
    thresholdLabel: 'Flag if VH (NISAR: HV) drops by more than (dB):',
    help: 'Forest pixels whose VH radar backscatter dropped sharply between ' +
          'the two periods. Tip: compare the same season (e.g. dry season).',
    example: {pts: [[-10.2, -63.4], [-9.6, -62.8]],            // Rondônia, Brazil
              dates: ['2019-06-01', '2019-09-30', '2023-06-01', '2023-09-30']}
  },
  'Flooding (SAR)': {
    sensor: 'S1', band: 'VV', threshold: -18, color: '00c3ff',
    thresholdLabel: 'Water if VV (NISAR: HH) is below (dB):',
    help: 'Pixels that look like water (very dark) AFTER but not BEFORE. ' +
          'Permanent water and steep slopes are excluded.',
    example: {pts: [[26.0, 67.4], [27.0, 68.3]],                // Sindh, Pakistan 2022
              dates: ['2022-05-01', '2022-06-15', '2022-08-25', '2022-09-15']}
  },
  'Urban growth (SAR)': {
    sensor: 'S1', band: 'VV', threshold: 4, color: 'ffd400',
    thresholdLabel: 'Flag if VV (NISAR: HH) rises by more than (dB):',
    help: 'Pixels whose VV backscatter rose strongly – new buildings act ' +
          'like corner reflectors and look very bright to radar.',
    example: {pts: [[29.95, 31.65], [30.10, 31.85]],            // New Admin. Capital, Egypt
              dates: ['2016-06-01', '2016-12-31', '2023-06-01', '2023-12-31']}
  },
  'Algae bloom (optical, Sentinel-2)': {
    sensor: 'S2', band: 'NDCI', threshold: 0.1, color: '39ff14',
    thresholdLabel: 'Bloom if NDCI is above:',
    help: 'SAR cannot reliably see algae, so this uses the Normalized ' +
          'Difference Chlorophyll Index (Sentinel-2 bands B5/B4) over water.',
    example: {pts: [[41.45, -83.5], [41.95, -82.75]],           // Lake Erie, USA
              dates: ['2023-05-01', '2023-05-31', '2023-08-01', '2023-08-31']}
  }
};

// ===================== 2. USER INTERFACE ====================================
var panel = ui.Panel({style: {width: '380px', padding: '8px'}});
ui.root.insert(0, panel);
Map.setOptions('HYBRID');
Map.style().set('cursor', 'crosshair');

function header(text) {
  return ui.Label(text, {fontWeight: 'bold', fontSize: '14px', margin: '12px 8px 4px 8px'});
}

panel.add(ui.Label('Earth Surface Change Monitor',
  {fontSize: '20px', fontWeight: 'bold'}));
panel.add(ui.Label('NASA Space Apps · Sentinel-1 / NASA OPERA / NISAR SAR (+ Sentinel-2 for algae)',
  {fontSize: '11px', color: 'gray'}));

// --- Phenomenon ---
panel.add(header('1. Phenomenon'));
var phenomenonSelect = ui.Select({
  items: Object.keys(PHENOMENA),
  value: 'Deforestation (SAR)',
  onChange: onPhenomenonChange,
  style: {stretch: 'horizontal'}
});
var helpLabel = ui.Label('', {fontSize: '11px', color: '#555'});
panel.add(phenomenonSelect).add(helpLabel);

// --- Radar data source (used by the SAR phenomena) ---
var SOURCES = {
  S1: 'Sentinel-1 (Earth Engine)',
  OPERA: 'NASA OPERA RTC-S1',
  NISAR: 'NISAR L-band (your uploads)'
};
var sourceSelect = ui.Select({
  items: [SOURCES.S1, SOURCES.OPERA, SOURCES.NISAR],
  value: SOURCES.S1,
  onChange: function(v) { nisarPanel.style().set('shown', v === SOURCES.NISAR); },
  style: {stretch: 'horizontal'}
});
var nisarBefore = ui.Textbox({placeholder: 'projects/your-project/assets/NISAR_20260620_A_T172',
                              style: {stretch: 'horizontal'}});
var nisarAfter = ui.Textbox({placeholder: 'projects/your-project/assets/NISAR_20261101_A_T172',
                             style: {stretch: 'horizontal'}});
var nisarPanel = ui.Panel([
  ui.Label('Paste the Image IDs of your uploaded NISAR GeoTIFFs (several: separate ' +
           'with commas). The dates in step 3 are ignored for NISAR. L-band values ' +
           'differ from Sentinel-1, so re-tune the sensitivity.',
           {fontSize: '11px', color: '#555'}),
  ui.Label('BEFORE image(s):', {fontSize: '12px'}), nisarBefore,
  ui.Label('AFTER image(s):', {fontSize: '12px'}), nisarAfter
], null, {shown: false});
panel.add(ui.Label('Radar data source (SAR phenomena):',
  {fontSize: '12px', color: 'gray', margin: '8px 8px 0 8px'}));
panel.add(sourceSelect).add(nisarPanel);

// --- Coordinate table ---
panel.add(header('2. Area of interest'));
panel.add(ui.Panel([
  ui.Label('Latitude', {width: '120px', fontSize: '12px', color: 'gray'}),
  ui.Label('Longitude', {width: '120px', fontSize: '12px', color: 'gray'})
], ui.Panel.Layout.flow('horizontal')));

var rowsPanel = ui.Panel();
panel.add(rowsPanel);

function addRow(lat, lon) {
  var row = ui.Panel({layout: ui.Panel.Layout.flow('horizontal')});
  var latBox = ui.Textbox({placeholder: 'e.g. -9.9', value: lat === undefined ? '' : String(lat),
                           style: {width: '110px'}, onChange: previewAoi});
  var lonBox = ui.Textbox({placeholder: 'e.g. -63.1', value: lon === undefined ? '' : String(lon),
                           style: {width: '110px'}, onChange: previewAoi});
  var del = ui.Button({label: '✕', onClick: function() { rowsPanel.remove(row); previewAoi(); }});
  row.add(latBox).add(lonBox).add(del);
  rowsPanel.add(row);
}

var pickCheckbox = ui.Checkbox({label: 'Add points by clicking the map', value: false});
var radiusBox = ui.Textbox({value: '10', style: {width: '60px'}, onChange: previewAoi});

panel.add(ui.Panel([
  ui.Button({label: '+ Add point', onClick: function() { addRow(); }}),
  ui.Button({label: 'Clear', onClick: function() { rowsPanel.clear(); addRow(); previewAoi(); }}),
  ui.Button({label: 'Load example', onClick: loadExample})
], ui.Panel.Layout.flow('horizontal')));
panel.add(pickCheckbox);
panel.add(ui.Panel([
  ui.Label('Radius for a single point (km):', {fontSize: '12px'}), radiusBox
], ui.Panel.Layout.flow('horizontal')));

// --- Dates ---
panel.add(header('3. Time periods (YYYY-MM-DD)'));
function dateBox(v) { return ui.Textbox({value: v, style: {width: '105px'}}); }
var b0 = dateBox(''), b1 = dateBox(''), a0 = dateBox(''), a1 = dateBox('');
panel.add(ui.Panel([ui.Label('Before', {width: '45px'}), b0, ui.Label('to'), b1],
  ui.Panel.Layout.flow('horizontal')));
panel.add(ui.Panel([ui.Label('After', {width: '45px'}), a0, ui.Label('to'), a1],
  ui.Panel.Layout.flow('horizontal')));

// --- Sensitivity ---
panel.add(header('4. Sensitivity'));
var thresholdLabel = ui.Label('', {fontSize: '12px'});
var thresholdBox = ui.Textbox({style: {width: '70px'}});
panel.add(ui.Panel([thresholdLabel, thresholdBox], ui.Panel.Layout.flow('horizontal')));

// --- Run + output ---
panel.add(ui.Button({label: '▶  Run analysis', onClick: run,
  style: {stretch: 'horizontal', margin: '12px 8px'}}));
var statusLabel = ui.Label('', {whiteSpace: 'pre', fontSize: '12px'});
var resultsPanel = ui.Panel();
panel.add(statusLabel).add(resultsPanel);

function setStatus(msg, isError) {
  statusLabel.setValue(msg);
  statusLabel.style().set('color', isError ? 'red' : '#333');
}

// ===================== 3. AREA OF INTEREST ==================================
// Reads the table. NOTE: Earth Engine wants [lon, lat] – we flip here.
function readPoints() {
  var pts = [], errors = [];
  var rows = rowsPanel.widgets();
  for (var i = 0; i < rows.length(); i++) {
    var boxes = rows.get(i).widgets();
    var latTxt = boxes.get(0).getValue(), lonTxt = boxes.get(1).getValue();
    if (!latTxt && !lonTxt) continue;                       // ignore empty rows
    var lat = parseFloat(latTxt), lon = parseFloat(lonTxt);
    if (isNaN(lat) || lat < -90 || lat > 90) {
      errors.push('Row ' + (i + 1) + ': latitude must be between -90 and 90');
    } else if (isNaN(lon) || lon < -180 || lon > 180) {
      errors.push('Row ' + (i + 1) + ': longitude must be between -180 and 180');
    } else {
      pts.push([lon, lat]);
    }
  }
  return {pts: pts, errors: errors};
}

function buildAoi() {
  var r = readPoints();
  if (r.errors.length) return {error: r.errors.join('\n')};
  var p = r.pts;
  if (p.length === 0) return {error: 'Add at least one coordinate.'};
  if (p.length === 1) {
    var km = parseFloat(radiusBox.getValue());
    if (isNaN(km) || km <= 0) return {error: 'Radius must be a positive number of km.'};
    return {geom: ee.Geometry.Point(p[0]).buffer(km * 1000)};
  }
  if (p.length === 2) {
    if (Math.abs(p[0][0] - p[1][0]) > 180) {
      return {error: 'This rectangle crosses the 180° line – split it into two areas.'};
    }
    return {geom: ee.Geometry.Rectangle([
      Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]),
      Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])], null, false)};
  }
  return {geom: ee.Geometry.Polygon([p], null, false)};
}

// Highlight: dim everything outside the area + bright outline.
var dimLayer = ui.Map.Layer(ee.Image(), {}, 'Outside area (dimmed)', true, 0.45);
var aoiLayer = ui.Map.Layer(ee.Image(), {}, 'Area of interest');
Map.layers().add(dimLayer);
Map.layers().add(aoiLayer);

function previewAoi() {
  var a = buildAoi();
  if (a.error) { setStatus(a.error, true); return null; }
  setStatus('');
  var fc = ee.FeatureCollection([ee.Feature(a.geom)]);
  dimLayer.setEeObject(ee.Image(1).byte().paint(fc, 0).selfMask());
  dimLayer.setVisParams({palette: ['000000']});
  aoiLayer.setEeObject(ee.Image().byte().paint(fc, 1, 3));
  aoiLayer.setVisParams({palette: ['ff6b00']});
  Map.centerObject(a.geom);
  return a.geom;
}

Map.onClick(function(c) {
  if (!pickCheckbox.getValue()) return;
  // Fill the first empty row if there is one, otherwise add a new row.
  var rows = rowsPanel.widgets();
  for (var i = 0; i < rows.length(); i++) {
    var boxes = rows.get(i).widgets();
    if (!boxes.get(0).getValue() && !boxes.get(1).getValue()) {
      boxes.get(0).setValue(c.lat.toFixed(5), false);
      boxes.get(1).setValue(c.lon.toFixed(5), false);
      previewAoi();
      return;
    }
  }
  addRow(c.lat.toFixed(5), c.lon.toFixed(5));
  previewAoi();
});

// ===================== 4. PHENOMENON / EXAMPLE HANDLERS =====================
function onPhenomenonChange(name) {
  var cfg = PHENOMENA[name];
  helpLabel.setValue(cfg.help);
  thresholdLabel.setValue(cfg.thresholdLabel);
  thresholdBox.setValue(String(cfg.threshold));
}

function loadExample() {
  var ex = PHENOMENA[phenomenonSelect.getValue()].example;
  rowsPanel.clear();
  ex.pts.forEach(function(p) { addRow(p[0], p[1]); });
  b0.setValue(ex.dates[0]); b1.setValue(ex.dates[1]);
  a0.setValue(ex.dates[2]); a1.setValue(ex.dates[3]);
  previewAoi();
}

// Dates are inclusive: 2023-08-01 to 2023-08-01 means that whole day.
function readDates() {
  var names = ['BEFORE start', 'BEFORE end', 'AFTER start', 'AFTER end'];
  var v = [b0, b1, a0, a1].map(function(b) { return b.getValue().trim(); });
  for (var i = 0; i < 4; i++) {
    if (!isRealDate(v[i])) {
      return {error: names[i] + ' date "' + v[i] + '" is not valid.\n' +
                     'Use YYYY-MM-DD, e.g. 2023-06-01.'};
    }
  }
  if (v[0] > v[1]) {
    return {error: 'BEFORE period: start (' + v[0] + ') is after its end (' + v[1] + ').\n' +
                   'Swap the two dates.'};
  }
  if (v[2] > v[3]) {
    return {error: 'AFTER period: start (' + v[2] + ') is after its end (' + v[3] + ').\n' +
                   'Swap the two dates.'};
  }
  if (v[1] >= v[2]) {
    return {error: 'The BEFORE period (ends ' + v[1] + ') must end before the\n' +
                   'AFTER period starts (' + v[2] + ').'};
  }
  return {b0: v[0], b1: v[1], a0: v[2], a1: v[3]};
}

// Checks the format AND that the day exists (rejects 2023-02-30).
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Earth Engine's filterDate excludes the end date, so add one day to include it.
function inclusiveEnd(end) {
  return ee.Date(end).advance(1, 'day');
}

// ===================== 5. ANALYSIS ==========================================
function run() {
  var geom = previewAoi();
  if (!geom) return;
  var name = phenomenonSelect.getValue();
  var cfg = PHENOMENA[name];
  var usesNisar = cfg.sensor === 'S1' && sourceSelect.getValue() === SOURCES.NISAR;
  var d = usesNisar ? {} : readDates();
  if (d.error) { setStatus(d.error, true); return; }
  var thr = parseFloat(thresholdBox.getValue());
  if (isNaN(thr)) { setStatus('Sensitivity must be a number.', true); return; }

  // Start a fresh map, keeping the AOI highlight on top.
  Map.layers().reset();
  resultsPanel.clear();
  setStatus('Searching for images…');

  if (cfg.sensor === 'S1') runSar(geom, d, name, cfg, thr);
  else runAlgae(geom, d, name, cfg, thr);
}

function addAoiOnTop() {
  Map.layers().add(dimLayer);
  Map.layers().add(aoiLayer);
}

// ---------- Radar sources ----------
// Every source returns bands CO (co-polarized: VV or HH) and CX (cross-
// polarized: VH or HV), both in dB, so the analysis below works for all.

function s1Collection(geom, start, end) {
  return ee.ImageCollection('COPERNICUS/S1_GRD')
    .filterBounds(geom)
    .filterDate(start, inclusiveEnd(end))
    .filter(ee.Filter.eq('instrumentMode', 'IW'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
    .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
    .select(['VV', 'VH'], ['CO', 'CX']);       // already in dB
}

// NASA OPERA RTC-S1: Sentinel-1 terrain-corrected by NASA JPL (linear power).
function operaCollection(geom, start, end) {
  return ee.ImageCollection('OPERA/RTC/L2_V1/S1')
    .filterBounds(geom)
    .filterDate(start, inclusiveEnd(end))
    .filter(ee.Filter.listContains('POLARIZATIONS', 'VV'))
    .filter(ee.Filter.listContains('POLARIZATIONS', 'VH'))
    .map(function(img) {
      var lin = img.select(['VV', 'VH']);
      var valid = img.select('mask').eq(0)              // 0 = valid (not layover/shadow)
        .and(lin.reduce(ee.Reducer.min()).gt(0));
      var db = lin.log10().multiply(10).rename(['CO', 'CX']).updateMask(valid);
      return ee.Image(db.copyProperties(img, ['system:time_start', 'ORBIT_PASS_DIRECTION']));
    });
}

// NISAR: GeoTIFFs made by nisar_to_geotiff.py (band 1 = HH, band 2 = HV, dB).
function parseIds(text) {
  return text.split(',').map(function(s) { return s.trim(); })
             .filter(function(s) { return s.length > 0; });
}
function nisarCollection(ids) {
  return ee.ImageCollection(ids.map(function(id) {
    var img = ee.Image(id).select([0, 1], ['CO', 'CX']);
    return img.updateMask(img.gt(-60).reduce(ee.Reducer.min()));  // drop -9999 nodata
  }));
}

function passFilters(source) {
  var prop = source === SOURCES.OPERA ? 'ORBIT_PASS_DIRECTION' : 'orbitProperties_pass';
  return {
    asc: ee.Filter.inList(prop, ['ASCENDING', 'Ascending', 'ascending']),
    desc: ee.Filter.inList(prop, ['DESCENDING', 'Descending', 'descending'])
  };
}

// Display name of CO / CX for the chosen source.
function bandLabel(source, generic) {
  if (source === SOURCES.NISAR) return generic === 'CO' ? 'HH' : 'HV';
  return generic === 'CO' ? 'VV' : 'VH';
}

// ---------- SAR: collect images, then analyse ----------
function runSar(geom, d, name, cfg, thr) {
  var source = sourceSelect.getValue();
  if (source === SOURCES.NISAR) { runNisar(geom, name, cfg, thr); return; }

  var getCol = source === SOURCES.OPERA ? operaCollection : s1Collection;
  var beforeAll = getCol(geom, d.b0, d.b1);
  var afterAll = getCol(geom, d.a0, d.a1);
  var f = passFilters(source);

  ee.Dictionary({
    bA: beforeAll.filter(f.asc).size(), bD: beforeAll.filter(f.desc).size(),
    aA: afterAll.filter(f.asc).size(), aD: afterAll.filter(f.desc).size(),
    areaKm2: geom.area(1).divide(1e6)
  }).evaluate(function(c, err) {
    if (err) { setStatus('Error: ' + err, true); addAoiOnTop(); return; }

    // Radar looks different from ascending vs descending orbits, so we only
    // compare images taken from the same direction.
    var useAsc = Math.min(c.bA, c.aA) >= Math.min(c.bD, c.aD);
    var nB = useAsc ? c.bA : c.bD, nA = useAsc ? c.aA : c.aD;
    if (nB === 0 || nA === 0) {
      setStatus('No ' + source + ' images from the same orbit direction\n' +
                'in both periods (found ' + c.bA + ' asc / ' + c.bD + ' desc before, ' +
                c.aA + ' asc / ' + c.aD + ' desc after).\n' +
                'Sentinel-1 revisits every 6–12 days, so use periods of at\n' +
                'least 2–4 weeks.', true);
      addAoiOnTop();
      return;
    }
    var passFilter = useAsc ? f.asc : f.desc;
    var gband = cfg.band === 'VH' ? 'CX' : 'CO';
    var series = getCol(geom, d.b0, d.a1).filter(passFilter).select(gband);

    analyzeSar(geom, beforeAll.filter(passFilter), afterAll.filter(passFilter),
      name, cfg, thr, source, c.areaKm2,
      source + '\nImages: ' + nB + ' before, ' + nA + ' after (' +
        (useAsc ? 'ascending' : 'descending') + ' orbit)',
      series);
  });
}

function runNisar(geom, name, cfg, thr) {
  var bIds = parseIds(nisarBefore.getValue());
  var aIds = parseIds(nisarAfter.getValue());
  if (!bIds.length || !aIds.length) {
    setStatus('Enter at least one NISAR asset ID for BEFORE and for AFTER\n' +
              '(Assets tab → click your upload → copy the "Image ID").', true);
    addAoiOnTop();
    return;
  }
  var beforeCol = nisarCollection(bIds), afterCol = nisarCollection(aIds);
  ee.Dictionary({
    areaKm2: geom.area(1).divide(1e6),
    bands: ee.Image(bIds[0]).bandNames()          // forces a check that the asset exists
  }).evaluate(function(c, err) {
    if (err) {
      setStatus('Could not open the NISAR assets. Check the IDs and that\n' +
                'the uploads finished (Tasks tab).\n' + err, true);
      addAoiOnTop();
      return;
    }
    analyzeSar(geom, beforeCol, afterCol, name, cfg, thr, SOURCES.NISAR, c.areaKm2,
      'NISAR L-band\nImages: ' + bIds.length + ' before, ' + aIds.length + ' after',
      null);
  });
}

function analyzeSar(geom, beforeCol, afterCol, name, cfg, thr, source, areaKm2,
                    imagesLine, series) {
  // Median composite + speckle filter, clipped to the area.
  function composite(col) {
    return col.median().focalMedian(30, 'circle', 'meters')
      .rename(['CO', 'CX']).clip(geom);
  }
  var before = composite(beforeCol);
  var after = composite(afterCol);
  var g = cfg.band === 'VH' ? 'CX' : 'CO';
  var label = bandLabel(source, g);
  var diff = after.select(g).subtract(before.select(g)).rename('diff');

  var change;
  if (name === 'Deforestation (SAR)') {
    var forest = ee.Image('UMD/hansen/global_forest_change_2023_v1_11')
      .select('treecover2000').gt(30);
    change = diff.lt(-Math.abs(thr)).and(forest);
  } else if (name === 'Flooding (SAR)') {
    var permanentWater = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
      .select('occurrence').unmask(0).gt(80);
    var slope = ee.Terrain.slope(ee.Image('USGS/SRTMGL1_003')).unmask(0);
    change = after.select('CO').lt(thr)
      .and(before.select('CO').gte(thr))
      .and(permanentWater.not())
      .and(slope.lt(5));
  } else { // Urban growth
    change = diff.gt(thr).and(after.select('CO').gt(-12));
  }
  change = change.rename('change').clip(geom);

  // --- Map layers ---
  var vis = g === 'CX' ? {min: -25, max: -5} : {min: -22, max: 0};
  Map.addLayer(before.select(g), vis, 'BEFORE ' + label, false);
  Map.addLayer(after.select(g), vis, 'AFTER ' + label);
  Map.addLayer(diff, {min: -6, max: 6, palette: ['b2182b', 'f7f7f7', '2166ac']},
               'Change in ' + label + ' (dB): red = darker, blue = brighter', false);
  if (name === 'Deforestation (SAR)') {
    var loss = ee.Image('UMD/hansen/global_forest_change_2023_v1_11')
      .select('lossyear').selfMask().clip(geom);
    Map.addLayer(loss, {min: 1, max: 23, palette: ['ffff00', 'ff00ff']},
                 'Reference: Hansen optical forest loss 2001–2023', false);
  }
  Map.addLayer(change.selfMask(), {palette: [cfg.color]}, 'DETECTED: ' + name);
  addAoiOnTop();

  // --- Statistics ---
  setStatus('Calculating area…');
  showStats(change, geom, 20, areaKm2, name, imagesLine);

  // Mean before/after values (useful for tuning thresholds, esp. L-band).
  before.addBands(after.rename(['CO_after', 'CX_after']))
    .reduceRegion({reducer: ee.Reducer.median(), geometry: geom, scale: 60,
                   maxPixels: 1e10, tileScale: 4})
    .evaluate(function(m) {
      if (!m) return;
      var k = g === 'CX' ? 'CX' : 'CO';
      if (m[k] === null || m[k + '_after'] === null) return;
      resultsPanel.insert(0, ui.Label(
        'Median ' + label + ': ' + m[k].toFixed(1) + ' dB before → ' +
        m[k + '_after'].toFixed(1) + ' dB after', {fontSize: '12px'}));
    });

  // --- Time series chart (not for NISAR uploads: only two dates) ---
  if (series) {
    resultsPanel.add(ui.Chart.image.series({
      imageCollection: series, region: geom,
      reducer: ee.Reducer.mean(), scale: 100
    }).setOptions({
      title: 'Average ' + label + ' backscatter over time',
      vAxis: {title: label + ' (dB)'}, hAxis: {title: 'Date'},
      lineWidth: 1, pointSize: 3, legend: {position: 'none'}
    }));
  }
}

// ---------- Sentinel-2 optical (algae) ----------
function s2Ndci(geom, start, end) {
  return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
    .filterBounds(geom)
    .filterDate(start, inclusiveEnd(end))
    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 60))
    .map(function(img) {
      var scl = img.select('SCL');                     // scene classification
      var clear = scl.neq(3).and(scl.neq(8)).and(scl.neq(9))
                    .and(scl.neq(10)).and(scl.neq(11)); // no shadow/cloud/cirrus/snow
      var ndci = img.normalizedDifference(['B5', 'B4']).rename('NDCI');
      return img.addBands(ndci).updateMask(clear);
    });
}

function runAlgae(geom, d, name, cfg, thr) {
  var beforeCol = s2Ndci(geom, d.b0, d.b1);
  var afterCol = s2Ndci(geom, d.a0, d.a1);

  ee.Dictionary({
    nB: beforeCol.size(), nA: afterCol.size(),
    areaKm2: geom.area(1).divide(1e6)
  }).evaluate(function(c, err) {
    if (err) { setStatus('Error: ' + err, true); addAoiOnTop(); return; }
    if (c.nB === 0 || c.nA === 0) {
      setStatus('No cloud-free-enough Sentinel-2 images in one of the periods.\n' +
                'Try wider date ranges.', true);
      addAoiOnTop();
      return;
    }
    var water = ee.Image('JRC/GSW1_4/GlobalSurfaceWater')
      .select('occurrence').unmask(0).gt(50);
    var before = beforeCol.median().clip(geom);
    var after = afterCol.median().clip(geom);
    var ndciB = before.select('NDCI').updateMask(water);
    var ndciA = after.select('NDCI').updateMask(water);
    var change = ndciA.gt(thr).unmask(0).rename('change').clip(geom);

    var rgb = {bands: ['B4', 'B3', 'B2'], min: 0, max: 2500};
    var ndciVis = {min: -0.1, max: 0.4, palette: ['0b1d51', '2a9df4', 'a8e05f', 'f5e400', 'e8590c']};
    Map.addLayer(before, rgb, 'BEFORE true colour', false);
    Map.addLayer(after, rgb, 'AFTER true colour');
    Map.addLayer(ndciB, ndciVis, 'BEFORE chlorophyll index (NDCI)', false);
    Map.addLayer(ndciA, ndciVis, 'AFTER chlorophyll index (NDCI)', false);
    Map.addLayer(change.selfMask(), {palette: [cfg.color]}, 'DETECTED: ' + name);
    addAoiOnTop();

    setStatus('Calculating area…');
    showStats(change, geom, 20, c.areaKm2, name,
      'Images: ' + c.nB + ' before, ' + c.nA + ' after (Sentinel-2)');

    var series = s2Ndci(geom, d.b0, d.a1).map(function(img) {
      return img.select('NDCI').updateMask(water);
    });
    resultsPanel.add(ui.Chart.image.series({
      imageCollection: series, region: geom,
      reducer: ee.Reducer.mean(), scale: 60
    }).setOptions({
      title: 'Average chlorophyll index (NDCI) over water',
      vAxis: {title: 'NDCI'}, hAxis: {title: 'Date'},
      lineWidth: 1, pointSize: 3, legend: {position: 'none'}
    }));
  });
}

// ---------- Shared: changed-area statistics ----------
function showStats(change, geom, scale, aoiKm2, name, imagesLine) {
  change.multiply(ee.Image.pixelArea()).divide(1e6)
    .reduceRegion({reducer: ee.Reducer.sum(), geometry: geom,
                   scale: scale, maxPixels: 1e10, tileScale: 4})
    .get('change')
    .evaluate(function(km2, err) {
      if (err) { setStatus('Error calculating area: ' + err, true); return; }
      km2 = km2 || 0;
      setStatus(
        name + '\n' + imagesLine + '\n' +
        'Area of interest: ' + aoiKm2.toFixed(1) + ' km²\n' +
        'Detected change: ' + km2.toFixed(2) + ' km² (' +
        (100 * km2 / aoiKm2).toFixed(1) + '% of area)');
    });
}

// ===================== 6. START-UP ==========================================
onPhenomenonChange(phenomenonSelect.getValue());
loadExample();
