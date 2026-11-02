/* global maplibregl */
import { BASE_LAYERS, OVERLAYS, MODE_DEFAULTS, REGION, inRegion } from './layers.js';
import { searchPlaces, reverseGeocode } from './search.js';
import { fetchRoutes } from './routing.js';
import { Navigator } from './navigator.js';
import { TrackRecorder } from './recorder.js';
import { fetchTrails, nearestPointOnTrail, ROUTE_LABEL } from './trails.js';
import { SegmentStore, segmentLabel, HIGHWAY_LABEL } from './segments.js';
import { RATINGS, UNRATED, effectiveRating, ratingColor, exportRatings } from './ratings.js';
import { haversine, bearing, destination, polylineLength, snapToPolyline, cumulativeDistances } from './geo.js';
import { formatDistance, formatDuration, formatSpeed, formatClock } from './format.js';

// ---------------------------------------------------------------- state ----
const SETTINGS_KEY = 'trailnav:settings';
const settings = Object.assign(
  { mode: 'bike', units: 'imperial', voice: true, base: null, overlays: null, camera: null },
  load(SETTINGS_KEY)
);
// Older versions saved the metric default without the user picking it; only keep units they chose.
if (!settings.unitsChosen) settings.units = 'imperial';
// Map position saved by the Leaflet version: same centre, but MapLibre zoom levels are one lower.
if (settings.view && !settings.camera) {
  settings.camera = { center: [settings.view.center[1], settings.view.center[0]], zoom: settings.view.zoom - 1 };
}
delete settings.view;
// The app covers California only; a saved position elsewhere starts at Granite Bay instead.
if (!settings.camera || !inRegion(...settings.camera.center)) settings.camera = { ...REGION.home };

// Difficulty ratings: shipped defaults plus this device's own ratings (see ratings.js).
const RATINGS_KEY = 'trailnav:ratings';
const myRatings = load(RATINGS_KEY);
let defaultRatings = {};
const segmentStore = new SegmentStore();

const state = {
  fix: null,            // latest GPS fix
  heading: null,
  watchId: null,
  origin: null,         // {lat,lng,name} or null = my location
  dest: null,           // {lat,lng,name}
  routes: [],
  routeIndex: 0,
  nav: null,            // Navigator while navigating
  following: true,
  rerouting: false,
  lastReroute: 0,
  recorder: null,
  wakeLock: null,
  trails: [],
  navHeading: null,     // direction of travel the map faces while navigating
  highlight: null,      // {name, id}: highlighted trail and the tapped segment of it
};

const $ = (s) => document.querySelector(s);
const els = {
  search: $('#search'), searchForm: $('#search-form'), searchClear: $('#search-clear'), results: $('#search-results'),
  sheet: $('#sheet'), sheetBody: $('#sheet-body'), sheetClose: $('#sheet-close'),
  toast: $('#toast'),
  banner: $('#nav-banner'), navIcon: $('#nav-icon'), navDist: $('#nav-dist'), navText: $('#nav-text'), navThen: $('#nav-then'),
  footer: $('#nav-footer'), navRemaining: $('#nav-remaining'), navEta: $('#nav-eta'), navSpeed: $('#nav-speed'),
  offroute: $('#offroute'), recenter: $('#btn-recenter'), mute: $('#btn-mute'),
};

// ------------------------------------------------------------------ map ----
// MapLibre GL (WebGL) so the map can tilt and turn with you while navigating.
// Zoom levels are one lower than Leaflet's for the same scale.
const NAV_ZOOM = 17, NAV_PITCH = 60, CAMERA_MS = 1000;
const EMPTY = { type: 'FeatureCollection', features: [] };
const ll = (p) => [p.lng, p.lat];
const fc = (features) => ({ type: 'FeatureCollection', features });
const lineFeature = (coords, properties = {}) =>
  ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords.map(ll) } });

function rasterSource(d) {
  const tiles = d.url.includes('{s}') ? [...(d.options.subdomains || 'abc')].map((s) => d.url.replace('{s}', s)) : [d.url];
  return { type: 'raster', tiles, tileSize: 256, maxzoom: d.options.maxZoom, attribution: d.options.attribution };
}
const lineLayer = (id, source, paint, extra = {}) =>
  ({ id, source, type: 'line', layout: { 'line-join': 'round', 'line-cap': 'round', ...extra.layout }, paint, ...(extra.filter && { filter: extra.filter }) });

function shownLayers() {
  const defaults = MODE_DEFAULTS[settings.mode];
  const base = settings.base || defaults.base;
  const overlays = settings.overlays || defaults.overlays;
  return new Set([`base-${base}`, ...overlays.map((k) => `ov-${k}`)]);
}
const visibility = (id, shown) => (shown.has(id) ? 'visible' : 'none');

