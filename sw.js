// Service worker: offline app shell + a bounded cache of map tiles you've viewed,
// so the map keeps working when signal drops out on the trail.
const SHELL = 'trailnav-shell-v4';
const TILES = 'trailnav-tiles-v1';
const MAX_TILES = 3000;
const TRAILS = 'trailnav-trails-v1';
const MAX_TRAIL_TILES = 1500;

const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'vendor/maplibre-gl/maplibre-gl.css', 'vendor/maplibre-gl/maplibre-gl.js',
  'js/app.js', 'js/geo.js', 'js/format.js', 'js/instructions.js', 'js/routing.js', 'js/navigator.js',
  'js/recorder.js', 'js/trails.js', 'js/search.js', 'js/layers.js', 'js/segments.js', 'js/trail-info.js', 'js/plan.js', 'js/trailroute.js', 'js/draw.js',
  'data/trail-info.json', 'data/trails/index.json',
];
// Trail segment tiles (data/trails/tiles/*) are cached as they're viewed, in their own
// bounded cache, so the places you've looked at keep working offline.
const isTrailTile = (url) => url.pathname.includes('/data/trails/tiles/');

self.addEventListener('install', (e) => {
  // 'reload': fetch fresh copies, never the browser's possibly older cached ones.
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES, TRAILS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Raster map images (.png) and vector map data (.pbf, e.g. the water layer).
const isTile = (url) => /\/\d+\/\d+\/\d+\.(png|pbf)$/.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // App shell: network first (so updates land), cache fallback offline. 'no-cache' makes
    // the browser check with the server every time; otherwise the server lets it reuse a
    // file for 10 minutes, and a new page could load with older scripts.
    e.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) {
          const trail = isTrailTile(url), copy = res.clone(); // clone now, before the page reads the body
          caches.open(trail ? TRAILS : SHELL).then((c) => c.put(req, copy)).then(() => trail && trim(TRAILS, MAX_TRAIL_TILES));
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  if (isTile(url)) {
    // Tiles: cache first, refresh in background.
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).then(() => trim(TILES, MAX_TILES));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
  // Everything else (routing, search, Overpass) goes straight to the network.
});

// Drop the oldest entries beyond max (one trim per cache at a time).
const trimming = new Set();
async function trim(name, max) {
  if (trimming.has(name)) return;
  trimming.add(name);
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
  } finally {
    trimming.delete(name);
  }
}
