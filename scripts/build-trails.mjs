// Build the trail tiles the app loads (data/trails/) from an OpenStreetMap extract file:
// everything walkable or rideable that isn't a paved road (paths, tracks, footways,
// bridleways, cycleways, steps, and unpaved service/minor roads), for all of California.
//
//   curl -L -o logs/geofabrik/california.osm.pbf https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
//   node scripts/build-trails.mjs logs/geofabrik/california.osm.pbf
//
// Replaces everything in data/trails/:
//   tiles/<row>_<col>.json  0.05° tiles: {v: 2, ways: [[id, name, kind, coords, access?]], names}
//                           coords: [lng, lat, dlng, dlat, ...] in 1e-5° (first point, then steps)
//                           access 'p' = no public access (private or no)
//                           names: trail name -> other tiles nearby it continues into
//   index.json              which tiles exist: column ranges per row
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_SIZE, tileKey, TRAIL_REACH } from '../js/segments.js';
import { REGION } from '../js/layers.js';
import { openPbf, parseHeader, parseData } from './osm-pbf.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'data', 'trails');
// Segment kinds in the tiles; minor roads only appear when unpaved.
const HIGHWAY = { path: 'p', track: 't', footway: 'f', bridleway: 'b', cycleway: 'c', steps: 's' };
const MINOR = /^(service|unclassified|residential|road)$/;
const UNPAVED = /^(unpaved|gravel|fine_gravel|dirt|earth|ground|compacted|grass|sand|mud|rock|pebblestone|woodchips)$/;
const NO_ACCESS = /^(private|no)$/;
// Signed hiking/cycling routes: their names fill in for member ways that have none.
const ROUTE = /^(hiking|foot|walking|bicycle|mtb)$/;