const map = (() => {
  const shown = shownLayers();
  const b = REGION.bounds;
  const selected = ['==', ['get', 'hl'], 2]; // the tapped segment (1 = rest of the same trail)
  return new maplibregl.Map({
    container: 'map',
    center: settings.camera.center,
    zoom: settings.camera.zoom,
    maxBounds: [[b.west, b.south], [b.east, b.north]],
    maxZoom: 19,
    maxPitch: 70,
    style: {
      version: 8,
      sources: {
        ...Object.fromEntries(Object.entries(BASE_LAYERS).map(([k, d]) => [`base-${k}`, rasterSource(d)])),
        ...Object.fromEntries(Object.entries(OVERLAYS).map(([k, d]) => [`ov-${k}`, rasterSource(d)])),
        trails: { type: 'geojson', data: EMPTY },
        segments: { type: 'geojson', data: EMPTY },
        accuracy: { type: 'geojson', data: EMPTY },
        routes: { type: 'geojson', data: EMPTY },
        record: { type: 'geojson', data: EMPTY },
      },
      layers: [
        // Base maps are faded (paler, less colour) so roads recede and the trail lines stand out.
        ...Object.keys(BASE_LAYERS).map((k) => ({ id: `base-${k}`, source: `base-${k}`, type: 'raster', layout: { visibility: visibility(`base-${k}`, shown) },
          paint: { 'raster-saturation': -0.75, 'raster-contrast': -0.3, 'raster-brightness-min': 0.3 } })),
        ...Object.entries(OVERLAYS).map(([k, d]) => ({ id: `ov-${k}`, source: `ov-${k}`, type: 'raster',
          layout: { visibility: visibility(`ov-${k}`, shown) }, paint: { 'raster-opacity': d.options.opacity ?? 1 } })),
        // Signed routes from "Trails nearby": a wide amber glow under the segments, in a
        // colour that can't be confused with a difficulty rating.
        lineLayer('trails', 'trails', {
          'line-color': '#ff9800',
          'line-width': ['match', ['get', 'look'], 'hl', 16, 11],
          'line-opacity': ['match', ['get', 'look'], 'hl', 0.6, 'dim', 0.15, 0.4],
        }, { layout: { 'line-sort-key': ['match', ['get', 'look'], 'hl', 1, 0] } }),
        // Highlighted trail: a yellow glow along its whole length, visible at any zoom.
        lineLayer('segments-hl', 'segments', {
          'line-color': '#ffc400',
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, ['case', selected, 9, 6], 16, ['case', selected, 22, 16]],
          'line-opacity': ['case', selected, 0.95, 0.7],
        }, { filter: ['>', ['get', 'hl'], 0] }),
        // Every trail segment, coloured by difficulty rating (grey = not rated).
        { ...lineLayer('segments-casing', 'segments', {
          'line-color': '#fff', 'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', selected, 8, 4], 16, ['case', selected, 12, 8]],
        }, { layout: { 'line-sort-key': ['case', selected, 1, 0] } }), minzoom: 12 },
        { ...lineLayer('segments', 'segments', {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['case', selected, 5, 2], 16, ['case', selected, 8, 5]],
        }, { layout: { 'line-sort-key': ['case', selected, 1, 0] } }), minzoom: 12 },
        { id: 'accuracy', source: 'accuracy', type: 'fill', paint: { 'fill-color': '#1a73e8', 'fill-opacity': 0.1, 'fill-outline-color': '#1a73e8' } },
        lineLayer('route-alt', 'routes', { 'line-color': '#8aa4c8', 'line-width': 6, 'line-opacity': 0.8 }, { filter: ['==', ['get', 'active'], false] }),
        lineLayer('route-casing', 'routes', { 'line-color': '#fff', 'line-width': 10, 'line-opacity': 0.9 }, { filter: ['==', ['get', 'active'], true] }),
        lineLayer('route', 'routes', { 'line-color': '#1a73e8', 'line-width': 6 }, { filter: ['==', ['get', 'active'], true] }),
        lineLayer('record', 'record', { 'line-color': '#e53935', 'line-width': 4, 'line-opacity': 0.8 }),
      ],
    },
  });
})();
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

// Sources and layers only exist once the style has loaded; queue work until then.
let mapReady = false;
const readyQueue = [];
const whenReady = (fn) => (mapReady ? fn() : readyQueue.push(fn));
map.once('style.load', () => { mapReady = true; readyQueue.splice(0).forEach((fn) => fn()); });
const setData = (id, data) => whenReady(() => map.getSource(id).setData(data));

let meMarker = null, destMarker = null, originMarker = null, glide = null;

function fitTo(points, padding) {
  const bounds = new maplibregl.LngLatBounds();
  for (const p of points) bounds.extend(ll(p));
  map.fitBounds(bounds, { padding, maxZoom: 17, linear: true, duration: 600 });
}

function applyLayers() {
  whenReady(() => {
    const shown = shownLayers();
    for (const k of Object.keys(BASE_LAYERS)) map.setLayoutProperty(`base-${k}`, 'visibility', visibility(`base-${k}`, shown));
    for (const k of Object.keys(OVERLAYS)) map.setLayoutProperty(`ov-${k}`, 'visibility', visibility(`ov-${k}`, shown));
  });
}

let segmentTimer = null;
map.on('moveend', () => {
  const c = map.getCenter();
  settings.camera = { center: [c.lng, c.lat], zoom: map.getZoom() };
  save(SETTINGS_KEY, settings);
  clearTimeout(segmentTimer);
  segmentTimer = setTimeout(loadSegments, 300);
});
map.on('dragstart', () => {
  state.following = false;
  els.recenter.hidden = !(state.nav || state.fix);
});
map.on('click', (e) => {
  if (state.nav || !mapReady) return;
  if (!els.results.hidden) { els.results.hidden = true; return; }
  // Lines are thin, so accept taps a little way off them.
  const { x, y } = e.point;
  const hits = map.queryRenderedFeatures([[x - 16, y - 16], [x + 16, y + 16]], { layers: ['route-alt', 'segments', 'trails'] });
  const alt = hits.find((h) => h.layer.id === 'route-alt');
  if (alt) { selectRoute(alt.properties.i); return; }
  const segs = hits.filter((h) => h.layer.id === 'segments').map((h) => segmentStore.segments.get(h.properties.id)).filter(Boolean);
  if (segs.length) { showSegment(nearestSegment(segs, e.lngLat)); return; }
  const trail = hits.find((h) => h.layer.id === 'trails');
  if (trail) { showTrail(state.trails[trail.properties.i]); return; }
  showPlace({ lat: e.lngLat.lat, lng: e.lngLat.lng, name: 'Dropped pin' }, { lookup: true });
});

const trailTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'trail-tip', offset: 10 });
whenReady(() => {
  for (const layer of ['segments', 'trails']) {
    map.on('mousemove', layer, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      trailTip.setLngLat(e.lngLat).setText(e.features[0].properties.name).addTo(map);
    });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; trailTip.remove(); });
  }
});

/** While navigating: tilted, facing the direction of travel, with you low on the screen. */
function followCamera(fix, heading) {
  map.easeTo({
    center: ll(fix), zoom: Math.max(map.getZoom(), NAV_ZOOM), pitch: NAV_PITCH, bearing: heading ?? map.getBearing(),
    padding: { top: map.getContainer().clientHeight * 0.45, bottom: 0, left: 0, right: 0 },
    duration: CAMERA_MS, easing: (t) => t,
  });
}

let flattening = false;
function flatCamera() {
  flattening = true;
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 800 });
  map.once('moveend', () => { flattening = false; });
}

// ------------------------------------------------------------------ GPS ----
function startGPS() {
  if (!('geolocation' in navigator)) { toast('GPS is not available on this device'); return; }
  if (state.watchId != null) return;
  state.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
  });
}

function onGpsError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    toast('Location permission denied — enable it in your browser settings to navigate');
    navigator.geolocation.clearWatch(state.watchId); state.watchId = null;
  } else if (!state.fix) {
    toast('Waiting for GPS signal…');
  }
}

function onFix(pos) {
  const c = pos.coords;
  const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, altitude: c.altitude,
    speed: c.speed, heading: c.heading, timestamp: pos.timestamp || Date.now() };
  const prev = state.fix;
  // Device heading if available and moving, else derive from movement.
  if (fix.heading != null && !isNaN(fix.heading) && (fix.speed ?? 1) > 0.5) state.heading = fix.heading;
  else if (prev && haversine(prev, fix) > 5) state.heading = bearing(prev, fix);
  if (fix.speed == null && prev) {
    const dt = (fix.timestamp - prev.timestamp) / 1000;
    if (dt >= 1 && dt < 30) fix.speed = haversine(prev, fix) / dt;
  }
  const first = !prev;
  state.fix = fix;
  drawMe();
  if (first && !state.nav && !state.dest) map.jumpTo({ center: ll(fix), zoom: Math.max(map.getZoom(), 14) });
  if (state.recorder) { state.recorder.add(fix); updateRecordPanel(); }
  if (state.nav) onNavFix(fix);
  // Panning now would cut short the return to the flat view after navigating.
  else if (state.following && !first && !flattening) map.panTo(ll(fix));
}

function drawMe() {
  const f = state.fix; if (!f) return;
  cancelAnimationFrame(glide);
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me-marker';
    el.innerHTML = '<div class="cone"></div><div class="dot"></div><svg class="arrow" viewBox="0 0 24 24"><path d="M12 2 4.5 20.5 12 16l7.5 4.5z"/></svg>';
    // Lies flat on the map and turns with it, so it tilts with the navigation view.
    meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(ll(f)).addTo(map);
  } else if (state.nav && state.following) {
    glideMe(f, CAMERA_MS); // keep pace with the camera instead of jumping ahead of it
  } else {
    meMarker.setLngLat(ll(f));
  }
  setData('accuracy', f.accuracy ? circle(f, f.accuracy) : EMPTY);
  pointMe(state.heading);
}

function pointMe(heading) {
  if (!meMarker) return;
  meMarker.getElement().classList.toggle('no-heading', heading == null);
  meMarker.setRotation(heading ?? 0);
}

function glideMe(to, ms) {
  const from = meMarker.getLngLat(), t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    meMarker.setLngLat([from.lng + (to.lng - from.lng) * t, from.lat + (to.lat - from.lat) * t]);
    if (t < 1) glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}

function circle(c, radius) {
  const ring = [];
  for (let i = 0; i <= 48; i++) ring.push(ll(destination(c, i * 7.5, radius)));
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

$('#btn-locate').addEventListener('click', () => {
  startGPS();
  state.following = true;
  els.recenter.hidden = true;
  if (state.fix) map.easeTo({ center: ll(state.fix), zoom: Math.max(map.getZoom(), 15) });
  else toast('Finding your location…');
});
els.recenter.addEventListener('click', () => {
  state.following = true; els.recenter.hidden = true;
  if (!state.fix) return;
  if (state.nav) followCamera(state.fix, state.navHeading);
  else map.easeTo({ center: ll(state.fix), zoom: Math.max(map.getZoom(), 16) });
});

// --------------------------------------------------------------- search ----
let searchCtl = null, searchTimer = null;
els.search.addEventListener('input', () => {
  els.searchClear.hidden = !els.search.value;
  clearTimeout(searchTimer);
  const q = els.search.value.trim();
  if (q.length < 3) { els.results.hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(q), 600);
});
els.searchForm.addEventListener('submit', (e) => {
  e.preventDefault(); clearTimeout(searchTimer);
  const q = els.search.value.trim(); if (q) runSearch(q);
});
els.searchClear.addEventListener('click', () => {
  els.search.value = ''; els.searchClear.hidden = true; els.results.hidden = true; els.search.focus();
});

async function runSearch(q) {
  searchCtl?.abort(); searchCtl = new AbortController();
  const c = map.getCenter();
  try {
    const results = await searchPlaces(q, { near: { lat: c.lat, lng: c.lng }, within: REGION.bounds, signal: searchCtl.signal });
    renderResults(results);
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message);
  }
}

