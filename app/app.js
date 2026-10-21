/*
 * Home screen for webOS: a dock of pinned apps on the home screen, every other app in a grid below
 * it (out of sight until you press Down), and one focus ring that springs between tiles.
 * A port of the tv-vibehack Android launcher.
 *
 * webOS does not let third-party apps list installed apps, so sync-apps.py writes them into apps.js.
 */
(function () {
  'use strict';

  var COLUMNS = Math.max(1, CONFIG.columns || 7);
  var DOCK_SLOTS = 5;                           // the dock's tiles are sized for this many across
  var MARGIN = 114, GAP = 28;                   // screen edge to the tiles, and between tiles
  var WIDTH = 1920 - 2 * MARGIN;
  var TILE_W = Math.round((WIDTH - (COLUMNS - 1) * GAP) / COLUMNS), TILE_H = Math.round(TILE_W * 0.82);
  var ROW_PITCH = TILE_H + 38;
  var DOCK_TOP = 560;           // the dock sits low on the home screen
  var GRID_TOP = 1120;          // the other apps start below the screen; Down pages them into view
  var GRID_PAGE = GRID_TOP - 170;   // scroll offset that puts the grid's first row near the top
  var FOCUS_SCALE = 1.06;
  var GLASS_PAD = 5;            // the focus ring sits just outside the scaled tile
  var VIEW_TOP = 80, VIEW_BOTTOM = 1050;    // area grid rows scroll into

  var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27 };

  var GREETINGS = [[5, 'Good night'], [12, 'Good morning'], [17, 'Good afternoon'], [22, 'Good evening'], [24, 'Good night']];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];

  var ICON_INPUT = 'M18,7V4c0,-1.1 -0.9,-2 -2,-2H8C6.9,2 6,2.9 6,4v3H5v6l3,6v3h8v-3l3,-6V7H18zM8,4h8v3h-2V5h-1v2h-2V5h-1v2H8V4z';
  var ICON_LIVETV = 'M21,6h-7.59l3.29,-3.29L16,2l-4,4l-4,-4l-0.71,0.71L10.59,6H3c-1.1,0 -2,0.89 -2,2v12c0,1.1 0.9,2 2,2h18c1.1,0 2,-0.89 2,-2V8C23,6.89 22.1,6 21,6zM21,20H3V8h18V20zM9,10v8l7,-4L9,10z';

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), tilesEl = $('tiles'), glass = $('glass');
  var ambients = [$('ambientA'), $('ambientB')], ambientFront = 0, ambientColor = null;
  var pills = [$('btnInputs'), $('btnWifi'), $('btnSettings')];
  var panel = $('inputsPanel');

  document.documentElement.style.setProperty('--tile-w', TILE_W + 'px');
  document.documentElement.style.setProperty('--tile-h', TILE_H + 'px');
  if (CONFIG.wallpaper) document.body.style.setProperty('--wallpaper', 'url("' + CONFIG.wallpaper + '")');

  var items = [];               // {app, el, color}
  var zone = 'grid';            // 'grid' | 'top' | 'inputs'
  var focused = 0, pillFocus = 0, inputFocus = 0, inputRows = [];
  var dockSize = 0, DOCK_W = 0, DOCK_H = 0;   // set by build(): the first dockSize items are the dock
  var offset = 0, glassShown = false;
  var editing = null;           // {item, snapshot} while a tile is being moved

  // ---- luna bus ------------------------------------------------------------------------------

  var bridges = [];   // keep a reference: a collected bridge drops its callback

  function luna(uri, params, cb) {
    try {
      var b = new PalmServiceBridge();
      b.onservicecallback = function (msg) {
        var res;
        try { res = JSON.parse(msg); } catch (e) { res = { returnValue: false }; }
        if (cb) cb(res);
        if (!params || !params.subscribe) bridges.splice(bridges.indexOf(b), 1);
      };
      bridges.push(b);
      b.call(uri, JSON.stringify(params || {}));
    } catch (e) {
      if (cb) cb({ returnValue: false, errorText: String(e) });   // not on a TV (desktop preview)
    }
  }

  function launch(id, title, params) {
    luna('luna://com.webos.applicationManager/launch', { id: id, params: params || {} }, function (res) {
      if (res.returnValue === false) toast("Can't open " + (title || id));
    });
  }

  var toastTimer;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.classList.add('shown');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('shown'); }, 2200);
  }

  // ---- apps ----------------------------------------------------------------------------------

  /** The app a dockApps entry names: its id, or else the start of its title ('peacock' finds 'Peacock TV'). */
  function findApp(apps, entry) {
    var e = String(entry).toLowerCase();
    var named = apps.filter(function (a) { return a.title.toLowerCase().indexOf(e) === 0; })
      .sort(function (a, b) { return a.title.length - b.title.length; });   // 'youtube' finds YouTube, not YouTube Kids
    return apps.filter(function (a) { return a.id === entry; })[0] || named[0];
  }

  /** {apps, dock}: every app to show in order, and how many of the first ones form the dock. */
  function orderedApps() {
    var all = (window.TV_APPS && TV_APPS.apps) || [];
    var byId = {}, hidden = {};
    all.forEach(function (a) { byId[a.id] = a; });
    (CONFIG.hiddenApps || []).forEach(function (id) { hidden[id] = true; });
    var visible = all.filter(function (a) { return !hidden[a.id]; });
    var byTitle = function (a, b) { return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1; };
    var others = function (placed) {
      return visible.filter(function (a) { return placed.indexOf(a) < 0; }).sort(byTitle);
    };

    var dock = [];
    (CONFIG.dockApps || []).forEach(function (entry) {
      var a = findApp(visible, entry);
      if (a && dock.indexOf(a) < 0) dock.push(a);
    });
    // The dock holds as many apps as dockApps found; with none installed, the first few.
    var size = dock.length || Math.min(DOCK_SLOTS, visible.length);

    // An order arranged on the TV wins, until dockApps in config.js changes.
    var saved = loadOrder();
    if (saved) {
      var placed = saved.map(function (id) { return byId[id]; })
        .filter(function (a) { return a && !hidden[a.id]; });
      return { apps: placed.concat(others(placed)), dock: size };
    }
    return { apps: dock.concat(others(dock)), dock: size };
  }

  var ORDER_KEY = 'tvhome.order';

  function loadOrder() {
    try {
      var s = JSON.parse(localStorage.getItem(ORDER_KEY));
      return s && s.dock === (CONFIG.dockApps || []).join(',') ? s.ids : null;
    } catch (e) {
      return null;
    }
  }

  function saveOrder() {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify({
        dock: (CONFIG.dockApps || []).join(','),
        ids: items.map(function (it) { return it.app.id; })
      }));
    } catch (e) { /* storage unavailable: the order lasts until the app restarts */ }
  }

  // Row 0 is the dock; rows 1 and on are the grid, COLUMNS to a row.
  function rowOf(i) { return i < dockSize ? 0 : 1 + Math.floor((i - dockSize) / COLUMNS); }
  function rowStart(r) { return r ? dockSize + (r - 1) * COLUMNS : 0; }
  function rowEnd(r) { return Math.min(items.length, r ? rowStart(r) + COLUMNS : dockSize) - 1; }
  function lastRow() { return rowOf(items.length - 1); }

  /** Where tile i sits on the stage: {x, y, w, h}. */
  function box(i) {
    if (i < dockSize) return { x: MARGIN + i * (DOCK_W + GAP), y: DOCK_TOP, w: DOCK_W, h: DOCK_H };
    var j = i - dockSize;
    return { x: MARGIN + (j % COLUMNS) * (TILE_W + GAP), y: GRID_TOP + Math.floor(j / COLUMNS) * ROW_PITCH, w: TILE_W, h: TILE_H };
  }

  function centerX(i) { var b = box(i); return b.x + b.w / 2; }

  /** The tile in row r closest to x: Up and Down go straight up and down the screen. */
  function nearestIn(r, x) {
    var best = -1, bestD = Infinity;
    for (var i = rowStart(r); i <= rowEnd(r); i++) {
      var d = Math.abs(centerX(i) - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /** 'Spotify - Music and Podcasts' -> 'Spotify', 'Tubi: Free Movies & TV' -> 'Tubi'. */
  function shortName(title) { return title.split(/\s+[-\u2013\u2014|]\s+|:\s+/)[0]; }

  function build() {
    tilesEl.innerHTML = '';
    var ordered = orderedApps();
    dockSize = ordered.dock;
    var across = Math.max(DOCK_SLOTS, dockSize);
    DOCK_W = Math.round((WIDTH - (across - 1) * GAP) / across);
    DOCK_H = Math.round(DOCK_W * 0.82);
    document.documentElement.style.setProperty('--dock-w', DOCK_W + 'px');
    document.documentElement.style.setProperty('--dock-h', DOCK_H + 'px');
    $('gridLabel').style.top = (GRID_TOP - 84) + 'px';
    items = ordered.apps.map(function (app) {
      var el = document.createElement('div');
      el.className = 'item';
      var card = document.createElement('div');
      card.className = 'card';
      // Shown as a background: webOS 22 ignores border-radius on <img>. The Image samples colours.
      var icon = document.createElement('div');
      icon.className = 'icon';
      icon.style.backgroundImage = 'url("' + app.icon + '")';
      card.appendChild(icon);
      var img = new Image();
      var item = { app: app, el: el, card: card, color: null };
      img.onload = function () { paintTile(item, img); };
      img.src = app.icon;
      el.appendChild(card);
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = shortName(app.title);
      card.appendChild(name);
      el.addEventListener('mouseover', function () {
        if (zone !== 'inputs' && !editing) focusTile(items.indexOf(item));
      });
      el.addEventListener('click', function () {
        if (editing) finishEdit(true);
        else launch(app.id, app.title);
      });
      tilesEl.appendChild(el);
      return item;
    });
    layout();
  }

  /** Places every tile by its position in items; tiles glide when the order changes. */
  function layout() {
    items.forEach(function (it, i) {
      var b = box(i);
      it.el.style.left = b.x + 'px';
      it.el.style.top = b.y + 'px';
      it.el.classList.toggle('dock', i < dockSize);
    });
    $('gridLabel').style.display = items.length > dockSize ? '' : 'none';
  }

  function animateIn() {
    items.forEach(function (it, i) {
      it.el.classList.remove('shown');
      setTimeout(function () { it.el.classList.add('shown'); }, 60 + Math.min(i, 16) * 40);
    });
  }

  /**
   * Tints the card with the app's colour: the background of a store icon (a logo on a solid
   * colour), or the app's own colour for LG's system icons, which are glyphs on transparent.
   */
  function paintTile(item, img) {
    var px = null, edge = null;
    try {
      var c = document.createElement('canvas');
      c.width = 12; c.height = 12;
      var g = c.getContext('2d');
      g.drawImage(img, 0, 0, 12, 12);
      px = g.getImageData(0, 0, 12, 12).data;
      edge = edgeColor(img);
    } catch (e) { /* tainted canvas: fall back to the app's colour */ }

    var glyph = !(edge && edge[3] > 200);
    var tint = glyph ? parseColor(item.app.iconColor) : [edge[0], edge[1], edge[2]];
    if (tint && rgbToHsv(tint)[1] < 0.15) tint = null;   // white, black or grey: keep the card neutral
    item.card.classList.toggle('glyph', glyph);
    if (tint) item.card.style.setProperty('--tint', tint.join(','));
    // A white glyph says nothing about the app: glow in the icon's colours instead.
    item.color = (glyph && tint) || (px ? vividColor(px) : parseColor(item.app.iconColor));
    if (items[focused] === item) setAmbient(item.color);
  }

  /**
   * The icon's background at full size: a corner pixel, or the middle of the left edge for rounded
   * icons whose corners are transparent. A downscaled sample would blend in the logo.
   */
  function edgeColor(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    var corner = g.getImageData(2, 2, 1, 1).data;
    return corner[3] > 200 ? corner : g.getImageData(2, Math.floor(h / 2), 1, 1).data;
  }

  /** A vivid colour from the icon: the most saturated, not too dark pixel, or the lifted average. */
  function vividColor(px) {
    var best = null, bestScore = -1, sum = [0, 0, 0], n = 0;
    for (var i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      var p = [px[i], px[i + 1], px[i + 2]];
      sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; n++;
      var hsv = rgbToHsv(p);
      var score = hsv[1] * Math.min(1, hsv[2] * 1.4);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!n) return [68, 68, 68];
    if (bestScore < 0.25) {   // nearly monochrome icon (e.g. white): its average, lifted
      var avg = rgbToHsv([sum[0] / n, sum[1] / n, sum[2] / n]);
      avg[2] = Math.max(avg[2], 0.55);
      return hsvToRgb(avg);
    }
    var h = rgbToHsv(best);
    h[1] = Math.min(1, h[1] * 1.1);
    h[2] = Math.max(0.5, h[2]);
    return hsvToRgb(h);
  }

  function parseColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    var v = parseInt(m[1], 16);
    return [v >> 16 & 255, v >> 8 & 255, v & 255];
  }

  function rgbToHsv(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max];
  }

  function hsvToRgb(hsv) {
    var h = hsv[0], s = hsv[1], v = hsv[2];
    var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgb.map(function (k) { return Math.round((k + m) * 255); });
  }

  // ---- focus & glass -------------------------------------------------------------------------

  function focusTile(i) {
    if (!items.length) return;
    i = Math.max(0, Math.min(i, items.length - 1));
    setZone('grid');
    if (items[focused]) items[focused].el.classList.remove('focused');
    focused = i;
    items[i].el.classList.add('focused');

    var b = box(i), row = rowOf(i);
    if (row === 0) {
      offset = 0;                   // home: the dock, with the grid out of sight below
    } else if (row === 1) {
      offset = GRID_PAGE;           // into the grid: page it up so it has the screen
    } else {
      // Scroll just enough so the whole focus ring and its glow are visible.
      if (b.y - offset + b.h + 24 > VIEW_BOTTOM) offset = b.y + b.h + 24 - VIEW_BOTTOM;
      if (b.y - offset - 24 < VIEW_TOP) offset = b.y - 24 - VIEW_TOP;
      offset = Math.max(offset, GRID_PAGE);
    }
    stage.style.transform = 'translateY(' + (-offset) + 'px)';
    document.body.classList.toggle('scrolled', offset > 0);   // the header slides away over the grid

    var w = b.w * FOCUS_SCALE + 2 * GLASS_PAD, h = b.h * FOCUS_SCALE + 2 * GLASS_PAD;
    var x = b.x + b.w / 2 - w / 2, y = b.y + b.h / 2 - h / 2;
    glass.style.setProperty('--tile-h', b.h + 'px');
    glass.style.width = w + 'px';
    glass.style.height = h + 'px';
    glass.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (!glassShown) {
      // First show: jump there without the spring, then fade in.
      glass.style.transition = 'none';
      glass.offsetWidth;   // flush the jump before restoring the transition
      glass.style.transition = '';
      glass.style.opacity = '1';
      glassShown = true;
    }

    setAmbient(items[i].color);   // the glow follows the focused tile
  }

  function hideGlass() {
    glassShown = false;
    glass.style.opacity = '0';
  }

  /** Crossfades the glow to a new colour by swapping between two layers. */
  function setAmbient(color) {
    if (!color) return;
    var key = color.join(',');
    if (key === ambientColor) return;
    ambientColor = key;
    var back = ambients[1 - ambientFront];
    back.style.background = 'radial-gradient(circle 1100px at 30% 50%, rgba(' + key + ',0.2) 0%, rgba(' +
      key + ',0.07) 50%, rgba(' + key + ',0) 100%)';
    back.style.opacity = '1';
    ambients[ambientFront].style.opacity = '0';
    ambientFront = 1 - ambientFront;
  }

  function focusPill(i) {
    setZone('top');
    document.body.classList.remove('scrolled');
    pills[pillFocus].classList.remove('focused');
    pillFocus = Math.max(0, Math.min(i, pills.length - 1));
    pills[pillFocus].classList.add('focused');
  }

  function setZone(z) {
    if (zone === z) return;
    if (zone === 'top') pills[pillFocus].classList.remove('focused');
    if (zone === 'grid') {
      if (items[focused]) items[focused].el.classList.remove('focused');
      hideGlass();
    }
    zone = z;
  }

  /** The pill straight above a dock tile, by horizontal distance. */
  function pillAbove(i) {
    var cx = centerX(i), best = 0, bestD = Infinity;
    pills.forEach(function (p, k) {
      var r = p.getBoundingClientRect();
      var d = Math.abs(r.left + r.width / 2 - cx);
      if (d < bestD) { bestD = d; best = k; }
    });
    return best;
  }

  // ---- top bar -------------------------------------------------------------------------------

  function updateClock() {
    var now = new Date(), h = now.getHours(), m = now.getMinutes();
    for (var k = 0; k < GREETINGS.length; k++) {
      if (h < GREETINGS[k][0]) { $('greeting').textContent = GREETINGS[k][1]; break; }
    }
    $('clock').textContent = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m;
    $('ampm').textContent = h < 12 ? 'am' : 'pm';
    $('date').textContent = DAYS[now.getDay()] + ', ' + now.getDate() + ' ' + MONTHS[now.getMonth()];
  }

  /** Shows the Wi-Fi network name when the TV reports it, otherwise the connection type. */
  function watchNetwork() {
    luna('luna://com.palm.connectionmanager/getStatus', { subscribe: true }, function (res) {
      if (res.returnValue === false && !res.wifi && !res.wired) return;
      var text = 'Wi-Fi';
      if (res.wired && res.wired.state === 'connected') text = 'Ethernet';
      else if (res.wifi && res.wifi.state === 'connected') text = res.wifi.ssid || 'Wi-Fi';
      else if (res.isInternetConnectionAvailable === false) text = 'Offline';
      $('wifiLabel').textContent = text;
    });
  }

  function activatePill(i) {
    if (i === 0) showInputs();
    else if (i === 1) launch('com.palm.app.settings', 'Settings', { target: 'network' });
    else launch('com.palm.app.settings', 'Settings');
  }

  // ---- inputs dropdown -----------------------------------------------------------------------

  function showInputs() {
    panel.innerHTML = '';
    inputRows = [];
    var inputs = (window.TV_APPS && TV_APPS.inputs) || [];
    inputs.forEach(function (inp) { addInputRow(ICON_INPUT, inp.label, inp.appId); });
    if (CONFIG.liveTvApp) {
      if (inputRows.length) panel.appendChild(Object.assign(document.createElement('div'), { className: 'separator' }));
      addInputRow(ICON_LIVETV, 'Live TV', CONFIG.liveTvApp);
    }
    if (!inputRows.length) { toast('No inputs found'); return; }

    // Hang below the Inputs button, lined up with its right edge: the edge that stays put while
    // the focused button widens and narrows.
    var r = pills[0].getBoundingClientRect();
    panel.style.right = (1920 - r.right) + 'px';
    panel.style.top = (r.bottom + 16) + 'px';
    panel.classList.remove('hidden');
    pills[pillFocus].classList.remove('focused');
    zone = 'inputs';
    focusInput(0);
  }

  function addInputRow(icon, label, appId) {
    var row = document.createElement('div');
    row.className = 'inputRow';
    row.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + icon + '"/></svg>';
    row.appendChild(document.createTextNode(label));
    var idx = inputRows.length;
    row.addEventListener('mouseover', function () { focusInput(idx); });
    row.addEventListener('click', function () { hideInputs(); launch(appId, label); });
    row.appId = appId;
    row.label = label;
    inputRows.push(row);
    panel.appendChild(row);
  }

  function focusInput(i) {
    if (inputRows[inputFocus]) inputRows[inputFocus].classList.remove('focused');
    inputFocus = Math.max(0, Math.min(i, inputRows.length - 1));
    inputRows[inputFocus].classList.add('focused');
  }

  function hideInputs() {
    panel.classList.add('hidden');
    zone = 'none';
    focusPill(0);
  }

  // ---- rearranging ---------------------------------------------------------------------------

  /** Hold OK on a tile: it wiggles, the arrows move it, OK places it, Back puts everything back. */
  function startEdit() {
    var it = items[focused];
    if (!it) return;
    editing = { item: it, snapshot: items.slice() };
    it.el.classList.add('moving');
    document.body.classList.add('editing');
    toast('Arrows to move  ·  OK to place  ·  Back to cancel');
  }

  function moveTo(to) {
    if (to < 0 || to >= items.length || to === focused) return;
    items.splice(to, 0, items.splice(focused, 1)[0]);
    focused = to;
    layout();
    focusTile(to);
  }

  function finishEdit(keep) {
    var it = editing.item;
    if (!keep) {
      items = editing.snapshot;
      layout();
    }
    editing = null;
    it.el.classList.remove('moving');
    document.body.classList.remove('editing');
    if (keep) saveOrder();
    focused = items.indexOf(it);
    focusTile(focused);
  }

  // ---- keys ----------------------------------------------------------------------------------

  var LONG_PRESS_MS = 600;
  var okDown = false, okTimer = null;

  // On tiles OK acts on release, so a held OK can start rearranging instead of opening the app.
  document.addEventListener('keyup', function (e) {
    if (e.keyCode !== KEY.OK) return;
    okDown = false;
    if (!okTimer) return;
    clearTimeout(okTimer);
    okTimer = null;
    var it = items[focused];
    if (zone === 'grid' && it && !editing) launch(it.app.id, it.app.title);
  });

  document.addEventListener('keydown', function (e) {
    var k = e.keyCode;
    if (k === KEY.OK && okDown) { e.preventDefault(); return; }   // key repeat while held
    if (k === KEY.OK) okDown = true;
    var row = rowOf(focused);
    if (editing) {
      if (k === KEY.LEFT) moveTo(focused - 1);
      else if (k === KEY.RIGHT) moveTo(focused + 1);
      else if (k === KEY.UP) { if (row > 0) moveTo(nearestIn(row - 1, centerX(focused))); }
      else if (k === KEY.DOWN) moveTo(row < lastRow() ? nearestIn(row + 1, centerX(focused)) : items.length - 1);
      else if (k === KEY.OK) finishEdit(true);
      else if (k === KEY.BACK || k === KEY.ESC) finishEdit(false);
      else return;
    } else if (zone === 'inputs') {
      if (k === KEY.UP) focusInput(inputFocus - 1);
      else if (k === KEY.DOWN) focusInput(inputFocus + 1);
      else if (k === KEY.OK) { var row = inputRows[inputFocus]; hideInputs(); launch(row.appId, row.label); }
      else if (k === KEY.BACK || k === KEY.ESC || k === KEY.LEFT || k === KEY.RIGHT) hideInputs();
      else return;
    } else if (zone === 'top') {
      if (k === KEY.LEFT) focusPill(pillFocus - 1);
      else if (k === KEY.RIGHT) focusPill(pillFocus + 1);
      else if (k === KEY.DOWN) focusTile(rowOf(focused) === 0 ? focused : 0);
      else if (k === KEY.OK) activatePill(pillFocus);
      else if (k === KEY.BACK) { /* home screen: Back goes nowhere */ }
      else return;
    } else {
      if (k === KEY.LEFT) { if (focused > rowStart(row)) focusTile(focused - 1); }
      else if (k === KEY.RIGHT) { if (focused < rowEnd(row)) focusTile(focused + 1); }
      else if (k === KEY.UP) {
        if (row === 0 || !items.length) focusPill(pillAbove(focused));
        else focusTile(nearestIn(row - 1, centerX(focused)));
      } else if (k === KEY.DOWN) {
        if (row < lastRow()) focusTile(nearestIn(row + 1, centerX(focused)));
      } else if (k === KEY.OK) {
        okTimer = setTimeout(function () { okTimer = null; startEdit(); }, LONG_PRESS_MS);
      } else if (k === KEY.BACK) { /* home screen: Back goes nowhere */ }
      else return;
    }
    e.preventDefault();
  });

  pills.forEach(function (p, i) {
    p.addEventListener('mouseover', function () { if (zone !== 'inputs') focusPill(i); });
    p.addEventListener('click', function () { activatePill(i); });
  });

  // ---- lifecycle -----------------------------------------------------------------------------

  /** Back from another app (or opened again from the shortcut): replay the entrance, keep the tile. */
  function resume() {
    if (editing) finishEdit(false);
    updateClock();
    if (zone === 'inputs') panel.classList.add('hidden');
    pills.forEach(function (p) { p.classList.remove('focused'); });
    zone = 'none';
    animateIn();
    focusTile(focused);
  }

  document.addEventListener('webOSRelaunch', resume);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });

  build();
  updateClock();
  setInterval(updateClock, 10000);
  watchNetwork();
  // Wakes the Home watcher (service/), which then keeps itself running and reopens this launcher
  // whenever LG's home comes up.
  luna('luna://com.gathin.tvhome.service/start', {});
  animateIn();
  zone = 'none';
  focusTile(0);
})();
