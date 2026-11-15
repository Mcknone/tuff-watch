// =============================================================================
// Earth Surface Change Monitor – phenomena, intensity levels and NASA datasets
// Every dataset here is real NASA (or NASA-partner) data:
//   - imagery comes from NASA GIBS (Global Imagery Browse Services)
//   - acquisition lists come from NASA CMR (Common Metadata Repository)
// =============================================================================

// Intensity levels used everywhere (1–4). 0 = observed, nothing detected.
export const LEVELS = [
  { id: 1, name: 'Low' },
  { id: 2, name: 'Moderate' },
  { id: 3, name: 'High' },
  { id: 4, name: 'Severe' }
];

// Each phenomenon owns one colour family; darker = more intense.
// Priority decides which colour wins when two phenomena hit the same pixel.
export const PHENOMENA = {
  vegetation: {
    name: 'Vegetation loss / deforestation',
    short: 'Vegetation loss',
    priority: 2,
    ramp: ['#fdbe85', '#fd8d3c', '#e6550d', '#8c1d04'],
    levelHelp: [
      'Small or first-time loss of vegetation cover',
      'Loss repeated over several images, or radar darkening',
      'Confirmed loss of vegetation cover',
      'Confirmed loss of 50 % or more of the vegetation cover'
    ]
  },
  water: {
    name: 'Flooding / surface water',
    short: 'Surface water',
    priority: 3,
    categorical: true,          // water is reported as extent + confidence, never as an intensity level
    // ramp kept for chart/timeline colour only: [normal water, new water, …]
    ramp: ['#9fb8d3', '#5b7fa6', '#1f78c8', '#0b4f8a'],
    water: { normal: '#5b7fa6', new: '#00b4f0', unknown: '#c5d3e2' },
    levelHelp: [
      'Water seen in the pre-event baseline (permanent or normally occurring water)',
      'Water now, dry in the pre-event baseline (newly inundated)',
      'Water now, but the baseline never saw this pixel (cannot tell if it is new)',
      ''
    ]
  },
  fire: {
    name: 'Active fires / burning',
    short: 'Fire',
    priority: 4,
    ramp: ['#fa9fb5', '#f768a1', '#c51b8a', '#7a0177'],
    levelHelp: [
      'Isolated heat signal',
      'Scattered fire detections',
      'Fire detected by satellite thermal sensor',
      'Dense cluster of fire detections'
    ]
  },
  algae: {
    name: 'Algae bloom / chlorophyll',
    short: 'Chlorophyll',
    priority: 1,
    ramp: ['#c2e699', '#78c679', '#31a354', '#005a32'],
    levelHelp: [
      'Chlorophyll-a 1–5 mg/m³ (moderately productive water)',
      'Chlorophyll-a 5–20 mg/m³ (nutrient-rich water)',
      'Chlorophyll-a 20–50 mg/m³ (likely bloom)',
      'Chlorophyll-a over 50 mg/m³ (intense bloom)'
    ]
  }
};

// ---- label rules (applied to the class names in NASA's colour maps) ----------
const UNOBSERVED_RE = /cloud|shadow|snow|ice|no ?data|fill|not observed|unobserved|missing|hand[- ]?mask|layover|outside/i;

function distLevel(label) {
  const big = /(≥|>=|&gt;=|>)\s*50|high|large/i.test(label);
  const small = /<\s*50|&lt;\s*50|low|small/i.test(label);
  const confirmed = /confirm|finish|ongoing/i.test(label);
  if (big) return confirmed ? 4 : 3;
  if (small) return confirmed ? 2 : 1;
  return null;                                   // fall back to colour-map order
}

