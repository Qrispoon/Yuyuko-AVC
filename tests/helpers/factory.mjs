// Offline fixture factory for the v0.7 test infra (F20).
//
// The repository's `fixtures/` directory holds real third-party snapshots that are not
// shipped with the repo. This factory can generate equivalent fixtures into a temporary
// directory so the parser/subtitle tests run on a clean checkout too:
//
//   const FIX = await ensureFixtures();          // real fixtures/ if present, else generated
//   const FIX = await ensureFixtures(tempDir);   // always generate into `tempDir`
//
// `AVC_TEST_FIXTURES=generated` forces generation even when `fixtures/` exists (used to
// verify the generators themselves).
//
// The manko API wraps every payload in a 91-radix, bit-packed string. The site only ships a
// decoder (`decodeData` in src/sources/manko.mjs); `encodeData` below is its exact inverse
// and is validated against the real decoder in tests/v07-infra.test.mjs.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANKO_ALPHABET, decodeData } from '../../src/sources/manko.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const REAL_FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

// ---------------------------------------------------------------------------
// manko 91-radix encoder (inverse of decodeData)
// ---------------------------------------------------------------------------
//
// decodeData consumes two alphabet symbols at a time into an integer c = v1 + 91*v2
// (0..8280) and advances the output bit stream by 13 or 14 bits:
//   - c in [89, 8191]          -> 13 bits, value c
//   - c in [0, 88]             -> 14 bits, value c (7 payload bits + 7 zero bits)
//   - c in [8192, 8280]        -> 14 bits, value c
// Encoding therefore walks the byte stream with a tiny DFS: at every bit position either the
// 13-bit or the 14-bit interpretation must be valid. Some byte streams are not representable;
// callers get a clear error rather than silent corruption.
const LEGACY_ENC = new Map();

/** Deterministic symbol-pair encoding of the whole byte stream, or null when impossible. */
function encodeWithPairs(bytes) {
  const totalBits = bytes.length * 8;
  const bitAt = (pos) => (pos < totalBits ? (bytes[pos >> 3] >> (pos & 7)) & 1 : 0);
  const field = (pos, width) => {
    let value = 0;
    for (let i = 0; i < width; i++) value |= bitAt(pos + i) << i;
    return value;
  };
  const memo = new Map();
  const solve = (pos) => {
    if (pos >= totalBits) return pos - totalBits <= 7 ? [] : null;
    if (memo.has(pos)) return memo.get(pos);
    memo.set(pos, null);
    const as13 = field(pos, 13);
    const as14 = field(pos, 14);
    const options = [];
    if (as13 > 88) options.push([13, as13]);
    if (as14 <= 88 || (as14 >= 8192 && as14 <= 8280)) options.push([14, as14]);
    for (const [width, value] of options) {
      const rest = solve(pos + width);
      if (rest) {
        const result = [value, ...rest];
        memo.set(pos, result);
        return result;
      }
    }
    return null;
  };
  const chunks = solve(0);
  if (!chunks) return null;
  let out = '';
  for (const value of chunks) out += MANKO_ALPHABET[value % 91] + MANKO_ALPHABET[Math.floor(value / 91)];
  return out;
}

/**
 * Encoding with the decoder's tail rule: emit all but the last byte as symbol pairs, then use
 * the single trailing symbol the decoder flushes as one final byte.
 */
function encodeWithTail(bytes) {
  const total = bytes.length;
  if (total === 0) return '';
  const headBits = (total - 1) * 8;
  const totalBits = total * 8;
  const bitAt = (pos) => (pos < totalBits ? (bytes[pos >> 3] >> (pos & 7)) & 1 : 0);
  const field = (pos, width) => {
    let value = 0;
    for (let i = 0; i < width; i++) value |= bitAt(pos + i) << i;
    return value;
  };
  const chunks = [];
  let pos = 0;
  while (pos < headBits) {
    const as13 = field(pos, 13);
    const as14 = field(pos, 14);
    if (as13 > 88) { chunks.push(as13); pos += 13; continue; }
    if (as14 <= 88 || (as14 >= 8192 && as14 <= 8280)) { chunks.push(as14); pos += 14; continue; }
    return null;
  }
  const leftover = pos - headBits;
  if (leftover > 7) return null;
  let acc = 0;
  for (let i = 0; i < leftover; i++) acc |= bitAt(headBits + i) << i;
  const lastByte = bytes[total - 1];
  if ((lastByte & ((1 << leftover) - 1)) !== acc) return null;
  const need = (lastByte >> leftover) & 0x7f;
  if (need > 90) return null;
  let out = '';
  for (const value of chunks) out += MANKO_ALPHABET[value % 91] + MANKO_ALPHABET[Math.floor(value / 91)];
  return out + MANKO_ALPHABET[need];
}

