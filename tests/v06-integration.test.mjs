// v0.6 集成测试：真实启动 server 子进程，覆盖 F1/F3/F6/F8/F9 的接口契约。
// 不联网：只扫描空目录/无番号文件，任务会在本地立即完成；network.timeoutMs 压到 1s。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openState } from '../src/core/state.mjs';
import { configSignature } from '../src/pipeline.mjs';
import { waitForOwnedHealth } from './helpers/owned-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealth(base, child, stderr, timeoutMs = 20000) {
  return waitForOwnedHealth(base, child, stderr, timeoutMs);
}

async function startServer({ configPath, port }) {
  let err = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs'), '--port', String(port), '--config', configPath], {
    cwd: ROOT,
    env: { ...process.env, AVC_GUI_WORKER: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr.on('data', (d) => { err += String(d); });
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await waitHealth(base, child, () => err.slice(-1200));
    return { child, base, health, stderr: () => err };
  } catch (error) {
    await stopServer({ child });
    throw error;
  }
}

async function stopServer(srv) {
  if (!srv?.child) return;
  const child = srv.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch { /* already gone */ }
  await Promise.race([exited, sleep(4000)]);
}

async function pollJob(base, id, want = ['done', 'aborted', 'cancelled', 'failed'], timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base}/api/jobs/${id}`);
    const job = await res.json();
    if (want.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`job ${id} stuck in ${job.status}`);
    await sleep(120);
  }
}

const tmpRoots = [];
let cfg;

async function makeTempRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-v06-'));
  tmpRoots.push(dir);
  return dir;
}

async function makeConfig(label) {
  const root = await makeTempRoot();
  const dataDir = path.join(root, 'data');
  const videos = path.join(root, 'videos');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(videos, { recursive: true });
  const configPath = path.join(root, `${label}.config.json`);
  const config = {
    network: { proxy: '', autoDiscover: false, proxyHosts: [], directHosts: [], defaultRoute: 'direct', timeoutMs: 1000, retry: 0, minIntervalMs: 0 },
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['manko', 'subtitlecat'], localDirs: [], maxCandidatesPerSource: 1, subtitlecatLimit: 1, maxDurationDeltaMin: 5, fit: { mode: 'none' } },
    covers: { download: false, posterWhenSingle: false, embed: false },
    scan: { videoExtensions: ['.mp4', '.mkv'] },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots: [root], maxEntries: 500, showFiles: true },
    media: { probeDuration: 'off' },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { root, dataDir, videos, configPath, config };
}

// 三个无番号文件：本地立即完成，不触发任何网络请求
async function seedVideos(videos) {
  for (const name of ['aaa.mp4', 'bbb.mp4', 'ccc.mp4']) {
    await fs.writeFile(path.join(videos, name), '');
  }
  // 两个同番号文件，用于验证 F3 duplicates（只读文件名/stat，不读内容）
  for (const name of ['IPX-920.mp4', 'IPX-920-copy.mp4']) {
    await fs.writeFile(path.join(videos, name), '');
  }
}

before(async () => {
  cfg = await makeConfig('main');
  await seedVideos(cfg.videos);
});

after(async () => {
  for (const dir of tmpRoots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('F6 /api/diagnose 字段齐全（不要求联网成功）', async () => {
  const port = await freePort();
  const srv = await startServer({ configPath: cfg.configPath, port });
  try {
    const res = await fetch(`${srv.base}/api/diagnose`);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.ok, true);
    assert.ok(Array.isArray(d.network.hosts) && d.network.hosts.length >= 3, 'hosts >= 3');
    for (const h of d.network.hosts) {
      assert.equal(typeof h.name, 'string');
      assert.equal(typeof h.ok, 'boolean');
      assert.equal(typeof h.ms, 'number');
    }
    assert.equal(typeof d.ffmpeg.available, 'boolean');
    assert.equal(d.dataDir.writable, true);
    assert.equal(d.config.valid, true);
    assert.ok(Array.isArray(d.config.unknownKeys));
    assert.ok(Array.isArray(d.config.warnings));
    assert.equal(typeof d.state.files, 'number');
  } finally {
    await stopServer(srv);
  }
});

test('F3 /api/scan 返回 duplicates/applied/stage 字段', async () => {
  const port = await freePort();
  const srv = await startServer({ configPath: cfg.configPath, port });
  try {
    const res = await fetch(`${srv.base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: cfg.videos }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 5);
    const byName = Object.fromEntries(body.items.map((it) => [it.name, it]));
    assert.ok(Array.isArray(byName['IPX-920.mp4'].duplicates));
    assert.ok(byName['IPX-920.mp4'].duplicates.includes(byName['IPX-920-copy.mp4'].path));
    assert.deepEqual(byName['aaa.mp4'].duplicates, []);
    for (const it of body.items) {
      assert.equal(typeof it.applied, 'boolean');
      assert.ok('stage' in it);
      assert.ok('rename' in it);
    }
  } finally {
    await stopServer(srv);
  }
});

