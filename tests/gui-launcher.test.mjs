import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = await import('node:net').then(({ createServer }) => createServer());
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, { holdStartup = false, invalidConfig = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-gui-launcher-'));
  const configFile = path.join(dir, 'config.json');
  const emptyDir = path.join(dir, 'empty-media');
  await fs.mkdir(emptyDir);
  if (invalidConfig) await fs.writeFile(configFile, '{', 'utf8');
  else {
    const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
    config.paths.dataDir = path.join(dir, 'data');
    await fs.writeFile(configFile, JSON.stringify(config), 'utf8');
  }
  const port = await freePort();
  const gate = path.join(dir, 'backend-start.release');
  const releaseStartup = () => holdStartup ? fs.writeFile(gate, 'release') : Promise.resolve();
  const preload = holdStartup ? ['--import', pathToFileURL(path.join(ROOT, 'tests/helpers/backend-start-gate.mjs')).href] : [];
  const child = spawn(process.execPath, [...preload, path.join(ROOT, 'src/gui-launcher.mjs')], {
    cwd: ROOT,
    env: { ...process.env, AVC_NO_BROWSER: '1', AVC_PORT: String(port), AVC_CONFIG_FILE: configFile, AVC_STARTUP_DELAY_MS: '0', AVC_TEST_BACKEND_START_GATE: holdStartup ? gate : '' },
    stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await releaseStartup();
    if (child.exitCode == null) {
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.send({type:'shutdown'});
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function state() {
    try { return await fetch(`${base}/__avc/startup`).then(r => r.json()); } catch { return null; }
  }
  async function waitFor(predicate, timeout = 10000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = await predicate();
      if (value) return value;
      if (child.exitCode != null) throw new Error(`launcher exited ${child.exitCode}`);
      await delay(40);
    }
    throw new Error(`launcher state timed out: ${JSON.stringify(await state())}`);
  }
  const initial = await waitFor(async () => {
    const response = await fetch(base).catch(() => null);
    if (!response) return null;
    return { response, body: await response.text() };
  });
  if (holdStartup) await waitFor(() => fs.stat(gate + '.held').then(() => true, () => false));
  return { child, base, emptyDir, initial, state, waitFor, releaseStartup };
}

test('launcher serves startup immediately, gates APIs, and forwards health and SSE after readiness', async t => {
  const app = await fixture(t, { holdStartup: true });
  assert.equal(app.initial.response.status, 200);
  assert.match(app.initial.body, /少女祈祷中/);
  assert.equal((await fetch(`${app.base}/api/health`)).status, 503);
  assert.equal((await app.state()).phase, 'initializing');
  for (const [url, type] of [['/startup-art.js', 'text/javascript'], ['/assets/yuyuko-startup.png', 'image/png'], ['/assets/yuyuko-avatar.jpg', 'image/jpeg']]) {
    const response = await fetch(`${app.base}${url}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
  }

  // Readiness cannot race the assertions above, regardless of client scheduling.
  await app.releaseStartup();
  await app.waitFor(async () => (await app.state())?.phase === 'ready');
  const health = await fetch(`${app.base}/api/health`).then(r => r.json());
  assert.equal(health.ok, true);
  const page = await fetch(app.base).then(r => r.text());
  assert.match(page, /id="view-work"/);
  const startup = await fetch(`${app.base}/startup.html`).then(r => r.text());
  assert.match(startup, /少女祈祷中/);
  assert.match(startup, /id="enter"[^>]*>进入<\/button>/);
  const jobs = await fetch(`${app.base}/api/jobs`).then(r => r.json());
  assert.deepEqual(jobs.jobs, []);
  const created = await fetch(`${app.base}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',Origin:app.base },
    body: JSON.stringify({ dir: app.emptyDir, kind: 'plan' }),
  }).then(r => r.json());
  const events = await fetch(`${app.base}/api/jobs/${created.jobId}/events`);
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  assert.match(await events.text(), /"type":"snapshot"/);
});

test('launcher reports bad configuration as a finite startup failure', async t => {
  const app = await fixture(t, { invalidConfig: true });
  const failed = await app.waitFor(async () => {
    const value = await app.state();
    return value?.phase === 'failed' ? value : null;
  });
  assert.equal(failed.error, 'backend_health_500');
  assert.equal((await fetch(app.base)).status, 200);
  const blocked = await fetch(`${app.base}/api/health`);
  assert.equal(blocked.status, 503);
  assert.equal((await blocked.json()).error, 'backend_start_failed');
});

test('health polling alone recovers readiness after each restart and root serves the workbench', async t => {
  const app = await fixture(t);
  const health = () => fetch(`${app.base}/api/health`, { signal: AbortSignal.timeout(1200) })
    .then(async response => response.ok ? response.json() : null).catch(() => null);
  let before = await app.waitFor(health);
  assert.equal(before.ok, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${app.base}/api/maintenance/restart`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',Origin:app.base }, body: '{}',
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).instanceId, before.instanceId);
    // Do not call /__avc/startup: the existing workbench never loads that route
    // while waiting for its replacement backend.
    const after = await app.waitFor(async () => {
      const next = await health();
      return next?.ok && next.instanceId !== before.instanceId ? next : null;
    });
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.maintenance, null);
    const root = await fetch(`${app.base}/?dir=isolated`).then(r => r.text());
    assert.match(root, /id="view-work"/);
    assert.doesNotMatch(root, /id="enter"/);
    before = after;
  }
});
