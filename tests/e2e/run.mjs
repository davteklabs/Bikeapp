// End-to-end smoke test in headless Chromium. All external map services are
// mocked, and GPS is simulated, so this runs offline:  npm run test:e2e
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from '../../scripts/serve.mjs';
import { tilesInBounds, tileKey } from '../../js/segments.js';
import { osrmResponse, overpassResponse, segmentTile, straightRoute, START, CORNER, END } from '../fixtures.mjs';

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
  // Water layer: a tile index and empty vector tiles.
  if (url.includes('tiles.openfreemap.org')) {
    if (url.endsWith('.pbf')) return route.fulfill({ contentType: 'application/x-protobuf', body: Buffer.alloc(0), headers: { 'Access-Control-Allow-Origin': '*' } });
    return json({ tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/test/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14,
      vector_layers: [{ id: 'water', fields: {} }, { id: 'waterway', fields: {} }, { id: 'transportation', fields: {} }] });
  }
  if (url.includes('routing.openstreetmap.de')) {
    calls.route++;
    // Directions to END get the fixture route; anything else (links in a trail plan) a straight line.
    const pts = url.match(/driving\/([^?]+)/)[1].split(';').map((p) => p.split(',').map(Number));
    const [lng, lat] = pts.at(-1);
    if (Math.abs(lat - END.lat) < 1e-4 && Math.abs(lng - END.lng) < 1e-4) return json(osrmResponse());
    return json(straightRoute(pts[0], pts.at(-1)));
  }
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
await context.route(/\/data\/(trails\/|trail-info\.json)/, (route) => {
  const url = route.request().url();
  const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.endsWith('/trail-info.json')) return json({ trails: { 1001: { rating: 'blue' } } });
  if (url.endsWith('/index.json')) return json({ v: 1, tiles: segmentKeys, regions: [] });
  return json(segmentTile());
});

