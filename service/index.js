// Home watcher, running on the TV beside the launcher.
//
// webOS hides the foreground app from Developer Mode apps, but the TV's remote-control service
// (the one LG's phone app uses) shares it, and it answers on the TV's own loopback address too.
// So this connects there like a phone would, pairs once (the TV asks to allow it), watches the
// foreground app and opens the launcher whenever LG's home comes up.
var Service = require('webos-service');
var fs = require('fs');
var WebSocket = require('ws');
var homeRedirect = require('./home');

var LAUNCHER = 'com.gathin.tvhome', LG_HOME = 'com.webos.app.home', ESCAPE_MS = 3000;
var TV = 'wss://127.0.0.1:3001';
var KEY_FILE = __dirname + '/.ssap-key';   // the pairing; a reinstall asks again
// The set tested on a webOS 22 TV.
var PERMISSIONS = ['LAUNCH', 'LAUNCH_WEBAPP', 'APP_TO_APP', 'CLOSE', 'TEST_OPEN', 'TEST_PROTECTED', 'CONTROL_AUDIO',
  'CONTROL_DISPLAY', 'CONTROL_INPUT_JOYSTICK', 'CONTROL_INPUT_MEDIA_RECORDING', 'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_TV', 'CONTROL_POWER', 'READ_APP_STATUS', 'READ_CURRENT_CHANNEL', 'READ_INPUT_DEVICE_LIST',
  'READ_NETWORK_STATE', 'READ_RUNNING_APPS', 'READ_TV_CHANNEL_LIST', 'WRITE_NOTIFICATION_TOAST',
  'READ_POWER_STATE', 'READ_COUNTRY_INFO'];

var service = new Service('com.gathin.tvhome.service');
var started = false;

function readKey() { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) { return null; } }

function connect() {
  var shouldOpen = homeRedirect(LAUNCHER, LG_HOME, ESCAPE_MS);
  var ws = new WebSocket(TV, { rejectUnauthorized: false, handshakeTimeout: 10000 });   // the TV's own certificate
  ws.on('open', function () {
    var payload = { forcePairing: false, pairingType: 'PROMPT', manifest: { manifestVersion: 1, appVersion: '1.1', permissions: PERMISSIONS } };
    var key = readKey();
    if (key) payload['client-key'] = key;
    ws.send(JSON.stringify({ type: 'register', id: 'reg', payload: payload }));
  });
  ws.on('message', function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.id === 'reg' && msg.type === 'registered') {
      var key = msg.payload['client-key'];
      if (key !== readKey()) {
        try { fs.writeFileSync(KEY_FILE, key); } catch (e) { console.error('home watcher: cannot save pairing', e.message); }
      }
      ws.send(JSON.stringify({ type: 'subscribe', id: 'fg', payload: {},
        uri: 'ssap://com.webos.applicationManager/getForegroundAppInfo' }));
    } else if (msg.id === 'fg' && msg.payload && shouldOpen(msg.payload.appId, Date.now())) {
      ws.send(JSON.stringify({ type: 'request', id: 'launch', uri: 'ssap://system.launcher/launch',
        payload: { id: LAUNCHER } }));
    }
  });
  ws.on('error', function (e) { console.error('home watcher:', e.message); });
  ws.on('close', function () { setTimeout(connect, 5000); });   // TV asleep or service restarted
}

// The launcher wakes this on start. Then a keep-alive activity stops webOS ending it when idle.
service.register('start', function (message) {
  message.respond({ returnValue: true });
  if (started) return;
  started = true;
  service.activityManager.create('keepAlive', function () {});
  connect();
});
