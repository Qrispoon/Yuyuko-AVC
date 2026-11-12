import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/main.js', ['main.js', 'text/javascript; charset=utf-8']],
  ['/web/startup-art.js', ['../../web/startup-art.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/assets/painting.svg', ['assets/painting.svg', 'image/svg+xml']],
  ['/assets/painting.png', ['assets/painting.png', 'image/png']],
]);
const server = http.createServer(async (req, res) => {
  const file = files.get(new URL(req.url, 'http://127.0.0.1').pathname);
  if (!file) { res.writeHead(404).end(); return; }
  try {
    const content = await fs.readFile(path.join(directory, file[0]));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch { res.writeHead(500).end('Demo file missing; run node demos/startup-watercolor/build.mjs.'); }
});
server.listen(Number(process.env.AVC_DEMO_PORT || 0), '127.0.0.1', () => console.log(`DEMO_URL=http://127.0.0.1:${server.address().port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
