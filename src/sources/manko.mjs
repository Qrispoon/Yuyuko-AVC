// manko.fun backend client (zero dependencies).
//
// The site (window.ip) points API calls at healertanker.com, with alpharomeo.shop as
// fallback. Every response is `{ data: "<91-radix variable-length string>", ... }` and
// must be run through the decoder below (exact port of the site bundle's `xn()`):
//   o += 91*l; a |= o << i; i += (8191 & o) > 88 ? 13 : 14; flush a>>=8 while i > 7
//
// Endpoints (verified 2026-11-07):
//   swx/movie/search?keyword=<code>&size=24&page=1&can_manko=true  -> [record...]
//   swx/movie/detail/<movieId>                                     -> object (title in discription[].overview)
//   swx/movie/actors/<movieId>?size=6&page=1                       -> [actor...] (mixed male/female cast)
//   swx/subtitle-link/<movieId>                                    -> { subtitle_link: [{ZH:url},...] }
//
// Notes:
// - `title_display_name` usually only repeats the code; the real localized titles are in
//   `discription` (field name is misspelled upstream) as {language, overview}.
// - actors() mixes genders: the lead performer is the entry with the smallest `order`
//   (often 1, but not always — e.g. IPX-920 has order 114), everything else is 99999.
// - Subtitle file names are data, not derivable: IPX-451's KO subtitle is `IPX-451.srt`
//   (no language suffix), so always trust swx/subtitle-link instead of guessing.
import { UA } from '../net/http.mjs';

export const MANKO_HOSTS = ['healertanker.com', 'alpharomeo.shop'];
export const MANKO_REFERER = 'https://manko.fun/';

// The bundle's 91-character alphabet, in this exact order.
export const MANKO_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"';

/**
 * Decode one `data` payload (91-radix, bit-packed UTF-8).
 * @param {string} encoded
 * @returns {string} UTF-8 text (usually JSON)
 */
export function decodeData(encoded) {
  const text = String(encoded == null ? '' : encoded);
  const bytes = [];
  let acc = 0; // 32-bit accumulator (the bundle's `a`)
  let bits = 0; // the bundle's `i`
  let pending = -1; // the bundle's `o`
  for (let i = 0; i < text.length; i++) {
    const value = MANKO_ALPHABET.indexOf(text[i]);
    if (value === -1) continue;
    if (pending < 0) {
      pending = value;
      continue;
    }
    pending += 91 * value;
    acc = (acc | (pending << bits)) | 0;
    bits += (8191 & pending) > 88 ? 13 : 14;
    do {
      bytes.push(acc & 255);
      acc >>= 8;
      bits -= 8;
    } while (bits > 7);
    pending = -1;
  }
  if (pending > -1) bytes.push((acc | (pending << bits)) & 255);
  return Buffer.from(bytes).toString('utf8');
}

/** Decode a full API envelope: `{data:<encoded>}` -> same object with `payload` attached. */
export function decodeEnvelope(json) {
  if (!json || typeof json !== 'object') throw mankoError('MANKO_BAD_ENVELOPE', 'API response is not an object');
  if (typeof json.data === 'string') {
    const text = decodeData(json.data);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw Object.assign(mankoError('MANKO_BAD_PAYLOAD', 'decoded manko payload is not JSON'), {
        sample: text.slice(0, 200),
        cause,
      });
    }
    return { ...json, payload };
  }
  // Some mirrors already return plain JSON in `data` / at the root; accept it as-is.
  if (json.data && typeof json.data === 'object') return { ...json, payload: json.data };
  return { ...json, payload: json };
}

/** Normalize `[{KO:'…'},{ZH:'…'}]` to `[{lang:'KO', url:'…'}…]` (first occurrence wins). */
export function normalizeSubtitleLinks(list) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [lang, url] of Object.entries(entry)) {
      if (typeof url !== 'string' || !url) continue;
      if (seen.has(lang)) continue;
      seen.add(lang);
      out.push({ lang, url });
    }
  }
  return out;
}

/** Compare codes loosely: 'ipx 920' / 'IPX_920' / 'IPX-920' are the same. */
export function normalizeCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Pick the best search hit for a code.
 * `/search` returns near-duplicates of the same movie (different `_id`, one often has no
 * subtitles), so prefer an exact title match, then a record that knows its subtitles.
 */
