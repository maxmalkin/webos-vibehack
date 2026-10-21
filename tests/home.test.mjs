// The on-TV Home watcher's decision: when LG's home should go back to the launcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const homeRedirect = createRequire(import.meta.url)('../service/home.js');
const L = 'com.gathin.tvhome', HOME = 'com.webos.app.home';

function run(events) {
  const decide = homeRedirect(L, HOME, 3000);
  return events.map(([app, t]) => decide(app, t * 1000));
}

test('LG home after any app opens the launcher; other apps and blanks do not', () => {
  assert.deepEqual(run([['netflix', 0], ['', 5], [HOME, 6], [L, 9], ['youtube', 20], [HOME, 30]]),
    [false, false, true, false, false, true]);
});

test('Home again right after the launcher comes back stays on LG home, once', () => {
  // The launcher can take seconds to appear: the window counts from when it does.
  assert.deepEqual(run([[HOME, 0], [L, 6], [HOME, 7.5], ['netflix', 20], [HOME, 25]]),
    [true, false, false, false, true]);
});

test('Home again after the window opens the launcher again', () => {
  assert.deepEqual(run([[HOME, 0], [L, 1], [HOME, 4], [L, 5]]), [true, false, true, false]);
});

test('opening the launcher yourself does not start an escape window', () => {
  assert.deepEqual(run([[L, 0], [HOME, 1]]), [false, true]);
});
