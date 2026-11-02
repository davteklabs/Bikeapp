import test from 'node:test';
import assert from 'node:assert/strict';
import { tilesInBounds, tileKey, parseTile, segmentLabel, TILE_SIZE } from '../js/segments.js';
import { effectiveRating, ratingColor, effectiveName, exportTrailInfo, RATINGS, UNRATED } from '../js/trail-info.js';
import { togglePlanned, planIndex, planLength, midpoint } from '../js/plan.js';
import { haversine } from '../js/geo.js';

test('route plan: toggling adds in order and removes, length adds up', () => {
  const a = { id: '1', name: 'A', kind: 'p', coords: [{ lat: 38.75, lng: -121.17 }, { lat: 38.751, lng: -121.17 }] };
  const b = { id: '2', name: null, kind: 't', coords: [{ lat: 38.751, lng: -121.17 }, { lat: 38.753, lng: -121.17 }] };
  let plan = togglePlanned([], a);
  plan = togglePlanned(plan, b);
  assert.deepEqual(plan.map((s) => s.id), ['1', '2']);
  assert.equal(planIndex(plan, '2'), 1);
  assert.ok(Math.abs(planLength(plan) - 3 * 111.2) < 1, planLength(plan));
  plan = togglePlanned(plan, a);
  assert.deepEqual(plan.map((s) => s.id), ['2']);
  assert.equal(planIndex(plan, '1'), -1);
  assert.ok(haversine(midpoint(b), { lat: 38.752, lng: -121.17 }) < 1);
});

test('tilesInBounds covers the box with aligned tiles', () => {
  const tiles = tilesInBounds({ south: 38.74, west: -121.19, north: 38.76, east: -121.14 });
  // 38.70-38.75 and 38.75-38.80 rows; -121.20 to -121.10 columns.
  assert.equal(tiles.length, 2 * 2);
  for (const t of tiles) {
    assert.ok(Math.abs(t.north - t.south - TILE_SIZE) < 1e-9);
    assert.ok(t.south <= 38.76 && t.north >= 38.74 && t.west <= -121.14 && t.east >= -121.19);
  }
  assert.equal(new Set(tiles.map((t) => tileKey(t.row, t.col))).size, tiles.length);
});

test('parseTile and labels', () => {
  const [a, b] = parseTile({ ways: [[11, 'Jedi Trail', 'p', [[-121.17, 38.75], [-121.16, 38.751]]], [12, null, 't', [[-121.1, 38.7], [-121.11, 38.71]]]] });
  assert.equal(a.id, '11');
  assert.deepEqual(a.coords[0], { lat: 38.75, lng: -121.17 });
  assert.equal(segmentLabel(a), 'Jedi Trail');
  assert.equal(segmentLabel(b), 'Unnamed track');
  assert.equal(a.private, false);
  const [c] = parseTile({ ways: [[13, null, 'r', [[-121.1, 38.7], [-121.11, 38.71]], 'p']] });
  assert.equal(c.private, true);
  assert.equal(segmentLabel(c), 'Unnamed dirt road');
});

test('ratings: only real ratings get a colour, own ratings override defaults', () => {
  const defaults = { 1: 'blue', 2: { rating: 'black', name: 'Rock Garden' } };
  const mine = { 2: { rating: 'unrated' }, 3: { rating: 'green', name: 'Easy Loop' } };
  assert.deepEqual(effectiveRating('1', defaults, mine), { rating: 'blue', source: 'default' });
  assert.deepEqual(effectiveRating('2', defaults, mine), { rating: null, source: 'you' });
  assert.deepEqual(effectiveRating('3', defaults, mine), { rating: 'green', source: 'you' });
  assert.deepEqual(effectiveRating('4', defaults, mine), { rating: null, source: null });
  assert.equal(ratingColor(null), UNRATED.color);
  assert.equal(ratingColor('black'), RATINGS.black.color);
  // Unknown values in the file are ignored, never guessed.
  assert.deepEqual(effectiveRating('5', { 5: 'purple' }, {}), { rating: null, source: null });
});

test('names: your own beats the TrailNav default beats the map data', () => {
  const defaults = { 1: { name: 'Jedi Trail' }, 2: { rating: 'blue' } };
  const mine = { 3: 'Quarry Spur' };
  assert.deepEqual(effectiveName('1', null, defaults, mine), { name: 'Jedi Trail', source: 'default' });
  assert.deepEqual(effectiveName('1', 'Old Name', defaults, { 1: 'New Name' }), { name: 'New Name', source: 'you' });
  assert.deepEqual(effectiveName('2', 'Pioneer Express Trail', defaults, mine), { name: 'Pioneer Express Trail', source: 'map' });
  assert.deepEqual(effectiveName('3', null, defaults, mine), { name: 'Quarry Spur', source: 'you' });
  assert.deepEqual(effectiveName('4', null, defaults, mine), { name: null, source: null });
  assert.equal(segmentLabel({ kind: 'p', name: null }, 'Quarry Spur'), 'Quarry Spur');
});

test('exportTrailInfo produces the shipped file format with own ratings and names applied', () => {
  const out = exportTrailInfo(
    { 1: { rating: 'blue' }, 2: { rating: 'black', name: 'Rock Garden' } },
    { 2: { rating: 'unrated' }, 3: { rating: 'green' } },
    { 4: 'Quarry Spur' },
  );
  assert.deepEqual(out.trails, { 1: { rating: 'blue' }, 2: { name: 'Rock Garden' }, 3: { rating: 'green' }, 4: { name: 'Quarry Spur' } });
  assert.match(out.about, /green, blue or black/);
  // Round trip: the export, used as defaults, gives the same colours and names.
  assert.equal(effectiveRating('3', out.trails, {}).rating, 'green');
  assert.equal(effectiveName('4', null, out.trails, {}).name, 'Quarry Spur');
});

test('exportTrailInfo includes drawn trails, shipped and own', () => {
  const coords = [[-121.17, 38.75], [-121.169, 38.751]];
  const out = exportTrailInfo({}, { d1: { rating: 'green' } }, {}, { d0: { name: 'Old Canal Path', kind: 'r', coords } }, { d1: { name: 'Canal Path', kind: 'p', coords } });
  assert.deepEqual(Object.keys(out.custom).sort(), ['d0', 'd1']);
  assert.equal(out.custom.d1.name, 'Canal Path');
  assert.deepEqual(out.trails.d1, { rating: 'green' });
});
