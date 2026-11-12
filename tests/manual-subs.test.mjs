// v0.7.1：手动字幕/封面接口单测 + server 集成（本地字幕源，不联网）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSubtitleCatalog, normalizeSubtitleLang } from '../src/subs/manual.mjs';
import { startServer } from '../src/server.mjs';
import {applyRenames} from '../src/core/journal.mjs';

const roots = [];
async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-manual-'));
  roots.push(dir);
  return dir;
}

function srt(lines) {
  return lines.map((text, i) => {
    const start = String(i * 3 + 1).padStart(2, '0');
    const end = String(i * 3 + 2).padStart(2, '0');
    return `${i + 1}\n00:00:${start},000 --> 00:00:${end},000\n${text}\n`;
  }).join('\n');
}

function fakeHttp() {
  return {
    getFollow: async () => { throw Object.assign(new Error('no network in tests'), { code: 'NET_ERR' }); },
    get: async () => { throw Object.assign(new Error('no network in tests'), { code: 'NET_ERR' }); },
    json: async () => { throw Object.assign(new Error('no network in tests'), { code: 'NET_ERR' }); },
    probe: async () => ({ ok: false, status: 0, ms: 0, route: 'direct', error: 'NET_ERR' }),
    routeFor: () => 'direct',
    stats: { requests: 0, retries: 0, fallbacks: 0, errors: 0, byRoute: {} },
    jar: new Map(),
  };
}

function baseConfig({ dataDir, localDirs = [], extra = {} } = {}) {
  return {
    network: { proxy: '', proxyHosts: [], directHosts: [], defaultRoute: 'direct', timeoutMs: 500, retry: 0, minIntervalMs: 0 },
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['local'], localDirs, maxCandidatesPerSource: 4, fit: { mode: 'none' }, maxDurationDeltaMin: 5 },
    covers: { download: false, posterWhenSingle: false, embed: false },
    scan: { videoExtensions: ['.mp4'] },
    paths: { dataDir },
    fs: { enabled: true, allowedRoots: [], maxEntries: 100 },
    media: { probeDuration: 'off' },
    metadata: { r18: false },
    ...extra,
  };
}

test('normalizeSubtitleLang 映射', () => {
  assert.equal(normalizeSubtitleLang('zh-CN'), 'zh');
  assert.equal(normalizeSubtitleLang('zh-TW'), 'zh-TW');
  assert.equal(normalizeSubtitleLang('en'), 'en');
  assert.equal(normalizeSubtitleLang('kor'), 'ko');
  assert.equal(normalizeSubtitleLang(''), 'zh');
});

