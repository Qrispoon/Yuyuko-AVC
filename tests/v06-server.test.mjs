// v0.6 backend-server 验收测试（SPEC §2.9 六组）
// 全部离线：临时 config + 临时 dataDir + 随机端口 18000–19999；spawn 真实子进程，测完必须 kill。
// 不联网测试：/api/diagnose 的探测允许真实发起，这里只断言结构；不要求探测连通。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { openState } from '../src/core/state.mjs';
import { applyRenames } from '../src/core/journal.mjs';
import { waitForOwnedHealth } from './helpers/owned-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 端口用 18000 + random(2000)，禁止 17890
const randPort = () => 18000 + Math.floor(Math.random() * 2000);

async function mkTempRoot(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `avc-v06-${label}-`));
}

/** 写一份临时 config：dataDir 指向 temp、network 超时收紧、fs.allowedRoots=[temp]。 */
async function writeTempConfig(root) {
  const dataDir = path.join(root, 'data');
  const config = {
    network: {
      proxy: '',
      autoDiscover: true,
      proxyHosts: [],
      directHosts: [],
      defaultRoute: 'direct',
      timeoutMs: 1200,
      retry: 0,
      minIntervalMs: 0,
    },
    rename: { template: '{code} {title} [{actress}]', maxLength: 170, stripActressFromTitle: true },
    subs: {
      lang: 'zh',
      sources: [],
      localDirs: [],
      maxCandidatesPerSource: 1,
      subtitlecatLimit: 1,
      maxDurationDeltaMin: 5,
      fit: {},
      writeSiblingSrt: true,
    },
    covers: { download: false, posterWhenSingle: true, embed: false },
    scan: { videoExtensions: ['.mp4', '.mkv'], skipNormalized: true },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots: [root], maxEntries: 500, showFiles: true },
    media: { probeDuration: 'off' },
  };
  const configFile = path.join(root, 'config.json');
  await fsp.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8');
  return { configFile, dataDir, config };
}

function spawnServer(port, configFile) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--config', configFile], {
    cwd: ROOT,
    env: { ...process.env, AVC_GUI_WORKER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });
  return { child, port, output: () => output };
}

async function killServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve();
    }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function waitHealth(port, child, output) {
  return waitForOwnedHealth(`http://127.0.0.1:${port}`, child, output);
}

/** 启动并等待就绪；端口冲突时自动换端口重试。 */
async function boot(configFile) {
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const handle = spawnServer(randPort(), configFile);
    try {
      await waitHealth(handle.port, handle.child, handle.output);
      return handle;
    } catch (e) {
      lastErr = e;
      await killServer(handle.child);
    }
  }
  throw lastErr || new Error('server boot failed');
}