function renderResults(results) {
  els.results.innerHTML = '';
  if (!results.length) {
    els.results.innerHTML = '<li class="muted">No places found</li>';
  }
  for (const r of results) {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.innerHTML = `<div class="name"></div><div class="sub"></div>`;
    li.querySelector('.name').textContent = r.name;
    li.querySelector('.sub').textContent = [r.type, r.label].filter(Boolean).join(' · ');
    const pick = () => {
      els.results.hidden = true; els.search.blur();
      map.jumpTo({ center: ll(r), zoom: 14 });
      showPlace(r);
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => e.key === 'Enter' && pick());
    els.results.appendChild(li);
  }
  els.results.hidden = false;
}

// --------------------------------------------------------- bottom sheet ----
let sheetSeq = 0; // changes whenever the sheet's content is replaced
function openSheet(html, onRender) {
  sheetSeq++;
  unselectSegment();
  els.sheetBody.innerHTML = html;
  els.sheet.hidden = false;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => document.body.style.setProperty('--sheet-h', `${els.sheet.offsetHeight}px`));
  onRender?.(els.sheetBody);
}
function closeSheet() {
  unselectSegment();
  els.sheet.hidden = true; document.body.classList.remove('sheet-open');
}
els.sheetClose.addEventListener('click', () => {
  closeSheet();
  if (!state.nav) clearRoute();
});

// --------------------------------------------------------------- places ----
function pinMarker(color, p) {
  const el = document.createElement('div');
  el.className = 'pin-marker';
  el.innerHTML = `<svg viewBox="0 0 32 42"><path fill="${color}" stroke="#fff" stroke-width="2" d="M16 1C7.7 1 1 7.6 1 15.8 1 27 16 41 16 41s15-14 15-25.2C31 7.6 24.3 1 16 1z"/><circle cx="16" cy="16" r="5.5" fill="#fff"/></svg>`;
  return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(ll(p)).addTo(map);
}

function setDestMarker(p) {
  if (destMarker) destMarker.setLngLat(ll(p));
  else destMarker = pinMarker('#d93025', p);
}

async function showPlace(place, { lookup = false } = {}) {
  setDestMarker(place);
  const dist = state.fix ? formatDistance(haversine(state.fix, place), settings.units) + ' away' : '';
  openSheet(`
    <h2 class="place-name"></h2>
    <div class="muted place-sub"></div>
    <div class="row actions">
      <button class="btn primary" data-act="to">Directions</button>
      <button class="btn" data-act="from">Start here</button>
      <button class="btn" data-act="trails">Trails nearby</button>
      <button class="btn" data-act="view-trail" hidden>View trail</button>
    </div>`, (root) => {
    root.querySelector('.place-name').textContent = place.name;
    root.querySelector('.place-sub').textContent = [place.label && place.label !== place.name ? place.label : '', dist].filter(Boolean).join(' · ');
    root.querySelector('[data-act="to"]').onclick = () => planRoute({ ...place });
    root.querySelector('[data-act="from"]').onclick = () => {
      state.origin = { ...place };
      if (originMarker) originMarker.setLngLat(ll(place));
      else originMarker = pinMarker('#188038', place);
      if (destMarker) { destMarker.remove(); destMarker = null; }
      toast('Start set — now tap or search your destination');
      closeSheet();
    };
    root.querySelector('[data-act="trails"]').onclick = () => {
      map.jumpTo({ center: ll(place), zoom: Math.max(map.getZoom(), 12) });
      findTrails();
    };
  });
  const mine = sheetSeq;
  if (lookup) {
    const name = await reverseGeocode(place);
    if (name && sheetSeq === mine) {
      place.name = name;
      const n = els.sheetBody.querySelector('.place-name'); if (n) n.textContent = name;
    }
  }
  // A spot on a named trail we have data for: highlight the whole trail.
  if (sheetSeq !== mine || !(await segmentStore.hasName(place.name))) return;
  const segs = await highlightTrail(place.name);
  const btn = els.sheetBody.querySelector('[data-act="view-trail"]');
  if (sheetSeq === mine && btn && segs.length) {
    btn.hidden = false;
    btn.onclick = () => showSegment(nearestSegment(segs, place));
  }
}

// -------------------------------------------------------------- routing ----
let routeCtl = null;
async function planRoute(dest) {
  state.dest = dest;
  setDestMarker(dest);
  const origin = state.origin || (state.fix && { lat: state.fix.lat, lng: state.fix.lng, name: 'My location' });
  if (!origin) {
    startGPS();
    toast('Waiting for your location — or pick a start with “Start here”');
    openSheet(`<h2>Directions</h2><p class="muted">Getting your GPS position…</p>`);
    const ok = await waitForFix(15000);
    if (!ok || state.dest !== dest) return;
    return planRoute(dest);
  }
  openSheet(`<h2>Directions</h2><p class="muted">Finding the best ${settings.mode === 'bike' ? 'bike' : 'hiking'} route…</p>`);
  routeCtl?.abort(); routeCtl = new AbortController();
  try {
    state.routes = await fetchRoutes(settings.mode, [origin, dest], { signal: routeCtl.signal });
    state.routeIndex = 0;
    drawRoutes();
    fitTo(state.routes[0].coords, { top: 40, left: 40, right: 40, bottom: els.sheet.offsetHeight + 20 });
    renderRoutePanel(origin, dest);
  } catch (err) {
    if (err.name === 'AbortError') return;
    openSheet(`<h2>Directions</h2><p class="muted"></p><div class="row actions"><button class="btn" id="retry">Try again</button></div>`, (root) => {
      root.querySelector('p').textContent = err.message || 'Could not get a route';
      root.querySelector('#retry').onclick = () => planRoute(dest);
    });
  }
}

function waitForFix(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (state.fix) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 300);
  });
}

function drawRoutes() {
  setData('routes', fc(state.routes.map((r, i) => lineFeature(r.coords, { i, active: i === state.routeIndex }))));
}

