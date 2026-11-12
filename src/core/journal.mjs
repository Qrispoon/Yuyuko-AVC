import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { writeJsonDurable, throwIfAborted } from './durable.mjs';
import { fileEvidence, sameEvidence, moveNoReplace, convergeMove, longPath } from './file-operations.mjs';
import { withMutation } from './mutations.mjs';

export const JOURNAL_VERSION = 1;
export const JOURNAL_TYPE = 'file-operations';
const locks = new Map(), sidecarLocks = new Map();
async function serial(map, key, fn) {
  const previous = map.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  map.set(key, current);
  try { return await current; } finally { if (map.get(key) === current) map.delete(key); }
}

export function decodeJournal(data) {
  if (!data || !Array.isArray(data.items)) throw Object.assign(new Error('invalid journal'), { code: 'JOURNAL_INVALID' });
  if (data.type === 'mux-create-output' && data.version === 2) return 'mux';
  if (!data.type && (data.version == null || data.version === 1)) return 'legacy';
  if (data.type === JOURNAL_TYPE && data.version === JOURNAL_VERSION) return 'files';
  throw Object.assign(new Error(`JOURNAL_VERSION_UNSUPPORTED: ${data.type || 'legacy'}/${data.version}`), { code: 'JOURNAL_VERSION_UNSUPPORTED',version:data.version,type:data.type||'legacy' });
}

export async function readJournal(file) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  decodeJournal(value);
  return value;
}

export async function updateJournal(file, change, { create = false } = {}) {
  return serial(locks, path.resolve(file), async () => {
    let data, fresh = false;
    try { data = await readJournal(file); }
    catch (e) {
      if (e.code !== 'ENOENT' || !create) throw e;
      fresh = true;
      data = { type: JOURNAL_TYPE, version: JOURNAL_VERSION, createdAt: new Date().toISOString(), seq: 0, items: [] };
    }
    if (decodeJournal(data) !== 'files') throw Object.assign(new Error('legacy/unknown journal is read-only'), { code: 'JOURNAL_LEGACY_READ_ONLY' });
    const result = await change(data);
    data.seq++;
    await writeJsonDurable(file, data, { create: fresh });
    return result;
  });
}

