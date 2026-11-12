// Offline parser/client tests for the javbus + manko metadata sources and the manko
// subtitle source. Everything here runs without network: fixtures are real snapshots
// captured on 2026-11-07 (see fixtures/javbus/*.html and fixtures/manko/*.json), or generated
// equivalents from tests/helpers/factory.mjs when the repository snapshots are absent (F20).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  JAVBUS_BASE,
  createJavbus,
  decodeEntities,
  parseActresses,
  parseCover,
  parseDetailHtml,
  parseGenres,
  parseSearchHtml,
  textOf,
} from '../src/sources/javbus.mjs';
import {
  MANKO_HOSTS,
  createManko,
  decodeData,
  decodeEnvelope,
  normalizeSubtitleLinks,
  pickBestRecord,
  splitLeadActors,
} from '../src/sources/manko.mjs';
import { createMankoSubSource } from '../src/subs/source-manko.mjs';
import { ensureFixtures } from './helpers/factory.mjs';

// F20: prefer the repository's real snapshots; on a clean checkout generate equivalent
// fixtures through tests/helpers/factory.mjs (AVC_TEST_FIXTURES=generated forces them).
const FIXTURES = await ensureFixtures();
const readText = (rel) => fs.readFile(path.join(FIXTURES, rel), 'utf8');
const readBuffer = (rel) => fs.readFile(path.join(FIXTURES, rel));

const IPX920_ID = '62eceeb22700df5342b529bf';
const IPX451_ID = '6158b0e224ddbb03ea1eed7d';
const CODE_BY_ID = { [IPX920_ID]: 'IPX-920', [IPX451_ID]: 'IPX-451' };

// ---------------------------------------------------------------- stubs

function javbusStubHttp() {
  const seen = [];
  return {
    seen,
    async getFollow(url, opts) {
      seen.push({ url, headers: opts?.headers || {} });
      const text = url.includes('/search/')
        ? await readText('javbus/search-ABP-984.html')
        : await readText('javbus/detail-ABP-984.html');
      return { status: 200, text, buffer: Buffer.from(text), url, route: 'direct', headers: {} };
    },
  };
}

/**
 * Serves the recorded manko API envelopes + the recorded ZH subtitle file.
 * @param {{failPrimary?:boolean}} [opts]
 */
function mankoStubHttp(opts = {}) {
  const requests = [];
  async function call(url, requestOpts, host) {
    const u = new URL(url);
    if (host === 'healertanker.com' && opts.failPrimary) {
      throw Object.assign(new Error('primary host down'), { code: 'STUB_PRIMARY_DOWN' });
    }
    if (u.pathname === '/swx/movie/search') {
      const keyword = u.searchParams.get('keyword') || '';
      const known = keyword === 'IPX-920' || keyword === 'IPX-451';
      const text = known ? await readText(`manko/api-search-${keyword}.json`) : JSON.stringify({ data: [], total: 0 });
      return { status: 200, text, buffer: Buffer.from(text), url, route: 'direct', headers: { 'content-type': 'application/json' } };
    }
    const movieMatch = /^\/swx\/movie\/(detail|actors)\/([^/]+)$/.exec(u.pathname);
    if (movieMatch) {
      const fixtureCode = CODE_BY_ID[movieMatch[2]];
      if (!fixtureCode) return { status: 404, text: '', buffer: Buffer.alloc(0), url, route: 'direct', headers: {} };
      const text = await readText(`manko/api-${movieMatch[1]}-${fixtureCode}.json`);
      return { status: 200, text, buffer: Buffer.from(text), url, route: 'direct', headers: { 'content-type': 'application/json' } };
    }
    const subMatch = /^\/swx\/subtitle-link\/([^/]+)$/.exec(u.pathname);
    if (subMatch) {
      const fixtureCode = CODE_BY_ID[subMatch[1]];
      const text = fixtureCode
        ? await readText(`manko/api-subtitle-${fixtureCode}.json`)
        : JSON.stringify({ data: JSON.stringify({ subtitle_link: [] }) });
      return { status: 200, text, buffer: Buffer.from(text), url, route: 'direct', headers: { 'content-type': 'application/json' } };
    }
    if (u.hostname === 's3.ap-northeast-1.wasabisys.com') {
      const buffer = await readBuffer('manko/subtitle-zh-IPX-920.srt');
      return { status: 200, text: buffer.toString('utf8'), buffer, url, route: 'direct', headers: { 'content-type': 'text/plain' } };
    }
    throw Object.assign(new Error(`stub has no fixture for ${url}`), { code: 'STUB_NO_FIXTURE' });
  }
  return {
    requests,
    async getFollow(url, requestOpts) {
      const host = new URL(url).hostname;
      requests.push({ url, host, headers: requestOpts?.headers || {} });
      return call(url, requestOpts, host);
    },
  };
}

