// Drawing trails by hand. A stroke is built from finger samples; a sample can be
// snapped to a nearby line on the map, and consecutive samples snapped to the same
// line follow that line's shape between them instead of cutting the corner.
// Pure geometry: the app does the hit-testing against the map.

import { cumulativeDistances, snapToPolyline, haversine, pointAlong, closestOnSegment } from './geo.js';
import { slicePolyline } from './trailroute.js';

/** Snap p to the nearest of `lines` ([{key, coords}]) within maxDist metres, or null. */
export function snapToLines(p, lines, maxDist) {
  let best = null;
  for (const line of lines) {
    if (line.coords.length < 2) continue;
    const cum = cumulativeDistances(line.coords);
    const s = snapToPolyline(p, line.coords, cum);
    if (s.distance <= maxDist && (!best || s.distance < best.distance)) best = { ...s, key: line.key, coords: line.coords, cum };
  }
  return best;
}

/**
 * Samples [{p: {lat,lng}, snap: result of snapToLines or null}] → stroke coords.
 * Between two samples snapped to the same line, the line's own vertices are used.
 */
export function assembleStroke(samples) {
  const out = [];
  samples.forEach((s, i) => {
    const prev = samples[i - 1];
    if (prev?.snap && s.snap && prev.snap.key === s.snap.key) {
      out.push(...slicePolyline(s.snap.coords, s.snap.cum, prev.snap.along, s.snap.along).slice(1));
    } else {
      out.push(s.snap ? s.snap.point : s.p);
    }
  });
  return dedupe(out);
}

function dedupe(coords, min = 0.5) {
  const out = [];
  for (const p of coords) if (!out.length || haversine(out[out.length - 1], p) > min) out.push(p);
  return out;
}

/** Extra points so no two neighbours are more than `step` metres apart (for erasing). */
export function densify(coords, step = 4) {
  if (coords.length < 2) return coords.slice();
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1];
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const n = Math.floor((cum[i] - cum[i - 1]) / step);
    for (let k = 1; k <= n; k++) {
      const d = cum[i - 1] + ((cum[i] - cum[i - 1]) * k) / (n + 1);
      if (d < total) out.push(pointAlong(coords, cum, d));
    }
    out.push(coords[i]);
  }
  return out;
}

/** Remove every point within `radius` metres of `center`; strokes split where cut. */
export function eraseAt(strokes, center, radius) {
  const out = [];
  for (const stroke of strokes) {
    let run = [];
    for (const p of stroke) {
      if (haversine(p, center) <= radius) {
        if (run.length > 1) out.push(run);
        run = [];
      } else run.push(p);
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

/** Fewer points, same shape (within `tolerance` metres). */
export function simplify(coords, tolerance = 1.5) {
  if (coords.length < 3) return coords.slice();
  const keep = new Array(coords.length).fill(false);
  keep[0] = keep[coords.length - 1] = true;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let idx = -1, max = 0;
    for (let i = a + 1; i < b; i++) {
      const d = closestOnSegment(coords[i], coords[a], coords[b]).distance;
      if (d > max) { max = d; idx = i; }
    }
    if (max > tolerance) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
  return coords.filter((_, i) => keep[i]);
}

export const strokeLength = (coords) => cumulativeDistances(coords).at(-1) || 0;
