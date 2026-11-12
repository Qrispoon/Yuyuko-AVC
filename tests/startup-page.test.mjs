import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const script = (await fs.readFile(new URL('../web/startup.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');

async function page({ reduced = false, loaded = true, phase = 'ready', pathname = '/startup.html', standalone = false } = {}) {
  let now = 0, nextId = 0, retryCalls = 0, reloadCalls = 0;
  const timers = new Map(), navigations = [];
  const element = () => {
    const classes = new Set(), listeners = new Map();
    return {
      style: {}, disabled: false,
      classList: {
        add: (...values) => values.forEach(c => classes.add(c)),
        remove: (...values) => values.forEach(c => classes.delete(c)),
        contains: c => classes.has(c),
      },
      setAttribute() {},
      addEventListener: (type, callback) => listeners.set(type, callback),
      dispatch: type => listeners.get(type)?.(),
    };
  };
  const image = Object.assign(element(), {
    complete: loaded, naturalWidth: loaded ? 1830 : 0,
    decode: async () => { if (!image.naturalWidth) throw new Error('image_failed'); },
  });
  const nodes = { painting: image, studio: element(), enter: element() };
  nodes.enter.disabled = true;
  const document = Object.assign(element(), {
    hidden: false, body: element(), documentElement: element(),
    getElementById: id => nodes[id], timeline: { get currentTime() { return now; } },
  });
  document.documentElement.classList.add('preparing');
  let paused = true, current = 0, start = 0;
  const master = {
    get currentTime() { return paused ? current : now - start; },
    set currentTime(value) { current = value; if (!paused) start = now - value; },
    set startTime(value) { start = value; },
    play() { start = now - current; paused = false; },
    pause() { current = this.currentTime; paused = true; },
  };
  const addTimer = (callback, ms) => { const id = ++nextId; timers.set(id, { callback, due: now + ms }); return id; };
  const context = vm.createContext({
    document, performance: { now: () => now },
    location: { pathname, search: '?dir=isolated', hash: '#work',
      replace: url => navigations.push({ at: now, url }),
      reload: () => { reloadCalls++; navigations.push({ at: now, url: '/?dir=isolated#work' }); },
    },
    matchMedia: () => ({ matches: reduced, addEventListener() {} }),
    createStartupArtwork: () => ({ duration: 8.6, animations: [master], master }),
    AbortSignal: { timeout: () => undefined },
    fetch: async url => {
      if (url === '/__avc/retry') { retryCalls++; phase = 'initializing'; }
      if (standalone && url === '/__avc/startup') return { ok: false, status: 404 };
      if (standalone && url === '/api/health') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ phase }) };
    },
    setTimeout: addTimer, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: callback => addTimer(() => callback(now), 16),
    cancelAnimationFrame: id => timers.delete(id),
  });
  async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) break;
      const [id, timer] = entry;
      timers.delete(id); now = timer.due; timer.callback(); await flush();
    }
    now = target; await flush();
  }
  vm.runInContext(script, context); await flush();
  return { image, nodes, document, master, navigations, advance,
    setPhase: next => { phase = next; }, get retryCalls() { return retryCalls; },
    get reloadCalls() { return reloadCalls; } };
}

test('opening holds the blank drawing for 600ms after preparation, then plays the full animation', async () => {
  const app = await page();
  await app.advance(80);
  assert.equal(app.document.documentElement.classList.contains('preparing'), false);
  await app.advance(599);
  assert.equal(app.master.currentTime, 0);
  await app.advance(101);
  assert.ok(app.master.currentTime > 0);
  await app.advance(8000);
  assert.equal(app.navigations.length, 0);
  await app.advance(1000);
  assert.equal(app.navigations.length, 1);
  assert.equal(app.navigations[0].url, '/?dir=isolated#work');
  await app.advance(10000);
  assert.equal(app.navigations.length, 1);
});

test('standalone backend can finish the startup animation using its health endpoint', async () => {
  const app = await page({ standalone: true });
  await app.advance(8500);
  assert.equal(app.navigations.length, 0);
  await app.advance(1500);
  assert.equal(app.navigations.length, 1);
  assert.equal(app.navigations[0].url, '/?dir=isolated#work');
});

test('slow asset decoding cannot consume the pause or drawing time', async () => {
  const app = await page({ loaded: false });
  await app.advance(3000);
  assert.equal(app.navigations.length, 0);
  app.image.complete = true; app.image.naturalWidth = 1830; app.image.dispatch('load');
  await app.advance(0);
  await app.advance(9500);
  assert.equal(app.navigations.length, 0);
  await app.advance(200);
  assert.equal(app.navigations.length, 1);
});

