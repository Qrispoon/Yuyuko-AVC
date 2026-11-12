import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Render once at build time: animating a mask over an external SVG makes some
// browsers rasterize all of its fine pigment paths again on every paint.
export async function renderPainting(directory) {
  const require = createRequire(import.meta.url);
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch {
    const runtime = process.env.AVC_PLAYWRIGHT_PATH || path.join(process.env.USERPROFILE || '',
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    ({ chromium } = require(runtime));
  }
  const chrome = process.env.AVC_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 915, height: 1330 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(path.join(directory, 'assets/painting.svg')).href);
    await page.screenshot({ path: path.join(directory, 'assets/painting.png'), omitBackground: true });
  } finally { await browser.close(); }
}
