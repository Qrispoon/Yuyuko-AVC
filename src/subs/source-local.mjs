// Subtitle source: a local directory (or several) holding Simplified Chinese .srt files.
//
// Multi-candidate interface (docs/CONTRACTS.md §8/§9 style, unified with the remote sources):
//   createLocalSource({ dirs = [], maxDepth = 2 }) -> {
//     name: 'local',
//     listCandidates(code) -> Promise<Candidate[]>,
//     download(candidate)  -> Promise<{buffer, bytes, contentType}>,
//     find(code)           -> Promise<Candidate|null>,   // convenience for pipeline.mjs
//   }
// A Candidate is { source:'local', lang:'zh', name, localPath (absolute), sizeHint }.
//
// Code matching is deliberately loose: `IPX-920`, `IPX920`, `IPX_920`, `ipx 920`,
// `[中文字幕] IPX-920`, `IPX-0920` all match the code `IPX-920`, but `IPX-9201` or
// `IPX-92` never match it (digit boundaries are respected). Only `.srt` is supported;
// `.ass`/`.ssa` are intentionally out of scope for now.
//
// Ordering: filenames hinting Simplified Chinese (简体/中文/校对/zh-CN) first, then by
// file size descending, then by file name — deterministic across platforms.
import fs from 'node:fs/promises';
import path from 'node:path';

export const SOURCE_NAME = 'local';
export const DEFAULT_MAX_DEPTH = 2;
const SRT_EXT = '.srt';
const ZH_HINT_RE = /简体|中文|校对|zh-?cn/i;

function localError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

/** Uppercase, strip every separator/punctuation: 'IPX-920' -> 'IPX920'. */
export function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Match keys for a code, tolerating separator and leading-zero differences:
 *   'IPX-920' -> ['IPX920', 'IPX0920', 'IPX00920']  (also the unpadded numeric form)
 */
export function codeKeys(code) {
  const raw = String(code || '').toUpperCase();
  const keys = new Set();
  const add = (value) => {
    const normalized = normalizeCode(value);
    if (normalized) keys.add(normalized);
  };
  add(raw);
  const parts = raw.match(/^(.*?)(\d+)$/);
  if (parts) {
    const prefix = normalizeCode(parts[1]);
    const digits = parts[2];
    const numeric = String(Number(digits));
    for (const variant of new Set([digits, numeric])) add(prefix + variant);
    for (let width = digits.length + 1; width <= 5; width++) add(prefix + digits.padStart(width, '0'));
  } else {
    add(raw.replace(/(\d+)/, (d) => d.padStart(5, '0')));
  }
  return [...keys];
}

/**
 * True when `key` occurs in the normalized name without being glued to another digit,
 * so 'IPX920' matches 'IPX920ZH' / '中文字幕IPX920' but not 'IPX9201' or 'IPX9210'.
 */
function containsKey(normalizedName, key) {
  let index = normalizedName.indexOf(key);
  while (index >= 0) {
    const before = index === 0 ? '' : normalizedName[index - 1];
    const after = normalizedName[index + key.length] || '';
    if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true;
    index = normalizedName.indexOf(key, index + 1);
  }
  return false;
}

/** Public helper: does this file name denote the given code? */
export function nameMatchesCode(fileName, code) {
  const stem = String(fileName || '').replace(/\.[^.\\/]*$/, '');
  const normalized = normalizeCode(stem);
  if (!normalized) return false;
  return codeKeys(code).some((key) => containsKey(normalized, key));
}

function isSrtFile(fileName) {
  return path.extname(fileName).toLowerCase() === SRT_EXT;
}

/** Recursively collect *.srt files, visiting at most `maxDepth` levels of sub-directories. */
async function walk(dir, depth, maxDepth, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Missing / unreadable / not-a-directory: treated as an empty directory, never fatal.
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (isSrtFile(entry.name)) out.push(full);
    } else if (entry.isDirectory() && depth < maxDepth) {
      await walk(full, depth + 1, maxDepth, out);
    }
  }
}

function zhHintRank(fileName) {
  return ZH_HINT_RE.test(fileName) ? 0 : 1;
}

function sizeHintOf(candidate) {
  return Number.isFinite(candidate.sizeHint) ? candidate.sizeHint : -1;
}

