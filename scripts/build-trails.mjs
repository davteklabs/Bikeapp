// Download everything walkable or rideable that isn't a paved road (paths, tracks,
// footways, bridleways, cycleways, steps, and unpaved service/minor roads) for a region
// from Overpass, in one request, and write it as small tiles the app loads by map view:
//
//   node scripts/build-trails.mjs <name> <south> <west> <north> <east>
//   node scripts/build-trails.mjs folsom-lake 38.64 -121.26 38.90 -121.02
//
// Raw Overpass responses are kept in logs/overpass-raw/<name>/ (not committed), so a
// rebuild doesn't download again. Public Overpass servers are often busy, so requests
// retry with backoff.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_SIZE, tileKey, tilesInBounds } from '../js/segments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'data', 'trails');
// Public Overpass servers, tried in turn when one is busy.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const UA = 'TrailNav-trail-builder/0.1 (+https://github.com/davteklabs/Bikeapp)';
// Segment kinds in the tiles; minor roads only appear when unpaved.
const HIGHWAY = { path: 'p', track: 't', footway: 'f', bridleway: 'b', cycleway: 'c', steps: 's' };
const UNPAVED = 'unpaved|gravel|fine_gravel|dirt|earth|ground|compacted|grass|sand|mud|rock|pebblestone|woodchips';
const NO_ACCESS = /^(private|no)$/;

const [name, ...nums] = process.argv.slice(2);
const [south, west, north, east] = nums.map(Number);
if (!name || [south, west, north, east].some((n) => !Number.isFinite(n))) {
  console.error('usage: node scripts/build-trails.mjs <name> <south> <west> <north> <east>');
  process.exit(1);
}
const rawDir = join(root, 'logs', 'overpass-raw', name);
await mkdir(rawDir, { recursive: true });
await mkdir(join(OUT, 'tiles'), { recursive: true });

// Query the whole tile grid covering the region (it reaches a little past the region's
// edges), so every tile written is complete.
const grid = tilesInBounds({ south, west, north, east });
const gs = Math.min(...grid.map((t) => t.south)), gw = Math.min(...grid.map((t) => t.west));
const gn = Math.max(...grid.map((t) => t.north)), ge = Math.max(...grid.map((t) => t.east));
const bbox = `${gs},${gw},${gn},${ge}`;
// Sidewalks and crossings are part of paved streets, so they're left out.
const wayQuery = (b) => `[out:json][timeout:300][maxsize:1073741824];(
  way["highway"~"^(path|track|footway|bridleway|cycleway|steps)$"]["footway"!~"^(sidewalk|crossing)$"](${b});
  way["highway"~"^(service|unclassified|residential|road)$"]["surface"~"^(${UNPAVED})$"](${b});
  way["highway"="service"]["tracktype"](${b});
);out tags geom;`;
// The busy public servers time out on one big area, so ask in chunks of 2x2 tiles.
const CHUNK = 2;
const chunks = new Map();
for (const t of grid) {
  const k = `${Math.floor(t.row / CHUNK)}_${Math.floor(t.col / CHUNK)}`;
  const c = chunks.get(k) || { south: t.south, west: t.west, north: t.north, east: t.east };
  chunks.set(k, { south: Math.min(c.south, t.south), west: Math.min(c.west, t.west), north: Math.max(c.north, t.north), east: Math.max(c.east, t.east) });
}
// Signed hiking/cycling routes: their names fill in for member ways that have none.
const routeQuery = `[out:json][timeout:180];relation["type"="route"]["route"~"^(hiking|foot|walking|bicycle|mtb)$"](${bbox});out body;`;

