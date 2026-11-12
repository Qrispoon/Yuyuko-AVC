// Pipeline: scan -> code -> metadata -> plan rename -> subtitle -> verify/install.
import fs from 'node:fs/promises';
import path from 'node:path';

import { createHttp,withHttpSignal } from './net/http.mjs';
import { extractCandidates, toLookupVariants, isNormalizedName } from './core/code.mjs';
import { createJavbus } from './sources/javbus.mjs';
import { createManko } from './sources/manko.mjs';
import { createR18 } from './sources/r18.mjs';
import { createLookup } from './sources/lookup.mjs';
import { createMankoSubSource } from './subs/source-manko.mjs';
import { createSubtitlecatSource } from './subs/source-subtitlecat.mjs';
import { verifySubtitle, decodeToUtf8, parseSrt } from './subs/verify.mjs';
import { installSubtitle, installSubtitleAs, subtitlePathFor, subtitlePathForLang } from './subs/install.mjs';
import { autoFitSrt } from './subs/fit.mjs';
import { buildNewName } from './core/template.mjs';
import { openState } from './core/state.mjs';
import { applyRenames, planRenames, annotateJournal, journalPathFor, ensureJournalEntry } from './core/rename.mjs';

import { workflowOptions, effectiveMetadata, diskAssets, validatePlan } from './core/workflow.mjs';
import { withMutation } from './core/mutations.mjs';
import { throwIfAborted } from './core/durable.mjs';
import { writeJournalSidecar } from './core/journal.mjs';
import {prepareEmbed,reconcileEmbeds} from './core/embed-reconcile.mjs';

export const CODE_CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// F1: plan signature + resumability decision (pure functions, no IO)
// ---------------------------------------------------------------------------

