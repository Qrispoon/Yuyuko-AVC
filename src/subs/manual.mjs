// Manual subtitle picking: list candidates from the configured sources WITHOUT downloading,
// then install one chosen candidate for a single file (verification + backup + journal + fit).
//
// Used by the GUI detail drawer (POST /api/subtitles/candidates, POST /api/subtitles/apply).
// Zero dependencies; the network transport is injected so tests never touch the network.
import fs from 'node:fs/promises';
import path from 'node:path';

import { createManko } from '../sources/manko.mjs';
import { createMankoSubSource } from './source-manko.mjs';
import { createSubtitlecatSource } from './source-subtitlecat.mjs';
import { createLocalSource } from './source-local.mjs';
import { classifyChinese, decodeToUtf8, parseSrt, verifySubtitle } from './verify.mjs';
import { installSubtitle, installSubtitleAs, subtitlePathFor, subtitlePathForLang, validateSubtitleText } from './install.mjs';
import { withMutation } from '../core/mutations.mjs';
import { throwIfAborted } from '../core/durable.mjs';
import {withHttpSignal} from '../net/http.mjs';
import { autoFitSrt } from './fit.mjs';
import { ensureJournalEntry, journalPathFor } from '../core/rename.mjs';

function manualError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

/** Normalise a candidate language to the suffix used for `<stem>.<lang>.srt`. */
export function normalizeSubtitleLang(lang) {
  const s = String(lang == null ? '' : lang).trim().toLowerCase();
  if (!s) return 'zh';
  if (s === 'zh' || s === 'zh-cn' || s === 'cn' || s === 'chi' || s === 'chs' || s === 'zh-hans') return 'zh';
  if (s === 'zh-tw' || s === 'tw' || s === 'cht' || s === 'zh-hant') return 'zh-TW';
  if (s === 'en' || s === 'eng') return 'en';
  if (s === 'ko' || s === 'kor') return 'ko';
  return 'zh';
}

/** Build the source list in the configured order (same order as the pipeline uses). */
export function createSubtitleSources({ config = {}, http } = {}) {
  if (!http || typeof http.getFollow !== 'function') throw new TypeError('createSubtitleSources: http transport is required');
  const configured = Array.isArray(config.subs?.sources) && config.subs.sources.length
    ? config.subs.sources
    : ['manko', 'subtitlecat'];
  const available = new Map([
    ['manko', createMankoSubSource(createManko(http))],
    ['subtitlecat', createSubtitlecatSource(http)],
  ]);
  const localDirs = Array.isArray(config.subs?.localDirs) ? config.subs.localDirs.filter(Boolean) : [];
  if (localDirs.length) available.set('local', createLocalSource({ dirs: localDirs, maxDepth: config.subs?.localMaxDepth ?? 2 }));
  return configured.filter((name) => available.has(name)).map((name) => available.get(name));
}

/** Map a raw candidate from any source into the stable manual-pick shape. */
export function normalizeCandidate(candidate, sourceName) {
  if (!candidate || typeof candidate !== 'object') return null;
  const localPath = typeof candidate.localPath === 'string' && candidate.localPath ? candidate.localPath : null;
  const name = typeof candidate.name === 'string' && candidate.name ? candidate.name : (localPath ? path.basename(localPath) : null);
  const url = typeof candidate.url === 'string' && candidate.url ? candidate.url : null;
  if (!name && !localPath && !url) return null;
  return {
    source: sourceName || candidate.source || 'local',
    lang: candidate.lang || 'zh',
    name,
    url,
    localPath,
    sizeHint: Number.isFinite(candidate.sizeHint) ? candidate.sizeHint : null,
    ...(candidate.source==='subtitlecat'||sourceName==='subtitlecat'?{matcherVersion:candidate.matcherVersion,srtName:candidate.srtName||null}:{}),
  };
}

/**
 * Catalog API used by the GUI: list candidates (cheap) and install one (download + verify + write).
 * @param {{config?: object, http: object}} options
 */