test('catalog：本地源候选列表与安装（备份 + 额外语言 + journal）', async () => {
  const root = await makeRoot();
  const videos = path.join(root, 'videos');
  const subs = path.join(root, 'subs');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(videos, { recursive: true });
  await fs.mkdir(subs, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const video = path.join(videos, 'IPX-920.mp4');
  await fs.writeFile(video, '');
  const zhSrt = path.join(subs, 'IPX-920.srt');
  await fs.writeFile(zhSrt, srt(['第一句', '第二句']), 'utf8');
  const enSrt = path.join(subs, 'IPX-920.en.srt');
  await fs.writeFile(enSrt, srt(['hello', 'world']), 'utf8');

  const config = baseConfig({ dataDir, localDirs: [subs] });
  const catalog = createSubtitleCatalog({ config, http: fakeHttp() });
  const found = await catalog.list('IPX-920', { limit: 10 });
  assert.ok(found.length >= 1);
  assert.equal(found[0].source, 'local');
  assert.equal(found[0].lang, 'zh');
  assert.equal(found[0].localPath, zhSrt);

  // 安装：写出同目录 .srt
  const first = await catalog.installChosen({ file: video, candidate: found[0], durationSec: null, fit: { mode: 'none' } });
  const installed = path.join(videos, 'IPX-920.srt');
  assert.equal(first.path, installed);
  assert.ok(await fs.stat(installed).then(() => true).catch(() => false));
  assert.equal(first.cues, 2);
  assert.equal(first.backup, null);

  // 第二次安装：旧字幕备份为 .avc-bak-*
  const second = await catalog.installChosen({ file: video, candidate: found[0], durationSec: null, fit: { mode: 'none' } });
  assert.ok(second.backup, 'second install must back up the previous .srt');
  assert.match(path.basename(second.backup), /\.avc-bak-\d+$/);

  // 额外语言：写 <stem>.en.srt
  const en = await catalog.installChosen({
    file: video,
    candidate: { source: 'local', lang: 'en', name: 'IPX-920.en.srt', localPath: enSrt },
    durationSec: null,
    fit: { mode: 'none' },
  });
  assert.equal(path.basename(en.path), 'IPX-920.en.srt');
  assert.ok(en.warnings.includes('non_zh_lang:en'));

  // journal：手动字幕记入条目
  const journalFile = path.join(dataDir, 'journal-test.json');
  const renamed = path.join(videos, 'IPX-920 renamed.mp4');
  await applyRenames([{from:video,to:renamed,action:'rename'}],{dataDir,journalFile});
  const withJournal = await catalog.installChosen({
    file: renamed,
    candidate: { source: 'local', lang: 'zh', name: 'IPX-920.srt', localPath: zhSrt },
    durationSec: null,
    journal: { file: journalFile, toPath: renamed },
    fit: { mode: 'none' },
  });
  assert.equal(withJournal.journal, journalFile);
  const journalData = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(journalData.items[0].srt, withJournal.path);
});

test('catalog：非法候选被拒绝', async () => {
  const root = await makeRoot();
  const video = path.join(root, 'IPX-920.mp4');
  await fs.writeFile(video, '');
  const empty = path.join(root, 'empty.srt');
  await fs.writeFile(empty, '');
  const config = baseConfig({ dataDir: path.join(root, 'data'), localDirs: [root] });
  const catalog = createSubtitleCatalog({ config, http: fakeHttp() });
  await assert.rejects(
    () => catalog.installChosen({ file: video, candidate: { source: 'local', localPath: empty }, fit: { mode: 'none' } }),
    (e) => e.code === 'SUBTITLE_REJECTED' && e.reason === 'empty',
  );
  await assert.rejects(
    () => catalog.installChosen({ file: video, candidate: { source: 'unknown', url: 'https://example.com/x.srt' } }),
    (e) => e.code === 'SUBTITLE_SOURCE_UNAVAILABLE',
  );
});

test('server：/api/subtitles/candidates 与 /api/subtitles/apply（本地源，不联网）', async () => {
  const root = await makeRoot();
  const videos = path.join(root, 'videos');
  const subs = path.join(root, 'subs');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(videos, { recursive: true });
  await fs.mkdir(subs, { recursive: true });
  const video = path.join(videos, 'IPX-920.mp4');
  await fs.writeFile(video, '');
  await fs.writeFile(path.join(subs, 'IPX-920.srt'), srt(['第一句', '第二句']), 'utf8');
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(baseConfig({ dataDir, localDirs: [subs] }), null, 2));

  const srv = await startServer({ port: 0, configFile: configPath, quiet: true });
  try {
    const post = async (p, body) => {
      const res = await fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };

    const missing = await post('/api/subtitles/candidates', {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'file_required');

    const notVideo = await post('/api/subtitles/candidates', { file: configPath });
    assert.equal(notVideo.status, 400);
    assert.equal(notVideo.body.error, 'not_video');

    const list = await post('/api/subtitles/candidates', { file: video });
    assert.equal(list.status, 200);
    assert.equal(list.body.code, 'IPX-920');
    assert.ok(Array.isArray(list.body.candidates) && list.body.candidates.length >= 1);
    assert.equal(list.body.candidates[0].source, 'local');

    const noCandidate = await post('/api/subtitles/apply', { file: video });
    assert.equal(noCandidate.status, 400);
    assert.equal(noCandidate.body.error, 'candidate_required');

    const applied = await post('/api/subtitles/apply', { file: video, candidate: list.body.candidates[0] });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.ok(applied.body.path.endsWith('IPX-920.srt'));
    assert.ok(await fs.stat(applied.body.path).then(() => true).catch(() => false));

    const coverMissing = await post('/api/cover/fetch', { file: video });
    assert.equal(coverMissing.status, 400);
    assert.equal(coverMissing.body.error, 'cover_url_missing');

    const coverBadUrl = await post('/api/cover/fetch', { file: video, url: 'not-a-url' });
    assert.equal(coverBadUrl.status, 400);
    assert.equal(coverBadUrl.body.error, 'invalid_url');
  } finally {
    await srv.close();
  }
});

after(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});
