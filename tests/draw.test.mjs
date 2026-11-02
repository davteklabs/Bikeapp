import test from 'node:test';
import assert from 'node:assert/strict';
import { snapToLines, assembleStroke, densify, eraseAt, simplify, strokeLength } from '../js/draw.js';
import { haversine, destination, snapToPolyline, cumulativeDistances } from '../js/geo.js';

const o = { lat: 38.75, lng: -121.17 };
// A curved path: a quarter circle of radius 200 m around o, from east to north.
const arc = Array.from({ length: 19 }, (_, i) => destination(o, 90 - i * 5, 200));
const line = { key: 'arc', coords: arc };

test('snapToLines snaps within range only', () => {
  const near = destination(arc[9], 45, 10); // 10 m outside the arc
  const s = snapToLines(near, [line], 20);
  assert.ok(s && Math.abs(s.distance - 10) < 1, s?.distance);
  assert.equal(snapToLines(destination(arc[9], 45, 40), [line], 20), null);
});

test('assembleStroke follows the snapped line between samples instead of cutting the corner', () => {
  // Two samples, at the start and end of the arc, both snapped to it.
  const a = destination(arc[0], 90, 5), b = destination(arc[18], 0, 5);
  const samples = [a, b].map((p) => ({ p, snap: snapToLines(p, [line], 20) }));
  const stroke = assembleStroke(samples);
  const len = strokeLength(stroke);
  assert.ok(Math.abs(len - (Math.PI / 2) * 200) < 5, `follows the curve: ${len} m`);
  // Every point lies on the arc.
  const cum = cumulativeDistances(arc);
  for (const p of stroke) assert.ok(snapToPolyline(p, arc, cum).distance < 1);
  // Without snapping it's just the straight line.
  const free = assembleStroke([a, b].map((p) => ({ p, snap: null })));
  assert.ok(Math.abs(strokeLength(free) - haversine(a, b)) < 0.5);
});

test('densify, erase splits the stroke, simplify keeps the shape', () => {
  const straight = [o, destination(o, 90, 100)];
  const dense = densify(straight, 4);
  assert.ok(dense.length >= 25);
  const pieces = eraseAt([dense], destination(o, 90, 50), 8);
  assert.equal(pieces.length, 2);
  assert.ok(strokeLength(pieces[0]) < 45 && strokeLength(pieces[1]) < 45);
  assert.equal(simplify(dense, 1).length, 2, 'a straight line needs only its ends');
  const curve = simplify(densify(arc, 4), 1.5);
  assert.ok(curve.length < densify(arc, 4).length && curve.length > 5);
});