/**
 * Inverse of `decodeData`.
 * @param {string} text UTF-8 text (typically JSON)
 * @returns {string} 91-radix encoded payload
 */
export function encodeData(text) {
  const source = String(text ?? '');
  const bytes = Buffer.from(source, 'utf8');
  for (const encode of [encodeWithTail, encodeWithPairs]) {
    const encoded = encode(bytes);
    if (encoded != null && decodeData(encoded) === source) return encoded;
  }
  throw new Error(`encodeData: ${bytes.length} byte(s) are not representable in the manko 91-radix codec`);
}

/** Encode a JSON payload; trailing whitespace is legal JSON and gives the codec room to fit. */
function encodeJsonPayload(value) {
  const base = JSON.stringify(value);
  for (let pad = 0; pad <= 512; pad++) {
    const text = pad === 0 ? base : `${base}${'\n'.repeat(pad)}`;
    try {
      const encoded = encodeData(text);
      return { text, data: encoded };
    } catch {
      // try one more byte of JSON-legal trailing whitespace
    }
  }
  throw new Error('encodeJsonPayload: payload is not representable even with trailing whitespace');
}

/** Envelope JSON string for a decoded manko payload. */
function mankoEnvelope(payload) {
  return JSON.stringify({ code: 200, message: 'ok', data: encodeJsonPayload(payload).data });
}

/** @param {object[]} records decoded search records */
export function makeMankoSearchJson(records) {
  return mankoEnvelope(Array.isArray(records) ? records : []);
}

/** @param {object} fields decoded detail object */
export function makeMankoDetailJson(fields = {}) {
  return mankoEnvelope({ video_duration: 120, rating: 'NA', ...fields });
}

/** @param {object[]} actors decoded actor list */
export function makeMankoActorsJson(actors = []) {
  return mankoEnvelope(Array.isArray(actors) ? actors : []);
}

/** @param {Array<{lang:string,url:string}>|object[]|object} links subtitle links (`[{KO:url}]`) */
export function makeMankoSubtitleJson(links = []) {
  // allow passing the whole decoded `{_id, subtitle_link}` object as well
  if (links && !Array.isArray(links) && typeof links === 'object' && ('subtitle_link' in links || '_id' in links)) {
    return mankoEnvelope(links);
  }
  const list = Array.isArray(links)
    ? links.map((link) => (Array.isArray(link) ? { [link[0]]: link[1] } : link))
    : Object.entries(links).map(([lang, url]) => ({ [lang]: url }));
  return mankoEnvelope({ subtitle_link: list });
}

// ---------------------------------------------------------------------------
// javbus
// ---------------------------------------------------------------------------

/** @param {string|string[]} codes */
export function makeJavbusSearchHtml(codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  const boxes = list.map((code) => `<a class="movie-box" href="https://www.javbus.com/${code}"><div class="photo-info">${code}</div></a>`).join('\n');
  return `<!doctype html><html><head><title>javbus search</title></head><body>\n${boxes}\n</body></html>`;
}

/**
 * @param {{code:string, title:string, date?:string, durationMin?:number, maker?:string,
 *          publisher?:string, series?:string, actress?:string[], genres?:string[],
 *          coverUrl?:string}} fields
 */
