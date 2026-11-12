// Subtitle installation: write a sibling .srt next to the video file.
// Output is always UTF-8 without BOM and uses LF line endings (players on all
// platforms accept it; mixed CRLF is normalised).
//
// F17: extra-language subtitles are written as `<stem>.<lang>.srt`
// (e.g. `IPX-920 标题.zh-TW.srt`), leaving the main `<stem>.srt` untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeToUtf8, parseSrt } from './verify.mjs';
import { writeJournalSidecar } from '../core/journal.mjs';
import { throwIfAborted } from '../core/durable.mjs';

function stemOf(videoPath) {
  const ext = path.extname(videoPath);
  return ext ? path.basename(videoPath, ext) : path.basename(videoPath);
}

/** Compute the sibling subtitle path for a video: `<same dir>/<same stem>.srt`. */
export function subtitlePathFor(videoPath) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  return path.join(path.dirname(videoPath), `${stemOf(videoPath)}.srt`);
}

/** Keep only `[A-Za-z-]` so a language tag can never escape into the path. */
export function sanitizeSubtitleLang(lang) {
  return String(lang == null ? '' : lang).trim().replace(/[^A-Za-z-]/g, '');
}

/**
 * F17: sibling path for an extra-language subtitle: `<stem>.<lang>.srt`.
 * @param {string} videoPath
 * @param {string} lang e.g. 'zh-TW' / 'en' / 'ko'
 */
export function subtitlePathForLang(videoPath, lang) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  const safe = sanitizeSubtitleLang(lang);
  if (!safe) throw Object.assign(new Error(`BAD_SUBTITLE_LANG: ${lang}`), { code: 'BAD_SUBTITLE_LANG', lang });
  return path.join(path.dirname(videoPath), `${stemOf(videoPath)}.${safe}.srt`);
}

/** Normalise subtitle text to UTF-8/no-BOM + LF, preserving a trailing newline. */
function normalizeSrtText(text) {
  let out = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // collapse 3+ blank lines down to one blank line between cues
  out = out.replace(/\n{3,}/g, '\n\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/** Decode + normalise + write one subtitle file (shared by the main and extra paths). */
export function validateSubtitleText(text) {
  const parsed = parseSrt(text);
  const timing = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})(?:\s+.*)?$/;
  const blocks=String(text).trim().split(/\n[ \t]*\n+/);
  const valid = parsed.count>0 && !parsed.problems.length && parsed.cues.every(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start&&c.text.trim()) && blocks.every(block=>{
    const lines=block.trim().split('\n'),line=lines.find(l=>l.includes('-->')),m=line?.match(timing);
    return m && [m[2],m[3],m[6],m[7]].every(n=>Number(n)<60) && lines.filter(l=>l.includes('-->')).length===1;
  });
  if(!valid)throw Object.assign(new Error('invalid final subtitle structure or timing'),{code:'INVALID_SUBTITLE_TIMING',problems:parsed.problems});
  return parsed;
}

async function writeNormalizedSubtitle(target, buffer, opts={}) {
  let text;
  if (typeof buffer === 'string') {
    text = buffer;
  } else {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!raw.length) throw Object.assign(new Error('EMPTY_SUBTITLE'), { code: 'EMPTY_SUBTITLE' });
    // decode any legacy Chinese encoding so the installed file is valid UTF-8
    text = decodeToUtf8(raw).text;
  }

  const normalized = normalizeSrtText(text);
  if (!normalized.trim()) throw Object.assign(new Error('EMPTY_SUBTITLE'), { code: 'EMPTY_SUBTITLE' });
  validateSubtitleText(normalized);
  throwIfAborted(opts.signal);

  const bytes = Buffer.from(normalized, 'utf8');
  if(opts.journal) return writeJournalSidecar(opts.journal,opts.media,target,bytes,{kind:opts.lang||'srt',signal:opts.signal});
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle=await fs.open(target,'wx');
  try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  return { path: path.resolve(target), bytes: bytes.length };
}

/**
 * Write the subtitle beside the video.
 * @param {string} videoPath path to the video file
 * @param {Buffer|Uint8Array|string} buffer raw subtitle bytes (any supported encoding)
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function installSubtitle(videoPath, buffer, opts={}) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  return writeNormalizedSubtitle(subtitlePathFor(videoPath), buffer, {...opts,media:videoPath});
}

/**
 * F17: write an extra-language subtitle as `<stem>.<lang>.srt` (same normalisation as
 * installSubtitle: UTF-8 without BOM, LF line endings).
 * @param {string} videoPath
 * @param {Buffer|Uint8Array|string} buffer
 * @param {string} lang 'zh-TW' | 'en' | 'ko'
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function installSubtitleAs(videoPath, buffer, lang, opts={}) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  return writeNormalizedSubtitle(subtitlePathForLang(videoPath, lang), buffer, {...opts,media:videoPath,lang});
}

export default { subtitlePathFor, subtitlePathForLang, sanitizeSubtitleLang, installSubtitle, installSubtitleAs };
