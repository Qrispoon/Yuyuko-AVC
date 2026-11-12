// Offline tests for the v0.7 metadata/subtitle sources (F15/F16/F17):
//   - src/sources/r18.mjs         defensive JSON parsing + contentId fallback chain
//   - src/pipeline.mjs            resolveMeta order (javbus -> r18 -> manko) + extraLangs
//   - src/sources/lookup.mjs      keyword lookup: javbus 优先 / manko 回退映射
//   - src/subs/source-manko.mjs   findLang() language mapping
//   - src/subs/install.mjs        `<stem>.<lang>.srt` install + UTF-8/LF normalisation
//
// r18.dev is NOT reachable from this machine: every network call goes through an injected
// fake http stub returning fixed JSON. No network, no fixtures, temp directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createR18, contentIdsFor, endpointFor, parseR18Record, R18_BASE } from '../src/sources/r18.mjs';
import { createLookup, mapLookupRecord } from '../src/sources/lookup.mjs';
import { createMankoSubSource, MANKO_EXTRA_LANG_KEYS } from '../src/subs/source-manko.mjs';
import {
  installSubtitle,
  installSubtitleAs,
  sanitizeSubtitleLang,
  subtitlePathFor,
  subtitlePathForLang,
} from '../src/subs/install.mjs';
import { configSignature, createContext, processFile } from '../src/pipeline.mjs';
import { parseSrt } from '../src/subs/verify.mjs';
import { undoJournal } from '../src/core/rename.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-v07-sources-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

async function exists(file) {
  return fs.stat(file).then(() => true).catch(() => false);
}

/** Fake http transport: `routes` is a function (url, opts) -> {json|text|status|throw}. */
function makeHttp(routes) {
  const calls = [];
  return {
    calls,
    async getFollow(url, opts = {}) {
      calls.push({ url, opts });
      const entry = typeof routes === 'function' ? routes(url, opts) : routes[url];
      if (!entry) return { status: 404, text: '', buffer: Buffer.alloc(0), url, headers: {} };
      if (entry.throw) throw entry.throw;
      const text = entry.text ?? (entry.json === undefined ? '' : JSON.stringify(entry.json));
      return {
        status: entry.status ?? 200,
        text,
        buffer: Buffer.from(text, 'utf8'),
        url: entry.url || url,
        headers: entry.headers || {},
      };
    },
  };
}

/** Minimal in-memory state used by processFile (no sqlite needed). */
function fakeState() {
  const files = new Map();
  const codes = new Map();
  const subs = [];
  return {
    files,
    codes,
    subs,
    getFile: (file) => files.get(file) || null,
    getCode: (code) => codes.get(code) || null,
    putCode: (code, data) => codes.set(code, data),
    putSubtitle: (row) => subs.push(row),
    upsertFile: (file, patch) => files.set(file, { path: file, ...patch }),
  };
}

function testConfig(extra = {}) {
  return {
    rename: { template: '{code} {title} [{actress}]', maxLength: 170 },
    subs: { sources: ['manko'], maxDurationDeltaMin: 5 },
    covers: {},
    media: { probeDuration: 'off' },
    ...extra,
  };
}

const R18_META = {
  code: 'IPX-920',
  titleJa: 'r18 タイトル',
  titleZh: null,
  releaseDate: '2020-08-14',
  durationMin: 120,
  maker: 'メーカー',
  publisher: 'レーベル',
  series: null,
  genres: ['ドラマ'],
  actress: ['女優A'],
  coverUrl: '',
  url: 'https://r18.dev/videos/vod/movies/detail/-/id=ipx00920/json',
  source: 'r18',
};

/** Context for resolveMeta tests: every network source is a stub. */
function metaCtx({ config = testConfig(), javbus, manko, r18 } = {}) {
  const state = fakeState();
  const logs = [];
  const calls = { javbus: 0, manko: 0, r18: 0 };
  const ctx = {
    config,
    state,
    logger: (line) => logs.push(line),
    http: { stats: {} },
    subs: [],
    javbus: javbus || { async search() { return null; } },
    manko: manko || { async findByCode() { return null; } },
    r18: r18 || { async findByCode() { return null; } },
  };
  return { ctx, state, logs, calls };
}

const SRT_6S = ['1', '00:00:01,000 --> 00:00:06,000', '这个时间说话', ''].join('\n');
const SRT_2H = ['1', '00:00:01,000 --> 02:00:00,000', 'english line', ''].join('\n');

