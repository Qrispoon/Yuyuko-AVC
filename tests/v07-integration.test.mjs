// v0.7 集成测试：可导入的 server（F20）、诊断包（F19）、反查（F16）、备份/恢复 CLI（F22）。
// 不联网：lookup 只测参数校验与失败降级；diagnose/export 的网络探测失败不影响断言。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startServer } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roots = [];
let ctx = null;

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-v07-'));
  roots.push(dir);
  return dir;
}

async function writeConfig(root, { dataDir, videos, secret = 'D:\\secret\\private\\videos' }) {
  const configPath = path.join(root, 'config.json');
  const config = {
    network: { proxy: '', proxyHosts: [], directHosts: [], defaultRoute: 'direct', timeoutMs: 800, retry: 0, minIntervalMs: 0 },
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['manko'], localDirs: [], maxCandidatesPerSource: 1, subtitlecatLimit: 1, maxDurationDeltaMin: 5, fit: { mode: 'none' }, extraLangs: [] },
    covers: { download: false, posterWhenSingle: false, embed: false },
    scan: { videoExtensions: ['.mp4'] },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots: [root, secret], maxEntries: 100 },
    media: { probeDuration: 'off' },
    metadata: { r18: false },
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { configPath, config };
}

before(async () => {
  const root = await makeRoot();
  const videos = path.join(root, 'videos');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(videos, { recursive: true });
  await fs.writeFile(path.join(videos, 'aaa.mp4'), '');
  const { configPath } = await writeConfig(root, { dataDir, videos });
  ctx = { root, videos, dataDir, configPath };
});

after(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

test('F20 startServer 可导入：health 版本来自 package.json，close() 生效', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const srv = await startServer({ port: 0, configFile: ctx.configPath, quiet: true });
  try {
    assert.ok(srv.port > 0);
    const health = await (await fetch(`http://127.0.0.1:${srv.port}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.version, pkg.version, 'VERSION 必须来自 package.json');
    assert.equal(typeof health.node, 'string');
  } finally {
    await srv.close();
  }
  // close 后端口应不可用
  await assert.rejects(fetch(`http://127.0.0.1:${srv.port}/api/health`));
});

test('F19 /api/diagnose 带 logs 字段', async () => {
  const srv = await startServer({ port: 0, configFile: ctx.configPath, quiet: true });
  try {
    const d = await (await fetch(`http://127.0.0.1:${srv.port}/api/diagnose`)).json();
    assert.equal(d.ok, true);
    assert.equal(typeof d.logs, 'object');
    assert.ok(d.logs.dir.includes('logs'));
    assert.equal(d.config.valid, true);
    assert.ok(Array.isArray(d.config.unknownKeys));
    assert.ok(Array.isArray(d.network.hosts));
  } finally {
    await srv.close();
  }
});

test('F19 诊断包导出：JSON 附件 + 默认脱敏，redact=0 保留路径', async () => {
  const srv = await startServer({ port: 0, configFile: ctx.configPath, quiet: true });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/diagnostics/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="avc-diagnostics-/);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.ok(body.generatedAt && body.version);
    assert.ok(body.diagnostics && body.config && Array.isArray(body.logs));
    assert.ok(!('paths' in body.config), 'config 副本应去掉 paths');
    // 默认脱敏：不应出现 Windows 绝对路径
    assert.doesNotMatch(text, /[A-Za-z]:\\/, '默认导出不得包含绝对路径');
    assert.match(text, /<path>/, '应有脱敏占位符');

    const raw = await fetch(`http://127.0.0.1:${srv.port}/api/diagnostics/export?redact=0`);
    const rawText = await raw.text();
    assert.match(rawText, /[A-Za-z]:\\/, 'redact=0 应保留原始路径');
  } finally {
    await srv.close();
  }
});

test('F16 /api/lookup 参数校验与失败降级', async () => {
  const srv = await startServer({ port: 0, configFile: ctx.configPath, quiet: true });
  try {
    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const missing = await post({});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'keyword_required');

    const tooLong = await post({ keyword: 'x'.repeat(201) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, 'keyword_too_long');

    // 真实网络不可用/被墙：允许 200（碰巧可用）或 502 lookup_failed
    const attempt = await post({ keyword: 'IPX-920' });
    assert.ok([200, 502].includes(attempt.status), `unexpected lookup status ${attempt.status}`);
    if (attempt.status === 200) assert.ok(Array.isArray(attempt.body.candidates));
    else assert.equal(attempt.body.error, 'lookup_failed');
  } finally {
    await srv.close();
  }
});

test('F22 CLI backup / restore 往返', async () => {
  // 先创建状态库（scan 会 openState）
  const srv = await startServer({ port: 0, configFile: ctx.configPath, quiet: true });
  try {
    const scan = await fetch(`http://127.0.0.1:${srv.port}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: ctx.videos }),
    });
    assert.equal(scan.status, 200);
  } finally {
    await srv.close();
  }
  assert.ok(await fs.stat(path.join(ctx.dataDir, 'state.db')).then(() => true).catch(() => false));

  const dest = path.join(await makeRoot(), 'backups');
  const runCli = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('exit', (code) => resolve({ code, out }));
  });

  const backup = await runCli(['backup', dest, '--config', ctx.configPath]);
  assert.equal(backup.code, 0, backup.out);
  const entries = await fs.readdir(dest);
  const backupDir = entries.find((n) => n.startsWith('avc-backup-'));
  assert.ok(backupDir, 'backup 目录应创建');
  const backupPath = path.join(dest, backupDir);
  assert.ok(await fs.stat(path.join(backupPath, 'state.db')).then(() => true).catch(() => false), '备份应包含 state.db');

  // 恢复到另一个 dataDir
  const root2 = await makeRoot();
  const dataDir2 = path.join(root2, 'data2');
  await fs.mkdir(dataDir2, { recursive: true });
  const cfg2 = await writeConfig(root2, { dataDir: dataDir2, videos: ctx.videos });
  const restore = await runCli(['restore', backupPath, '--config', cfg2.configPath, '--force']);
  assert.equal(restore.code, 0, restore.out);
  assert.ok(await fs.stat(path.join(dataDir2, 'state.db')).then(() => true).catch(() => false), '恢复后应有 state.db');
});
