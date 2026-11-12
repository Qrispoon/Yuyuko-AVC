// State store: SQLite via Node built-in node:sqlite (no deps). Idempotent, resumable.
//
// F22: schema migrations are versioned with `PRAGMA user_version`. Before a migration that
// touches an existing database, VACUUM INTO captures a consistent snapshot first.
// A snapshot failure blocks migration and preserves the existing generation.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const openConnections = new Map();
export function stateConnectionCount(dbFile) { return openConnections.get(path.resolve(dbFile)) || 0; }

/** Current on-disk schema version (see the MIGRATIONS table). */
export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  status TEXT,
  code TEXT,
  new_name TEXT,
  sub_path TEXT,
  error TEXT,
  data TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  data TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS subtitles (
  code TEXT,
  lang TEXT,
  source TEXT,
  url TEXT,
  bytes INTEGER,
  cues INTEGER,
  verdict TEXT,
  local_path TEXT,
  created_at INTEGER,
  PRIMARY KEY (code, lang, source)
);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_updated ON files(updated_at);
CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, path TEXT UNIQUE, source_id TEXT, revision INTEGER NOT NULL DEFAULT 0, fields TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS corrections (id INTEGER PRIMARY KEY, record_id TEXT, revision INTEGER, fields TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS undo_projections (operation_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

export function openState(dbFile = 'data/state.db') {
  const abs = path.resolve(dbFile);
  if (fs.existsSync(path.join(path.dirname(abs), '.restore-intent.json'))) throw Object.assign(new Error('restore_recovery_required'), { code: 'RESTORE_PENDING' });
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  // "had data before we opened it" decides whether a pre-migration backup is needed.
  const existedWithData = fs.existsSync(abs) && fs.statSync(abs).size > 0;

  const db = new DatabaseSync(abs);
  // Wait up to 5s on a concurrent writer instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  const fromVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
  if (existedWithData && fromVersion < SCHEMA_VERSION) {
    try {
      const backups = path.join(path.dirname(abs), 'backups'); fs.mkdirSync(backups, { recursive: true });
      const snapshot = path.join(backups, `state-v${fromVersion}-${Date.now()}-${randomUUID()}.db`);
      db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } catch (e) {
      db.close();
      throw Object.assign(new Error('state migration backup failed'), { code: 'MIGRATION_BACKUP_FAILED', cause: e });
    }
  }
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(records)').all().some(c=>c.name==='source_id')) db.exec('ALTER TABLE records ADD COLUMN source_id TEXT');
  if (fromVersion < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  openConnections.set(abs, (openConnections.get(abs) || 0) + 1);
  let closed = false;

  const now = () => Date.now();
  const parse = (s) => {
    try { return JSON.parse(s || 'null'); } catch { return null; }
  };

  const stmt = {
    getFile: db.prepare('SELECT * FROM files WHERE path = ?'),
    upsertFile: db.prepare(`
      INSERT INTO files (path, status, code, new_name, sub_path, error, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        status=COALESCE(excluded.status, files.status),
        code=COALESCE(excluded.code, files.code),
        new_name=COALESCE(excluded.new_name, files.new_name),
        sub_path=COALESCE(excluded.sub_path, files.sub_path),
        error=excluded.error,
        data=COALESCE(excluded.data, files.data),
        updated_at=excluded.updated_at`),
    allFiles: db.prepare('SELECT * FROM files ORDER BY path'),
    filesByStatus: db.prepare('SELECT * FROM files WHERE status = ? ORDER BY path'),
    resetFile: db.prepare(`
      UPDATE files SET status='discovered', code=NULL, new_name=NULL, sub_path=NULL,
        error=NULL, data=NULL, updated_at=? WHERE path=?`),
    deleteFile: db.prepare('DELETE FROM files WHERE path=?'),
    getCode: db.prepare('SELECT * FROM codes WHERE code = ?'),
    upsertCode: db.prepare(`
      INSERT INTO codes (code, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`),
    upsertSub: db.prepare(`
      INSERT INTO subtitles (code, lang, source, url, bytes, cues, verdict, local_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code, lang, source) DO UPDATE SET
        url=excluded.url, bytes=excluded.bytes, cues=excluded.cues,
        verdict=excluded.verdict, local_path=excluded.local_path, created_at=excluded.created_at`),
    subsForCode: db.prepare('SELECT * FROM subtitles WHERE code = ?'),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM files GROUP BY status'),
  };

  return {
    db,

    record(filePath) {
      const abs = path.resolve(filePath);
      for(const name of fs.readdirSync(path.dirname(path.resolve(dbFile))).filter(n=>/^\.identity-pending-.*\.json$/.test(n))) {
        const pending=JSON.parse(fs.readFileSync(path.join(path.dirname(path.resolve(dbFile)),name),'utf8'));
        if(pending.media===abs)throw Object.assign(new Error('embedding identity reconciliation required'),{code:'EMBED_RECONCILE_PENDING'});
      }
      let identity=null;
      try {const st=fs.statSync(abs);identity=`${st.dev}:${st.ino}:${st.birthtimeMs}`;} catch {}
      const old=db.prepare('SELECT * FROM records WHERE path=?').get(abs);
      if(old && !old.source_id)stmt.resetFile.run(now(),abs);
      if(old?.source_id && identity && old.source_id!==identity) {
        // A different file placed at the same path is a new record; retain old correction history.
        db.prepare('UPDATE records SET path=NULL WHERE id=?').run(old.id);
        stmt.resetFile.run(now(),abs);
      }
      db.prepare('INSERT OR IGNORE INTO records(id,path,source_id) VALUES(?,?,?)').run(randomUUID(), abs, identity);
      if(identity) db.prepare('UPDATE records SET source_id=COALESCE(source_id,?) WHERE path=?').run(identity,abs);
      const row = db.prepare('SELECT * FROM records WHERE path=?').get(abs);
      return { ...row, fields: parse(row.fields) || {},identityVerified:!!identity };
    },
    correct(filePath, fields, revision) {
      const old = this.record(filePath);
      if (revision !== old.revision) throw Object.assign(new Error('revision_changed'), { status: 409 });
      const allowed = ['code','titleJa','titleZh','actress','releaseDate','maker','coverUrl'];
      for (const [key, value] of Object.entries(fields)) {
        if (!allowed.includes(key) || !value || typeof value.locked !== 'boolean') throw new Error('invalid_field');
        if (key === 'actress' ? !Array.isArray(value.value) || value.value.some(v => typeof v !== 'string') : typeof value.value !== 'string') throw new Error('invalid_value');
        if (key === 'releaseDate' && value.value && (!/^\d{4}-\d{2}-\d{2}$/.test(value.value) || !Number.isFinite(Date.parse(value.value)) || new Date(value.value).toISOString().slice(0,10) !== value.value)) throw new Error('invalid_date');
        if (key === 'coverUrl' && value.value) {
          let url; try { url = new URL(value.value); } catch { throw new Error('invalid_cover_url'); }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_cover_url');
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO corrections(record_id,revision,fields,at) VALUES(?,?,?,?)').run(old.id, old.revision, JSON.stringify(old.fields), now());
        const updated = db.prepare('UPDATE records SET fields=?,revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(fields),old.id,revision);
        if (!updated.changes) throw Object.assign(new Error('revision_changed'), {status:409});
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
      return this.record(filePath);
    },
    correctionHistory(filePath) { return db.prepare('SELECT * FROM corrections WHERE record_id=? ORDER BY id DESC LIMIT 50').all(this.record(filePath).id).map(r=>({...r, fields:parse(r.fields)})); },
    moveRecord(from, to) {
      if (path.resolve(from) === path.resolve(to)) return;
      // Only an explicit program rename/undo transfers identity. Never match by code/size.
      const row = db.prepare('SELECT id FROM records WHERE path=?').get(path.resolve(from));
      if (!row) return;
      const occupied = db.prepare('SELECT id,fields FROM records WHERE path=?').get(path.resolve(to));
      if(occupied && occupied.fields!=='{}') throw new Error('record_target_occupied');
      db.prepare('DELETE FROM records WHERE path=?').run(path.resolve(to));
      db.prepare('UPDATE records SET path=? WHERE id=?').run(path.resolve(to),row.id);
    },
    replaceRecordIdentity({ recordId, filePath, oldIdentity, newIdentity, operationId }) {
      if (!operationId || !oldIdentity || !newIdentity) throw new Error('replacement_evidence_required');
      const row = db.prepare('SELECT * FROM records WHERE id=? AND path=?').get(recordId, path.resolve(filePath));
      if (!row) throw new Error('replacement_record_changed');
      if (row.source_id === newIdentity) return { ...row, fields: parse(row.fields) || {} };
      if (row.source_id !== oldIdentity) throw new Error('replacement_identity_changed');
      const changed = db.prepare('UPDATE records SET source_id=?, revision=revision+1 WHERE id=? AND source_id=?').run(newIdentity, recordId, oldIdentity);
      if (!changed.changes) throw new Error('replacement_identity_changed');
      const current = db.prepare('SELECT * FROM records WHERE id=?').get(recordId);
      return { ...current, fields: parse(current.fields) || {} };
    },
    projectUndo(item) {
      if(!item.operationId||!item.undo?.videoDone)throw new Error('undo_video_incomplete');
      db.exec('BEGIN IMMEDIATE');
      try {
        if(db.prepare('SELECT 1 FROM undo_projections WHERE operation_id=?').get(item.operationId)){db.exec('COMMIT');return false;}
        if(item.to!==item.from)this.moveRecord(item.to,item.from);
        this.resetFile(item.from);
        if(item.to!==item.from)this.deleteFile(item.to);
        db.prepare('INSERT INTO undo_projections VALUES(?,?)').run(item.operationId,now());
        db.exec('COMMIT');return true;
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    clearCodeCache() {
      const rows = db.prepare('SELECT data FROM codes').all();
      const bytes = rows.reduce((n, row) => n + Buffer.byteLength(row.data || ''), 0);
      const { changes } = db.prepare('DELETE FROM codes').run();
      return { entries: Number(changes), bytes };
    },

    getFile(filePath) {
      const row = stmt.getFile.get(path.resolve(filePath));
      if (!row) return null;
      return { ...row, data: parse(row.data) };
    },

    /** Merge-update a file row. Pass only the fields you want to change. */
    upsertFile(filePath, patch = {}) {
      const abs = path.resolve(filePath);
      const prev = stmt.getFile.get(abs);
      const merged = {
        status: patch.status ?? prev?.status ?? 'discovered',
        code: patch.code ?? prev?.code ?? null,
        new_name: patch.newName ?? prev?.new_name ?? null,
        sub_path: patch.subPath ?? prev?.sub_path ?? null,
        error: patch.error ?? null,
        data: patch.data !== undefined ? JSON.stringify(patch.data) : prev?.data ?? null,
      };
      stmt.upsertFile.run(abs, merged.status, merged.code, merged.new_name, merged.sub_path, merged.error, merged.data, now());
      return this.getFile(abs);
    },

    listFiles() {
      return stmt.allFiles.all().map((r) => ({ ...r, data: parse(r.data) }));
    },

    listByStatus(status) {
      return stmt.filesByStatus.all(status).map((r) => ({ ...r, data: parse(r.data) }));
    },

    /** true when the file was fully processed and its size still matches. */
    isProcessed(filePath, meta) {
      const row = this.getFile(filePath);
      if (!row) return false;
      if (!['ok', 'no_subtitle'].includes(row.status)) return false;
      const d = row.data || {};
      return !meta || (d.size === meta.size);
    },

    /**
     * Reset a file row back to "discovered" (used by /api/undo after a journal restore).
     * Clears status/code/newName/subPath/error/data; the row itself is kept.
     * @returns {object|null} the reset row (or null when the path was unknown)
     */
    resetFile(filePath) {
      const abs = path.resolve(filePath);
      stmt.resetFile.run(now(), abs);
      return this.getFile(abs);
    },

    /** Delete a file row (used by /api/undo for the post-rename path). */
    deleteFile(filePath) {
      const abs = path.resolve(filePath);
      const info = stmt.deleteFile.run(abs);
      return (info?.changes ?? 0) > 0;
    },

    getCode(code) {
      const row = stmt.getCode.get(String(code).toUpperCase());
      if (!row) return null;
      return { code: row.code, ...(parse(row.data) || {}), updated_at: row.updated_at };
    },

    putCode(code, data) {
      stmt.upsertCode.run(String(code).toUpperCase(), JSON.stringify(data || {}), now());
      return this.getCode(code);
    },

    putSubtitle(record) {
      stmt.upsertSub.run(
        record.code, record.lang || 'zh', record.source || 'unknown',
        record.url || null, record.bytes ?? null, record.cues ?? null,
        record.verdict || null, record.local_path || null, now(),
      );
    },

    subtitlesFor(code) {
      return stmt.subsForCode.all(String(code).toUpperCase());
    },

    summary() {
      const rows = stmt.counts.all();
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },

    /** Current on-disk schema version (read back from `PRAGMA user_version`). */
    schemaVersion() {
      try {
        return Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
      } catch {
        return 0;
      }
    },

    close() {
      if (closed) return;
      db.close(); closed = true;
      const count = (openConnections.get(abs) || 1) - 1;
      if (count) openConnections.set(abs, count); else openConnections.delete(abs);
    },
  };
}

export default openState;