test('slow backend holds the finished painting until ready', async () => {
  const app = await page({ phase: 'initializing' });
  await app.advance(15000);
  assert.equal(app.navigations.length, 0);
  assert.equal(app.master.currentTime, 8600);
  app.setPhase('ready'); await app.advance(1000);
  assert.equal(app.navigations.length, 1);
});

test('enter waits one second, fades in, and can skip only after its reveal and backend readiness', async () => {
  const app = await page({ phase: 'initializing' });
  app.nodes.enter.dispatch('click'); await app.advance(350);
  assert.equal(app.navigations.length, 0);
  app.setPhase('ready'); await app.advance(250);
  assert.equal(app.nodes.enter.disabled, true);
  assert.equal(app.nodes.enter.classList.contains('enter-visible'), false);
  app.nodes.enter.dispatch('click'); await app.advance(399);
  assert.equal(app.navigations.length, 0);
  assert.equal(app.nodes.enter.classList.contains('enter-visible'), false);
  await app.advance(1);
  assert.equal(app.nodes.enter.classList.contains('enter-visible'), true);
  assert.equal(app.nodes.enter.disabled, true);
  app.nodes.enter.dispatch('click'); await app.advance(1599);
  assert.equal(app.navigations.length, 0);
  assert.equal(app.nodes.enter.disabled, true);
  await app.advance(1);
  assert.equal(app.nodes.enter.disabled, false);
  app.nodes.enter.dispatch('click'); await app.advance(300);
  assert.equal(app.navigations.length, 1);
});

test('backend failure reuses enter for retry and never navigates into an unavailable workbench', async () => {
  const app = await page({ phase: 'failed' });
  await app.advance(10000);
  assert.equal(app.navigations.length, 0);
  assert.equal(app.nodes.enter.disabled, false);
  app.nodes.enter.dispatch('click'); await app.advance(100);
  assert.equal(app.retryCalls, 1);
  assert.equal(app.nodes.enter.disabled, true);
  app.setPhase('ready'); await app.advance(1000);
  assert.equal(app.navigations.length, 1);
});

test('startup served at the root reloads the document instead of navigating to the same hash', async () => {
  const app = await page({ pathname: '/' });
  await app.advance(2600);
  app.nodes.enter.dispatch('click'); await app.advance(300);
  assert.equal(app.reloadCalls, 1);
  assert.equal(app.navigations[0].url, '/?dir=isolated#work');
  await app.advance(10000);
  assert.equal(app.reloadCalls, 1);
});

test('hidden tabs preserve the opening pause and the remaining drawing time', async () => {
  const app = await page();
  await app.advance(280);
  app.document.hidden = true; app.document.dispatch('visibilitychange');
  await app.advance(10000);
  assert.equal(app.master.currentTime, 0);
  assert.equal(app.navigations.length, 0);
  app.document.hidden = false; app.document.dispatch('visibilitychange');
  await app.advance(399); assert.equal(app.master.currentTime, 0);
  await app.advance(2000);
  app.document.hidden = true; app.document.dispatch('visibilitychange');
  const held = app.master.currentTime;
  await app.advance(10000); assert.equal(app.master.currentTime, held);
  app.document.hidden = false; app.document.dispatch('visibilitychange');
  await app.advance(6500); assert.equal(app.navigations.length, 0);
  await app.advance(1000); assert.equal(app.navigations.length, 1);
});

test('reduced motion shows the complete painting and enters without waiting for playback', async () => {
  const app = await page({ reduced: true });
  await app.advance(100);
  assert.equal(app.master.currentTime, 8600);
  assert.equal(app.navigations.length, 1);
});

test('failed image loading cannot block a healthy workbench indefinitely', async () => {
  const app = await page({ loaded: false });
  app.image.dispatch('error'); await app.advance(300);
  assert.equal(app.navigations.length, 1);
});

test('production startup markup contains exactly the requested text and one button', async () => {
  const html = await fs.readFile(new URL('../web/startup.html', import.meta.url), 'utf8');
  const body = html.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<svg\b[\s\S]*?<\/svg>/g, '');
  assert.equal(body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), '少女祈祷中 进入');
  assert.equal((body.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(body, /<(?:a|input|select)\b/);
});
