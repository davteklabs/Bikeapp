// Public map tile sources. All are OpenStreetMap-based and free for
// light/personal use; for a high-traffic production app switch to a paid
// provider or self-hosted tiles (see README).

export const BASE_LAYERS = {
  cyclosm: {
    name: 'CyclOSM (bike)',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    options: { maxZoom: 20, subdomains: 'abc', attribution: '<a href="https://www.cyclosm.org">CyclOSM</a> | © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  },
  topo: {
    name: 'OpenTopoMap (hike)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 17, subdomains: 'abc', attribution: 'Map: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) | © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM' },
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  },
};

export const OVERLAYS = {
  hiking: {
    name: 'Hiking trails',
    url: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png',
    options: { maxZoom: 18, opacity: 0.8, attribution: 'Trails: <a href="https://waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)' },
  },
  cycling: {
    name: 'Cycling routes',
    url: 'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png',
    options: { maxZoom: 18, opacity: 0.8, attribution: 'Trails: <a href="https://waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)' },
  },
  mtb: {
    name: 'MTB trails',
    url: 'https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png',
    options: { maxZoom: 18, opacity: 0.8, attribution: 'Trails: <a href="https://waymarkedtrails.org">Waymarked Trails</a> (CC-BY-SA)' },
  },
};

/**
 * Water (lakes, reservoirs, rivers, canals, creeks), drawn as sharp vector shapes on
 * top of the faded base map so it stays clearly water. Light sky blue: distinct from
 * the dark "blue" difficulty rating and the blue navigation route.
 */
export const WATER = {
  source: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
  fill: '#bfe6fa', outline: '#7ccbef', line: '#5bbfe8',
};

/**
 * Defaults per activity. The route overlays are off by default: their coloured
 * highlights (often blue) could be mistaken for difficulty ratings.
 */
// Bike uses the OSM standard map: its tile servers answered in ~0.2-0.5 s versus
// CyclOSM's 0.6-4 s when measured, and trails are drawn by the app on top anyway.
export const MODE_DEFAULTS = {
  bike: { base: 'osm', overlays: [] },
  hike: { base: 'topo', overlays: [] },
};

/** The app covers California only, opening at Granite Bay. */
export const REGION = {
  name: 'California',
  bounds: { south: 32.3, west: -124.7, north: 42.2, east: -113.9 },
  home: { center: [-121.165, 38.755], zoom: 12 },
};
export const inRegion = (lng, lat, b = REGION.bounds) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
