// End-to-end smoke test in headless Chromium. All external map services are
// mocked, and GPS is simulated, so this runs offline:  npm run test:e2e
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from '../../scripts/serve.mjs';
import { tilesInBounds, tileKey } from '../../js/segments.js';
import { osrmResponse, overpassResponse, segmentTile, START, CORNER, END } from '../fixtures.mjs';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try { return require('playwright'); } catch {
    return require(`${execSync('npm root -g').toString().trim()}/playwright`);
  }
}
const { chromium } = loadPlaywright();
const shots = process.env.SHOTS_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const snap = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

const server = createServer().listen(0);
const port = server.address().port;
// The map is WebGL; headless runners have no GPU, so opt in to software rendering.
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  permissions: ['geolocation'], geolocation: { latitude: START.lat, longitude: START.lng, accuracy: 5 },
  serviceWorkers: 'block',
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const calls = { route: 0, search: 0, overpass: 0 };
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, async (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*' } });
  if (/\.png$/.test(url)) return route.fulfill({ contentType: 'image/png', body: PNG, headers: { 'Access-Control-Allow-Origin': '*' } });
  if (url.includes('routing.openstreetmap.de')) { calls.route++; return json(osrmResponse()); }
  if (url.includes('nominatim') && url.includes('/search')) {
    calls.search++;
    return json([{ name: 'Ridge Summit', display_name: 'Ridge Summit, Testland', type: 'peak', lat: String(END.lat), lon: String(END.lng) }]);
  }
  if (url.includes('nominatim') && url.includes('/reverse')) return json({ name: 'Somewhere' });
  if (url.includes('overpass')) { calls.overpass++; return json(overpassResponse()); }
  return route.abort();
});
// Shipped trail data and default ratings: one blue-rated segment, the rest unrated.
const segmentKeys = tilesInBounds({ south: 38.7, west: -121.25, north: 38.8, east: -121.1 }).map((t) => tileKey(t.row, t.col));
await context.route(/\/data\/(trails\/|trail-ratings\.json)/, (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.endsWith('/trail-ratings.json')) return json({ ratings: { 1001: 'blue' } });
  if (url.endsWith('/index.json')) return json({ v: 1, tiles: segmentKeys, regions: [] });
  if (url.endsWith('/names.json')) return json({ 'Ridge Trail': segmentKeys });
  return json(segmentTile());
});

