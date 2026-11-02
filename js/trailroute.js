// Turns trail segments picked in order into one continuous, navigable route:
// from the start to the closest point of trail #1, along each trail in turn, to
// the end. Trail #1 is ridden toward where trail #2 joins it, so the order picked
// sets the direction. Pure logic; the app supplies any road/path links (from the
// router) between the start, the trails and the end.

import { cumulativeDistances, snapToPolyline, pointAlong, haversine, bearing, angleDiff } from './geo.js';
import { instructionText, instructionIcon } from './instructions.js';

/** Typical moving speeds on trails (m/s): about 7 mph riding, 2.7 mph hiking. */
export const TRAIL_SPEED = { bike: 3.1, hike: 1.2 };
/** Pieces closer than this (m) are treated as joined; further apart needs a link. */
export const JOIN_GAP = 25;

/** The part of a polyline between two along-distances, reversed when `to` < `from`. */
export function slicePolyline(coords, cum, from, to) {
  const [a, b] = to >= from ? [from, to] : [to, from];
  const pts = [pointAlong(coords, cum, a)];
  for (let i = 0; i < coords.length; i++) if (cum[i] > a && cum[i] < b) pts.push(coords[i]);
  pts.push(pointAlong(coords, cum, b));
  return to >= from ? pts : pts.reverse();
}

/** Along-distance on `seg` of its vertex nearest to `other`: where the two trails meet. */
function joinAlong(seg, cum, other) {
  const ocum = cumulativeDistances(other.coords);
  let best = 0, bestD = Infinity;
  seg.coords.forEach((p, i) => {
    const d = snapToPolyline(p, other.coords, ocum).distance;
    if (d < bestD) { bestD = d; best = cum[i]; }
  });
  return best;
}

/**
 * Which part of each segment to travel, and in which direction.
 * @param start  {lat,lng}
 * @param segs   [{id, name, coords}] in the order picked
 * @param end    {lat,lng} or null to finish at the far end of the last trail
 * @returns {pieces: [{seg, coords, gapBefore}], gapAfter}
 */
export function planPieces(start, segs, end = null) {
  const pieces = [];
  let here = start;
  segs.forEach((seg, k) => {
    const cum = cumulativeDistances(seg.coords);
    const total = cum[cum.length - 1];
    const entry = snapToPolyline(here, seg.coords, cum).along;
    let exit;
    if (k < segs.length - 1) exit = joinAlong(seg, cum, segs[k + 1]);
    else if (end) exit = snapToPolyline(end, seg.coords, cum).along;
    else exit = entry < total / 2 ? total : 0; // the far end
    const coords = slicePolyline(seg.coords, cum, entry, exit);
    pieces.push({ seg, coords, gapBefore: haversine(here, coords[0]) });
    here = coords[coords.length - 1];
  });
  return { pieces, gapAfter: end ? haversine(here, end) : 0 };
}

/**
 * Order a named trail's segments into a chain, starting from the one nearest
 * `start` and heading toward its far end.
 */
export function chainSegments(segs, start) {
  const left = [...segs];
  const first = (s) => s.coords[0], last = (s) => s.coords[s.coords.length - 1];
  const nearest = (p) => left.reduce((bi, s, i) => {
    const d = snapToPolyline(p, s.coords, cumulativeDistances(s.coords)).distance;
    return d < bi.d ? { i, d } : bi;
  }, { i: -1, d: Infinity });
  if (!left.length) return [];
  const out = [left.splice(nearest(start).i, 1)[0]];
  let tip = haversine(start, first(out[0])) > haversine(start, last(out[0])) ? first(out[0]) : last(out[0]);
  while (left.length) {
    let bi = -1, bd = Infinity;
    left.forEach((s, i) => {
      const d = Math.min(haversine(tip, first(s)), haversine(tip, last(s)));
      if (d < bd) { bd = d; bi = i; }
    });
    if (bd > 60) break; // not connected to the end of the chain
    const s = left.splice(bi, 1)[0];
    tip = haversine(tip, first(s)) < haversine(tip, last(s)) ? last(s) : first(s);
    out.push(s);
  }
  return out;
}

function headingAt(coords, cum, from, len) {
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(from, total)), b = Math.max(0, Math.min(from + len, total));
  if (Math.abs(b - a) < 1) return null;
  return bearing(pointAlong(coords, cum, Math.min(a, b)), pointAlong(coords, cum, Math.max(a, b)));
}

function modifierFor(diff) {
  const a = Math.abs(diff), side = diff < 0 ? 'left' : 'right';
  if (a < 25) return 'straight';
  if (a < 60) return `slight ${side}`;
  if (a < 125) return side;
  if (a < 165) return `sharp ${side}`;
  return 'uturn';
}

/**
 * Join legs into one route the Navigator can follow.
 * @param legs  [{coords, name, steps?}]: trail pieces and links, in travel order.
 *              `steps` are a link's own turns (from the router), along-distances
 *              relative to that leg; their depart/arrive are ignored.
 * @param endLabel  text for the arrival instruction
 */
export function assembleRoute(mode, legs, endLabel = 'Arrive at your destination') {
  const coords = [], steps = [];
  const legStart = [];
  for (const leg of legs) {
    const pts = leg.coords.filter(Boolean);
    if (!pts.length) continue;
    // Where legs share an end point, this leg starts at the point already added.
    const prev = coords[coords.length - 1];
    legStart.push({ leg, index: prev && haversine(prev, pts[0]) <= 0.5 ? coords.length - 1 : coords.length });
    for (const p of pts) {
      const prev = coords[coords.length - 1];
      if (!prev || haversine(prev, p) > 0.5) coords.push(p);
    }
  }
  const cum = cumulativeDistances(coords);
  const alongAt = (i) => cum[Math.min(i, cum.length - 1)];

  const add = (along, maneuver, name) => {
    const step = { maneuver, name };
    steps.push({
      text: instructionText(step), icon: instructionIcon(step), type: maneuver.type, modifier: maneuver.modifier,
      name: name || '', location: pointAlong(coords, cum, along), along, distance: 0,
    });
  };

  // A link's road or path name comes from the router's first step.
  const nameOf = (leg) => leg.name || leg.steps?.[0]?.name || '';
  legStart.forEach(({ leg, index }, k) => {
    const at = alongAt(index);
    const out = headingAt(coords, cum, at, 20);
    if (k === 0) {
      add(0, { type: 'depart', bearing_after: out }, nameOf(leg));
    } else {
      const into = headingAt(coords, cum, at - 20, 20);
      if (into != null && out != null) {
        const mod = modifierFor(angleDiff(into, out));
        // Straight on along the same trail needs no instruction.
        if (!(mod === 'straight' && nameOf(leg) === nameOf(legStart[k - 1].leg))) {
          add(at, { type: mod === 'straight' ? 'new name' : 'turn', modifier: mod }, nameOf(leg));
        }
      }
    }
    for (const s of (leg.steps || []).slice(1)) {
      if (s.type === 'arrive') continue;
      add(at + s.along, { type: s.type, modifier: s.modifier }, s.name);
    }
  });
  const total = cum[cum.length - 1] || 0;
  steps.push({ text: endLabel, icon: { kind: 'arrive', angle: 0 }, type: 'arrive', name: '', location: coords[coords.length - 1], along: total, distance: 0 });
  steps.sort((a, b) => a.along - b.along);
  steps.forEach((s, i) => { s.distance = (steps[i + 1]?.along ?? total) - s.along; });

  return { mode, coords, cum, steps, distance: total, duration: total / (TRAIL_SPEED[mode] || TRAIL_SPEED.bike) };
}
