// v0.7 infra-data tests (F20/F22):
//   - state.db schema migration to v2 + automatic pre-migration backup
//   - undoJournal journal-version guard
//   - undoJournal F17 `srtExtra` / `srtExtraBackup` handling
//   - `avc backup` / `avc restore` CLI round-trip (importable `main(argv)`)
//   - fixture factory sanity (91-radix encoder round-trip, generated javbus/manko fixtures)
//
// Everything runs offline against OS temp directories; the user's data/ is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openState, SCHEMA_VERSION } from '../src/core/state.mjs';
import { undoJournal, backupPathFor } from '../src/core/rename.mjs';
import { main } from '../src/cli.mjs';
import { decodeData } from '../src/sources/manko.mjs';
import { parseSearchHtml, parseDetailHtml, JAVBUS_BASE } from '../src/sources/javbus.mjs';
import { ensureFixtures, encodeData, makeR18Json, makeSrt } from './helpers/factory.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avc-v07-infra-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  });
  return dir;
}

async function exists(file) {
  return fsp.stat(file).then(() => true).catch(() => false);
}

/** Run `fn` while capturing console output (the CLI prints progress on purpose). */
async function quietly(fn) {
  const logs = [];
  const errors = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const code = await fn();
    return { code, logs, errors };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

// ---------------------------------------------------------------------------
// F22: schema migration + automatic backup
// ---------------------------------------------------------------------------
test('v07 infra: openState migrates an old database to schema v2 and backs it up first', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const dbFile = path.join(dataDir, 'state.db');
  await fsp.mkdir(dataDir, { recursive: true });

  // Build a pre-v0.7 database (user_version 0, only the files table).
  const legacy = new DatabaseSync(dbFile);
  legacy.exec(`CREATE TABLE files (
    path TEXT PRIMARY KEY, status TEXT, code TEXT, new_name TEXT,
    sub_path TEXT, error TEXT, data TEXT, updated_at INTEGER)`);
  legacy.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?)').run('C:/vids/IPX-920.mp4', 'ok', 'IPX-920', null, null, null, null, 1);
  legacy.close();
  const legacySize = fsSync.statSync(dbFile).size;
  assert.ok(legacySize > 0);

  const state = openState(dbFile);
  try {
    assert.equal(state.schemaVersion(), SCHEMA_VERSION);
    assert.equal(state.schemaVersion(), 3);
    assert.equal(state.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assert.equal(state.listFiles().length, 1, 'existing rows survive the migration');
    assert.equal(state.listFiles()[0].status, 'ok');
    assert.ok(
      state.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_files_updated'").get(),
      'migration creates idx_files_updated',
    );

    // pre-migration copy lives in <dataDir>/backups/state-v<old>-<ts>.db
    const backupsDir = path.join(dataDir, 'backups');
    const backups = await fsp.readdir(backupsDir);
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^state-v0-\d+-[0-9a-f-]{36}\.db$/);
    assert.ok(fsSync.statSync(path.join(backupsDir, backups[0])).size > 0, 'backup file is not empty');
    const copy = new DatabaseSync(path.join(backupsDir, backups[0]), { readOnly: true });
    try {
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1, 'backup is a usable database');
    } finally {
      copy.close();
    }
  } finally {
    state.close();
  }

  // Re-opening an already-migrated database must not create another backup.
  const reopened = openState(dbFile);
  try {
    assert.equal(reopened.schemaVersion(), 3);
  } finally {
    reopened.close();
  }
  const backupDbs = async () => (await fsp.readdir(path.join(dataDir, 'backups'))).filter((name) => name.endsWith('.db'));
  assert.equal((await backupDbs()).length, 1);

  // A brand-new database needs no backup at all.
  const fresh = openState(path.join(dir, 'fresh', 'state.db'));
  try {
    assert.equal(fresh.schemaVersion(), 3);
  } finally {
    fresh.close();
  }
  assert.equal(await exists(path.join(dir, 'fresh', 'backups')), false);
});

// ---------------------------------------------------------------------------
// F22: journal version guard
// ---------------------------------------------------------------------------
test('v07 infra: undoJournal rejects an unsupported version and preserves unverifiable legacy files', async (t) => {
  const dir = await tempDir(t);

  const future = path.join(dir, 'journal-v2.json');
  await fsp.writeFile(future, JSON.stringify({ version: 2, items: [] }), 'utf8');
  await assert.rejects(
    () => undoJournal(future),
    (err) => err.code === 'JOURNAL_VERSION_UNSUPPORTED' && err.version === 2,
  );

  // A legacy journal can be read, but size alone cannot authorize a mutation.
  const oldVideo = path.join(dir, 'IPX-920 old.mp4');
  const newVideo = path.join(dir, 'IPX-920 new.mp4');
  await fsp.writeFile(newVideo, 'video', 'utf8');
  const legacyJournal = path.join(dir, 'journal-legacy.json');
  await fsp.writeFile(legacyJournal, JSON.stringify({
    items: [{ from: oldVideo, to: newVideo, size: 5 }],
  }), 'utf8');

  const result = await undoJournal(legacyJournal);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'legacy_unverifiable');
  assert.equal(await exists(oldVideo), false);
  assert.equal(await fsp.readFile(newVideo, 'utf8'), 'video');
});