export function journalPathFor(dataDir = 'data') { return path.join(dataDir, `journal-${Date.now()}-${randomUUID()}.json`); }
export function backupPathFor(file, ts = Date.now()) { return `${path.resolve(file)}.avc-bak-${ts}`; }
export function originalPathOfBackup(file) { const abs = path.resolve(String(file)); return /\.avc-bak-\d+$/i.test(abs) ? abs.replace(/\.avc-bak-\d+$/i, '') : null; }
async function optionalEvidence(file, content = true) {
  try { return await fileEvidence(file, { content }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function unusedBackup(file) {
  for (let n = Date.now(); ; n++) { const candidate = backupPathFor(file, n); if (!await optionalEvidence(candidate)) return candidate; }
}
function findItem(data, to) {
  const item = [...data.items].reverse().find(i => i.to === to && !i.undo?.complete);
  if (!item) throw Object.assign(new Error('journal entry not found'), { code: 'JOURNAL_ENTRY_MISSING' });
  return item;
}

export async function ensureJournalEntry(file, media) {
  await updateJournal(file, async data => {
    if (!data.items.some(i => i.to === media && !i.undo?.complete)) data.items.push({ operationId: randomUUID(), from: media, to: media, sidecarOnly: true, phase: 'committed', output: await fileEvidence(media), sidecars: [], at: new Date().toISOString() });
  }, { create: true });
  return file;
}

export async function applyRenames(plan, options={}) {
  return withMutation(options.dataDir||'data',()=>applyRenamesOwned(plan,options),{signal:options.signal});
}
async function applyRenamesOwned(plan, { dataDir = 'data', dryRun = false, journalFile = null, signal } = {}) {
  const executed = [], skipped = [];
  let journal = null;
  for (const entry of plan) {
    if (entry.action !== 'rename') { skipped.push(entry); continue; }
    if (dryRun) { executed.push({ ...entry, dryRun: true }); continue; }
    throwIfAborted(signal);
    const proof = await fileEvidence(entry.from), id = randomUUID();
    journal ||= journalFile || journalPathFor(dataDir);
    await updateJournal(journal, data => data.items.push({ ...entry, operationId: id, size: proof.size, mtimeMs: proof.mtimeMs, output: proof, phase: 'prepared', sidecars: [], at: new Date().toISOString() }), { create: true });
    try {
      await moveNoReplace(entry.from, entry.to, { expected: proof, signal, onPhase: (phase, extra = {}) => updateJournal(journal, data => Object.assign(data.items.find(i => i.operationId === id), { phase, ...extra })) });
      executed.push({ from: entry.from, to: entry.to, operationId: id, ...proof });
    } catch (e) { e.partial = { ...e.partial, journal, from: entry.from, to: entry.to, operationId: id }; throw e; }
  }
  return { renamed: executed.length, executed, skipped, journal };
}

/** Standalone compatibility helper; its own intent survives even without a parent journal. */
export async function backupFile(file) {
  if (!file || typeof file !== 'string') return null;
  const before = await optionalEvidence(file);
  if (!before) return null;
  const backup = await unusedBackup(file), intent = backup + '.intent.json';
  const record = { type: 'sidecar-backup', version: 1, from: path.resolve(file), to: backup, before, phase: 'prepared' };
  await writeJsonDurable(intent, record, { create: true });
  await moveNoReplace(file, backup, { expected: before, onPhase: async phase => { record.phase = phase; await writeJsonDurable(intent, record); } });
  return backup;
}

/** One sidecar transaction: expected bytes and backup identity are durable BEFORE effects. */
export async function writeJournalSidecar(journal, media, target, buffer, { kind = 'sidecar', signal } = {}) {
  return serial(sidecarLocks, path.resolve(target).toLowerCase(), async () => {
    throwIfAborted(signal);
    const bytes = Buffer.from(buffer), before = await optionalEvidence(target);
    const backup = before ? await unusedBackup(target) : null, id = randomUUID();
    const after = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await updateJournal(journal, data => {
      const item = findItem(data, media); item.sidecars ||= [];
      item.sidecars.push({ id, kind, target: path.resolve(target), backup, before, after, phase: 'prepared' });
    });
    const stage = (phase, extra = {}) => updateJournal(journal, data => {
      const item=findItem(data,media);Object.assign(item.sidecars.find(op=>op.id===id),{phase,...extra});
      if(phase==='committed'&&['srt','cover','poster'].includes(kind)){item[kind]=path.resolve(target);if(backup)item[kind+'Backup']=backup;}
      if(phase==='committed'&&['zh-TW','en','ko'].includes(kind)) {
        item.srtExtra=[...(item.srtExtra||[]).filter(e=>e.path!==path.resolve(target)),{lang:kind,path:path.resolve(target)}];
        if(backup)item.srtExtraBackup=[...(item.srtExtraBackup||[]).filter(e=>e.path!==path.resolve(target)),{lang:kind,path:path.resolve(target),backup}];
      }
    });
    if (backup) await moveNoReplace(target, backup, { expected: before, signal, onPhase: phase => stage('backup_' + phase) });
    throwIfAborted(signal);
    await stage('writing');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const output = await fs.open(longPath(target), 'wx');
    try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
    const evidence = await fileEvidence(target, { content: true });
    if (evidence.sha256 !== after.sha256) throw Object.assign(new Error('sidecar output changed'), { code: 'NEEDS_REVIEW' });
    await stage('committed', { after: evidence });
    return { path: path.resolve(target), bytes: bytes.length, backup, operationId: id };
  });
}

/** Compatibility metadata only; all product sidecar writes use writeJournalSidecar. */
export async function annotateJournal(file, to, extra = {}) {
  return updateJournal(file, async data => {
    const item = findItem(data, to);
    Object.assign(item, extra);
    // Preserve callers of the original public helper, with fingerprints and undo state.
    const observed = [ ['srt',extra.srt,extra.srtBackup], ['cover',extra.cover,extra.coverBackup], ['poster',extra.poster,extra.posterBackup], ...(extra.srtExtra || []).map(e => [e.lang,e.path,(extra.srtExtraBackup || []).find(b => b.path === e.path)?.backup]) ];
    for (const [kind,target,backup] of observed) {
      if (!target || item.sidecars?.some(op => op.target === path.resolve(target))) continue;
      const after = await optionalEvidence(target);
      if (!after) continue;
      item.sidecars ||= [];
      item.sidecars.push({ id: randomUUID(), kind, target: path.resolve(target), backup: backup || null, before: backup ? await optionalEvidence(backup) : null, after, phase: 'committed', observedByCaller: true });
    }
    return true;
  });
}

export async function undoJournal(file, {dataDir = path.dirname(path.resolve(file))} = {}) {
  return withMutation(dataDir, () => undoOwned(file));
}
async function undoOwned(file) {
  const initial = await readJournal(file), type = decodeJournal(initial);
  if (type !== 'files') {
    if (type === 'mux') throw Object.assign(new Error('mux journal requires mux undo'), { code: 'JOURNAL_TYPE_MISMATCH' });
    return { restored: 0, restoredItems: [], completedItems: [], removed: 0, restoredExtras: [], failed: initial.items.map(item => ({ ...item, reason: 'legacy_unverifiable' })), undoComplete: false };
  }
  const restored = [], completed = [], removed = [], restoredExtras = [], failed = [];
  for (const original of [...initial.items].reverse()) {
    let item = structuredClone(original);
    const save = async () => updateJournal(file, data => { data.items[data.items.findIndex(i => i.operationId === item.operationId)] = item; });
    if (item.undo?.complete) { completed.push(item); continue; }
    try {
      item.undo ||= {};
      if (item.embed?.phase && !['committed','cancelled'].includes(item.embed.phase)) throw new Error('identity_reconcile_pending');
      if (!item.undo.videoDone) {
        const caseOnly = process.platform === 'win32' && item.from !== item.to && path.resolve(item.from).toLowerCase() === path.resolve(item.to).toLowerCase();
        const output = await optionalEvidence(item.to, !!item.output?.sha256);
        const source = item.sidecarOnly ? output : await optionalEvidence(item.from, !!item.output?.sha256);
        if (caseOnly) {
          const intermediatePath=item.undo.intermediate||item.intermediate;
          const intermediate = intermediatePath && await optionalEvidence(intermediatePath, !!item.output?.sha256);
          if(output && !sameEvidence(output,item.output) || intermediate && !sameEvidence(intermediate,item.output))throw new Error('content_changed');
          if(!output && !intermediate)throw new Error('target_missing');
          item.undo.videoPhase='prepared';await save();
          if(!output)await moveNoReplace(intermediatePath,item.from,{expected:item.output,onPhase:async phase=>{item.undo.videoPhase=phase;await save();}});
          else {
            const names=await fs.readdir(path.dirname(item.from));
            if(!names.includes(path.basename(item.from)))await moveNoReplace(item.to,item.from,{expected:item.output,onPhase:async(phase,extra)=>{item.undo.videoPhase=phase;Object.assign(item.undo,extra);await save();}});
            if(intermediate) {await save();await fs.unlink(longPath(intermediatePath));}
          }
          item.undo.videoDone=true;await save();
        } else if (!output && source && sameEvidence(source, item.output) && item.undo.videoPhase) {
          item.undo.videoDone = true; await save();
        } else if (item.phase === 'prepared' && !output && source && sameEvidence(source, item.output)) {
          item.undo.videoDone = true; await save();
        } else {
          if (!output) throw new Error('target_missing');
          if (!sameEvidence(output, item.output)) throw new Error('content_changed');
          if (!item.sidecarOnly) {
            if (source) {
              // A prior publication can have two names for the original object.
              if (!sameEvidence(source, item.output) || source.identity !== output.identity) throw new Error('source_busy');
              item.undo.videoPhase = 'remove_dual'; await save();
              await fs.unlink(longPath(item.to));
            } else {
              item.undo.videoPhase = 'prepared'; await save();
              await moveNoReplace(item.to, item.from, { expected: item.output, onPhase: async phase => { item.undo.videoPhase = phase; await save(); } });
            }
          }
          item.undo.videoDone = true; await save();
        }
        restored.push(item);
      }
      for (const op of [...(item.sidecars || [])].reverse()) {
        op.undo ||= {};
        if (op.undo.done) continue;
        if (!op.undo.removed) {
          const current = await optionalEvidence(op.target);
          if (current) {
            if(op.before && sameEvidence(current,op.before)) {
              const backup=op.backup&&await optionalEvidence(op.backup);
              if(backup && sameEvidence(backup,op.before) && backup.identity===current.identity) {
                await convergeMove(op.backup,op.target,{expected:op.before,onPhase:async phase=>{op.undo.restorePhase=phase;await save();}});
                op.undo.done=true;await save();continue;
              }
              if(!backup && op.undo.phase==='restoring'){op.undo.done=true;await save();continue;}
            }
            if (op.before && sameEvidence(current, op.before) && op.phase === 'prepared') { op.undo.done = true; await save(); continue; }
            if (!sameEvidence(current, op.after)) throw new Error(`sidecar_changed: ${op.target}`);
            op.undo.quarantine ||= `${op.target}.avc-undo-${randomUUID()}`;
            op.undo.phase = 'removing'; await save();
            await convergeMove(op.target, op.undo.quarantine, { expected: current, onPhase:async phase=>{op.undo.removePhase=phase;await save();} });
            removed.push(op.target);
          } else if (op.undo.quarantine) {
            if (!sameEvidence(await optionalEvidence(op.undo.quarantine), op.after)) throw new Error('undo_quarantine_changed');
          } else if (op.phase === 'committed') throw new Error(`sidecar_missing: ${op.target}`);
          op.undo.removed = true; await save();
        }
        if (op.backup && !op.undo.restored) {
          const backup = await optionalEvidence(op.backup), current = await optionalEvidence(op.target);
          if (!backup && current && op.undo.phase === 'restoring' && sameEvidence(current, op.before)) {
            op.undo.restored = true;
          } else {
            if (!backup || !sameEvidence(backup, op.before)) throw new Error('backup_changed_or_missing');
            op.undo.phase = 'restoring'; await save();
            await convergeMove(op.backup, op.target, { expected: op.before, onPhase:async phase=>{op.undo.restorePhase=phase;await save();} });
            op.undo.restored = true;
            restoredExtras.push({ kind: op.kind, from: op.backup, to: op.target, path: op.target });
          }
          await save();
        }
        op.undo.done = true; await save();
      }
      item.undo.complete = true; item.undo.completedAt = new Date().toISOString(); await save(); completed.push(item);
    } catch (e) { failed.push({ ...item, reason: e.code || e.message }); }
  }
  // A sidecar conflict cannot hide a video path already restored durably.
  // Project from saved checkpoints, including earlier partial undo attempts.
  const current=await readJournal(file);
  const videoDoneItems=current.items.filter(item=>item.undo?.videoDone);
  return { restored: restored.length, restoredItems: restored, completedItems: completed, videoDoneItems, removed: removed.length, restoredExtras, failed, undoComplete: failed.length === 0, retainedEffects: [...new Set(current.items.flatMap(i => i.retainedEffects || []))] };
}
