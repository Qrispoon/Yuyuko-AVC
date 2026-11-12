// manko subtitle source: simplified Chinese (ZH) only.
//
// Multi-candidate interface (docs/CONTRACTS.md §8, additive):
//   createMankoSubSource(manko) -> {
//     name: 'manko',
//     listCandidates(code) -> Promise<Candidate[]>,   // 0 or 1 entry (ZH)
//     download(candidate)  -> Promise<{buffer, bytes, contentType}>,
//     find(code)           -> Promise<Candidate|null>, // legacy shim used by pipeline.mjs
//     findLang(code, lang) -> Promise<{source, lang, url, movieId}|null>, // F17 extra subtitle
//   }
// A Candidate is { source:'manko', lang:'zh', name, url, sizeHint?, code, movieId, subtitles }.
//
// `createMankoSubSource(manko)` reuses a createManko() client so the caller keeps one
// network layer (proxy/cookie/throttle) and one memoized metadata lookup per code.
// Language keys are raw manko keys: ZH = 简体, TW = 繁体, EN, KO … — listCandidates()/find()
// only accept ZH (the main subtitle), while F17's findLang(code, lang) serves the optional
// extra languages (zh-TW→TW, en→EN, ko→KO).
// Never guess subtitle file names (IPX-451's KO file is `IPX-451.srt`, no suffix).
export const MANKO_EXTRA_LANG_KEYS = {
  'zh-TW': 'TW',
  en: 'EN',
  ko: 'KO',
};

/** Resolve a config language tag to its manko key ('zh-TW' -> 'TW'); null when unsupported. */
export function mankoLangKey(lang) {
  const wanted = String(lang == null ? '' : lang).trim().toLowerCase();
  for (const [key, mankoKey] of Object.entries(MANKO_EXTRA_LANG_KEYS)) {
    if (key.toLowerCase() === wanted) return { lang: key, mankoKey };
  }
  return null;
}

function basename(url) {
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : null;
  } catch {
    return null;
  }
}

function subSourceError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

/**
 * @param {{findByCode:Function, download?:Function}} manko createManko() instance
 */
export function createMankoSubSource(manko) {
  if (!manko || typeof manko.findByCode !== 'function') {
    throw new TypeError('createMankoSubSource(manko): manko.findByCode is required');
  }

  /**
   * Build the single ZH candidate for a code (or an empty array).
   * @param {string} code
   * @returns {Promise<Array<{source:'manko', lang:'zh', name:string, url:string,
   *   code:string, movieId:string|null, subtitles:{lang:string,url:string}[]}>>}
   */
  async function listCandidates(code) {
    if (!code || typeof code !== 'string') throw new TypeError('listCandidates(code): non-empty string required');
    const record = await manko.findByCode(code);
    if (!record) return [];
    const subtitles = Array.isArray(record.subtitles) ? record.subtitles : [];
    const zh = subtitles.find((sub) => String(sub?.lang || '').toUpperCase() === 'ZH');
    if (!zh || typeof zh.url !== 'string' || !zh.url) return [];
    const resolvedCode = record.code || String(code).trim();
    return [
      {
        source: 'manko',
        lang: 'zh',
        // File name is informative but never load-bearing: the URL is the identity.
        name: basename(zh.url) || `${resolvedCode}.srt`,
        url: zh.url,
        code: resolvedCode,
        movieId: record.movieId || null,
        subtitles,
      },
    ];
  }

  return {
    name: 'manko',

    listCandidates,

    /** Legacy single-result shim (pipeline.mjs). Returns the best candidate or null. */
    async find(code) {
      const candidates = await listCandidates(code);
      return candidates.length ? candidates[0] : null;
    },

    /**
     * F17: find one subtitle in a configured extra language.
     * Never throws when the language/subtitle is absent — returns null instead.
     * @param {string} code
     * @param {'zh-TW'|'en'|'ko'|string} lang config language tag
     * @returns {Promise<{source:'manko', lang:string, url:string, movieId:string|null}|null>}
     */
    async findLang(code, lang) {
      if (!code || typeof code !== 'string') return null;
      const mapping = mankoLangKey(lang);
      if (!mapping) return null;
      const record = await manko.findByCode(code);
      if (!record) return null;
      const subtitles = Array.isArray(record.subtitles) ? record.subtitles : [];
      const hit = subtitles.find((sub) => String(sub?.lang || '').toUpperCase() === mapping.mankoKey);
      if (!hit || typeof hit.url !== 'string' || !hit.url) return null;
      return {
        source: 'manko',
        lang: mapping.lang,
        url: hit.url,
        movieId: record.movieId || null,
      };
    },

    /**
     * Download the subtitle picked by listCandidates()/find().
     * Accepts a candidate object or a bare URL string.
     * @param {{url:string}|string} candidate
     * @returns {Promise<{buffer:Buffer, url:string, bytes:number, contentType:string|null}>}
     */
    async download(candidate) {
      const url = typeof candidate === 'string' ? candidate : candidate?.url;
      if (!url) throw subSourceError('MANKO_SUB_BAD_FOUND', 'download(candidate): candidate.url is required');
      if (typeof manko.download !== 'function') {
        throw subSourceError(
          'MANKO_SUB_NO_DOWNLOAD',
          'download(candidate): the manko client exposes no download(url) — create it with createManko(http)',
        );
      }
      const res = await manko.download(url);
      const buffer = res?.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw subSourceError('MANKO_SUB_EMPTY', `download(candidate): empty body from ${url}`, { url });
      }
      return {
        buffer,
        url: res.url || url,
        bytes: buffer.length,
        contentType: res.contentType || null,
      };
    },
  };
}
