// Service worker: offline app shell + a bounded cache of map tiles you've viewed,
// so the map keeps working when signal drops out on the trail.
const SHELL = 'trailnav-shell-v2';
const TILES = 'trailnav-tiles-v1';
const MAX_TILES = 3000;

const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'vendor/maplibre-gl/maplibre-gl.css', 'vendor/maplibre-gl/maplibre-gl.js',
  'js/app.js', 'js/geo.js', 'js/format.js', 'js/instructions.js', 'js/routing.js', 'js/navigator.js',
  'js/recorder.js', 'js/trails.js', 'js/search.js', 'js/layers.js', 'js/segments.js', 'js/trail-info.js', 'js/plan.js',
  'data/trail-info.json', 'data/trails/index.json', 'data/trails/names.json',
];
// Trail segment tiles (data/trails/tiles/*) are same-origin, so they're cached as
// they're viewed by the app-shell handler below and keep working offline.

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isTile = (url) => /\/\d+\/\d+\/\d+\.png$/.test(url.pathname);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // App shell: network first (so updates land), cache fallback offline.
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
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
          if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); trim(cache); }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
  // Everything else (routing, search, Overpass) goes straight to the network.
});

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}
