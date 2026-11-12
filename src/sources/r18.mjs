// r18.dev metadata source (zero dependencies).
//
// Public API (injected http keeps parsing testable offline — r18.dev is not reachable here):
//   const r18 = createR18(http);
//   r18.name                      -> 'r18'
//   r18.endpointFor(code)         -> JSON endpoint of the first contentId candidate
//   r18.findByCode(code)          -> Promise<null | {code, titleJa, titleZh:null, …}>
//
// The detail endpoint accepts r18's internal contentId (`ipx00920`), which is usually the
// label lowercased + the number zero-padded to 5 digits. Several spellings are tried in
// order because older entries use unpadded / hyphenated ids.
//
// Defensive parsing (the upstream JSON is not versioned and mirrors differ):
//   code        : dvd_id | content_id | contentId      (content ids are converted back to LABEL-NUM)
//   title       : title | title_ja | title_en
//   date        : release_date | releaseDate
//   duration    : runtime_minutes | runtime | duration
//   maker       : maker_name | maker
//   publisher   : label_name | publisher
//   series      : series_name | series
//   genres      : [{name}] or ['name']  |  actresses: [{name}] or ['name']
//   cover       : images.jacket_image.large_url | images.jacket_image.url
//                 | images.thumb_image.large_url | cover_url
//
// Errors: 404 / non-JSON body / missing identity fields -> null (never throws);
//         transport failure -> {code:'R18_HTTP'}; malformed JSON -> {code:'R18_PARSE'}.
export const R18_BASE = 'https://r18.dev';

const RE_CODE = /^([A-Z]{2,8})[-_ ]?(\d{2,6})$/;