function selectRoute(i) {
  state.routeIndex = i; drawRoutes(); renderRoutePanel(state.origin, state.dest);
}

function renderRoutePanel(origin, dest) {
  const r = state.routes[state.routeIndex];
  const u = settings.units;
  const alts = state.routes.length > 1
    ? `<div class="alts">${state.routes.map((x, i) => `<button class="alt" data-i="${i}" aria-pressed="${i === state.routeIndex}"><b>${formatDuration(x.duration)}</b>${formatDistance(x.distance, u)}</button>`).join('')}</div>`
    : '';
  openSheet(`
    <h2>${settings.mode === 'bike' ? '🚲' : '🥾'} <span class="dest-name"></span></h2>
    <div class="muted">From <span class="origin-name"></span></div>
    <div class="summary"><span class="big">${formatDuration(r.duration)}</span><span>${formatDistance(r.distance, u)}</span></div>
    ${alts}
    <div class="row actions">
      <button class="btn primary" id="btn-start">▶ Start</button>
      <button class="btn" id="btn-steps">Steps (${r.steps.length})</button>
      <button class="btn" id="btn-swap" title="Reverse direction">⇅ Reverse</button>
    </div>
    <ul class="steps" hidden></ul>`, (root) => {
    root.querySelector('.dest-name').textContent = dest.name || 'Destination';
    root.querySelector('.origin-name').textContent = origin?.name || 'My location';
    root.querySelectorAll('.alt').forEach((b) => (b.onclick = () => selectRoute(+b.dataset.i)));
    const stepsEl = root.querySelector('.steps');
    stepsEl.innerHTML = r.steps.map((s, i) => `<li data-i="${i}"><span class="maneuver-icon">${iconSvg(s.icon)}</span><span class="t"></span><span class="d">${s.distance ? formatDistance(s.distance, u) : ''}</span></li>`).join('');
    stepsEl.querySelectorAll('li').forEach((li) => {
      const s = r.steps[+li.dataset.i];
      li.querySelector('.t').textContent = s.text;
      li.onclick = () => map.easeTo({ center: ll(s.location), zoom: 16 });
    });
    root.querySelector('#btn-steps').onclick = () => { stepsEl.hidden = !stepsEl.hidden; };
    root.querySelector('#btn-start').onclick = () => startNavigation();
    root.querySelector('#btn-swap').onclick = () => {
      const from = origin?.name === 'My location' || !state.origin ? { lat: state.fix.lat, lng: state.fix.lng, name: 'My location' } : origin;
      state.origin = { ...dest };
      originMarker?.remove();
      originMarker = pinMarker('#188038', dest);
      planRoute(from);
    };
  });
}

function clearRoute() {
  setData('routes', EMPTY);
  state.routes = []; state.dest = null; state.origin = null;
  if (destMarker) { destMarker.remove(); destMarker = null; }
  if (originMarker) { originMarker.remove(); originMarker = null; }
}

// ----------------------------------------------------------- navigation ----
async function startNavigation() {
  const route = state.routes[state.routeIndex];
  if (!route) return;
  startGPS();
  if (!state.fix) { toast('Waiting for GPS before starting…'); if (!(await waitForFix(20000))) return toast('No GPS signal'); }
  // If the route started somewhere else ("Start here"), get from here to the route start first.
  state.origin = null;
  if (originMarker) { originMarker.remove(); originMarker = null; }

  state.nav = new Navigator(route, { mode: settings.mode, units: settings.units });
  state.following = true;
  closeSheet();
  document.body.classList.add('navigating');
  els.banner.hidden = false; els.footer.hidden = false;
  els.mute.textContent = settings.voice ? '🔊' : '🔇';
  speak(`Starting ${settings.mode === 'bike' ? 'ride' : 'hike'}. ${route.steps[0]?.text || ''}`, true);
  requestWakeLock();
  if (!state.recorder) startRecording(true);
  onNavFix(state.fix);
}

function onNavFix(fix) {
  const st = state.nav.update(fix);
  renderNav(st);
  for (const a of st.announcements) speak(a);
  // Face along the route; off it, fall back to the direction you're moving.
  state.navHeading = st.onRoute && st.heading != null ? st.heading : state.heading;
  pointMe(state.navHeading);
  if (state.following) followCamera(fix, state.navHeading);
  els.offroute.hidden = !st.offRoute;
  if (st.offRoute) reroute(fix);
  if (st.arrived) finishNavigation(true);
}

function renderNav(st) {
  const u = settings.units;
  els.navIcon.innerHTML = iconSvg(st.step.icon);
  els.navDist.textContent = st.arrived ? '' : formatDistance(st.distToManeuver, u);
  els.navText.textContent = st.arrived ? 'You have arrived' : st.step.text;
  const then = st.followingStep;
  const showThen = then && !st.arrived && then.along - st.step.along < 150;
  els.navThen.hidden = !showThen;
  if (showThen) els.navThen.textContent = `Then ${then.text.charAt(0).toLowerCase()}${then.text.slice(1)}`;
  els.navRemaining.textContent = formatDistance(st.remaining, u);
  els.navEta.textContent = formatClock(st.eta);
  els.navSpeed.textContent = formatSpeed(st.speed, u);
}

async function reroute(fix) {
  if (state.rerouting || Date.now() - state.lastReroute < 10000 || !state.dest) return;
  state.rerouting = true; state.lastReroute = Date.now();
  speak('Rerouting');
  try {
    const [route] = await fetchRoutes(settings.mode, [fix, state.dest], { alternatives: false });
    if (!state.nav) return;
    state.routes = [route]; state.routeIndex = 0;
    state.nav = new Navigator(route, { mode: settings.mode, units: settings.units });
    drawRoutes();
    const st = state.nav.update(fix);
    renderNav(st);
    els.offroute.hidden = true;
  } catch (err) {
    toast(`Reroute failed: ${err.message}`);
  } finally {
    state.rerouting = false;
  }
}