// ---- surface-water products: documented categorical class codes ----------------
// Water classes are CATEGORIES (dry / open water / partial / inundated vegetation /
// product-flagged flood / product reference water) – not an intensity scale – and
// any confidence wording in a label is ignored when deciding the class.
// Class codes are read from the colour map's sourceValue; labels are a cross-check.
//
// OPERA DSWx-HLS v1, layer WTR (OPERA DSWx-HLS product specification):
//   0 not water · 1 open water · 2 partial surface water · 252 snow/ice ·
//   253 cloud/cloud shadow · 254 ocean masked · 255 fill (no data)
// OPERA DSWx-S1 v1, layer WTR (OPERA DSWx-S1 product specification):
//   0 not water · 1 open water · 3 inundated vegetation · 250 HAND masked ·
//   251 layover/shadow masked · 252 snow/ice · 253 cloud · 254 ocean masked · 255 fill
// MODIS/VIIRS NRT Global Flood Product MCDWD (LANCE NRT Global Flood Product user guide):
//   0 no water · 1 surface water matching reference water · 2 recurring flood ·
//   3 flood (unusual) · 255 insufficient data
export const WATER_CODES = {
  dswxHls: { 0: 'dry', 1: 'open', 2: 'partial', 252: 'invalid', 253: 'invalid', 254: 'invalid', 255: 'invalid' },
  dswxS1: { 0: 'dry', 1: 'open', 2: 'partial', 3: 'inundated_veg', 250: 'invalid', 251: 'invalid', 252: 'invalid', 253: 'invalid', 254: 'invalid', 255: 'invalid' },
  mcdwd: { 0: 'dry', 1: 'reference', 2: 'reference', 3: 'flood', 255: 'invalid' }
};

// Label rules, checked in order. Anything not matched is treated as INVALID (never as water).
export const WATER_LABEL_RULES = [
  [/no ?data|fill|not observed|unobserved|insufficient|missing|outside/i, 'invalid'],
  [/cloud|shadow|snow|ice|layover|hand|mask|ocean|terrain/i, 'invalid'],
  [/not[ -]water|no[ -]water|^\s*land\s*$|^\s*dry/i, 'dry'],
  [/inundated veg|flooded veg/i, 'inundated_veg'],
  [/partial/i, 'partial'],
  [/recurring|reference|permanent|normal water/i, 'reference'],
  [/unusual|flood/i, 'flood'],
  [/water/i, 'open']
];

