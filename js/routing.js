// Routing via the public FOSSGIS OSRM servers (OpenStreetMap data), which
// offer dedicated bicycle and foot profiles and full turn-by-turn steps.
// See https://routing.openstreetmap.de/about.html for usage policy.

import { cumulativeDistances, nearestVertex } from './geo.js';
import { instructionText, instructionIcon } from './instructions.js';

export const PROFILES = {
  bike: { url: 'https://routing.openstreetmap.de/routed-bike', speed: 4.5 },  // ~16 km/h fallback
  hike: { url: 'https://routing.openstreetmap.de/routed-foot', speed: 1.3 },  // ~4.7 km/h fallback
};

export function buildRouteUrl(mode, waypoints, { alternatives = true } = {}) {
  const profile = PROFILES[mode] || PROFILES.bike;
  const coords = waypoints.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
    alternatives: alternatives && waypoints.length === 2 ? 'true' : 'false',
  });
  return `${profile.url}/route/v1/driving/${coords}?${params}`;
}

export async function fetchRoutes(mode, waypoints, { signal, alternatives = true } = {}) {
  const res = await fetch(buildRouteUrl(mode, waypoints, { alternatives }), { signal });
  if (!res.ok) throw new Error(`Routing server error (${res.status})`);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes?.length) {
    throw new Error(json.message || 'No route found between these points');
  }
  return json.routes.map((r) => parseRoute(r, mode));
}

/** Normalise an OSRM route into what the navigation engine needs. */
export function parseRoute(osrmRoute, mode = 'bike') {
  const coords = osrmRoute.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const cum = cumulativeDistances(coords);
  const rawSteps = osrmRoute.legs.flatMap((leg, li) =>
    // Drop intermediate "arrive" steps (via points) except on the final leg.
    leg.steps.filter((s) => s.maneuver.type !== 'arrive' || li === osrmRoute.legs.length - 1)
  );

  const steps = [];
  let searchFrom = 0;
  rawSteps.forEach((s, i) => {
    const [lng, lat] = s.maneuver.location;
    const loc = { lat, lng };
    const vi = nearestVertex(loc, coords, searchFrom);
    searchFrom = vi;
    steps.push({
      text: instructionText(s, { isLast: i === rawSteps.length - 1 }),
      icon: instructionIcon(s),
      type: s.maneuver.type,
      modifier: s.maneuver.modifier,
      name: s.name || '',
      location: loc,
      along: cum[vi],
      distance: s.distance, // length of the step *after* this maneuver
    });
  });

  const distance = osrmRoute.distance ?? cum[cum.length - 1];
  return {
    mode,
    coords,
    cum,
    steps,
    distance,
    duration: osrmRoute.duration ?? distance / (PROFILES[mode]?.speed || 4),
  };
}