// ---------------------------------------------------------------------------
// F15: r18.dev content ids / endpoints
// ---------------------------------------------------------------------------

test('r18: contentId candidates follow the SPEC order (padded, raw, hyphenated)', () => {
  assert.deepEqual(contentIdsFor('IPX-920'), ['ipx00920', 'ipx920', 'ipx-920']);
  assert.deepEqual(contentIdsFor('SSIS-001'), ['ssis00001', 'ssis001', 'ssis-001']);
  assert.deepEqual(contentIdsFor('ipx 920'), ['ipx00920', 'ipx920', 'ipx-920']);
  assert.deepEqual(contentIdsFor('ipx_920'), ['ipx00920', 'ipx920', 'ipx-920']);
  assert.deepEqual(contentIdsFor('not a code'), []);
  assert.equal(endpointFor('IPX-920'), `${R18_BASE}/videos/vod/movies/detail/-/id=ipx00920/json`);
  assert.equal(endpointFor('nope'), null);
});

// ---------------------------------------------------------------------------
// F15: defensive parsing
// ---------------------------------------------------------------------------

test('r18: parses the canonical r18.dev JSON shape', async () => {
  const json = {
    dvd_id: 'IPX-920',
    content_id: 'ipx00920',
    title: 'タイトル',
    release_date: '2020-08-14',
    runtime_minutes: 120,
    maker_name: 'メーカー',
    label_name: 'レーベル',
    series_name: 'シリーズ',
    genres: [{ name: 'ドラマ' }, { name: '単体作品' }, { name: 'ドラマ' }],
    actresses: [{ name: '女優A' }, { name: '女優B' }, { name: '女優A' }],
    images: {
      jacket_image: { large_url: 'https://pics.r18.dev/jacket.jpg', url: 'https://pics.r18.dev/jacket-s.jpg' },
      thumb_image: { large_url: 'https://pics.r18.dev/thumb.jpg' },
    },
  };
  const http = makeHttp(() => ({ json }));
  const r18 = createR18(http);
  assert.equal(r18.name, 'r18');

  const rec = await r18.findByCode('IPX-920');
  assert.equal(rec.code, 'IPX-920');
  assert.equal(rec.titleJa, 'タイトル');
  assert.equal(rec.titleZh, null);
  assert.equal(rec.releaseDate, '2020-08-14');
  assert.equal(rec.durationMin, 120);
  assert.equal(rec.maker, 'メーカー');
  assert.equal(rec.publisher, 'レーベル');
  assert.equal(rec.series, 'シリーズ');
  assert.deepEqual(rec.genres, ['ドラマ', '単体作品']);
  assert.deepEqual(rec.actress, ['女優A', '女優B']);
  assert.equal(rec.coverUrl, 'https://pics.r18.dev/jacket.jpg');
  assert.equal(rec.source, 'r18');
  assert.match(rec.url, /\/id=ipx00920\/json$/);
  assert.equal(http.calls.length, 1);
});

test('r18: tolerates alternate field names, string arrays and a {data} wrapper', async () => {
  const json = {
    contentId: 'ipx00920',
    title_en: 'English title',
    releaseDate: '2020/8/9',
    runtime: '125',
    maker: 'MakerX',
    publisher: 'LabelY',
    series: 'SeriesZ',
    genres: ['Drama', { name: 'Romance' }, 'Drama'],
    actresses: ['A', { name: 'B' }, 'A'],
    cover_url: 'https://img.test/r18-cover.jpg',
  };
  const rec = await createR18(makeHttp(() => ({ json }))).findByCode('IPX-920');
  assert.equal(rec.code, 'IPX-920', 'contentId is converted back to LABEL-NUM');
  assert.equal(rec.titleJa, 'English title');
  assert.equal(rec.releaseDate, '2020-08-09');
  assert.equal(rec.durationMin, 125);
  assert.equal(rec.maker, 'MakerX');
  assert.equal(rec.publisher, 'LabelY');
  assert.equal(rec.series, 'SeriesZ');
  assert.deepEqual(rec.genres, ['Drama', 'Romance']);
  assert.deepEqual(rec.actress, ['A', 'B']);
  assert.equal(rec.coverUrl, 'https://img.test/r18-cover.jpg');

  const wrapped = await createR18(makeHttp(() => ({ json: { data: { dvd_id: 'ABP-984', title: 'wrapped title' } } })))
    .findByCode('ABP-984');
  assert.equal(wrapped.code, 'ABP-984');
  assert.equal(wrapped.titleJa, 'wrapped title');

  // thumb fallback when jacket_image is absent
  const thumbOnly = await createR18(makeHttp(() => ({
    json: { dvd_id: 'MIDE-001', title: 't', images: { thumb_image: { large_url: 'https://img.test/thumb.jpg' } } },
  }))).findByCode('MIDE-001');
  assert.equal(thumbOnly.coverUrl, 'https://img.test/thumb.jpg');
  assert.equal(thumbOnly.publisher, null);
  assert.equal(thumbOnly.series, null);
  assert.equal(thumbOnly.durationMin, null);
});

