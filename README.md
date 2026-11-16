# EarthScope – Surface Change Monitor

**NASA Space Apps Challenge** – an interactive web app that monitors changes on Earth's surface over
time – **deforestation, flooding, fires and algae blooms** – using **real NASA radar (SAR) and optical
satellite data**. Runs on **Cloudflare Workers**, no Google Earth Engine needed.

## What it does

**Two views – switch any time in the top bar:**
- **Simple** (default): made so that anyone can use it. The app opens on the whole globe; choose a
  spot on the map, set the **size of the area** with a slider, pick what to look for (forests &
  plants, floods, fires, algae – shown with small line icons), press **Look from space** and read one
  plain sentence per topic (“New flood water found! About 9.4 km² – about 1,300 football fields”),
  plus *when* it happened with **Before / During / After** buttons. Coordinates, example presets,
  settings, charts, satellite tracks, data sources and exports are hidden.
- **Detailed**: everything described below – coordinates, sensitivity settings, charts, satellite
  tracks, diagnostics and downloads. The same analysis powers both views.


1. **Coordinates table** – type latitude/longitude (1 point = circle, 2 = rectangle, 3+ = polygon)
   or add points on the map: middle-click, or **Add point** mode (a crosshair at the map centre plus an
   explicit *Add point here* button – for touchpads and touch screens). A normal left click or tap
   never adds a point, so panning cannot create points by accident.
   Your area is outlined in orange and everything outside it is dimmed.
2. **Time period + phenomena** – pick dates and any of the 4 phenomena. For floods, an optional
   **flood event date** splits observations into a pre-event baseline and later observations.
3. **Analyse** – for every dataset the app:
   - asks **NASA CMR** (Common Metadata Repository) which real satellite acquisitions cover your area
     in that period (all result pages, with the collection version),
   - **vegetation disturbance and water**: reads the products' own **GeoTIFF rasters** (OPERA
     DIST-ALERT `VEG-DIST-STATUS` + `VEG-ANOM-MAX`, DSWx `B01_WTR`) through the server relay, decodes
     the documented numerical class values on a 30 m UTM grid (nearest neighbour, overlapping granules
     never counted twice) and reports valid / invalid / missing pixels for every acquisition,
   - **fire, chlorophyll, rainfall and radar-brightness indicators**: estimated from NASA **GIBS**
     imagery and NASA's colour maps (labelled as estimates in the app),
   - GIBS imagery is otherwise used for display only (“NASA original” view).
4. **Results**
   - **3D globe** – a Google-Earth-style spinning globe with an atmosphere (MapLibre GL v5 globe
     projection). Switch to a **flat** map at any time, turn on a **latitude/longitude grid**
     (30° lines on the whole globe, 10° / 5° / 1° lines appear as you zoom in, equator and prime
     meridian highlighted) and optional **3D terrain** (tilt with right-drag or Ctrl+drag).
     Base map: satellite + labels, satellite, or street map. Your choices are remembered.
   - **Map** – "Analysed" view (one colour family per phenomenon, darker = more intense; for water only
     pixels actually classified as water are drawn: newly inundated, normal water, or water with no
     baseline, with unobserved pixels hatched) or "NASA original" view. Tick **Show pre-event
     baseline** under the timeline to compare water before and after the event.
   - **Map controls** – left-drag moves (clicks never add points), right-drag rotates/tilts (no browser
     menu), the wheel zooms, middle-click adds an AOI point. The **?** button on the map lists the controls.
   - **Interactive timeline** – a row per dataset showing every NASA acquisition (thin ticks), the
     analysed dates (circles coloured by intensity), water baseline observations (squares), the
     pre-event window, low-coverage dates (dashed) and failures (×). Drag the slider, click the
     timeline or press ▶ to play through time.
   - **Event track** – above the satellite tracks, one row per phenomenon showing when the event
     happened according to the observations (see *Event timeline* below). Click a band or use
     **Before / During / After** to jump there; map, imagery, findings and chart follow.
   - **Chart** – detected km² per dataset over time (dashed = radar); the selected event is shaded.
   - **Findings** – per phenomenon: km² and % of area, overall severity badge, trend since the
     first date, area per intensity level, and **area confirmed by 2+ independent sensors**.
     Floods: newly inundated km² and % of the *observable* area, normal/permanent vs new water,
     valid coverage, confidence (with reasons), baseline dates, observation date and a per-source table.
   - **Data sources** – clear indicators for each dataset: LIVE / no acquisitions / failed, satellite,
     sensor type (SAR / Optical / Thermal / Ocean colour), agency, NASA CMR granule count with a link
     to verify the query, image coverage, method, GIBS layer ID, and links to Earthdata Search and
     NASA Worldview.
   - **Export** – CSV and JSON of every number.
