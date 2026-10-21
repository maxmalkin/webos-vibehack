// Drives the launcher (app/) in headless Chrome with mock apps and a fake webOS service bus.
// Checks behaviour (order, focus, launches, rearranging), not pixel positions, so restyling
// the launcher shouldn't break it.   Run: npm test   (needs Google Chrome; CHROME=path to override)
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const APP_DIR = new URL('../app/', import.meta.url).pathname;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LAUNCH = 'luna://com.webos.applicationManager/launch';
const NETWORK = 'luna://com.palm.connectionmanager/getStatus';

// ---- fixture TV ------------------------------------------------------------------------------

// solid: square logo on a colour (store apps). glyph: transparent icon (LG system apps).
const APPS = [
  ['netflix', 'Netflix', { solid: '#e50914' }],
  ['amazon', 'Prime Video', { solid: '#00a8e1' }],
  ['youtube.leanback.v4', 'YouTube', { solid: '#ffffff' }],
  ['hotstar', 'JioHotstar', { solid: '#1f80e0' }],
  ['spotify', 'Spotify', { solid: '#1db954' }],
  ['com.apple.appletv', 'Apple TV', { solid: '#000000' }],
  ['crunchyroll', 'Crunchyroll', { solid: '#f47521' }],
  ['disney', 'Disney+', { solid: '#113ccf', rounded: true }],
  ['com.webos.app.music', 'Music', { glyph: '#ff5a7e' }],
  ['com.webos.app.photovideo', 'Photo & Video', { glyph: '#ffffff' }],
  ['plex', 'plex', { solid: '#e5a00d' }],
  ['twitch', 'Twitch', { solid: '#9146ff' }],
  ['com.webos.app.browser', 'Web Browser', { glyph: '#e54b4b' }],
  ['zee5', 'ZEE5', { solid: '#8230c6' }],
  ['com.webos.app.livetv', 'Live TV', { solid: '#333333' }],
  ['com.webos.app.hdmi1', 'HDMI 1', { solid: '#333333' }],
  ['com.gathin.tvhome', 'Home', { solid: '#000000' }],
];
const ORDER = ['Netflix', 'Prime Video', 'YouTube', 'JioHotstar', 'Spotify',   // the dock
  'Apple TV', 'Crunchyroll', 'Disney+', 'Music', 'Photo & Video', 'plex', 'Twitch', 'Web Browser', 'ZEE5'];
const CONFIG = {
  dockApps: ['netflix', 'amazon', 'missing.app', 'youtube.leanback.v4', 'hotstar', 'spot'],   // 'spot': by name
  hiddenApps: ['com.gathin.tvhome', 'com.webos.app.livetv', 'com.webos.app.hdmi1'],
  liveTvApp: 'com.webos.app.livetv',
  columns: 4,
};
const INPUTS = [{ appId: 'com.webos.app.hdmi1', label: 'HDMI 1' }, { appId: 'com.webos.app.hdmi2', label: 'PlayStation' }];

let fixture;
function reset() {
  fixture = { apps: APPS.slice(), config: structuredClone(CONFIG), inputs: INPUTS.slice() };
}