export function makeJavbusDetailHtml(fields = {}) {
  const {
    code = 'ABP-984',
    title = `${code} タイトル 主演女優`,
    date = '2020-06-12',
    durationMin = 120,
    maker = 'メーカー',
    publisher = 'レーベル',
    series = 'シリーズ',
    actress = [],
    genres = [],
    coverUrl = '/pics/cover/default_b.jpg',
  } = fields;
  const info = [
    `<p><span class="header">識別碼:</span> ${code}</p>`,
    `<p><span class="header">發行日期:</span> ${date}</p>`,
    `<p><span class="header">長度:</span> ${durationMin}分鐘</p>`,
    '<p><span class="header">導演:</span> ----</p>',
    `<p><span class="header">製作商:</span> ${maker}</p>`,
    `<p><span class="header">發行商:</span> ${publisher}</p>`,
    `<p><span class="header">系列:</span> ${series}</p>`,
  ].join('\n');
  const stars = actress.map((name) => `<div class="star-name"><a href="/star/xxx" title="${name}">${name}</a></div>`).join('\n');
  // span.genre blocks also contain /star/ links on the real site; those must never become genres
  const genreLinks = genres.map((name) => `<a href="/genre/${encodeURIComponent(name)}">${name}</a>`).join(' ');
  const starInGenre = actress.length ? `<a href="/star/yyy">${actress[0]}</a>` : '';
  return `<!doctype html><html><head><title>${title}</title></head><body>
<nav class="container"><h3>${title}</h3>
<div class="info">${info}</div>
<a class="bigImage" href="${coverUrl}"><img src="${coverUrl}" alt="cover"></a>
<div class="star-box">${stars}</div>
<span class="genre">${genreLinks} ${starInGenre}</span>
</body></html>`;
}

// ---------------------------------------------------------------------------
// subtitlecat
// ---------------------------------------------------------------------------

/**
 * @param {Array<{href:string,name:string}|[string,string]>} rows search result rows
 */
export function makeSubtitlecatSearchHtml(rows = []) {
  const anchors = rows.map((row) => {
    const [href, name] = Array.isArray(row) ? row : [row.href, row.name];
    return `<a href="${href}">${name}</a>`;
  }).join('\n');
  return `<!doctype html><html><head><title>subtitlecat search</title></head><body>\n${anchors}\n</body></html>`;
}

/**
 * @param {{title?:string, hrefs?:string[], links?:Array<string|{href:string}>}} fields
 */
export function makeSubtitlecatDetailHtml(fields = {}) {
  const title = fields.title || 'subtitlecat';
  const hrefs = fields.hrefs || fields.links || [];
  const anchors = hrefs.map((link) => {
    const href = typeof link === 'string' ? link : link.href;
    return `<a href="${href}" class="green-link">Download</a>`;
  }).join('\n');
  return `<!doctype html><html><head><title>${title} subtitles</title></head><body>
<h2>All language subtitles for ${title}</h2>
${anchors}
</body></html>`;
}

// ---------------------------------------------------------------------------
// r18.dev (F15)
// ---------------------------------------------------------------------------

/**
 * Canonical r18.dev detail JSON (the defensive parser accepts a lot of aliases; this is the
 * shape the live site returns).
 * @param {object} fields
 * @returns {string} JSON text
 */