test('F8 /api/preview 参数校验与离线 no_code 结果', async () => {
  const port = await freePort();
  const srv = await startServer({ configPath: cfg.configPath, port });
  try {
    const post = async (body) => {
      const res = await fetch(`${srv.base}/api/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const missing = await post({});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'file_required');

    const txt = path.join(cfg.videos, 'readme.txt');
    await fs.writeFile(txt, 'x');
    const notVideo = await post({ file: txt });
    assert.equal(notVideo.status, 400);
    assert.equal(notVideo.body.error, 'not_video');

    const ghost = await post({ file: path.join(cfg.videos, 'nope.mp4') });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.body.error, 'file_not_found');

    // 无番号文件：processFile 早退 no_code，不联网、不写状态库
    const ok = await post({ file: path.join(cfg.videos, 'aaa.mp4') });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'no_code');
    assert.ok(Array.isArray(ok.body.candidates));
    assert.equal(ok.body.meta, null);
    assert.equal(ok.body.newName, null);
  } finally {
    await stopServer(srv);
  }
});

test('F9 任务持久化：重启后历史仍在且日志/报告可读；F4 撤销缺失 journal 返回 400', async () => {
  const port = await freePort();
  let srv = await startServer({ configPath: cfg.configPath, port });
  let jobId = null;
  try {
    const res = await fetch(`${srv.base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'plan', dir: cfg.videos, options: { downloadSubs: false } }),
    });
    assert.equal(res.status, 202);
    const created = await res.json();
    jobId = created.jobId;
    const done = await pollJob(srv.base, jobId);
    assert.equal(done.status, 'done');
    assert.ok(done.summary && done.summary.no_code >= 3);
  } finally {
    await stopServer(srv);
  }

  // 重启：内存 Map 清空，但应能从 data/jobs/*.json 恢复
  srv = await startServer({ configPath: cfg.configPath, port });
  try {
    const list = await (await fetch(`${srv.base}/api/jobs`)).json();
    assert.ok(Array.isArray(list.jobs));
    const restored = list.jobs.find((j) => j.id === jobId);
    assert.ok(restored, 'persisted job should survive restart');
    assert.equal(restored.status, 'done');

    const log = await fetch(`${srv.base}/api/jobs/${jobId}/log`);
    assert.equal(log.status, 200);
    const logBody = await log.json();
    assert.ok(Array.isArray(logBody.logs) && logBody.logs.length >= 0);

    const report = await fetch(`${srv.base}/api/jobs/${jobId}/report`);
    assert.equal(report.status, 200);
    const rep = await report.json();
    assert.equal(rep.apply, false);
    assert.ok(Array.isArray(rep.results));

    // F4：不存在/非法 journal → 400 undo_failed（不 500、不产生副作用）
    const undo = await fetch(`${srv.base}/api/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ journal: 'data/journal-does-not-exist.json' }),
    });
    assert.equal(undo.status, 400);
    assert.equal((await undo.json()).error, 'undo_failed');
  } finally {
    await stopServer(srv);
  }
});

test('F9 终态 /events 会补发 job-finished 并关闭流', async () => {
  const port = await freePort();
  const srv = await startServer({ configPath: cfg.configPath, port });
  try {
    const res = await fetch(`${srv.base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'plan', dir: cfg.videos, options: { downloadSubs: false } }),
    });
    const { jobId } = await res.json();
    await pollJob(srv.base, jobId);

    const stream = await fetch(`${srv.base}/api/jobs/${jobId}/events`);
    assert.equal(stream.status, 200);
    const text = await stream.text(); // 终态任务应主动 end，否则这里会挂住
    assert.match(text, /"type":"snapshot"/);
    assert.match(text, /"type":"job-finished"/);
  } finally {
    await stopServer(srv);
  }
});