test('r18: 404 falls through the contentId candidates; all 404 -> null', async () => {
  const http = makeHttp((url) => (url.includes('/id=ipx920/')
    ? { json: { content_id: 'ipx920', title: 'second candidate' } }
    : undefined));
  const rec = await createR18(http).findByCode('IPX-920');
  assert.equal(rec.code, 'IPX-920');
  assert.equal(rec.titleJa, 'second candidate');
  assert.equal(http.calls.length, 2);
  assert.match(http.calls[0].url, /\/id=ipx00920\/json$/);
  assert.match(http.calls[1].url, /\/id=ipx920\/json$/);

  const allMiss = makeHttp(() => undefined);
  assert.equal(await createR18(allMiss).findByCode('IPX-920'), null);
  assert.equal(allMiss.calls.length, 3, 'all three candidates are tried once');
});

test('r18: non-JSON body / missing identity fields -> null (never throws)', async () => {
  assert.equal(await createR18(makeHttp(() => ({ status: 200, text: '<html>challenge</html>' }))).findByCode('IPX-920'), null);
  assert.equal(await createR18(makeHttp(() => ({ status: 200, text: '   ' }))).findByCode('IPX-920'), null);
  assert.equal(await createR18(makeHttp(() => ({ json: {} }))).findByCode('IPX-920'), null);
  assert.equal(await createR18(makeHttp(() => ({ json: { runtime_minutes: 100 } }))).findByCode('IPX-920'), null);
  assert.equal(await createR18(makeHttp(() => ({ json: [1, 2, 3] }))).findByCode('IPX-920'), null);
  assert.equal(await createR18(makeHttp(() => ({ json: {} }))).findByCode('not a code'), null, 'invalid code -> null without HTTP');
  assert.equal(await createR18(makeHttp(() => ({ json: {} }))).findByCode(''), null);
});

test('r18: transport failure -> R18_HTTP, malformed JSON -> R18_PARSE, HTTP error status -> R18_HTTP', async () => {
  await assert.rejects(
    () => createR18(makeHttp(() => ({ throw: Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) }))).findByCode('IPX-920'),
    (err) => err.code === 'R18_HTTP',
  );
  await assert.rejects(
    () => createR18(makeHttp(() => ({ status: 500, text: 'oops' }))).findByCode('IPX-920'),
    (err) => err.code === 'R18_HTTP' && err.status === 500,
  );
  await assert.rejects(
    () => createR18(makeHttp(() => ({ status: 200, text: '{"dvd_id":"IPX-920",' }))).findByCode('IPX-920'),
    (err) => err.code === 'R18_PARSE',
  );
});

test('r18: parseR18Record is exported and returns null for non-objects', () => {
  assert.equal(parseR18Record(null), null);
  assert.equal(parseR18Record('x'), null);
  assert.equal(parseR18Record([]), null);
  assert.equal(parseR18Record({}), null);
  const rec = parseR18Record({ dvd_id: 'ABP-984', title: 't', runtime_minutes: '169' });
  assert.equal(rec.durationMin, 169);
  assert.equal(rec.source, 'r18');
});

// ---------------------------------------------------------------------------
// F15: resolveMeta order — javbus -> r18 -> manko
// ---------------------------------------------------------------------------

test('pipeline: resolveMeta falls back to r18 between javbus and manko', async (t) => {
  const dir = await tempDir(t);
  const { ctx, state, calls } = metaCtx({
    r18: { async findByCode(code) { calls.r18++; return { ...R18_META, code }; } },
    manko: { async findByCode() { calls.manko++; return { code: 'IPX-920', titleJa: 'manko title', actress: [{ jp: 'X' }] }; } },
  });
  const file = { path: path.join(dir, 'IPX-920.mp4'), name: 'IPX-920.mp4', size: 1 };
  const result = await processFile(ctx, file, { persist: false, downloadSubs: false });

  assert.equal(result.status, 'ok');
  assert.equal(result.code, 'IPX-920');
  assert.equal(result.meta.titleJa, 'r18 タイトル');
  assert.equal(result.meta.maker, 'メーカー');
  assert.equal(result.meta.source, 'r18');
  assert.equal(calls.r18, 1);
  assert.equal(calls.manko, 0, 'r18 success short-circuits the manko fallback');
  assert.equal(state.codes.has('IPX-920'), true, 'r18 metadata is cached via state.putCode');
  assert.equal(state.codes.get('IPX-920').meta.titleJa, 'r18 タイトル');
});