// ---------------------------------------------------------------- javbus: pure parsing

test('javbus search page -> detail URL', async () => {
  const html = await readText('javbus/search-ABP-984.html');
  assert.deepEqual(parseSearchHtml(html), [`${JAVBUS_BASE}/ABP-984`]);
});

test('javbus detail page (ABP-984) parses every contract field', async () => {
  const html = await readText('javbus/detail-ABP-984.html');
  const meta = parseDetailHtml(html, { url: `${JAVBUS_BASE}/ABP-984` });

  assert.equal(meta.code, 'ABP-984');
  assert.match(meta.titleJa, /中出し 射精執行官 05/);
  assert.match(meta.titleJa, /涼森れむ/);
  assert.deepEqual(meta.actress, ['涼森れむ']);
  assert.equal(meta.durationMin, 169);
  assert.equal(meta.maker, 'プレステージ');
  assert.equal(meta.publisher, 'ABSOLUTELY PERFECT');
  assert.equal(meta.series, '強●中出し 射精執行官');
  assert.equal(meta.releaseDate, '2020-06-12');
  assert.deepEqual(meta.genres, ['中出', '女上位', '高畫質', '單體作品']);
  assert.equal(meta.coverUrl, `${JAVBUS_BASE}/pics/cover/7prq_b.jpg`);
  assert.equal(meta.url, `${JAVBUS_BASE}/ABP-984`);
});

test('javbus genres exclude actress links mixed into span.genre', async () => {
  const html = await readText('javbus/detail-ABP-984.html');
  const genres = parseGenres(html);
  assert.ok(genres.length > 0);
  assert.ok(!genres.includes('涼森れむ'), 'star link inside span.genre must not become a genre');
  assert.equal(new Set(genres).size, genres.length, 'no duplicate genres');
});

test('javbus actress/cover helpers are independent of the info block', async () => {
  const html = await readText('javbus/detail-ABP-984.html');
  assert.deepEqual(parseActresses(html), ['涼森れむ']);
  assert.equal(parseCover(html), `${JAVBUS_BASE}/pics/cover/7prq_b.jpg`);
});

test('javbus html entity handling', () => {
  assert.equal(decodeEntities('a &amp; b &lt;tag&gt; &quot;q&quot; &#39;s&#39; &#39;'), `a & b <tag> "q" 's' '`);
  assert.equal(decodeEntities('強&amp;制 &#x41;'), '強&制 A');
  assert.equal(textOf('<b>粗</b>&nbsp;<i>体</i>'), '粗 体');
});

// ---------------------------------------------------------------- javbus: client against fixtures

