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

/** Sensible defaults per activity. */
export const MODE_DEFAULTS = {
  bike: { base: 'cyclosm', overlays: ['cycling', 'mtb'] },
  hike: { base: 'topo', overlays: ['hiking'] },
};