function finishNavigation(arrived) {
  if (!state.nav) return;
  state.nav = null;
  document.body.classList.remove('navigating');
  els.banner.hidden = true; els.footer.hidden = true; els.offroute.hidden = true; els.recenter.hidden = true;
  releaseWakeLock();
  flatCamera();
  pointMe(state.heading);
  setData('routes', EMPTY);
  if (destMarker) { destMarker.remove(); destMarker = null; }
  state.dest = null; state.routes = [];
  if (state.recorder?.autoStarted) stopRecording({ title: arrived ? '🏁 You have arrived' : 'Navigation ended' });
  else if (arrived) toast('🏁 You have arrived');
}

$('#btn-end').addEventListener('click', () => { speechSynthesis?.cancel(); finishNavigation(false); });
els.mute.addEventListener('click', () => {
  settings.voice = !settings.voice; save(SETTINGS_KEY, settings);
  els.mute.textContent = settings.voice ? '🔊' : '🔇';
  if (!settings.voice) window.speechSynthesis?.cancel();
});

function speak(text, interrupt = false) {
  if (!settings.voice || !('speechSynthesis' in window) || !text) return;
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.lang = navigator.language || 'en-US';
  speechSynthesis.speak(u);
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported / denied */ }
}
function releaseWakeLock() { state.wakeLock?.release().catch(() => {}); state.wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.nav && !state.wakeLock) requestWakeLock();
});

// -------------------------------------------------------- maneuver icons ----
function iconSvg(icon) {
  if (!icon) return '';
  switch (icon.kind) {
    case 'arrive':
      return '<svg viewBox="0 0 24 24"><path d="M5 21V4h9l.4 2H20v10h-7l-.4-2H7v7H5z"/></svg>';
    case 'depart':
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="17" r="3.5"/><path d="M12 2 6 9h4.5v4h3V9H18z"/></svg>';
    case 'uturn':
      return '<svg viewBox="0 0 24 24"><path d="M17 21V9a5 5 0 0 0-10 0v4H3.5L8 18l4.5-5H9V9a3 3 0 0 1 6 0v12z"/></svg>';
    case 'roundabout':
      return `<svg viewBox="0 0 24 24"><path d="M12 6a6 6 0 1 0 6 6h-2.2A3.8 3.8 0 1 1 12 8.2V11l4-4-4-4z"/>${icon.exit ? `<text x="12" y="15" font-size="7" text-anchor="middle" font-weight="700">${icon.exit}</text>` : ''}</svg>`;
    default:
      return `<svg viewBox="0 0 24 24" style="transform:rotate(${icon.angle}deg)"><path d="M12 2 4.5 10H10v12h4V10h5.5z"/></svg>`;
  }
}

