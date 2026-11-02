import test from 'node:test';
import assert from 'node:assert/strict';
import { tilesInBounds, tileKey, parseTile, segmentLabel, TILE_SIZE } from '../js/segments.js';
import { effectiveRating, ratingColor, exportRatings, RATINGS, UNRATED } from '../js/ratings.js';

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

test('exportRatings produces the shipped file format with own ratings applied', () => {
  const out = exportRatings({ 1: 'blue', 2: { rating: 'black', name: 'Rock Garden' } }, { 2: { rating: 'unrated' }, 3: { rating: 'green', name: 'Easy Loop' } });
  assert.deepEqual(out.ratings, { 1: { rating: 'blue' }, 3: { rating: 'green', name: 'Easy Loop' } });
  assert.match(out.about, /green, blue or black/);
  // Round trip: the export, used as defaults, gives the same colours.
  assert.equal(effectiveRating('3', out.ratings, {}).rating, 'green');
});
