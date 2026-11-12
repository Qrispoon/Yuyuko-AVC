import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { throwIfAborted } from './durable.mjs';

export function longPath(file) {
  const abs = path.resolve(file);
  return process.platform === 'win32' && abs.length >= 240 && !abs.startsWith('\\\\?\\') ? '\\\\?\\' + abs : abs;
}

export async function fileEvidence(file, { content = false, io = fs } = {}) {
  const st = await io.lstat(longPath(file));
  if (!st.isFile() || st.isSymbolicLink()) throw Object.assign(new Error('regular file required'), { code: 'UNSUPPORTED_SAFE_MOVE' });
  const evidence = { size: st.size, mtimeMs: st.mtimeMs, isFile: true, identity: `${st.dev}:${st.ino}:${st.birthtimeMs}` };
  if (content) evidence.sha256 = createHash('sha256').update(await io.readFile(longPath(file))).digest('hex');
  return evidence;
}

export function sameEvidence(actual, expected) {
  if (!actual || !expected) return false;
  if (expected.sha256 && actual.sha256 !== expected.sha256) return false;
  return actual.size === expected.size && (!expected.identity || actual.identity === expected.identity) && (expected.mtimeMs == null || actual.mtimeMs === expected.mtimeMs);
}

/** Resume only a previously prepared move. Two names must identify the same object. */
export async function convergeMove(from, to, { expected, onPhase = async () => {}, io = fs } = {}) {
  const read = async p => { try { return await fileEvidence(p, { io, content: !!expected?.sha256 }); } catch(e) {if(e.code==='ENOENT')return null;throw e;} };
  const source=await read(from),target=await read(to);
  if(!source && target && sameEvidence(target,expected))return onPhase('committed');
  if(source && target) {
    if(!sameEvidence(source,expected)||!sameEvidence(target,expected)||source.identity!==target.identity)throw Object.assign(new Error('move_conflict'),{code:'NEEDS_REVIEW'});
    await onPhase('source_cleanup_pending');
    if(!sameEvidence(await read(from),expected))throw Object.assign(new Error('source_changed'),{code:'NEEDS_REVIEW'});
    await io.unlink(longPath(from));
    return onPhase('committed');
  }
  return moveNoReplace(from,to,{expected,onPhase,io});
}

/**
 * Local same-volume regular files. Target publication is exclusive; cleanup assumes
 * cooperating ownership of the source path. Node cannot bind unlink to a handle
 * against a non-cooperating process replacing the source between check and unlink.
 */
export async function moveNoReplace(from, to, { expected = null, signal, onPhase = async () => {}, io = fs } = {}) {
  throwIfAborted(signal);
  const source = path.resolve(from), target = path.resolve(to);
  const proof = await fileEvidence(source, { io, content: !!expected?.sha256 });
  if (expected && !sameEvidence(proof, expected)) throw Object.assign(new Error('source_changed'), { code: 'NEEDS_REVIEW' });
  if (source === target) return proof;
  if (process.platform === 'win32' && (source.startsWith('\\\\') || target.startsWith('\\\\'))) throw Object.assign(new Error('network move unsupported'), { code: 'UNSUPPORTED_SAFE_MOVE' });
  const caseOnly = process.platform === 'win32' && source.toLowerCase() === target.toLowerCase();
  // Case-only moves need a recoverable intermediate name on Windows.
  const published = caseOnly ? `${source}.avc-case-${randomUUID()}` : target;
  await onPhase('publishing', { intermediate: caseOnly ? published : null, evidence: proof });
  throwIfAborted(signal);
  try { await io.link(longPath(source), longPath(published)); }
  catch (e) {
    if (e.code === 'EEXIST') throw Object.assign(new Error('target_occupied'), { code: 'NEEDS_REVIEW', cause: e });
    if (['EXDEV','ENOTSUP','EOPNOTSUPP','EPERM'].includes(e.code)) throw Object.assign(new Error('safe move unsupported'), { code: 'UNSUPPORTED_SAFE_MOVE', cause: e });
    throw e;
  }
  await onPhase('published_dual', { intermediate: caseOnly ? published : null });
  const now = await fileEvidence(source, { io, content: !!proof.sha256 });
  if (!sameEvidence(now, proof)) throw Object.assign(new Error('source_cleanup_pending: source changed'), { code: 'NEEDS_REVIEW', partial: { from: source, to: published } });
  await onPhase('source_cleanup_pending');
  // Once published, finish this indivisible move even if cancellation arrived.
  await io.unlink(longPath(source));
  if (caseOnly) {
    await onPhase('case_source_removed', { intermediate: published });
    await io.link(longPath(published), longPath(target));
    await onPhase('case_target_published', { intermediate: published });
    await io.unlink(longPath(published));
  }
  await onPhase('committed');
  return proof;
}