5. **Movable panels** – the map fills the window; the *Analysis setup*, *Results* and *Timeline*
   panels can be **dragged by their title bar to the left, right, top or bottom** of the map
   (or use the ⇆ button), resized by dragging their inner edge, and collapsed with **–**.
   The layout is saved in your browser; **Reset layout** in the top bar restores the default.
6. **Guided tour** – **How to use EarthScope** in the top bar walks through the eight steps of an
   analysis, highlighting the real controls. It never starts on its own. Technical terms (SAR,
   NISAR, backscatter, change detection, baseline, coverage…) have tooltips (dotted underline).

## NASA datasets used

| Phenomenon | Dataset | Satellite / sensor | Type |
|---|---|---|---|
| Vegetation disturbance | OPERA DIST-ALERT-HLS – `VEG-DIST-STATUS`, `VEG-ANOM-MAX` rasters | Landsat 8/9 + Sentinel-2 (HLS) | Optical |
| Vegetation disturbance (compared) | OPERA DIST-ALERT-S1 – `GEN-DIST-STATUS` raster | Sentinel-1 C-band | SAR |
| Indicator only | OPERA RTC-S1 (radar brightness change, GIBS) | Sentinel-1 C-band | SAR |
| Indicator only | NISAR L2 GCOV (radar brightness change, GIBS) | NISAR L-band (NASA–ISRO) | SAR |
| Surface water / floods | OPERA DSWx-S1 – `B01_WTR` raster | Sentinel-1 C-band | SAR |
| Surface water / floods | OPERA DSWx-HLS – `B01_WTR` raster | Landsat 8/9 + Sentinel-2 | Optical |
| Surface water / floods | MODIS Global Flood, LANCE NRT (`MCDWD_L3_F2_NRT`) raster | Terra + Aqua MODIS | Optical (independent check) |
| Floods – context only | GPM IMERG precipitation rate | GPM constellation | Precipitation |
| Fires | VIIRS Thermal Anomalies 375 m (FIRMS) | Suomi NPP VIIRS | Thermal |
| Algae / chlorophyll | PACE OCI Chlorophyll-a | PACE | Ocean colour |
| Algae / chlorophyll | MODIS Aqua Chlorophyll-a | Aqua MODIS | Ocean colour |

The Data sources tab also explains why Sentinel-1 RTC (same acquisitions as DSWx-S1 – would be
double-counted), Sentinel-2/Landsat (already inside DSWx-HLS), VIIRS flood maps and NISAR are not
used for flood extent.

Dataset definitions (layer IDs, CMR short names, intensity rules) live in
[`public/js/config.js`](public/js/config.js) – add a phenomenon or dataset there.

### How vegetation disturbance is measured
OPERA DIST detects vegetation **disturbance**; it does not establish the cause, so the app says
“vegetation disturbance / loss”, not deforestation.
- `VEG-DIST-STATUS` (DIST-ALERT-HLS v1) is decoded numerically: 0 no disturbance · 1/2/3 first /
  provisional / confirmed with **< 50 %** cover loss · 4/5/6 the same with **≥ 50 %** · 7/8 confirmed and
  finished · 255 no data. **All** first, provisional and confirmed classes, including the < 50 %
  ones, are detections. No data is invalid, never “no disturbance”.
- `VEG-ANOM-MAX` (0–100 % maximum vegetation-cover loss; 255 = no data) gives the loss magnitude.
- Two separate, user-adjustable **analysis settings** (not universal definitions):
  *minimum loss per pixel* (default 20 %, applied to `VEG-ANOM-MAX`; options 0–50 %) and *minimum patch
  size* (default **none** – every pixel counts; options 0.09–5 ha). Changing them re-evaluates the
  downloaded rasters instantly. Everything they leave out is still reported (“flagged by DIST but
  below the loss setting”, “in patches smaller than…”, “loss anomaly without a DIST alert”).
- Results show confirmed / provisional / first-detection area separately for < 50 % and ≥ 50 % loss,
  mean and maximum loss, patch count, valid / masked / missing coverage, observation date and source.
- DIST-ALERT-S1 (radar, generic surface disturbance) is reported next to it with the overlap of their
  detections – never added. RTC-S1 and NISAR brightness changes are shown only as indicators.
- Analysis is on the native 30 m grid; very large areas (> 4 million cells) are sampled every 60 m,
  90 m… with nearest neighbour, and the app says so.