/** Segment kind for a way's tags, or null if it isn't one we keep. */
function kindOf(t) {
  // Sidewalks and crossings are part of paved streets, so they're left out.
  if (HIGHWAY[t.highway]) return /^(sidewalk|crossing)$/.test(t.footway || '') ? null : HIGHWAY[t.highway];
  if (MINOR.test(t.highway || '') && UNPAVED.test(t.surface || '')) return 'r';
  if (t.highway === 'service' && t.tracktype !== undefined) return 'r';
  return null;
}

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/build-trails.mjs <extract.osm.pbf>');
  process.exit(1);
}
const t0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s`, ...a);
const pbf = openPbf(file);

// ---- pass 1: the ways we keep (with their node ids) and route names ----
let header = { features: [], timestamp: null };
const nodeBlocks = [];
const ways = []; // {id, name, kind, priv, start, n}
let refs = new Float64Array(1 << 24), nRefs = 0;
const routeName = new Map(); // way id -> name of a signed route it belongs to
let nBlocks = 0, nWays = 0;
for (const b of pbf.blocks()) {
  if (b.type === 'OSMHeader') { header = parseHeader(pbf.read(b)); continue; }
  if (b.type !== 'OSMData') continue;
  const d = parseData(pbf.read(b));
  if (d.nodes) nodeBlocks.push(b);
  if (d.ways) d.eachWay((id, t, r) => {
    nWays++;
    const kind = kindOf(t);
    if (!kind || r.length < 2) return;
    while (nRefs + r.length > refs.length) { const g = new Float64Array(refs.length * 2); g.set(refs); refs = g; }
    refs.set(r, nRefs);
    const priv = NO_ACCESS.test(t.access || '') || (NO_ACCESS.test(t.foot || '') && NO_ACCESS.test(t.bicycle || ''));
    ways.push({ id, name: t.name || null, kind, priv, start: nRefs, n: r.length });
    nRefs += r.length;
  });
  if (d.relations) d.eachRelation((id, t, members) => {
    const rname = t.name || t.ref;
    if (t.type !== 'route' || !ROUTE.test(t.route || '') || !rname) return;
    for (const m of members) if (m.type === 'way' && !routeName.has(m.ref)) routeName.set(m.ref, rname);
  });
  if (++nBlocks % 2000 === 0) log(`pass 1: ${nBlocks} blocks, ${nWays} ways read, ${ways.length} kept`);
}
log(`pass 1 done: ${nBlocks} blocks, ${nodeBlocks.length} with nodes, ${nWays} ways read, ${ways.length} kept, ${nRefs} node refs, ${routeName.size} ways in named routes`);
log('file:', basename(file), 'data as of', header.timestamp, 'features', header.features.join(' '));

// ---- pass 2: coordinates of the nodes those ways use ----
const nodeIds = refs.slice(0, nRefs).sort();
let m = 0;
for (let i = 0; i < nodeIds.length; i++) if (i === 0 || nodeIds[i] !== nodeIds[i - 1]) nodeIds[m++] = nodeIds[i];
const ids = nodeIds.subarray(0, m);
const lat = new Int32Array(m), lon = new Int32Array(m), found = new Uint8Array(m);
const lowerBound = (x) => { let lo = 0, hi = m; while (lo < hi) { const mid = (lo + hi) >>> 1; if (ids[mid] < x) lo = mid + 1; else hi = mid; } return lo; };
let j = 0, last = -Infinity, unsorted = 0, nNodes = 0;
nBlocks = 0;
for (const b of nodeBlocks) {
  parseData(pbf.read(b)).eachNode((id, la, lo) => {
    nNodes++;
    if (id < last) { j = lowerBound(id); unsorted++; } // files are normally sorted by id
    last = id;
    while (j < m && ids[j] < id) j++;
    if (j < m && ids[j] === id) { lat[j] = la; lon[j] = lo; found[j] = 1; }
  });
  if (++nBlocks % 2000 === 0) log(`pass 2: ${nBlocks}/${nodeBlocks.length} blocks`);
}
pbf.close();
let nFound = 0;
for (let i = 0; i < m; i++) nFound += found[i];
log(`pass 2 done: ${nNodes} nodes read (${unsorted} out of order), ${nFound}/${m} needed nodes found`);

// ---- geometry, tiles ----
// Default names from the developer-maintained trail info file, so those trails are
// linked across tiles by name too.
let infoNames = new Map();
try {
  const info = JSON.parse(await readFile(join(root, 'data', 'trail-info.json'), 'utf8')).trails || {};
  infoNames = new Map(Object.entries(info).filter(([, v]) => v.name).map(([id, v]) => [Number(id), v.name]));
} catch { /* no trail info yet */ }

const T = Math.round(TILE_SIZE * 1e5); // tile size in 1e-5°
const b5 = (v) => Math.round(v * 1e5);
const rows = [Math.floor(b5(REGION.bounds.south) / T), Math.floor(b5(REGION.bounds.north) / T)];
const cols = [Math.floor(b5(REGION.bounds.west) / T), Math.floor(b5(REGION.bounds.east) / T)];
const tiles = new Map(); // tile key -> way indices
const nameTiles = new Map(); // name -> Set of tile keys
const kinds = {};
let partial = 0, dropped = 0, outside = 0;
for (let wi = 0; wi < ways.length; wi++) {
  const w = ways[wi];
  // Longest run of nodes the file has (ways leaving the extract are cut at its edge).
  let best = [], run = [];
  for (let k = w.start; k < w.start + w.n; k++) {
    const i = lowerBound(refs[k]);
    if (i < m && ids[i] === refs[k] && found[i]) run.push(i);
    else { if (run.length > best.length) best = run; run = []; }
  }
  if (run.length > best.length) best = run;
  if (best.length < w.n) partial++;
  const xy = [];
  for (const i of best) {
    const x = Math.round(lon[i] / 100), y = Math.round(lat[i] / 100);
    if (xy.length && xy[xy.length - 2] === x && xy[xy.length - 1] === y) continue;
    xy.push(x, y);
  }
  if (xy.length < 4) { dropped++; continue; }
  // Tiles the way passes through (each step's bounding box).
  const keys = new Set();
  for (let p = 0; p < xy.length; p += 2) {
    const q = p ? p - 2 : p;
    const r0 = Math.floor(Math.min(xy[p + 1], xy[q + 1]) / T), r1 = Math.floor(Math.max(xy[p + 1], xy[q + 1]) / T);
    const c0 = Math.floor(Math.min(xy[p], xy[q]) / T), c1 = Math.floor(Math.max(xy[p], xy[q]) / T);
    for (let r = Math.max(r0, rows[0]); r <= Math.min(r1, rows[1]); r++) {
      for (let c = Math.max(c0, cols[0]); c <= Math.min(c1, cols[1]); c++) keys.add(tileKey(r, c));
    }
  }
  if (!keys.size) { outside++; continue; }
  const flat = xy.map((v, p) => (p < 2 ? v : v - xy[p - 2]));
  const name = w.name || routeName.get(w.id) || null;
  const entry = [w.id, name, w.kind, flat];
  if (w.priv) entry.push('p');
  w.json = JSON.stringify(entry);
  w.label = name;
  const k = w.kind + (w.priv ? ' (no public access)' : '');
  kinds[k] = (kinds[k] || 0) + 1;
  for (const key of keys) {
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(wi);
    for (const n of new Set([name, infoNames.get(w.id)])) {
      if (!n) continue;
      if (!nameTiles.has(n)) nameTiles.set(n, new Set());
      nameTiles.get(n).add(key);
    }
  }
}
log(`ways written: ${ways.length - dropped - outside} (${partial} cut at the extract edge, ${dropped} too short, ${outside} outside California)`, JSON.stringify(kinds));

// ---- write ----
await rm(join(OUT, 'tiles'), { recursive: true, force: true });
await rm(join(OUT, 'names.json'), { force: true });
await mkdir(join(OUT, 'tiles'), { recursive: true });
const rc = (key) => key.split('_').map(Number);
let bytes = 0, biggest = [];
const keys = [...tiles.keys()].sort();
for (const key of keys) {
  const list = tiles.get(key);
  const [r, c] = rc(key);
  // For each trail here: the other tiles within reach it continues into, so the app can
  // load the rest of the trail around wherever it's tapped.
  const names = {};
  for (const n of new Set(list.flatMap((wi) => [ways[wi].label, infoNames.get(ways[wi].id)]))) {
    if (!n) continue;
    const near = [...nameTiles.get(n)].filter((k) => {
      if (k === key) return false;
      const [r2, c2] = rc(k);
      return Math.abs(r2 - r) <= TRAIL_REACH && Math.abs(c2 - c) <= TRAIL_REACH;
    });
    if (near.length) names[n] = near.sort();
  }
  const text = `{"v":2,"ways":[${list.map((wi) => ways[wi].json).join(',')}],"names":${JSON.stringify(names)}}`;
  await writeFile(join(OUT, 'tiles', `${key}.json`), text);
  bytes += text.length;
  biggest.push([text.length, key]);
}
biggest = biggest.sort((a, b) => b[0] - a[0]).slice(0, 5);

// Index: column ranges per row.
const index = {};
for (const [r, c] of keys.map(rc).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
  const ranges = (index[r] ||= []);
  const lastRange = ranges[ranges.length - 1];
  if (lastRange && lastRange[1] === c - 1) lastRange[1] = c;
  else ranges.push([c, c]);
}
const region = { name: 'california', source: basename(file), builtAt: new Date().toISOString(), osmData: header.timestamp };
await writeFile(join(OUT, 'index.json'), JSON.stringify({ v: 2, tileSize: TILE_SIZE, regions: [region], rows: index }));
log(`done: ${keys.length} tiles, ${(bytes / 1e6).toFixed(1)} MB; largest ${biggest.map(([n, k]) => `${k} ${(n / 1e6).toFixed(2)} MB`).join(', ')}`);