// ---------------------------------------------------------------------------
// F22/F17: srtExtra removal + srtExtraBackup restore
// ---------------------------------------------------------------------------
test('v07 infra: legacy undo preserves extra subtitles and backups for manual review', async (t) => {
  const dir = await tempDir(t);
  const oldVideo = path.join(dir, 'IPX-920 old.mp4');
  const newVideo = path.join(dir, 'IPX-920 new.mp4');
  const zhTw = path.join(dir, 'IPX-920 new.zh-TW.srt');
  const en = path.join(dir, 'IPX-920 new.en.srt');
  const zhTwBackup = backupPathFor(zhTw, 1700000000000);
  const enBackup = backupPathFor(en, 1700000000001);

  await fsp.writeFile(newVideo, 'video', 'utf8');
  await fsp.writeFile(zhTw, 'new traditional subtitle', 'utf8');
  await fsp.writeFile(en, 'new english subtitle', 'utf8');
  await fsp.writeFile(zhTwBackup, 'old traditional subtitle', 'utf8');
  await fsp.writeFile(enBackup, 'old english subtitle', 'utf8');

  const journalFile = path.join(dir, 'journal-extra.json');
  await fsp.writeFile(journalFile, JSON.stringify({
    version: 1,
    items: [{
      from: oldVideo,
      to: newVideo,
      size: 5,
      srtExtra: [{ lang: 'zh-TW', path: zhTw }, { lang: 'en', path: en }],
      srtExtraBackup: [
        { lang: 'zh-TW', path: zhTw, backup: zhTwBackup },
        { lang: 'en', path: en, backup: enBackup },
      ],
    }],
  }), 'utf8');

  const originalJournal = await fsp.readFile(journalFile, 'utf8');
  const result = await undoJournal(journalFile);
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].reason, 'legacy_unverifiable');
  assert.equal(result.removed, 0);
  assert.equal(result.restoredExtras.length, 0);
  assert.equal(await exists(oldVideo), false);
  assert.equal(await fsp.readFile(newVideo, 'utf8'), 'video');
  assert.equal(await fsp.readFile(zhTw, 'utf8'), 'new traditional subtitle');
  assert.equal(await fsp.readFile(en, 'utf8'), 'new english subtitle');
  assert.equal(await fsp.readFile(zhTwBackup, 'utf8'), 'old traditional subtitle');
  assert.equal(await fsp.readFile(enBackup, 'utf8'), 'old english subtitle');
  assert.equal(await fsp.readFile(journalFile, 'utf8'), originalJournal);
});