async function api(port, pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

const postJson = (port, pathname, body) => api(port, pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

async function waitUntil(fn, { timeoutMs = 20000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

const TERMINAL = ['done', 'aborted', 'cancelled', 'failed'];

async function createEmptyPlanJob(port, dir) {
  const res = await postJson(port, '/api/jobs', { kind: 'plan', dir });
  assert.equal(res.status, 202);
  assert.ok(res.body.jobId);
  return res.body.jobId;
}

async function waitJobDone(port, jobId) {
  return waitUntil(async () => {
    const r = await api(port, `/api/jobs/${jobId}`);
    if (r.status === 200 && TERMINAL.includes(r.body.status)) return r.body;
    return null;
  }, { label: `job ${jobId} finished`, timeoutMs: 30000 });
}

/** 等 drain 的 persistJob 落盘（避免 status 已 done 但 kill 太早导致重启后丢历史）。 */
async function waitJobPersisted(dataDir, jobId) {
  const file = path.join(dataDir, 'jobs', `${jobId}.json`);
  return waitUntil(() => fsp.stat(file).then(() => true).catch(() => false), {
    label: `job ${jobId} persisted`, timeoutMs: 15000,
  });
}

// ---------------------------------------------------------------------------
// 1) GET /api/diagnose
// ---------------------------------------------------------------------------
test('1) GET /api/diagnose 返回完整自检结构', async () => {
  const root = await mkTempRoot('diag');
  const { configFile, dataDir } = await writeTempConfig(root);
  const srv = await boot(configFile);
  try {
    const { status, body } = await api(srv.port, '/api/diagnose');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.match(body.node, /^v\d+/);
    assert.ok(typeof body.platform === 'string' && body.platform.length > 0);

    // network：4 个 host 并行探测；不要求联网成功，只要求结构完整
    assert.ok(body.network && typeof body.network === 'object');
    assert.equal(typeof body.network.defaultRoute, 'string');
    assert.ok('proxy' in body.network);
    assert.equal(body.network.hosts.length, 4);
    assert.deepEqual(
      body.network.hosts.map((h) => h.name).sort(),
      ['cover-cdn', 'javbus', 'manko', 'subtitlecat'],
    );
    for (const h of body.network.hosts) {
      assert.equal(typeof h.url, 'string');
      assert.ok(/^https:\/\//.test(h.url));
      assert.equal(typeof h.ok, 'boolean');
      assert.equal(typeof h.status, 'number');
      assert.equal(typeof h.ms, 'number');
      assert.equal(typeof h.route, 'string');
    }

    // ffmpeg：可用性布尔值即可（本机可能没装）
    assert.equal(typeof body.ffmpeg.available, 'boolean');
    assert.equal(typeof body.ffmpeg.ffprobe, 'boolean');
    assert.ok('version' in body.ffmpeg);

    // dataDir：可写，且探测临时文件已清理；v0.7 起启动会自动创建 logs/（F19），除此之外不得多写
    assert.equal(body.dataDir.writable, true);
    assert.equal(body.dataDir.error, null);
    assert.equal(path.resolve(body.dataDir.path).toLowerCase(), path.resolve(dataDir).toLowerCase());
    const dataDirEntries = await fsp.readdir(dataDir);
    assert.ok(dataDirEntries.every((n) => n === 'logs'), `dataDir 只允许自动创建 logs/，实际：${dataDirEntries.join(',')}`);
    assert.ok(!dataDirEntries.includes('state.db'), '诊断接口不应额外创建 state.db');

    // config：允许的键不算 unknown；4 个未实现键只在 warnings 里提示
    assert.equal(body.config.path, configFile);
    assert.equal(body.config.valid, true);
    assert.ok(Array.isArray(body.config.unknownKeys));
    assert.deepEqual(body.config.unknownKeys, []);
    assert.ok(Array.isArray(body.config.warnings));
    assert.ok(body.config.warnings.length >= 4);

    // state：库不存在时 files=0、byStatus={}
    assert.equal(typeof body.state.db, 'string');
    assert.equal(body.state.files, 0);
    assert.deepEqual(body.state.byStatus, {});
  } finally {
    await killServer(srv.child);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2) POST /api/preview：校验错误码 + 不落状态库
// ---------------------------------------------------------------------------
test('2) POST /api/preview 参数校验与只读预演', async () => {
  const root = await mkTempRoot('preview');
  const { configFile } = await writeTempConfig(root);
  const srv = await boot(configFile);
  try {
    // 缺 file → 400 file_required
    const r1 = await postJson(srv.port, '/api/preview', {});
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'file_required');

    // 非视频扩展名 → 400 not_video
    const txt = path.join(root, 'note.txt');
    await fsp.writeFile(txt, 'hello', 'utf8');
    const r2 = await postJson(srv.port, '/api/preview', { file: txt });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'not_video');

    // 视频扩展名但文件不存在 → 400 file_not_found
    const missing = path.join(root, 'IPX-920.mp4');
    const r3 = await postJson(srv.port, '/api/preview', { file: missing });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, 'file_not_found');

    // 目录伪装成 .mp4 → 400 file_not_found（不是普通文件）
    const dirAsVideo = path.join(root, 'folder.mp4');
    await fsp.mkdir(dirAsVideo);
    const r4 = await postJson(srv.port, '/api/preview', { file: dirAsVideo });
    assert.equal(r4.status, 400);
    assert.equal(r4.body.error, 'file_not_found');

    // 正例（纯本地、无网络）：无番号文件名 → no_code；persist:false 不写状态库
    const noCode = path.join(root, 'no code here.mp4');
    await fsp.writeFile(noCode, Buffer.alloc(16), 'utf8');
    const r5 = await postJson(srv.port, '/api/preview', { file: noCode });
    assert.equal(r5.status, 200);
    assert.equal(r5.body.status, 'no_code');
    assert.equal(r5.body.file, path.resolve(noCode));
    assert.equal(r5.body.code, null);
    assert.equal(r5.body.newName, null);
    assert.equal(r5.body.rename, null);
    assert.equal(r5.body.sub, null);
    assert.deepEqual(r5.body.candidates, []);
    assert.equal(r5.body.coverPlanned, null);

    const state = await api(srv.port, '/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.body.files.length, 0);
  } finally {
    await killServer(srv.child);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 3) POST /api/undo：无 journal → 400 undo_failed；撤销成功回写状态库
// ---------------------------------------------------------------------------
test('3) POST /api/undo 错误码与撤销后状态库一致性', async () => {
  const root = await mkTempRoot('undo');
  const { configFile, dataDir } = await writeTempConfig(root);
  const srv = await boot(configFile);
  try {
    // 不存在 journal → 400 undo_failed
    const r1 = await postJson(srv.port, '/api/undo', { journal: 'journal-missing.json' });
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'undo_failed');

    // 通过真实改名创建含历史身份依据的 typed journal。
    const videos = path.join(root, 'videos');
    await fsp.mkdir(videos, { recursive: true });
    const from = path.join(videos, 'IPX-920 old.mp4');
    const to = path.join(videos, 'IPX-920 标题 [演员].mp4');
    await fsp.writeFile(from, Buffer.alloc(32), 'utf8');
    await fsp.mkdir(dataDir, { recursive: true });
    const journalFile = path.join(dataDir, 'journal-test.json');
    await applyRenames([{ from, to, action: 'rename' }], { dataDir, journalFile });

    // 预置状态库：from 有旧的 apply 记录、to 有改名后记录；撤销后 from 应被 reset、to 应被 delete
    const state = openState(path.join(dataDir, 'state.db'));
    try {
      state.upsertFile(from, { status: 'ok', code: 'IPX-920', newName: path.basename(to), data: { stage: 'apply', applied: true, planSig: 'v06-old00000', size: 32 } });
      state.upsertFile(to, { status: 'ok', code: 'IPX-920', newName: path.basename(to), data: { stage: 'apply', applied: true, size: 32 } });
    } finally { state.close(); }

    const r2 = await postJson(srv.port, '/api/undo', { journal: 'journal-test.json' });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.restored, 1);
    assert.equal(r2.body.reset, 1);
    assert.deepEqual(r2.body.failed, []);
    assert.ok(Array.isArray(r2.body.restoredItems));
    assert.equal(r2.body.restoredItems.length, 1);
    assert.deepEqual(Object.keys(r2.body.restoredItems[0]).sort(), ['from', 'to']);
    assert.equal(r2.body.restoredItems[0].from, from);
    assert.equal(r2.body.restoredItems[0].to, to);

    // 磁盘：视频已改回旧名
    assert.equal(await fsp.stat(from).then((s) => s.isFile()).catch(() => false), true);
    assert.equal(await fsp.stat(to).then(() => true).catch(() => false), false);

    // 状态库：from 被重置为 discovered，to 被删除
    const after = await api(srv.port, '/api/state');
    assert.equal(after.status, 200);
    const byPath = new Map(after.body.files.map((f) => [path.resolve(f.path).toLowerCase(), f]));
    const resetRow = byPath.get(path.resolve(from).toLowerCase());
    assert.ok(resetRow, 'restored source should exist in state db');
    assert.equal(resetRow.status, 'discovered');
    assert.equal(resetRow.newName, null);
    assert.equal(resetRow.planSig, null);
    assert.equal(resetRow.applied, false);
    assert.equal(byPath.has(path.resolve(to).toLowerCase()), false);

    // 旧日志没有可信的历史身份，不可将路径存在当作可安全撤销的证据。
    const legacy = path.join(dataDir, 'journal-legacy.json');
    await fsp.writeFile(legacy, JSON.stringify({ version: 1, items: [{ from: to, to: from }] }));
    const refused = await postJson(srv.port, '/api/undo', { journal: 'journal-legacy.json' });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.undoComplete, false);
    assert.equal(refused.body.restored, 0);
    assert.equal(refused.body.failed[0].reason, 'legacy_unverifiable');
    assert.equal((await fsp.readFile(from)).length, 32);
    assert.equal(await fsp.stat(to).then(() => true).catch(() => false), false);
  } finally {
    await killServer(srv.child);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4) F9：任务持久化（kill 重启后仍能看到 job 与日志）
// ---------------------------------------------------------------------------
test('4) F9 任务持久化：重启后 /api/jobs 与 /log 仍可用', async () => {
  const root = await mkTempRoot('persist');
  const { configFile, dataDir } = await writeTempConfig(root);
  const videos = path.join(root, 'videos');
  await fsp.mkdir(videos, { recursive: true });

  let srv1 = null;
  let srv2 = null;
  try {
    srv1 = await boot(configFile);
    const jobId = await createEmptyPlanJob(srv1.port, videos);
    const job = await waitJobDone(srv1.port, jobId);
    assert.equal(job.status, 'done');
    assert.ok(job.progress && typeof job.progress === 'object');
    assert.deepEqual(job.progress, { done: 0, total: 0 });
    await waitJobPersisted(dataDir, jobId);
    await killServer(srv1.child);
    srv1 = null;

    // 重启（同 config / 同 dataDir）
    srv2 = await boot(configFile);
    const list = await api(srv2.port, '/api/jobs');
    assert.equal(list.status, 200);
    assert.equal(list.body.jobs.length, 1);
    assert.equal(list.body.jobs[0].id, jobId);
    assert.equal(list.body.jobs[0].status, 'done');

    const single = await api(srv2.port, `/api/jobs/${jobId}`);
    assert.equal(single.status, 200);
    assert.equal(single.body.id, jobId);

    const log = await api(srv2.port, `/api/jobs/${jobId}/log`);
    assert.equal(log.status, 200);
    assert.equal(log.body.id, jobId);
    assert.ok(Array.isArray(log.body.logs));

    const report = await api(srv2.port, `/api/jobs/${jobId}/report`);
    assert.equal(report.status, 200);
    assert.equal(report.body.summary !== undefined, true);
  } finally {
    if (srv1) await killServer(srv1.child);
    if (srv2) await killServer(srv2.child);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 5) 终态 /events：snapshot + job-finished 后流结束；/cancel 终态 409
// ---------------------------------------------------------------------------
test('5) 终态 /api/jobs/:id/events 补发 job-finished 并结束', async () => {
  const root = await mkTempRoot('events');
  const { configFile } = await writeTempConfig(root);
  const videos = path.join(root, 'videos');
  await fsp.mkdir(videos, { recursive: true });
  const srv = await boot(configFile);
  try {
    const jobId = await createEmptyPlanJob(srv.port, videos);
    const done = await waitJobDone(srv.port, jobId);
    assert.equal(done.status, 'done');

    // 终态任务的 SSE：应立刻结束（不挂起），且包含 snapshot + job-finished
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    let text;
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/jobs/${jobId}/events`, { signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(String(res.headers.get('content-type')), /text\/event-stream/);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const events = text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice(6)));
    assert.ok(events.some((e) => e.type === 'snapshot'), 'should contain snapshot');
    const finished = events.filter((e) => e.type === 'job-finished');
    assert.equal(finished.length, 1);
    assert.equal(finished[0].job.id, jobId);
    assert.equal(finished[0].job.status, 'done');
    assert.ok('progress' in finished[0].job);

    // 终态取消 → 409 job_finished（不再 200）
    const cancel = await postJson(srv.port, `/api/jobs/${jobId}/cancel`, {});
    assert.equal(cancel.status, 409);
    assert.equal(cancel.body.error, 'job_finished');
  } finally {
    await killServer(srv.child);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 6) /api/state 与 /api/scan 的新增字段（stage/applied/planSig/rename/duplicates）
// ---------------------------------------------------------------------------
test('6) /api/state 与 /api/scan 返回 v0.6 增量字段', async () => {
  const root = await mkTempRoot('fields');
  const { configFile, dataDir } = await writeTempConfig(root);
  const video = path.join(root, 'IPX-920.mp4');
  await fsp.writeFile(video, Buffer.alloc(24), 'utf8');

  // 预置状态库记录，验证 /api/state 的 stage/applied/planSig 透出
  await fsp.mkdir(dataDir, { recursive: true });
  const state = openState(path.join(dataDir, 'state.db'));
  try {
    state.upsertFile(video, {
      status: 'ok',
      code: 'IPX-920',
      newName: 'IPX-920 标题 [演员].mp4',
      data: { stage: 'plan', applied: false, planSig: 'v06-abc12345', size: 24, rename: { from: video, to: 'x', action: 'rename' } },
    });
  } finally { state.close(); }

  const srv = await boot(configFile);
  try {
    const st = await api(srv.port, '/api/state');
    assert.equal(st.status, 200);
    const row = st.body.files.find((f) => path.resolve(f.path).toLowerCase() === video.toLowerCase());
    assert.ok(row, '/api/state should include the preseeded file');
    assert.equal(row.stage, 'plan');
    assert.equal(row.applied, false);
    assert.equal(row.planSig, 'v06-abc12345');
    assert.ok('stage' in row && 'applied' in row && 'planSig' in row);

    const scan = await postJson(srv.port, '/api/scan', { dir: root });
    assert.equal(scan.status, 200);
    assert.equal(scan.body.items.length, 1);
    const item = scan.body.items[0];
    assert.equal(item.applied, false);
    assert.equal(item.stage, 'plan');
    assert.deepEqual(item.rename, { from: video, to: 'x', action: 'rename' });
    assert.ok(Array.isArray(item.duplicates));
    assert.deepEqual(item.duplicates, []);
  } finally {
    await killServer(srv.child);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