const page = await context.newPage();
await page.addInitScript(() => {
  // The checks below are written in metric; imperial is covered at the end.
  localStorage.setItem('trailnav:settings', JSON.stringify({ units: 'metric', unitsChosen: true }));
  window.__spoken = [];
  const s = window.speechSynthesis;
  if (s) { s.speak = (u) => window.__spoken.push(u.text); s.cancel = () => {}; }
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const setGPS = async (p, speed = 5) => {
  await context.setGeolocation({ latitude: p.lat, longitude: p.lng, accuracy: 5 });
  await page.waitForTimeout(250);
};
const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

try {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('.me-marker', { timeout: 10000 });
  ok('map loads and shows GPS position');
  await snap(page, '1-map');

  const segProps = () => page.evaluate(() => Object.fromEntries(
    window.trailnav.map.querySourceFeatures('segments').map((f) => [f.properties.id, f.properties])));
  await page.waitForFunction(() => window.trailnav.map.querySourceFeatures('segments').length >= 3, null, { timeout: 10000 });
  let segs = await segProps();
  assert.equal(segs['1001'].color, '#1565c0', 'default rating shows blue');
  assert.equal(segs['1002'].color, '#6b7076', 'unrated shows grey');
  assert.equal(segs['1003'].color, '#6b7076', 'unrated shows grey');
  ok('trail segments load, coloured only where rated (default blue, others grey)');

  // Tap the second half of Ridge Trail.
  const tap = await page.evaluate((p) => window.trailnav.map.project([p.lng, p.lat]), { lng: CORNER.lng, lat: (CORNER.lat + 3 * END.lat) / 4 });
  await page.mouse.click(tap.x, tap.y);
  await page.waitForSelector('#sheet .rate-buttons');
  assert.equal(await page.textContent('#sheet h2'), 'Ridge Trail');
  await page.waitForFunction(() => /in 2 segments/.test(document.querySelector('#sheet .trail-len')?.textContent || ''));
  await page.waitForTimeout(800);
  segs = await segProps();
  assert.equal(segs['1002'].hl, 2, 'tapped segment highlighted');
  assert.equal(segs['1001'].hl, 1, 'rest of the trail highlighted');
  assert.ok(!segs['1003']?.hl, 'other trails not highlighted');
  ok('tapping a trail highlights the whole trail');
  await snap(page, '1b-trail');

  await page.click('#sheet .rate[data-r="black"]');
  await page.waitForFunction(() => window.trailnav.map.querySourceFeatures('segments').some((f) => f.properties.id === '1002' && f.properties.color === '#111111'));
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('trailnav:ratings'))))['1002'].rating, 'black');
  assert.match(await page.textContent('#sheet .rating-now'), /Black · Difficult · your rating/);
  ok('rating a segment recolours it and saves it on this device');
  await page.click('#sheet-close');

  await page.fill('#search', 'Ridge');
  await page.waitForSelector('#search-results li .name');
  assert.equal(await page.textContent('#search-results li .name'), 'Ridge Summit');
  ok('search returns places');

  await page.click('#search-results li');
  await page.waitForSelector('#sheet [data-act="to"]');
  await page.click('#sheet [data-act="to"]');
  await page.waitForSelector('#btn-start');
  const summary = await page.textContent('#sheet .summary');
  assert.match(summary, /3 min/); assert.match(summary, /800 m/);
  await page.click('#btn-steps');
  const steps = await page.$$eval('#sheet .steps .t', (n) => n.map((x) => x.textContent));
  assert.deepEqual(steps, ['Head east on River Path', 'Turn left onto Ridge Trail', 'Arrive at your destination']);
  ok('bike route planned with turn-by-turn steps');
  await snap(page, '2-route');

  await page.click('#btn-start');
  await page.waitForSelector('#nav-banner:not([hidden])');
  assert.equal(await page.textContent('#nav-text'), 'Turn left onto Ridge Trail');
  assert.equal(await page.textContent('#nav-dist'), '500 m');
  ok('navigation starts, banner shows next turn');
  // The route heads east, so the tilted map should face east (bearing 90).
  await page.waitForFunction(() => window.trailnav.map.getPitch() > 50 && Math.abs(window.trailnav.map.getBearing() - 90) < 5, null, { timeout: 5000 });
  ok('navigation view tilts and faces the direction of travel');

  for (const t of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) await setGPS(lerp(START, CORNER, t));
  const dist = await page.textContent('#nav-dist');
  assert.ok(/^\d+ m$/.test(dist) && parseInt(dist) < 100, dist);
  const spoken = await page.evaluate(() => window.__spoken);
  assert.ok(spoken.some((s) => /^In \d+ metres, turn left onto Ridge Trail$/.test(s)), spoken.join(' | '));
  ok(`live updates while riding (${dist} to turn, voice: "${spoken.at(-1)}")`);
  await snap(page, '3-navigating');

  const before = calls.route;
  const off = { lat: CORNER.lat - 0.0015, lng: CORNER.lng - 0.002 };
  for (let i = 0; i < 4; i++) await setGPS({ lat: off.lat - i * 0.0001, lng: off.lng });
  await page.waitForFunction((n) => window.__spoken.includes('Rerouting'), before);
  assert.ok(calls.route > before);
  ok('going off-route triggers automatic reroute');

  for (let t = 0; t <= 1.0001; t += 0.25) await setGPS(lerp(START, CORNER, Math.max(t, 0.9)));
  for (let t = 0.2; t <= 1.0001; t += 0.2) await setGPS(lerp(CORNER, END, t));
  await page.waitForSelector('#sheet #gpx');
  assert.match(await page.textContent('#sheet h2'), /arrived/);
  ok('arrival detected, ride summary with GPX export');
  await page.waitForFunction(() => window.trailnav.map.getPitch() < 1 && Math.abs(window.trailnav.map.getBearing()) < 1, null, { timeout: 5000 });
  ok('map returns to flat, north-up view after arriving');
  await snap(page, '4-arrived');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#sheet #gpx')]);
  assert.match(dl.suggestedFilename(), /\.gpx$/);
  ok('GPX download works');
  await page.click('#sheet #discard');

  await page.click('.mode-toggle [data-mode="hike"]');
  assert.equal(await page.getAttribute('body', 'data-mode'), 'hike');
  await page.evaluate(() => window.trailnav.map.setZoom(12));
  await page.click('#btn-trails');
  await page.waitForSelector('.trail-list li');
  assert.match(await page.textContent('.trail-list li'), /Panorama Loop/);
  assert.match(await page.textContent('.trail-list li'), /Hiking · P1 · 7\.5 km/);
  ok('hike mode finds nearby trails');
  await page.click('.trail-list li');
  await page.waitForSelector('#go-trail');
  await page.waitForTimeout(1000);
  assert.ok(await page.evaluate(() => window.trailnav.map.getZoom()) >= 14, 'map zooms to selected trail');
  await snap(page, '5-trails');
  await page.click('#go-trail');
  await page.waitForSelector('#btn-start');
  assert.ok((await page.textContent('#sheet h2')).includes('Panorama Loop'));
  ok('directions to a trail');

  await page.click('#btn-layers');
  await page.waitForSelector('#sheet .settings');
  await snap(page, '6-layers');
  ok('layers & settings panel');

  const [exp] = await Promise.all([page.waitForEvent('download'), page.click('#export-ratings')]);
  const exported = JSON.parse(readFileSync(await exp.path(), 'utf8'));
  assert.deepEqual(exported.ratings, { 1001: { rating: 'blue' }, 1002: { rating: 'black', name: 'Ridge Trail' } });
  ok('ratings export in the same format as the shipped defaults file');

  await page.selectOption('#units', 'imperial');
  await page.click('#btn-trails');
  await page.waitForSelector('.trail-list li');
  assert.match(await page.textContent('.trail-list li'), /Hiking · P1 · 4\.7 mi/);
  ok('switching units to imperial');

  assert.deepEqual(errors, [], 'no console errors');
  console.log(`\nAll ${step} e2e checks passed.`);
} catch (err) {
  await snap(page, 'failure');
  console.error('E2E FAILED:', err.message, '\nconsole errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
