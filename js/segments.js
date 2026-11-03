// Trail segments: every walkable or rideable OSM way that isn't a paved road (paths,
// tracks, footways, bridleways, cycleways, steps, unpaved minor roads), prebuilt into
// small tiles by scripts/build-trails.mjs and shipped with the app, so they load
// instantly and work offline. Each segment can carry a difficulty rating and name.

export const TILE_SIZE = 0.05; // degrees
// How far (in tiles, each way) a trail is followed from where it's tapped, so a long trail
// or a common name doesn't pull in the whole state.
export const TRAIL_REACH = 6;
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
    id: String(id), name: name || '', kind, coords: json.v === 2 ? unpack(coords) : coords.map(([lng, lat]) => ({ lat, lng })), private: access === 'p',
  }));
}

// Version 2 tiles store a line as [lng, lat, dlng, dlat, ...] in 1e-5 degrees: the first
// point, then the step to each next one.
function unpack(flat) {
  const out = [];
  let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i]; y += flat[i + 1];
    out.push({ lat: y / 1e5, lng: x / 1e5 });
  }
  return out;
}

export function segmentLabel(seg, name = seg.name) {
  return name || `Unnamed ${(HIGHWAY_LABEL[seg.kind] || 'trail').toLowerCase()}`;
}

const tileOf = (p) => [Math.floor(p.lat / TILE_SIZE), Math.floor(p.lng / TILE_SIZE)];
const tileAt = (k) => k.split('_').map(Number);
// Whether tile k is within TRAIL_REACH tiles of tile [r, c] (the same test the build uses).
const inReach = (k, [r, c]) => { const [r2, c2] = tileAt(k); return Math.abs(r2 - r) <= TRAIL_REACH && Math.abs(c2 - c) <= TRAIL_REACH; };
const keyBounds = (k) => { const [r, c] = tileAt(k); return { south: r * TILE_SIZE, north: (r + 1) * TILE_SIZE, west: c * TILE_SIZE, east: (c + 1) * TILE_SIZE }; };
export const intersects = (a, b) => a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;

/** The area a trail is followed over from a point: TRAIL_REACH tiles each way around its tile. */
export function trailWindow(p) {
  const [r, c] = tileOf(p);
  return { south: (r - TRAIL_REACH) * TILE_SIZE, north: (r + TRAIL_REACH + 1) * TILE_SIZE, west: (c - TRAIL_REACH) * TILE_SIZE, east: (c + TRAIL_REACH + 1) * TILE_SIZE };
}

/** A segment's bounding box (kept on the segment). */
export function segmentBounds(seg) {
  if (!seg.bounds) {
    const lats = seg.coords.map((c) => c.lat), lngs = seg.coords.map((c) => c.lng);
    seg.bounds = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lngs), east: Math.max(...lngs) };
  }
  return seg.bounds;
}

// Tiles kept in memory; the ones farthest from the view are dropped beyond this.
const MAX_LOADED = 120;

/** Loads tiles on demand and keeps the segments of the ones loaded, keyed by OSM way id. */
export class SegmentStore {
  constructor(baseUrl = 'data/trails/') {
    this.baseUrl = baseUrl;
    this.index = null;
    this.available = null;   // tile keys that exist
    this.loaded = new Map(); // tile key -> Promise
    this.tileIds = new Map(); // tile key -> way ids in it
    this.tileNames = new Map(); // tile key -> {trail name: other tiles nearby it continues into}
    this.useCount = new Map(); // way id -> loaded tiles it's in
    this.segments = new Map();
  }

  /**
   * Load the tiles a named trail runs through around a point (TRAIL_REACH tiles each way),
   * and return its segments there.
   */
  async loadTrail(name, near) {
    await this.loadIndex();
    const at = tileOf(near), [r, c] = at;
    await this.loadKeys([-1, 0, 1].flatMap((dr) => [-1, 0, 1].map((dc) => tileKey(r + dr, c + dc))).filter((k) => this.available.has(k)));
    const more = new Set();
    for (const [k, names] of this.tileNames) {
      if (inReach(k, at)) for (const k2 of names[name] || []) if (inReach(k2, at) && this.available.has(k2)) more.add(k2);
    }
    await this.loadKeys([...more]);
    return this.named(name, near);
  }

