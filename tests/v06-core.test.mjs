// Offline tests for the v0.6 backend-core changes (SPEC §1.10).
//
// Everything runs against OS temp dirs (fs.mkdtemp(os.tmpdir())); nothing here touches the
// network, the user's data/ directory or an external binary.
//
// Covers:
//   1. configSignature      stable hash of the result-affecting config subset
//   2. shouldSkipFile       resumability matrix (force/override/terminal/plan/apply/size)
//   3. backupFile           `.avc-bak-<ms>` sidecar backups
//   4. undoJournal          legacy evidence rejection + typed apply/undo
//   5. scanDirectory        duplicate-code detection (metadata only)
//   6. processFile          persist:false never writes state.upsertFile
//   (+) durationSecOf       unified F7 duration computation
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  configSignature,
  shouldSkipFile,
  durationSecOf,
  scanDirectory,
  processFile,
} from '../src/pipeline.mjs';
import { backupPathFor, backupFile, undoJournal } from '../src/core/rename.mjs';
import { openState } from '../src/core/state.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avc-v06-core-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });
  return dir;
}

async function exists(file) {
  return fsp.stat(file).then(() => true).catch(() => false);
}

/** Minimal config used by processFile: no network, no probing, no covers. */
function testConfig(extra = {}) {
  return {
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['manko', 'subtitlecat'], maxDurationDeltaMin: 5 },
    covers: {},
    media: { probeDuration: 'off' },
    ...extra,
  };
}

/** No-op ctx for processFile calls that never leave the local-filesystem path. */
function testCtx(config, state) {
  return { config, state, logger: () => {} };
}