function r18Error(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** First non-empty trimmed string among `obj[key]` for the given keys. */
function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** First positive finite number among `obj[key]` for the given keys (numbers or numeric strings). */
function pickNumber(obj, keys) {
  for (const key of keys) {
    const raw = obj?.[key];
    const num = typeof raw === 'number' ? raw : Number.parseFloat(String(raw == null ? '' : raw));
    if (Number.isFinite(num) && num > 0) return Math.round(num * 100) / 100;
  }
  return null;
}

function parseDate(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
}

/** `[{name}]` / `['name']` / `{name}` -> unique non-empty names (order preserved). */
function namesOf(list) {
  const values = Array.isArray(list) ? list : list == null ? [] : [list];
  const names = [];
  for (const item of values) {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  }
  return names;
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * contentId candidates tried in order: `ipx00920`, `ipx920`, `ipx-920`.
 * @param {string} code e.g. 'IPX-920'
 * @returns {string[]} lower-case content ids (empty when the input is not a code)
 */
export function contentIdsFor(code) {
  const raw = String(code == null ? '' : code).normalize('NFKC').trim().toUpperCase();
  const match = RE_CODE.exec(raw);
  if (!match) return [];
  const label = match[1].toLowerCase();
  const num = match[2];
  const ids = [];
  const add = (value) => { if (value && !ids.includes(value)) ids.push(value); };
  add(label + num.padStart(5, '0'));
  add(label + num);
  add(`${label}-${num}`);
  return ids;
}

/** JSON endpoint for the first contentId candidate (null for a non-code input). */
export function endpointFor(code) {
  const ids = contentIdsFor(code);
  if (!ids.length) return null;
  return `${R18_BASE}/videos/vod/movies/detail/-/id=${ids[0]}/json`;
}

/**
 * r18 content ids hide the separator and zero-pad the number to 5 digits
 * (`ipx00920`, `ssis00001`). Convert back to the pipeline's display form
 * (`IPX-920`, `SSIS-001`) so canonCode() comparisons and file names stay consistent.
 */
function codeFromContentId(contentId) {
  const match = /^([a-z]{2,8})[-_ ]?(\d{2,6})$/i.exec(String(contentId || '').trim());
  if (!match) return null;
  const label = match[1].toUpperCase();
  let digits = match[2].replace(/^0+(?=\d)/, '');
  if (digits.length < 3) digits = digits.padStart(3, '0');
  return `${label}-${digits}`;
}

/**
 * Map one r18 detail JSON object to the pipeline metadata shape.
 * @returns {object|null} null when identity/title fields are missing
 */
export function parseR18Record(json, { url = null } = {}) {
  if (!isPlainObject(json)) return null;
  // Some deployments wrap the payload as `{data:{…}}`; raw objects are the documented shape.
  const record = isPlainObject(json.data) ? json.data : json;

  const dvdId = pickString(record, ['dvd_id', 'dvdId']);
  const contentId = pickString(record, ['content_id', 'contentId']);
  const code = dvdId || codeFromContentId(contentId);
  const title = pickString(record, ['title', 'title_ja', 'title_en']);
  if (!code && !title) return null;

  const images = isPlainObject(record.images) ? record.images : {};
  const jacket = images.jacket_image;
  const thumb = images.thumb_image;
  const coverValues = [];
  for (const card of [jacket, thumb]) {
    if (typeof card === 'string') coverValues.push(card);
    else if (isPlainObject(card)) coverValues.push(card.large_url, card.url, card.small_url);
  }
  coverValues.push(record.cover_url, record.coverUrl);

  return {
    code,
    titleJa: title || '',
    titleZh: null,
    releaseDate: parseDate(pickString(record, ['release_date', 'releaseDate'])),
    durationMin: pickNumber(record, ['runtime_minutes', 'runtime', 'duration']),
    maker: pickString(record, ['maker_name', 'maker']),
    publisher: pickString(record, ['label_name', 'publisher']),
    series: pickString(record, ['series_name', 'series']),
    genres: namesOf(record.genres ?? record.genre),
    actress: namesOf(record.actresses ?? record.actress ?? record.actors),
    coverUrl: firstString(coverValues),
    url: url || null,
    source: 'r18',
  };
}

/**
 * @param {{getFollow:Function}} http createHttp() instance (or a test stub)
 */
export function createR18(http) {
  if (!http || typeof http.getFollow !== 'function') throw new TypeError('createR18(http): http.getFollow is required');

  /**
   * Fetch with an optional proxy fallback: r18.dev is often only reachable through the
   * configured proxy even when other hosts are direct. When a proxy is configured, one
   * failed direct attempt is retried once via the proxy route.
   * @param {string} url
   * @param {object} options
   */
  async function fetchWithRouteFallback(url, options) {
    try {
      return await http.getFollow(url, options);
    } catch (cause) {
      if (!http.config || !http.config.proxy) throw cause;
      try {
        return await http.getFollow(url, { ...options, route: 'proxy' });
      } catch {
        throw cause; // surface the original error
      }
    }
  }

  /**
   * Fetch + parse one r18 detail document.
   * @returns {Promise<object|null>}
   */
  async function findByCode(code) {
    const ids = contentIdsFor(code);
    if (!ids.length) return null;

    for (const id of ids) {
      const url = `${R18_BASE}/videos/vod/movies/detail/-/id=${encodeURIComponent(id)}/json`;
      let res;
      try {
        res = await fetchWithRouteFallback(url, {
          headers: { Accept: 'application/json, text/plain, */*', Referer: `${R18_BASE}/` },
        });
      } catch (cause) {
        throw r18Error('R18_HTTP', `r18 request failed for ${id}: ${cause?.message || cause}`, { url, cause });
      }
      const status = Number(res?.status ?? 0);
      if (status === 404) continue;
      if (status !== 200) {
        throw r18Error('R18_HTTP', `r18 HTTP ${status} for ${id}`, { url: res?.url || url, status });
      }

      const text = String(res?.text != null ? res.text : res?.buffer?.toString('utf8') ?? '')
        .replace(/^\uFEFF/, '')
        .trim();
      if (!text) continue;
      // r18 answers real JSON here; an HTML challenge/error page means "no match".
      if (!/^[{\[]/.test(text)) continue;

      let json;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        throw r18Error('R18_PARSE', `r18 returned malformed JSON for ${id}`, { url: res?.url || url, cause });
      }
      const parsed = parseR18Record(json, { url: res?.url || url });
      if (!parsed) continue;
      return parsed;
    }
    return null;
  }

  return { name: 'r18', endpointFor, findByCode };
}

export default createR18;