// --------------------------------------------------------------- trails ----
let trailCtl = null;
async function findTrails() {
  if (map.getZoom() < 9) { toast('Zoom in closer to find trails'); return; }
  const mode = settings.mode;
  openSheet(`<h2>${mode === 'bike' ? 'Bike' : 'Hiking'} trails here</h2><p class="muted">Searching OpenStreetMap…</p>`);
  trailCtl?.abort(); trailCtl = new AbortController();
  const b = map.getBounds();
  try {
    state.trails = await fetchTrails({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, mode, { signal: trailCtl.signal });
    drawTrails();
    renderTrailList();
  } catch (err) {
    if (err.name === 'AbortError') return;
    openSheet(`<h2>Trails</h2><p class="muted"></p>`, (root) => (root.querySelector('p').textContent = err.message));
  }
}

function drawTrails(highlight = null) {
  setData('trails', fc(state.trails.map((t, i) => ({
    type: 'Feature',
    properties: { i, name: t.name, look: highlight === t ? 'hl' : highlight ? 'dim' : '' },
    geometry: { type: 'MultiLineString', coordinates: t.lines.map((line) => line.map(ll)) },
  }))));
}

function renderTrailList() {
  if (!state.trails.length) {
    openSheet(`<h2>Trails here</h2><p class="muted">No signed ${settings.mode === 'bike' ? 'bike/MTB' : 'hiking'} routes in this area. Try zooming out a little or switching activity.</p>`);
    return;
  }
  openSheet(`<h2>${state.trails.length} trails here</h2><ul class="trail-list"></ul>`, (root) => {
    const ul = root.querySelector('ul');
    for (const t of state.trails) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="swatch"></span><div><b class="n"></b><div class="muted meta"></div></div>`;
      li.querySelector('.n').textContent = t.name;
      li.querySelector('.meta').textContent = trailMeta(t);
      li.onclick = () => showTrail(t);
      ul.appendChild(li);
    }
  });
}

function trailMeta(t) {
  return [ROUTE_LABEL[t.route] || t.route, t.ref, t.distanceTag ? formatDistance(t.distanceTag, settings.units) : null, t.difficulty]
    .filter(Boolean).join(' · ');
}

function showTrail(t) {
  drawTrails(t);
  fitTo(t.lines.flat(), 30);
  openSheet(`
    <h2 class="n"></h2>
    <div class="muted meta"></div>
    <p class="desc"></p>
    <div class="row actions">
      <button class="btn primary" id="go-trail">Directions to trail</button>
      <button class="btn" id="back">All trails</button>
      <a class="btn" id="osm" target="_blank" rel="noopener">Details</a>
    </div>`, (root) => {
    root.querySelector('.n').textContent = t.name;
    root.querySelector('.meta').textContent = trailMeta(t);
    root.querySelector('.desc').textContent = t.description;
    const a = root.querySelector('#osm');
    a.href = `https://hiking.waymarkedtrails.org/#route?id=${t.id}`.replace('hiking', t.route === 'mtb' ? 'mtb' : t.route === 'bicycle' ? 'cycling' : 'hiking');
    root.querySelector('#back').onclick = () => { drawTrails(); renderTrailList(); };
    root.querySelector('#go-trail').onclick = () => {
      const from = state.origin || state.fix || map.getCenter();
      const near = nearestPointOnTrail({ lat: from.lat, lng: from.lng }, t);
      planRoute({ lat: near.point.lat, lng: near.point.lng, name: t.name });
    };
  });
}

$('#btn-trails').addEventListener('click', findTrails);

// ------------------------------------------------- trail segments & ratings ----
async function loadSegments() {
  if (map.getZoom() < 12) return;
  const b = map.getBounds();
  if (await segmentStore.loadBounds({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() })) drawSegments();
}

function drawSegments() {
  const h = state.highlight;
  setData('segments', fc([...segmentStore.segments.values()].map((s) => lineFeature(s.coords, {
    id: s.id,
    name: segmentLabel(s),
    color: ratingColor(effectiveRating(s.id, defaultRatings, myRatings).rating),
    hl: !h ? 0 : s.id === h.id ? 2 : h.name && s.name === h.name ? 1 : 0,
  }))));
}

function unselectSegment() {
  if (!state.highlight) return;
  state.highlight = null;
  drawSegments();
}

/** Highlight a whole named trail (loading every tile it runs through). */
async function highlightTrail(name, id = null) {
  state.highlight = { name, id };
  drawSegments();
  const segs = name ? await segmentStore.loadTrail(name) : [];
  if (state.highlight?.name === name) drawSegments();
  return segs;
}

function nearestSegment(segs, p) {
  const d = (s) => snapToPolyline({ lat: p.lat, lng: p.lng }, s.coords, cumulativeDistances(s.coords)).distance;
  return segs.reduce((best, s) => (d(s) < d(best) ? s : best));
}

function ratingText(id) {
  const { rating, source } = effectiveRating(id, defaultRatings, myRatings);
  if (!rating) return source === 'you' ? 'Not rated (you removed the default rating)' : 'Not rated';
  const r = RATINGS[rating];
  return `${r.label} · ${r.meaning} · ${source === 'you' ? 'your rating' : 'TrailNav default'}`;
}

async function showSegment(seg, { fit = true } = {}) {
  const { rating } = effectiveRating(seg.id, defaultRatings, myRatings);
  const choices = [...Object.entries(RATINGS), ['unrated', UNRATED]];
  openSheet(`
    <h2 class="n"></h2>
    <div class="muted meta"></div>
    <div class="muted trail-len"></div>
    <h3>This segment</h3>
    <div class="rating-now"><span class="swatch"></span><span class="txt"></span></div>
    <div class="rate-buttons">
      ${choices.map(([k, r]) => `<button class="rate" data-r="${k}" aria-pressed="${(rating || 'unrated') === k}"><span class="swatch" style="background:${r.color}"></span>${r.label}</button>`).join('')}
    </div>
    <label class="same" hidden><input type="checkbox" id="rate-all"> <span></span></label>
    <div class="row actions"><button class="btn" id="rate-reset" hidden>Use TrailNav default</button></div>`, (root) => {
    root.querySelector('.n').textContent = segmentLabel(seg);
    root.querySelector('.meta').textContent = `${HIGHWAY_LABEL[seg.kind] || 'Trail'} · this segment ${formatDistance(polylineLength(seg.coords), settings.units)}`;
    root.querySelector('.rating-now .swatch').style.background = ratingColor(rating);
    root.querySelector('.rating-now .txt').textContent = ratingText(seg.id);
    root.querySelector('#rate-reset').hidden = !myRatings[seg.id];
    root.querySelectorAll('.rate').forEach((b) => (b.onclick = () => {
      const targets = root.querySelector('#rate-all').checked ? segmentStore.named(seg.name) : [seg];
      for (const s of targets) {
        // Only store what differs from the shipped default.
        const def = effectiveRating(s.id, defaultRatings, {}).rating || 'unrated';
        if (b.dataset.r === def) delete myRatings[s.id];
        else myRatings[s.id] = { rating: b.dataset.r, name: s.name };
      }
      save(RATINGS_KEY, myRatings);
      showSegment(seg, { fit: false });
    }));
    root.querySelector('#rate-reset').onclick = () => { delete myRatings[seg.id]; save(RATINGS_KEY, myRatings); showSegment(seg, { fit: false }); };
  });

  // Highlight the whole trail and show all of it.
  const root = els.sheetBody;
  const named = seg.name ? await highlightTrail(seg.name, seg.id) : (await highlightTrail(null, seg.id), [seg]);
  if (state.highlight?.id !== seg.id) return; // another trail was tapped meanwhile
  if (named.length > 1) {
    root.querySelector('.trail-len').textContent = `Whole trail ${formatDistance(named.reduce((d, s) => d + polylineLength(s.coords), 0), settings.units)} in ${named.length} segments (highlighted)`;
    const label = root.querySelector('.same');
    label.hidden = false;
    label.querySelector('span').textContent = `Apply to all ${named.length} segments of “${seg.name}”`;
  }
  if (fit) fitTo(named.flatMap((s) => s.coords), { top: 60, left: 40, right: 40, bottom: els.sheet.offsetHeight + 20 });
}

function exportMyRatings() {
  const json = JSON.stringify(exportRatings(defaultRatings, myRatings), null, 2);
  download('trail-ratings.json', `${json}\n`, 'application/json');
}

// ------------------------------------------------------------ recording ----
$('#btn-record').addEventListener('click', () => {
  if (state.recorder) stopRecording();
  else startRecording(false);
});

function startRecording(auto) {
  startGPS();
  state.recorder = new TrackRecorder();
  state.recorder.autoStarted = auto;
  setData('record', EMPTY);
  $('#btn-record').classList.add('recording');
  if (state.fix) state.recorder.add(state.fix);
  if (!auto) toast('Recording started');
}

function updateRecordPanel() {
  const r = state.recorder;
  if (r?.points.length > 1) setData('record', lineFeature(r.points));
}

function stopRecording({ title = 'Activity recorded' } = {}) {
  const r = state.recorder; if (!r) return;
  state.recorder = null;
  $('#btn-record').classList.remove('recording');
  const u = settings.units;
  const dur = r.points.length > 1 ? (r.points.at(-1).time - r.points[0].time) / 1000 : 0;
  openSheet(`
    <h2></h2>
    <div class="stats-grid">
      <div><b>${formatDistance(r.distance, u)}</b>distance</div>
      <div><b>${formatDuration(dur)}</b>total time</div>
      <div><b>${formatSpeed(r.avgSpeed, u)}</b>avg moving speed</div>
      <div><b>${u === 'imperial' ? Math.round(r.elevationGain * 3.28084) + ' ft' : Math.round(r.elevationGain) + ' m'}</b>climb</div>
    </div>
    <div class="row actions">
      <button class="btn primary" id="gpx" ${r.points.length < 2 ? 'disabled' : ''}>Export GPX</button>
      <button class="btn" id="discard">Close</button>
    </div>`, (root) => {
    root.querySelector('h2').textContent = title;
    root.querySelector('#gpx').onclick = () => {
      const name = `TrailNav ${new Date(r.startedAt).toISOString().slice(0, 16).replace('T', ' ')}`;
      download(`${name.replace(/[: ]/g, '-')}.gpx`, r.toGPX(name, settings.mode === 'bike' ? 'cycling' : 'hiking'), 'application/gpx+xml');
    };
    root.querySelector('#discard').onclick = () => {
      setData('record', EMPTY);
      closeSheet();
    };
  });
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------- layers & settings ----
$('#btn-layers').addEventListener('click', () => {
  const defaults = MODE_DEFAULTS[settings.mode];
  const base = settings.base || defaults.base;
  const overlays = settings.overlays || defaults.overlays;
  openSheet(`
    <h2>Map & settings</h2>
    <div class="settings">
      <h3>Base map</h3>
      ${Object.entries(BASE_LAYERS).map(([k, d]) => `<label><input type="radio" name="base" value="${k}" ${k === base ? 'checked' : ''}> ${d.name}</label>`).join('')}
      <h3>Trail overlays</h3>
      ${Object.entries(OVERLAYS).map(([k, d]) => `<label><input type="checkbox" name="ov" value="${k}" ${overlays.includes(k) ? 'checked' : ''}> ${d.name}</label>`).join('')}
      <h3>Trail difficulty</h3>
      <div class="legend">${[...Object.values(RATINGS), UNRATED].map((r) => `<span><i style="background:${r.color}"></i>${r.label}</span>`).join('')}</div>
      <p class="muted note">Zoom in and tap a trail to rate it. Grey only means nobody has rated it yet. It says nothing about how hard the trail is.</p>
      <div class="row"><span>Your ratings on this device: <b id="my-count"></b></span><button class="btn" id="export-ratings">Export</button></div>
      <h3>Navigation</h3>
      <label>Units <select id="units"><option value="metric">Metric (km)</option><option value="imperial">Imperial (mi)</option></select></label>
      <label><input type="checkbox" id="voice" ${settings.voice ? 'checked' : ''}> Voice directions</label>
    </div>`, (root) => {
    root.querySelector('#my-count').textContent = Object.keys(myRatings).length;
    root.querySelector('#export-ratings').onclick = exportMyRatings;
    root.querySelector('#units').value = settings.units;
    root.querySelectorAll('input[name="base"]').forEach((i) => (i.onchange = () => { settings.base = i.value; persistLayers(); }));
    root.querySelectorAll('input[name="ov"]').forEach((i) => (i.onchange = () => {
      settings.overlays = [...root.querySelectorAll('input[name="ov"]:checked')].map((x) => x.value); persistLayers();
    }));
    root.querySelector('#units').onchange = (e) => { settings.units = e.target.value; settings.unitsChosen = true; save(SETTINGS_KEY, settings); };
    root.querySelector('#voice').onchange = (e) => { settings.voice = e.target.checked; save(SETTINGS_KEY, settings); };
  });
});
function persistLayers() { save(SETTINGS_KEY, settings); applyLayers(); }

// ----------------------------------------------------------- mode switch ----
document.querySelectorAll('.mode-toggle button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  if (mode === settings.mode) return;
  settings.mode = mode;
  // Switching activity resets layer choices to that activity's defaults.
  settings.base = null; settings.overlays = null;
  save(SETTINGS_KEY, settings);
  syncModeUI();
  applyLayers();
  if (state.dest && !state.nav) planRoute(state.dest);
}
function syncModeUI() {
  document.body.dataset.mode = settings.mode;
  document.querySelectorAll('.mode-toggle button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
}

// --------------------------------------------------------------- utils ----
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (els.toast.hidden = true), 3500);
}
function load(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

// ----------------------------------------------------------------- boot ----
syncModeUI();
applyLayers();
startGPS();
whenReady(loadSegments);
fetch('data/trail-ratings.json')
  .then((r) => (r.ok ? r.json() : {}))
  .then((json) => { defaultRatings = json.ratings || {}; drawSegments(); })
  .catch(() => { /* offline and not cached: own ratings still apply */ });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Exposed for debugging / automated tests.
window.trailnav = { map, state, settings };
