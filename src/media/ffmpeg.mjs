// ffmpeg capability layer: detect ffmpeg/ffprobe, read a video's duration, and embed a
// cover image into the container without re-encoding.
//
// Design constraints:
//   - Zero dependencies, node:child_process only. Windows-first (commands are invoked by
//     PATH name; no shell, no quoting problems: arguments are passed as an argv array).
//   - ffmpeg is NOT required on the machine. `detectFfmpeg()` returns null when absent and
//     every caller degrades gracefully with a stable error code (FFMPEG_MISSING).
//   - Detection is cached per exec function (a WeakMap key), so a directory run shells out
//     to `ffmpeg -version` at most once per process. Inject a custom exec to bypass the
//     real binaries entirely (used by the offline test suite).
//   - Command construction is a pure function (`buildEmbedArgs`) so tests can assert on it
//     without ever running ffmpeg.
//
// Stable error codes:
//   FFMPEG_MISSING         no ffmpeg on PATH (or detection failed)
//   UNSUPPORTED_CONTAINER  container cannot carry an attached cover (only mp4/m4v/mkv)
//   FFMPEG_NO_OUTPUT       ffmpeg exited 0 but produced no temporary file
//   FFMPEG_TIMEOUT         ffmpeg exceeded the caller-supplied timeoutMs
//   (plus whatever the child process reports, e.g. ENOENT)
import { execFile as spawnExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {throwIfAborted} from '../core/durable.mjs';
import {fileEvidence,sameEvidence,moveNoReplace} from '../core/file-operations.mjs';

export const DETECT_TIMEOUT_MS = 3000;
export const PROBE_TIMEOUT_MS = 15000;

const FFMPEG_CMD = 'ffmpeg';
const FFPROBE_CMD = 'ffprobe';

const MP4_EXTS = new Set(['.mp4', '.m4v']);
const MKV_EXTS = new Set(['.mkv']);
const IMAGE_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// ---------------------------------------------------------------------------
// exec plumbing
// ---------------------------------------------------------------------------

/** Build a stable error object with a `code`. */
function procError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/**
 * Default execFile: run an executable once and resolve `{ stdout, stderr }` (utf8 strings).
 * A positive `opts.timeoutMs` kills the child and rejects with code `FFMPEG_TIMEOUT`.
 */
function defaultExecFile(cmd, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let child = null;
    let cancellation=null;
    const abort=()=>{if(settled)return;cancellation=opts.signal?.reason||procError('media operation cancelled','ABORT_ERR');try{child?.kill();}catch{}};
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort',abort);
      fn(value);
    };
    try {
      child = spawnExecFile(
        cmd,
        args,
        { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if(cancellation){finish(reject,cancellation);return;}
          if (err) {
            finish(reject, Object.assign(err, { stdout, stderr, cmd }));
            return;
          }
          finish(resolve, { stdout, stderr });
        },
      );
    } catch (err) {
      finish(reject, err);
      return;
    }
    opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)abort();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        cancellation=procError(`${cmd} timed out after ${timeoutMs}ms`, 'FFMPEG_TIMEOUT', { cmd, timeoutMs });
        try { child.kill(); } catch { /* owned child already gone; callback completes */ }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

/** Normalise the varying shapes an injected exec may resolve with into stdout text. */
function stdoutOf(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Buffer.isBuffer(result)) return result.toString('utf8');
  const out = result.stdout;
  if (typeof out === 'string') return out;
  if (Buffer.isBuffer(out)) return out.toString('utf8');
  return '';
}

