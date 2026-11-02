// Synthetic OSRM response: head east ~500 m along "River Path", turn left
// onto "Ridge Trail" and go north ~300 m, then arrive.
export const START = { lat: 38.75, lng: -121.17 };       // Granite Bay, CA
export const CORNER = { lat: 38.75, lng: -121.164241 }; // ~500 m east
export const END = { lat: 38.7527, lng: -121.164241 };   // ~300 m north of corner

function interp(a, b, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push([a.lng + (b.lng - a.lng) * (i / n), a.lat + (b.lat - a.lat) * (i / n)]);
  return out;
}

export function osrmResponse() {
  const leg1 = interp(START, CORNER, 10);
  const leg2 = interp(CORNER, END, 6);
  const coordinates = [...leg1, ...leg2.slice(1)];
  return {
    code: 'Ok',
    routes: [{
      distance: 800,
      duration: 180,
      geometry: { type: 'LineString', coordinates },
      legs: [{
        distance: 800,
        duration: 180,
        steps: [
          { name: 'River Path', distance: 500, duration: 110,
            maneuver: { type: 'depart', location: [START.lng, START.lat], bearing_after: 90 } },
          { name: 'Ridge Trail', distance: 300, duration: 70,
            maneuver: { type: 'turn', modifier: 'left', location: [CORNER.lng, CORNER.lat], bearing_after: 0 } },
          { name: 'Ridge Trail', distance: 0, duration: 0,
            maneuver: { type: 'arrive', location: [END.lng, END.lat] } },
        ],
      }],
    }],
  };
}

/** A routing answer that is just a straight line between two [lng, lat] points. */
export function straightRoute(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const d = 2 * R * Math.asin(Math.sqrt(Math.sin(((b[1] - a[1]) * r) / 2) ** 2
    + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2));
  const brg = (Math.atan2(Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r),
    Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r)) / r + 360) % 360;
  return {
    code: 'Ok',
    routes: [{
      distance: d, duration: d / 4,
      geometry: { type: 'LineString', coordinates: [a, b] },
      legs: [{ distance: d, duration: d / 4, steps: [
        { name: '', distance: d, duration: d / 4, maneuver: { type: 'depart', location: a, bearing_after: brg } },
        { name: '', distance: 0, duration: 0, maneuver: { type: 'arrive', location: b } },
      ] }],
    }],
  };
}

/** Shipped trail-segment tile: "Ridge Trail" in two pieces from CORNER to END, plus an unnamed track. */
export function segmentTile() {
  const mid = { lat: (CORNER.lat + END.lat) / 2, lng: CORNER.lng };
  return {
    v: 1,
    ways: [
      [1001, 'Ridge Trail', 'p', [[CORNER.lng, CORNER.lat], [mid.lng, mid.lat]]],
      [1002, 'Ridge Trail', 'p', [[mid.lng, mid.lat], [END.lng, END.lat]]],
      [1003, null, 't', [[START.lng, START.lat - 0.002], [START.lng + 0.003, START.lat - 0.002]]],
    ],
  };
}

export function overpassResponse() {
  return {
    elements: [{
      type: 'relation', id: 123,
      tags: { type: 'route', route: 'hiking', name: 'Panorama Loop', ref: 'P1', network: 'lwn', distance: '7.5', sac_scale: 'hiking' },
      members: [
        { type: 'way', ref: 1, role: '', geometry: [{ lat: 38.751, lon: -121.169 }, { lat: 38.752, lon: -121.168 }] },
        { type: 'way', ref: 2, role: '', geometry: [{ lat: 38.752, lon: -121.168 }, { lat: 38.753, lon: -121.166 }] },
        { type: 'node', ref: 3, role: 'guidepost', lat: 38.751, lon: -121.169 },
      ],
    }],
  };
}
