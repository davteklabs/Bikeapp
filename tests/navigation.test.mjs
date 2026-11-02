import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, buildRouteUrl } from '../js/routing.js';
import { Navigator } from '../js/navigator.js';
import { instructionText } from '../js/instructions.js';
import { osrmResponse, START, CORNER, END } from './fixtures.mjs';

const route = () => parseRoute(osrmResponse().routes[0], 'bike');
const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });

test('buildRouteUrl uses bike/foot profiles with steps', () => {
  const u = buildRouteUrl('hike', [START, END]);
  assert.match(u, /routed-foot\/route\/v1\/driving\/8\.000000,47\.000000;8\.006580,47\.002700\?/);
  assert.match(u, /steps=true/);
  assert.match(buildRouteUrl('bike', [START, END]), /routed-bike/);
});

test('parseRoute builds instructions and along-route positions', () => {
  const r = route();
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[0].text, 'Head east on River Path');
  assert.equal(r.steps[1].text, 'Turn left onto Ridge Trail');
  assert.equal(r.steps[2].text, 'Arrive at your destination');
  assert.ok(Math.abs(r.steps[1].along - 500) < 10, r.steps[1].along);
  assert.ok(Math.abs(r.cum.at(-1) - 800) < 10);
});

test('instructionText covers roundabouts, forks, end of road', () => {
  assert.equal(instructionText({ name: 'Main St', maneuver: { type: 'roundabout', exit: 2 } }), 'At the roundabout, take the 2nd exit onto Main St');
  assert.equal(instructionText({ name: '', maneuver: { type: 'fork', modifier: 'slight left' } }), 'Keep left at the fork');
  assert.equal(instructionText({ name: 'Elm', maneuver: { type: 'end of road', modifier: 'right' } }), 'At the end of the road, turn right onto Elm');
  assert.equal(instructionText({ name: '', maneuver: { type: 'continue', modifier: 'straight' } }), 'Continue straight');
});

test('navigator tracks progress, announces turn, and arrives', () => {
  const nav = new Navigator(route(), { mode: 'bike' });
  const spoken = [];
  let st;
  // Ride east in 25 m increments.
  for (let t = 0; t <= 1.0001; t += 0.05) {
    st = nav.update({ ...lerp(START, CORNER, t), accuracy: 5, speed: 5, timestamp: 0 });
    spoken.push(...st.announcements);
    if (t < 0.9) {
      assert.equal(st.stepIndex, 1, `before corner t=${t}`);
      assert.ok(Math.abs(st.distToManeuver - 500 * (1 - t)) < 12, `dist ${st.distToManeuver} at t=${t}`);
    }
  }
  assert.ok(spoken.some((s) => /^In \d+ metres, turn left onto Ridge Trail$/.test(s)), spoken.join(' | '));
  assert.ok(spoken.includes('Turn left onto Ridge Trail'), spoken.join(' | '));
  // No duplicate prompts.
  assert.equal(new Set(spoken).size, spoken.length, spoken.join(' | '));

  // Now head north to the end.
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    st = nav.update({ ...lerp(CORNER, END, t), accuracy: 5, speed: 5, timestamp: 0 });
    spoken.push(...st.announcements);
  }
  assert.equal(st.arrived, true);
  assert.ok(spoken.includes('You have arrived at your destination'));
  assert.ok(st.remaining < 25);
});

test('navigator flags off-route only after consecutive bad fixes', () => {
  const nav = new Navigator(route(), { mode: 'bike', offRouteFixes: 3 });
  const away = { lat: START.lat - 0.001, lng: 8.003, accuracy: 5 }; // ~110 m south of the path
  nav.update({ ...lerp(START, CORNER, 0.4), accuracy: 5 });
  assert.equal(nav.update(away).offRoute, false);
  assert.equal(nav.update(away).offRoute, false);
  const st = nav.update(away);
  assert.equal(st.offRoute, true);
  assert.ok(st.distanceFromRoute > 100);
  // Back on route resets.
  assert.equal(nav.update({ ...lerp(START, CORNER, 0.5), accuracy: 5 }).offRoute, false);
});

test('poor GPS accuracy widens the off-route tolerance', () => {
  const nav = new Navigator(route(), { mode: 'bike', offRouteFixes: 1 });
  const p = { lat: START.lat - 0.0005, lng: 8.003 }; // ~55 m off
  assert.equal(nav.update({ ...p, accuracy: 5 }).offRoute, true);
  const nav2 = new Navigator(route(), { mode: 'bike', offRouteFixes: 1 });
  assert.equal(nav2.update({ ...p, accuracy: 60 }).offRoute, false);
});