export function pickBestRecord(records, code) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (!list.length) return null;
  const wanted = normalizeCode(code);
  let best = null;
  let bestScore = -Infinity;
  for (const record of list) {
    let score = 0;
    if (normalizeCode(record.title) === wanted) score += 100;
    const subs = Array.isArray(record.subtitle_link) ? record.subtitle_link : [];
    score += Math.min(subs.length, 8) * 2;
    if (record.can_play) score += 1;
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }
  return best;
}

/** Split actors into the lead performer(s) (smallest `order`) vs. the rest. */
export function splitLeadActors(actors) {
  const list = Array.isArray(actors) ? actors.filter(Boolean) : [];
  if (!list.length) return { leads: [], rest: [] };
  const orders = list.map((actor) => (Number.isFinite(Number(actor.order)) ? Number(actor.order) : 99999));
  const minOrder = Math.min(...orders);
  const leads = [];
  const rest = [];
  list.forEach((actor, index) => (orders[index] === minOrder ? leads : rest).push(actor));
  return { leads, rest };
}

/** Map an actor record to the unified `{jp, zh, en}` shape (plus useful extras). */
export function mapActor(actor) {
  const also = actor?.also_known_as || {};
  const name = typeof actor?.name === 'string' ? actor.name.trim() : '';
  return {
    jp: (also.jp || name || '').trim() || null,
    // No explicit `zh` key upstream; `tw` is the closest Chinese variant, then the display name.
    zh: (also.zh || also.tw || name || '').trim() || null,
    en: (also.en || '').trim() || null,
    name: name || null,
    personId: actor?.person_id || null,
    order: Number.isFinite(Number(actor?.order)) ? Number(actor.order) : null,
  };
}

function mankoError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

function toNumber(value) {
  const num = Number.parseFloat(String(value == null ? '' : value));
  return Number.isFinite(num) ? num : null;
}

function localizedOverview(list, language) {
  const entries = Array.isArray(list) ? list : [];
  const entry = entries.find((item) => String(item?.language || '').toLowerCase() === language);
  return entry && typeof entry.overview === 'string' && entry.overview.trim() ? entry.overview.trim() : null;
}

function localizedTitle(list, language) {
  const entries = Array.isArray(list) ? list : [];
  const entry = entries.find((item) => String(item?.language || '').toLowerCase() === language);
  return entry && typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : null;
}

/**
 * @param {ReturnType<import('../net/http.mjs').createHttp>} http
 */
