// Pure geometry helpers. Points are {lat, lng} in degrees, distances in metres.

const R = 6371008.8; // mean Earth radius (m)
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from north (0..360). */
export function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Closest point on segment a-b to p, using a local equirectangular projection
 * (accurate to well under a metre for segments of a few km).
 * Returns {point, t (0..1 along segment), distance}.
 */
export function closestOnSegment(p, a, b) {
  const kx = Math.cos(toRad(p.lat)) * R * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return {
    point: { lat: p.lat + cy / ky, lng: p.lng + cx / kx },
    t,
    distance: Math.hypot(cx, cy),
  };
}

/** Cumulative distance array for a polyline (same length as coords). */
export function cumulativeDistances(coords) {
  const out = new Array(coords.length);
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    out[i] = acc;
  }
  return out;
}

export function polylineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

/**
 * Snap p onto a polyline. Optionally restrict the search to segments
 * [from, to) to keep it cheap and prevent jumping to a parallel part of a loop.
 * Returns {segment, point, distance, along} where `along` is metres from start.
 */
export function snapToPolyline(p, coords, cum, from = 0, to = coords.length - 1) {
  from = Math.max(0, from);
  to = Math.min(coords.length - 1, to);
  let best = null;
  for (let i = from; i < to; i++) {
    const c = closestOnSegment(p, coords[i], coords[i + 1]);
    if (!best || c.distance < best.distance) {
      const segLen = cum[i + 1] - cum[i];
      best = { segment: i, point: c.point, distance: c.distance, along: cum[i] + c.t * segLen };
    }
  }
  if (!best && coords.length) {
    best = { segment: 0, point: coords[0], distance: haversine(p, coords[0]), along: 0 };
  }
  return best;
}

/** Index of the polyline vertex closest to p, searching from `start`. */
export function nearestVertex(p, coords, start = 0) {
  let bestI = start, bestD = Infinity;
  for (let i = start; i < coords.length; i++) {
    const d = haversine(p, coords[i]);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}

/** Signed smallest difference between two bearings, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = ((b - a) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}