export function makeR18Json(fields = {}) {
  const {
    contentId = 'ipx00920',
    code = 'IPX-920',
    title = '美人家庭教師つむぎ先生の接吻レクチャー',
    releaseDate = '2022-08-05',
    durationMin = 120,
    maker = 'IDEA POCKET',
    label = 'IDEA POCKET',
    series = '',
    genres = ['単体作品'],
    actress = ['明里つむぎ'],
    coverUrl = 'https://pics.dmm.co.jp/mono/movie/adult/ipx00920/ipx00920pl.jpg',
  } = fields;
  return JSON.stringify({
    content_id: contentId,
    dvd_id: code,
    title,
    release_date: releaseDate,
    runtime_minutes: durationMin,
    maker_name: maker,
    label_name: label,
    series_name: series,
    genres: genres.map((name) => (typeof name === 'string' ? { name } : name)),
    actresses: actress.map((name) => (typeof name === 'string' ? { name } : name)),
    images: { jacket_image: { large_url: coverUrl } },
  });
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(totalMs / 3600000))}:${pad(Math.floor((totalMs % 3600000) / 60000))}:${pad(Math.floor((totalMs % 60000) / 1000))},${pad(totalMs % 1000, 3)}`;
}

/**
 * Build an SRT document.
 * @param {Array<{start:number, end:number, text:string}>} cues start/end in seconds
 * @returns {string}
 */
export function makeSrt(cues = []) {
  return cues
    .map((cue, index) => `${index + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${cue.text ?? ''}\n`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// legacy-encoding helpers (GB18030 / BIG5) for the encoding-detection tests
// ---------------------------------------------------------------------------
const LEGACY_RANGES = {
  gb18030: { leads: [0x81, 0xfe], trails: [[0x40, 0x7e], [0x80, 0xfe]] },
  big5: { leads: [0xa1, 0xf9], trails: [[0x40, 0x7e], [0xa1, 0xfe]] },
};

/** Lazily build a char -> bytes reverse map using Node's ICU TextDecoder. */
function legacyMap(encoding) {
  if (LEGACY_ENC.has(encoding)) return LEGACY_ENC.get(encoding);
  const spec = LEGACY_RANGES[encoding];
  if (!spec) throw new Error(`unsupported legacy encoding: ${encoding}`);
  const decoder = new TextDecoder(encoding);
  const map = new Map();
  for (let lead = spec.leads[0]; lead <= spec.leads[1]; lead++) {
    for (const [lo, hi] of spec.trails) {
      for (let trail = lo; trail <= hi; trail++) {
        const decoded = decoder.decode(Buffer.from([lead, trail]));
        if (decoded.length !== 1 || decoded === '\uFFFD') continue;
        if (!map.has(decoded)) map.set(decoded, [lead, trail]);
      }
    }
  }
  LEGACY_ENC.set(encoding, map);
  return map;
}

/** Encode text with GB18030 / BIG5 (best effort for the characters used by the fixtures). */
export function encodeLegacy(text, encoding = 'gb18030') {
  const map = legacyMap(encoding);
  const bytes = [];
  for (const char of String(text ?? '')) {
    const codePoint = char.codePointAt(0);
    if (codePoint < 0x80) { bytes.push(codePoint); continue; }
    const pair = map.get(char);
    if (!pair) throw new Error(`encodeLegacy(${encoding}): cannot encode ${JSON.stringify(char)}`);
    bytes.push(...pair);
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// fixture set used by the existing test suite
// ---------------------------------------------------------------------------
const IPX920_ID = '62eceeb22700df5342b529bf';
const IPX451_ID = '6158b0e224ddbb03ea1eed7d';

const SEARCH_920 = [{
  _id: IPX920_ID,
  title: 'IPX-920',
  share_date: '2022-08-05',
  maker: 'IDEA POCKET',
  rating: '4.51',
  imdb_score: '4.51',
  can_play: true,
  title_display_name: [{ language: 'en', title: 'IPX-920' }],
  thumbnail_image: `https://image.healertanker.com/${IPX920_ID}/thumbs/zx/ZXXMqq.jpg`,
  wide_thumbnail: `https://image.healertanker.com/${IPX920_ID}/cover.webp`,
  subtitle_link: [{ KO: 'IPX-920-ko.srt' }, { ZH: 'IPX-920-zh.srt' }, { EN: 'IPX-920-en.srt' }],
}];

const DETAIL_920 = {
  _id: IPX920_ID,
  video_duration: 120,
  rating: 'NA',
  share_date: '2022-08-05',
  country: 'IDEA POCKET',
  cover_image: `https://image.healertanker.com/${IPX920_ID}/cover.webp`,
  discription: [
    { language: 'ja', overview: '美人家庭教師つむぎ先生の接吻レクチャー個人レッスン 明里つむぎ 生写真3枚付き' },
    { language: 'en', overview: "Beautiful Tutor Tsumugi Sensei's Kiss Lecture Personal Lesson" },
    { language: 'zh', overview: '美丽的家庭教师 Tsumugi Sensei 的亲吻讲座私人课程 附 3 张原始照片' },
  ],
  title_display_name: [{ language: 'en', title: 'IPX-920' }, { language: 'ja', title: 'IPX-920' }],
};

const ACTORS_920 = [
  {
    _id: '333639313937383430303030',
    order: 114,
    person_id: 'M4Q7',
    name: '明裏紬',
    also_known_as: { jp: '明里つむぎ', en: 'Tsumugi Akari', kr: '아카리 츠무기', tw: '明里䌷', zh: '明里䌷' },
  },
  {
    _id: '383833373938313030303030',
    order: 99999,
    person_id: 'OJ2k',
    name: 'Qべぇ',
    also_known_as: { jp: 'Qべぇ', en: 'Qbe' },
  },
];

