// Rename engine: plan -> apply (with journal) -> undo. Never overwrites.
// IMPORTANT: only file METADATA (name/size/mtime) is used here — video contents are never read.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileEvidence } from './file-operations.mjs';

const LONG_PREFIX = '\\\\?\\';

export function toLongPath(p) {
  const abs = path.resolve(p);
  if (process.platform !== 'win32') return abs;
  if (abs.startsWith(LONG_PREFIX)) return abs;
  return abs.length >= 240 ? LONG_PREFIX + abs : abs;
}

/** Metadata-only fingerprint (size + mtime). No file content is read. */
export async function fingerprint(file) {
  return fileEvidence(file);
}

/**
 * @param {{file:string, newName:string, force?:boolean}[]} items
 * @param {{dir?:string}} opts
 * @returns {Promise<Array<{from:string,to:string,action:string,reason?:string}>>}
 */
export async function planRenames(items, opts = {}) {
  const plan = [];
  const claimed = new Set();
  for (const item of items) {
    const from = path.resolve(item.file);
    const dir = path.dirname(from);
    const ext = path.extname(from);
    const targetName = item.newName.toLowerCase().endsWith(ext.toLowerCase()) ? item.newName : item.newName + ext;
    let to = path.join(dir, targetName);
    const rel = { from, to, action: 'rename' };

    if (path.basename(from) === path.basename(to)) {
      plan.push({ ...rel, action: 'skip_same' });
      continue;
    }
    if (process.platform === 'win32' && from.toLowerCase() === to.toLowerCase()) {
      plan.push(rel); claimed.add(to.toLowerCase()); continue;
    }
    if (claimed.has(to.toLowerCase())) {
      plan.push({ ...rel, action: 'skip_conflict', reason: 'duplicate_target_in_batch' });
      continue;
    }
    const exists = await fs.stat(toLongPath(to)).then(() => true).catch(() => false);
    if (exists) {
      const [a, b] = await Promise.all([
        fingerprint(from).catch(() => null),
        fingerprint(to).catch(() => null),
      ]);
      // metadata-only duplicate check (content is never read)
      if (a && b && a.size === b.size) {
        plan.push({ ...rel, action: 'skip_duplicate', reason: 'same_size' });
        continue;
      }
      // find a free slot
      const stem = targetName.slice(0, targetName.length - ext.length).replace(/\s*\(\d+\)$/, '');
      let n = 2;
      for (;;) {
        const candidate = path.join(dir, `${stem} (${n})${ext}`);
        const busy = await fs.stat(toLongPath(candidate)).then(() => true).catch(() => false);
        if (!busy && !claimed.has(candidate.toLowerCase())) { to = candidate; break; }
        n++;
        if (n > 50) break;
      }
      rel.to = to;
      plan.push({ ...rel, action: 'rename', reason: 'renamed_conflict' });
      claimed.add(to.toLowerCase());
      continue;
    }
    claimed.add(to.toLowerCase());
    plan.push(rel);
  }
  return plan;
}

export { applyRenames, undoJournal, annotateJournal, ensureJournalEntry, journalPathFor, backupPathFor, backupFile, originalPathOfBackup, JOURNAL_VERSION, JOURNAL_TYPE, decodeJournal, readJournal, updateJournal, writeJournalSidecar } from './journal.mjs';
import { applyRenames, undoJournal, annotateJournal, journalPathFor, backupPathFor, backupFile, originalPathOfBackup, JOURNAL_VERSION } from './journal.mjs';
export default { planRenames, applyRenames, undoJournal, annotateJournal, fingerprint, journalPathFor, toLongPath, backupPathFor, backupFile, originalPathOfBackup, JOURNAL_VERSION };