// ---------------------------------------------------------------------------
// 1. configSignature
// ---------------------------------------------------------------------------
test('v06 core: configSignature is stable, key-order independent and change-sensitive', () => {
  const a = {
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['manko', 'subtitlecat'] },
    covers: {},
  };
  const sig = configSignature(a);
  assert.match(sig, /^v06-[0-9a-f]{8}$/);
  assert.equal(configSignature(a), sig, 'same config -> same signature');
  assert.equal(configSignature({ ...a }), sig, 'same config (fresh object) -> same signature');

  // stable key order: insertion order must not matter
  const ordered = { rename: { template: 'X', maxLength: 100 }, subs: {}, covers: {}, media: {} };
  const reversed = { media: {}, covers: {}, subs: {}, rename: { maxLength: 100, template: 'X' } };
  assert.equal(configSignature(ordered), configSignature(reversed));

  // unrelated keys are outside the signature
  assert.equal(configSignature({ ...a, network: { timeoutMs: 1 }, paths: { dataDir: 'x' } }), sig);

  // result-affecting keys must change it
  const changes = [
    { ...a, rename: { ...a.rename, template: '{code} {title}' } },
    { ...a, rename: { ...a.rename, maxLength: 120 } },
    { ...a, subs: { ...a.subs, sources: ['subtitlecat'] } },
    { ...a, subs: { ...a.subs, localDirs: ['D:\\subs'] } },
    { ...a, covers: { ...a.covers, embed: true } },
    { ...a, covers: { ...a.covers, download: false } },
    { ...a, media: { probeDuration: 'off' } },
  ];
  for (const cfg of changes) assert.notEqual(configSignature(cfg), sig);

  // defaults are explicit: an empty config has a well-defined signature
  assert.match(configSignature({}), /^v06-[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------------------
// 2. shouldSkipFile matrix
// ---------------------------------------------------------------------------
test('v06 core: shouldSkipFile follows the SPEC §1.2 matrix', () => {
  const SIG = 'v06-aaaaaaaa';
  const prev = { status: 'ok', data: { size: 100, applied: false, planSig: SIG } };
  const applied = { status: 'ok', data: { size: 100, applied: true, planSig: SIG } };
  const base = { prev, fileSize: 100, apply: false, force: false, planSig: SIG, hasOverride: false };

  // rule 1: force / manual override always reprocess
  assert.equal(shouldSkipFile({ ...base, force: true }), false);
  assert.equal(shouldSkipFile({ ...base, hasOverride: true }), false);
  // rule 2: no previous row
  assert.equal(shouldSkipFile({ ...base, prev: null }), false);
  // rule 3: size changed (or unknown previous size counts as "same")
  assert.equal(shouldSkipFile({ ...base, fileSize: 101 }), false);
  assert.equal(shouldSkipFile({ ...base, prev: { status: 'ok', data: { size: null, applied: false, planSig: SIG } } }), true);
  // rule 4: terminal statuses skip without a signature match
  assert.equal(shouldSkipFile({ ...base, prev: { status: 'no_code', data: { size: 100 } } }), true);
  assert.equal(shouldSkipFile({ ...base, prev: { status: 'out_of_scope', data: { size: 100 } } }), true);
  // rule 7: plan mode — same signature skips, changed signature does not
  assert.equal(shouldSkipFile({ ...base, apply: false }), true);
  assert.equal(shouldSkipFile({ ...base, apply: false, planSig: 'v06-bbbbbbbb' }), false);
  // rule 6: apply mode — only an already-applied row with the same signature skips
  assert.equal(shouldSkipFile({ ...base, prev: applied, apply: true }), true);
  assert.equal(shouldSkipFile({ ...base, prev: applied, apply: true, planSig: 'v06-bbbbbbbb' }), false);
  assert.equal(shouldSkipFile({ ...base, apply: true }), false);
  // legacy rows (pre-v0.6, no planSig) are reprocessed once
  assert.equal(shouldSkipFile({ ...base, prev: { status: 'ok', data: { size: 100, applied: true } }, apply: true }), false);
  assert.equal(shouldSkipFile({ ...base, prev: { status: 'ok', data: { size: 100 } }, apply: false }), false);
});

// ---------------------------------------------------------------------------
// 3. backupFile / backupPathFor
// ---------------------------------------------------------------------------
test('v06 core: backupFile renames an existing sidecar and returns its backup path', async (t) => {
  const dir = await tempDir(t);
  const srt = path.join(dir, 'IPX-920 中字.srt');
  await fsp.writeFile(srt, 'old subtitle', 'utf8');

  assert.match(backupPathFor(srt), /\.avc-bak-\d+$/);
  assert.equal(path.dirname(backupPathFor(srt)), dir, 'backup path lives next to the sidecar');
  const backup = await backupFile(srt);
  assert.ok(backup, 'backup path returned');
  assert.match(path.basename(backup), /^IPX-920 中字\.srt\.avc-bak-\d+$/);
  assert.equal(path.dirname(backup), dir, 'backup stays in the same directory');
  assert.equal(await exists(srt), false, 'original was renamed away');
  assert.equal(await fsp.readFile(backup, 'utf8'), 'old subtitle');

  // missing file -> null, no error
  assert.equal(await backupFile(path.join(dir, 'missing.srt')), null);

  // second backup in the same millisecond must not clobber the first
  await fsp.writeFile(srt, 'second', 'utf8');
  const backup2 = await backupFile(srt);
  assert.ok(backup2);
  assert.notEqual(backup2, backup);
  assert.equal(await fsp.readFile(backup, 'utf8'), 'old subtitle');
  assert.equal(await fsp.readFile(backup2, 'utf8'), 'second');
});

// ---------------------------------------------------------------------------
// 4. undoJournal
// ---------------------------------------------------------------------------
test('v06 core: legacy undo preserves video, sidecars, backups and original journal without historical evidence', async (t) => {
  const dir = await tempDir(t);
  const oldVideo = path.join(dir, 'IPX-920 old.mp4');
  const newVideo = path.join(dir, 'IPX-920 new.mp4');
  const newSrt = path.join(dir, 'IPX-920 new.srt');
  const newCover = path.join(dir, 'IPX-920 new.jpg');
  const srtBackup = backupPathFor(newSrt, 1700000000000);
  const coverBackup = backupPathFor(newCover, 1700000000001);

  await fsp.writeFile(newVideo, 'video', 'utf8'); // 5 bytes, matches item.size
  await fsp.writeFile(newSrt, 'subtitle written by apply', 'utf8');
  await fsp.writeFile(newCover, 'cover written by apply', 'utf8');
  await fsp.writeFile(srtBackup, 'subtitle before apply', 'utf8');
  await fsp.writeFile(coverBackup, 'cover before apply', 'utf8');

  const journalFile = path.join(dir, 'journal-1.json');
  await fsp.writeFile(journalFile, JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    items: [{
      from: oldVideo, to: newVideo, size: 5,
      srt: newSrt, srtBackup,
      cover: newCover, coverBackup,
    }],
  }), 'utf8');

  const originalJournal = await fsp.readFile(journalFile, 'utf8');
  const result = await undoJournal(journalFile);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'legacy_unverifiable');
  assert.equal(result.removed, 0);
  assert.equal(result.restoredItems.length, 0);
  assert.equal(result.restoredExtras.length, 0);
  assert.equal(await exists(oldVideo), false);
  assert.equal(await fsp.readFile(newVideo, 'utf8'), 'video');
  assert.equal(await fsp.readFile(newSrt, 'utf8'), 'subtitle written by apply');
  assert.equal(await fsp.readFile(newCover, 'utf8'), 'cover written by apply');
  assert.equal(await fsp.readFile(srtBackup, 'utf8'), 'subtitle before apply');
  assert.equal(await fsp.readFile(coverBackup, 'utf8'), 'cover before apply');
  assert.equal(await fsp.readFile(journalFile, 'utf8'), originalJournal);

  // Repeating a rejected legacy undo cannot convert current evidence into history.
  const again = await undoJournal(journalFile);
  assert.equal(again.restored, 0);
  assert.equal(again.failed[0].reason, 'legacy_unverifiable');
  assert.equal(await fsp.readFile(newSrt, 'utf8'), 'subtitle written by apply');
  assert.equal(await fsp.readFile(journalFile, 'utf8'), originalJournal);
});

