// javbus.com metadata source (zero dependencies).
//
// Verified live 2026-11-07 against https://www.javbus.com/ABP-984:
//   search page  : <a class="movie-box" href="https://www.javbus.com/ABP-984">
//   title        : first <h3>…</h3> on the detail page
//   info rows    : <p><span class="header">識別碼:</span> …</p>
//                  (識別碼 / 發行日期 / 長度 / 導演 / 製作商 / 發行商 / 系列)
//   actress      : div.star-name a[title]   (span.genre also holds /star/ links — do not use text there)
//   genres       : only span.genre blocks whose inner <a> points at /genre/
//   cover        : a.bigImage[href] (site-relative, e.g. /pics/cover/7prq_b.jpg)
//   duration     : 長度: 169分鐘 -> 169
//
// Network is injected (`createJavbus(http)`) so parsing stays testable offline.
export const JAVBUS_BASE = 'https://www.javbus.com';

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Decode the small set of HTML entities javbus actually emits. */
export function decodeEntities(input) {
  return String(input == null ? '' : input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const num = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(num) && num > 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

/** Strip tags + decode entities + collapse whitespace. */
export function textOf(html) {
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a possibly site-relative javbus link to an absolute https URL. */
export function absoluteUrl(href, base = JAVBUS_BASE) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, base.endsWith('/') ? base : base + '/').href;
  } catch {
    return null;
  }
}

/** Normalize for exact code comparison: 'ABP-984' / 'abp 984' -> 'ABP984'. */
export function normalizeCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Parse a javbus search result page.
 * @returns {string[]} absolute detail URLs, in page order
 */
export function parseSearchHtml(html) {
  const source = String(html == null ? '' : html);
  const links = [];
  for (const match of source.matchAll(/class="movie-box"[^>]*href="([^"]+)"/gi)) {
    const url = absoluteUrl(match[1]);
    if (url && !links.includes(url)) links.push(url);
  }
  return links;
}

/**
 * Parse a javbus search result page into rich candidates (code / url / title / cover / date).
 * Used by keyword lookup (F16): javbus search accepts actress names and title fragments.
 *
 * @param {string} html
 * @param {{limit?: number}} [opts]
 * @returns {Array<{code: string, url: string, title: string|null, coverUrl: string|null, releaseDate: string|null}>}
 */
export function parseSearchItems(html, opts = {}) {
  const source = String(html == null ? '' : html);
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 30));
  const items = [];
  const seen = new Set();
  for (const block of source.matchAll(/<a class="movie-box"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(block[1]);
    if (!url) continue;
    const body = block[2];
    const slug = decodeURIComponent(String(block[1]).split('/').filter(Boolean).pop() || '');
    const dates = [...body.matchAll(/<date[^>]*>([\s\S]*?)<\/date>/gi)].map((m) => textOf(m[1]));
    const code = (dates[0] || slug || '').trim();
    if (!code) continue;
    const key = normalizeCode(code);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const titleAttr = (/<img[^>]*\btitle="([^"]*)"/i.exec(body) || [])[1] || '';
    const src = (/<img[^>]*\bsrc="([^"]*)"/i.exec(body) || [])[1] || '';
    items.push({
      code,
      url,
      title: textOf(titleAttr) || null,
      coverUrl: absoluteUrl(src),
      releaseDate: parseDate(dates[1] || '') || null,
    });
    if (items.length >= limit) break;
  }
  return items;
}

/** Pull `<span class="header">KEY:</span> VALUE` rows into a plain object. */function parseInfoRows(html) {
  const info = {};
  for (const match of String(html).matchAll(/<p[^>]*>\s*<span class="header">([\s\S]*?)<\/span>([\s\S]*?)<\/p>/gi)) {
    const key = textOf(match[1]).replace(/[:：]\s*$/, '').trim();
    if (!key) continue;
    const value = textOf(match[2]);
    if (value === '' || value === '----' || value === 'N/A') continue;
    if (!Object.prototype.hasOwnProperty.call(info, key)) info[key] = value;
  }
  return info;
}

function pickInfo(info, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(info, key) && info[key]) return info[key];
  }
  return null;
}