  /** Whether a trail loaded with loadTrail() goes on beyond the area around the point. */
  continuesBeyond(name, near) {
    const at = tileOf(near);
    for (const [k, names] of this.tileNames) if (inReach(k, at) && (names[name] || []).some((k2) => !inReach(k2, at))) return true;
    return false;
  }

  /** Segments with this map name near a point. */
  named(name, near) {
    if (!name) return [];
    const win = trailWindow(near);
    return [...this.segments.values()].filter((s) => s.name === name && intersects(segmentBounds(s), win));
  }

  async loadKeys(keys) {
    const fresh = keys.filter((k) => !this.loaded.has(k));
    await Promise.all([...new Set(keys)].map((k) => {
      if (this.loaded.has(k)) return this.loaded.get(k);
      const p = fetch(`${this.baseUrl}tiles/${k}.json`)
        .then((r) => (r.ok ? r.json() : { ways: [] }))
        .then((json) => {
          if (this.loaded.get(k) !== p) return; // dropped while loading
          const ids = [];
          for (const s of parseTile(json)) {
            if (!this.segments.has(s.id)) this.segments.set(s.id, s);
            this.useCount.set(s.id, (this.useCount.get(s.id) || 0) + 1);
            ids.push(s.id);
          }
          this.tileIds.set(k, ids);
          this.tileNames.set(k, json.names || {});
        })
        .catch(() => this.loaded.delete(k)); // retry next time
      this.loaded.set(k, p);
      return p;
    }));
    return fresh.length > 0;
  }

  async loadIndex() {
    if (!this.index) {
      this.index = fetch(`${this.baseUrl}index.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
        .then((index) => {
          // Version 2 lists column ranges per row; version 1 lists every tile.
          this.available = new Set(index.tiles || Object.entries(index.rows || {}).flatMap(([r, ranges]) =>
            ranges.flatMap(([c0, c1]) => Array.from({ length: c1 - c0 + 1 }, (_, i) => tileKey(r, c0 + i)))));
          return index;
        });
    }
    return this.index;
  }

  /** Load any tiles in view not loaded yet. Resolves true if the segments changed. */
  async loadBounds(bounds, { maxTiles = 36 } = {}) {
    await this.loadIndex();
    const keys = tilesInBounds(bounds).map((t) => tileKey(t.row, t.col)).filter((k) => this.available.has(k));
    const fresh = await this.loadKeys(keys.filter((k) => !this.loaded.has(k)).slice(0, maxTiles));
    return this.unloadFar(bounds) || fresh;
  }

  /** Drop the tiles farthest from the view once more than MAX_LOADED are loaded. */
  unloadFar(bounds, max = MAX_LOADED) {
    if (this.tileIds.size <= max) return false;
    const lat = (bounds.south + bounds.north) / 2, lng = (bounds.west + bounds.east) / 2;
    const dist = (k) => { const b = keyBounds(k); return Math.hypot((b.south + b.north) / 2 - lat, ((b.west + b.east) / 2 - lng) * Math.cos(lat * Math.PI / 180)); };
    const far = [...this.tileIds.keys()].filter((k) => !intersects(keyBounds(k), bounds)).sort((a, b) => dist(b) - dist(a));
    for (const k of far.slice(0, this.tileIds.size - max)) {
      for (const id of this.tileIds.get(k)) {
        const n = this.useCount.get(id) - 1;
        if (n > 0) this.useCount.set(id, n);
        else { this.useCount.delete(id); this.segments.delete(id); }
      }
      this.tileIds.delete(k);
      this.tileNames.delete(k);
      this.loaded.delete(k);
    }
    return true;
  }

  /** Whether any shipped trail data covers this view. */
  covers(bounds) {
    return !!this.available && tilesInBounds(bounds).some((t) => this.available.has(tileKey(t.row, t.col)));
  }
}
