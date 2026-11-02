import test from 'node:test';
import assert from 'node:assert/strict';
import { haversine, bearing, closestOnSegment, cumulativeDistances, snapToPolyline, angleDiff, pointAlong, destination } from '../js/geo.js';

test('haversine: 1 degree of latitude ≈ 111.2 km', () => {
  const d = haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(d - 111195) < 50, d);
});

test('bearing: cardinal directions', () => {
  const o = { lat: 47, lng: 8 };
  assert.ok(Math.abs(bearing(o, { lat: 48, lng: 8 }) - 0) < 0.01);
  assert.ok(Math.abs(bearing(o, { lat: 47, lng: 9 }) - 90) < 0.5);
  assert.ok(Math.abs(bearing(o, { lat: 46, lng: 8 }) - 180) < 0.01);
});

test('closestOnSegment: perpendicular projection and clamping', () => {
  const a = { lat: 47, lng: 8 }, b = { lat: 47, lng: 8.01 };
  const mid = closestOnSegment({ lat: 47.0005, lng: 8.005 }, a, b);
  assert.ok(Math.abs(mid.t - 0.5) < 0.01);
  assert.ok(Math.abs(mid.distance - 55.6) < 1, mid.distance);
  const before = closestOnSegment({ lat: 47, lng: 7.99 }, a, b);
  assert.equal(before.t, 0);
});

test('snapToPolyline: along-distance accumulates over segments', () => {
  const coords = [{ lat: 47, lng: 8 }, { lat: 47, lng: 8.01 }, { lat: 47.01, lng: 8.01 }];
  const cum = cumulativeDistances(coords);
  const s = snapToPolyline({ lat: 47.005, lng: 8.0101 }, coords, cum);
  assert.equal(s.segment, 1);
  assert.ok(Math.abs(s.along - (cum[1] + 556)) < 3, s.along);
  assert.ok(s.distance < 10);
});

test('angleDiff wraps around north', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
});

test('pointAlong interpolates and clamps', () => {
  const coords = [{ lat: 47, lng: 8 }, { lat: 47, lng: 8.01 }, { lat: 47.01, lng: 8.01 }];
  const cum = cumulativeDistances(coords);
  const p = pointAlong(coords, cum, cum[1] + 556);
  assert.ok(haversine(p, { lat: 47.005, lng: 8.01 }) < 3, JSON.stringify(p));
  assert.deepEqual(pointAlong(coords, cum, -5), coords[0]);
  assert.deepEqual(pointAlong(coords, cum, 1e9), coords[2]);
});

test('destination moves the given distance on the given bearing', () => {
  const o = { lat: 38.75, lng: -121.17 };
  const p = destination(o, 90, 1000);
  assert.ok(Math.abs(haversine(o, p) - 1000) < 0.5);
  assert.ok(Math.abs(bearing(o, p) - 90) < 0.1);
});