// -----------------------------------------------------------------------------
// method:
//   'classes'    – categorical NASA product; classes mapped to levels by label
//   'continuous' – numeric product (e.g. mg/m³); levels from thresholds
//   'presence'   – anything drawn = detection (vector layers such as fires)
//   'sar'        – radar image; level = how much darker it got vs the first date
// dates:
//   'granules'   – use the real acquisition dates found in NASA CMR
//   'daily'      – global daily product; sample evenly across the period
// -----------------------------------------------------------------------------
export const DATASETS = [
  {
    id: 'dist',
    phenomenon: 'vegetation',
    name: 'OPERA DIST-ALERT (HLS)',
    product: 'Land Surface Disturbance Alert – vegetation cover loss',
    satellites: 'Landsat 8/9 + Sentinel-2A/B/C (Harmonized Landsat Sentinel-2)',
    kind: 'Optical',
    agency: 'NASA JPL OPERA · UMD GLAD · LP DAAC',
    resolution: '30 m',
    gibs: 'OPERA_L3_DIST-ALERT-HLS_Color_Index',
    cmr: 'OPERA_L3_DIST-ALERT-HLS_V1',
    dates: 'granules',
    method: 'classes',
    transparentMeans: 'none',
    noneRe: /no (vegetation )?disturbance|no loss|undisturbed|^none$/i,
    labelLevel: distLevel
  },
  {
    id: 'rtc',
    phenomenon: 'vegetation',
    name: 'OPERA RTC-S1 radar',
    product: 'Radiometric Terrain-Corrected SAR backscatter (VV/VH)',
    satellites: 'Sentinel-1A/C (C-band SAR)',
    kind: 'SAR',
    agency: 'NASA JPL OPERA · ASF DAAC',
    resolution: '30 m',
    gibs: 'OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1',
    cmr: 'OPERA_L2_RTC-S1_V1',
    dates: 'granules',
    method: 'sar',
    sarThresholds: [18, 32, 50, 75]
  },
  {
    id: 'nisar',
    phenomenon: 'vegetation',
    name: 'NISAR GCOV radar',
    product: 'L-band Geocoded Polarimetric Covariance (HH/HV)',
    satellites: 'NISAR (NASA–ISRO), L-band SAR',
    kind: 'SAR',
    agency: 'NASA JPL · ISRO · ASF DAAC',
    resolution: '~150 m (GIBS view)',
    gibs: 'NISAR_L2_Geocoded_Polarimetric_Covariance',
    cmr: 'NISAR_L2*GCOV*',
    dates: 'granules',
    method: 'sar',
    sarThresholds: [18, 32, 50, 75]
  },
  {
    id: 'dswx-s1',
    phenomenon: 'water',
    name: 'OPERA DSWx-S1 radar water',
    product: 'Dynamic Surface Water Extent from Sentinel-1 radar (sees through clouds)',
    satellites: 'Sentinel-1A/C (C-band SAR)',
    kind: 'SAR',
    agency: 'NASA JPL OPERA · PO.DAAC',
    resolution: '30 m',
    gibs: 'OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1',
    cmr: 'OPERA_L3_DSWX-S1_V1',
    dates: 'granules',
    method: 'water',
    waterCodes: 'dswxS1',
    sensorGroup: 'sentinel-1'
  },
  {
    id: 'dswx-hls',
    phenomenon: 'water',
    name: 'OPERA DSWx-HLS optical water',
    product: 'Dynamic Surface Water Extent from Landsat 8/9 + Sentinel-2 optical imagery',
    satellites: 'Landsat 8/9 + Sentinel-2A/B/C (HLS)',
    kind: 'Optical',
    agency: 'NASA JPL OPERA · USGS · PO.DAAC',
    resolution: '30 m',
    gibs: 'OPERA_L3_Dynamic_Surface_Water_Extent-HLS',
    cmr: 'OPERA_L3_DSWX-HLS_V1',
    dates: 'granules',
    method: 'water',
    waterCodes: 'dswxHls',
    sensorGroup: 'hls'
  },
  {
    id: 'modis-flood',
    phenomenon: 'water',
    name: 'MODIS Global Flood (LANCE NRT)',
    product: 'NRT Global Flood Product, 2-day composite – flags unusual flooding against a reference-water map',
    satellites: 'Terra + Aqua (MODIS)',
    kind: 'Optical',
    agency: 'NASA LANCE · GSFC',
    resolution: '250 m',
    gibs: 'MODIS_Combined_Flood_2-Day',
    cmr: 'MCDWD_L3_F2_NRT',
    dates: 'daily',
    method: 'water',
    waterCodes: 'mcdwd',
    sensorGroup: 'modis',
    complementary: true,
    note: 'Near-real-time product; NASA keeps only recent NRT granules, so older periods may have no data. Coarser (250 m) than OPERA – compared, never averaged.'
  },
  {
    id: 'imerg',
    phenomenon: 'water',
    name: 'GPM IMERG rainfall (context)',
    product: 'IMERG precipitation rate (mm/h), 30-minute snapshot at 00:00 UTC of each sampled day',
    satellites: 'GPM Core Observatory + partner constellation',
    kind: 'Precipitation',
    agency: 'NASA GSFC · GES DISC',
    resolution: '~10 km',
    gibs: 'IMERG_Precipitation_Rate',
    cmr: 'GPM_3IMERGHHL',
    dates: 'daily',
    method: 'rain',
    context: true,
    note: 'Rainfall is context for a possible flood event only – it is never counted as flooded area.'
  },
  {
    id: 'viirs-fire',
    phenomenon: 'fire',
    name: 'VIIRS active fires',
    product: 'Thermal Anomalies and Fires 375 m (FIRMS)',
    satellites: 'Suomi NPP (VIIRS)',
    kind: 'Thermal',
    agency: 'NASA LANCE / FIRMS · LP DAAC',
    resolution: '375 m',
    gibs: 'VIIRS_SNPP_Thermal_Anomalies_375m_All',
    cmr: 'VNP14IMG',
    dates: 'daily',
    method: 'presence',
    presenceLevel: 3
  },
  {
    id: 'pace-chl',
    phenomenon: 'algae',
    name: 'PACE OCI chlorophyll-a',
    product: 'Chlorophyll-a concentration (ocean & large lakes)',
    satellites: 'PACE (Ocean Color Instrument)',
    kind: 'Ocean colour',
    agency: 'NASA GSFC · OB.DAAC',
    resolution: '1 km',
    gibs: 'OCI_PACE_Chlorophyll_a',
    cmr: 'PACE_OCI_L2_BGC*',
    dates: 'daily',
    method: 'continuous',
    thresholds: [1, 5, 20, 50]
  },
  {
    id: 'modis-chl',
    phenomenon: 'algae',
    name: 'MODIS Aqua chlorophyll-a',
    product: 'Chlorophyll-a concentration (ocean & large lakes)',
    satellites: 'Aqua (MODIS)',
    kind: 'Ocean colour',
    agency: 'NASA GSFC · OB.DAAC',
    resolution: '1 km',
    gibs: 'MODIS_Aqua_L2_Chlorophyll_A',
    cmr: 'MODISA_L2_OC',
    dates: 'daily',
    method: 'continuous',
    thresholds: [1, 5, 20, 50]
  }
];