const SUBS_920 = {
  _id: IPX920_ID,
  subtitle_link: [
    { KO: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX920_ID}/IPX-920-ko.srt` },
    { ZH: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX920_ID}/IPX-920-zh.srt` },
    { EN: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX920_ID}/IPX-920-en.srt` },
  ],
};

const SEARCH_451 = [
  {
    _id: IPX451_ID,
    title: 'IPX-451',
    share_date: '2020-03-13',
    maker: 'IDEA POCKET',
    rating: '4.61',
    imdb_score: '4.61',
    can_play: true,
    title_display_name: [{ language: 'en', title: 'IPX-451' }],
    thumbnail_image: `https://image.healertanker.com/${IPX451_ID}/thumbs/gn/Gn1nJ.jpg`,
    wide_thumbnail: `https://image.healertanker.com/${IPX451_ID}/cover.webp`,
    subtitle_link: [{ KO: 'IPX-451.srt' }, { ZH: 'IPX-451-zh.srt' }, { EN: 'IPX-451-en.srt' }, { TW: 'IPX-451-tw.srt' }],
  },
  {
    _id: '671b3e72cf949a5ead4223e0',
    title: 'IPX-451',
    share_date: '2020-03-13',
    maker: 'IDEA POCKET',
    rating: '4.61',
    imdb_score: '4.61',
    can_play: true,
    title_display_name: [{ language: 'en', title: 'IPX-451' }],
    wide_thumbnail: `https://image.healertanker.com/${IPX451_ID}/cover.webp`,
    subtitle_link: [],
  },
];

const DETAIL_451 = {
  _id: IPX451_ID,
  video_duration: 166,
  rating: 'NA',
  share_date: '2020-03-13',
  country: 'IDEA POCKET',
  cover_image: `https://image.healertanker.com/${IPX451_ID}/cover.webp`,
  discription: [
    { language: 'ja', overview: '凌●解禁！！―犯●れた美し過ぎる女教師― 楓カレン' },
    { language: 'zh', overview: '凌解除！ ！ -被强暴的太美女教师- 枫花莲' },
  ],
  title_display_name: [{ language: 'en', title: 'IPX-451' }],
};

const ACTORS_451 = [
  { _id: '313836373431333730303030', order: 99999, person_id: '2aVnB', name: '細田あつし', also_known_as: { jp: '細田あつし' } },
  { _id: '373834313838373130303030', order: 1, person_id: 'kzx6', name: '楓カレン', also_known_as: { jp: '楓カレン', en: 'Karen Kaede', tw: '田中レモン' } },
  { _id: '363933333136313330303030', order: 99999, person_id: 'xvDYV', name: '武田大樹', also_known_as: { jp: '武田大樹' } },
];