// ---------------------------------------------------------------------------
// F22: cli backup / restore round-trip
// ---------------------------------------------------------------------------
test('v07 infra: avc backup / restore round-trips the data dir (--force required to overwrite)', async (t) => {
  const dir = await tempDir(t);
  const dataDir = path.join(dir, 'data');
  const destDir = path.join(dir, 'backups-out');
  const cfgFile = path.join(dir, 'config.json');
  await fsp.mkdir(path.join(dataDir, 'jobs'), { recursive: true });
  await fsp.writeFile(cfgFile, JSON.stringify({ paths: { dataDir }, network: {} }), 'utf8');

  // minimal data dir: state.db, a journal, a run report, and two persisted jobs
  const state = openState(path.join(dataDir, 'state.db'));
  state.upsertFile(path.join(dir, 'IPX-920.mp4'), { status: 'ok', code: 'IPX-920' });
  state.close();
  const journalFile = path.join(dataDir, 'journal-20260101.json');
  await fsp.writeFile(journalFile, JSON.stringify({ version: 1, items: [] }), 'utf8');
  await fsp.writeFile(path.join(dataDir, 'run-1.json'), JSON.stringify({ n: 1 }), 'utf8');
  await fsp.writeFile(path.join(dataDir, 'jobs', 'a.json'), JSON.stringify({ id: 'a' }), 'utf8');
  await fsp.writeFile(path.join(dataDir, 'jobs', 'b.json'), JSON.stringify({ id: 'b' }), 'utf8');

  const realNow = Date.now;
  Date.now = () => 1700000000000;
  let first;
  let second;
  try {
    first = await quietly(() => main(['backup', destDir, '--config', cfgFile]));
    second = await quietly(() => main(['backup', destDir, '--config', cfgFile]));
  } finally {
    Date.now = realNow;
  }
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  const backup1 = path.join(destDir, 'avc-backup-1700000000000');
  const backup2 = path.join(destDir, 'avc-backup-1700000000000-2');
  assert.ok(await exists(backup1), 'first backup dir created');
  assert.ok(await exists(backup2), 'second backup with the same timestamp gets a -2 suffix (never overwrites)');
  for (const name of ['state.db', 'journal-20260101.json', 'run-1.json', path.join('jobs', 'a.json'), path.join('jobs', 'b.json')]) {
    assert.ok(await exists(path.join(backup1, name)), `${name} was backed up`);
    assert.ok(await exists(path.join(backup2, name)), `${name} was backed up twice`);
  }
  assert.ok(first.logs.some((line) => line.includes('backup')), 'backup prints a summary');

  // Existing database means the entire generation is skipped, including missing jobs.
  await fsp.writeFile(journalFile, JSON.stringify({ version: 1, items: [{ changed: true }] }), 'utf8');
  await fsp.rm(path.join(dataDir, 'jobs', 'b.json'), { force: true });
  const noForce = await quietly(() => main(['restore', backup1, '--config', cfgFile]));
  assert.equal(noForce.code, 0);
  assert.equal(await fsp.readFile(journalFile, 'utf8'), JSON.stringify({ version: 1, items: [{ changed: true }] }), 'existing file not overwritten');
  assert.equal(await exists(path.join(dataDir, 'jobs', 'b.json')), false, 'history cannot be mixed into an existing database generation');
  assert.ok(noForce.logs.some((line) => line.includes('--force')), 'restore tells the user about --force');

  // With --force the original content comes back.
  const forced = await quietly(() => main(['restore', backup1, '--force', '--config', cfgFile]));
  assert.equal(forced.code, 0);
  assert.equal(await fsp.readFile(journalFile, 'utf8'), JSON.stringify({ version: 1, items: [] }));
  assert.ok(await exists(path.join(dataDir, 'jobs', 'b.json')), 'forced restore installs matching history as a whole generation');
  const restoredState = openState(path.join(dataDir, 'state.db'));
  try {
    assert.equal(restoredState.listFiles().length, 1);
  } finally {
    restoredState.close();
  }

  // A missing backup directory is a normal error (exit 1), not a crash.
  const missing = await quietly(() => main(['restore', path.join(dir, 'nope'), '--config', cfgFile]));
  assert.equal(missing.code, 1);
});

// ---------------------------------------------------------------------------
// F20: fixture factory sanity
// ---------------------------------------------------------------------------
test('v07 infra: factory encodes the 91-radix envelope and generates usable fixtures', async (t) => {
  // encoder round-trip through the *real* decoder
  for (const text of ['[{"a":1}]', '{"title":"美人家庭教師","n":120}', '["ABP-984"]']) {
    assert.equal(decodeData(encodeData(text)), text, `round-trip ${text}`);
  }
  // buildable JSON helpers
  assert.equal(JSON.parse(makeR18Json({ dvd_id: 'IPX-920' })).dvd_id, 'IPX-920');
  assert.match(makeSrt([{ start: 0, end: 5, text: 'x' }]), /^1\n00:00:00,000 --> 00:00:05,000\nx\n$/);

  const dir = await tempDir(t);
  const fixtures = await ensureFixtures(path.join(dir, 'fixtures'));
  assert.equal(fixtures, path.join(dir, 'fixtures'));
  const searchHtml = await fsp.readFile(path.join(fixtures, 'javbus', 'search-ABP-984.html'), 'utf8');
  assert.deepEqual(parseSearchHtml(searchHtml), [`${JAVBUS_BASE}/ABP-984`]);
  const detailHtml = await fsp.readFile(path.join(fixtures, 'javbus', 'detail-ABP-984.html'), 'utf8');
  assert.equal(parseDetailHtml(detailHtml).durationMin, 169);

  const envelope = JSON.parse(await fsp.readFile(path.join(fixtures, 'manko', 'api-search-IPX-920.json'), 'utf8'));
  const decoded = JSON.parse(decodeData(envelope.data));
  const snapshot = JSON.parse(await fsp.readFile(path.join(fixtures, 'manko', 'search-IPX-920.json'), 'utf8'));
  assert.deepEqual(decoded, snapshot);
  assert.equal(
    (await fsp.readFile(path.join(fixtures, 'manko', 'subtitle-zh-IPX-920.srt'))).length,
    33695,
  );
});