test('v06 core: undoJournal refuses a busy source and keeps the new sidecars', async (t) => {
  const dir = await tempDir(t);
  const oldVideo = path.join(dir, 'IPX-920 old.mp4');
  const newVideo = path.join(dir, 'IPX-920 new.mp4');
  const newSrt = path.join(dir, 'IPX-920 new.srt');
  await fsp.writeFile(oldVideo, 'old video', 'utf8');
  await fsp.writeFile(newVideo, 'new video', 'utf8');
  await fsp.writeFile(newSrt, 'new subtitle', 'utf8');

  const journalFile = path.join(dir, 'journal-busy.json');
  await fsp.writeFile(journalFile, JSON.stringify({
    version: 1,
    items: [{ from: oldVideo, to: newVideo, size: 9, srt: newSrt }],
  }), 'utf8');

  const result = await undoJournal(journalFile);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'legacy_unverifiable');
  // nothing was touched: the busy source is intact and the sidecar was not deleted
  assert.equal(await fsp.readFile(oldVideo, 'utf8'), 'old video');
  assert.equal(await fsp.readFile(newVideo, 'utf8'), 'new video');
  assert.equal(await fsp.readFile(newSrt, 'utf8'), 'new subtitle');
});

// ---------------------------------------------------------------------------
// 5. scanDirectory duplicates
// ---------------------------------------------------------------------------
test('v06 core: scanDirectory reports duplicate codes within one directory', async (t) => {
  const dir = await tempDir(t);
  await fsp.writeFile(path.join(dir, 'IPX-920.mp4'), 'a');
  await fsp.writeFile(path.join(dir, 'IPX-920 copy.mp4'), 'bb');
  await fsp.writeFile(path.join(dir, 'ABC-001.mp4'), 'ccc');

  const items = await scanDirectory(dir, testConfig());
  assert.equal(items.length, 3);
  const byName = new Map(items.map((it) => [it.name, it]));
  for (const it of items) assert.ok(Array.isArray(it.duplicates), `${it.name} has a duplicates array`);

  const first = byName.get('IPX-920.mp4');
  const second = byName.get('IPX-920 copy.mp4');
  const solo = byName.get('ABC-001.mp4');
  assert.deepEqual(first.duplicates, [path.join(dir, 'IPX-920 copy.mp4')]);
  assert.deepEqual(second.duplicates, [path.join(dir, 'IPX-920.mp4')]);
  assert.deepEqual(solo.duplicates, []);

  // a directory with a single file has no duplicates
  const soloDir = await tempDir(t);
  await fsp.writeFile(path.join(soloDir, 'MIDE-001.mp4'), 'x');
  const soloItems = await scanDirectory(soloDir, testConfig());
  assert.equal(soloItems.length, 1);
  assert.deepEqual(soloItems[0].duplicates, []);
});