function iconSvg(look) {
  const bg = look.solid ? `<rect width="300" height="300" rx="${look.rounded ? 60 : 0}" fill="${look.solid}"/>` : '';
  const fg = look.solid === '#ffffff' ? '#ff0000' : '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">${bg}<circle cx="150" cy="150" r="70" fill="${fg}"/></svg>`;
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const send = (body, file) => {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  };
  if (url === '/apps.js') {
    const apps = fixture.apps.map(([id, title, look]) => ({ id, title, icon: `icons/${id}.svg`, iconColor: look.glyph || '' }));
    return send(`window.TV_APPS = ${JSON.stringify({ apps, inputs: fixture.inputs })};`, url);
  }
  if (url === '/config.js') {
    // The real config.js (so a syntax error there fails the tests), with the fixture's values on top.
    const real = fs.readFileSync(path.join(APP_DIR, 'config.js'), 'utf8');
    return send(`${real}\nObject.assign(window.CONFIG, ${JSON.stringify(fixture.config)});`, url);
  }
  if (url.startsWith('/icons/')) {
    const app = fixture.apps.find(([id]) => `/icons/${id}.svg` === url);
    if (app) return send(iconSvg(app[2]), url);
  }
  const file = path.join(APP_DIR, url === '/' ? 'index.html' : url);
  if (file.startsWith(APP_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(fs.readFileSync(file), file);
  res.writeHead(404).end();
});

// ---- browser helpers -------------------------------------------------------------------------

let browser, base, contexts = [];
before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
});
afterEach(async () => {
  await Promise.all(contexts.map(c => c.close()));
  contexts = [];
});
after(async () => {
  await browser?.close();
  server.close();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Opens the launcher in a fresh profile. `responses` maps luna URIs to what the bus answers. */
async function open({ responses = {}, now } = {}) {
  const context = await browser.createBrowserContext();
  contexts.push(context);
  const page = await context.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.emulateTimezone('UTC');
  await page.evaluateOnNewDocument((responses, now) => {
    window.calls = [];
    window.PalmServiceBridge = function () {
      const bridge = this;
      bridge.call = (uri, params) => {
        window.calls.push({ uri, params: JSON.parse(params) });
        setTimeout(() => bridge.onservicecallback(JSON.stringify(responses[uri] || { returnValue: true })));
      };
    };
    if (now) {
      const RealDate = Date;
      window.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } };
    }
    // Animations off: positions and visibility settle at once.
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.appendChild(s);
    });
  }, responses, now);
  await page.goto(base);
  await sleep(100);
  return page;
}

const CODES = { left: 37, up: 38, right: 39, down: 40, ok: 13, back: 461 };

/** Presses a remote key (keydown + keyup), or sends just one of them with `only`. */
async function key(page, name, only) {
  await page.evaluate((code, types) => {
    for (const type of types) {
      const e = new KeyboardEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'keyCode', { value: code });
      document.dispatchEvent(e);
    }
  }, CODES[name], only ? [only] : ['keydown', 'keyup']);
  await sleep(20);
}

async function keys(page, ...names) {
  for (const n of names) await key(page, n);
}

/** Holds OK long enough to start rearranging, with the key repeats a real remote sends. */
async function holdOk(page) {
  for (let t = 0; t < 4; t++) {
    await key(page, 'ok', 'keydown');
    await sleep(220);
  }
  await key(page, 'ok', 'keyup');
}

