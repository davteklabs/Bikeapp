# TrailNav — bike & hike navigation

A "Google Maps for trails": open trail maps, phone GPS, and live voice turn-by-turn
directions for **cycling** and **hiking**. It's a Progressive Web App (PWA). It runs in any
modern phone browser, you can install it to the home screen, and it needs no app store,
accounts, or API keys.

## Features

| | |
|---|---|
| 🗺️ **Trail maps** | Base maps: CyclOSM (bike), OpenTopoMap (hike, with contours), OpenStreetMap. Overlays from Waymarked Trails show signed hiking, cycling and MTB routes worldwide. |
| 🔎 **Search** | Find places, peaks, parks and trailheads (OpenStreetMap Nominatim). Tap anywhere on the map to drop a pin. |
| 🧭 **Routing** | Bike-specific and foot-specific routing on OSM paths and tracks, with alternative routes, a step list, reverse, and a custom start point. |
| 🗣️ **Live navigation** | Google Maps–style tilted view that turns to face your direction of travel, with you low on the screen and the route ahead. Big next-turn banner with distance-to-turn, voice prompts timed per activity, "then…" hints for back-to-back turns, ETA, remaining distance and speed. The screen stays on. |
| ↩️ **Auto-reroute** | Detects when you leave the route (it takes GPS accuracy into account and needs several bad fixes in a row) and recalculates from where you are. |
| 🥾 **Trails nearby** | Lists signed trails in the current view with type, ref, length and difficulty. Tap one to highlight it, then get directions to its closest point. |
| ⏺️ **Track recording** | Records your ride or hike (auto-starts with navigation) with distance, time, moving speed and climb. Export as **GPX** for Strava, Komoot, etc. |
| 📴 **Offline-friendly** | A service worker caches the app and up to 3,000 recently viewed map tiles, so the map keeps working when you lose signal. |
| ⚙️ **Settings** | Metric or imperial units, voice on/off, choice of base map and overlays. Bike and Hike modes each have their own defaults. |

## Run it

```bash
npm start            # http://localhost:8080  (no dependencies to install)
```

Phones only allow GPS on **https** pages (or localhost). To use it on your phone:

1. **GitHub Pages (recommended).** In the repo go to **Settings → Pages → Source: GitHub Actions**.
   After that, every push to the default branch runs the tests and deploys to
   `https://<user>.github.io/<repo>/`. Open that link on your phone, then choose
   **Add to Home Screen**.
2. **Quick tunnel from your computer.** Run `npm start`, then `npx localtunnel --port 8080`
   and open the https URL it prints.

## Tests

```bash
npm test             # unit tests: geometry, instructions, navigation engine, GPX, trails parsing
npm run test:e2e     # headless Chromium: simulated GPS ride with mocked map services
```

The e2e test runs a full trip: search → route → start → live banner and voice updates →
leave the route → automatic reroute → arrive → GPX export → hike mode → nearby trails →
directions to a trail. Set `SHOTS_DIR=some/dir` to save screenshots.

## How it works

```
index.html, css/app.css    UI shell (mobile-first, light and dark)
js/app.js                  UI controller: map (MapLibre GL), GPS, panels, voice, wake lock
js/navigator.js            Navigation engine (pure): snap to route, progress, next maneuver,
                           voice prompt timing, off-route and arrival detection
js/routing.js              OSRM client + route normalisation
js/instructions.js         OSRM maneuvers → "Turn left onto Ridge Trail" + icons
js/trails.js               Overpass query for hiking/bicycle/MTB route relations
js/search.js               Nominatim search (rate-limited to 1 request/second)
js/recorder.js             Track recording + GPX export
js/geo.js, js/format.js    Geometry and unit formatting
sw.js                      Offline app shell + tile cache
```

### Data sources (all OpenStreetMap-based, free, no keys)

| What | Service |
|---|---|
| Routing | [FOSSGIS OSRM](https://routing.openstreetmap.de) `routed-bike` / `routed-foot` |
| Search | [Nominatim](https://nominatim.org) |
| Trails list | [Overpass API](https://overpass-api.de) |
| Trail overlays | [Waymarked Trails](https://waymarkedtrails.org) |
| Base maps | [CyclOSM](https://www.cyclosm.org), [OpenTopoMap](https://opentopomap.org), [OSM](https://www.openstreetmap.org) |

These public servers are run by volunteers and are meant for **light/personal use**. If the
app gets real traffic, move to your own or paid infrastructure. Each service sits behind one
URL constant, so swapping is a small change:

- Routing: self-host [BRouter](https://brouter.de) or [GraphHopper](https://www.graphhopper.com/) (they have strong bike/MTB/hiking profiles and elevation-aware routing), or use the GraphHopper / Stadia / Mapbox APIs.
- Tiles: Thunderforest (OpenCycleMap/Outdoors), MapTiler Outdoor, Stadia, or self-hosted vector tiles (Protomaps).
- Search: self-hosted Nominatim/Photon, or a commercial geocoder.

## Limitations & roadmap

- **Screen-off GPS.** Browsers pause GPS when the screen is locked, so the app keeps the
  screen awake while navigating (Wake Lock API). True background tracking needs a native
  shell: wrap this code with **Capacitor** and add a background-geolocation plugin. That
  is the natural next step if you want to publish to the App Store or Play Store.
- Elevation profiles and climb-aware routing (BRouter or GraphHopper provide these)
- Download a region's tiles for fully offline trips
- Import GPX/KML routes and follow them with off-trail alerts
- Trail conditions, photos and difficulty filters
