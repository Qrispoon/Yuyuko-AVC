import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = await fs.readFile(path.join(root, 'demos/startup-watercolor/index.html'), 'utf8');
const artwork = demo.match(/<svg id="study"[\s\S]*?<\/svg>/)?.[0];
if (!artwork || !artwork.includes('wash-painting')) throw new Error('Build the watercolor preview first.');
const svg = artwork.replaceAll('assets/painting.png', '/assets/yuyuko-startup.png')
  .replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, '')
  .replace(/<desc\b[^>]*>[\s\S]*?<\/desc>/g, '');
await fs.copyFile(path.join(root, 'demos/startup-watercolor/assets/painting.png'), path.join(root, 'web/assets/yuyuko-startup.png'));
await fs.writeFile(path.join(root, 'web/startup.html'), `<!doctype html>
<html lang="zh-CN" class="preparing">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f2eb">
  <title>少女祈祷中</title>
  <link rel="icon" type="image/jpeg" href="/assets/yuyuko-avatar.jpg">
  <link rel="preload" as="image" href="/assets/yuyuko-startup.png">
  <link rel="stylesheet" href="/startup.css">
  <script src="/startup-art.js" defer></script>
  <script src="/startup.js" defer></script>
</head>
<body>
  <main class="studio" id="studio" aria-busy="true">
    <div class="art-holder" id="art-holder" aria-hidden="true">
      <div class="study-layer" id="study-layer">${svg}</div>
      <div class="finish-layer" id="finish-layer"><img id="painting" src="/assets/yuyuko-startup.png" width="915" height="1330" alt="" decoding="async" fetchpriority="high"></div>
    </div>
    <p class="status">少女祈祷中</p>
    <button id="enter" type="button" disabled>进入</button>
  </main>
</body>
</html>
`, 'utf8');
console.log('Built web/startup.html and its local painting asset.');
