# TrailNav — bike & hike navigation

Turn-by-turn trail navigation: open trail maps, phone GPS, and live voice turn-by-turn
directions for **cycling** and **hiking**. It's a Progressive Web App (PWA). It runs in any
modern phone browser, you can install it to the home screen, and it needs no app store,
accounts, or API keys.

## Features

| | |
|---|---|
| 🗺️ **Trail maps** | California only, opening at Granite Bay. Base maps (faded so trails stand out): OpenStreetMap (bike), OpenTopoMap (hike, with contours), CyclOSM. Every path, track, footway, bridleway, bike path, steps and dirt road in California is drawn on top from data shipped with the app; ones with no public access are dashed. Optional Waymarked Trails overlays for signed routes. |
| 🟢 **Trail difficulty & names** | Tap a trail to highlight it and get directions to it (a long trail is highlighted for about 20 miles each way from where you tap). Segments are green, blue or black only when someone has actually rated them; everything else is grey (not rated). Most trails have no name in OpenStreetMap, so they can be named in the app (⚙ in the trail panel). Default ratings and names ship in `data/trail-info.json`; users can change them on their own device and export them in the same format. |
| 🟣 **Plan route** | Two modes: **Explore** (tap a trail for its info, rating and name) and **Plan route** (tap trails in the order you'll take them). You join trail #1 at its closest point to your start (GPS or a dropped pin), and #1 is ridden toward where #2 joins it, so the order sets the direction. Finish at the end of the last trail, back at the start (loop), or at a pin. The plan is built into one route with turn instructions where trails meet and trail-speed time estimates (about 7 mph riding, 2.7 mph hiking). Press and hold a trail in either mode to add/remove it. **Simulate** rides the route on screen at 3× speed for testing away from the trail. |
| ✏️ **Draw a trail** | Pen button: drag to draw a trail. By default the line snaps to paths and roads already on the map and follows their curves; switch Snap off to draw freehand. Eraser, Undo, Move map, Cancel, Save. Saved trails work like any other (rate, name, plan, navigate) and are exported with ratings and names. |
| 💧 **Water** | Lakes and reservoirs with a wave texture, rivers, canals and creeks in blue, darker than the faded land so they stand out even without colour. |
| 🔎 **Search** | Find places, peaks, parks and trailheads (OpenStreetMap Nominatim). Tap anywhere on the map to drop a pin. |
| 🧭 **Routing** | Bike-specific and foot-specific routing on OSM paths and tracks, with alternative routes, a step list, reverse, and a custom start point. |
| 🗣️ **Live navigation** | Along a planned trail route, leaving the route tells you to head back to the trail (it never reroutes you off your trails); A-to-B directions reroute automatically. Tilted view that turns to face your direction of travel, with you low on the screen and the route ahead. Big next-turn banner with distance-to-turn, voice prompts timed per activity, "then…" hints for back-to-back turns, ETA, remaining distance and speed. The screen stays on. |
| ↩️ **Auto-reroute** | Detects when you leave the route (it takes GPS accuracy into account and needs several bad fixes in a row) and recalculates from where you are. |
| 🥾 **Trails nearby** | Lists signed trails in the current view with type, ref, length and difficulty. Tap one to highlight it, then get directions to its closest point. |
| ⏺️ **Track recording** | Records your ride or hike (auto-starts with navigation) with distance, time, moving speed and climb. Export as **GPX** for other fitness and mapping apps. |
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
js/segments.js             Loads shipped trail-segment tiles (data/trails/) by map view or trail name
js/trail-info.js           Ratings and names: shipped defaults + the user's own edits, export
js/plan.js                 Route plan: trail segments picked, in order
js/trailroute.js           Builds a planned route along the picked trails: entry point, direction, turns
js/draw.js                 Drawing trails: snapping to map lines, following their shape, erasing, simplifying
scripts/build-trails.mjs   Builds data/trails/ from an OpenStreetMap extract file (see below)
scripts/osm-pbf.mjs        Reads .osm.pbf extract files
js/search.js               Nominatim search (rate-limited to 1 request/second)
js/recorder.js             Track recording + GPX export
js/geo.js, js/format.js    Geometry and unit formatting
sw.js                      Offline app shell + tile cache
```

### Trail data and difficulty ratings

Trail segments are prebuilt, not fetched live, from the California OpenStreetMap extract
published by Geofabrik (about 1.3 GB, updated daily). To refresh them:

```bash
curl -L -o logs/geofabrik/california.osm.pbf https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
node scripts/build-trails.mjs logs/geofabrik/california.osm.pbf
```

This takes about two minutes and replaces `data/trails/`: `index.json` and `tiles/*.json`
(0.05° tiles, about 16,000 files and 185 MB). The app loads the tiles in view, keeps at most
120 in memory, and the ones you've viewed stay cached for offline use. Each tile lists, for
each trail in it, the nearby tiles the trail continues into, so tapping a trail loads the
rest of it around that spot.

Ratings and names live in `data/trail-info.json`, keyed by OpenStreetMap way ID. To update the
defaults: rate and name trails in the app, then **Map & settings → Export ratings & names**, and
replace that file with the export (then re-run the build so the new names are searchable by
name). Never add a rating that hasn't been checked; unrated trails stay grey. Unnamed ways that
belong to a signed hiking/cycling route get the route's name at build time.

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
