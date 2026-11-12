// F16: keyword lookup (title / actress / anything) for files that carry no code.
//
//   const lookup = createLookup({ http, config });
//   await lookup.byKeyword('明里つむぎ', { limit: 10 })
//     -> [{ code, movieId, title, releaseDate, maker, coverUrl, source:'javbus'|'manko' }, …]
//
// Backends, in order:
//   1. javbus keyword search — verified live to accept actress names (Japanese) and title
//      fragments, returning `movie-box` items with code / title / cover / release date.
//   2. manko `/swx/movie/search?keyword=` — only matches codes in practice (its search is
//      code-oriented), kept as a fallback for code-like input.
//
// Ordering: an input that is itself a code and matches a candidate (canonical comparison)
// comes first; everything else is sorted by releaseDate descending. Candidates are
// de-duplicated by canonical code, then truncated to `limit`.
import { createJavbus } from './javbus.mjs';
import { createManko } from './manko.mjs';

const RE_CODE = /^([A-Z]{2,8})[-_ ]?(\d{2,6})$/i;

/** Same canonical form as pipeline.canonCode: ignore separators / leading zeros. */
function canonCode(code) {
  const raw = String(code == null ? '' : code).toUpperCase().trim();
  const match = /^([A-Z]{2,8})[-_ .]?(\d{1,6})$/.exec(raw);
  if (!match) return raw.replace(/[^A-Z0-9]/g, '');
  return `${match[1]}-${match[2].replace(/^0+(?=\d)/, '')}`;
}

function isCode(value) {
  return RE_CODE.test(String(value == null ? '' : value).trim());
}

function dateValue(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/** Map one manko search record to a lookup candidate (null when it is not a code). */
export function mapLookupRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const code = typeof record.title === 'string' ? record.title.trim() : '';
  if (!RE_CODE.test(code)) return null;
  const display = Array.isArray(record.title_display_name) ? record.title_display_name[0] : null;
  const displayTitle = display && typeof display.title === 'string' && display.title.trim()
    ? display.title.trim()
    : null;
  return {
    code,
    movieId: record._id ?? null,
    title: displayTitle || code,
    releaseDate: typeof record.share_date === 'string' && record.share_date.trim() ? record.share_date : null,
    maker: typeof record.maker === 'string' && record.maker.trim() ? record.maker : null,
    coverUrl: record.wide_thumbnail || record.thumbnail_image || null,
    source: 'manko',
  };
}

/** Map one javbus search item to a lookup candidate. */
export function mapJavbusItem(item) {
  if (!item || typeof item !== 'object' || !item.code) return null;
  return {
    code: String(item.code).trim(),
    movieId: null,
    title: item.title || String(item.code).trim(),
    releaseDate: item.releaseDate || null,
    maker: null,
    coverUrl: item.coverUrl || null,
    source: 'javbus',
  };
}

/**
 * @param {{http:object, config?:object}} opts
 */
export function createLookup({ http, config } = {}) {
  const javbus = createJavbus(http);
  const manko = createManko(http);

  async function searchJavbus(query, limit) {
    const items = await javbus.searchKeyword(query, { limit: Math.max(10, limit) });
    return (Array.isArray(items) ? items : []).map(mapJavbusItem).filter(Boolean);
  }

  async function searchManko(query) {
    const records = await manko.search(query);
    return (Array.isArray(records) ? records : []).map(mapLookupRecord).filter(Boolean);
  }

  /**
   * Search by an arbitrary keyword (title fragment / actress / code).
   * @param {string} keyword
   * @param {{limit?:number}} [options]
   * @returns {Promise<Array<{code:string,movieId:any,title:string,releaseDate:string|null,
   *   maker:string|null,coverUrl:string|null,source:'javbus'|'manko'}>>}
   */
  async function byKeyword(keyword, { limit = 10 } = {}) {
    const query = String(keyword == null ? '' : keyword).trim();
    if (!query) return [];
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 10;
    const wanted = isCode(query) ? canonCode(query) : null;

    const errors = [];
    let found = [];
    try {
      found = await searchJavbus(query, cap);
    } catch (e) {
      errors.push(e);
    }
    if (!found.length) {
      try {
        found = await searchManko(query);
      } catch (e) {
        errors.push(e);
      }
    }
    if (!found.length && errors.length) throw errors[errors.length - 1];

    const seen = new Set();
    const candidates = [];
    for (const candidate of found) {
      const key = canonCode(candidate.code);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({ candidate, exact: wanted != null && key === wanted });
    }

    candidates.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      const da = dateValue(a.candidate.releaseDate);
      const db = dateValue(b.candidate.releaseDate);
      if (da === db) return 0;
      if (da === -Infinity) return 1;
      if (db === -Infinity) return -1;
      return db - da;
    });

    return candidates.slice(0, cap).map((entry) => entry.candidate);
  }

  return { byKeyword };
}

export default createLookup;
