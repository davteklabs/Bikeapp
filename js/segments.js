// Trail segments: every walkable or rideable OSM way that isn't a paved road (paths,
// tracks, footways, bridleways, cycleways, steps, unpaved minor roads), prebuilt into
// small tiles by scripts/build-trails.mjs and shipped with the app, so they load
// instantly and work offline. Each segment can carry a difficulty rating and name.

export const TILE_SIZE = 0.05; // degrees
export const HIGHWAY_LABEL = { p: 'Path', t: 'Track', f: 'Footway', b: 'Bridleway', c: 'Bike path', s: 'Steps', r: 'Dirt road' };

export const tileKey = (row, col) => `${row}_${col}`;

/** Grid tiles (row/col indices and their bounds) covering a bounding box. */
export function tilesInBounds({ south, west, north, east }) {
  const out = [];
  const r0 = Math.floor(south / TILE_SIZE), r1 = Math.floor(north / TILE_SIZE);
  const c0 = Math.floor(west / TILE_SIZE), c1 = Math.floor(east / TILE_SIZE);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const s = +(row * TILE_SIZE).toFixed(6), w = +(col * TILE_SIZE).toFixed(6);
      out.push({ row, col, south: s, west: w, north: +(s + TILE_SIZE).toFixed(6), east: +(w + TILE_SIZE).toFixed(6) });
    }
  }
  return out;
}

/** Tile file → segments: {id, name, kind, coords: [{lat,lng}], private}. */
export function parseTile(json) {
  return (json.ways || []).map(([id, name, kind, coords, access]) => ({
    id: String(id), name: name || '', kind, coords: coords.map(([lng, lat]) => ({ lat, lng })), private: access === 'p',
  }));
}

export function segmentLabel(seg, name = seg.name) {
  return name || `Unnamed ${(HIGHWAY_LABEL[seg.kind] || 'trail').toLowerCase()}`;
}

/** Loads tiles on demand and keeps every segment seen so far, keyed by OSM way id. */
export class SegmentStore {
  constructor(baseUrl = 'data/trails/') {
    this.baseUrl = baseUrl;
    this.index = null;
    this.names = null;      // trail name -> tile keys it appears in
    this.loaded = new Map(); // tile key -> Promise
    this.segments = new Map();
  }

  async loadNames() {
    if (!this.names) {
      this.names = fetch(`${this.baseUrl}names.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    }
    return this.names;
  }

  async hasName(name) {
    return !!name && !!(await this.loadNames())[name];
  }

  /** Load every tile a named trail passes through, so the whole trail can be shown. */
  async loadTrail(name) {
    const keys = (await this.loadNames())[name] || [];
    await this.loadKeys(keys);
    return this.named(name);
  }

  named(name) {
    return name ? [...this.segments.values()].filter((s) => s.name === name) : [];
  }

  async loadKeys(keys) {
    const fresh = keys.filter((k) => !this.loaded.has(k));
    await Promise.all([...new Set(keys)].map((k) => {
      if (this.loaded.has(k)) return this.loaded.get(k);
      const p = fetch(`${this.baseUrl}tiles/${k}.json`)
        .then((r) => (r.ok ? r.json() : { ways: [] }))
        .then((json) => { for (const s of parseTile(json)) this.segments.set(s.id, s); })
        .catch(() => this.loaded.delete(k)); // retry next time
      this.loaded.set(k, p);
      return p;
    }));
    return fresh.length > 0;
  }

  async loadIndex() {
    if (!this.index) {
      this.index = fetch(`${this.baseUrl}index.json`).then((r) => (r.ok ? r.json() : { tiles: [], regions: [] }))
        .catch(() => ({ tiles: [], regions: [] }));
    }
    const index = await this.index;
    this.available = new Set(index.tiles);
    return index;
  }

  /** Load any tiles in view not loaded yet. Resolves true if new segments arrived. */
  async loadBounds(bounds, { maxTiles = 36 } = {}) {
    await this.loadIndex();
    const keys = tilesInBounds(bounds).map((t) => tileKey(t.row, t.col)).filter((k) => this.available.has(k));
    return this.loadKeys(keys.filter((k) => !this.loaded.has(k)).slice(0, maxTiles));
  }

  /** Whether any shipped trail data covers this view. */
  covers(bounds) {
    return !!this.available && tilesInBounds(bounds).some((t) => this.available.has(tileKey(t.row, t.col)));
  }
}
