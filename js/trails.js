// Find signed hiking / cycling / MTB trails from OpenStreetMap via Overpass.

import { polylineLength, snapToPolyline, cumulativeDistances } from './geo.js';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export const TRAIL_TYPES = {
  hike: ['hiking', 'foot', 'walking'],
  bike: ['bicycle', 'mtb'],
};

export function buildTrailQuery(bounds, mode) {
  const types = (mode === 'all' ? [...TRAIL_TYPES.hike, ...TRAIL_TYPES.bike] : TRAIL_TYPES[mode] || TRAIL_TYPES.bike).join('|');
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].map((n) => n.toFixed(5)).join(',');
  return `[out:json][timeout:25];relation["type"="route"]["route"~"^(${types})$"](${bbox});out tags geom(${bbox}) 60;`;
}

export async function fetchTrails(bounds, mode, { signal } = {}) {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: buildTrailQuery(bounds, mode) }),
    signal,
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'Trail server busy, try again shortly' : `Trail server error (${res.status})`);
  const json = await res.json();
  return parseTrails(json);
}

export function parseTrails(json) {
  const trails = [];
  for (const el of json.elements || []) {
    if (el.type !== 'relation') continue;
    const lines = (el.members || [])
      .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length > 1)
      .map((m) => m.geometry.filter(Boolean).map((g) => ({ lat: g.lat, lng: g.lon })));
    if (!lines.length) continue;
    const t = el.tags || {};
    trails.push({
      id: el.id,
      name: t.name || t.ref || t['name:en'] || `Unnamed ${t.route} route`,
      ref: t.ref || '',
      route: t.route,
      network: t.network || '',
      distanceTag: t.distance ? parseFloat(t.distance) * 1000 : null, // OSM "distance" is km
      difficulty: t['mtb:scale'] || t.sac_scale || t.difficulty || '',
      colour: t.colour || null,
      description: t.description || '',
      website: t.website || t.url || '',
      lines,
      visibleLength: lines.reduce((s, l) => s + polylineLength(l), 0),
    });
  }
  // Longer / better-known trails first.
  trails.sort((a, b) => (b.network === 'iwn' || b.network === 'icn') - (a.network === 'iwn' || a.network === 'icn') || b.visibleLength - a.visibleLength);
  return trails;
}

/** Closest point of a trail to p, so we can route the user onto it. */
export function nearestPointOnTrail(p, trail) {
  let best = null;
  for (const line of trail.lines) {
    const s = snapToPolyline(p, line, cumulativeDistances(line));
    if (!best || s.distance < best.distance) best = s;
  }
  return best;
}

export const ROUTE_LABEL = {
  hiking: 'Hiking', foot: 'Walking', walking: 'Walking', bicycle: 'Cycling', mtb: 'MTB',
};
