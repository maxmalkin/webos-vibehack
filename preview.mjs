// Serves the launcher at http://localhost:8000 to try it in a desktop browser: arrow keys, Enter,
// hold Enter to rearrange, Esc to cancel. Zoom out (⌘−) to fit the 1920x1080 screen.
// Shows your TV's apps once sync-apps.py has written app/apps.js, otherwise a demo set.
//   npm run preview
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const APP_DIR = new URL('app/', import.meta.url).pathname;
const PORT = process.env.PORT || 8000;

// [id, title, background, text colour]; no background = a transparent LG system icon (glyph).
const DEMO = [
  ['netflix', 'Netflix', '#000000', '#e50914'], ['amazon', 'Prime Video', '#1a98ff', '#fff'],
  ['demo.paramount', 'Paramount+', '#0064ff', '#fff'], ['demo.peacock', 'Peacock TV', '#000000', '#fff'],
  ['youtube.leanback.v4', 'YouTube', '#ffffff', '#ff0000'], ['hotstar', 'JioHotstar', '#1f80e0', '#fff'],
  ['com.apple.appletv', 'Apple TV', '#000000', '#fff'], ['disney', 'Disney+', '#0e2a6b', '#fff'],
  ['spotify', 'Spotify', '#1db954', '#000'], ['crunchyroll', 'Crunchyroll', '#f47521', '#fff'],
  ['sonyliv', 'SonyLIV', '#111111', '#f2c94c'], ['zee5', 'ZEE5', '#8230c6', '#fff'],
  ['twitch', 'Twitch', '#9146ff', '#fff'], ['plex', 'Plex', '#1f1f1f', '#e5a00d'],
  ['applemusic', 'Apple Music', '#fa2d48', '#fff'], ['youtube.music', 'YouTube Music', '#212121', '#ff0000'],
  ['jiocinema', 'JioCinema', '#d4145a', '#fff'], ['mxplayer', 'MX Player', '#0a6bff', '#fff'],
  ['com.webos.app.browser', 'Web Browser', '', '#e54b4b'], ['com.webos.app.photovideo', 'Photo & Video', '', '#4a9dff'],
  ['com.webos.app.music', 'Music', '', '#ff5a7e'], ['com.webos.app.discovery', 'Apps', '', '#d1386c'],
  ['com.webos.app.sports', 'Sports', '', '#2bb673'], ['com.webos.app.connectionwizard', 'Connection Guide', '', '#ffffff'],
  ['com.webos.app.livetv', 'Live TV', '', '#ffffff'], ['com.webos.app.hdmi1', 'HDMI 1', '', '#ffffff'],
];

function demoIcon(title, bg, fg) {
  if (!bg) {   // glyph: white shape on transparent, like LG's own icons
    return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect x="90" y="90" width="120" height="120" rx="28" fill="none" stroke="#fff" stroke-width="16"/><circle cx="150" cy="150" r="22" fill="#fff"/></svg>`;
  }
  const size = Math.min(64, 520 / title.length);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${bg}"/>` +
    `<text x="150" y="150" dy="0.35em" text-anchor="middle" font-family="Helvetica, Arial" font-weight="700" font-size="${size}" fill="${fg}">${title}</text></svg>`;
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const send = (body, file) => res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || '' }).end(body);
  const synced = fs.existsSync(path.join(APP_DIR, 'apps.js'));
  if (!synced && url === '/apps.js') {
    const apps = DEMO.map(([id, title, bg, fg]) => ({ id, title, icon: `demo/${id}.svg`, iconColor: bg ? '' : fg }));
    const inputs = [{ appId: 'com.webos.app.hdmi1', label: 'HDMI 1' }, { appId: 'com.webos.app.hdmi2', label: 'PlayStation 5' }];
    return send(`window.TV_APPS = ${JSON.stringify({ apps, inputs })};`, url);
  }
  const demo = DEMO.find(([id]) => url === `/demo/${id}.svg`);
  if (demo) return send(demoIcon(...demo.slice(1)), url);
  const file = path.join(APP_DIR, url === '/' ? 'index.html' : url);
  if (file.startsWith(APP_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(fs.readFileSync(file), file);
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`Launcher preview: http://localhost:${PORT}  (Ctrl+C to stop)`));