export function createSubtitleCatalog({ config = {}, http } = {}) {
  const sources = createSubtitleSources({ config, http });
  const perSource = Math.max(1, Number(config.subs?.maxCandidatesPerSource ?? 4));

  function sourceByName(name) {
    return sources.find((s) => s.name === name) || null;
  }

  async function download(candidate) {
    const source = sourceByName(candidate?.source);
    if (source && typeof source.download === 'function') {
      const res = await source.download(candidate);
      const buffer = Buffer.isBuffer(res) ? res : (res && Buffer.isBuffer(res.buffer) ? res.buffer : null);
      if (!buffer) throw manualError('SUBTITLE_SOURCE_BAD_RESPONSE', `source ${candidate.source} returned no buffer`);
      return buffer;
    }
    if (candidate?.localPath) return fs.readFile(candidate.localPath);
    throw manualError('SUBTITLE_SOURCE_UNAVAILABLE', `unknown subtitle source: ${candidate?.source}`);
  }

  return {
    sources,

    async analyze({candidate,durationSec=null,fit={},startSec=0,windowSec=60}={}) {
      const buffer=await download(candidate);
      if(buffer.length>8*1024*1024) throw manualError('SUBTITLE_TOO_LARGE','subtitle exceeds 8 MiB');
      const {text,encoding}=decodeToUtf8(buffer), parsed=parseSrt(text);
      if(!parsed.count || parsed.problems.includes('reversed_timing')) throw manualError('SUBTITLE_REJECTED','invalid SRT');
      const adjusted=durationSec>0 && fit.mode!=='none'?autoFitSrt(text,{videoDurationSec:durationSec,mode:fit.mode||'auto',maxShiftSec:fit.maxShiftSec??90}):{text,applied:'none'};
      const check=verifySubtitle({buffer,lang:normalizeSubtitleLang(candidate.lang),expectedDurationMin:durationSec>0?durationSec/60:null});
      const adjustedParsed=parseSrt(adjusted.text||text);
      validateSubtitleText(adjusted.text||text);
      const window=list=>list.filter(c=>c.end>=startSec && c.start<startSec+windowSec).slice(0,100);
      return {source:candidate.source,lang:candidate.lang,encoding,bytes:buffer.length,cues:parsed.count,firstSec:parsed.cues[0]?.start??null,lastSec:parsed.lastEndSec,coverage:durationSec>0?Math.min(1,parsed.lastEndSec/durationSec):null,warnings:check.warnings,problems:parsed.problems,verdict:check.verdict,fit:{applied:adjusted.applied,factor:adjusted.factor,shiftSec:adjusted.shiftSec},original:window(parsed.cues),adjusted:window(adjustedParsed.cues),base64:Buffer.from(adjusted.text||text).toString('base64'),check,explanation:durationSec>0?'structure_language_duration':'structure_language_only'};
    },

    /** @returns {Promise<Array<{source,lang,name,url,localPath,sizeHint}>>} */
    async list(code, { limit = 12 } = {}) {
      if (!code || typeof code !== 'string') throw manualError('CODE_REQUIRED', 'list(code): non-empty code required');
      const out = [];
      const seen = new Set();
      const maxTotal = Math.max(1, Math.min(50, Number(limit) || 12));
      for (const source of sources) {
        let list = [];
        try {
          if (typeof source.listCandidates === 'function') list = await source.listCandidates(code, { limit: perSource });
          else {
            const one = await source.find(code);
            list = one ? [one] : [];
          }
        } catch {
          continue; // a failing source must not hide the others
        }
        for (const raw of Array.isArray(list) ? list.slice(0, perSource) : []) {
          const cand = normalizeCandidate(raw, source.name);
          if (!cand) continue;
          const key = `${cand.source}|${cand.name || ''}|${cand.url || cand.localPath || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(cand);
          if (out.length >= maxTotal) return out;
        }
      }
      return out;
    },

    /**
     * Install a chosen candidate beside one video file.
     * @param {{
     *   file: string, candidate: object, durationSec?: number|null,
     *   journal?: {file: string, toPath: string}|null,
     *   fit?: {mode?: string, toleranceSec?: number, maxShiftSec?: number, maxDurationDeltaMin?: number}
     * }} params
     */
    async installChosen({ file, candidate, durationSec = null, journal = null, fit = {}, signal } = {}) {
      return withHttpSignal(signal,()=>withMutation(config.paths?.dataDir||'data', async()=>{
      throwIfAborted(signal);
      if (!file || typeof file !== 'string') throw manualError('FILE_REQUIRED', 'installChosen: file is required');
      if (!candidate || typeof candidate !== 'object' || !candidate.source) {
        throw manualError('CANDIDATE_REQUIRED', 'installChosen: candidate is required');
      }
      if(candidate.source==='subtitlecat'&&candidate.matcherVersion!==2)throw manualError('SUBTITLE_CANDIDATE_REFRESH_REQUIRED','list subtitle candidates again');
      let buffer;
      try {
        buffer = await download(candidate);
      } catch (e) {
        if (e.code === 'SUBTITLE_SOURCE_UNAVAILABLE') throw e;
        throw manualError('SUBTITLE_REJECTED', e.message, {
          reason: e.code === 'LOCAL_SUB_EMPTY' ? 'empty' : 'download_failed',
          cause: e.code,
        });
      }
      if (!buffer.length) throw manualError('SUBTITLE_REJECTED', 'empty subtitle', { reason: 'empty' });
      if (buffer.length>8*1024*1024) throw manualError('SUBTITLE_TOO_LARGE','subtitle exceeds 8 MiB');

      const { text } = decodeToUtf8(buffer);
      const parsed = parseSrt(text);
      if (!parsed.count) throw manualError('SUBTITLE_REJECTED', 'not a valid SRT', { reason: 'not_srt' });

      const lang = normalizeSubtitleLang(candidate.lang);
      let out = text;
      let fitApplied = { applied: 'none' };
      const mode = String(fit.mode || 'none');
      if (Number.isFinite(durationSec) && durationSec > 0 && mode !== 'none') {
        try {
          fitApplied = autoFitSrt(text, {
            videoDurationSec: durationSec,
            mode,
            toleranceSec: Number(fit.toleranceSec ?? 2),
            maxShiftSec: Number(fit.maxShiftSec ?? 90),
          });
          if (fitApplied.applied !== 'none') out = fitApplied.text;
        } catch(e) { if(e.code==='INVALID_SUBTITLE_TIMING')throw e; throw manualError('SUBTITLE_FIT_FAILED',e.message); }
      }

      validateSubtitleText(out);
      throwIfAborted(signal);

      if(!journal) {
        const entry=journalPathFor(config.paths?.dataDir||'data');
        await ensureJournalEntry(entry,file);journal={file:entry,toPath:file};
      }
      const target = lang === 'zh' ? subtitlePathFor(file) : subtitlePathForLang(file, lang);
      const written = lang === 'zh'
        ? await installSubtitle(file, out, {journal:journal.file,signal})
        : await installSubtitleAs(file, out, lang, {journal:journal.file,signal});
      const backup=written.backup;

      const warnings = [];
      let verdict = classifyChinese(text).verdict;
      if (lang === 'zh') {
        try {
          const check = verifySubtitle({
            buffer: Buffer.from(out, 'utf8'),
            expectedDurationMin: Number.isFinite(durationSec) && durationSec > 0 ? durationSec / 60 : null,
            lang: 'zh',
            maxDurationDeltaMin: Number(fit.maxDurationDeltaMin ?? 5),
          });
          verdict = check.verdict || verdict;
          warnings.push(...(check.warnings || []));
        } catch { /* verification is advisory for manual picks */ }
      }
      if (lang !== 'zh') warnings.push(`non_zh_lang:${lang}`);

      const journalFile = journal.file;

      return {
        path: written.path,
        bytes: written.bytes,
        cues: parseSrt(out).count,
        verdict,
        lang,
        warnings: [...new Set(warnings)],
        backup: backup || null,
        journal: journalFile,
        fit: fitApplied.applied && fitApplied.applied !== 'none'
          ? { applied: fitApplied.applied, factor: fitApplied.factor ?? null, shiftSec: fitApplied.shiftSec ?? null }
          : null,
      };
      },{signal}));
    },
  };
}

export default createSubtitleCatalog;