test('pipeline: r18 result whose code does not match the request is rejected', async (t) => {
  const dir = await tempDir(t);
  const { ctx, state, calls } = metaCtx({
    r18: { async findByCode() { calls.r18++; return { ...R18_META, code: 'MIDE-991' }; } },
    manko: { async findByCode() { calls.manko++; return { code: 'IPX-920', titleJa: 'manko title', actress: [{ jp: '女優' }] }; } },
  });
  const file = { path: path.join(dir, 'IPX-920.mp4'), name: 'IPX-920.mp4', size: 1 };
  const result = await processFile(ctx, file, { persist: false, downloadSubs: false });

  assert.equal(result.status, 'ok');
  assert.equal(result.meta.titleJa, 'manko title', 'the mismatched r18 record is ignored');
  assert.equal(calls.r18, 1);
  assert.equal(calls.manko, 1);
  assert.equal(state.codes.has('MIDE-991'), false);
});

test('pipeline: metadata.r18=false disables the r18 attempt', async (t) => {
  const dir = await tempDir(t);
  const { ctx, calls } = metaCtx({
    config: testConfig({ metadata: { r18: false } }),
    r18: { async findByCode() { calls.r18++; return R18_META; } },
    manko: { async findByCode() { calls.manko++; return { code: 'IPX-920', titleJa: 'manko title' }; } },
  });
  const file = { path: path.join(dir, 'IPX-920.mp4'), name: 'IPX-920.mp4', size: 1 };
  const result = await processFile(ctx, file, { persist: false, downloadSubs: false });
  assert.equal(result.status, 'ok');
  assert.equal(result.meta.titleJa, 'manko title');
  assert.equal(calls.r18, 0);
  assert.equal(calls.manko, 1);
});

test('pipeline: r18 is not queried when javbus already resolved the code', async (t) => {
  const dir = await tempDir(t);
  const { ctx, calls } = metaCtx({
    javbus: {
      async search() { return 'https://javbus.test/IPX-920'; },
      async detail() {
        return { code: 'IPX-920', titleJa: 'javbus title', actress: ['女優'], durationMin: 120, coverUrl: '', genres: ['x'] };
      },
    },
    r18: { async findByCode() { calls.r18++; return R18_META; } },
  });
  const file = { path: path.join(dir, 'IPX-920.mp4'), name: 'IPX-920.mp4', size: 1 };
  const result = await processFile(ctx, file, { persist: false, downloadSubs: false });
  assert.equal(result.status, 'ok');
  assert.equal(result.meta.titleJa, 'javbus title');
  assert.equal(calls.r18, 0);
});

test('pipeline: createContext wires r18 and lookup clients', () => {
  const ctx = createContext({}, {});
  assert.equal(ctx.r18.name, 'r18');
  assert.equal(typeof ctx.r18.findByCode, 'function');
  assert.equal(typeof ctx.lookup.byKeyword, 'function');
});

// ---------------------------------------------------------------------------
// F16: lookup.byKeyword
// ---------------------------------------------------------------------------

/**
 * Fake http for lookup: javbus keyword search answers an empty result page (so the lookup
 * falls back to manko), and the manko search API returns `{data:[record…]}` envelopes.
 */
function lookupHttp(recordsByKeyword) {
  const calls = [];
  return {
    calls,
    async getFollow(url, opts = {}) {
      calls.push(url);
      if (String(url).includes('javbus.com/search/')) {
        const text = '<html><body><div id="waterfall"></div></body></html>';
        return { status: 200, text, buffer: Buffer.from(text, 'utf8'), url, headers: { 'content-type': 'text/html' } };
      }
      const keyword = new URL(url).searchParams.get('keyword') || '';
      const records = recordsByKeyword[keyword] || [];
      const text = JSON.stringify({ data: records });
      return { status: 200, text, buffer: Buffer.from(text, 'utf8'), url, headers: { 'content-type': 'application/json' } };
    },
  };
}

