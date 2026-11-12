// v0.7.2：备份/恢复（模块 + API）、字幕内容预览。全部离线（临时目录）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBackup, listBackups, restoreBackup } from '../src/core/backup.mjs';
import { startServer } from '../src/server.mjs';
import {openState} from '../src/core/state.mjs';

const roots = [];
async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-bp-'));
  roots.push(dir);
  return dir;
}

async function seedDataDir(dataDir) {
  await fs.mkdir(path.join(dataDir, 'jobs'), { recursive: true });
  const state=openState(path.join(dataDir,'state.db'));
  try{state.upsertFile(path.join(dataDir,'synthetic.mp4'),{status:'discovered'});}finally{state.close();}
  await fs.writeFile(path.join(dataDir, 'journal-x.json'), JSON.stringify({ version: 1, items: [] }));
  await fs.writeFile(path.join(dataDir, 'run-1.json'), JSON.stringify({ summary: {} }));
  await fs.writeFile(path.join(dataDir, 'jobs', 'a.json'), JSON.stringify({ id: 'a' }));
}

function configFor({ dataDir, allowedRoots }) {
  return {
    network: { proxy: '', proxyHosts: [], directHosts: [], defaultRoute: 'direct', timeoutMs: 500, retry: 0, minIntervalMs: 0 },
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['local'], localDirs: [], maxCandidatesPerSource: 4, fit: { mode: 'none' } },
    covers: { download: false, posterWhenSingle: false, embed: false },
    scan: { videoExtensions: ['.mp4'] },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots, maxEntries: 100 },
    media: { probeDuration: 'off' },
    metadata: { r18: false },
  };
}

test('backup 模块：备份 → 列表 → 恢复（默认跳过 / force 覆盖）', async () => {
  const root = await makeRoot();
  const dataDir = path.join(root, 'data');
  await seedDataDir(dataDir);

  const backup = await createBackup({ dataDir });
  assert.ok(backup.files >= 4);
  assert.ok(await fs.stat(path.join(backup.path, 'state.db')).then(() => true));

  const list = await listBackups(dataDir);
  assert.equal(list.length, 1);
  assert.equal(list[0].dir, backup.path);
  assert.ok(list[0].files >= 4);

  const dataDir2 = path.join(root, 'data2');
  const restored = await restoreBackup({ backupDir: backup.path, dataDir: dataDir2, force: false });
  assert.ok(restored.copied >= 4);
  assert.equal(restored.skipped, 0);
  assert.ok(await fs.stat(path.join(dataDir2, 'state.db')).then(() => true));

  const again = await restoreBackup({ backupDir: backup.path, dataDir: dataDir2, force: false });
  assert.equal(again.copied, 0);
  assert.ok(again.skipped >= 4);
  const forced = await restoreBackup({ backupDir: backup.path, dataDir: dataDir2, force: true });
  assert.ok(forced.copied >= 4);

  await assert.rejects(
    () => restoreBackup({ backupDir: path.join(root, 'not-a-backup'), dataDir: dataDir2 }),
    (e) => e.code === 'BACKUP_DIR_NOT_FOUND' || e.code === 'INVALID_BACKUP',
  );
});

test('server API：备份/恢复、字幕预览', async () => {
  const root = await makeRoot();
  const dataDir = path.join(root, 'data');
  await seedDataDir(dataDir);
  const srtPath = path.join(root, 'IPX-920.srt');
  await fs.writeFile(srtPath, '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,000 --> 00:00:06,000\n第二句\n', 'utf8');
  const txtPath = path.join(root, 'note.txt');
  await fs.writeFile(txtPath, 'x');
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(configFor({ dataDir, allowedRoots: [root] }), null, 2));

  const srv = await startServer({ port: 0, configFile: configPath, quiet: true });
  const base = () => `http://127.0.0.1:${srv.port}`;
  const post = async (p, body) => {
    const res = await fetch(base() + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    // 备份 + 列表 + 恢复
    const backup = await post('/api/backup', {});
    assert.equal(backup.status, 200, JSON.stringify(backup.body));
    assert.ok(backup.body.path && backup.body.files >= 4);

    const backups = await (await fetch(base() + '/api/backups')).json();
    assert.ok(Array.isArray(backups.backups) && backups.backups.length >= 1);
    assert.equal(backups.backups[0].dir, backup.body.path);

    const restore = await post('/api/restore', { dir: backup.body.path, force: true });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.ok(restore.body.copied >= 4);

    const restoreMissing = await post('/api/restore', { dir: path.join(root, 'nope') });
    assert.equal(restoreMissing.status, 400);
    assert.ok(['dir_not_found', 'invalid_backup'].includes(restoreMissing.body.error));

    // 字幕内容预览
    const preview = await (await fetch(`${base()}/api/subtitle/preview?path=${encodeURIComponent(srtPath)}&lines=1`)).json();
    assert.equal(preview.count, 2);
    assert.equal(preview.cues.length, 1);
    assert.equal(preview.truncated, true);
    assert.match(preview.cues[0].start, /^00:00:01,000$/);
    assert.equal(preview.cues[0].text, '第一句');

    const noPath = await fetch(`${base()}/api/subtitle/preview`);
    assert.equal(noPath.status, 400);
    assert.equal((await noPath.json()).error, 'path_required');

    const notSrt = await fetch(`${base()}/api/subtitle/preview?path=${encodeURIComponent(txtPath)}`);
    assert.equal(notSrt.status, 400);
    assert.equal((await notSrt.json()).error, 'not_srt');

    const forbidden = path.join(os.tmpdir(), 'avc-outside.srt');
    const forbiddenRes = await fetch(`${base()}/api/subtitle/preview?path=${encodeURIComponent(forbidden)}`);
    assert.equal(forbiddenRes.status, 400);
    assert.equal((await forbiddenRes.json()).error, 'fs_forbidden');
  } finally {
    await srv.close();
  }
});

after(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});
