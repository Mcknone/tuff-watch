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
    icon: '🌳',
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
    icon: '🌊',
    priority: 3,
    ramp: ['#9ecae1', '#4292c6', '#2171b5', '#08306b'],
    levelHelp: [
      'Possible water (low confidence)',
      'Partial surface water (water mixed with land or vegetation)',
      'Open water or water under vegetation',
      'Open water that was NOT water at the first date (new flooding)'
    ]
  },
  fire: {
    name: 'Active fires / burning',
    short: 'Fire',
    icon: '🔥',
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
    icon: '🦠',
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

function waterLevel(label) {
  if (/partial/i.test(label)) return 2;
  if (/inundated|flooded|vegetation/i.test(label)) return 3;
  if (/open|water/i.test(label)) return 3;
  return null;
}

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
    product: 'Dynamic Surface Water Extent from radar (sees through clouds)',
    satellites: 'Sentinel-1A/C (C-band SAR)',
    kind: 'SAR',
    agency: 'NASA JPL OPERA · PO.DAAC',
    resolution: '30 m',
    gibs: 'OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1',
    cmr: 'OPERA_L3_DSWX-S1_V1',
    dates: 'granules',
    method: 'classes',
    transparentMeans: 'none',
    noneRe: /not water|no water|^land$/i,
    labelLevel: waterLevel,
    newWaterSevere: true
  },
  {
    id: 'dswx-hls',
    phenomenon: 'water',
    name: 'OPERA DSWx-HLS optical water',
    product: 'Dynamic Surface Water Extent from optical imagery',
    satellites: 'Landsat 8/9 + Sentinel-2A/B/C (HLS)',
    kind: 'Optical',
    agency: 'NASA JPL OPERA · USGS · PO.DAAC',
    resolution: '30 m',
    gibs: 'OPERA_L3_Dynamic_Surface_Water_Extent-HLS',
    cmr: 'OPERA_L3_DSWX-HLS_V1',
    dates: 'granules',
    method: 'classes',
    transparentMeans: 'none',
    noneRe: /not water|no water|^land$/i,
    labelLevel: waterLevel,
    newWaterSevere: true
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
    start: '2025-06-15', end: '2025-07-25',
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