// ---------------------------------------------------------------------------
// 6. processFile persist:false
// ---------------------------------------------------------------------------
test('v06 core: processFile persist:false writes no file row but still returns the result', async (t) => {
  const dir = await tempDir(t);
  const dbFile = path.join(dir, 'state.db');
  const state = openState(dbFile);
  try {
    const config = testConfig({paths:{dataDir:dir}});
    const sig = configSignature(config);
    const ctx = testCtx(config, state);
    const file = { path: path.join(dir, 'no-code-video.mp4'), name: 'no-code-video.mp4', size: 123 };

    const before = state.listFiles().length;
    const preview = await processFile(ctx, file, { persist: false, downloadSubs: true });
    assert.equal(preview.status, 'no_code');
    assert.equal(preview.rename, null);
    assert.equal(state.listFiles().length, before, 'persist:false must not write state rows');
    assert.equal(state.getFile(file.path), null);

    // the same call with persist:true (the default) records planSig/stage
    const planned = await processFile(ctx, file, { persist: true, downloadSubs: true });
    assert.equal(planned.status, 'no_code');
    const row = state.getFile(file.path);
    assert.ok(row, 'row written when persisting');
    assert.equal(row.status, 'no_code');
    assert.equal(row.data.planSig, sig);
    assert.equal(row.data.stage, 'plan');

    // and the written signature is exactly what shouldSkipFile consumes
    assert.equal(shouldSkipFile({ prev: row, fileSize: file.size, apply: false, planSig: sig }), true);
    assert.equal(shouldSkipFile({ prev: row, fileSize: file.size, apply: false, planSig: 'v06-ffffffff' }), true, 'terminal status still skips');
  } finally {
    // close before the temp cleanup hook: Windows cannot delete an open SQLite file
    try { state.close(); } catch { /* already closed */ }
  }
});

// ---------------------------------------------------------------------------
// (+) apply path: planRenames -> applyRenames -> journal -> undoJournal (offline stubs)
// ---------------------------------------------------------------------------
test('v06 core: processFile apply renames + journals the video and undo restores it', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const state = openState(path.join(dataDir, 'state.db'));
  try {
    const original = path.join(dir, 'IPX-920.mp4');
    await fsp.writeFile(original, 'video-bytes', 'utf8');

    const config = testConfig({ covers: { download: false }, paths: { dataDir } });
    const journalFile = path.join(dataDir, 'journal-apply.json');
    // Offline metadata stubs: resolveMeta only needs javbus.search + javbus.detail + manko.
    const ctx = {
      config,
      state,
      logger: () => {},
      journalFile,
      http: { stats: {} },
      javbus: {
        async search() { return 'https://javbus.test/IPX-920'; },
        async detail() { return { code: 'IPX-920', titleJa: 'テスト作品', actress: ['女優A'], durationMin: 120, coverUrl: '' }; },
      },
      manko: { async findByCode() { return null; } },
      subs: [],
    };
    const file = { path: original, name: 'IPX-920.mp4', size: 11 };
    const result = await processFile(ctx, file, { apply: true, downloadSubs: false });

    assert.equal(result.status, 'ok');
    assert.equal(result.rename.action, 'rename');
    assert.equal(result.rename.from, original);
    const renamed = result.renamedTo;
    assert.ok(renamed && renamed !== original, 'video was renamed');
    assert.equal(result.rename.to, renamed);
    assert.equal(await exists(original), false);
    assert.equal(await fsp.readFile(renamed, 'utf8'), 'video-bytes');

    // journal records the rename; both state rows know planSig/stage
    const journal = JSON.parse(await fsp.readFile(journalFile, 'utf8'));
    assert.equal(journal.items.length, 1);
    assert.equal(journal.items[0].from, original);
    assert.equal(journal.items[0].to, renamed);
    const sig = configSignature(config);
    const rowFrom = state.getFile(original);
    assert.equal(rowFrom.data.stage, 'apply');
    assert.equal(rowFrom.data.applied, true);
    assert.equal(rowFrom.data.planSig, sig);
    assert.equal(rowFrom.data.renamedTo, renamed);
    assert.deepEqual(rowFrom.data.rename, result.rename, 'rename plan persisted for /api/scan');
    const rowTo = state.getFile(renamed);
    assert.equal(rowTo.data.fromPath, original);
    assert.deepEqual(rowTo.data.rename, result.rename);

    // undo puts the video back; the DB cleanup sequence mirrors POST /api/undo
    const undo = await undoJournal(journalFile);
    assert.equal(undo.restored, 1);
    assert.equal(undo.failed.length, 0);
    assert.equal(await exists(original), true);
    assert.equal(await exists(renamed), false);
    state.resetFile(original);
    state.deleteFile(renamed);
    assert.equal(state.getFile(original).status, 'discovered');
    assert.equal(state.getFile(original).data, null);
    assert.equal(state.getFile(renamed), null);
  } finally {
    try { state.close(); } catch { /* already closed */ }
  }
});

// ---------------------------------------------------------------------------
// (+) F4: apply backs up an existing .srt / cover / poster and undo restores them
// ---------------------------------------------------------------------------
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body', 'latin1')]);
const ZH_SRT = [
  '1', '00:00:01,000 --> 00:00:02,000', '这个时间说话', '',
  '2', '00:00:03,000 --> 00:00:04,000', '这个时间说话', '',
].join('\n');

