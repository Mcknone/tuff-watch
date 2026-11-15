// Synthetic GeoTIFF fixtures for automated tests ONLY. They use the documented class
// values of the real products, real projections (UTM / geographic) and 30 m pixels,
// but they are not observations and are never served by the app.
import { writeArrayBuffer, fromArrayBuffer } from 'geotiff';
import { fieldTagTypes } from '../node_modules/geotiff/dist-module/globals.js';

// geotiff.js can read GDAL_METADATA (42112) but its writer lacks the tag type – it is ASCII.
fieldTagTypes[42112] ??= 'ASCII';
import { toUtm } from '../public/js/geo.js';

/**
 * Build a single-band uint8 GeoTIFF.
 * opts: { epsg, x0, y0 (upper-left corner), res, width, height, value(x, y) → 0..255, nodata }
 * value() receives the pixel-centre coordinates in the raster CRS.
 */
export function makeTiff({ epsg, x0, y0, res, width, height, value, nodata = 255, version }) {
  const data = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    data[r * width + c] = value(x0 + (c + 0.5) * res, y0 - (r + 0.5) * res);
  }
  const geo = epsg === 4326
    ? { GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2 }
    : { ProjectedCSTypeGeoKey: epsg, GTModelTypeGeoKey: 1 };
  const meta = {
    width, height, BitsPerSample: [8], SampleFormat: [1],
    ModelPixelScale: [res, res, 0], ModelTiepoint: [0, 0, 0, x0, y0, 0], GTRasterTypeGeoKey: 1,
    GDAL_NODATA: String(nodata), ...geo
  };
  if (version) meta.GDAL_METADATA = `<GDALMetadata><Item name="PRODUCT_VERSION">${version}</Item></GDALMetadata>`;
  return writeArrayBuffer(data, meta);
}

export const open = buf => fromArrayBuffer(buf);

/** A raster covering a metric grid with a margin, aligned to the 30 m grid like OPERA tiles. */
export function tileFor(grid, margin = 300, res = 30) {
  const x0 = Math.floor((grid.x0 - margin) / res) * res;
  const y0 = Math.ceil((grid.y1 + margin) / res) * res;
  const width = Math.ceil((grid.w * grid.cell + 2 * margin) / res);
  const height = Math.ceil((grid.h * grid.cell + 2 * margin) / res);
  return { epsg: grid.epsg, x0, y0, res, width, height };
}

/** Axis-aligned box in grid-relative metres (from the grid's upper-left corner). */
export const inBox = (grid, x, y, [ox, oy, w, h]) => {
  const dx = x - grid.x0, dy = grid.y1 - y;
  return dx >= ox && dx < ox + w && dy >= oy && dy < oy + h;
};

export const rect = (lon0, lat0, lon1, lat1) => [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]];
export { toUtm };