const page = await context.newPage();
// CPU_THROTTLE=4 runs the page 4x slower, to reproduce slow CI machines locally.
if (process.env.CPU_THROTTLE) {
  await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
}
await page.addInitScript(() => {
  // The checks below are written in metric; imperial is covered at the end.
  localStorage.setItem('trailnav:settings', JSON.stringify({ units: 'metric', unitsChosen: true }));
  window.__spoken = [];
  const s = window.speechSynthesis;
  if (s) { s.speak = (u) => window.__spoken.push(u.text); s.cancel = () => {}; }
});
// Wait until the map has finished moving and drawing (fixed pauses are too short on slow machines).
const idle = () => page.evaluate(() => new Promise((resolve) => {
  const m = window.trailnav.map;
  if (!m.isMoving() && m.loaded() && m.areTilesLoaded()) resolve(); else m.once('idle', () => resolve());
}));
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
  const water = await page.evaluate(() => {
    const m = window.trailnav.map;
    return [m.getPaintProperty('water', 'fill-pattern'), m.getPaintProperty('waterway', 'line-color'), m.getPaintProperty('waterway-seasonal', 'line-color')];
  });
  assert.deepEqual(water, ['water-waves', '#1499d6', '#1499d6']);
  ok('water layers: lakes with a wave texture, rivers/canals in blue');
  await snap(page, '1-map');

  const segProps = () => page.evaluate(() => Object.fromEntries(
    window.trailnav.map.querySourceFeatures('segments').map((f) => [f.properties.id, f.properties])));
  await page.waitForFunction(() => window.trailnav.map.querySourceFeatures('segments').length >= 3, null, { timeout: 10000 });
  let segs = await segProps();
  assert.equal(segs['1001'].color, '#1565c0', 'default rating shows blue');
  assert.equal(segs['1002'].color, '#6b7076', 'unrated shows grey');
  assert.equal(segs['1003'].color, '#6b7076', 'unrated shows grey');
  assert.equal(segs['1004'].private, true, 'no-public-access road is flagged (drawn dashed)');
  assert.equal(segs['1003'].private, false);
  ok('trail segments load, coloured only where rated (default blue, others grey); private ones flagged');

  // Tap the second half of Ridge Trail.
  const tap = await page.evaluate((p) => window.trailnav.map.project([p.lng, p.lat]), { lng: CORNER.lng, lat: (CORNER.lat + 3 * END.lat) / 4 });
  await page.mouse.click(tap.x, tap.y);
  await page.waitForSelector('#sheet #seg-go');
  assert.equal(await page.textContent('#sheet h2'), 'Ridge Trail');
  assert.ok(await page.isHidden('#sheet .edit-panel'), 'editing is tucked behind the gear button');
  await page.waitForFunction(() => /in 2 segments/.test(document.querySelector('#sheet .trail-len')?.textContent || ''));
  await page.waitForTimeout(800);
  segs = await segProps();
  assert.equal(segs['1002'].hl, 2, 'tapped segment highlighted');
  assert.equal(segs['1001'].hl, 1, 'rest of the trail highlighted');
  assert.ok(!segs['1003']?.hl, 'other trails not highlighted');
  ok('tapping a trail highlights the whole trail');
  await snap(page, '1b-trail');

  await page.click('#sheet #seg-edit');
  await page.click('#sheet .rate[data-r="black"]');
  await page.waitForFunction(() => window.trailnav.map.querySourceFeatures('segments').some((f) => f.properties.id === '1002' && f.properties.color === '#111111'));
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('trailnav:ratings'))))['1002'].rating, 'black');
  assert.match(await page.textContent('#sheet .rating-now'), /Black · Difficult · your rating/);
  ok('rating a segment recolours it and saves it on this device');
  await page.click('#sheet-close');

  // Name the unnamed track, then get directions to it.
  const quarry = { lng: START.lng + 0.0015, lat: START.lat - 0.002 };
  await page.evaluate((p) => void window.trailnav.map.jumpTo({ center: [p.lng, p.lat], zoom: 15 }), quarry);
  await idle();
  await page.waitForTimeout(800);
  const tap2 = await page.evaluate((p) => window.trailnav.map.project([p.lng, p.lat]), quarry);
  await page.mouse.click(tap2.x, tap2.y);
  await page.waitForSelector('#sheet #seg-go');
  assert.equal(await page.textContent('#sheet h2'), 'Unnamed track');
  await page.click('#sheet #seg-edit');
  await page.click('#sheet #rename');
  await page.fill('#sheet #name-input', 'Quarry Spur');
  await page.click('#sheet .rename button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#sheet h2')?.textContent === 'Quarry Spur');
  await page.waitForTimeout(300);
  assert.equal((await segProps())['1003'].name, 'Quarry Spur');
  assert.match(await page.textContent('#sheet .name-src'), /Name set by you/);
  ok('renaming a trail updates the map and saves it on this device');
  await page.click('#sheet #seg-go');
  await page.waitForSelector('#sheet .plan-list li');
  assert.equal(await page.getAttribute('#view-toggle [data-view="plan"]', 'aria-checked'), 'true');
  assert.match(await page.textContent('#sheet .plan-list'), /Quarry Spur/);
  ok('"Navigate this trail" opens Plan route with that trail');
  await page.click('#view-toggle [data-view="explore"]');
  assert.ok(await page.isHidden('#sheet'));
  assert.ok(await page.isVisible('#plan-bar'), 'the route bar brings you back to the plan');
  page.once('dialog', (d) => d.accept());
  await page.click('#plan-clear');

  // Route plan: press and hold trails to add them, hold again to remove.
  const planIds = () => page.evaluate(() => window.trailnav.state.plan.map((s) => s.id));
  const holdOn = async (p) => {
    const pt = await page.evaluate((q) => window.trailnav.map.project([q.lng, q.lat]), p);
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForTimeout(300);
  };
  const ridgeA = { lng: CORNER.lng, lat: (3 * CORNER.lat + END.lat) / 4 }; // segment 1001
  const ridgeB = { lng: CORNER.lng, lat: (CORNER.lat + 3 * END.lat) / 4 }; // segment 1002
  await page.evaluate((p) => void window.trailnav.map.jumpTo({ center: [p.lng, p.lat], zoom: 15 }), ridgeA);
  await idle();
  await page.waitForTimeout(800);
  await holdOn(ridgeA);
  assert.deepEqual(await planIds(), ['1001']);
  assert.ok(await page.isHidden('#sheet'), 'press-and-hold does not also open the trail panel');
  assert.match(await page.textContent('#plan-text'), /1 segment · 150 m/);
  await holdOn(ridgeB);
  assert.deepEqual(await planIds(), ['1001', '1002']);
  assert.match(await page.textContent('#plan-text'), /2 segments · 300 m/);
  assert.deepEqual(await page.$$eval('#map .plan-num', (n) => n.map((x) => x.textContent)), ['1', '2']);
  ok('press and hold adds trails to the route in order, with distance');
  await snap(page, '1c-plan');
  await holdOn(ridgeA);
  assert.deepEqual(await planIds(), ['1002']);
  await page.click('#plan-undo');
  assert.deepEqual(await planIds(), []);
  assert.ok(await page.isHidden('#plan-bar'));
  ok('holding again removes a trail; Undo removes the last one');
  await page.mouse.click(...Object.values(await page.evaluate((q) => { const p = window.trailnav.map.project([q.lng, q.lat]); return { x: p.x, y: p.y }; }, ridgeB)));
  await page.waitForSelector('#sheet #seg-plan');
  assert.equal(await page.textContent('#sheet #seg-plan'), 'Add to route');
  await page.click('#sheet #seg-plan');
  assert.equal(await page.textContent('#sheet #seg-plan'), 'Remove from route (#1)');
  assert.deepEqual(await planIds(), ['1002']);
  page.once('dialog', (d) => d.accept());
  await page.click('#plan-clear');
  assert.deepEqual(await planIds(), []);
  ok('"Add to route" in the trail panel; Clear empties the route');
  await page.click('#sheet-close');

  // Same with a finger: a real touch press-and-hold (as on a phone), then a normal tap still works.
  const cdp = await context.newCDPSession(page);
  const touchAt = async (p, ms) => {
    const pt = await page.evaluate((q) => window.trailnav.map.project([q.lng, q.lat]), p);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pt.x, y: pt.y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
  };
  await idle();
  await touchAt(ridgeB, 1000);
  assert.deepEqual(await planIds(), ['1002']);
  assert.ok(await page.isHidden('#sheet'), 'touch hold does not also open the trail panel');
  await touchAt(ridgeA, 80);
  assert.deepEqual(await planIds(), ['1002'], 'a short tap does not add to the route');
  await page.waitForSelector('#sheet #seg-plan');
  ok('touch: hold adds to the route, a quick tap opens the trail panel');
  await page.click('#plan-undo');
  await page.click('#sheet-close');

  // Plan route mode: tap trails in order; start from GPS (START, 500 m west of the trail).
  await page.click('#view-toggle [data-view="plan"]');
  await page.waitForSelector('#sheet .plan-row');
  // Tap a map point, first panning it into the clear space between the top bar and the
  // plan panel (whose height depends on the platform's fonts).
  const tapAt = async (p) => {
    const project = () => page.evaluate((q) => window.trailnav.map.project([q.lng, q.lat]), p);
    const free = await page.evaluate(() => ({
      top: document.querySelector('#topbar').getBoundingClientRect().bottom + 20,
      bottom: (document.querySelector('#sheet').hidden ? innerHeight : document.querySelector('#sheet').getBoundingClientRect().top) - 20,
    }));
    let pt = await project();
    if (pt.y < free.top || pt.y > free.bottom) {
      await page.evaluate(({ q, y }) => {
        const m = window.trailnav.map;
        m.panBy([0, m.project([q.lng, q.lat]).y - y], { animate: false });
      }, { q: p, y: (free.top + free.bottom) / 2 });
      await page.waitForTimeout(500);
      pt = await project();
    }
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(250);
  };
  await page.evaluate((p) => void window.trailnav.map.jumpTo({ center: [p.lng, p.lat], zoom: 15 }), ridgeA);
  await idle();
  await page.waitForTimeout(600);
  await tapAt(ridgeA);
  await tapAt(ridgeB);
  assert.deepEqual(await planIds(), ['1001', '1002']);
  assert.equal(await page.locator('#sheet .plan-list li').count(), 2);
  // Read the finished route for both trails in one go (the app rebuilds after each tap).
  const settled = (cond) => page.waitForFunction((c) => {
    const s = window.trailnav.state, r = s.planRoute;
    if (!r || s.planBuilding || s.plan.length !== c.n || (c.pin && !s.planStart)) return null;
    return { steps: r.steps.map((x) => x.text), d: r.distance };
  }, cond, { timeout: 8000 }).then((h) => h.jsonValue());
  const planSteps = (await settled({ n: 2 })).steps;
  assert.deepEqual(planSteps, ['Head east', 'Turn left onto Ridge Trail', 'Arrive at your end point']);
  assert.match(await page.textContent('#sheet .plan-summary'), /4 min.*800 m.*incl\. 500 m off the picked trails/);
  ok('plan mode: tap trails in order; route joins #1 at its closest point and turns onto it');
  await snap(page, '1d-plan-mode');

  // Drop a start pin right on the trail: no link needed, and #1 still sets the direction (north).
  await page.click('#sheet #pick-start');
  await tapAt({ lng: CORNER.lng + 0.0001, lat: CORNER.lat + 0.0003 });
  const r2 = await settled({ n: 2, pin: true });
  assert.deepEqual(r2.steps, ['Head north on Ridge Trail', 'Arrive at your end point']);
  assert.ok(Math.abs(r2.d - 267) < 15, r2.d);
  assert.match(await page.textContent('#sheet .plan-start'), /Pin on the map/);
  ok('a start pin sets where you join the trail');
  await page.click('#sheet #pick-start'); // back to my location

  // Simulate the ride: trail navigation, tilted view, moving along.
  await page.waitForFunction(() => !window.trailnav.state.planStart && window.trailnav.state.planRoute?.steps.length === 3, null, { timeout: 5000 });
  await page.click('#sheet #plan-sim');
  await page.waitForSelector('#nav-banner:not([hidden])');
  assert.equal(await page.textContent('#nav-text'), 'Turn left onto Ridge Trail');
  const d0 = parseInt(await page.textContent('#nav-dist'));
  await page.waitForTimeout(3200);
  const d1 = parseInt(await page.textContent('#nav-dist'));
  assert.ok(d1 < d0 - 15, `moving toward the turn (${d0} → ${d1} m)`);
  assert.ok(await page.evaluate(() => window.trailnav.map.getPitch()) > 50);
  ok(`simulated ride navigates along the plan (${d0} m → ${d1} m to the turn)`);
  await snap(page, '1e-simulate');
  await page.click('#btn-end');
  assert.equal(await page.evaluate(() => window.trailnav.state.sim), null, 'End stops the simulation');
  await page.click('#sheet #discard');
  await page.waitForSelector('#sheet .plan-row');
  ok('ending returns to the plan');
  await page.click('#sheet-close');
  assert.equal(await page.getAttribute('#view-toggle [data-view="explore"]', 'aria-checked'), 'true');
  page.once('dialog', (d) => d.accept());
  await page.click('#plan-clear');
  // Back to where the rest of the test expects GPS to be.
  await setGPS(START);

  // Draw a trail: a stroke snapped onto the track (1003), a freehand one, erase, undo, save.
  const track = { south: START.lat - 0.002, west: START.lng, east: START.lng + 0.003 }; // 1003 runs west-east
  await page.evaluate((p) => void window.trailnav.map.jumpTo({ center: [p.lng, p.lat], zoom: 16 }), { lng: START.lng + 0.0015, lat: START.lat - 0.0015 });
  await idle();
  await page.waitForTimeout(600);
  await page.click('#btn-draw');
  assert.ok(await page.isVisible('#draw-bar'));
  assert.ok(await page.isHidden('#topbar'), 'search and toggles step aside while drawing');
  const drag = async (from, to, steps = 15) => {
    const [a, b] = await page.evaluate(([p, q]) => [p, q].map((r) => window.trailnav.map.project([r.lng, r.lat])), [from, to]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps });
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  const strokes = () => page.evaluate(() => window.trailnav.draw.strokes);
  const offTrack = (p) => Math.abs(p.lat - track.south) * 111200; // metres from the track line
  const strokeLen = (s) => s.slice(1).reduce((d, p, i) => d + Math.hypot((p.lat - s[i].lat) * 111200, (p.lng - s[i].lng) * 86800), 0);
  // 8 m north of the track: snapping puts the line on it.
  await drag({ lat: track.south + 0.00007, lng: START.lng + 0.0003 }, { lat: track.south + 0.00007, lng: START.lng + 0.0027 });
  let st = await strokes();
  assert.equal(st.length, 1);
  assert.ok(st[0].every((p) => offTrack(p) < 1.5), `snapped onto the track (max ${Math.max(...st[0].map(offTrack)).toFixed(1)} m off)`);
  ok('drawing snaps onto an existing line by default');
  await page.uncheck('#draw-snap');
  await drag({ lat: track.south + 0.0012, lng: START.lng + 0.0005 }, { lat: track.south + 0.0012, lng: START.lng + 0.0025 });
  st = await strokes();
  assert.equal(st.length, 2);
  assert.ok(st[1].every((p) => offTrack(p) > 120), 'freehand stays where it was drawn');
  ok('with snapping off, drawing is freehand');
  await page.click('#draw-bar [data-tool="erase"]');
  const mid = START.lng + 0.0015;
  await drag({ lat: track.south + 0.0001, lng: mid }, { lat: track.south - 0.0001, lng: mid }, 6);
  assert.equal((await strokes()).length, 3, 'erasing through the middle splits the stroke');
  await page.click('#draw-undo');
  assert.equal((await strokes()).length, 2);
  ok('eraser cuts the drawing; Undo puts it back');
  // With a finger, as on a phone: pen tool, one-finger drag.
  await page.click('#draw-bar [data-tool="pen"]');
  const fa = await page.evaluate((q) => window.trailnav.map.project([q.lng, q.lat]), { lat: track.south + 0.0006, lng: START.lng + 0.0005 });
  const fb = await page.evaluate((q) => window.trailnav.map.project([q.lng, q.lat]), { lat: track.south + 0.0006, lng: START.lng + 0.0025 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fa.x, y: fa.y }] });
  for (let i = 1; i <= 15; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fa.x + ((fb.x - fa.x) * i) / 15, y: fa.y }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  st = await strokes();
  assert.equal(st.length, 3, 'a finger drag draws a stroke');
  assert.ok(strokeLen(st[2]) > 120, `finger stroke ${Math.round(strokeLen(st[2]))} m long`);
  ok('drawing works with a finger (touch), not just a mouse');
  await page.click('#draw-undo');
  await snap(page, '1f-draw');
  await page.click('#draw-save');
  await page.fill('#draw-name', 'Canal Path');
  await page.click('#draw-form button[type="submit"]');
  await page.waitForSelector('#sheet #seg-go');
  assert.equal(await page.textContent('#sheet h2'), 'Canal Path');
  assert.match(await page.textContent('#sheet .meta'), /drawn/);
  assert.equal(await page.evaluate(() => window.trailnav.draw.on), false);
  const drawn = await page.evaluate(() => [...window.trailnav.segmentStore.segments.values()].filter((s) => s.custom === 'mine').map((s) => s.name));
  assert.deepEqual(drawn, ['Canal Path', 'Canal Path']);
  await page.waitForFunction(() => window.trailnav.map.querySourceFeatures('segments').some((f) => f.properties.name === 'Canal Path'));
  ok('saved drawing becomes a named trail on the map, with its trail panel');
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
  // Give a slow machine a moment to process the last fixes.
  await page.waitForFunction(() => parseInt(document.querySelector('#nav-dist').textContent) < 100, null, { timeout: 5000 }).catch(() => {});
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
  await page.evaluate(() => void window.trailnav.map.setZoom(12));
  await idle();
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
  assert.deepEqual(exported.trails, { 1001: { rating: 'blue' }, 1002: { rating: 'black' }, 1003: { name: 'Quarry Spur' } });
  assert.deepEqual(Object.values(exported.custom).map((c) => c.name), ['Canal Path', 'Canal Path']);
  ok('ratings, names and drawn trails export in the same format as the shipped defaults file');

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
  // On GitHub Actions, also report it as an annotation, which is readable without access to the logs.
  if (process.env.GITHUB_ACTIONS) {
    const msg = `step ${step + 1}: ${err.message} | console errors: ${errors.join(' / ')}`.replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
    console.log(`::error title=e2e failed::${msg}`);
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