test('v06 core: apply backs up existing sidecars and undo restores them', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const state = openState(path.join(dataDir, 'state.db'));
  try {
    const original = path.join(dir, 'IPX-920.mp4');
    await fsp.writeFile(original, 'video-bytes', 'utf8');
    const newStem = path.join(dir, 'IPX-920 テスト作品 [女優A]');
    const targetSrt = `${newStem}.srt`;
    const targetCover = `${newStem}.jpg`;
    const targetPoster = path.join(dir, 'poster.jpg');
    // stale sidecars that the apply will overwrite (invalid srt -> download proceeds)
    await fsp.writeFile(targetSrt, 'not a subtitle', 'utf8');
    await fsp.writeFile(targetCover, 'old-cover', 'utf8');
    await fsp.writeFile(targetPoster, 'old-poster', 'utf8');

    const config = testConfig({
      covers: { download: true, posterWhenSingle: true },
      paths: { dataDir },
      subs: { sources: ['manko'], maxDurationDeltaMin: 5 },
    });
    const journalFile = path.join(dataDir, 'journal-sidecars.json');
    const ctx = {
      config,
      state,
      logger: () => {},
      journalFile,
      http: {
        stats: {},
        async getFollow() { return { status: 200, buffer: JPG, headers: { 'content-type': 'image/jpeg' }, url: 'https://img.test/a.jpg' }; },
      },
      javbus: {
        async search() { return 'https://javbus.test/IPX-920'; },
        async detail() { return { code: 'IPX-920', titleJa: 'テスト作品', actress: ['女優A'], durationMin: 120, coverUrl: 'https://img.test/a.jpg' }; },
      },
      manko: { async findByCode() { return null; } },
      subs: [{
        name: 'manko',
        async listCandidates() { return [{ name: 'zh.srt', url: 'https://sub.test/zh.srt' }]; },
        async download() { return { buffer: Buffer.from(ZH_SRT, 'utf8') }; },
      }],
    };
    const file = { path: original, name: 'IPX-920.mp4', size: 11 };
    const result = await processFile(ctx, file, { apply: true, downloadSubs: true });

    assert.equal(result.status, 'ok');
    assert.equal(result.sub.source, 'manko');
    assert.equal(await fsp.readFile(targetSrt, 'utf8').then((s) => s.includes('这个时间说话')), true, 'new subtitle written');
    assert.equal(await fsp.readFile(targetCover).then((s) => s.equals(JPG)), true, 'new cover written');

    // journal remembers the backups so undo can restore them
    const journal = JSON.parse(await fsp.readFile(journalFile, 'utf8'));
    const item = journal.items[0];
    assert.ok(item.srt && item.srtBackup, 'srt + srtBackup journaled');
    assert.ok(item.coverBackup, 'coverBackup journaled');
    assert.ok(item.posterBackup, 'posterBackup journaled');
    assert.equal(await fsp.readFile(item.srtBackup, 'utf8'), 'not a subtitle');
    assert.equal(await fsp.readFile(item.coverBackup, 'utf8'), 'old-cover');
    assert.equal(await fsp.readFile(item.posterBackup, 'utf8'), 'old-poster');

    const undo = await undoJournal(journalFile);
    assert.equal(undo.restored, 1);
    assert.equal(undo.failed.length, 0, JSON.stringify(undo.failed));
    assert.equal(undo.restoredExtras.length, 3);
    assert.equal(await exists(original), true);
    // the apply-written sidecars are gone, the pre-apply ones are back
    assert.equal(await fsp.readFile(targetSrt, 'utf8'), 'not a subtitle');
    assert.equal(await fsp.readFile(targetCover, 'utf8'), 'old-cover');
    assert.equal(await fsp.readFile(targetPoster, 'utf8'), 'old-poster');
    assert.equal(await exists(item.srtBackup), false);
  } finally {
    try { state.close(); } catch { /* already closed */ }
  }
});

// ---------------------------------------------------------------------------
// (+) F7 duration helper
// ---------------------------------------------------------------------------
test('v06 core: durationSecOf prefers the probed seconds and falls back to metadata minutes', () => {
  assert.equal(durationSecOf({ durationSec: 1234.5, durationMin: 20 }), 1234.5);
  assert.equal(durationSecOf({ durationMin: 20 }), 1200);
  assert.equal(durationSecOf({ durationSec: 0, durationMin: 20 }), 1200);
  assert.equal(durationSecOf({}), null);
  assert.equal(durationSecOf(null), null);
});