/** What's on screen, in reading order (tiles sorted by position, not DOM order). */
async function snap(page) {
  await sleep(60);
  return page.evaluate(() => {
    const $ = id => document.getElementById(id);
    const tiles = [...document.querySelectorAll('#tiles .item')].map(el => {
      const card = el.querySelector('.card');
      const r = card.getBoundingClientRect();
      return {
        title: el.querySelector('.name').textContent,
        top: el.offsetTop, left: el.offsetLeft, height: card.offsetHeight, width: card.offsetWidth,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        focused: el.classList.contains('focused'), moving: el.classList.contains('moving'),
        glyph: card.classList.contains('glyph'), tint: card.style.getPropertyValue('--tint'),
        nameShown: (() => {
          const n = el.querySelector('.name'), nr = n.getBoundingClientRect(), cs = getComputedStyle(n);
          return cs.opacity === '1' && cs.visibility === 'visible' && cs.display !== 'none' && nr.width > 0 &&
            nr.top >= r.top && nr.bottom <= r.bottom;
        })(),
      };
    }).sort((a, b) => a.top - b.top || a.left - b.left);
    const header = document.querySelector('header').getBoundingClientRect();
    const front = [...document.querySelectorAll('.ambient')].find(a => a.style.opacity === '1');
    return {
      titles: tiles.map(t => t.title),
      tiles,
      focused: tiles.find(t => t.focused)?.title ?? null,
      moving: tiles.find(t => t.moving)?.title ?? null,
      pill: document.querySelector('.pill.focused span')?.textContent ?? null,
      panelOpen: !$('inputsPanel').classList.contains('hidden'),
      inputs: [...document.querySelectorAll('.inputRow')].map(r => r.textContent),
      input: document.querySelector('.inputRow.focused')?.textContent ?? null,
      separators: document.querySelectorAll('#inputsPanel .separator').length,
      glass: $('glass').style.opacity === '1',
      toast: $('toast').classList.contains('shown') ? $('toast').textContent : null,
      scrolled: document.body.classList.contains('scrolled'),
      editing: document.body.classList.contains('editing'),
      header: { bottom: header.bottom, hidden: getComputedStyle(document.querySelector('header')).opacity === '0' },
      glow: front ? front.style.background.match(/rgba\((\d+), (\d+), (\d+)/).slice(1).map(Number) : null,
      wifi: $('wifiLabel').textContent,
      greeting: $('greeting').textContent, clock: $('clock').textContent, ampm: $('ampm').textContent, date: $('date').textContent,
      calls: window.calls,
    };
  });
}

const launches = s => s.calls.filter(c => c.uri === LAUNCH).map(c => c.params);
const rows = s => Object.values(Object.groupBy(s.tiles, t => t.top));
const inDock = (s, title) => rows(s)[0].some(t => t.title === title);
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

/** Focuses a tile by title with the arrow keys: up or down to its row, then along it. */
async function focusTitle(page, title) {
  for (let step = 0; step < 40; step++) {
    const s = await snap(page);
    if (s.focused === title) return;
    const r = rows(s), where = t => {
      const ri = r.findIndex(row => row.some(x => x.title === t));
      return [ri, r[ri].findIndex(x => x.title === t)];
    };
    const [tr, tc] = where(title), [fr, fc] = where(s.focused);
    await key(page, tr < fr ? 'up' : tr > fr ? 'down' : tc < fc ? 'left' : 'right');
  }
  assert.fail(`could not reach ${title}`);
}

const onScreen = t => t.rect.bottom > 0 && t.rect.top < 1080;
const fullyOnScreen = t => t.rect.top >= 0 && t.rect.bottom <= 1080;

reset();

// ---- apps & layout ---------------------------------------------------------------------------

test('dock apps come first in config order (by id or name), the rest A to Z; hidden and missing apps are left out', async () => {
  reset();
  const s = await snap(await open());
  assert.deepEqual(s.titles, ORDER);
});

test('the dock is a row of its own, the other apps a grid below it with lined-up columns', async () => {
  reset();
  const s = await snap(await open());
  const r = rows(s);
  assert.deepEqual(r.map(x => x.length), [5, 4, 4, 1]);
  assert.deepEqual(r[0].map(t => t.title), ORDER.slice(0, 5));
  const cols = r[1].map(t => t.left);
  assert.deepEqual(cols, [...cols].sort((a, b) => a - b), 'columns run left to right');
  r.slice(1).forEach(row => assert.deepEqual(row.map(t => t.left), cols.slice(0, row.length), 'columns line up'));
  for (let i = 1; i < r.length; i++) assert.ok(r[i][0].top >= r[i - 1][0].top + r[i - 1][0].height, 'rows do not overlap');
  const right = row => row.at(-1).left + row.at(-1).width;
  assert.equal(r[0][0].left, r[1][0].left, 'dock and grid share a left edge');
  assert.ok(Math.abs(right(r[0]) - right(r[1])) <= 1, 'and a right edge');
  assert.ok(s.header.bottom <= Math.min(...r[0].map(t => t.rect.top)), 'header clears the dock');
  for (const t of s.tiles.filter(x => x.rect.top < 1080)) assert.ok(t.rect.left >= 0 && t.rect.right <= 1920, `${t.title} fits across`);
});

test('the home screen shows the dock only; Down pages the other apps in, Up puts them away', async () => {
  reset();
  const page = await open();
  let s = await snap(page);
  assert.ok(rows(s)[0].every(fullyOnScreen), 'dock on screen');
  assert.ok(rows(s).slice(1).flat().every(t => !onScreen(t)), 'other apps out of sight');
  assert.ok(!s.scrolled && !s.header.hidden);
  await key(page, 'down');
  s = await snap(page);
  assert.equal(s.focused, 'Apple TV');
  assert.ok(rows(s)[1].every(fullyOnScreen), 'grid on screen');
  assert.ok(rows(s)[0].every(t => !onScreen(t)), 'dock out of sight');
  assert.ok(s.scrolled && s.header.hidden, 'header out of the way');
  await key(page, 'up');
  s = await snap(page);
  assert.equal(s.focused, 'Netflix');
  assert.ok(rows(s).slice(1).flat().every(t => !onScreen(t)), 'other apps out of sight again');
  assert.ok(!s.scrolled && !s.header.hidden);
});

test('a dock name matches the start of a title, preferring the shortest; with no dock app installed, the first few apps', async () => {
  reset();
  fixture.apps.unshift(['youtube.kids', 'YouTube Kids', { solid: '#ff0000' }]);   // listed before YouTube
  fixture.config.dockApps = ['youtube'];
  let s = await snap(await open());
  assert.deepEqual(rows(s)[0].map(t => t.title), ['YouTube']);
  fixture.config.dockApps = ['nothing.here'];
  s = await snap(await open());
  assert.deepEqual(rows(s)[0].map(t => t.title), ['Apple TV', 'Crunchyroll', 'Disney+', 'JioHotstar', 'Music']);
});

test('starts focused on the first dock app', async () => {
  reset();
  const s = await snap(await open());
  assert.equal(s.focused, 'Netflix');
  assert.ok(s.glass);
  assert.equal(s.pill, null);
  assert.deepEqual(launches(s), []);
});

test('with no apps the launcher still loads', async () => {
  reset();
  fixture.apps = [];
  const page = await open();
  const s = await snap(page);
  assert.deepEqual(s.titles, []);
  assert.ok(!s.glass);
  await keys(page, 'right', 'down', 'ok', 'up');
  assert.ok((await snap(page)).pill, 'top buttons still reachable');
});

test('every tile shows its app name', async () => {
  reset();
  const s = await snap(await open());
  for (const t of s.tiles) assert.ok(t.nameShown, `${t.title} labelled`);
});

// ---- tile colours ----------------------------------------------------------------------------

test('tiles are tinted from the icon: its background, or the app colour for glyphs; never white or black', async () => {
  reset();
  const s = await snap(await open());
  const tile = t => s.tiles.find(x => x.title === t);
  const tint = t => tile(t).tint && tile(t).tint.split(',').map(Number);
  assert.ok(near(tint('Netflix'), [229, 9, 20]) && !tile('Netflix').glyph);
  assert.ok(near(tint('Disney+'), [17, 60, 207]) && !tile('Disney+').glyph, 'rounded icon: sampled from its edge');
  assert.ok(near(tint('Web Browser'), [229, 75, 75]) && tile('Web Browser').glyph, 'glyph: the app colour');
  assert.equal(tile('Photo & Video').tint, '', 'white glyph: neutral');
  assert.ok(tile('Photo & Video').glyph);
  assert.equal(tile('YouTube').tint, '', 'white icon: neutral');
  assert.equal(tile('Apple TV').tint, '', 'black icon: neutral');
});

test('the background glow follows the focused tile colour', async () => {
  reset();
  const page = await open();
  const [r1, g1, b1] = (await snap(page)).glow;   // Netflix: red
  assert.ok(r1 > g1 && r1 > b1, `red glow, got ${[r1, g1, b1]}`);
  await focusTitle(page, 'Spotify');
  const [r2, g2, b2] = (await snap(page)).glow;   // Spotify: green
  assert.ok(g2 > r2 && g2 > b2, `green glow, got ${[r2, g2, b2]}`);
  await focusTitle(page, 'Twitch');
  const [r3, g3, b3] = (await snap(page)).glow;   // Twitch: purple, in the grid
  assert.ok(b3 > g3 && b3 > r3, `purple glow, got ${[r3, g3, b3]}`);
});

// ---- navigation ------------------------------------------------------------------------------

test('arrows move along rows, stop at the edges, and go straight up and down between rows', async () => {
  reset();
  const page = await open();
  const at = async () => (await snap(page)).focused;
  await key(page, 'left');
  assert.equal(await at(), 'Netflix', 'left edge');
  await keys(page, 'right', 'down');
  assert.equal(await at(), 'Crunchyroll', 'the grid tile below Prime Video');
  await key(page, 'up');
  assert.equal(await at(), 'Prime Video', 'and back up');
  await keys(page, 'right', 'right', 'right');
  assert.equal(await at(), 'Spotify');
  await key(page, 'right');
  assert.equal(await at(), 'Spotify', 'right end of the dock');
  await key(page, 'down');
  assert.equal(await at(), 'Music');
  await keys(page, 'left', 'down');
  assert.equal(await at(), 'Twitch');
  await key(page, 'down');
  assert.equal(await at(), 'ZEE5', 'short last row: the nearest tile');
  await key(page, 'down');
  assert.equal(await at(), 'ZEE5', 'bottom edge');
  await key(page, 'right');
  assert.equal(await at(), 'ZEE5', 'no tile to the right');
  await key(page, 'up');
  assert.equal(await at(), 'Photo & Video', 'straight up from the short row');
  await key(page, 'back');
  assert.equal(await at(), 'Photo & Video', 'Back does nothing on the home screen');
  await key(page, 'left');
  assert.equal(await at(), 'Photo & Video', 'left edge of a grid row: no wrap to the row above');
  await keys(page, 'up', 'up');
  assert.equal(await at(), 'Netflix', 'up through the grid into the dock');
  assert.deepEqual(launches(await snap(page)), []);
});

test('scrolling keeps the focused tile on screen and slides the header away', async () => {
  reset();
  for (let i = 0; i < 40; i++) fixture.apps.push([`filler${i}`, `Zz ${String(i).padStart(2, '0')}`, { solid: '#336699' }]);
  const page = await open();
  for (let i = 0; i < 20; i++) {
    await key(page, 'down');
    const s = await snap(page);
    const t = s.tiles.find(x => x.focused).rect;
    assert.ok(t.top >= 0 && t.bottom <= 1080, `${s.focused} on screen: ${t.top}..${t.bottom}`);
  }
  let s = await snap(page);
  assert.ok(rows(s).at(-1).some(t => t.focused), 'reached the last row');
  assert.ok(s.scrolled && s.header.hidden, 'header hidden while scrolled');
  while (!rows(await snap(page))[0].some(x => x.focused)) await key(page, 'up');
  s = await snap(page);
  const dockTop = Math.min(...rows(s)[0].map(t => t.rect.top));
  assert.ok(!s.scrolled && !s.header.hidden && s.header.bottom <= dockTop, 'header back, clear of the dock');
});

test('up from the dock goes to the top buttons; left/right move between them; down comes back', async () => {
  reset();
  const page = await open();
  await keys(page, 'right', 'right', 'right', 'up');
  let s = await snap(page);
  assert.ok(s.pill, 'a top button is focused');
  assert.equal(s.focused, null);
  assert.ok(!s.glass, 'the tile highlight hides');
  await keys(page, 'left', 'left', 'left', 'left');
  assert.equal((await snap(page)).pill, 'Inputs');
  await key(page, 'right');
  assert.equal((await snap(page)).pill, 'Wi-Fi');
  await keys(page, 'right', 'right');
  assert.equal((await snap(page)).pill, 'Settings');
  await key(page, 'back');
  assert.equal((await snap(page)).pill, 'Settings', 'Back does nothing');
  await key(page, 'down');
  s = await snap(page);
  assert.equal(s.focused, 'JioHotstar', 'returns to the dock tile it left');
  assert.equal(s.pill, null);
  assert.ok(s.glass);
});

test('up from a grid row goes to the row above, not the top buttons', async () => {
  reset();
  const page = await open();
  await keys(page, 'down', 'down', 'up');
  const s = await snap(page);
  assert.equal(s.focused, 'Apple TV');
  assert.equal(s.pill, null);
});

// ---- launching -------------------------------------------------------------------------------

test('OK on a tile opens its app', async () => {
  reset();
  const page = await open();
  await keys(page, 'right', 'ok');
  assert.deepEqual(launches(await snap(page)), [{ id: 'amazon', params: {} }]);
  await focusTitle(page, 'Web Browser');
  await key(page, 'ok');
  assert.deepEqual(launches(await snap(page)).at(-1), { id: 'com.webos.app.browser', params: {} });
});

test('an app that fails to open shows a toast', async () => {
  reset();
  const page = await open({ responses: { [LAUNCH]: { returnValue: false } } });
  await keys(page, 'right', 'ok');
  assert.equal((await snap(page)).toast, "Can't open Prime Video");
});

test('the Wi-Fi button opens network settings, Settings opens settings', async () => {
  reset();
  const page = await open();
  await keys(page, 'up', 'left', 'left', 'right', 'ok');   // Wi-Fi
  await keys(page, 'right', 'ok');                         // Settings
  assert.deepEqual(launches(await snap(page)), [
    { id: 'com.palm.app.settings', params: { target: 'network' } },
    { id: 'com.palm.app.settings', params: {} },
  ]);
});

// ---- inputs menu -----------------------------------------------------------------------------

async function openInputs(page) {
  await keys(page, 'up', 'left', 'left', 'left', 'ok');
}

test('the Inputs menu lists HDMI inputs, then Live TV, and opens the chosen one', async () => {
  reset();
  const page = await open();
  await openInputs(page);
  let s = await snap(page);
  assert.ok(s.panelOpen);
  assert.deepEqual(s.inputs, ['HDMI 1', 'PlayStation', 'Live TV']);
  assert.equal(s.separators, 1);
  assert.equal(s.input, 'HDMI 1');
  await keys(page, 'down', 'down', 'down');
  assert.equal((await snap(page)).input, 'Live TV', 'stops at the bottom');
  await keys(page, 'up', 'up', 'up');
  assert.equal((await snap(page)).input, 'HDMI 1', 'stops at the top');
  await keys(page, 'down', 'ok');
  s = await snap(page);
  assert.deepEqual(launches(s), [{ id: 'com.webos.app.hdmi2', params: {} }]);
  assert.ok(!s.panelOpen);
  assert.equal(s.pill, 'Inputs');
});

test('Back, left or right close the Inputs menu without opening anything', async () => {
  reset();
  const page = await open();
  for (const k of ['back', 'left', 'right']) {
    await openInputs(page);
    assert.ok((await snap(page)).panelOpen);
    await key(page, k);
    const s = await snap(page);
    assert.ok(!s.panelOpen, `${k} closes it`);
    assert.equal(s.pill, 'Inputs');
    await key(page, 'down');
  }
  assert.deepEqual(launches(await snap(page)), []);
});

test('the Inputs menu without HDMI inputs shows only Live TV, and with nothing says so', async () => {
  reset();
  fixture.inputs = [];
  let page = await open();
  await openInputs(page);
  let s = await snap(page);
  assert.deepEqual(s.inputs, ['Live TV']);
  assert.equal(s.separators, 0);

  fixture.config.liveTvApp = '';
  page = await open();
  await openInputs(page);
  s = await snap(page);
  assert.ok(!s.panelOpen);
  assert.equal(s.toast, 'No inputs found');
  assert.equal(s.pill, 'Inputs');
});

// ---- rearranging -----------------------------------------------------------------------------

test('holding OK picks a tile up instead of opening it', async () => {
  reset();
  const page = await open();
  await key(page, 'right');
  await holdOk(page);
  const s = await snap(page);
  assert.ok(s.editing);
  assert.equal(s.moving, 'Prime Video');
  assert.match(s.toast, /OK to place/);
  assert.deepEqual(launches(s), []);
});

test('a picked-up tile moves with the arrows, into and out of the dock, and OK saves the order', async () => {
  reset();
  const page = await open();
  await key(page, 'right');
  await holdOk(page);
  await key(page, 'right');
  let s = await snap(page);
  assert.deepEqual(s.titles.slice(0, 5), ['Netflix', 'YouTube', 'Prime Video', 'JioHotstar', 'Spotify']);
  assert.equal(s.focused, 'Prime Video');
  await keys(page, 'right', 'down');   // out of the dock: the first grid app moves up into it
  s = await snap(page);
  assert.deepEqual(s.titles.slice(0, 9), ['Netflix', 'YouTube', 'JioHotstar', 'Spotify', 'Apple TV', 'Crunchyroll', 'Disney+', 'Prime Video', 'Music']);
  assert.ok(!inDock(s, 'Prime Video') && inDock(s, 'Apple TV'));
  assert.equal(rows(s)[0].length, 5, 'the dock keeps its size');
  await keys(page, 'up', 'up');   // back up, then past the top: stays in the dock
  assert.deepEqual((await snap(page)).titles.slice(0, 5), ['Netflix', 'YouTube', 'JioHotstar', 'Prime Video', 'Spotify']);
  await keys(page, 'left', 'left', 'left', 'left');
  s = await snap(page);
  assert.deepEqual(s.titles.slice(0, 5), ['Prime Video', 'Netflix', 'YouTube', 'JioHotstar', 'Spotify'], 'stops at the first slot');
  await key(page, 'ok');
  s = await snap(page);
  assert.ok(!s.editing && !s.moving);
  assert.equal(s.focused, 'Prime Video');
  assert.deepEqual(launches(s), [], 'placing does not open the app');

  await page.reload();
  await sleep(100);
  s = await snap(page);
  assert.deepEqual(s.titles, ['Prime Video', ...ORDER.filter(t => t !== 'Prime Video')], 'order survives a restart');
});

test('a picked-up tile moved down past the end lands in the last slot', async () => {
  reset();
  const page = await open();
  await holdOk(page);
  for (let i = 0; i < 5; i++) await key(page, 'down');
  await key(page, 'right');
  assert.equal((await snap(page)).titles.at(-1), 'Netflix');
});

test('Back puts a picked-up tile back and saves nothing', async () => {
  reset();
  const page = await open();
  await holdOk(page);
  await keys(page, 'right', 'right', 'down');
  await key(page, 'back');
  let s = await snap(page);
  assert.ok(!s.editing);
  assert.deepEqual(s.titles, ORDER);
  assert.equal(s.focused, 'Netflix');
  await page.reload();
  await sleep(100);
  assert.deepEqual((await snap(page)).titles, ORDER);
});

test('a saved order keeps up with app changes, and resets when dockApps changes', async () => {
  reset();
  const page = await open();
  await holdOk(page);
  await keys(page, 'right', 'ok');   // Prime Video, Netflix, ...
  fixture.apps.push(['aaa', 'Aardvark TV', { solid: '#123456' }]);   // newly installed
  fixture.config.hiddenApps.push('plex');                              // newly hidden
  await page.reload();
  await sleep(100);
  const expected = ['Prime Video', 'Netflix', ...ORDER.slice(2).filter(t => t !== 'plex'), 'Aardvark TV'];
  assert.deepEqual((await snap(page)).titles, expected, 'saved order kept, new app at the end, hidden app gone');

  fixture.config.dockApps = ['twitch'];
  await page.reload();
  await sleep(100);
  const s = await snap(page);
  assert.equal(s.titles[0], 'Twitch', 'new dock config wins');
  assert.equal(rows(s)[0].length, 1, 'the dock holds just its apps');
  assert.deepEqual(s.titles.slice(1, 4), ['Aardvark TV', 'Apple TV', 'Crunchyroll']);
});

// ---- mouse (LG Magic Remote pointer) ---------------------------------------------------------

async function tileHandle(page, title) {
  return page.evaluateHandle(t => [...document.querySelectorAll('#tiles .item')]
    .find(el => el.querySelector('.name').textContent === t), title);
}

test('pointing at a tile focuses it, clicking opens it', async () => {
  reset();
  const page = await open();
  const yt = await tileHandle(page, 'YouTube');
  await yt.hover();
  assert.equal((await snap(page)).focused, 'YouTube');
  await yt.click();
  assert.deepEqual(launches(await snap(page)), [{ id: 'youtube.leanback.v4', params: {} }]);
});

test('pointing at a top button focuses it, clicking activates it', async () => {
  reset();
  const page = await open();
  await page.hover('#btnSettings');
  assert.equal((await snap(page)).pill, 'Settings');
  await page.click('#btnSettings');
  assert.deepEqual(launches(await snap(page)), [{ id: 'com.palm.app.settings', params: {} }]);
  await page.click('#btnInputs');
  assert.ok((await snap(page)).panelOpen);
});

test('clicking while a tile is picked up places it', async () => {
  reset();
  const page = await open();
  await holdOk(page);
  await key(page, 'right');
  await (await tileHandle(page, 'Netflix')).click();
  const s = await snap(page);
  assert.ok(!s.editing);
  assert.deepEqual(s.titles.slice(0, 2), ['Prime Video', 'Netflix']);
  assert.deepEqual(launches(s), []);
});

// ---- coming back to the launcher ------------------------------------------------------------

test('returning to the launcher keeps the focused tile, and cancels a move or an open menu', async () => {
  reset();
  const page = await open();
  const relaunch = () => page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
  await focusTitle(page, 'Twitch');
  await relaunch();
  let s = await snap(page);
  assert.equal(s.focused, 'Twitch');
  assert.ok(s.glass);

  await holdOk(page);
  await key(page, 'left');
  await relaunch();
  s = await snap(page);
  assert.ok(!s.editing);
  assert.deepEqual(s.titles, ORDER, 'move cancelled');

  await focusTitle(page, 'YouTube');
  await openInputs(page);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  s = await snap(page);
  assert.ok(!s.panelOpen);
  assert.equal(s.pill, null);
  assert.equal(s.focused, 'YouTube');
});

// ---- header ----------------------------------------------------------------------------------

test('the clock shows 12-hour time, the date and a greeting for the time of day', async () => {
  reset();
  const cases = [
    [Date.UTC(2026, 9, 19, 0, 30), 'Good night', '12:30', 'am', 'Monday, 19 October'],
    [Date.UTC(2026, 9, 20, 9, 5), 'Good morning', '9:05', 'am', 'Tuesday, 20 October'],
    [Date.UTC(2026, 9, 21, 12, 0), 'Good afternoon', '12:00', 'pm', 'Wednesday, 21 October'],
    [Date.UTC(2026, 0, 1, 17, 45), 'Good evening', '5:45', 'pm', 'Thursday, 1 January'],
    [Date.UTC(2026, 11, 31, 23, 59), 'Good night', '11:59', 'pm', 'Thursday, 31 December'],
  ];
  for (const [now, greeting, clock, ampm, date] of cases) {
    const s = await snap(await open({ now }));
    assert.deepEqual([s.greeting, s.clock, s.ampm, s.date], [greeting, clock, ampm, date]);
  }
});

test('the Wi-Fi button shows the network name, Ethernet, or Offline', async () => {
  reset();
  const cases = [
    [{ returnValue: true, wifi: { state: 'connected', ssid: 'HomeNet' } }, 'HomeNet'],
    [{ returnValue: true, wifi: { state: 'connected' } }, 'Wi-Fi'],
    [{ returnValue: true, wired: { state: 'connected' }, wifi: { state: 'connected', ssid: 'HomeNet' } }, 'Ethernet'],
    [{ returnValue: true, wifi: { state: 'disconnected' }, isInternetConnectionAvailable: false }, 'Offline'],
    [{ returnValue: false }, 'Wi-Fi'],
  ];
  for (const [status, label] of cases) {
    const s = await snap(await open({ responses: { [NETWORK]: status } }));
    assert.equal(s.wifi, label);
    assert.deepEqual(s.calls.find(c => c.uri === NETWORK).params, { subscribe: true });
  }
});