const LOOKUP_RECORDS = [
  {
    _id: 'id-920',
    title: 'IPX-920',
    title_display_name: [{ language: 'zh', title: 'IPX-920 中文标题' }],
    share_date: '2020-08-14',
    maker: 'MakerA',
    wide_thumbnail: 'https://img.test/920.jpg',
  },
  { _id: 'id-dup', title: 'IPX 920', share_date: '2023-01-01' },
  { _id: 'id-invalid', title: '不是番号的标题', share_date: '2023-01-01' },
  { _id: 'id-mide', title: 'MIDE-001', share_date: '2022-05-01', thumbnail_image: 'https://img.test/mide.jpg' },
  { _id: 'id-abp', title: 'ABP-984', share_date: '2018-02-02' },
  { _id: 'id-ssis', title: 'SSIS-001', share_date: null },
];

test('lookup: maps manko records, drops non-codes, dedupes by canonical code', async () => {
  const http = lookupHttp({ 'IPX-920': LOOKUP_RECORDS });
  const lookup = createLookup({ http, config: {} });
  const list = await lookup.byKeyword('IPX-920');

  assert.deepEqual(list.map((c) => c.code), ['IPX-920', 'MIDE-001', 'ABP-984', 'SSIS-001']);
  assert.deepEqual(list[0], {
    code: 'IPX-920',
    movieId: 'id-920',
    title: 'IPX-920 中文标题',
    releaseDate: '2020-08-14',
    maker: 'MakerA',
    coverUrl: 'https://img.test/920.jpg',
    source: 'manko',
  });
  assert.equal(list[1].title, 'MIDE-001', 'title falls back to the code');
  assert.equal(list[1].movieId, 'id-mide');
  assert.equal(list[1].coverUrl, 'https://img.test/mide.jpg');
  assert.equal(list[1].maker, null);
  assert.equal(list[3].releaseDate, null, 'missing date stays null');
  assert.match(http.calls[0], /^https:\/\/www\.javbus\.com\/search\//, 'javbus keyword search is tried first');
  assert.match(http.calls[1], /^https:\/\/healertanker\.com\/swx\/movie\/search\?keyword=IPX-920/, 'manko is the fallback');
});

test('lookup: exact code first, then releaseDate desc, then limit', async () => {
  const http = lookupHttp({ 'IPX-920': LOOKUP_RECORDS });
  const lookup = createLookup({ http });
  const limited = await lookup.byKeyword('IPX-920', { limit: 2 });
  assert.deepEqual(limited.map((c) => c.code), ['IPX-920', 'MIDE-001']);

  const byActress = lookupHttp({
    涼森れむ: [
      { _id: 's1', title: 'SSNI-001', share_date: '2021-01-01' },
      { _id: 's2', title: 'SSNI-002', share_date: '2022-01-01' },
      { _id: 's3', title: 'SSNI-003', share_date: '2020-01-01' },
    ],
  });
  const list = await createLookup({ http: byActress }).byKeyword('涼森れむ');
  assert.deepEqual(list.map((c) => c.code), ['SSNI-002', 'SSNI-001', 'SSNI-003']);
  assert.match(byActress.calls[1], /keyword=%E6%B6%BC%E6%A3%AE/, 'manko fallback keeps the keyword');
});

test('lookup: empty keyword returns [] without a request; invalid-only results are dropped', async () => {
  const http = lookupHttp({});
  const lookup = createLookup({ http });
  assert.deepEqual(await lookup.byKeyword('   '), []);
  assert.deepEqual(await lookup.byKeyword(null), []);
  assert.equal(http.calls.length, 0);

  const invalid = lookupHttp({ keyword: [{ _id: 'x', title: '普通标题' }] });
  assert.deepEqual(await createLookup({ http: invalid }).byKeyword('keyword'), []);
});

test('lookup: mapLookupRecord rejects records without a code-shaped title', () => {
  assert.equal(mapLookupRecord(null), null);
  assert.equal(mapLookupRecord({ title: '普通标题' }), null);
  assert.equal(mapLookupRecord({ title: 'IPX-920' }).code, 'IPX-920');
  assert.equal(mapLookupRecord({ title: 'ipx-920' }).code, 'ipx-920');
  assert.equal(mapLookupRecord({ title: 'FC2-1234567' }), null, '7-digit FC2 pseudo code is not a candidate');
});

// ---------------------------------------------------------------------------
// F17: install helpers
// ---------------------------------------------------------------------------

test('install: subtitlePathForLang writes <stem>.<lang>.srt and sanitises the tag', () => {
  assert.equal(subtitlePathForLang(path.join('C:', 'vids', 'IPX-920.mp4'), 'zh-TW'), path.join('C:', 'vids', 'IPX-920.zh-TW.srt'));
  assert.equal(subtitlePathForLang(path.join('/media', 'a.b', 'ABP-984.4K.mkv'), 'en'), path.join('/media', 'a.b', 'ABP-984.4K.en.srt'));
  assert.equal(subtitlePathForLang(path.join('/media', 'x.mp4'), 'zh_TW!'), path.join('/media', 'x.zhTW.srt'));
  assert.equal(sanitizeSubtitleLang('zh-TW'), 'zh-TW');
  assert.equal(sanitizeSubtitleLang('zh_TW/../'), 'zhTW');
  assert.equal(subtitlePathFor(path.join('C:', 'vids', 'IPX-920.mp4')), path.join('C:', 'vids', 'IPX-920.srt'));
  assert.throws(() => subtitlePathForLang('/media/x.mp4', '***'), (err) => err.code === 'BAD_SUBTITLE_LANG');
});

test('install: installSubtitleAs normalises any encoding to UTF-8/LF at the lang path', async (t) => {
  const dir = await tempDir(t);
  const video = path.join(dir, 'IPX-920 标题.mp4');

  const raw = Buffer.from('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n世界\r\n', 'utf8');
  const written = await installSubtitleAs(video, raw, 'zh-TW');
  assert.equal(written.path, path.join(dir, 'IPX-920 标题.zh-TW.srt'));
  const text = await fs.readFile(written.path, 'utf8');
  assert.equal(text.startsWith('\uFEFF'), false, 'BOM stripped');
  assert.equal(text.includes('\r'), false, 'CRLF normalised to LF');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(written.bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(parseSrt(text).count, 2);

  // UTF-16LE (BOM) input -> valid UTF-8 file at <stem>.ko.srt
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT_6S, 'utf16le')]);
  await installSubtitleAs(video, utf16, 'ko');
  const ko = await fs.readFile(path.join(dir, 'IPX-920 标题.ko.srt'), 'utf8');
  assert.equal(ko, SRT_6S);

  // the main install path keeps working unchanged
  const main = await installSubtitle(video, Buffer.from(SRT_6S, 'utf8'));
  assert.equal(main.path, path.join(dir, 'IPX-920 标题.srt'));
  assert.equal(await fs.readFile(main.path, 'utf8'), SRT_6S);

  await assert.rejects(() => installSubtitleAs(video, Buffer.alloc(0), 'en'), /EMPTY_SUBTITLE/);
});