function parseFfmpegVersion(stdout) {
  const m = /ffmpeg version\s+(\S+)/i.exec(String(stdout || ''));
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

// Cache keyed by the exec function itself: the default exec keeps one entry for the whole
// process, while every injected mock gets its own slot (so mocks never see stale results).
let detectCache = new WeakMap();

/** Drop the detection cache (tests / a user telling the app "ffmpeg was just installed"). */
export function resetDetectCache() {
  detectCache = new WeakMap();
}

/**
 * Detect ffmpeg (and optionally ffprobe) on PATH.
 *
 * @param {{ execFile?: Function, timeoutMs?: number }} [opts]
 *   `execFile(cmd, args, {timeoutMs}) -> Promise<{stdout,stderr}|string>`; defaults to the
 *   real child-process runner. `timeoutMs` applies to each probe (default 3000).
 * @returns {Promise<null | {ffmpeg: string, ffprobe: string|null, version: string}>}
 *   null when ffmpeg is not runnable. Cached per exec function.
 */
export async function detectFfmpeg(opts = {}) {
  const execFile = opts.execFile || defaultExecFile;
  if (typeof execFile !== 'function') throw new TypeError('detectFfmpeg: execFile must be a function');
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DETECT_TIMEOUT_MS;

  if (detectCache.has(execFile)) return detectCache.get(execFile);

  let version = '';
  try {
    version = parseFfmpegVersion(stdoutOf(await execFile(FFMPEG_CMD, ['-version'], { timeoutMs })));
  } catch {
    detectCache.set(execFile, null);
    return null;
  }

  let ffprobe = null;
  try {
    await execFile(FFPROBE_CMD, ['-version'], { timeoutMs });
    ffprobe = FFPROBE_CMD;
  } catch {
    ffprobe = null;
  }

  const result = { ffmpeg: FFMPEG_CMD, ffprobe, version: version || 'unknown' };
  detectCache.set(execFile, result);
  return result;
}

// ---------------------------------------------------------------------------
// duration probing
// ---------------------------------------------------------------------------

/**
 * Read a video's duration in seconds via ffprobe. Never throws: any failure (no ffprobe,
 * timeout, unreadable/odd container, non-numeric duration) resolves to null.
 *
 * @param {string} videoPath absolute path to the video
 * @param {{ ffprobe?: string, execFile?: Function, timeoutMs?: number }} [opts]
 * @returns {Promise<number|null>}
 */
export async function probeDurationSec(videoPath, opts = {}) {
  if (!videoPath || typeof videoPath !== 'string') return null;
  const execFile = opts.execFile || defaultExecFile;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : PROBE_TIMEOUT_MS;
  try {
    let bin = opts.ffprobe || null;
    if (!bin) {
      const det = await detectFfmpeg(opts.execFile ? { execFile } : {});
      bin = det?.ffprobe || null;
    }
    if (!bin) return null;
    const stdout = stdoutOf(
      await execFile(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', videoPath], { timeoutMs }),
    );
    const data = JSON.parse(stdout);
    const sec = Number(data?.format?.duration);
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// cover embedding
// ---------------------------------------------------------------------------

/**
 * Which embedding strategy a container extension supports.
 * @returns {'mp4-attached-pic'|'mkv-attachment'|null}
 */
export function coverKindFor(videoPath) {
  const ext = path.extname(String(videoPath || '')).toLowerCase();
  if (MP4_EXTS.has(ext)) return 'mp4-attached-pic';
  if (MKV_EXTS.has(ext)) return 'mkv-attachment';
  return null;
}

/** Legacy path helper kept for callers; embedCover uses a unique private .avc-cover-* directory in the video's parent. */
export function tmpCoverPath(videoPath) {
  const ext = path.extname(String(videoPath || '')).toLowerCase();
  return `${videoPath}.tmp-cover${ext}`;
}

/**
 * Pure command builder for cover embedding (no I/O, no detection).
 *
 * mp4/m4v: `ffmpeg -y -i <video> -i <cover> -map 0 -map 1 -c copy -disposition:v:1 attached_pic
 *           -metadata:s:v:1 title=Cover <tmp>`
 * mkv:     `ffmpeg -y -i <video> -attach <cover> -metadata:s:t mimetype=<mime>
 *           -metadata:s:t filename=cover.<ext> -c copy <tmp>`
 *
 * @param {'mp4-attached-pic'|'mkv-attachment'} kind
 * @returns {string[]} argument vector (executable name excluded)
 * @throws {Error} code UNSUPPORTED_CONTAINER for any other kind
 */
export function buildEmbedArgs(kind, videoPath, imagePath, tmpPath) {
  if (kind !== 'mp4-attached-pic' && kind !== 'mkv-attachment') {
    throw procError(`UNSUPPORTED_CONTAINER ${String(kind)}`, 'UNSUPPORTED_CONTAINER', { kind });
  }
  const video = String(videoPath);
  const image = String(imagePath);
  const tmp = String(tmpPath);
  if (kind === 'mp4-attached-pic') {
    return [
      '-y',
      '-i', video,
      '-i', image,
      '-map', '0',
      '-map', '1',
      '-c', 'copy',
      '-disposition:v:1', 'attached_pic',
      '-metadata:s:v:1', 'title=Cover',
      tmp,
    ];
  }
  const imgExt = (path.extname(image).toLowerCase() || '.jpg').replace(/^\./, '');
  const mime = IMAGE_MIME[imgExt] || IMAGE_MIME.jpg;
  return [
    '-y',
    '-i', video,
    '-attach', image,
    '-metadata:s:t', `mimetype=${mime}`,
    '-metadata:s:t', `filename=cover.${imgExt}`,
    '-c', 'copy',
    tmp,
  ];
}

/** Replace only the explicitly authorized current media from a validated output on the same volume. No EXDEV fallback. */
async function replaceFile(from, to) {
  await fs.rename(from, to);
}

/**
 * Embed `imagePath` into the explicitly authorized current media file.
 *
 * ffmpeg writes a unique private .avc-cover-* directory in the video's parent.
 * After output/track validation and identity checks, replace the current media;
 * a distinct outPath uses exclusive no-replace publication. No original media backup.
 *
 * @param {string} videoPath  source video (.mp4/.m4v/.mkv)
 * @param {string} imagePath  cover image (jpg/png/webp)
 * @param {{ outPath?: string, ffmpeg?: string|null, execFile?: Function, timeoutMs?: number }} [opts]
 *   `outPath` defaults to `videoPath`. `ffmpeg` defaults to auto-detection; pass a custom
 *   `execFile` to avoid the real binary (tests). `timeoutMs` 0 = no timeout.
 * @returns {Promise<{ok: true, method: 'mp4-attached-pic'|'mkv-attachment', elapsedMs: number}>}
 * @throws code FFMPEG_MISSING | UNSUPPORTED_CONTAINER | FFMPEG_NO_OUTPUT | FFMPEG_TIMEOUT
 */
export async function embedCover(videoPath, imagePath, opts = {}) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  if (!imagePath || typeof imagePath !== 'string') throw new TypeError('imagePath must be a non-empty string');

  const target = opts.outPath || videoPath;
  const kind = coverKindFor(videoPath);
  if (!kind) {
    const ext = path.extname(videoPath) || '(none)';
    throw procError(`UNSUPPORTED_CONTAINER ${ext}`, 'UNSUPPORTED_CONTAINER', { ext });
  }

  const execFile = opts.execFile || defaultExecFile;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;

  let ffmpeg = opts.ffmpeg;
  if (!ffmpeg) {
    const det = await detectFfmpeg(opts.execFile ? { execFile } : {});
    ffmpeg = det?.ffmpeg || null;
  }
  if (!ffmpeg) throw procError('FFMPEG_MISSING: ffmpeg executable not found on PATH', 'FFMPEG_MISSING');

  throwIfAborted(opts.signal);
  const oldEvidence=await fileEvidence(videoPath,{content:true});
  const tempDir=await fs.mkdtemp(path.join(path.dirname(videoPath),'.avc-cover-'));
  const tmp = path.join(tempDir,path.basename(videoPath));
  const args = buildEmbedArgs(kind, videoPath, imagePath, tmp);
  const started = Date.now();
  let published=false;
  try {
    await execFile(ffmpeg, args, {timeoutMs,signal:opts.signal});
    const st = await fs.stat(tmp).catch(() => null);
    if (!st || !st.isFile() || st.size === 0) {
      throw procError('FFMPEG_NO_OUTPUT: ffmpeg exited without writing the output file', 'FFMPEG_NO_OUTPUT', { tmp, video: videoPath });
    }
    const probe=async file=>JSON.parse(stdoutOf(await execFile(opts.ffprobe||FFPROBE_CMD,['-v','error','-show_format','-show_streams','-of','json',file],{timeoutMs:PROBE_TIMEOUT_MS,signal:opts.signal})));
    const sourceInfo=await probe(videoPath),outputInfo=await probe(tmp);
    const tracks=info=>(info.streams||[]).filter(s=>['video','audio','subtitle'].includes(s.codec_type)&&!s.disposition?.attached_pic).map(s=>`${s.codec_type}:${s.codec_name}`).sort();
    const sourceDuration=Number(sourceInfo.format?.duration),outputDuration=Number(outputInfo.format?.duration);
    if(!tracks(sourceInfo).length||JSON.stringify(tracks(sourceInfo))!==JSON.stringify(tracks(outputInfo))||!Number.isFinite(outputDuration)||outputDuration<=0||Number.isFinite(sourceDuration)&&Math.abs(outputDuration-sourceDuration)>Math.max(1,sourceDuration*0.001)||!(outputInfo.streams||[]).some(s=>s.disposition?.attached_pic||s.codec_type==='attachment'))throw procError('embedded output validation failed','FFMPEG_OUTPUT_INVALID');
    const handle=await fs.open(tmp,'r+');try{await handle.sync();}finally{await handle.close();}
    const outputEvidence=await fileEvidence(tmp,{content:true});
    if(!sameEvidence(await fileEvidence(videoPath,{content:true}),oldEvidence))throw procError('media changed','NEEDS_REVIEW');
    throwIfAborted(opts.signal);
    await opts.beforePublish?.({temp:tmp,oldEvidence,outputEvidence});
    throwIfAborted(opts.signal);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if(path.resolve(target)===path.resolve(videoPath))await replaceFile(tmp,target);
    else await moveNoReplace(tmp,target,{expected:outputEvidence,signal:opts.signal});
    published=true;
    await opts.afterPublish?.({outputEvidence});
    await fs.rmdir(tempDir);
    return { ok: true, method: kind, elapsedMs: Date.now() - started,outputEvidence };
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    await fs.rmdir(tempDir).catch(()=>{});
    if(published)err.published=true;
    throw err;
  }
}

export default { detectFfmpeg, probeDurationSec, embedCover, buildEmbedArgs, coverKindFor, tmpCoverPath, resetDetectCache };
