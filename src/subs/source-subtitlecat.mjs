// Subtitle source: subtitlecat.com — multi-candidate edition.
//
// Flow (verified against the live site 2026-11-07):
//   1. GET https://www.subtitlecat.com/index.php?search=<code>
//      -> result rows: <a href="subs/1752/ABP-984%20....html">NAME</a>   (relative, no leading /)
//   2. Result rows carry NO language marker, so the detail page must be opened.
//   3. Detail page lists every language as  href="/subs/667/NAME-zh-CN.srt".
//      ONLY files whose name ends with "-zh-CN.srt" are Simplified Chinese;
//      "-zh-TW.srt" is Traditional and must never be returned as a Chinese candidate.
//   4. Downloading that .srt returns Content-Type: application/octet-stream.
//
// Search results are noisy (searching a non-existent code still returns unrelated
// fuzzy matches), so a candidate is only accepted when the subtitle filename — or the
// combination of result title and detail-page title — actually contains the requested code.
//
// Multi-candidate interface (docs/CONTRACTS.md §9, additive):
//   { name:'subtitlecat',
//     listCandidates(code) -> Promise<Candidate[]>,  // every -zh-CN.srt version found
//     download(candidate)  -> Promise<{buffer, bytes, contentType}>,
//     find(code)           -> Promise<Candidate|null> }  // legacy shim for pipeline.mjs
// A Candidate is { source:'subtitlecat', lang:'zh', name, srtName, url, detailUrl, sizeHint? }.
// Order: names hinting 「简体」or「校对」first, then by sizeHint (Content-Length) descending.
export const BASE_URL = 'https://www.subtitlecat.com/';

const MAX_DETAIL_FETCHES = 12;
const MAX_CANDIDATES = 12;
const SEARCH_TIMEOUT_MS = 30000;
const DETAIL_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const SIZE_TIMEOUT_MS = 15000;

const stripTags = (s) =>
  String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Uppercase, strip every separator/punctuation: 'ABP-984' -> 'ABP984'. */
export function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Code match keys, tolerating leading-zero differences: ABP-984 -> {ABP984, ABP00984}. */
export function codeKeys(code) {
  const keys = new Set();
  const raw = String(code || '').toUpperCase();
  keys.add(normalizeCode(raw));
  keys.add(normalizeCode(raw.replace(/(\d+)/, (d) => d.padStart(5, '0'))));
  keys.add(normalizeCode(raw.replace(/(\d+)/, (d) => String(Number(d)))));
  keys.delete('');
  return [...keys];
}

function matchesCode(text, keys) {
  return keys.some(key=>fullCodeMatches(text,key));
}

function decodeFileName(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function srtFileNameFromUrl(url) {
  const clean = String(url).split('?')[0].split('#')[0];
  const last = clean.split('/').pop();
  return decodeFileName(last);
}

/** Parse the search-result rows out of a subtitlecat search page. */
export function parseSearchRows(html) {
  const rows = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="(?:\.\/|\/)?(subs\/\d+\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    rows.push({ href, name: stripTags(m[2]) });
  }
  return rows;
}

/** Parse every .srt download link out of a subtitlecat detail page (absolute URLs). */
export function parseSrtLinks(html, detailUrl) {
  const links = [];
  const seen = new Set();
  const re = /href="([^"]+?\.srt)"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const raw = m[1];
    let abs;
    try {
      abs = new URL(raw, detailUrl || BASE_URL).href;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    links.push(abs);
  }
  return links;
}

/** True when the srt filename denotes Simplified Chinese (ends with -zh-CN.srt). */
export function isSimplifiedSrt(url) {
  return /-zh-CN\.srt$/i.test(srtFileNameFromUrl(url));
}

/** True when a candidate's title/filename advertises a Simplified or proofread version. */
function isPreferred(candidate) {
  return /简体|校对/.test(`${candidate.name || ''} ${candidate.srtName || ''}`);
}

function sizeHintOf(candidate) {
  return Number.isFinite(candidate.sizeHint) ? candidate.sizeHint : -1;
}

/** Preferred-hint first, then Content-Length descending; Array#sort is stable in Node. */
function sortCandidates(candidates) {
  return candidates.sort(
    (a, b) => Number(isPreferred(b)) - Number(isPreferred(a)) || sizeHintOf(b) - sizeHintOf(a),
  );
}

