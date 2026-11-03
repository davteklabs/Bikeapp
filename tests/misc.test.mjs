import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDistance, formatDuration, spokenDistance, formatSpeed } from '../js/format.js';
import { TrackRecorder } from '../js/recorder.js';
import { parseTrails, buildTrailQuery, nearestPointOnTrail } from '../js/trails.js';
import { overpassResponse } from './fixtures.mjs';

test('formatting', () => {
  assert.equal(formatDistance(42), '40 m');
  assert.equal(formatDistance(1530), '1.5 km');
  assert.equal(formatDistance(1609.344 * 3, 'imperial'), '3.0 mi');
  assert.equal(formatDistance(100, 'imperial'), '330 ft');
  assert.equal(formatDuration(3720), '1 h 02 min');
  assert.equal(spokenDistance(120), '100 metres');
  assert.equal(spokenDistance(30, 'imperial'), '100 feet');
  assert.equal(spokenDistance(12, 'imperial'), '40 feet');
  assert.equal(spokenDistance(1, 'imperial'), '10 feet');
  assert.equal(spokenDistance(100, 'imperial'), '350 feet');
  assert.equal(formatSpeed(5), '18.0 km/h');
});

test('recorder measures distance, filters jitter, exports GPX', () => {
  const r = new TrackRecorder();
  const t0 = Date.parse('2026-06-01T10:00:00Z');
  r.add({ lat: 47, lng: 8, altitude: 500, timestamp: t0, accuracy: 5 });
  assert.equal(r.add({ lat: 47.00001, lng: 8, altitude: 500, timestamp: t0 + 1000, accuracy: 5 }), false); // ~1 m jitter
  r.add({ lat: 47.001, lng: 8, altitude: 510, timestamp: t0 + 30000, accuracy: 5 });
  assert.equal(r.add({ lat: 47.01, lng: 8, timestamp: t0 + 31000, accuracy: 200 }), false); // inaccurate
  assert.ok(Math.abs(r.distance - 111) < 2);
  assert.equal(r.elevationGain, 10);
  const gpx = r.toGPX('Test <ride>');
  assert.match(gpx, /<gpx version="1.1"/);
  assert.match(gpx, /Test &lt;ride&gt;/);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 2);
});

test('trails: query + parse Overpass relations', () => {
  const q = buildTrailQuery({ south: 47, west: 8, north: 47.1, east: 8.1 }, 'hike');
  assert.match(q, /route"~"\^\(hiking\|foot\|walking\)\$"/);
  assert.match(q, /\(47\.00000,8\.00000,47\.10000,8\.10000\)/);
  const [t] = parseTrails(overpassResponse());
  assert.equal(t.name, 'Panorama Loop');
  assert.equal(t.lines.length, 2);
  assert.equal(t.distanceTag, 7500);
  const near = nearestPointOnTrail({ lat: 38.7531, lng: -121.1659 }, t);
  assert.ok(near.distance < 20, near.distance);
});