// ---------------------------------------------------------------------------
// F17: manko findLang
// ---------------------------------------------------------------------------

test('manko: findLang maps zh-TW/en/ko and returns null when absent', async () => {
  assert.deepEqual(MANKO_EXTRA_LANG_KEYS, { 'zh-TW': 'TW', en: 'EN', ko: 'KO' });
  const manko = {
    async findByCode() {
      return {
        movieId: 'movie-1',
        code: 'IPX-920',
        subtitles: [
          { lang: 'TW', url: 'https://cdn.test/IPX-920-tw.srt' },
          { lang: 'EN', url: 'https://cdn.test/IPX-920-en.srt' },
          { lang: 'KO', url: 'https://cdn.test/IPX-920-ko.srt' },
        ],
      };
    },
  };
  const source = createMankoSubSource(manko);

  assert.deepEqual(await source.findLang('IPX-920', 'zh-TW'), {
    source: 'manko',
    lang: 'zh-TW',
    url: 'https://cdn.test/IPX-920-tw.srt',
    movieId: 'movie-1',
  });
  assert.deepEqual(await source.findLang('IPX-920', 'en'), {
    source: 'manko',
    lang: 'en',
    url: 'https://cdn.test/IPX-920-en.srt',
    movieId: 'movie-1',
  });
  assert.equal((await source.findLang('IPX-920', 'KO')).lang, 'ko');
  assert.equal(await source.findLang('IPX-920', 'fr'), null);
  assert.equal(await source.findLang('', 'en'), null);
  assert.equal(await source.findLang('IPX-920', null), null);

  const empty = createMankoSubSource({ async findByCode() { return null; } });
  assert.equal(await empty.findLang('IPX-920', 'en'), null);

  const noSubtitles = createMankoSubSource({ async findByCode() { return { code: 'IPX-920' }; } });
  assert.equal(await noSubtitles.findLang('IPX-920', 'en'), null);
});