export function createManko(http) {
  if (!http || typeof http.getFollow !== 'function') throw new TypeError('createManko(http): http.getFollow is required');

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Origin: 'https://manko.fun',
    Referer: MANKO_REFERER,
    'User-Agent': UA,
  };

  /**
   * GET an API path against the primary host, then the fallback host.
   * @returns {Promise<{host:string, status:number, route:string|null, ms:number|null, payload:any}>}
   */
  async function api(pathname) {
    const errors = [];
    for (const host of MANKO_HOSTS) {
      const url = `https://${host}/${String(pathname).replace(/^\/+/, '')}`;
      try {
        const res = await http.getFollow(url, { headers });
        if (res.status !== 200) {
          errors.push(`${host} HTTP ${res.status}`);
          continue;
        }
        let json;
        try {
          json = JSON.parse(res.text);
        } catch {
          errors.push(`${host} non-JSON response`);
          continue;
        }
        const decoded = decodeEnvelope(json);
        return { host, status: res.status, route: res.route || null, ms: res.ms ?? null, payload: decoded.payload };
      } catch (cause) {
        errors.push(`${host} ${cause?.code || cause?.message || cause}`);
      }
    }
    throw mankoError('MANKO_API_FAILED', `manko API failed for ${pathname}`, { path: pathname, errors });
  }

  async function searchRecords(code) {
    const keyword = String(code || '').trim();
    if (!keyword) throw mankoError('MANKO_BAD_CODE', 'search(code): empty code');
    const { payload } = await api(`swx/movie/search?keyword=${encodeURIComponent(keyword)}&size=24&page=1&can_manko=true`);
    return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  }

  async function detailOf(movieId) {
    const id = String(movieId || '').trim();
    if (!id) throw mankoError('MANKO_BAD_MOVIE_ID', 'detail(movieId): empty movieId');
    const { payload } = await api(`swx/movie/detail/${encodeURIComponent(id)}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw mankoError('MANKO_BAD_DETAIL', `manko detail ${id}: unexpected payload`);
    }
    return payload;
  }

  async function actorsOf(movieId) {
    const id = String(movieId || '').trim();
    if (!id) throw mankoError('MANKO_BAD_MOVIE_ID', 'actors(movieId): empty movieId');
    const { payload } = await api(`swx/movie/actors/${encodeURIComponent(id)}?size=6&page=1`);
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    return list.slice().sort((a, b) => (Number(a?.order) || 99999) - (Number(b?.order) || 99999));
  }

  async function subtitleLinkOf(movieId) {
    const id = String(movieId || '').trim();
    if (!id) throw mankoError('MANKO_BAD_MOVIE_ID', 'subtitleLink(movieId): empty movieId');
    const { payload } = await api(`swx/subtitle-link/${encodeURIComponent(id)}`);
    return normalizeSubtitleLinks(payload?.subtitle_link ?? payload?.data?.subtitle_link);
  }

  async function findByCode(code) {
    const keyword = String(code || '').trim();
    if (!keyword) throw mankoError('MANKO_BAD_CODE', 'findByCode(code): empty code');
    const search = await api(`swx/movie/search?keyword=${encodeURIComponent(keyword)}&size=24&page=1&can_manko=true`);
    const records = Array.isArray(search.payload) ? search.payload : Array.isArray(search.payload?.data) ? search.payload.data : [];
    const record = pickBestRecord(records, keyword);
    if (!record || !record._id) return null;

    const movieId = String(record._id);
    const detail = await detailOf(movieId);
    let actors = [];
    try {
      actors = await actorsOf(movieId);
    } catch {
      actors = [];
    }
    let subtitles = [];
    try {
      subtitles = await subtitleLinkOf(movieId);
    } catch {
      subtitles = [];
    }

    const { leads } = splitLeadActors(actors);
    const titleJa =
      localizedOverview(detail.discription, 'ja') ||
      localizedTitle(detail.title_display_name, 'ja') ||
      localizedTitle(detail.title_display_name, 'en') ||
      (typeof record.title === 'string' ? record.title : null);
    const titleZh = localizedOverview(detail.discription, 'zh') || localizedOverview(detail.discription, 'tw');

    return {
      movieId,
      code: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : keyword,
      titleJa,
      titleZh,
      actress: leads.map(mapActor),
      durationMin: toNumber(detail.video_duration),
      rating: toNumber(detail.rating) ?? toNumber(record.rating) ?? toNumber(record.imdb_score),
      maker: record.maker || detail.country || null,
      releaseDate: detail.share_date || record.share_date || null,
      coverUrl: detail.cover_image || record.wide_thumbnail || record.thumbnail_image || null,
      subtitles,
      host: search.host,
    };
  }

  async function download(url) {
    const target = String(url || '').trim();
    if (!target) throw mankoError('MANKO_BAD_URL', 'download(url): empty url');
    const res = await http.getFollow(target, { headers: { Accept: '*/*', Referer: MANKO_REFERER } });
    if (res.status !== 200) {
      throw mankoError('MANKO_DOWNLOAD_HTTP', `manko subtitle download HTTP ${res.status}`, {
        url: res.url || target,
        status: res.status,
      });
    }
    return {
      buffer: res.buffer,
      status: res.status,
      url: res.url || target,
      contentType: res.headers?.['content-type'] || null,
    };
  }

  // findByCode costs 4 API round-trips (search/detail/actors/subtitle-link). The pipeline
  // asks for the same code once for metadata and once for subtitles, so memoize per code
  // (in-flight promises are shared; failures are not cached).
  const findCache = new Map();
  function cachedFindByCode(code) {
    const key = normalizeCode(code) || String(code || '').trim().toUpperCase();
    if (!findCache.has(key)) {
      const pending = findByCode(code).catch((err) => {
        findCache.delete(key);
        throw err;
      });
      findCache.set(key, pending);
    }
    return findCache.get(key);
  }

  return {
    /** Search a code. @returns {Promise<object[]>} raw search records (decoded) */
    search: searchRecords,
    /** Raw decoded detail object for a movieId. */
    detail: detailOf,
    /** Raw decoded actor list, sorted by `order` ascending (lead first). */
    actors: actorsOf,
    /** Subtitle links: `[{lang:'ZH', url:'https://…'}, …]` */
    subtitleLink: subtitleLinkOf,
    /** One-call resolve (memoized per code; shared with the subtitle source). */
    findByCode: cachedFindByCode,
    /** Drop the findByCode memo (e.g. after external changes). */
    clearCache() {
      findCache.clear();
    },
    /** Download an arbitrary URL (e.g. a subtitle) through the shared network layer. */
    download,
  };
}
