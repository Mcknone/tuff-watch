// =============================================================================
// Latitude / longitude grid ("graticule") as GeoJSON lines.
// Each line gets a `rank` = the coarsest spacing it belongs to, so the map can
// show 30° lines on the whole globe and add 10°, 5° and 1° lines as you zoom in.
// =============================================================================

export const GRATICULE_RANKS = [
  { step: 30, minzoom: 0 },
  { step: 10, minzoom: 2 },
  { step: 5, minzoom: 3.5 },
  { step: 1, minzoom: 5.5 }
];
const MAX_LAT = 85;     // the globe/web-mercator view stops at ~85°

const rankOf = v => GRATICULE_RANKS.findIndex(r => v % r.step === 0);

export function latLabel(lat) {
  return lat === 0 ? 'Equator 0°' : `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`;
}
export function lonLabel(lon) {
  if (lon === 0) return 'Prime meridian 0°';
  if (Math.abs(lon) === 180) return '180°';
  return `${Math.abs(lon)}°${lon > 0 ? 'E' : 'W'}`;
}

export function graticuleGeoJSON() {
  const features = [];
  // meridians (lines of longitude)
  for (let lon = -180; lon < 180; lon++) {
    const rank = rankOf(lon);
    if (rank < 0) continue;
    const coords = [];
    for (let lat = -MAX_LAT; lat <= MAX_LAT; lat += 2.5) coords.push([lon, lat]);
    features.push({
      type: 'Feature',
      properties: { rank, kind: 'lon', major: lon === 0, label: lonLabel(lon) },
      geometry: { type: 'LineString', coordinates: coords }
    });
  }
  // parallels (lines of latitude)
  for (let lat = -80; lat <= 80; lat++) {
    const rank = rankOf(lat);
    if (rank < 0) continue;
    const coords = [];
    for (let lon = -180; lon <= 180; lon += 2.5) coords.push([lon, lat]);
    features.push({
      type: 'Feature',
      properties: { rank, kind: 'lat', major: lat === 0, label: latLabel(lat) },
      geometry: { type: 'LineString', coordinates: coords }
    });
  }
  return { type: 'FeatureCollection', features };
}
