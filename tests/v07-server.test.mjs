// v0.7 backend-server 验收（SPEC2 §2 /api/lookup、§5 F19、§6 F20、§7 F18）
// 用 startServer() 在进程内起临时实例（临时 config/dataDir、随机端口 18000+），测完 close。
// 不联网：/api/lookup 只测参数校验；diagnose/export 的网络探测只断言结构。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { startServer, VERSION } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randPort = () => 18000 + Math.floor(Math.random() * 2000);

async function tempSetup(label) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `avc-v07-${label}-`));
  const dataDir = path.join(root, 'data');
  const config = {
    network: { proxy: '', proxyHosts: [], directHosts: [], defaultRoute: 'direct', timeoutMs: 1200, retry: 0, minIntervalMs: 0 },
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { lang: 'zh', sources: [], localDirs: [], maxCandidatesPerSource: 1, subtitlecatLimit: 1, maxDurationDeltaMin: 5, fit: {}, extraLangs: [] },
    covers: { download: false, posterWhenSingle: true, embed: false },
    scan: { videoExtensions: ['.mp4', '.mkv'] },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots: [root], maxEntries: 500, showFiles: true },
    media: { probeDuration: 'off' },
    metadata: { r18: true },
  };
  const configFile = path.join(root, 'config.json');
  await fsp.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8');
  return { root, dataDir, configFile, config };
}

/** 用 startServer 起实例；端口冲突时换端口重试（禁止 17890）。 */
async function startTestServer(opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = opts.port ?? randPort();
    try {
      return await startServer({ quiet: true, host: '127.0.0.1', ...opts, port });
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw lastErr || new Error('startServer failed');
}

async function api(port, pathname, opts = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers, text };
}

const postJson = (port, pathname, body) => api(port, pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

const TERMINAL = ['done', 'aborted', 'cancelled', 'failed'];

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

async function createEmptyPlanJob(port, dir) {
  const res = await postJson(port, '/api/jobs', { kind: 'plan', dir });
  assert.equal(res.status, 202);
  return res.body.jobId;
}

async function waitJobDone(port, jobId) {
  return waitUntil(async () => {
    const r = await api(port, `/api/jobs/${jobId}`);
    return r.status === 200 && TERMINAL.includes(r.body.status) ? r.body : null;
  }, { label: `job ${jobId} finished`, timeoutMs: 30000 });
}

/** 等 drain 里 persistJob 落盘（否则比对文件列表会与后台写盘竞态）。 */
async function waitJobPersisted(dataDir, jobId) {
  const file = path.join(dataDir, 'jobs', `${jobId}.json`);
  return waitUntil(() => fsp.stat(file).then(() => true).catch(() => false), {
    label: `job ${jobId} persisted`, timeoutMs: 15000,
  });
}

async function listFilesRecursive(dir) {
  const out = [];
  const walk = async (d) => {
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full.toLowerCase());
    }
  };
  await walk(dir);
  return out.sort();
}

/** sqlite 的 -wal/-shm 是瞬时文件，不算“新写文件”。 */
const stableFiles = (files) => files.filter((f) => !/-(wal|shm)$/i.test(f));