function pickDetailHeading(html) {
  const h2 = String(html || '').match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2) return stripTags(h2[1]);
  const title = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripTags(title[1]) : '';
}

function looksLikeChallenge(status, html) {
  if (status === 403 || status === 503) return true;
  const head = String(html || '').slice(0, 4000).toLowerCase();
  return head.includes('just a moment') || head.includes('cf-browser-verification') || head.includes('challenges.cloudflare.com');
}

function httpError(status, url, extra = {}) {
  return Object.assign(new Error(`HTTP_${status}`), { status, url, ...extra });
}

/**
 * @param {{ getFollow: Function, get?: Function }} http instance from src/net/http.mjs
 */
export function createSubtitlecatSource(http) {
  if (!http || typeof http.getFollow !== 'function') throw new TypeError('createSubtitlecatSource(http): http.getFollow is required');

  async function getPage(url, timeoutMs, what) {
    const res = await http.getFollow(url, { timeoutMs });
    if (res.status !== 200) {
      throw httpError(res.status, url, { stage: what });
    }
    if (looksLikeChallenge(res.status, res.text)) {
      throw Object.assign(new Error('CF_CHALLENGE'), { code: 'CF_CHALLENGE', url, stage: what });
    }
    return res;
  }

  function classifyRows(rows, keys) {
    return rows
      .map((row, order) => {
        const codeMatch = matchesCode(row.name, keys);
        const zhHint = /简体|中文|zh-CN/i.test(row.name);
        const twHint = /zh-TW|zhTW|繁體|繁体|台湾/i.test(row.name);
        // Prefer simplified hints, then plain code matches, then TW-derived titles last.
        let priority = 0;
        if (codeMatch) priority = zhHint ? 3 : twHint ? 1 : 2;
        return { ...row, order, codeMatch, zhHint, twHint, priority };
      })
      .filter((row) => row.priority > 0)
      .sort((a, b) => b.priority - a.priority || a.order - b.order);
  }

  /**
   * Probe the search results and collect zh-CN candidates.
   * @param {string} code
   * @param {{sizes?:boolean, stopAtFirst?:boolean, maxDetails?:number, limit?:number}} [opts]
   *   limit: 最多收集多少个候选（默认无限，受 MAX_CANDIDATES 约束）；越小探测越快
   * @returns {Promise<Array<{source:'subtitlecat', lang:'zh', name:string, srtName:string,
   *   url:string, detailUrl:string, sizeHint?:number}>>}
   */
  async function collect(code, opts = {}) {
    const { sizes = true, stopAtFirst = false, maxDetails = MAX_DETAIL_FETCHES, limit = Infinity } = opts;
    const cap = Math.max(1, Math.min(MAX_CANDIDATES, Number.isFinite(limit) ? limit : MAX_CANDIDATES));
    if (!code || typeof code !== 'string') throw new TypeError('listCandidates(code): non-empty string required');
    const keys = codeKeys(code);
    const searchUrl = `${BASE_URL}index.php?search=${encodeURIComponent(code)}`;
    const res = await getPage(searchUrl, SEARCH_TIMEOUT_MS, 'search');
    const rows = parseSearchRows(res.text);
    const probes = classifyRows(rows, keys).slice(0, maxDetails);
    if (!probes.length) return [];

    let lastError = null;
    let attempted = 0;
    let succeeded = 0;
    const seenUrls = new Set();
    const candidates = [];

    for (const row of probes) {
      const detailUrl = new URL(row.href, BASE_URL).href;
      attempted++;
      let detail;
      try {
        detail = await getPage(detailUrl, DETAIL_TIMEOUT_MS, 'detail');
      } catch (e) {
        lastError = e;
        continue;
      }
      succeeded++;
      const srtLinks = parseSrtLinks(detail.text, detailUrl);
      if (!srtLinks.length) continue;
      const zhLinks = srtLinks.filter(isSimplifiedSrt);
      if (!zhLinks.length) continue;

      const heading = pickDetailHeading(detail.text);
      // The whole detail page is either the requested movie or not. A zh-CN link on a
      // page that fails both the filename and the title guard belongs to another movie.
      const filenameHasCode = zhLinks.some((url) => matchesCode(srtFileNameFromUrl(url), keys));
      const titleHasCode = matchesCode(row.name, keys) && matchesCode(heading, keys);
      if (!filenameHasCode && !titleHasCode) continue;

      for (const url of zhLinks) {
        if(!matchesCode(srtFileNameFromUrl(url),keys))continue;
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        const srtName = srtFileNameFromUrl(url);
        candidates.push({
          source: 'subtitlecat',
          matcherVersion:2,
          lang: 'zh',
          name: row.name || srtName,
          srtName,
          url,
          detailUrl,
        });
      }

      if ((stopAtFirst && candidates.length) || candidates.length >= cap) break;
    }

    // Every detail request failed: surface the network error instead of claiming "no subtitle".
    if (attempted > 0 && succeeded === 0 && lastError && !candidates.length) throw lastError;
    if (!candidates.length) return [];

    sortCandidates(candidates);
    if (sizes) await attachSizes(candidates);
    // Sorting again: sizes may have arrived after the first (order-only) sort.
    return sortCandidates(candidates);
  }

  /**
   * Fill candidate.sizeHint from the HTTP Content-Length of a HEAD request.
   * Advisory only — a failed/blocked HEAD must never hurt candidate discovery.
   */
  async function attachSizes(candidates) {
    for (const candidate of candidates) {
      try {
        const res = await http.getFollow(candidate.url, {
          method: 'HEAD',
          timeoutMs: SIZE_TIMEOUT_MS,
          headers: { Referer: candidate.detailUrl || BASE_URL, Accept: '*/*' },
        });
        const length = Number(res?.headers?.['content-length']);
        if (res?.status === 200 && Number.isFinite(length) && length > 0) candidate.sizeHint = length;
      } catch {
        // No Content-Length available — keep site order inside the same priority bucket.
      }
    }
    return candidates;
  }

  return {
    name: 'subtitlecat',

    /**
     * Every Simplified Chinese subtitle version found for a code (never Traditional).
     * @param {string} code e.g. 'IPX-920'
     * @param {{limit?:number}} [opts] limit = 最多收集多少候选（越小越快）
     * @returns {Promise<Array<{source:'subtitlecat', lang:'zh', name:string, srtName:string,
     *   url:string, detailUrl:string, sizeHint?:number}>>}
     */
    async listCandidates(code, opts = {}) {
      return collect(code, { sizes: true, stopAtFirst: false, limit: opts.limit });
    },

    /** Legacy single-result shim (pipeline.mjs): the best candidate or null. */
    async find(code) {
      const candidates = await collect(code, { sizes: false, stopAtFirst: true });
      return candidates.length ? candidates[0] : null;
    },

    /**
     * Download a candidate subtitle (Referer is required by subtitlecat).
     * @param {{url:string, detailUrl?:string}} candidate
     * @returns {Promise<{buffer:Buffer, bytes:number, contentType:string|null}>}
     */
    async download(candidate) {
      if (!candidate || !candidate.url) throw new TypeError('download(candidate): candidate.url is required');
      const headers = {
        Referer: candidate.detailUrl || BASE_URL,
        Accept: '*/*',
      };
      const res = await http.getFollow(candidate.url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, headers });
      if (res.status !== 200) throw httpError(res.status, candidate.url, { stage: 'download' });
      const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
      const buffer = res.buffer || Buffer.alloc(0);
      if (contentType.includes('text/html')) {
        throw Object.assign(new Error('UNEXPECTED_HTML'), { code: 'UNEXPECTED_HTML', url: candidate.url, stage: 'download' });
      }
      if (!buffer.length) {
        throw Object.assign(new Error('EMPTY_DOWNLOAD'), { code: 'EMPTY_DOWNLOAD', url: candidate.url, stage: 'download' });
      }
      const head = buffer.subarray(0, 200).toString('latin1').trimStart().toLowerCase();
      if (head.startsWith('<!doctype') || head.startsWith('<html')) {
        throw Object.assign(new Error('UNEXPECTED_HTML'), { code: 'UNEXPECTED_HTML', url: candidate.url, stage: 'download' });
      }
      return { buffer, bytes: buffer.length, contentType: String(res.headers?.['content-type'] || '') || null };
    },
  };
}

export default createSubtitlecatSource;
import { fullCodeMatches } from '../core/code.mjs';