const SUBS_451 = {
  _id: IPX451_ID,
  subtitle_link: [
    { KO: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX451_ID}/IPX-451.srt` },
    { ZH: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX451_ID}/IPX-451-zh.srt` },
    { EN: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX451_ID}/IPX-451-en.srt` },
    { TW: `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX451_ID}/IPX-451-tw.srt` },
  ],
};

/** 60-cue Simplified Chinese SRT (no Traditional characters, ordered timings). */
function makeZhCnSrt() {
  return makeSrt(Array.from({ length: 60 }, (_, i) => ({
    start: i * 4,
    end: i * 4 + 3,
    text: '本片由字幕组提供',
  })));
}

/** 60-cue Traditional Chinese SRT (contains 性慾, no Simplified characters). */
function makeZhTwSrt() {
  return makeSrt(Array.from({ length: 60 }, (_, i) => ({
    start: i * 4,
    end: i * 4 + 3,
    text: '性慾與字幕組製作',
  })));
}

/** The manko ZH subtitle used by sources.test; the live file is exactly 33695 bytes. */
function makeMankoSubtitleSrt(size = 33695) {
  const head = '1\n00:00:00,000 --> 00:00:05,000\n本片由 字幕组 制作\n';
  const base = `${head}\n2\n00:00:06,000 --> 00:00:07,000\n`;
  const tail = '\n';
  const remaining = size - Buffer.byteLength(base) - Buffer.byteLength(tail);
  if (remaining < 0) throw new Error('makeMankoSubtitleSrt: requested size too small');
  const cjk = Math.floor(remaining / 3);
  const ascii = remaining - cjk * 3;
  return `${base}${'字'.repeat(cjk)}${'x'.repeat(ascii)}${tail}`;
}

const JAVBUS_ABP984_DETAIL = {
  code: 'ABP-984',
  title: 'ABP-984 中出し 射精執行官 05 涼森れむ',
  date: '2020-06-12',
  durationMin: 169,
  maker: 'プレステージ',
  publisher: 'ABSOLUTELY PERFECT',
  series: '強●中出し 射精執行官',
  actress: ['涼森れむ'],
  genres: ['中出', '女上位', '高畫質', '單體作品'],
  coverUrl: '/pics/cover/7prq_b.jpg',
};

const SEARCH_ROWS_ABP984 = [
  ['subs/1752/ABP-984%20Grok%E7%BF%BB%E8%AF%91%E4%BA%BA%E5%B7%A5%E6%A0%A1%E5%AF%B9zh-CN.html', 'ABP-984 Grok翻译人工校对zh-CN'],
  ['subs/1753/ABP-984%20%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87.html', 'ABP-984 简体中文'],
  ['subs/1754/ABP-984%201080p.html', 'ABP-984 1080p'],
  ['subs/1755/ABP-984.html', 'ABP-984'],
  ['subs/1756/ABP-984%20HD.html', 'ABP-984 HD'],
  ['subs/1757/ABP-984%20FHD.html', 'ABP-984 FHD'],
  ['subs/1758/ABP-984%20part1.html', 'ABP-984 part1'],
  ['subs/1759/ABP-984%20part2.html', 'ABP-984 part2'],
  ['subs/1760/ABP-984%20uncensored.html', 'ABP-984 uncensored'],
  ['subs/1761/ABP-984%20leak.html', 'ABP-984 leak'],
  ['subs/1762/ABP-984%20sample.html', 'ABP-984 sample'],
];

const DETAIL_IPX920_HREFS = [
  '/subs/822/IPX-920.zh.LLW-zh-CN.srt',
  '/subs/472/IPX-920.zh.LLW-zh-TW.srt',
  '/subs/823/IPX-920.zh.LLW-en.srt',
  '/subs/824/IPX-920.zh.LLW-ja.srt',
  '/subs/825/IPX-920.zh.LLW-ko.srt',
  '/subs/826/IPX-920.zh.LLW-zh.srt',
  '/subs/827/IPX-920.zh.LLW-th.srt',
  '/subs/828/IPX-920.zh.LLW-vi.srt',
  '/subs/829/IPX-920.zh.LLW-de.srt',
  '/subs/830/IPX-920.zh.LLW-fr.srt',
  '/subs/831/IPX-920.zh.LLW-es.srt',
  '/subs/832/IPX-920.zh.LLW-pt.srt',
  '/subs/833/IPX-920.zh.LLW-id.srt',
];

const SEARCH_ROWS_IPX920 = [
  ['subs/472/IPX-920.zh.LLW.html', 'IPX-920.zh.LLW'],
  ['subs/396/IPX-920%20TDS.html', 'IPX-920 TDS'],
  ['subs/396/IPX-920.html', 'IPX-920'],
];

const SEARCH_ROWS_SSIS001 = [
  ['subs/266/SSIS-001%20T.html', 'SSIS-001 T'],
  ['subs/1707/SSIS-001-zhTW.html', 'SSIS-001-zhTW'],
];

/** Write the generated fixture set below `dir`. */
async function generateInto(dir) {
  const javbus = path.join(dir, 'javbus');
  const manko = path.join(dir, 'manko');
  const subtitlecat = path.join(dir, 'subtitlecat');
  await fs.mkdir(javbus, { recursive: true });
  await fs.mkdir(manko, { recursive: true });
  await fs.mkdir(subtitlecat, { recursive: true });

  const write = (file, content) => fs.writeFile(file, content, typeof content === 'string' ? 'utf8' : undefined);
  const writeJson = (file, value) => write(file, JSON.stringify(value, null, 2));
  const writeApi = (file, json) => write(file, json);

  // javbus
  await write(path.join(javbus, 'search-ABP-984.html'), makeJavbusSearchHtml(['ABP-984']));
  await write(path.join(javbus, 'detail-ABP-984.html'), makeJavbusDetailHtml(JAVBUS_ABP984_DETAIL));

  // manko: raw snapshots + the encoded API envelopes that decode back to them
  const snapshot = async (name, value) => {
    await writeJson(path.join(manko, `${name}.json`), value);
  };
  const envelope = async (endpoint, code, json) => {
    await writeApi(path.join(manko, `api-${endpoint}-${code}.json`), json);
  };
  for (const [code, search, detail, actors, subs] of [
    ['IPX-920', SEARCH_920, DETAIL_920, ACTORS_920, SUBS_920],
    ['IPX-451', SEARCH_451, DETAIL_451, ACTORS_451, SUBS_451],
  ]) {
    await snapshot(`search-${code}`, search);
    await envelope('search', code, makeMankoSearchJson(search));
    await snapshot(`detail-${code}`, detail);
    await envelope('detail', code, makeMankoDetailJson(detail));
    await snapshot(`actors-${code}`, actors);
    await envelope('actors', code, makeMankoActorsJson(actors));
    await snapshot(`subtitle-${code}`, subs);
    await envelope('subtitle', code, makeMankoSubtitleJson(subs));
  }
  await write(path.join(manko, 'subtitle-zh-IPX-920.srt'), makeMankoSubtitleSrt(33695));

  // subtitlecat
  const scSearch = (file, rows) => write(path.join(subtitlecat, file), makeSubtitlecatSearchHtml(rows));
  await scSearch('search-ABP-984.html', SEARCH_ROWS_ABP984);
  await scSearch('search-IPX-920.html', SEARCH_ROWS_IPX920);
  await scSearch('search-SSIS-001.html', SEARCH_ROWS_SSIS001);
  await scSearch('search-empty.html', []);
  await write(path.join(subtitlecat, 'detail-IPX-920.html'), makeSubtitlecatDetailHtml({ title: 'IPX-920.zh.LLW', hrefs: DETAIL_IPX920_HREFS }));
  await write(path.join(subtitlecat, 'detail-ABP-984.html'), makeSubtitlecatDetailHtml({
    title: 'ABP-984',
    hrefs: ['/subs/1752/ABP-984-zh-CN.srt', '/subs/1753/ABP-984-zh-TW.srt', '/subs/1754/ABP-984-en.srt'],
  }));

  // SRT fixtures (encoding-detection cases are generated with real GB18030/BIG5 bytes)
  const zhCn = makeZhCnSrt();
  const zhTw = makeZhTwSrt();
  await write(path.join(subtitlecat, 'zh-CN.srt'), zhCn);
  await write(path.join(subtitlecat, 'zh-TW.srt'), zhTw);
  await write(path.join(subtitlecat, 'zh-CN-bom.srt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(zhCn, 'utf8')]));
  await write(path.join(subtitlecat, 'zh-CN.gb18030.srt'), encodeLegacy(zhCn, 'gb18030'));
  await write(path.join(subtitlecat, 'zh-TW.big5.srt'), encodeLegacy(zhTw, 'big5'));

  return dir;
}

const tempDirs = [];
process.once('exit', () => {
  for (const dir of tempDirs) {
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** True when a directory contains a usable javbus/manko/subtitlecat snapshot set. */
function hasRealFixtures(dir) {
  return fsSync.existsSync(path.join(dir, 'javbus', 'detail-ABP-984.html'))
    && fsSync.existsSync(path.join(dir, 'manko', 'search-IPX-920.json'))
    && fsSync.existsSync(path.join(dir, 'subtitlecat', 'zh-CN.srt'));
}

/**
 * Return a fixture directory that the parser tests can rely on.
 *
 * - `ensureFixtures(dir)` generates into `dir` (created if needed).
 * - `ensureFixtures()` returns the repository's real `fixtures/` when available, otherwise
 *   generates an equivalent set into an OS temp directory (cleaned up on process exit).
 *   `AVC_TEST_FIXTURES=generated` forces generation.
 *
 * @param {string} [dir]
 * @returns {Promise<string>} absolute fixture directory
 */
export async function ensureFixtures(dir) {
  if (dir) {
    await fs.mkdir(dir, { recursive: true });
    await generateInto(path.resolve(dir));
    return path.resolve(dir);
  }
  if (process.env.AVC_TEST_FIXTURES !== 'generated' && hasRealFixtures(REAL_FIXTURES_DIR)) {
    return REAL_FIXTURES_DIR;
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-fixtures-'));
  tempDirs.push(temp);
  await generateInto(temp);
  return temp;
}

export default {
  encodeData, decodeData,
  makeJavbusSearchHtml, makeJavbusDetailHtml,
  makeMankoSearchJson, makeMankoDetailJson, makeMankoActorsJson, makeMankoSubtitleJson,
  makeSubtitlecatSearchHtml, makeSubtitlecatDetailHtml,
  makeR18Json, makeSrt, encodeLegacy, ensureFixtures,
};