function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// 1) F20：startServer 可导入启动（health/version/diagnose.logs/close/端口释放）
// ---------------------------------------------------------------------------
test('1) startServer 启动健康检查、VERSION 与 package.json 一致、close 释放端口', async () => {
  const t = await tempSetup('boot');
  const inst = await startTestServer({ configFile: t.configFile });
  try {
    const health = await api(inst.port, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.version, PKG.version, 'health.version 必须来自 package.json');
    assert.equal(health.body.version, VERSION);

    // F19：/api/diagnose 增加 logs 字段（目录 + 最新日志文件名）
    const diag = await api(inst.port, '/api/diagnose');
    assert.equal(diag.status, 200);
    assert.ok(diag.body.logs && typeof diag.body.logs === 'object');
    assert.equal(typeof diag.body.logs.dir, 'string');
    assert.ok(/[\\/]logs$/i.test(diag.body.logs.dir));
    assert.match(String(diag.body.logs.latest), /^avc-\d{4}-\d{2}-\d{2}\.log$/);
    const logFile = path.join(diag.body.logs.dir, diag.body.logs.latest);
    assert.equal(fs.existsSync(logFile), true);
    // 启动即写日志：ISO8601 LEVEL msg
    const firstLine = (await fsp.readFile(logFile, 'utf8')).split(/\r?\n/)[0];
    assert.match(firstLine, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO server started/);
  } finally {
    await inst.close();
  }

  // close 结束后服务器已停止；close 幂等；可再次启动一个新实例
  assert.equal(inst.server.listening, false);
  const inst2 = await startTestServer({ configFile: t.configFile });
  try {
    const health2 = await api(inst2.port, '/api/health');
    assert.equal(health2.status, 200);
  } finally {
    await inst2.close();
  }
  // close 幂等
  await inst2.close();
  await fsp.rm(t.root, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 2) F19：/api/diagnostics/export（JSON 附件、默认脱敏、可选 job、不写新文件）
// ---------------------------------------------------------------------------
test('2) /api/diagnostics/export 返回脱敏诊断包且不写新文件', async () => {
  const t = await tempSetup('export');
  const videos = path.join(t.root, 'videos');
  await fsp.mkdir(videos, { recursive: true });
  const inst = await startTestServer({ configFile: t.configFile });
  try {
    const jobId = await createEmptyPlanJob(inst.port, videos);
    const job = await waitJobDone(inst.port, jobId);
    assert.equal(job.status, 'done');
    await waitJobPersisted(t.dataDir, jobId);

    // 快照文件列表（导出“不写新文件”）
    const before = stableFiles(await listFilesRecursive(t.root));

    const res = await fetch(`http://127.0.0.1:${inst.port}/api/diagnostics/export?job=${jobId}`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /application\/json/);
    assert.match(String(res.headers.get('content-disposition')), /^attachment; filename="avc-diagnostics-.+\.json"$/);
    const raw = await res.text();

    // 默认脱敏：原始文本里不应出现盘符绝对路径（JSON 里反斜杠会写成两个）
    assert.ok(!/[A-Za-z]:\\\\/.test(raw), 'default export should not leak windows absolute paths');
    assert.ok(raw.includes('<path>'));

    const body = JSON.parse(raw);
    assert.ok(body.generatedAt && !Number.isNaN(Date.parse(body.generatedAt)));
    assert.equal(body.version, PKG.version);
    assert.equal(typeof body.node, 'string');
    assert.equal(typeof body.platform, 'string');
    assert.equal(typeof body.arch, 'string');
    // diagnostics：与 /api/diagnose 同结构且已脱敏
    assert.ok(body.diagnostics && typeof body.diagnostics === 'object');
    assert.equal(body.diagnostics.dataDir.writable, true);
    assert.equal(body.diagnostics.dataDir.path, '<path>');
    assert.ok(body.diagnostics.logs && typeof body.diagnostics.logs.latest === 'string');
    // config 去掉 paths，且其余路径字段被脱敏
    assert.equal(body.config.paths, undefined);
    assert.deepEqual(body.config.fs.allowedRoots, ['<path>']);
    // logs 尾部 300 行
    assert.ok(Array.isArray(body.logs) && body.logs.length >= 1);
    assert.equal(body.logs.every((line) => typeof line === 'string'), true);
    // 可选 job：publicJob + report.summary
    assert.equal(body.job.id, jobId);
    assert.equal(body.job.status, 'done');
    assert.deepEqual(body.job.reportSummary, job.summary);

    // 不写新文件（忽略 sqlite -wal/-shm 瞬时文件）
    const after = stableFiles(await listFilesRecursive(t.root));
    assert.deepEqual(after, before);

    // redact=0：不脱敏字符串路径（但 config.paths 按 SPEC 始终移除）；不带 job 参数时无 job 键
    const rawRes = await fetch(`http://127.0.0.1:${inst.port}/api/diagnostics/export?redact=0`);
    assert.equal(rawRes.status, 200);
    const rawText = await rawRes.text();
    const rawBody = JSON.parse(rawText);
    assert.equal(rawBody.config.paths, undefined, 'config.paths 始终被移除');
    assert.deepEqual(rawBody.config.fs.allowedRoots, [t.root]);
    assert.notEqual(rawBody.diagnostics.dataDir.path, '<path>');
    assert.equal(
      path.resolve(rawBody.diagnostics.dataDir.path).toLowerCase(),
      path.resolve(t.dataDir).toLowerCase(),
    );
    assert.ok(/[A-Za-z]:\\/.test(rawText), 'redact=0 时应保留原始盘符路径（JSON 中为转义反斜杠）');
    assert.equal('job' in rawBody, false);
  } finally {
    await inst.close();
    await fsp.rm(t.root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 3) F16：POST /api/lookup 参数校验（不触发网络）
// ---------------------------------------------------------------------------
test('3) POST /api/lookup 参数校验 keyword_required / keyword_too_long', async () => {
  const t = await tempSetup('lookup');
  const inst = await startTestServer({ configFile: t.configFile });
  try {
    const r1 = await postJson(inst.port, '/api/lookup', {});
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'keyword_required');

    const r2 = await postJson(inst.port, '/api/lookup', { keyword: '   ' });
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'keyword_required');

    const r3 = await postJson(inst.port, '/api/lookup', { keyword: 'x'.repeat(201) });
    assert.equal(r3.status, 400);
    assert.equal(r3.body.error, 'keyword_too_long');
  } finally {
    await inst.close();
    await fsp.rm(t.root, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 4) F19：日志文件 14 天清理 + 任务生命周期记录 + 关闭记录
// ---------------------------------------------------------------------------
test('4) 日志文件：启动清理 14 天前、记录任务生命周期与关闭', async () => {
  const t = await tempSetup('logs');
  const logsDir = path.join(t.dataDir, 'logs');
  await fsp.mkdir(logsDir, { recursive: true });
  const oldLog = path.join(logsDir, 'avc-2020-01-01.log');
  await fsp.writeFile(oldLog, '2020-01-01T00:00:00.000Z INFO old\n', 'utf8');
  const oldTime = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  await fsp.utimes(oldLog, oldTime, oldTime);
  const videos = path.join(t.root, 'videos');
  await fsp.mkdir(videos, { recursive: true });
  const todayLog = () => path.join(t.dataDir, 'logs', `avc-${localDateStr()}.log`);

  const inst = await startTestServer({ configFile: t.configFile });
  try {
    assert.equal(fs.existsSync(oldLog), false, '14 天前的日志应在启动时清理');
    const jobId = await createEmptyPlanJob(inst.port, videos);
    const done = await waitJobDone(inst.port, jobId);
    await waitUntil(async () => {
      const text = await fsp.readFile(todayLog(), 'utf8').catch(() => '');
      return /job finishing/.test(text);
    }, { label: 'job finalization log line' });
    const text = await fsp.readFile(todayLog(), 'utf8');
    assert.match(text, new RegExp(`job created ${jobId} kind=plan`));
    assert.match(text, new RegExp(`job started ${jobId}`));
    assert.match(text, new RegExp(`job finishing ${jobId} status=done`));
    const persisted = JSON.parse(await fsp.readFile(path.join(t.dataDir, 'jobs', `${jobId}.json`), 'utf8'));
    assert.equal(persisted.status, 'done');
    assert.equal(persisted.finishedAt, done.finishedAt);
    assert.equal(persisted.reportJson, done.reportJson);
    assert.ok(Array.isArray(JSON.parse(await fsp.readFile(persisted.reportJson, 'utf8')).results));
  } finally {
    await inst.close();
  }
  const closedText = await fsp.readFile(todayLog(), 'utf8');
  assert.match(closedText, /server closed/);
  await fsp.rm(t.root, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// 5) F19：全局异常处理（unhandledRejection 记录后继续；uncaughtException 写 crash 后 exit(1)）
// ---------------------------------------------------------------------------
test('5) 全局异常：unhandledRejection 记录不退出，uncaughtException 写 crash-*.log 并 exit(1)', async () => {
  const t = await tempSetup('crash');
  const serverUrl = new URL('../src/server.mjs', import.meta.url).href;
  const code = `
import { startServer } from ${JSON.stringify(serverUrl)};
const inst = await startServer({ port: 0, host: '127.0.0.1', configFile: ${JSON.stringify(t.configFile)}, quiet: true });
// 1) unhandledRejection：只记录，不退出（300ms 后服务仍可访问）
Promise.reject(new Error('rej-test'));
setTimeout(async () => {
  try {
    const r = await fetch('http://127.0.0.1:' + inst.port + '/api/health');
    console.log('ALIVE ' + r.status);
    // 2) uncaughtException：写 crash 日志后 exit(1)
    setTimeout(() => { throw new Error('boom-crash-test'); }, 30);
  } catch (e) {
    console.error('ALIVE_FAIL ' + (e && e.message));
    process.exit(2);
  }
}, 300);
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('crash child timeout')); }, 20000);
    // 用 close（stdio 已关闭）而不是 exit，避免 stdout 尾部数据丢失
    child.once('close', (codeVal) => { clearTimeout(timer); resolve(codeVal); });
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
  try {
    assert.equal(exitCode, 1, `child should exit(1) on uncaughtException; stdout=${stdout} stderr=${stderr}`);
    assert.match(stdout, /ALIVE 200/, 'unhandledRejection 之后服务应继续响应');
    const logsDir = path.join(t.dataDir, 'logs');
    const names = await fsp.readdir(logsDir).catch(() => []);
    const crashNames = names.filter((n) => /^crash-.*\.log$/.test(n));
    assert.ok(crashNames.length >= 1, `应生成 crash-*.log，实际：${names.join(',')}`);
    let crashText = '';
    for (const n of crashNames) crashText += await fsp.readFile(path.join(logsDir, n), 'utf8');
    // uncaughtException：含栈，进程 exit(1)
    assert.match(crashText, /boom-crash-test/);
    assert.match(crashText, /uncaughtException/);
    // unhandledRejection：也写 crash 日志，但进程继续运行（ALIVE 200）
    assert.match(crashText, /rej-test/);
    assert.match(crashText, /unhandledRejection/);
    const avcNames = names.filter((n) => /^avc-.*\.log$/.test(n));
    assert.ok(avcNames.length >= 1);
    const avcText = await fsp.readFile(path.join(logsDir, avcNames[0]), 'utf8');
    assert.match(avcText, /unhandledRejection/);
  } finally {
    await fsp.rm(t.root, { recursive: true, force: true }).catch(() => {});
  }
});
