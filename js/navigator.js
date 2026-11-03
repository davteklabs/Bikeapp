// Turn-by-turn navigation engine. Pure logic, no DOM: feed it GPS fixes via
// update() and it tells you where you are on the route, the next maneuver,
// what to announce, and whether you've gone off-route or arrived.

import { snapToPolyline, haversine, bearing, pointAlong } from './geo.js';
import { spokenDistance } from './format.js';

const MODE_CONFIG = {
  // Distances (m) before a maneuver at which a voice prompt is given: a heads-up, then the
  // turn itself (bike 100 ft and 40 ft, hike 50 ft and 20 ft). Going fast moves each one
  // earlier so it still comes at least `lead` seconds before the turn.
  // `reassure`: after a turn, say how far to the next one if it's further than this.
  bike: { prompts: [30, 12], lead: [5, 2], reassure: 800, offRoute: 35, arrive: 25 },
  hike: { prompts: [15, 6], lead: [5, 2], reassure: 300, offRoute: 30, arrive: 15 },
};

export class Navigator {
  /**
   * @param route  output of parseRoute()
   * @param opts   {mode, units, offRouteFixes}
   */
  constructor(route, { mode = route.mode || 'bike', units = 'metric', offRouteFixes = 3 } = {}) {
    this.route = route;
    this.mode = mode;
    this.units = units;
    this.cfg = MODE_CONFIG[mode] || MODE_CONFIG.bike;
    this.offRouteFixes = offRouteFixes;
    this.total = route.cum[route.cum.length - 1] || route.distance;
    this.segment = 0;
    this.along = 0;
    this.badFixes = 0;
    this.announced = new Set(); // `${stepIndex}:${threshold}`
    this.arrived = false;
    this.speedEma = null;
    this.lastStepIndex = -1;
    // Average speed implied by the router, used until we measure real speed.
    this.routeSpeed = route.duration > 0 ? route.distance / route.duration : 4;
  }

  /** Steps index of the next maneuver ahead of `along`. */
  nextStepIndex(along) {
    const steps = this.route.steps;
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].along > along + 3) return i;
    }
    return steps.length - 1;
  }

  update(fix) {
    const p = { lat: fix.lat, lng: fix.lng };
    const { coords, cum, steps } = this.route;
    const accuracy = Math.min(fix.accuracy ?? 10, 100);
    const threshold = Math.max(this.cfg.offRoute, accuracy * 1.5);

    // Search near where we were last; widen to the full route if that fails.
    let snap = snapToPolyline(p, coords, cum, this.segment - 5, this.segment + 400);
    if (snap.distance > threshold) {
      const global = snapToPolyline(p, coords, cum);
      if (global.distance < snap.distance) snap = global;
    }

    const onRoute = snap.distance <= threshold;
    if (onRoute) {
      this.badFixes = 0;
      // Don't let GPS jitter drag progress backwards by more than a little.
      if (snap.along >= this.along - 30 || snap.distance < 10) {
        this.segment = snap.segment;
        this.along = snap.along;
      }
    } else {
      this.badFixes++;
    }
    const offRoute = this.badFixes >= this.offRouteFixes;

    if (fix.speed != null && fix.speed >= 0) {
      this.speedEma = this.speedEma == null ? fix.speed : this.speedEma * 0.8 + fix.speed * 0.2;
    }

    const remaining = Math.max(0, this.total - this.along);
    const distToEnd = haversine(p, coords[coords.length - 1]);
    if (!this.arrived && (remaining < this.cfg.arrive || (distToEnd < this.cfg.arrive && remaining < 200))) {
      this.arrived = true;
    }

    const stepIndex = this.nextStepIndex(this.along);
    const step = steps[stepIndex];
    const distToManeuver = Math.max(0, step.along - this.along);
    const speed = this.speedEma != null && this.speedEma > 0.7 ? this.speedEma : this.routeSpeed;
    const remainingTime = remaining / speed;

    const announcements = this.arrived ? this.arrivalAnnouncement() : offRoute ? [] : this.announce(stepIndex, distToManeuver, speed);
    this.lastStepIndex = stepIndex;

    // Direction of travel along the route, looking a little ahead so the map
    // turns smoothly into corners instead of following GPS jitter.
    const here = pointAlong(coords, cum, this.along);
    const ahead = pointAlong(coords, cum, this.along + 30);
    const heading = haversine(here, ahead) > 3 ? bearing(here, ahead) : null;

    return {
      position: p,
      snapped: snap.point,
      distanceFromRoute: snap.distance,
      onRoute,
      offRoute,
      along: this.along,
      remaining,
      remainingTime,
      eta: new Date((fix.timestamp ?? Date.now()) + remainingTime * 1000),
      stepIndex,
      step,
      followingStep: steps[stepIndex + 1] || null,
      distToManeuver,
      heading,
      speed: fix.speed ?? null,
      arrived: this.arrived,
      announcements,
    };
  }

  announce(stepIndex, dist, speed) {
    const steps = this.route.steps;
    const step = steps[stepIndex];
    const { lead, reassure } = this.cfg;
    const prompts = this.cfg.prompts.map((d, t) => Math.max(d, speed * lead[t]));
    const gap = step.along - (steps[stepIndex - 1]?.along ?? 0);
    const out = [];

    // Just completed a maneuver and the next one is far away: reassure.
    if (stepIndex !== this.lastStepIndex && this.lastStepIndex !== -1 && dist > reassure) {
      out.push(`Continue for ${spokenDistance(dist, this.units)}`);
    }

    for (let t = 0; t < prompts.length; t++) {
      const key = `${stepIndex}:${t}`;
      if (this.announced.has(key) || dist > prompts[t]) continue;
      // Mark this and all larger thresholds so we never speak a burst.
      for (let u = 0; u <= t; u++) this.announced.add(`${stepIndex}:${u}`);
      const isFinal = t === prompts.length - 1;
      // Skip the early prompt for short steps where it would be confusing.
      if (!isFinal && t === 0 && gap < prompts[0] * 1.5) break;
      const text = step.type === 'arrive' ? 'your destination is ahead' : lowerFirst(step.text);
      out.push(isFinal ? capitalise(step.type === 'arrive' ? 'You are arriving at your destination' : step.text)
                       : `In ${spokenDistance(dist, this.units)}, ${text}`);
      break;
    }
    return out;
  }

  arrivalAnnouncement() {
    if (this.announced.has('arrived')) return [];
    this.announced.add('arrived');
    return ['You have arrived at your destination'];
  }
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