test('createJavbus(http) searches and parses a detail page', async () => {
  const http = javbusStubHttp();
  const javbus = createJavbus(http);

  const url = await javbus.search('ABP-984');
  assert.equal(url, `${JAVBUS_BASE}/ABP-984`);

  const meta = await javbus.detail(url);
  assert.equal(meta.code, 'ABP-984');
  assert.equal(meta.durationMin, 169);
  assert.deepEqual(meta.actress, ['涼森れむ']);
  assert.equal(meta.maker, 'プレステージ');
  assert.equal(meta.coverUrl, `${JAVBUS_BASE}/pics/cover/7prq_b.jpg`);
  assert.equal(meta.url, `${JAVBUS_BASE}/ABP-984`);

  // Referer is always sent, and the search URL is the verified javbus format.
  assert.match(http.seen[0].url, /\/search\/ABP-984&type=&parent=ce$/);
  assert.equal(http.seen[0].headers.Referer, `${JAVBUS_BASE}/`);
});

test('createJavbus handles "no result" and transport/status errors clearly', async () => {
  const noResult = createJavbus({ getFollow: async (url) => ({ status: 200, text: '<html>no boxes</html>', url }) });
  assert.equal(await noResult.search('NOPE-000'), null);

  const notFound = createJavbus({ getFollow: async (url) => ({ status: 404, text: 'nope', url }) });
  await assert.rejects(notFound.search('ABP-984'), (err) => err.code === 'JAVBUS_HTTP_STATUS' && err.status === 404);

  const offline = createJavbus({
    getFollow: async () => {
      throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    },
  });
  await assert.rejects(offline.search('ABP-984'), (err) => err.code === 'JAVBUS_NETWORK');

  assert.throws(() => parseDetailHtml(''), (err) => err.code === 'JAVBUS_EMPTY_DETAIL');
  assert.throws(
    () => parseDetailHtml('<html><body><p>nothing here</p></body></html>'),
    (err) => err.code === 'JAVBUS_PARSE_FAILED'
  );
});

// ---------------------------------------------------------------- manko: decoder

test('manko 91-radix decoder reproduces recorded search/detail snapshots', async () => {
  for (const code of ['IPX-920', 'IPX-451']) {
    for (const [endpoint, file] of [
      ['search', `manko/search-${code}.json`],
      ['detail', `manko/detail-${code}.json`],
      ['actors', `manko/actors-${code}.json`],
      ['subtitle', `manko/subtitle-${code}.json`],
    ]) {
      const envelope = JSON.parse(await readText(`manko/api-${endpoint}-${code}.json`));
      const decoded = JSON.parse(decodeData(envelope.data));
      const expected = JSON.parse(await readText(file));
      assert.deepEqual(decoded, expected, `decoded ${endpoint} for ${code} must match snapshot`);
    }
  }
});

test('manko decoder tolerates plain-JSON envelopes', () => {
  const direct = decodeEnvelope({ data: { subtitle_link: [{ ZH: 'x' }] } });
  assert.deepEqual(direct.payload, { subtitle_link: [{ ZH: 'x' }] });
  assert.throws(() => decodeEnvelope(null), (err) => err.code === 'MANKO_BAD_ENVELOPE');
});

test('manko subtitle links keep raw language keys (KO filename has no suffix)', async () => {
  const envelope = JSON.parse(await readText('manko/api-subtitle-IPX-451.json'));
  const payload = decodeEnvelope(envelope).payload;
  const links = normalizeSubtitleLinks(payload.subtitle_link);
  assert.deepEqual(links.map((l) => l.lang), ['KO', 'ZH', 'EN', 'TW']);
  assert.match(links.find((l) => l.lang === 'KO').url, /\/IPX-451\.srt$/);
  assert.match(links.find((l) => l.lang === 'ZH').url, /\/IPX-451-zh\.srt$/);
});

// ---------------------------------------------------------------- manko: client against fixtures