// Context imagery (display only, not analysed)
export const CONTEXT_LAYERS = [
  { id: 'viirs-tc', name: 'VIIRS true colour (daily, 250 m)', gibs: 'VIIRS_SNPP_CorrectedReflectance_TrueColor' },
  { id: 'hls-s30', name: 'HLS Sentinel-2 true colour (30 m)', gibs: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance' },
  { id: 'hls-l30', name: 'HLS Landsat true colour (30 m)', gibs: 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance' }
];

export const UNOBSERVED_LABELS = UNOBSERVED_RE;

// Ready-made examples of real events
export const EXAMPLES = [
  {
    name: 'South Papua (Merauke) – forest clearing 2026',
    rows: [[-8.30, 140.40]], radiusKm: 10,
    start: '2026-05-01', end: '2026-11-10',
    phenomena: ['vegetation', 'water', 'fire']
  },
  {
    name: 'Texas Hill Country floods – July 2025',
    rows: [[29.95, -99.40], [30.15, -99.05]],
    start: '2025-06-15', end: '2025-07-25', eventDate: '2025-07-04',
    phenomena: ['water']
  },
  {
    name: 'Palisades fire, Los Angeles – January 2025',
    rows: [[34.02, -118.68], [34.13, -118.48]],
    start: '2024-12-15', end: '2025-02-28',
    phenomena: ['fire', 'vegetation']
  },
  {
    name: 'Lake Erie algae bloom – summer 2025',
    rows: [[41.40, -83.50], [41.95, -82.70]],
    start: '2025-06-01', end: '2025-09-30',
    phenomena: ['algae']
  }
];

// Complementary sources that were evaluated for flood mapping, and why each is
// (or is not) used. Shown in the Data sources tab.
export const SOURCE_NOTES = [
  { name: 'Sentinel-1 RTC backscatter', used: 'Not added for floods',
    why: 'DSWx-S1 is computed from the same Sentinel-1 RTC acquisitions, so adding RTC would count each radar observation twice. RTC stays in use for vegetation change.' },
  { name: 'Sentinel-2 / Landsat', used: 'Already included',
    why: 'Both are the inputs of DSWx-HLS (Harmonized Landsat Sentinel-2). Cloudy pixels are excluded using the product’s own cloud classes.' },
  { name: 'MODIS Global Flood (LANCE)', used: 'Used as independent check',
    why: 'Daily optical flood maps with their own reference-water baseline. 250 m pixels, so they are compared with OPERA results, not averaged with them.' },
  { name: 'VIIRS flood products', used: 'Not used',
    why: 'A VIIRS flood layer could not be confirmed in NASA GIBS when this version was built, so it is not queried. The MODIS LANCE flood product fills the same daily-optical role.' },
  { name: 'GPM IMERG rainfall', used: 'Context only',
    why: 'Shows whether heavy rain fell over the area. Rain is evidence that a flood was possible, not proof of flooded area.' },
  { name: 'NISAR', used: 'Vegetation only',
    why: 'NISAR L-band GCOV radar is used for vegetation change. NASA has not published a NISAR water-extent product in GIBS, so it is not used to map water.' }
];
