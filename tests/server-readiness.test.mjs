import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { waitForOwnedHealth } from './helpers/owned-server.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('owned health rejects another process before accepting an occupied port', async () => {
  let requests = 0;
  const other = http.createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, pid: process.pid, instanceId: 'owned-mock-other-process' }));
  });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${other.address().port}`;
  // This child never touches a port. IPC makes its readiness independent of timing.
  const child = spawn(process.execPath, ['-e', "process.on('message',()=>process.exit(0));process.send('ready')"], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  try {
    await once(child, 'message');
    assert.notEqual(child.pid, process.pid);
    await assert.rejects(waitForOwnedHealth(base, child), error => {
      assert.equal(error.code, 'SERVER_IDENTITY_MISMATCH');
      assert.match(error.message, new RegExp(`expected PID ${child.pid}, got ${process.pid}`));
      return true;
    });
    assert.equal(requests, 1, 'identity mismatch must fail without retrying or mutating the other service');
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'close'); child.send('stop'); await stopped; }
    await new Promise(resolve => other.close(resolve));
  }
});

test('owned health reports an exited child before contacting any service', async () => {
  await assert.rejects(waitForOwnedHealth('http://127.0.0.1:1', {
    pid: 123, exitCode: 7, signalCode: null,
  }, () => 'owned child: EADDRINUSE'), /exited before readiness \(7\).*EADDRINUSE/);
});

test('owned health accepts a real isolated backend with the exact child PID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-owned-health-'));
  let child;
  try {
    const configFile = path.join(root, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ paths: { dataDir: path.join(root, 'data') },
      fs: { enabled: true, allowedRoots: [root] } }));
    child = spawn(process.execPath, [path.join(ROOT, 'src/server.mjs'), '--port', '0', '--config', configFile], {
      cwd: ROOT, env: { ...process.env, AVC_GUI_WORKER: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let output = ''; child.stderr.on('data', chunk => output += chunk);
    const [listening] = await once(child, 'message');
    assert.equal(listening.type, 'listening');
    const health = await waitForOwnedHealth(`http://127.0.0.1:${listening.port}`, child, () => output);
    assert.equal(health.pid, child.pid);
    assert.equal(health.ok, true);
    assert.equal(typeof health.instanceId, 'string');
  } finally {
    if (child?.exitCode === null) { const stopped = once(child, 'close'); child.send({type:'shutdown'}); await stopped; }
    await fs.rm(root, { recursive: true, force: true });
  }
});