// ---------------------------------------------------------------------------
// F17: pipeline extraLangs (apply only)
// ---------------------------------------------------------------------------

/**
 * Build a ctx whose offline stubs resolve IPX-920 via manko and serve one ZH main
 * subtitle + the requested extra languages.
 */
function extraLangsCtx({ dir, extraLangs, findLangResult = null }) {
  const state = fakeState();
  const logs = [];
  const findLangCalls = [];
  const journalFile = path.join(dir, 'journal-extras.json');
  const config = testConfig({
    metadata: { r18: false },
    paths: { dataDir: dir },
    subs: { sources: ['manko'], maxDurationDeltaMin: 5, extraLangs },
    covers: { download: false },
  });
  const mankoRecord = {
    code: 'IPX-920',
    titleJa: 'テスト作品',
    actress: [{ jp: '女優A' }],
    durationMin: 0.1, // 6s — lets the en (2h) subtitle trigger duration_mismatch
    releaseDate: '2020-08-14',
    maker: 'メーカー',
    coverUrl: '',
  };
  const subs = [{
    name: 'manko',
    async listCandidates() { return [{ name: 'IPX-920.srt', url: 'https://sub.test/zh.srt' }]; },
    async download(candidate) {
      const url = typeof candidate === 'string' ? candidate : candidate?.url;
      return { buffer: Buffer.from(url.endsWith('/zh-TW.srt') ? SRT_6S : url.endsWith('/en.srt') ? SRT_2H : SRT_6S, 'utf8'), url };
    },
    async findLang(code, lang) {
      findLangCalls.push(lang);
      if (findLangResult) return findLangResult(code, lang);
      if (lang === 'zh-TW') return { source: 'manko', lang, url: 'https://sub.test/zh-TW.srt' };
      if (lang === 'en') return { source: 'manko', lang, url: 'https://sub.test/en.srt' };
      return null;
    },
  }];
  const ctx = {
    config,
    state,
    logger: (line) => logs.push(line),
    journalFile,
    http: { stats: {} },
    javbus: { async search() { return null; } },
    manko: { async findByCode() { return mankoRecord; } },
    r18: null,
    subs,
  };
  return { ctx, state, logs, findLangCalls, journalFile };
}

test('pipeline: apply writes extraLangs as <stem>.<lang>.srt, journals srtExtra/srtExtraBackup', async (t) => {
  const dir = await tempDir(t);
  const { ctx, journalFile } = extraLangsCtx({ dir, extraLangs: ['zh-TW', 'en'] });

  const original = path.join(dir, 'IPX-920.mp4');
  await fs.writeFile(original, 'video-bytes', 'utf8');
  const stem = 'IPX-920 テスト作品 [女優A]';
  const oldTw = path.join(dir, `${stem}.zh-TW.srt`);
  await fs.writeFile(oldTw, 'old tw subtitle', 'utf8');

  const result = await processFile(ctx, { path: original, name: 'IPX-920.mp4', size: 11 }, { apply: true, downloadSubs: true });

  assert.equal(result.status, 'ok');
  assert.ok(result.renamedTo, 'video renamed before the subtitles are written');
  assert.equal(path.dirname(result.renamedTo), dir);

  const twPath = path.join(dir, `${stem}.zh-TW.srt`);
  const enPath = path.join(dir, `${stem}.en.srt`);
  const mainPath = path.join(dir, `${stem}.srt`);
  assert.equal(await exists(mainPath), true, 'main zh subtitle still written');

  assert.equal(result.extraSubs.length, 2);
  const tw = result.extraSubs.find((e) => e.lang === 'zh-TW');
  const en = result.extraSubs.find((e) => e.lang === 'en');
  assert.deepEqual(tw, { lang: 'zh-TW', path: twPath, bytes: Buffer.byteLength(SRT_6S, 'utf8'), cues: 1, warnings: [] });
  assert.equal(en.lang, 'en');
  assert.equal(en.path, enPath);
  assert.equal(en.cues, 1);
  assert.deepEqual(en.warnings, ['duration_mismatch'], '2h subtitle vs 6s metadata -> warning, still written');

  assert.equal(await fs.readFile(twPath, 'utf8'), SRT_6S);
  assert.equal(await fs.readFile(enPath, 'utf8'), SRT_2H);

  // journal: new sidecars + the pre-existing zh-TW backup
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  const item = journal.items[0];
  assert.deepEqual(item.srtExtra, [
    { lang: 'zh-TW', path: twPath },
    { lang: 'en', path: enPath },
  ]);
  assert.equal(item.srtExtraBackup.length, 1);
  assert.equal(item.srtExtraBackup[0].lang, 'zh-TW');
  assert.equal(item.srtExtraBackup[0].path, twPath);
  assert.match(path.basename(item.srtExtraBackup[0].backup), /\.srt\.avc-bak-\d+$/);
  assert.equal(await fs.readFile(item.srtExtraBackup[0].backup, 'utf8'), 'old tw subtitle');

  // the journal fields are the exact contract infra-data's undo consumes
  const undo = await undoJournal(journalFile);
  assert.equal(undo.failed.length, 0, JSON.stringify(undo.failed));
  assert.equal(await exists(result.renamedTo), false, 'video renamed back by undo');
  assert.equal(await exists(mainPath), false, 'main subtitle written by apply is removed');
  assert.equal(await exists(enPath), false, 'apply-written extra subtitle is removed');
  assert.equal(await fs.readFile(oldTw, 'utf8'), 'old tw subtitle', 'pre-existing extra subtitle is restored');
});

