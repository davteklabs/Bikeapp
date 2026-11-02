import test from 'node:test';
import assert from 'node:assert/strict';
import { slicePolyline, planPieces, chainSegments, assembleRoute, TRAIL_SPEED } from '../js/trailroute.js';
import { cumulativeDistances, haversine } from '../js/geo.js';
import { Navigator } from '../js/navigator.js';
import { START, CORNER, END } from './fixtures.mjs';

const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
const line = (a, b, n = 5) => Array.from({ length: n + 1 }, (_, i) => lerp(a, b, i / n));
// An L-shaped pair of trails: "River Path" east from START to CORNER, "Ridge Trail" north to END.
const river = { id: 'r', name: 'River Path', coords: line(START, CORNER) };
const ridge = { id: 'g', name: 'Ridge Trail', coords: line(CORNER, END) };

test('slicePolyline cuts forward and backward', () => {
  const c = river.coords, cum = cumulativeDistances(c);
  const fwd = slicePolyline(c, cum, 100, 300);
  assert.ok(Math.abs(haversine(fwd[0], fwd.at(-1)) - 200) < 1);
  const back = slicePolyline(c, cum, 300, 100);
  assert.deepEqual(back[0], fwd.at(-1));
  assert.deepEqual(back.at(-1), fwd[0]);
});

test('planPieces: enter #1 at the closest point, ride it toward #2', () => {
  // Start a little south of the middle of River Path.
  const start = { lat: START.lat - 0.0003, lng: (START.lng + CORNER.lng) / 2 };
  const { pieces } = planPieces(start, [river, ridge]);
  assert.ok(pieces[0].gapBefore < 40, `joins near the start (${pieces[0].gapBefore} m)`);
  assert.ok(haversine(pieces[0].coords.at(-1), CORNER) < 1, 'River Path ridden east, to where Ridge Trail joins');
  assert.ok(haversine(pieces[1].coords.at(-1), END) < 1, 'then Ridge Trail to its far end');
  assert.ok(pieces[1].gapBefore < 1);
  // The same trails picked the other way round: Ridge first, ridden south toward River Path.
  const fromTop = planPieces({ lat: END.lat, lng: END.lng + 0.0002 }, [ridge, river]);
  assert.ok(haversine(fromTop.pieces[0].coords.at(-1), CORNER) < 1);
  assert.ok(haversine(fromTop.pieces[1].coords.at(-1), START) < 1);
});

test('planPieces: finishing at a chosen end point exits the last trail nearest to it', () => {
  const end = { lat: (CORNER.lat + END.lat) / 2, lng: CORNER.lng + 0.0003 };
  const { pieces, gapAfter } = planPieces(START, [river, ridge], end);
  assert.ok(haversine(pieces[1].coords.at(-1), { lat: end.lat, lng: CORNER.lng }) < 2);
  assert.ok(gapAfter > 20 && gapAfter < 30, gapAfter);
});

test('assembleRoute: turn instructions where trails meet, trail-speed time', () => {
  const { pieces } = planPieces(START, [river, ridge]);
  const r = assembleRoute('bike', pieces.map((p) => ({ coords: p.coords, name: p.seg.name })), 'Arrive at your end point');
  assert.deepEqual(r.steps.map((s) => s.text), ['Head east on River Path', 'Turn left onto Ridge Trail', 'Arrive at your end point']);
  assert.ok(Math.abs(r.steps[1].along - 500) < 10, r.steps[1].along);
  assert.ok(Math.abs(r.distance - 800) < 10, r.distance);
  assert.ok(Math.abs(r.duration - r.distance / TRAIL_SPEED.bike) < 1);
  // The navigator can follow it.
  const nav = new Navigator(r, { mode: 'bike' });
  const st = nav.update({ ...lerp(START, CORNER, 0.5), accuracy: 5 });
  assert.equal(st.step.text, 'Turn left onto Ridge Trail');
  assert.ok(Math.abs(st.distToManeuver - 250) < 15, st.distToManeuver);
});

test('assembleRoute: no instruction for carrying straight on along the same trail', () => {
  const a = { name: 'Ridge Trail', coords: line(CORNER, lerp(CORNER, END, 0.5), 3) };
  const b = { name: 'Ridge Trail', coords: line(lerp(CORNER, END, 0.5), END, 3) };
  const r = assembleRoute('hike', [a, b]);
  assert.deepEqual(r.steps.map((s) => s.type), ['depart', 'arrive']);
});

test('chainSegments orders a trail from the end nearest the start', () => {
  const pieces = [ridge, river].map((s, i) => ({ ...s, id: String(i) }));
  const out = chainSegments(pieces, { lat: START.lat, lng: START.lng - 0.0002 });
  assert.deepEqual(out.map((s) => s.name), ['River Path', 'Ridge Trail']);
});
