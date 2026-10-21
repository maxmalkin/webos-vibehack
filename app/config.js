// Launcher configuration. Edit this file, then run ./install.sh.
// App ids: run `python3 sync-apps.py --list` (or look in app/apps.js after a sync).
window.CONFIG = {
  // The dock on the home screen, in this order: app ids, or the start of an app's name ('peacock'
  // finds 'Peacock TV'). Missing apps are skipped. Every other app is in the grid below it.
  dockApps: ['netflix', 'amazon', 'com.cbs-all-access.webapp.prod', 'youtube.leanback.v4', 'com.peacock.tv'],

  // Apps never shown as tiles (inputs and Live TV are already in the Inputs menu).
  hiddenApps: [
    'com.gathin.tvhome',
    'com.webos.app.livetv',
    'com.webos.app.hdmi1', 'com.webos.app.hdmi2', 'com.webos.app.hdmi3', 'com.webos.app.hdmi4',
    'com.webos.app.lgchannels',   // LG Channels
    'shortcutcopilot'             // Copilot
  ],

  // The Live TV app, offered at the end of the Inputs menu. Leave empty to omit.
  liveTvApp: 'com.webos.app.livetv',

  // Tiles per row in the grid below the dock. Tile size follows: 5 = big, 7 = small.
  columns: 7,

  // Background image in app/ (any 1920x1080 JPG or PNG). Leave empty for a plain gradient.
  wallpaper: 'wallpaper.jpg'
};
