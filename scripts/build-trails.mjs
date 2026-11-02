// Download trail segments (OSM paths, tracks, footways, bridleways, cycleways) for a
// region from Overpass and write them as small tiles the app loads by map view:
//
//   node scripts/build-trails.mjs <name> <south> <west> <north> <east>
//   node scripts/build-trails.mjs folsom-lake 38.64 -121.26 38.90 -121.02
//
// Raw Overpass responses are kept in logs/overpass-raw/<name>/ (not committed).
// Public Overpass servers are often busy, so each tile retries with backoff.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TILE_SIZE, tileKey, tilesInBounds } from '../js/segments.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'data', 'trails');
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'TrailNav-trail-builder/0.1 (+https://github.com/davteklabs/Bikeapp)';
const HIGHWAY = { path: 'p', track: 't', footway: 'f', bridleway: 'b', cycleway: 'c' };

const [name, ...nums] = process.argv.slice(2);
const [south, west, north, east] = nums.map(Number);
if (!name || [south, west, north, east].some((n) => !Number.isFinite(n))) {
  console.error('usage: node scripts/build-trails.mjs <name> <south> <west> <north> <east>');
  process.exit(1);
}
const rawDir = join(root, 'logs', 'overpass-raw', name);
await mkdir(rawDir, { recursive: true });
await mkdir(join(OUT, 'tiles'), { recursive: true });

const query = (s, w, n, e) =>
  `[out:json][timeout:120];way["highway"~"^(path|track|footway|bridleway|cycleway)$"]` +
  `["footway"!~"^(sidewalk|crossing)$"]["access"!~"^(private|no)$"](${s},${w},${n},${e});out tags geom;`;

// Signed hiking/cycling routes: their names fill in for member ways that have none.
const routeQuery = (s, w, n, e) =>
  `[out:json][timeout:180];relation["type"="route"]["route"~"^(hiking|foot|walking|bicycle|mtb)$"](${s},${w},${n},${e});out body;`;

async function fetchCached(key, data) {
  const rawFile = join(rawDir, `${key}.json`);
  try { return JSON.parse(await readFile(rawFile, 'utf8')); } catch { /* not downloaded yet */ }
  for (let attempt = 0, wait = 10; attempt < 8; attempt++, wait *= 2) {
    const t0 = Date.now();
    let status = 0, text = '';
    try {
      const res = await fetch(OVERPASS, { method: 'POST', headers: { 'User-Agent': UA }, body: new URLSearchParams({ data }) });
      status = res.status; text = await res.text();
    } catch (err) { text = String(err); }
    console.log(`${new Date().toISOString()} ${key} attempt ${attempt + 1}: HTTP ${status}, ${text.length} bytes, ${Date.now() - t0} ms`);
    if (status === 200) {
      await writeFile(rawFile, text);
      return JSON.parse(text);
    }
    await writeFile(join(rawDir, `${key}.error-${attempt + 1}.txt`), `HTTP ${status}\n${text}`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  throw new Error(`${key}: gave up after retries`);
}
const fetchTile = (key, b) => fetchCached(key, query(b.south, b.west, b.north, b.east));

const routeName = new Map(); // way id -> name of a signed route it belongs to
for (const r of (await fetchCached('routes', routeQuery(south, west, north, east))).elements) {
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

const round = (n) => Math.round(n * 1e5) / 1e5; // ~1 m
const tiles = tilesInBounds({ south, west, north, east });
let indexTiles = [];
try { indexTiles = JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8')).tiles; } catch { /* first build */ }
const regions = [];
try { regions.push(...JSON.parse(await readFile(join(OUT, 'index.json'), 'utf8')).regions.filter((r) => r.name !== name)); } catch { /* first build */ }

// Trail name -> tiles it appears in, so the app can load and highlight a whole trail.
let names = {};
try { names = JSON.parse(await readFile(join(OUT, 'names.json'), 'utf8')); } catch { /* first build */ }
// This region's tiles are rebuilt below; drop their old entries so renamed trails don't linger.
const rebuilt = new Set(tiles.map((t) => tileKey(t.row, t.col)));
for (const n of Object.keys(names)) {
  names[n] = names[n].filter((k) => !rebuilt.has(k));
  if (!names[n].length) delete names[n];
}

let osmBase = null, total = 0;
for (const t of tiles) {
  const key = tileKey(t.row, t.col);
  const json = await fetchTile(key, t);
  osmBase = json.osm3s?.timestamp_osm_base || osmBase;
  const ways = json.elements
    .filter((e) => e.type === 'way' && e.geometry?.length > 1)
    .map((e) => [e.id, e.tags?.name || routeName.get(e.id) || null, HIGHWAY[e.tags?.highway] || 'p', e.geometry.filter(Boolean).map((g) => [round(g.lon), round(g.lat)])]);
  total += ways.length;
  if (!ways.length) continue;
  await writeFile(join(OUT, 'tiles', `${key}.json`), JSON.stringify({ v: 1, ways }));
  if (!indexTiles.includes(key)) indexTiles.push(key);
  for (const [id, wayName] of ways) {
    for (const n of new Set([wayName, infoNames.get(id)])) {
      if (!n) continue;
      const list = (names[n] ||= []);
      if (!list.includes(key)) list.push(key);
    }
  }
}

regions.push({ name, bounds: { south, west, north, east }, builtAt: new Date().toISOString(), osmData: osmBase });
await writeFile(join(OUT, 'index.json'), JSON.stringify({ v: 1, tileSize: TILE_SIZE, regions, tiles: indexTiles.sort() }, null, 1));
const sortedNames = Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b)).map(([n, keys]) => [n, keys.sort()]));
await writeFile(join(OUT, 'names.json'), JSON.stringify(sortedNames, null, 1));
console.log(`done: ${tiles.length} tiles, ${total} way entries (ways crossing tiles count once per tile), OSM data as of ${osmBase}`);