/** Deterministic JSON: recursively sorts object keys (arrays keep their order). */
function stableStringify(value) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number' || type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => {
      const s = stableStringify(v);
      return s === undefined ? 'null' : s;
    }).join(',')}]`;
  }
  if (type === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const s = stableStringify(value[key]);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a 32-bit over UTF-16 code units; stable across runs/platforms. */
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Signature of the config subset that changes preview/apply results (F1).
 * Same config -> same string; changing the template / subtitle sources / cover switches changes it.
 * @returns {string} `v06-xxxxxxxx`
 */
export function configSignature(config = {}) {
  const cfg = config || {};
  const subset = {
    tpl: cfg.rename?.template ?? '{code} {title} [{actress}]',
    maxLen: cfg.rename?.maxLength ?? 170,
    subs: {
      sources: cfg.subs?.sources ?? ['manko', 'subtitlecat'],
      localDirs: cfg.subs?.localDirs ?? [],
      maxCandidatesPerSource: cfg.subs?.maxCandidatesPerSource ?? 4,
      subtitlecatLimit: cfg.subs?.subtitlecatLimit ?? 4,
      maxDurationDeltaMin: cfg.subs?.maxDurationDeltaMin ?? 5,
      fit: cfg.subs?.fit ?? {},
      extraLangs: cfg.subs?.extraLangs ?? [],
    },
    covers: {
      download: cfg.covers?.download !== false,
      posterWhenSingle: cfg.covers?.posterWhenSingle !== false,
      embed: !!cfg.covers?.embed,
    },
    media: { probeDuration: cfg.media?.probeDuration ?? 'auto' },
    metadata: { r18: cfg.metadata?.r18 !== false },
  };
  return `v06-${fnv1a32(stableStringify(subset)).toString(16).padStart(8, '0')}`;
}

/**
 * F1: can this file be skipped by the resumable batch runner? Pure function (no IO).
 * @param {{prev:object|null, fileSize:number|null, apply:boolean, force:boolean,
 *          planSig:string|null, hasOverride:boolean}} input
 * @returns {boolean}
 */
export function shouldSkipFile({ prev = null, fileSize = null, apply = false, force = false, planSig = null, hasOverride = false } = {}) {
  if (hasOverride || force) return false;
  if (!prev) return false;
  const sameSize = prev.data?.size == null || prev.data.size === fileSize;
  if (!sameSize) return false;
  if (prev.status === 'no_code' || prev.status === 'out_of_scope') return true;
  const prevSig = prev.data?.planSig || null;
  const applied = prev.data?.applied === true;
  if (apply === true) return applied && prevSig === planSig;
  return prevSig === planSig;
}

/** F7: unified duration in seconds — probed value first, metadata minutes as fallback. */
export function durationSecOf(meta) {
  const sec = Number(meta?.durationSec);
  if (Number.isFinite(sec) && sec > 0) return sec;
  const min = Number(meta?.durationMin);
  return Number.isFinite(min) && min > 0 ? min * 60 : null;
}


export function createContext(config, { state, logger = () => {}, journalFile = null, overrides = null } = {}) {
  const http = createHttp(config.network);
  const javbus = createJavbus(http);
  const manko = createManko(http);
  const r18 = createR18(http);
  const lookup = createLookup({ http, config });
  const subs = [createMankoSubSource(manko), createSubtitlecatSource(http)];
  return { config, http, javbus, manko, r18, lookup, subs, state, logger, journalFile, overrides };
}

export async function listVideos(dir, config) {
  const exts = new Set((config.scan?.videoExtensions || ['.mp4', '.mkv', '.avi', '.mov', '.wmv']).map((e) => e.toLowerCase()));
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!exts.has(path.extname(e.name).toLowerCase())) continue;
    const full = path.join(dir, e.name);
    const st = await fs.stat(full).catch(() => null);
    out.push({ path: full, name: e.name, size: st?.size ?? null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 规范化用户手动输入的番号：'ipx 00984' -> 'IPX-00984'。
 *  保留前导零（SSIS-001 / MIDE-001 的 001 是官方写法的一部分），查询时再靠变体去零。 */
export function normalizeManualCode(input) {
  const s = String(input == null ? '' : input).normalize('NFKC').trim().toUpperCase();
  if (!s) return null;
  const m = /^([A-Z]{2,8})[-_ .]?(\d{1,6})$/.exec(s);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

/** 番号比较键：忽略分隔符与数字前导零（MIDE-001 与 MIDE-1 视为同一编号）。 */
export function canonCode(code) {
  const raw = String(code == null ? '' : code).toUpperCase().trim();
  const m = /^([A-Z]{2,8})[-_ .]?(\d{1,6})$/.exec(raw);
  if (!m) return raw.replace(/[^A-Z0-9]/g, '');
  return `${m[1]}-${m[2].replace(/^0+(?=\d)/, '')}`;
}

function mergeMeta(javbusMeta, mankoRec) {
  const actresses = (javbusMeta?.actress?.length ? javbusMeta.actress : (mankoRec?.actress || []).map((a) => a.jp || a.zh || a.en)).filter(Boolean);
  return {
    titleJa: javbusMeta?.titleJa || mankoRec?.titleJa || '',
    titleZh: javbusMeta?.titleZh || mankoRec?.titleZh || '',
    actress: [...new Set(actresses)],
    releaseDate: javbusMeta?.releaseDate || mankoRec?.releaseDate || '',
    durationMin: Number(javbusMeta?.durationMin || mankoRec?.durationMin) || null,
    maker: javbusMeta?.maker || mankoRec?.maker || '',
    coverUrl: javbusMeta?.coverUrl || mankoRec?.coverUrl || '',
    genres: javbusMeta?.genres || [],
    movieId: mankoRec?.movieId || null,
    source: [javbusMeta ? 'javbus' : null, mankoRec ? 'manko' : null].filter(Boolean).join('+'),
  };
}

async function resolveMeta(ctx, candidates) {
  const { javbus, manko, r18, state, logger, config } = ctx;
  for (const cand of candidates.slice(0, 3)) {
    const cached = state.getCode(cand.code);
    if (cached && cached.meta && Date.now() - (cached.updated_at || 0) < CODE_CACHE_TTL_MS) {
      logger(`  ↳ code cache hit ${cand.code}`);
      return { code: cand.code, meta: cached.meta, candidates: [cand.code] };
    }
    for (const variant of toLookupVariants(cand.code).slice(0, 5)) {
      try {
        const url = await javbus.search(variant);
        if (!url) continue;
        const meta = await javbus.detail(url);
        // 强匹配护栏：javbus 搜索是模糊的，返回的番号与请求不一致时绝不能采用
        // （否则会把 MIDE-001 错配成 MIDE-991，导致改错片名）。
        const want = canonCode(cand.code);
        const got = canonCode(meta.code || variant);
        if (want !== got) {
          logger(`  · javbus returned ${meta.code || variant}, expected ${cand.code} — skipped`);
          continue;
        }
        let mankoRec = null;
        try { mankoRec = await manko.findByCode(meta.code || variant); } catch (e) { logger(`  ! manko failed: ${e.message}`); }
        const merged = mergeMeta(meta, mankoRec);
        state.putCode(meta.code || variant, { meta: merged });
        return { code: meta.code || variant, meta: merged, candidates: [cand.code] };
      } catch (e) {
        logger(`  ! javbus ${variant} failed: ${e.code || e.message}`);
      }
    }
    // javbus could not confirm -> try r18.dev (F15), then manko alone.
    // r18's id lookup is exact-ish, but still guard with the same strong match as javbus.
    if (config.metadata?.r18 !== false && r18 && typeof r18.findByCode === 'function') {
      try {
        const rec = await r18.findByCode(cand.code);
        if (rec && canonCode(rec.code || cand.code) === canonCode(cand.code)) {
          const merged = mergeMeta(rec, null);
          merged.source = 'r18';
          state.putCode(rec.code || cand.code, { meta: merged });
          logger(`  · r18 resolved ${rec.code || cand.code}`);
          return { code: rec.code || cand.code, meta: merged, candidates: [cand.code] };
        }
        logger(`  · r18: no match for ${cand.code}`);
      } catch (e) {
        logger(`  ! r18 ${cand.code} failed: ${e.code || e.message}`);
      }
    }
    // javbus could not confirm -> try manko alone
    try {
      const mankoRec = await manko.findByCode(cand.code);
      if (mankoRec && canonCode(mankoRec.code || cand.code) === canonCode(cand.code)) {
        const merged = mergeMeta(null, mankoRec);
        state.putCode(mankoRec.code || cand.code, { meta: merged });
        return { code: mankoRec.code || cand.code, meta: merged, candidates: [cand.code] };
      }
    } catch (e) {
      logger(`  ! manko ${cand.code} failed: ${e.code || e.message}`);
    }
  }
  return null;
}

// 媒体相关模块（封面/ffmpeg）延迟加载：缺失时不影响主流程
let mediaCache;
async function loadMedia() {
  if (mediaCache !== undefined) return mediaCache;
  mediaCache = {};
  try { mediaCache.covers = await import('./media/covers.mjs'); } catch { mediaCache.covers = null; }
  try { mediaCache.ffmpeg = await import('./media/ffmpeg.mjs'); } catch { mediaCache.ffmpeg = null; }
  return mediaCache;
}

/**
 * F7: measure the real duration with ffprobe (once per file). Never throws and never
 * changes the main flow: on any failure it only downgrades `meta.durationSource`.
 * Mutates `meta` in place: `durationSec` / `durationSource` / optional `warnings`.
 */
async function probeMediaDuration(ctx, file, meta) {
  if (!meta || typeof meta !== 'object') return;
  const { config, logger } = ctx;
  const hasMetaMin = Number(meta.durationMin) > 0;
  const fallbackSource = hasMetaMin ? 'metadata' : 'unknown';
  if ((config.media?.probeDuration ?? 'auto') === 'off') {
    meta.durationSource = fallbackSource;
    return;
  }
  try {
    const media = await loadMedia();
    if (!media.ffmpeg) { meta.durationSource = fallbackSource; return; }
    const cap = await media.ffmpeg.detectFfmpeg();
    const ffprobe = cap?.ffprobe || null;
    if (!ffprobe) {
      logger('  · duration probe skipped: ffprobe not found');
      meta.durationSource = fallbackSource;
      return;
    }
    // hard guard on top of probeDurationSec's own timeoutMs
    const sec = await withTimeout(
      media.ffmpeg.probeDurationSec(file.path, { ffprobe, timeoutMs: 15000 }),
      15500,
      'ffprobe',
    );
    if (!Number.isFinite(sec) || sec <= 0) {
      meta.durationSource = fallbackSource;
      return;
    }
    meta.durationSec = sec;
    meta.durationSource = 'probe';
    if (hasMetaMin && Math.abs(meta.durationMin * 60 - sec) > 300) {
      const warnings = Array.isArray(meta.warnings) ? meta.warnings : [];
      if (!warnings.includes('duration_mismatch')) warnings.push('duration_mismatch');
      meta.warnings = warnings;
    }
  } catch (e) {
    logger(`  ! duration probe failed: ${e.code || e.message}`);
    meta.durationSource = fallbackSource;
  }
}

/** F4: back up an existing sidecar before overwriting it; failures never block the run. */
/**
 * 本地字幕源按需加载（避免没有 source-local.mjs 时拖垮主流程）。
 */
async function ensureLocalSource(ctx) {
  if (ctx.localSource !== undefined) return ctx.localSource;
  ctx.localSource = null;
  const dirs = ctx.config?.subs?.localDirs || [];
  if (!dirs.length) return null;
  try {
    const mod = await import('./subs/source-local.mjs');
    ctx.localSource = mod.createLocalSource({ dirs });
  } catch {
    ctx.localSource = null;
  }
  return ctx.localSource;
}

/**
 * 收集所有字幕源的候选（多候选），逐个下载+校验+打分。
 * 评分：时长贴合优先，其次简体、cue 数、源顺序。
 */
async function collectSubtitleCandidates(ctx, code, meta, durationSec) {
  const { subs, logger, config } = ctx;
  const order = config.subs?.sources || ['manko', 'subtitlecat'];
  const perSource = Math.max(1, Number(config.subs?.maxCandidatesPerSource ?? 4));
  const found = [];
  let srcIdx = 0;
  for (const name of order) {
    if (name === 'local' && !subs.some((s) => s.name === 'local')) {
      const local = await ensureLocalSource(ctx);
      if (local) subs.push(local);
    }
    const source = subs.find((s) => s.name === name);
    if (!source) { srcIdx++; continue; }
    let list = [];
    const sourceLimit = name === 'subtitlecat'
      ? Math.max(1, Number(config.subs?.subtitlecatLimit ?? perSource))
      : perSource;
    try {
      if (typeof source.listCandidates === 'function') list = await source.listCandidates(code, { limit: sourceLimit });
      else {
        const one = await source.find(code);
        list = one ? [one] : [];
      }
    } catch (e) {
      logger(`  ! ${name} list failed: ${e.code || e.message}`);
      srcIdx++;
      continue;
    }
    if (!list?.length) { logger(`  · ${name}: no zh subtitle`); srcIdx++; continue; }

    let candIdx = 0;
    for (const cand of list.slice(0, perSource)) {
      try {
        const { buffer } = await source.download(cand);
        const check = verifySubtitle({
          buffer,
          expectedDurationMin: durationSec ? durationSec / 60 : (meta?.durationMin || null),
          lang: 'zh',
          maxDurationDeltaMin: config.subs?.maxDurationDeltaMin ?? 5,
        });
        if (!check.ok) {
          logger(`  · ${name}/${cand.name || ''}: rejected (${check.reason})`);
          candIdx++;
          continue;
        }
        const deltaMin = durationSec ? Math.abs(check.lastEndSec - durationSec) / 60 : null;
        const score =
          100
          - (deltaMin == null ? 0 : deltaMin * 8)
          + (check.verdict === 'zh-CN' ? 10 : 0)
          + (check.cues >= 100 ? 3 : 0)
          - srcIdx * 2
          - candIdx * 0.5;
        found.push({ source: name, candidate: cand, buffer, check, deltaMin, score, srcIdx, candIdx });
        logger(`  · cand ${name}/${cand.name || ''}: score ${score.toFixed(1)} Δ${deltaMin == null ? '?' : deltaMin.toFixed(1)}min cues ${check.cues} ${check.verdict}`);
      } catch (e) {
        logger(`  ! ${name} download failed: ${e.code || e.message}`);
      }
      candIdx++;
    }
    srcIdx++;
  }
  return found;
}

/** 选择最贴合的字幕，并做时间轴校正。 */
async function fetchSubtitle(ctx, code, meta, durationSec) {
  const { logger, config } = ctx;
  const candidates = await collectSubtitleCandidates(ctx, code, meta, durationSec);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  logger(`  · picked ${best.source}/${best.candidate.name || ''} (score ${best.score.toFixed(1)}, Δ${best.deltaMin == null ? '?' : best.deltaMin.toFixed(1)}min, of ${candidates.length})`);

  // 时间轴校正
  let buffer = best.buffer;
  let fit = { applied: 'none' };
  try {
    const { text } = decodeToUtf8(buffer);
    fit = autoFitSrt(text, {
      videoDurationSec: durationSec,
      mode: config.subs?.fit?.mode || 'auto',
      toleranceSec: config.subs?.fit?.toleranceSec ?? 2,
      maxShiftSec: config.subs?.fit?.maxShiftSec ?? 90,
    });
    if (fit.applied !== 'none') {
      buffer = Buffer.from(fit.text, 'utf8');
      logger(`  · time fit: ${fit.applied}${fit.factor ? ' ×' + fit.factor.toFixed(4) : ''}${fit.shiftSec ? ' ' + fit.shiftSec.toFixed(1) + 's' : ''}`);
    }
  } catch (e) {
    logger(`  ! time fit skipped: ${e.message}`);
    if(e.code==='INVALID_SUBTITLE_TIMING')throw e;
  }

  return {
    source: best.source,
    candidate: best.candidate,
    url: best.candidate.url || null,
    buffer,
    check: best.check,
    bytes: buffer.length,
    fit,
    score: best.score,
    candidates: candidates.length,
  };
}

/**
 * F17: download + install the configured extra-language subtitles (apply only).
 * Only called after the main subtitle succeeded. A failure for one language only logs
 * and never changes the file's main status.
 *
 * @returns {Promise<null|{extras:Array<{lang,path,bytes,cues,warnings}>,
 *   journalExtras:Array<{lang,path}>, journalBackups:Array<{lang,path,backup}>}>}
 */
async function installExtraSubtitles(ctx, { code, effectivePath, originalPath=effectivePath, durationSec, maxDurationDeltaMin, missing = false, ensureJournal = null, signal }) {
  const { config, logger } = ctx;
  const langs = [];
  for (const raw of Array.isArray(config.subs?.extraLangs) ? config.subs.extraLangs : []) {
    if (typeof raw !== 'string') continue;
    const lang = raw.trim();
    if (lang && !langs.includes(lang)) langs.push(lang);
  }
  if (!langs.length) return null;

  const source = (ctx.subs || []).find((s) => s && s.name === 'manko' && typeof s.findLang === 'function')
    || (ctx.subs || []).find((s) => typeof s?.findLang === 'function');
  if (!source) {
    logger('  · extra subtitles skipped: no source exposes findLang()');
  }

  const extras = [];
  const journalExtras = [];
  const journalBackups = [];
  for (const lang of langs) {
    if (missing && (await diskAssets(effectivePath,durationSec)).subtitles[lang]) continue;
    try {
      const original=missing && effectivePath!==originalPath && (await diskAssets(originalPath,durationSec)).subtitles[lang];
      if(original) {
        const targetPath=subtitlePathForLang(effectivePath,lang),journal=await ensureJournal?.();
        await installSubtitleAs(effectivePath,await fs.readFile(original.path),lang,{journal,signal});
        extras.push({lang,path:targetPath,bytes:original.size,preservedSource:true});journalExtras.push({lang,path:targetPath});continue;
      }
      if(!source)continue;
      const found = await source.findLang(code, lang);
      if (!found || !found.url) {
        logger(`  · extra ${lang}: not available`);
        continue;
      }
      const { buffer } = await source.download(found);
      if (!buffer || !buffer.length) throw Object.assign(new Error(`empty ${lang} subtitle`), { code: 'EMPTY_SUBTITLE' });

      // structural check: must parse into cues and end after 0 (the pipeline installs as-is)
      const { text } = decodeToUtf8(buffer);
      const parsed = parseSrt(text);
      if (!parsed.count || !(parsed.lastEndSec > 0) || parsed.problems.includes('reversed_timing')) {
        logger(`  · extra ${lang}: rejected (invalid srt)`);
        continue;
      }
      const warnings = [];
      if (Number.isFinite(Number(durationSec)) && Number(durationSec) > 0) {
        const deltaMin = Math.abs(parsed.lastEndSec - Number(durationSec)) / 60;
        if (deltaMin > maxDurationDeltaMin) warnings.push('duration_mismatch');
      }

      const targetPath = subtitlePathForLang(effectivePath, lang);
      const journal=await ensureJournal?.();
      const written = await installSubtitleAs(effectivePath, buffer, lang,{journal,signal});
      const backup=written.backup;
      extras.push({ lang, path: written.path, bytes: written.bytes, cues: parsed.count, warnings });
      journalExtras.push({ lang, path: written.path });
      if (backup) journalBackups.push({ lang, path: written.path, backup });
      logger(`  · extra ${lang}: ${parsed.count} cues${warnings.length ? ` (${warnings.join(',')})` : ''}`);
    } catch (e) {
      throwIfAborted(signal);
      logger(`  ! extra ${lang} failed: ${e.code || e.message}`);
    }
  }
  return { extras, journalExtras, journalBackups };
}

/**
 * Process one video file (no side effects on the video unless apply=true).
 * @param {object} file `{path, name, size}`
 * @param {{apply?:boolean, downloadSubs?:boolean, overrideCode?:string|null, persist?:boolean}} [opts]
 *   `persist:false` skips every state.upsertFile write (used by `/api/preview`; reads still work).
 * @returns {object} unified result shape (see docs/CONTRACTS.md §6)
 */
export async function processFile(ctx,file,opts={}) {
  return withMutation(ctx.config.paths?.dataDir||'data',()=>withHttpSignal(opts.signal,()=>processFileOwned(ctx,file,opts)),{signal:opts.signal});
}
async function processFileOwned(ctx, file, { apply = false, downloadSubs = true, overrideCode = null, persist = true, confirmed = null, workflow = {}, signal } = {}) {
  throwIfAborted(signal);
  await reconcileEmbeds(ctx.config.paths?.dataDir||'data',ctx.state);
  const { config, state, logger } = ctx;
  const wf = workflowOptions(workflow);
  const correction = state.record?.(file.path) || {fields:{}};
  const previousRow = state.getFile(file.path);
  const previous = previousRow?.data || {};
  const assets = await diskAssets(file.path);
  const missing = wf.mode === 'missing';
  downloadSubs = downloadSubs && wf.subtitles;
  const base = path.basename(file.name, path.extname(file.name));
  const planSig = configSignature(config);
  const stage = apply ? 'apply' : 'plan';
  const saveFile = (filePath, patch) => (persist ? state.upsertFile(filePath, patch) : null);
  const result = {
    file: file.path, name: file.name, status: 'error',
    candidates: [], code: null, meta: null, newName: null, sub: null, error: null,
    rename: null, originalFile: file.path,
    actions: {metadata:wf.metadata?'blocked':'disabled',rename:'blocked',subtitles:downloadSubs?'not_found':'disabled',covers:wf.covers&&config.covers?.download!==false?'not_available':'disabled',extraSubtitles:wf.extraSubtitles&&config.subs?.extraLangs?.length?(apply?'not_available':'planned'):'disabled'},
    backups:[], locks: correction.fields,
  };

  // 手动番号：本次传入的 override，或上次运行保存过的（重跑时无需再次输入）
  const storedData = state.getFile(file.path)?.data || {};
  const manualCode = normalizeManualCode(correction.fields.code?.locked ? correction.fields.code.value : overrideCode || storedData.manualCode);
  if (manualCode) {
    saveFile(file.path, { data: { ...storedData, size: storedData.size ?? file.size, manualCode, planSig, stage } });
  }

  let candidates;
  if (manualCode) {
    const [label, num] = manualCode.split('-');
    candidates = [{
      code: manualCode, label, num, scope: 'censored', known: true,
      rule: 'manual', score: 99, manual: true,
    }];
    result.candidates = [`${manualCode}(manual)`];
    logger(`  · manual code: ${manualCode}`);
  } else {
    const extracted = extractCandidates(file.name);
    result.candidates = extracted.candidates.map((c) => `${c.code}(${c.score})`);
    if (!extracted.candidates.length) {
      result.status = 'no_code';
      saveFile(file.path, { status: 'no_code', data: { ...storedData, size: file.size, planSig, stage } });
      return result;
    }
    candidates = extracted.candidates;
  }

  // 范围外判断只针对自动识别的结果（手动补录视为有码）
  if (!manualCode) {
    const top = candidates[0];
    const scope = top.scope || 'censored';
    if (!['censored', 'unknown'].includes(scope)) {
      result.status = 'out_of_scope';
      result.code = top.code;
      result.error = `out of scope: ${top.scope}`;
      saveFile(file.path, { status: 'out_of_scope', code: top.code, data: { ...storedData, size: file.size, scope: top.scope, planSig, stage } });
      logger(`  · out of scope (${top.scope}) -> ${top.code}`);
      return result;
    }
  }

  const sameCode=!previousRow?.code || previousRow.code===candidates[0].code;
  const requiredMeta=['titleJa','actress','releaseDate','maker',...(wf.covers&&!assets.cover?['coverUrl']:[])];
  const metadataComplete=missing && sameCode && previous.meta && requiredMeta.every(k=>correction.fields[k]?.locked || (Array.isArray(previous.meta[k])?previous.meta[k].length:previous.meta[k]));
  const resolved = confirmed?.meta ? { code:confirmed.code, meta:structuredClone(confirmed.meta) } : !wf.metadata || metadataComplete ? {code:candidates[0].code, meta:sameCode?previous.meta || {}:{}} : await resolveMeta(ctx, candidates);
  if (!resolved) {
    result.status = 'unresolved';
    result.code = candidates[0].code;
    saveFile(file.path, { status: 'unresolved', code: candidates[0].code, data: { ...storedData, size: file.size, ...(manualCode ? { manualCode } : {}), planSig, stage } });
    return result;
  }

  result.code = resolved.code;
  result.sourceMeta = confirmed?.sourceMeta || (metadataComplete?previous.sourceMeta:null) || structuredClone(resolved.meta);
  const oldMeta = previousRow?.code && previousRow.code !== resolved.code ? {} : previous.meta;
  resolved.meta = effectiveMetadata(resolved.meta, missing || !wf.metadata ? oldMeta : null, correction.fields, missing || !wf.metadata);
  result.meta = resolved.meta;
  result.actions.metadata = !wf.metadata || metadataComplete ? 'preserved' : missing ? 'fill_missing' : 'resolved';
  // F7: 实测片长（失败只降级；每个文件只探测一次）
  if(!confirmed) await probeMediaDuration(ctx, file, result.meta);
  const durationSec = durationSecOf(result.meta);
  const expectedDurationMin = durationSec ? durationSec / 60 : (result.meta?.durationMin || null);
  result.newName = buildNewName({
    ...resolved.meta,
    code: resolved.code,
    ext: path.extname(file.name),
    template: config.rename?.template || '{code} {title} [{actress}]',
    maxLength: config.rename?.maxLength ?? 170,
  });

  if (!wf.rename) result.newName = file.name;
  if (confirmed?.newName) result.newName=confirmed.newName;
  const alreadyNamed = isNormalizedName(base) && base.startsWith(resolved.code);

  // Rename FIRST so the subtitle lands next to the final file name.
  // F1/F2: the plan is computed for every file (metadata IO only) so previews can show the
  // exact action; apply still goes through applyRenames (journal + undo unchanged).
  let renamePlan = [];
  let planEntry = null;
  if (result.newName) {
    try {
      renamePlan = confirmed?.rename ? [confirmed.rename] : await planRenames([{ file: file.path, newName: result.newName }]);
      planEntry = renamePlan[0] || null;
    } catch (e) {
      logger(`  ! rename plan failed: ${e.code || e.message}`);
    }
  }
  if (planEntry) {
    result.rename = {
      from: planEntry.from,
      to: planEntry.to,
      action: planEntry.action,
      ...(planEntry.reason ? { reason: planEntry.reason } : {}),
    };
  }

  let effectivePath = file.path;
  if (planEntry && planEntry.action === 'rename') {
    if (apply) {
      const applied = await applyRenames(renamePlan, {
        dataDir: config.paths?.dataDir || 'data',
        journalFile: ctx.journalFile || null,
        signal,
      });
      const done = applied.executed.find((e) => e.from === file.path);
      if (done) {
        result.renamedTo = done.to;
        result.journal = applied.journal;
        effectivePath = done.to;
        state.moveRecord?.(file.path,done.to);
      }
    } else {
      effectivePath = planEntry.to;
    }
  } else if (!apply && !alreadyNamed && planEntry && planEntry.action !== 'skip_same') {
    // dry-run keeps the historical preview semantics: show the nominal target even when the
    // plan would skip it (conflict/duplicate), so the UI can explain why nothing will happen.
    effectivePath = planEntry.to;
  }
  result.file = effectivePath;
  result.actions.rename = result.renamedTo ? 'completed' : apply ? 'preserved' : result.rename?.action || 'blocked';
  const ensureJournal = async () => {
    throwIfAborted(signal);
    if (!result.journal) result.journal = await ensureJournalEntry(ctx.journalFile || journalPathFor(config.paths?.dataDir || 'data'), effectivePath);
    return result.journal;
  };
  const targetSrt = subtitlePathFor(effectivePath);

  try {
  // reuse an existing sibling .srt instead of downloading again
  if (downloadSubs && !confirmed?._selectedSubtitle) {
    const existingSrt = missing && assets.subtitles.zh ? assets.subtitles.zh.path : targetSrt;
    const hasSibling = await fs.stat(existingSrt).then(() => true).catch(() => false);
    if (hasSibling) {
      const buf = await fs.readFile(existingSrt);
      const check = verifySubtitle({
        buffer: buf,
        expectedDurationMin,
        lang: 'zh',
        maxDurationDeltaMin: config.subs?.maxDurationDeltaMin ?? 5,
      });
      if (check.ok) {
        result.sub = {
          source: 'existing', lang: 'zh', bytes: buf.length, cues: check.cues,
          verdict: check.verdict, warnings: check.warnings || [], path: existingSrt,
        };
        result.actions.subtitles = 'preserved';
        if(missing && existingSrt!==targetSrt) {
          result.sub.targetPath=targetSrt;
          if(apply) {
            await ensureJournal();await installSubtitle(effectivePath,buf,{journal:result.journal,signal});
            result.sub.path=targetSrt;result.sub.writtenBytes=buf.length;result.sub.preservedSource=true;
            result.actions.subtitles='completed';await annotateJournal(result.journal,effectivePath,{srt:targetSrt});
          } else result.actions.subtitles='planned';
        }
        logger('  · subtitle already present, reused');
      }
    }
  }

  if (downloadSubs && !result.sub) {
    const sub = confirmed ? (confirmed._subtitle ? { ...confirmed._subtitle, buffer:Buffer.from(confirmed._subtitle.base64,'base64') } : null) : await fetchSubtitle(ctx, resolved.code, resolved.meta, durationSec);
    if (sub) {
      if (!apply) result._subtitle = {...sub, buffer:undefined, base64:sub.buffer.toString('base64')};
      result.actions.subtitles = 'planned';
      const verify = sub.check;
      result.sub = {
        source: sub.source, lang: 'zh', bytes: sub.bytes,
        cues: verify.cues, verdict: verify.verdict, warnings: verify.warnings || [],
        targetPath: targetSrt,
        candidates: sub.candidates,
        name: sub.candidate?.name || null,
        fit: sub.fit?.applied && sub.fit.applied !== 'none' ? { applied: sub.fit.applied, factor: sub.fit.factor, shiftSec: sub.fit.shiftSec } : null,
      };
      if (apply) {
        // F4: keep the subtitle that is about to be overwritten (it can be restored by undo)
        await ensureJournal();
        const written = await installSubtitle(effectivePath, sub.buffer,{journal:result.journal,signal});
        const srtBackup=written.backup;
        if(srtBackup)result.backups.push(srtBackup);
        result.sub.path = written.path;
        result.sub.writtenBytes = written.bytes;
        result.actions.subtitles = 'completed';
        if (result.journal) {
          await annotateJournal(result.journal, effectivePath, {
            srt: written.path,
            ...(srtBackup ? { srtBackup } : {}),
          });
        } else if (srtBackup) {
          logger(`  · previous subtitle kept as ${path.basename(srtBackup)} (no journal entry to attach)`);
        }
      }
      state.putSubtitle({
        code: resolved.code, lang: 'zh', source: sub.source, url: sub.url,
        bytes: result.sub.bytes, cues: verify.cues, verdict: verify.verdict,
        local_path: targetSrt,
      });
    } else {
      result.status = 'no_subtitle';
    }
  }

  // ---------- F17: extra-language subtitles (apply only, after the main subtitle) ----------
  if (apply && wf.extraSubtitles) {
    const extra = await installExtraSubtitles(ctx, {
      code: resolved.code,
      effectivePath,
      originalPath:file.path,
      durationSec,
      missing, ensureJournal, signal, maxDurationDeltaMin: Number(config.subs?.maxDurationDeltaMin ?? 5),
    });
    if (extra && extra.extras.length) {
      result.extraSubs = extra.extras;
      result.actions.extraSubtitles = 'completed';
      result.backups.push(...extra.journalBackups.map(b=>b.backup));
      if (result.journal) {
        await annotateJournal(result.journal, effectivePath, {
          srtExtra: extra.journalExtras,
          ...(extra.journalBackups.length ? { srtExtraBackup: extra.journalBackups } : {}),
        });
      } else if (extra.journalBackups.length) {
        logger('  · previous extra subtitles backed up but no journal entry to attach');
      }
    }
  }

  // ---------- 封面 ----------
  const coverUrl = resolved.meta?.coverUrl || null;
  if (missing && assets.cover) {
    result.cover = {path:assets.cover.path, preserved:true}; result.actions.covers='preserved';
    if(wf.covers && effectivePath!==file.path) {
      const target=effectivePath.slice(0,-path.extname(effectivePath).length)+path.extname(assets.cover.path);
      if(apply) {
        await ensureJournal();await writeJournalSidecar(result.journal,effectivePath,target,await fs.readFile(assets.cover.path),{kind:'cover',signal});
        result.cover={path:target,bytes:assets.cover.size,preservedSource:true};result.actions.covers='completed';
        await annotateJournal(result.journal,effectivePath,{cover:target});
      } else {result.coverPlanned={localPath:assets.cover.path,targetPath:target};result.actions.covers='planned';}
    }
  }
  if (coverUrl && wf.covers && !(missing && assets.cover)) {
    const existingPoster=missing && (await diskAssets(path.join(path.dirname(effectivePath),'poster.mp4'))).cover;
    const alsoPoster=confirmed?.coverPlanned ? confirmed.coverPlanned.alsoPoster===true : config.covers?.posterWhenSingle!==false && !existingPoster && (await listVideos(path.dirname(effectivePath),config)).length<=1;
    if (!apply) {
      result.coverPlanned = config.covers?.download!==false ? { url: coverUrl, alsoPoster, targetPath: path.join(path.dirname(effectivePath), path.basename(effectivePath, path.extname(effectivePath)) + '.jpg') } : null;
      if(result.coverPlanned) result.actions.covers = 'planned';
    } else if (config.covers?.download !== false) {
      try {
        const media = await loadMedia();
        if (!media.covers) throw Object.assign(new Error('covers module missing'), { code: 'COVERS_MODULE_MISSING' });
        const { buffer, ext } = await media.covers.downloadCover(ctx.http, coverUrl);
        const dirVideos = (await listVideos(path.dirname(effectivePath), config)).length;
        // F4: back up the sidecars we are about to replace (the real extension is known now)
        const coverTarget = media.covers.coverSidecarPath(effectivePath, { ext });
        const posterTarget = alsoPoster ? path.join(path.dirname(effectivePath), `poster.${ext}`) : null;
        await ensureJournal();
        const written = await media.covers.writeCover(effectivePath, buffer, { alsoPoster,journal:result.journal,signal });
        const coverBackup=written.backup,posterBackup=written.posterBackup;
        result.backups.push(...[coverBackup,posterBackup].filter(Boolean));
        result.actions.covers = 'completed';
        result.cover = { path: written.path, posterPath: written.posterPath || null, bytes: written.bytes, ext };
        if (result.journal) {
          await annotateJournal(result.journal, effectivePath, {
            cover: written.path,
            poster: written.posterPath || null,
            ...(coverBackup ? { coverBackup } : {}),
            ...(posterBackup ? { posterBackup } : {}),
          });
        }
        logger(`  · cover: ${path.basename(written.path)}${written.posterPath ? ` + ${path.basename(written.posterPath)}` : ''}`);

        if (!missing && config.covers?.embed && media.ffmpeg) {
          const cap = await media.ffmpeg.detectFfmpeg();
          if (cap) {
            try {
              throwIfAborted(signal);
              const embedding=await prepareEmbed({dataDir:config.paths?.dataDir||'data',journal:result.journal,media:effectivePath,record:state.record(effectivePath)});
              const emb = await media.ffmpeg.embedCover(effectivePath, written.path, { ffmpeg: cap.ffmpeg,ffprobe:cap.ffprobe,signal,beforePublish:embedding.beforePublish });
              await reconcileEmbeds(config.paths?.dataDir||'data',state);
              result.cover.embedded = true;
              result.cover.method = emb.method;
              logger(`  · cover embedded (${emb.method})`);
            } catch (e) {
              if(e.code==='EMBED_RECONCILE_PENDING'||e.published) {result.status='error';result.error='EMBED_RECONCILE_PENDING';}
              result.cover.embedError = e.code || e.message;
              logger(`  ! cover embed failed: ${e.code || e.message}`);
            }
          } else {
            result.cover.embedSkipped = 'ffmpeg_not_found';
            logger('  · cover embed skipped: ffmpeg not installed');
          }
        }
      } catch (e) {
        result.cover = { error: e.code || e.message };
        result.actions.covers = 'failed';
        logger(`  ! cover failed: ${e.code || e.message}`);
      }
    }
  }

  } catch(e) {
    result.status='error';result.error=e.code||e.message;
    if(result.actions.subtitles==='planned')result.actions.subtitles='failed';
    logger(`  ! sidecar operation failed: ${result.error}`);
  }
  if (!result.error && result.status !== 'no_subtitle') result.status = 'ok';

  saveFile(file.path, {
    status: result.status,
    code: result.code,
    newName: result.newName,
    error:result.error,
    subPath: result.sub?.path || result.sub?.targetPath || null,
    data: { size: file.size, meta: result.meta, sourceMeta: result.sourceMeta, sub: result.sub, cover: result.cover || null, coverPlanned: result.coverPlanned || null, renamedTo: result.renamedTo || null, applied: apply, rename: result.rename, ...(manualCode ? { manualCode } : {}), planSig, stage },
  });
  // 重命名后文件路径变了：给新路径也落一条记录，避免下次扫描（新文件名）丢失元数据/封面/字幕状态
  if (result.renamedTo && apply) {
    saveFile(result.renamedTo, {
      status: result.status,
      code: result.code,
      newName: result.newName,
      error:result.error,
      subPath: result.sub?.path || result.sub?.targetPath || null,
      data: { size: file.size, meta: result.meta, sourceMeta: result.sourceMeta, sub: result.sub, cover: result.cover || null, renamedTo: null, applied: true, rename: result.rename, fromPath: file.path, ...(manualCode ? { manualCode } : {}), planSig, stage: 'apply' },
    });
  }
  return result;
}

/** Fast, network-free scan used by the CLI and the GUI backend. */
export async function scanDirectory(dir, config) {
  const files = await listVideos(dir, config);
  const items = files.map((f) => {
    const ex = extractCandidates(f.name);
    const top = ex.candidates[0] || null;
    return {
      path: f.path,
      name: f.name,
      size: f.size,
      code: top?.code || null,
      scope: top?.scope || null,
      score: top?.score ?? null,
      normalized: isNormalizedName(path.basename(f.name, path.extname(f.name))),
      candidates: ex.candidates.map((c) => ({ code: c.code, score: c.score, scope: c.scope || 'censored' })),
      notes: ex.notes || [],
      duplicates: [],
    };
  });
  // F3: same-directory duplicate code detection (metadata only, contents are never read)
  const byCode = new Map();
  for (const it of items) {
    if (!it.code) continue;
    const key = canonCode(it.code);
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(it);
  }
  for (const it of items) {
    if (!it.code) continue;
    const group = byCode.get(canonCode(it.code)) || [];
    it.duplicates = group.filter((other) => other !== it).map((other) => other.path);
  }
  return items;
}

export async function withDeadline(work, ms, label, parentSignal) {
  const controller=new AbortController(),signal=parentSignal?AbortSignal.any([parentSignal,controller.signal]):controller.signal;
  const timer=ms>0?setTimeout(()=>controller.abort(Object.assign(new Error(`FILE_TIMEOUT: ${label}`),{code:'FILE_TIMEOUT'})),ms):null;
  try {const value=await work(signal);throwIfAborted(signal);return value;}finally{if(timer)clearTimeout(timer);}
}

/**
 * Batch runner with hard stability guarantees:
 *  - one file can never kill the run (timeout + try/catch per file)
 *  - circuit breaker stops the run after N consecutive failures
 *  - resumable (state.db), cancellable (AbortSignal), observable (onEvent)
 */
export async function runDirectory(options) {
  return withMutation(options.config.paths?.dataDir||'data',()=>runDirectoryOwned(options),{signal:options.signal});
}
async function runDirectoryOwned({
  dir,
  config,
  apply = false,
  limit = 0,
  force = false,
  downloadSubs = true,
  logger = () => {},
  onEvent = () => {},
  fileTimeoutMs = 180000,
  maxConsecutiveFailures = 5,
  signal = null,
  concurrency = 1,
  overrides = null,
  only = null,
  workflow = {},
  operationPlan = null,
}) {
  const dataDir = config.paths?.dataDir || 'data';
  const state = openState(path.join(dataDir, 'state.db'));
  const journalFile = journalPathFor(dataDir);
  const ctx = createContext(config, { state, logger, journalFile, overrides });
  const planSig = configSignature(config);
  const startedAt = Date.now();
  let files = [];
  try {
    await reconcileEmbeds(dataDir,state);
    files = await listVideos(dir, config);
    if (operationPlan) files = files.filter(f=>operationPlan.entries.some(e=>e.file===f.path));
    const found = files.length;
    // 只处理用户勾选的文件（overrides 里的手动番号文件始终保留）
    if (Array.isArray(only)) {
      const keep = new Set(only.map((x) => path.resolve(x)));
      files = files.filter((f) => keep.has(path.resolve(f.path)));
      logger(`selected ${files.length}/${found} video file(s) (explicit selection)`);
    }
    logger(`found ${files.length} video file(s) in ${dir}`);
    onEvent({ type: 'start', dir, total: files.length, found, apply });

    const results = [];
    let processed = 0;
    let consecutiveFailures = 0;
    let cancelled = false;
    let aborted = null;

    const queue = [...files];
    const takeNext = () => (limit && processed >= limit ? null : queue.shift() || null);

    async function handleFile(file) {
      if (signal?.aborted) { cancelled = true; return; }
      processed++;
      const index = processed;
      logger(`\n[${index}] ${file.name}`);
      onEvent({ type: 'file-start', index, total: files.length, file: file.path, name: file.name });
      try {
        const entry = operationPlan?.entries.find(e=>e.file===file.path);
        if(entry)await validatePlan({...operationPlan,entries:[entry]},state);
        if(entry?.result.skipOperation) {const r={...entry.result,status:'skipped',actions:{all:'preserved'},_subtitle:undefined};results.push(r);onEvent({type:'file-done',file:file.path,result:r});return;}
        const r = await withDeadline(fileSignal=>processFile(ctx, file, {
          apply,
          downloadSubs,
          overrideCode: overrides?.[file.path] || null,
          confirmed:entry?.result || null, workflow,signal:fileSignal,
        }), fileTimeoutMs, file.name,signal);
        results.push(r);
        consecutiveFailures = 0;
        const line = `  → ${r.status}${r.code ? ' ' + r.code : ''}${r.sub ? ` | sub ${r.sub.source} ${r.sub.bytes}B` : ''}`;
        logger(line);
        if (r.newName && r.newName !== file.name) logger(`  ${apply ? 'renamed' : 'plan'}: ${r.newName}`);
        onEvent({ type: 'file-done', index, file: file.path, name: file.name, status: r.status, code: r.code, newName: r.newName, sub: r.sub || null, result: r });
      } catch (e) {
        consecutiveFailures++;
        logger(`  ! error: ${e.code || e.message}`);
        const r = { file: file.path, name: file.name, status: 'error', error: e.message, code: null, newName: null, sub: null };
        results.push(r);
        state.upsertFile(file.path, { status: 'error', error: e.message, data: {...(state.getFile(file.path)?.data||{}),size:file.size,partial:e.partial||null} });
        onEvent({ type: 'file-error', index, file: file.path, name: file.name, error: e.message });
        if (consecutiveFailures >= maxConsecutiveFailures) {
          aborted = `aborted after ${consecutiveFailures} consecutive failures (last: ${e.code || e.message})`;
          logger(`\n!! ${aborted}`);
          queue.length = 0;
        }
      }
    }

    const next = async () => {
      for (;;) {
        if (signal?.aborted) { cancelled = true; return; }
        if (limit && processed >= limit) return;
        const file = queue.shift();
        if (!file) return;
        // skip already processed files (resume / idempotency) — F1: one pure predicate
        // dry-run 只写 planned 语义（data.applied=false）；apply 必须重新处理，
        // 否则「先预演、再应用」会被误判为已完成而整批跳过。
        // 用户手动补了番号的路径不跳过（否则输入了也不会处理）。
        const hasOverride = !!(overrides && Object.prototype.hasOwnProperty.call(overrides, file.path));
        const record=state.record(file.path);
        const prev = state.getFile(file.path);
        if (!operationPlan && record.identityVerified!==false && workflowOptions(workflow).mode!=='missing' && !Object.keys(record.fields).length && shouldSkipFile({ prev, fileSize: file.size, apply, force, planSig, hasOverride })) {
          logger(`- skip (done): ${file.name}`);
          onEvent({ type: 'file-skipped', file: file.path, name: file.name, status: prev.status });
          continue;
        }
        await handleFile(file);
        if (aborted) return;
      }
    };

    const workers = Math.max(1, Math.min(concurrency | 0, 4));
    await Promise.all(Array.from({ length: workers }, () => next()));

    // F1/F2: dry-run only — mark files whose planned target collides inside this batch
    // (in-memory only, nothing on disk changes; the GUI shows it as "target conflict").
    if (!apply) {
      const byTarget = new Map();
      for (const r of results) {
        const to = r?.rename?.to;
        if (!to) continue;
        const key = path.join(path.dirname(to), path.basename(to).toLowerCase());
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key).push(r);
      }
      for (const group of byTarget.values()) {
        if (group.length > 1) for (const r of group) r.rename.batchConflict = true;
      }
    }

    const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    const durationMs = Date.now() - startedAt;
    const journalExists = await fs.stat(journalFile).then(() => true).catch(() => false);
    const report = {
      dir, apply, count: results.length, summary, results,
      http: ctx.http.stats, journal: journalExists ? journalFile : null,
      durationMs, aborted, cancelled, fileTimeoutMs, startedAt,
    };
    logger(`\n== ${cancelled ? 'CANCELLED' : aborted ? 'ABORTED' : 'DONE'} == ${JSON.stringify(summary)} in ${(durationMs / 1000).toFixed(1)}s`);
    state.close();
    onEvent({ type: 'pipeline-complete', summary, cancelled, aborted, durationMs, journal: report.journal });
    return report;
  } finally {
    state.close();
  }
}

export default { createContext, listVideos, processFile, runDirectory, scanDirectory, configSignature, shouldSkipFile, durationSecOf };