function parseDuration(value) {
  if (!value) return null;
  const match = String(value).match(/(\d+)\s*(?:分鐘|分钟|分|min)/i);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function parseDate(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!match) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${match[1]}-${pad(match[2])}-${pad(match[3])}`;
}

/** Genres live only inside span.genre blocks; those blocks also carry /star/ links. */
export function parseGenres(html) {
  const source = String(html == null ? '' : html);
  const genres = [];
  for (const block of source.matchAll(/<span class="genre"[^>]*>([\s\S]*?)<\/span>/gi)) {
    for (const link of block[1].matchAll(/<a[^>]+href="([^"]*\/genre\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const name = textOf(link[2]);
      if (name && !genres.includes(name)) genres.push(name);
    }
  }
  return genres;
}

/** Actresses: div.star-name a[title], falling back to avatar boxes. */
export function parseActresses(html) {
  const source = String(html == null ? '' : html);
  const names = [];
  const push = (value) => {
    const name = textOf(value);
    if (name && !names.includes(name)) names.push(name);
  };
  for (const match of source.matchAll(/<div class="star-name"[^>]*>\s*<a[^>]*\btitle="([^"]+)"/gi)) push(match[1]);
  if (names.length) return names;
  for (const match of source.matchAll(/<a class="avatar-box"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi)) push(match[1]);
  return names;
}

/** Cover image from a.bigImage (site-relative). */
export function parseCover(html) {
  const match = /<a class="bigImage"[^>]*href="([^"]+)"/i.exec(String(html == null ? '' : html));
  return match ? absoluteUrl(match[1]) : null;
}

/**
 * Parse a javbus detail page.
 * @param {string} html
 * @param {{url?: string, code?: string}} [opts]
 * @returns {{code:string,titleJa:string,releaseDate:string|null,durationMin:number|null,
 *   maker:string|null,publisher:string|null,series:string|null,genres:string[],
 *   actress:string[],coverUrl:string|null,url:string|null}}
 */
export function parseDetailHtml(html, opts = {}) {
  const source = String(html == null ? '' : html);
  if (!source.trim()) throw parseError('JAVBUS_EMPTY_DETAIL', 'javbus detail page is empty');
  const info = parseInfoRows(source);

  const title = textOf((/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(source) || [])[1]);
  const url = opts.url || null;
  const code =
    pickInfo(info, ['識別碼', '识别码', '番號', '番号']) ||
    (url ? decodeURIComponent(String(url).split('/').filter(Boolean).pop() || '') : null) ||
    opts.code ||
    null;

  if (!title && !code) {
    throw parseError('JAVBUS_PARSE_FAILED', 'javbus detail page: neither <h3> title nor 識別碼 found');
  }
  if (!title) {
    throw parseError('JAVBUS_PARSE_FAILED', 'javbus detail page: missing <h3> title', { url, code });
  }

  return {
    code,
    titleJa: title,
    releaseDate: parseDate(pickInfo(info, ['發行日期', '发行日期', '配信開始日'])),
    durationMin: parseDuration(pickInfo(info, ['長度', '长度', '収録時間'])),
    maker: pickInfo(info, ['製作商', '制作商', 'メーカー']),
    publisher: pickInfo(info, ['發行商', '发行商', 'レーベル']),
    series: pickInfo(info, ['系列', 'シリーズ']),
    genres: parseGenres(source),
    actress: parseActresses(source),
    coverUrl: parseCover(source),
    url,
  };
}

function parseError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...(extra || {}) });
}

/**
 * @param {ReturnType<import('../net/http.mjs').createHttp>} http
 */
export function createJavbus(http) {
  if (!http || typeof http.getFollow !== 'function') throw new TypeError('createJavbus(http): http.getFollow is required');

  async function fetchPage(url, what) {
    let res;
    try {
      res = await http.getFollow(url, { headers: { Referer: `${JAVBUS_BASE}/` } });
    } catch (cause) {
      throw Object.assign(new Error(`javbus ${what} request failed: ${cause?.message || cause}`), {
        code: 'JAVBUS_NETWORK',
        url,
        cause,
      });
    }
    if (res.status !== 200) {
      throw Object.assign(new Error(`javbus ${what} HTTP ${res.status}`), {
        code: 'JAVBUS_HTTP_STATUS',
        status: res.status,
        url: res.url || url,
      });
    }
    if (!res.text || !res.text.trim()) {
      throw Object.assign(new Error(`javbus ${what} returned an empty body`), { code: 'JAVBUS_EMPTY_BODY', url });
    }
    return res;
  }

  return {
    /**
     * Search a code on javbus.
     * @param {string} code
     * @returns {Promise<string|null>} absolute detail URL, or null when no result matched
     */
    async search(code) {
      const keyword = String(code || '').trim();
      if (!keyword) throw parseError('JAVBUS_BAD_CODE', 'search(code): empty code');
      const url = `${JAVBUS_BASE}/search/${encodeURIComponent(keyword)}&type=&parent=ce`;
      const res = await fetchPage(url, 'search');
      const links = parseSearchHtml(res.text);
      if (!links.length) return null;

      // Prefer the box whose slug equals the requested code (search also returns loose matches).
      const wanted = normalizeCode(keyword);
      const exact = links.find((link) => {
        const slug = decodeURIComponent(String(link).split('/').filter(Boolean).pop() || '');
        return normalizeCode(slug) === wanted;
      });
      return exact || links[0];
    },

    /**
     * Keyword search (actress / title fragment / code) on javbus.
     * @param {string} keyword
     * @param {{limit?:number}} [opts]
     * @returns {Promise<Array<{code:string,url:string,title:string|null,coverUrl:string|null,releaseDate:string|null}>>}
     */
    async searchKeyword(keyword, opts = {}) {
      const kw = String(keyword || '').trim();
      if (!kw) return [];
      const url = `${JAVBUS_BASE}/search/${encodeURIComponent(kw)}`;
      const res = await fetchPage(url, 'search-keyword');
      return parseSearchItems(res.text, { limit: opts.limit });
    },

    /**
     * Fetch + parse a detail page.
     * @param {string} url absolute detail URL
     * @returns {Promise<object>} parsed metadata (see parseDetailHtml)
     */
    async detail(url) {
      const target = absoluteUrl(url);
      if (!target) throw parseError('JAVBUS_BAD_URL', `detail(url): not a valid URL: ${url}`);
      const res = await fetchPage(target, 'detail');
      const parsed = parseDetailHtml(res.text, { url: res.url || target });
      return { ...parsed, url: res.url || target };
    },
  };
}