async function fetchCached(key, data) {
  const rawFile = join(rawDir, `${key}.json`);
  try { return JSON.parse(await readFile(rawFile, 'utf8')); } catch { /* not downloaded yet */ }
  for (let attempt = 0, wait = 10; attempt < 8; attempt++, wait *= 2) {
    const t0 = Date.now();
    let status = 0, text = '';
    try {
      const res = await fetch(OVERPASS[attempt % OVERPASS.length], { method: 'POST', headers: { 'User-Agent': UA }, body: new URLSearchParams({ data }), signal: AbortSignal.timeout(330000) });
      status = res.status; text = await res.text();
    } catch (err) { text = String(err); }
    console.log(`${new Date().toISOString()} ${key} attempt ${attempt + 1} (${new URL(OVERPASS[attempt % OVERPASS.length]).host}): HTTP ${status}, ${text.length} bytes, ${Date.now() - t0} ms`);
    if (status === 200 && !text.includes('"remark": "runtime error')) {
      await writeFile(rawFile, text);
      return JSON.parse(text);
    }
    await writeFile(join(rawDir, `${key}.error-${attempt + 1}.txt`), `HTTP ${status}\n${text}`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  throw new Error(`${key}: gave up after retries`);
}

const routeName = new Map(); // way id -> name of a signed route it belongs to
for (const r of (await fetchCached('routes', routeQuery)).elements) {
  const rname = r.tags?.name || r.tags?.ref;
  if (!rname) continue;
  for (const m of r.members || []) if (m.type === 'way' && !routeName.has(m.ref)) routeName.set(m.ref, rname);
}
console.log(`signed routes: ${routeName.size} member ways have a route name`);

// Default names from the developer-maintained trail info file, so those trails can be
// found by name too.
let infoNames = new Map();
try {
  const info = JSON.parse(await readFile(join(root, 'data', 'trail-info.json'), 'utf8')).trails || {};
  infoNames = new Map(Object.entries(info).filter(([, v]) => v.name).map(([id, v]) => [Number(id), v.name]));
} catch { /* no trail info yet */ }

const byId = new Map();
let osmBase = null;
for (const c of chunks.values()) {
  const b = `${c.south},${c.west},${c.north},${c.east}`;
  const part = await fetchCached(`ways-v2_${b}`, wayQuery(b));
  osmBase = part.osm3s?.timestamp_osm_base || osmBase;
  for (const e of part.elements) byId.set(e.id, e);
}
console.log(`${chunks.size} chunks, ${byId.size} unique ways`);
const json = { elements: [...byId.values()] };
const round = (n) => Math.round(n * 1e5) / 1e5; // ~1 m

// [id, name, kind, coords, access]; access 'p' = no public access (private or no).
const ways = json.elements.filter((e) => e.type === 'way' && e.geometry?.length > 1).map((e) => {
  const t = e.tags || {};
  const restricted = NO_ACCESS.test(t.access || '') || (NO_ACCESS.test(t.foot || '') && NO_ACCESS.test(t.bicycle || ''));
  const way = [e.id, t.name || routeName.get(e.id) || null, HIGHWAY[t.highway] || 'r',
    e.geometry.filter(Boolean).map((g) => [round(g.lon), round(g.lat)])];
  if (restricted) way.push('p');
  return way;
});
const kinds = {};
for (const w of ways) kinds[w[2] + (w[4] ? ' (no public access)' : '')] = (kinds[w[2] + (w[4] ? ' (no public access)' : '')] || 0) + 1;
console.log(`ways: ${ways.length}`, JSON.stringify(kinds));

// Split into tiles: a way goes into every tile its bounding box touches.
const tiles = tilesInBounds({ south, west, north, east });
const perTile = new Map(tiles.map((t) => [tileKey(t.row, t.col), []]));
for (const w of ways) {
  const lats = w[3].map((c) => c[1]), lngs = w[3].map((c) => c[0]);
  for (const t of tilesInBounds({ south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) })) {
    perTile.get(tileKey(t.row, t.col))?.push(w);
  }
}

let indexTiles = [];
try { indexTiles = JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8')).tiles; } catch { /* first build */ }
const regions = [];
try { regions.push(...JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8')).regions.filter((r) => r.name !== name)); } catch { /* first build */ }

// Trail name -> tiles it appears in, so the app can load and highlight a whole trail.
let names = {};
try { names = JSON.parse(await readFile(join(OUT, 'names.json'), 'utf8')); } catch { /* first build */ }
// This region's tiles are rebuilt below; drop their old entries so renamed trails don't linger.
for (const n of Object.keys(names)) {
  names[n] = names[n].filter((k) => !perTile.has(k));
  if (!names[n].length) delete names[n];
}

let written = 0;
for (const [key, list] of perTile) {
  if (!list.length) continue;
  await writeFile(join(OUT, 'tiles', `${key}.json`), JSON.stringify({ v: 1, ways: list }));
  written++;
  if (!indexTiles.includes(key)) indexTiles.push(key);
  for (const [id, wayName] of list) {
    for (const n of new Set([wayName, infoNames.get(id)])) {
      if (!n) continue;
      const keys = (names[n] ||= []);
      if (!keys.includes(key)) keys.push(key);
    }
  }
}

regions.push({ name, bounds: { south, west, north, east }, builtAt: new Date().toISOString(), osmData: osmBase });
await writeFile(join(OUT, 'index.json'), JSON.stringify({ v: 1, tileSize: TILE_SIZE, regions, tiles: indexTiles.sort() }, null, 1));
const sortedNames = Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)).map(([n, keys]) => [n, keys.sort()]));
await writeFile(join(OUT, 'names.json'), JSON.stringify(sortedNames, null, 1));
console.log(`done: ${written} tiles written, ${ways.length} ways, OSM data as of ${osmBase}`);