### How intensity is decided (imagery-based estimates)
- **Chlorophyll**: thresholds on NASA's mg/m³ values: 1 / 5 / 20 / 50.
- **Fires**: every NASA fire-detection pixel counts.
- **Radar indicators (RTC-S1, NISAR)**: how much NASA's radar visualisation *darkened* compared with
  the first date – an indicator, not calibrated dB (for exact values use `extras/nisar_to_geotiff.py`).
- The badge shows the highest level **present** (any area); the area of every level is listed.

### Event timeline (how event dates are estimated)
Events are built only from the analysed observations, one per phenomenon
([`public/js/events.js`](public/js/events.js), unit-tested). No date is ever invented:
- A date is **affected** when a valid observation shows the phenomenon (floods: new water with
  ≥ 25 % valid coverage and a known baseline; fires: any VIIRS active-fire pixel; others: intensity
  above "none"), **clear** when a valid observation shows it absent, otherwise **unknown**.
  Several sources on the same date are merged: affected if any source saw it; disagreement is flagged.
- **Onset** = the window between the last clear and the first affected observation
  (e.g. dry on 10 Aug, flooded on 14 Aug → onset 10–14 Aug). With no earlier clear observation the
  start is shown open-ended ("on or before …").
- **Peak** = the highest observed value (not necessarily the true peak). Floods also show
  **recession** (first later observation below half the peak).
- **End / recovery** = the window between the last affected and the first later clear observation;
  if there is none the event is shown as **ongoing / end not observed**.
- Observations that cannot tell (no baseline, too little coverage) give an **uncertain** hatched band
  with no dates. Dates in a window, or after the last observation of an ongoing event, are labelled
  *uncertain* rather than before/after.
- **Date confidence** (High / Medium / Low) depends on the onset window width, whether the end was
  observed, the number of affected observations and independent sources.
- For wildfires the last satellite detection is **not** containment (clouds, smoke and overpass
  times hide fire). Officially **reported** dates (e.g. CAL FIRE's reported ignition and 100 %
  containment of the Palisades Fire, NWS reports for the Texas floods) are attached to the examples
  as separate, attributed markers. They are only shown while the example's area is unchanged and
  the date is inside the period. They are never used to compute satellite dates.
- Each event's source datasets, supporting observations, confidence, reasons and estimation method
  are stored and included in the JSON export.

### How floods are measured (no severity scale)
Water products are **categorical**, so they are never turned into Low/Moderate/High/Severe.
1. **Classes** are decoded from the numerical **WTR** band of each file (never from map colours):
   DSWx-HLS 0 not water · 1 open water · 2 partial surface water · 252 snow/ice · 253 cloud/shadow ·
   254 ocean masked · 255 no data; DSWx-S1 0 not water · 1 open water · 3 inundated vegetation ·
   250 HAND masked · 251 layover/shadow masked · 255 fill; MODIS flood 1–2 reference/recurring water,
   3 flood. Masked, fill and **any undocumented value are invalid** – never water – and are counted in
   the diagnostics. BWTR, CONF and DIAG are separate kinds of information and are not mixed in.
2. **Nearest-neighbour sampling** on a 30 m UTM grid aligned with the OPERA tiles: categorical
   values are never interpolated; overlapping granules are never counted twice.
3. **No data is not dry and not wet.** Areas with no file or no valid pixel are reported as missing
   or invalid coverage, and a failed download is a **data retrieval error**, never “no flood”.
4. **Baseline**: all valid observations strictly **before** the flood event date, combined per pixel
   by majority (water in ≥ half of them = permanent, in some = occasional, never = dry). Without an
   event date the earliest observations are *assumed* pre-event – the app says so and caps confidence
   at Medium.
5. **Newly inundated** = valid water now that was validly dry in the baseline (or that the MODIS
   product itself flags as unusual flood). Water whose baseline is unknown is shown separately and
   not counted as new. Percentages are of the **valid observed** area; valid, masked and missing
   coverage are reported separately. “New water detected” needs ≥ 0.5 % of the observed area or
   ≥ 0.05 km² (a stated noise floor); smaller amounts are still reported as numbers.
6. **Sensors are not averaged.** The headline uses the source with the best valid coverage; other
   sources observed within 3 days are compared pixel by pixel to compute agreement (inundated
   vegetation, which only radar can see, is excluded from that comparison).
7. **Confidence** (separate from the amount of water): *Insufficient data* if < 25 % of the area was
   observed or the baseline is unknown for most pixels; *High* needs ≥ 70 % coverage, ≥ 70 % known
   baseline and ≥ 80 % agreement with a second independent sensor; *Medium* ≥ 50 % / ≥ 50 %; else
   *Low*. Disagreement between sensors lowers it one step.
