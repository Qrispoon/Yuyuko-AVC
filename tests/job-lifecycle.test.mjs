import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { requestJson, waitFor, waitForJob } from './helpers/job-lifecycle.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-job-lifecycle-'));
  const data = path.join(root, 'data'), videos = path.join(root, 'videos');
  await fs.mkdir(videos);
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ paths: { dataDir: data },
    media: { probeDuration: 'off' }, covers: { download: false, embed: false },
    subs: { sources: ['local'], localDirs: [root] }, fs: { enabled: true, allowedRoots: [root] } }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, data, videos, configFile };
}

// Gate only the worker's lease in this test's private directory. The first
// unlink belongs to the submission request; the second belongs to its worker.
function holdWorkerRelease(t, data, { fail = false } = {}) {
  const unlink = fs.unlink, lease = path.join(data, '.mutator-lease.json');
  let count = 0, entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'unlink', async function(file, ...args) {
    if (path.resolve(file) === lease && ++count === 2) {
      entered = true;
      await gate;
      if (fail) throw Object.assign(new Error('synthetic owned lease release failure'), { code: 'EACCES' });
    }
    return unlink.call(this, file, ...args);
  });
  return { entered: () => entered, release, lease };
}

for (const status of ['done', 'needs_review']) {
  test(`worker publishes ${status} and SSE completion only after lease release`, async t => {
    const { data, videos, configFile } = await fixture(t);
    let restarted = false;
    const srv = await startServer({ port: 0, configFile, quiet: true, onRestart: () => { restarted = true; } });
    const base = `http://127.0.0.1:${srv.port}`, gate = holdWorkerRelease(t, data);
    const eventsController = new AbortController();
    try {
      const submit = body => requestJson(base, '/api/jobs', { method: 'POST', status: 202, body });
      const created = await submit(status === 'done'
        ? { kind: 'plan', dir: videos, options: { downloadSubs: false } }
        : { kind: 'apply', dir: videos, options: { requirePlan: true } });
      await waitFor(gate.entered, 'worker lease cleanup to reach the gate');
      const heldJob = await requestJson(base, '/api/jobs/' + created.jobId);
      assert.equal(heldJob.status, 'running', 'a saved terminal snapshot is not yet public completion');
      assert.equal((await requestJson(base, '/api/health')).running, created.jobId);
      const jobPath = path.join(data, 'jobs', created.jobId + '.json');
      const disk = JSON.parse(await fs.readFile(jobPath, 'utf8'));
      assert.equal(disk.status, status);
      assert.ok(await fs.stat(disk.reportJson));
      const events = await fetch(base + '/api/jobs/' + created.jobId + '/events', {
        signal: AbortSignal.any([eventsController.signal, AbortSignal.timeout(5000)]),
      });
      const reader = events.body.getReader();
      const decoder = new TextDecoder();
      let first = '';
      // HTTP stream chunks need not coincide with SSE message boundaries.
      while (!first.includes('"type":"snapshot"') || !first.endsWith('\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false, 'SSE must remain open while cleanup is held');
        first += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(first, /"type":"snapshot"/);
      assert.doesNotMatch(first, /"type":"job-finished"/);
      await requestJson(base, '/api/jobs/' + created.jobId + '/cancel', { method: 'POST', body: {} });
      assert.equal(JSON.parse(await fs.readFile(jobPath, 'utf8')).status, status, 'late cancel must not overwrite saved completion');
      const blocked = await requestJson(base, '/api/maintenance/restart', { method: 'POST', body: {}, status: 409 });
      assert.equal(blocked.error, 'task_running');
      gate.release();
      let tail = '';
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += decoder.decode(chunk.value, { stream: true }); }
      assert.equal((tail.match(/"type":"job-finished"/g) || []).length, 1);
      assert.match(tail, new RegExp(`"status":"${status}"`));
      assert.equal((await waitForJob(base, created.jobId)).status, status);
      await assert.rejects(fs.stat(gate.lease), { code: 'ENOENT' });
      assert.equal((await requestJson(base, '/api/health')).running, null);
      const next = await submit({ kind: 'plan', dir: videos, options: { downloadSubs: false } });
      assert.equal((await waitForJob(base, next.jobId)).status, 'done');
      await requestJson(base, '/api/maintenance/restart', { method: 'POST', body: {}, status: 202 });
      await waitFor(() => restarted, 'accepted restart to close this private server');
    } finally {
      gate.release(); eventsController.abort(); await srv.close();
    }
  });
}

test('worker lease release failure keeps public state busy and reports cleanup error', async t => {
  const { data, videos, configFile } = await fixture(t);
  const srv = await startServer({ port: 0, configFile, quiet: true });
  const base = `http://127.0.0.1:${srv.port}`, gate = holdWorkerRelease(t, data, { fail: true });
  try {
    const created = await requestJson(base, '/api/jobs', { method: 'POST', body: { kind: 'plan', dir: videos }, status: 202 });
    await waitFor(gate.entered, 'worker lease cleanup to reach the failure gate');
    gate.release();
    const failedCleanup = await waitFor(async () => {
      const job = await requestJson(base, '/api/jobs/' + created.jobId);
      return job.progress?.error === 'EACCES' && job;
    }, 'lease cleanup failure to be visible');
    assert.equal(failedCleanup.status, 'running');
    assert.equal((await requestJson(base, '/api/health')).running, created.jobId);
    assert.ok(await fs.stat(gate.lease));
    await requestJson(base, '/api/jobs', { method: 'POST', body: { kind: 'plan', dir: videos }, status: 409 });
  } finally {
    gate.release();
    // The worker records the cleanup error and remains busy; closing the
    // isolated server must still be possible after the injected failure.
    await srv.close();
  }
});
