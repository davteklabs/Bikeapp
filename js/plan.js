// The user's route plan: trail segments picked on the map (press and hold a trail),
// in the order they were added. Each entry keeps its geometry so the plan survives
// a reload even before the map tiles it came from are loaded again.

import { polylineLength, pointAlong, cumulativeDistances } from './geo.js';

/** Add the segment if it isn't in the plan, remove it if it is. Returns a new plan. */
export function togglePlanned(plan, seg) {
  if (plan.some((s) => s.id === seg.id)) return plan.filter((s) => s.id !== seg.id);
  return [...plan, { id: seg.id, name: seg.name, kind: seg.kind, coords: seg.coords, private: !!seg.private }];
}

export const planIndex = (plan, id) => plan.findIndex((s) => s.id === id);

export const planLength = (plan) => plan.reduce((d, s) => d + polylineLength(s.coords), 0);

/** Halfway along a segment, where its order number is shown. */
export function midpoint(seg) {
  const cum = cumulativeDistances(seg.coords);
  return pointAlong(seg.coords, cum, cum[cum.length - 1] / 2);
}