test('pipeline: extraLangs are not fetched or written in plan (apply=false) mode', async (t) => {
  const dir = await tempDir(t);
  const { ctx, findLangCalls } = extraLangsCtx({ dir, extraLangs: ['zh-TW', 'en'] });
  const original = path.join(dir, 'IPX-920.mp4');
  await fs.writeFile(original, 'video-bytes', 'utf8');

  const result = await processFile(ctx, { path: original, name: 'IPX-920.mp4', size: 11 }, { apply: false, downloadSubs: true });
  assert.equal(result.status, 'ok');
  assert.equal(result.extraSubs, undefined);
  assert.deepEqual(findLangCalls, []);
  assert.equal(await exists(path.join(dir, 'IPX-920 テスト作品 [女優A].zh-TW.srt')), false);
  assert.equal(await fs.readFile(original, 'utf8'), 'video-bytes', 'plan mode never touches files');
});

test('pipeline: an unavailable extra language is skipped without failing the file', async (t) => {
  const dir = await tempDir(t);
  const { ctx, findLangCalls } = extraLangsCtx({ dir, extraLangs: ['ko'], findLangResult: () => null });
  const original = path.join(dir, 'IPX-920.mp4');
  await fs.writeFile(original, 'video-bytes', 'utf8');

  const result = await processFile(ctx, { path: original, name: 'IPX-920.mp4', size: 11 }, { apply: true, downloadSubs: true });
  assert.equal(result.status, 'ok');
  assert.equal(result.extraSubs, undefined);
  assert.deepEqual(findLangCalls, ['ko']);
  assert.equal(await exists(path.join(dir, 'IPX-920 テスト作品 [女優A].ko.srt')), false);
});

// ---------------------------------------------------------------------------
// config template + plan signature
// ---------------------------------------------------------------------------

test('config.example.json carries the v0.7 keys and drops the unimplemented ones', async () => {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(cfg.network.proxyHosts.includes('r18.dev'), true);
  assert.deepEqual(cfg.metadata, { r18: true });
  assert.deepEqual(cfg.subs.extraLangs, []);
  assert.deepEqual(cfg.media, { probeDuration: 'auto' });
  const removed = [
    ['network', 'autoDiscover'],
    ['rename', 'stripActressFromTitle'],
    ['subs', 'writeSiblingSrt'],
    ['scan', 'skipNormalized'],
  ];
  for (const [section, key] of removed) {
    assert.equal(Object.prototype.hasOwnProperty.call(cfg[section], key), false, `${section}.${key} must be removed`);
  }
  // the remaining keys are still the documented ones
  assert.equal(cfg.rename.template, '{code} {title} [{actress}]');
  assert.equal(cfg.subs.lang, 'zh');
  assert.deepEqual(cfg.subs.fit, { mode: 'auto', toleranceSec: 2, maxShiftSec: 90 });
});

test('pipeline: configSignature reacts to metadata.r18 and subs.extraLangs', () => {
  const base = testConfig();
  const sig = configSignature(base);
  assert.match(sig, /^v06-[0-9a-f]{8}$/);
  assert.notEqual(configSignature({ ...base, metadata: { r18: false } }), sig);
  assert.notEqual(configSignature({ ...base, subs: { ...base.subs, extraLangs: ['en'] } }), sig);
  assert.equal(configSignature({ ...base, metadata: { r18: true } }), sig, 'r18 enabled is the default');
});