test('createManko(http) sends manko origin/referer and consumes the API', async () => {
  const http = mankoStubHttp();
  const manko = createManko(http);

  const records = await manko.search('IPX-920');
  assert.equal(records.length, 1);
  assert.equal(records[0]._id, IPX920_ID);

  const detail = await manko.detail(IPX920_ID);
  assert.equal(detail.video_duration, 120);
  assert.equal(detail.discription.find((d) => d.language === 'ja').overview.includes('美人家庭教師'), true);

  const actors = await manko.actors(IPX920_ID);
  assert.equal(actors[0].order, 114, 'lead performer is the smallest order, not necessarily 1');
  assert.equal(actors[0].also_known_as.jp, '明里つむぎ');

  const subs = await manko.subtitleLink(IPX920_ID);
  assert.deepEqual(subs.map((s) => s.lang), ['KO', 'ZH', 'EN']);
  assert.match(subs.find((s) => s.lang === 'ZH').url, /\/IPX-920-zh\.srt$/);

  assert.equal(http.requests[0].headers.Origin, 'https://manko.fun');
  assert.equal(http.requests[0].headers.Referer, 'https://manko.fun/');
  assert.match(http.requests[0].url, new RegExp(`^https://${MANKO_HOSTS[0]}/swx/movie/search\\?keyword=IPX-920`));
});

test('manko.findByCode(IPX-920) resolves the unified record', async () => {
  const manko = createManko(mankoStubHttp());
  const found = await manko.findByCode('IPX-920');

  assert.ok(found);
  assert.equal(found.movieId, IPX920_ID);
  assert.equal(found.code, 'IPX-920');
  assert.equal(found.titleJa, '美人家庭教師つむぎ先生の接吻レクチャー個人レッスン 明里つむぎ 生写真3枚付き');
  assert.match(found.titleZh, /家庭教师/);
  assert.equal(found.durationMin, 120);
  assert.equal(found.rating, 4.51, 'detail.rating is "NA", fall back to the search record rating');
  assert.equal(found.maker, 'IDEA POCKET');
  assert.equal(found.releaseDate, '2022-08-05');
  assert.match(found.coverUrl, /62eceeb22700df5342b529bf\/cover\.webp$/);
  assert.deepEqual(found.actress.map((a) => a.jp), ['明里つむぎ']);
  assert.deepEqual(found.actress[0], {
    jp: '明里つむぎ',
    zh: '明里䌷',
    en: 'Tsumugi Akari',
    name: '明裏紬',
    personId: 'M4Q7',
    order: 114,
  });
  const zh = found.subtitles.find((s) => s.lang === 'ZH');
  assert.ok(zh);
  assert.equal(zh.url, `https://s3.ap-northeast-1.wasabisys.com/swipesub/${IPX920_ID}/IPX-920-zh.srt`);
});

test('manko.findByCode(IPX-451) keeps the extension-less KO file name', async () => {
  const manko = createManko(mankoStubHttp());
  const found = await manko.findByCode('IPX-451');

  assert.ok(found);
  assert.equal(found.movieId, IPX451_ID);
  assert.equal(found.durationMin, 166);
  assert.equal(found.releaseDate, '2020-03-13');
  assert.deepEqual(found.actress.map((a) => a.jp), ['楓カレン']);
  const ko = found.subtitles.find((s) => s.lang === 'KO');
  const zh = found.subtitles.find((s) => s.lang === 'ZH');
  assert.match(ko.url, /\/IPX-451\.srt$/, 'must not guess "-ko" suffix');
  assert.match(zh.url, /\/IPX-451-zh\.srt$/);
});

test('manko.findByCode returns null for an unknown code', async () => {
  const manko = createManko(mankoStubHttp());
  assert.equal(await manko.findByCode('ZZZ-000'), null);
});

test('manko falls back from healertanker.com to alpharomeo.shop', async () => {
  const http = mankoStubHttp({ failPrimary: true });
  const manko = createManko(http);
  const found = await manko.findByCode('IPX-920');
  assert.ok(found);
  assert.equal(found.movieId, IPX920_ID);
  assert.equal(found.host, 'alpharomeo.shop');
  assert.ok(http.requests.some((r) => r.host === 'healertanker.com' && r.url.includes('/swx/')));
  assert.ok(http.requests.some((r) => r.host === 'alpharomeo.shop' && r.url.includes('/swx/')));
});

