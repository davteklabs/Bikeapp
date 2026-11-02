// Synthetic OSRM response: head east ~500 m along "River Path", turn left
// onto "Ridge Trail" and go north ~300 m, then arrive.
export const START = { lat: 47.0, lng: 8.0 };
export const CORNER = { lat: 47.0, lng: 8.00658 };   // ~500 m east
export const END = { lat: 47.0027, lng: 8.00658 };    // ~300 m north of corner

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

export function overpassResponse() {
  return {
    elements: [{
      type: 'relation', id: 123,
      tags: { type: 'route', route: 'hiking', name: 'Panorama Loop', ref: 'P1', network: 'lwn', distance: '7.5', sac_scale: 'hiking' },
      members: [
        { type: 'way', ref: 1, role: '', geometry: [{ lat: 47.001, lon: 8.001 }, { lat: 47.002, lon: 8.002 }] },
        { type: 'way', ref: 2, role: '', geometry: [{ lat: 47.002, lon: 8.002 }, { lat: 47.003, lon: 8.004 }] },
        { type: 'node', ref: 3, role: 'guidepost', lat: 47.001, lon: 8.001 },
      ],
    }],
  };
}