test('F1 /api/state 返回 stage/applied 字段', async () => {
  const port = await freePort();
  const srv = await startServer({ configPath: cfg.configPath, port });
  try {
    // 先跑一次 plan 写入状态库
    const created = await (await fetch(`${srv.base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'plan', dir: cfg.videos, options: { downloadSubs: false } }),
    })).json();
    await pollJob(srv.base, created.jobId);

    const res = await fetch(`${srv.base}/api/state`);
    assert.equal(res.status, 200);
    const st = await res.json();
    assert.ok(Array.isArray(st.files) && st.files.length >= 5);
    for (const f of st.files) {
      assert.equal(typeof f.applied, 'boolean');
      assert.ok('stage' in f);
    }
  } finally {
    await stopServer(srv);
  }
});

// F1 端到端：同配置签名二次预演应跳过；改模板（签名变化）后应重新处理。
// 预置状态库行，避免依赖网络元数据（文件名无番号 → 重新处理时走 no_code 早退）。
test('F1 预演语义：同配置跳过、改模板重新处理', async () => {
  const root = await makeTempRoot();
  const videos = path.join(root, 'videos');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(videos, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(videos, 'plain.mp4');
  await fs.writeFile(file, '');

  const baseCfg = (tpl) => ({
    network: { proxy: '', proxyHosts: [], directHosts: [], defaultRoute: 'direct', timeoutMs: 800, retry: 0, minIntervalMs: 0 },
    rename: { template: tpl, maxLength: 170 },
    subs: { sources: ['manko'], localDirs: [], maxCandidatesPerSource: 1, subtitlecatLimit: 1, maxDurationDeltaMin: 5, fit: { mode: 'none' } },
    covers: { download: false, posterWhenSingle: false, embed: false },
    scan: { videoExtensions: ['.mp4'] },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots: [root], maxEntries: 100 },
    media: { probeDuration: 'off' },
  });
  const cfgA = baseCfg('{code} {title} [{actress}]');
  const cfgB = baseCfg('{code}_{title}');
  const pathA = path.join(root, 'a.config.json');
  const pathB = path.join(root, 'b.config.json');
  await fs.writeFile(pathA, JSON.stringify(cfgA, null, 2));
  await fs.writeFile(pathB, JSON.stringify(cfgB, null, 2));
  assert.notEqual(configSignature(cfgA), configSignature(cfgB));

  // 预置：上次预演用的签名 = 配置 A
  const st = openState(path.join(dataDir, 'state.db'));
  st.upsertFile(file, { status: 'ok', code: 'IPX-999', newName: 'IPX-999 old.mp4', data: { size: 0, applied: false, planSig: configSignature(cfgA), stage: 'plan' } });
  st.close();

  // 1) 配置 A（同签名）→ 跳过
  let port = await freePort();
  let srv = await startServer({ configPath: pathA, port });
  try {
    const created = await (await fetch(`${srv.base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'plan', dir: videos, options: { downloadSubs: false } }),
    })).json();
    await pollJob(srv.base, created.jobId);
    const log = await (await fetch(`${srv.base}/api/jobs/${created.jobId}/log`)).json();
    assert.ok(log.logs.some((l) => l.line.includes('skip (done)')), 'same signature should skip');
  } finally {
    await stopServer(srv);
  }

  // 2) 配置 B（模板变化 → 签名不同）→ 重新处理（文件名无番号 → no_code）
  port = await freePort();
  srv = await startServer({ configPath: pathB, port });
  try {
    const created = await (await fetch(`${srv.base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'plan', dir: videos, options: { downloadSubs: false } }),
    })).json();
    await pollJob(srv.base, created.jobId);
    const log = await (await fetch(`${srv.base}/api/jobs/${created.jobId}/log`)).json();
    const lines = log.logs.map((l) => l.line);
    assert.ok(lines.some((l) => l.includes('plain.mp4')), 'changed signature should reprocess');
    assert.ok(!lines.some((l) => l.includes('skip (done)')), 'changed signature must not skip');
  } finally {
    await stopServer(srv);
  }
});