test('manko.findByCode is memoized per code (metadata + subtitle share one lookup)', async () => {
  const http = mankoStubHttp();
  const manko = createManko(http);
  const [first, second] = await Promise.all([manko.findByCode('IPX-920'), manko.findByCode('ipx_920')]);
  assert.equal(first.movieId, IPX920_ID);
  assert.equal(second.movieId, IPX920_ID);
  assert.equal(http.requests.filter((r) => r.url.includes('/swx/movie/search')).length, 1, 'one search for one code');
  manko.clearCache();
  await manko.findByCode('IPX-920');
  assert.equal(http.requests.filter((r) => r.url.includes('/swx/movie/search')).length, 2);
});

test('pickBestRecord prefers the exact title and the record that knows its subtitles', async () => {
  const records = JSON.parse(await readText('manko/search-IPX-451.json'));
  assert.equal(pickBestRecord(records, 'IPX-451')._id, IPX451_ID);
  assert.equal(pickBestRecord([], 'IPX-451'), null);
});

test('splitLeadActors isolates the smallest order', () => {
  const { leads, rest } = splitLeadActors([
    { name: 'a', order: 99999 },
    { name: 'b', order: 1 },
    { name: 'c', order: 99999 },
    { name: 'd', order: 1 },
  ]);
  assert.deepEqual(leads.map((a) => a.name), ['b', 'd']);
  assert.deepEqual(rest.map((a) => a.name), ['a', 'c']);
});

// ---------------------------------------------------------------- manko subtitle source

test('createMankoSubSource finds + downloads the ZH subtitle', async () => {
  const http = mankoStubHttp();
  const manko = createManko(http);
  const source = createMankoSubSource(manko);

  assert.equal(source.name, 'manko');

  const found = await source.find('IPX-920');
  assert.ok(found);
  assert.equal(found.source, 'manko');
  assert.equal(found.lang, 'zh');
  assert.equal(found.name, 'IPX-920-zh.srt');
  assert.equal(found.movieId, IPX920_ID);
  assert.match(found.url, /IPX-920-zh\.srt$/);

  const { buffer, bytes, contentType } = await source.download(found);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(bytes, 33695, 'live ZH download for IPX-920 is 33695 bytes');
  assert.equal(buffer.length, 33695);
  assert.equal(contentType, 'text/plain');
  assert.match(buffer.toString('utf8'), /00:00:00,000 --> 00:00:05,000/);
});

test('createMankoSubSource only accepts ZH (never TW)', async () => {
  const twOnly = createMankoSubSource({
    findByCode: async () => ({ subtitles: [{ lang: 'TW', url: 'https://example.test/x-tw.srt' }] }),
  });
  assert.equal(await twOnly.find('IPX-920'), null);

  const noSubs = createMankoSubSource({ findByCode: async () => null });
  assert.equal(await noSubs.find('IPX-999'), null);

  const zhTw = createMankoSubSource({
    findByCode: async () => ({ subtitles: [{ lang: 'TW', url: 'https://example.test/x-tw.srt' }, { lang: 'ZH', url: 'https://example.test/x-zh.srt' }] }),
  });
  assert.equal((await zhTw.find('IPX-920')).url, 'https://example.test/x-zh.srt');
});

test('createMankoSubSource surfaces clear errors', async () => {
  assert.throws(() => createMankoSubSource(null), /findByCode/);
  const source = createMankoSubSource({
    findByCode: async () => ({ subtitles: [{ lang: 'ZH', url: 'https://example.test/x-zh.srt' }] }),
  });
  const found = await source.find('IPX-920');
  await assert.rejects(source.download(found), (err) => err.code === 'MANKO_SUB_NO_DOWNLOAD');
  await assert.rejects(source.download({}), (err) => err.code === 'MANKO_SUB_BAD_FOUND');
});