8. **Rainfall (GPM IMERG)** is context only and never counted as flooded area.

## Deploy: GitHub → Cloudflare

1. Push this folder to a GitHub repository.
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the repo.
3. Settings: **Build command:** *(leave empty)* · **Deploy command:** `npx wrangler deploy`.
   The Worker name must match `name` in `wrangler.jsonc` (`earth-surface-monitor`).
4. Deploy. Every push to the main branch redeploys automatically.

**NASA Earthdata token (required for vegetation-disturbance and flood numbers).** The OPERA and
LANCE GeoTIFFs are Earthdata-protected. Create a token at urs.earthdata.nasa.gov (profile → Generate
Token) and store it as a Worker secret – it stays on the server, is sent only to NASA / DAAC hosts and
never to CDN redirects:
```bash
npx wrangler secret put EARTHDATA_TOKEN
```
Without it the app shows “Earthdata access not configured” for those datasets (a data error, not a
result). GIBS and CMR need no token.

### Run locally
```bash
npm install
npm run dev          # http://localhost:8787
npm test             # unit tests: classification, raster decoding (GeoTIFF fixtures), geometry,
                     # gestures, events, worker
npm run test:e2e     # headless-browser end-to-end test (needs Python Playwright + Pillow)
EARTHDATA_TOKEN=… npm run test:integration   # live NASA data: July 2025 Central Texas flood
```

## Project structure
```
wrangler.jsonc          Cloudflare config (Worker + static assets)
src/worker.js           Worker: serves the app, relays + caches NASA GIBS/CMR, authenticated Earthdata
                        GeoTIFF relay (allow-listed, not an open proxy)
public/index.html       the app page
public/css/style.css
public/js/config.js     phenomena, intensity colours, NASA datasets, examples
public/js/classify.js   water baseline / statistics / confidence, imagery classification (pure, tested)
public/js/raster.js     GeoTIFF window reading, nearest-neighbour sampling, DIST / WTR decoding (tested)
public/js/geo.js        UTM projection, metric circles, polygon checks, 30 m analysis grid (tested)
public/js/pointer.js    click / drag / multi-touch gesture classification (tested)
public/js/nasa.js       calls to /api (CMR, GIBS images, colour maps, remote GeoTIFFs, typed data errors)
public/js/app.js        globe/map, coordinate table, timeline, chart, findings, data-source indicators
public/js/graticule.js  latitude/longitude grid lines + labels
public/js/layout.js     draggable / resizable / collapsible panels
public/js/events.js     event detection: onset / peak / end windows, phases (pure, unit-tested)
public/js/tour.js       guided tour ("How to use EarthScope")
public/js/glossary.js   plain-language tooltips for technical terms
tests/                  unit tests + headless-browser end-to-end test
extras/                 Google Earth Engine version + NISAR GCOV → GeoTIFF converter
```

## Limitations (say these in the pitch – judges like honesty)
- The raster pipeline has been tested with GeoTIFF fixtures built from the documented class values,
  not yet end-to-end against live NASA files (the development environment could not reach NASA).
  Run `npm run test:integration` with a token to check it; the app also prints per-acquisition
  diagnostics (raw value histogram, file version, projection) so any mismatch is visible.
- DIST-ALERT-S1 band name (`GEN-DIST-STATUS`) and the MODIS flood file layout are assumptions until
  checked against live files; the app reports them as missing bands rather than guessing.
- Fire, chlorophyll, rainfall and radar-brightness indicators still come from NASA GIBS
  visualisations (labelled as estimates; radar is brightness-based, not calibrated dB).
- Clouds hide optical data (DIST-ALERT, DSWx-HLS, chlorophyll); radar datasets (RTC-S1, DSWx-S1,
  NISAR) see through clouds – that's why both are combined.
- NISAR coverage depends on NASA's release schedule; the app reports "no acquisitions" honestly when
  NASA has none for the area/period.
- If NASA has no colour map for a vegetation/fire/chlorophyll layer, any coloured pixel counts as
  "detected" and the Data sources panel says so. Water and rainfall layers without a colour map are
  **not used** (their classes cannot be read safely).
- The MODIS flood product is near-real-time; NASA keeps only recent NRT granules, so older periods may
  show "no data". The IMERG layer is read as a 30-minute snapshot per sampled day – sparse context, not
  a rainfall total.

Data: NASA GIBS, NASA CMR / Earthdata, OPERA (JPL), NISAR (NASA–ISRO), LP DAAC, PO.DAAC, ASF DAAC,
OB.DAAC, LANCE/FIRMS. Base maps © OpenStreetMap contributors, Esri.
