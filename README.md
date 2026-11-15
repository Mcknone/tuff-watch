# 🛰️ Earth Surface Change Monitor

**NASA Space Apps Challenge** – an interactive web app that monitors changes on Earth's surface over
time – **deforestation, flooding, fires and algae blooms** – using **real NASA radar (SAR) and optical
satellite data**. Runs on **Cloudflare Workers**, no Google Earth Engine needed.

## What it does

1. **Coordinates table** – type latitude/longitude (1 point = circle, 2 = rectangle, 3+ = polygon)
   or click the map. Your area is outlined in orange and everything outside it is dimmed.
2. **Time period + phenomena** – pick dates and any of the 4 phenomena.
3. **Analyse** – for every dataset the app:
   - asks **NASA CMR** (Common Metadata Repository) which real satellite acquisitions cover your area
     in that period,
   - downloads NASA's science imagery for those dates from **NASA GIBS**,
   - reads every pixel and classifies it using NASA's own colour map (class names / values),
   - turns it into **phenomenon + intensity (Low / Moderate / High / Severe)**.
4. **Results**
   - **3D globe** – a Google-Earth-style spinning globe with an atmosphere (MapLibre GL v5 globe
     projection). Switch to a **flat** map at any time, turn on a **latitude/longitude grid**
     (30° lines on the whole globe, 10° / 5° / 1° lines appear as you zoom in, equator and prime
     meridian highlighted) and optional **3D terrain** (tilt with right-drag or Ctrl+drag).
     Base map: satellite + labels, satellite, or street map. Your choices are remembered.
   - **Map** – "Classified intensity" view (one colour family per phenomenon, darker = more intense)
     or "NASA original colours" view.
   - **Interactive timeline** – a row per dataset showing every NASA acquisition (thin ticks), the
     analysed dates (circles coloured by intensity) and failures (×). Drag the slider, click the
     timeline or press ▶ to play through time.
   - **Chart** – detected km² per dataset over time (dashed = radar).
   - **Findings** – per phenomenon: km² and % of area, overall severity badge, trend since the
     first date, area per intensity level, and **area confirmed by 2+ independent sensors**.
   - **Data sources** – clear indicators for each dataset: LIVE / no acquisitions / failed, satellite,
     sensor type (SAR / Optical / Thermal / Ocean colour), agency, NASA CMR granule count with a link
     to verify the query, image coverage, method, GIBS layer ID, and links to Earthdata Search and
     NASA Worldview.
   - **Export** – CSV and JSON of every number.
5. **Movable panels** – the map fills the window; the *Analysis setup*, *Results* and *Timeline*
   panels can be **dragged by their title bar to the left, right, top or bottom** of the map
   (or use the ⇆ button), resized by dragging their inner edge, and collapsed with **–**.
   The layout is saved in your browser; **Reset layout** in the top bar restores the default.

## NASA datasets used

| Phenomenon | Dataset | Satellite / sensor | Type |
|---|---|---|---|
| 🌳 Vegetation loss | OPERA DIST-ALERT-HLS | Landsat 8/9 + Sentinel-2 (HLS) | Optical |
| 🌳 Vegetation loss | OPERA RTC-S1 (radar darkening) | Sentinel-1 C-band | SAR |
| 🌳 Vegetation loss | NISAR L2 GCOV (radar darkening) | NISAR L-band (NASA–ISRO) | SAR |
| 🌊 Surface water / floods | OPERA DSWx-S1 | Sentinel-1 C-band | SAR |
| 🌊 Surface water / floods | OPERA DSWx-HLS | Landsat 8/9 + Sentinel-2 | Optical |
| 🔥 Fires | VIIRS Thermal Anomalies 375 m (FIRMS) | Suomi NPP VIIRS | Thermal |
| 🦠 Algae / chlorophyll | PACE OCI Chlorophyll-a | PACE | Ocean colour |
| 🦠 Algae / chlorophyll | MODIS Aqua Chlorophyll-a | Aqua MODIS | Ocean colour |

Dataset definitions (layer IDs, CMR short names, intensity rules) live in
[`public/js/config.js`](public/js/config.js) – add a phenomenon or dataset there.

### How intensity is decided
- **Categorical products** (DIST-ALERT, DSWx): NASA's class names are mapped to levels, e.g. DIST
  "confirmed ≥50 % loss" → Severe; DSWx "partial surface water" → Moderate, "open water" → High,
  water that was dry at the first date → **Severe (new flooding)**. Cloud / snow / no-data classes are
  excluded.
- **Chlorophyll**: thresholds on NASA's mg/m³ values: 1 / 5 / 20 / 50.
- **Radar (RTC-S1, NISAR)**: how much the radar image *darkened* compared with the first date
  (a backscatter drop, typical of forest clearing). This uses NASA's visualised radar imagery, so it is
  an indicator – for exact dB values use `extras/nisar_to_geotiff.py`.
- **Fires**: every NASA fire-detection pixel counts.

## Deploy: GitHub → Cloudflare

1. Push this folder to a GitHub repository.
2. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick the repo.
3. Settings: **Build command:** *(leave empty)* · **Deploy command:** `npx wrangler deploy`.
   The Worker name must match `name` in `wrangler.jsonc` (`earth-surface-monitor`).
4. Deploy. Every push to the main branch redeploys automatically.

No secrets are needed: NASA GIBS and CMR are public services.

### Run locally
```bash
npm install
npm run dev          # http://localhost:8787
npm test             # unit tests (classification + worker)
```

## Project structure
```
wrangler.jsonc          Cloudflare config (Worker + static assets)
src/worker.js           Worker: serves the app, relays + caches NASA GIBS/CMR (allow-listed, not an open proxy)
public/index.html       the app page
public/css/style.css
public/js/config.js     phenomena, intensity colours, NASA datasets, examples
public/js/classify.js   pixel classification, radar darkening, area statistics (pure, unit-tested)
public/js/nasa.js       calls to /api (CMR, GIBS images, colour maps)
public/js/app.js        globe/map, coordinate table, timeline, chart, findings, data-source indicators
public/js/graticule.js  latitude/longitude grid lines + labels
public/js/layout.js     draggable / resizable / collapsible panels
tests/                  unit tests + headless-browser end-to-end test
extras/                 Google Earth Engine version + NISAR GCOV → GeoTIFF converter
```

## Limitations (say these in the pitch – judges like honesty)
- Imagery comes from NASA GIBS visualisations (exact class colours for categorical products; radar
  is a brightness-based indicator, not calibrated dB).
- Clouds hide optical data (DIST-ALERT, DSWx-HLS, chlorophyll); radar datasets (RTC-S1, DSWx-S1,
  NISAR) see through clouds – that's why both are combined.
- NISAR coverage depends on NASA's release schedule; the app reports "no acquisitions" honestly when
  NASA has none for the area/period.
- If NASA has no colour map for a layer, any coloured pixel counts as "detected" and the Data sources
  panel says so.

Data: NASA GIBS, NASA CMR / Earthdata, OPERA (JPL), NISAR (NASA–ISRO), LP DAAC, PO.DAAC, ASF DAAC,
OB.DAAC, LANCE/FIRMS. Base maps © OpenStreetMap contributors, Esri.