function compareCandidates(a, b) {
  return (
    zhHintRank(a.name) - zhHintRank(b.name) ||
    sizeHintOf(b) - sizeHintOf(a) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.localPath < b.localPath ? -1 : a.localPath > b.localPath ? 1 : 0)
  );
}

/**
 * @param {{dirs?: string[], localDirs?: string[], maxDepth?: number}|string[]} [options]
 *   dirs:      absolute or relative directories (relative to process.cwd()).
 *   localDirs: alias for `dirs` — matches the config.json key `subs.localDirs`.
 *   maxDepth:  sub-directory levels to descend; 0 = only the listed directories.
 *   An array may also be passed directly as a shorthand for `{ dirs: array }`.
 * @returns {{
 *   name: 'local',
 *   listCandidates: (code: string) => Promise<Array<object>>,
 *   download: (candidate: object|string) => Promise<{buffer:Buffer, bytes:number, contentType:string}>,
 *   find: (code: string) => Promise<object|null>,
 * }}
 */
export function createLocalSource(options = {}) {
  const opts = Array.isArray(options) ? { dirs: options } : (options || {});
  const dirs = opts.dirs ?? opts.localDirs ?? [];
  const { maxDepth = DEFAULT_MAX_DEPTH } = opts;
  if (!Array.isArray(dirs)) throw new TypeError('createLocalSource({dirs}): dirs must be an array');
  if (!Number.isFinite(Number(maxDepth)) || Number(maxDepth) < 0) {
    throw new TypeError('createLocalSource({maxDepth}): maxDepth must be a non-negative number');
  }
  const roots = [...new Set(dirs.map((dir) => path.resolve(String(dir))))];
  const depthLimit = Math.floor(Number(maxDepth));

  /**
   * Every local .srt file whose name matches the code.
   * @param {string} code e.g. 'IPX-920'
   * @returns {Promise<Array<{source:'local', lang:'zh', name:string,
   *   localPath:string, sizeHint?:number}>>}
   */
  async function listCandidates(code) {
    if (!code || typeof code !== 'string') throw new TypeError('listCandidates(code): non-empty string required');
    if (!roots.length) return [];
    const keys = codeKeys(code);
    const files = [];
    for (const root of roots) await walk(root, 0, depthLimit, files);

    const seenPaths = new Set();
    const candidates = [];
    for (const file of files) {
      const fileName = path.basename(file);
      const normalizedName = normalizeCode(fileName.replace(/\.[^.\\/]*$/, ''));
      if (!keys.some((key) => containsKey(normalizedName, key))) continue;
      const localPath = path.resolve(file);
      const dedupeKey = localPath.toLowerCase(); // Windows file systems are case-insensitive
      if (seenPaths.has(dedupeKey)) continue;
      seenPaths.add(dedupeKey);
      const stat = await fs.stat(localPath).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      candidates.push({
        source: SOURCE_NAME,
        lang: 'zh',
        name: fileName,
        localPath,
        sizeHint: stat.size,
      });
    }
    return candidates.sort(compareCandidates);
  }

  return {
    name: SOURCE_NAME,

    listCandidates,

    /** Legacy single-result shim: the best local candidate or null. */
    async find(code) {
      const candidates = await listCandidates(code);
      return candidates.length ? candidates[0] : null;
    },

    /**
     * Read the subtitle file backing a local candidate.
     * @param {{localPath:string}|string} candidate
     * @returns {Promise<{buffer:Buffer, bytes:number, contentType:string}>}
     */
    async download(candidate) {
      const localPath = typeof candidate === 'string' ? candidate : candidate?.localPath;
      if (!localPath) throw localError('LOCAL_SUB_BAD_FOUND', 'download(candidate): candidate.localPath is required');
      let buffer;
      try {
        buffer = await fs.readFile(localPath);
      } catch (e) {
        throw localError('LOCAL_SUB_READ_FAILED', `download(candidate): cannot read ${localPath} (${e.code || e.message})`, {
          localPath,
        });
      }
      if (!buffer.length) throw localError('LOCAL_SUB_EMPTY', `download(candidate): empty file ${localPath}`, { localPath });
      return { buffer, bytes: buffer.length, contentType: 'application/x-subrip' };
    },
  };
}

export default createLocalSource;
