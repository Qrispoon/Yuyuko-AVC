// Offline tests for the multi-candidate subtitle sources (T-SRC):
//   - src/subs/source-manko.mjs       listCandidates() -> 0/1 ZH candidate + download
//   - src/subs/source-subtitlecat.mjs every -zh-CN.srt version, ranked, never zh-TW + download
//   - src/subs/source-local.mjs       loose code matching in local dirs (recursive) + download
//
// No network: subtitlecat is driven by fixtures/subtitlecat/* snapshots plus a stub http,
// manko reuses a stub createManko() client, local scans throw-away temp directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMankoSubSource } from '../src/subs/source-manko.mjs';
import { createSubtitlecatSource } from '../src/subs/source-subtitlecat.mjs';
import { createLocalSource, nameMatchesCode, codeKeys } from '../src/subs/source-local.mjs';
import { ensureFixtures } from './helpers/factory.mjs';

// F20: real snapshots when present, otherwise generated equivalents (AVC_TEST_FIXTURES=generated
// forces the generator so the factory itself is exercised).
const FIX = path.join(await ensureFixtures(), 'subtitlecat');
const fixtureText = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const fixtureBytes = (name) => fs.readFileSync(path.join(FIX, name));

const SEARCH_URL = (code) => `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(code)}`;
const detailUrlOf = (href) => new URL(href, 'https://www.subtitlecat.com/').href;

/** Decode a URL for readable assertions (percent-decodes the Chinese/punctuation path). */
const decoded = (url) => decodeURIComponent(String(url));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
/** Fake http: URL -> response map; HEAD responses carry content-length via headers. */
function makeStubHttp(routes) {
  const calls = [];
  const http = {
    calls,
    async getFollow(url, opts = {}) {
      calls.push({ url, opts });
      let entry = routes[url];
      if (typeof entry === 'function') entry = entry(url, opts);
      if (entry && entry.throw) throw entry.throw;
      if (!entry) throw Object.assign(new Error(`NO_STUB_ROUTE ${url}`), { code: 'NO_ROUTE' });
      const text = entry.text ?? '';
      return {
        status: entry.status ?? 200,
        text,
        buffer: entry.buffer ?? Buffer.from(text, 'utf8'),
        headers: entry.headers ?? {},
        url,
        route: 'proxy',
        ms: 1,
      };
    },
  };
  return http;
}

/** Build a minimal subtitlecat detail page with the given srt hrefs. */
function detailPage(title, hrefs) {
  const body = hrefs.map((href) => `<a href="${href}" class="green-link">Download</a>`).join('\n');
  return `<html><head><title>${title} subtitles</title></head><body>`
    + `<h2>All language subtitles for ${title}</h2>\n${body}\n</body></html>`;
}

/** Remove the Simplified Chinese download anchor from a detail page (simulates TW-only). */
function stripZhCnLinks(html) {
  return html.replace(/<a\b[^>]*href="[^"]*-zh-CN\.srt"[^>]*>[\s\S]*?<\/a>/gi, '');
}

/** Manko client stub: findByCode result + download recording. */
function makeMankoStub({ findByCode, downloadBody = fixtureBytes('zh-CN.srt') } = {}) {
  const downloads = [];
  const manko = {
    downloads,
    findByCode: async (code) => (findByCode ? findByCode(code) : null),
    async download(url) {
      downloads.push(url);
      return { buffer: downloadBody, url, contentType: 'text/plain' };
    },
  };
  return manko;
}

// ---------------------------------------------------------------------------
// manko: listCandidates
// ---------------------------------------------------------------------------
test('manko: listCandidates returns exactly one ZH candidate (never TW/EN)', async () => {
  const manko = makeMankoStub({
    findByCode: async (code) => ({
      code,
      movieId: 'ipx00920',
      subtitles: [
        { lang: 'TW', url: 'https://cdn.test/IPX-920-tw.srt' },
        { lang: 'EN', url: 'https://cdn.test/IPX-920-en.srt' },
        { lang: 'ZH', url: 'https://cdn.test/IPX-920-zh.srt' },
      ],
    }),
  });
  const source = createMankoSubSource(manko);
  assert.equal(source.name, 'manko');

  const candidates = await source.listCandidates('IPX-920');
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.source, 'manko');
  assert.equal(candidate.lang, 'zh');
  assert.equal(candidate.name, 'IPX-920-zh.srt');
  assert.equal(candidate.url, 'https://cdn.test/IPX-920-zh.srt');
  assert.equal(candidate.code, 'IPX-920');
  assert.equal(candidate.movieId, 'ipx00920');
  assert.doesNotMatch(candidate.url, /-tw\.srt|-en\.srt/);
});

test('manko: listCandidates returns [] when there is no ZH subtitle', async () => {
  const twOnly = createMankoSubSource(
    makeMankoStub({ findByCode: async () => ({ code: 'IPX-920', subtitles: [{ lang: 'TW', url: 'https://cdn.test/x-tw.srt' }] }) }),
  );
  assert.deepEqual(await twOnly.listCandidates('IPX-920'), []);
  assert.equal(await twOnly.find('IPX-920'), null, 'legacy find() stays null, not []');

  const notFound = createMankoSubSource(makeMankoStub({ findByCode: async () => null }));
  assert.deepEqual(await notFound.listCandidates('IPX-999'), []);

  const noSubtitles = createMankoSubSource(makeMankoStub({ findByCode: async () => ({ code: 'IPX-920' }) }));
  assert.deepEqual(await noSubtitles.listCandidates('IPX-920'), []);
});

test('manko: download returns the ZH srt buffer for a candidate', async () => {
  const body = fixtureBytes('zh-CN.srt');
  const manko = makeMankoStub({
    findByCode: async () => ({ code: 'IPX-920', movieId: 'm', subtitles: [{ lang: 'ZH', url: 'https://cdn.test/x-zh.srt' }] }),
    downloadBody: body,
  });
  const source = createMankoSubSource(manko);
  const [candidate] = await source.listCandidates('IPX-920');
  const result = await source.download(candidate);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.deepEqual(result.buffer, body);
  assert.equal(result.bytes, body.length);
  assert.equal(result.contentType, 'text/plain');
  assert.deepEqual(manko.downloads, ['https://cdn.test/x-zh.srt']);

  // back-compat error codes from the pre-multi-candidate contract
  await assert.rejects(source.download({}), (err) => err.code === 'MANKO_SUB_BAD_FOUND');
  const noDownload = createMankoSubSource({ findByCode: async () => ({ subtitles: [{ lang: 'ZH', url: 'https://cdn.test/x.srt' }] }) });
  await assert.rejects(noDownload.download({ url: 'https://cdn.test/x.srt' }), (err) => err.code === 'MANKO_SUB_NO_DOWNLOAD');
});

// ---------------------------------------------------------------------------
// subtitlecat: listCandidates
// ---------------------------------------------------------------------------
test('subtitlecat: listCandidates returns every -zh-CN.srt version, ranked, never zh-TW', async () => {
  const searchHtml = fixtureText('search-IPX-920.html');
  const row472 = detailUrlOf('subs/472/IPX-920.zh.LLW.html');
  const rowTds = detailUrlOf('subs/396/IPX-920%20TDS.html');
  const rowPlain = detailUrlOf('subs/396/IPX-920.html');

  const detail472 = detailPage('IPX-920', [
    '/subs/822/IPX-920.zh.LLW-zh-CN.srt', // plain, 5000B
    '/subs/900/IPX-920 校对版-zh-CN.srt', // preferred, 3000B
    '/subs/901/IPX-920 简体中文-zh-CN.srt', // preferred, 2000B
    '/subs/472/IPX-920.zh.LLW-zh-TW.srt', // must never be returned
    '/subs/472/IPX-920.zh.LLW-en.srt',
  ]);
  const detailTds = detailPage('IPX-920 TDS', [
    '/subs/902/IPX-920 TDS 简体-zh-CN.srt', // preferred, 4000B
    '/subs/903/IPX-920 TDS-en.srt',
  ]);
  const emptyDetail = detailPage('IPX-920', ['/subs/904/IPX-920-en.srt']);

  const http = makeStubHttp({
    [SEARCH_URL('IPX-920')]: { text: searchHtml },
    [row472]: { text: detail472 },
    [rowTds]: { text: detailTds },
    [rowPlain]: { text: emptyDetail },
    // HEAD probes (sizeHint), keyed by srt URL
    [detailUrlOf('subs/822/IPX-920.zh.LLW-zh-CN.srt')]: { headers: { 'content-length': '5000' } },
    [detailUrlOf('subs/900/IPX-920 校对版-zh-CN.srt')]: { headers: { 'content-length': '3000' } },
    [detailUrlOf('subs/901/IPX-920 简体中文-zh-CN.srt')]: { headers: { 'content-length': '2000' } },
    [detailUrlOf('subs/902/IPX-920 TDS 简体-zh-CN.srt')]: { headers: { 'content-length': '4000' } },
  });

  const source = createSubtitlecatSource(http);
  const candidates = await source.listCandidates('IPX-920');

  assert.equal(candidates.length, 4, 'all simplified versions of the movie');
  for (const candidate of candidates) {
    assert.equal(candidate.source, 'subtitlecat');
    assert.equal(candidate.lang, 'zh');
    assert.match(candidate.url, /-zh-CN\.srt$/);
    assert.doesNotMatch(decoded(candidate.url), /zh-TW|-en\.srt/);
    assert.ok(candidate.detailUrl.startsWith('https://www.subtitlecat.com/'));
    assert.equal(typeof candidate.name, 'string');
    assert.ok(candidate.name.length > 0);
  }
  // 「简体」/「校对」 first (biggest first), then the remaining by size descending.
  assert.deepEqual(
    candidates.map((candidate) => decoded(candidate.srtName)),
    [
      'IPX-920 TDS 简体-zh-CN.srt',
      'IPX-920 校对版-zh-CN.srt',
      'IPX-920 简体中文-zh-CN.srt',
      'IPX-920.zh.LLW-zh-CN.srt',
    ],
  );
  assert.deepEqual(candidates.map((candidate) => candidate.sizeHint), [4000, 3000, 2000, 5000]);
  // HEAD requests carried the Referer needed by subtitlecat.
  const head = http.calls.filter((call) => call.opts.method === 'HEAD');
  assert.equal(head.length, 4);
  assert.ok(head.every((call) => call.opts.headers.Referer.startsWith('https://www.subtitlecat.com/')));
});

test('subtitlecat: listCandidates returns [] (not null) when only zh-TW/-en exist', async () => {
  const searchHtml = fixtureText('search-IPX-920.html');
  const twOnly = stripZhCnLinks(fixtureText('detail-IPX-920.html'));
  assert.doesNotMatch(twOnly, /-zh-CN\.srt/);
  const http = makeStubHttp({
    [SEARCH_URL('IPX-920')]: { text: searchHtml },
  });
  // every detail page (all three IPX-920 rows) has Traditional Chinese only
  http.getFollow = async (url) => {
    const text = url.includes('index.php') ? searchHtml : twOnly;
    http.calls.push({ url, opts: {} });
    return { status: 200, text, buffer: Buffer.from(text, 'utf8'), headers: {}, url, route: 'proxy', ms: 1 };
  };
  const candidates = await createSubtitlecatSource(http).listCandidates('IPX-920');
  assert.ok(Array.isArray(candidates));
  assert.deepEqual(candidates, []);
});

test('subtitlecat: listCandidates rejects fuzzy search results for another code', async () => {
  const http = makeStubHttp({ [SEARCH_URL('ZZZZ-9999')]: { text: fixtureText('search-empty.html') } });
  assert.deepEqual(await createSubtitlecatSource(http).listCandidates('ZZZZ-9999'), []);
  assert.equal(http.calls.length, 1, 'the code guard must reject before probing detail pages');
});

test('subtitlecat: download returns bytes for a listCandidates() candidate', async () => {
  const body = fixtureBytes('zh-CN.srt');
  const srtUrl = 'https://www.subtitlecat.com/subs/822/IPX-920.zh.LLW-zh-CN.srt';
  const http = makeStubHttp({
    [srtUrl]: { buffer: body, headers: { 'content-type': 'application/octet-stream' } },
  });
  const source = createSubtitlecatSource(http);
  const result = await source.download({
    url: srtUrl,
    detailUrl: 'https://www.subtitlecat.com/subs/472/IPX-920.zh.LLW.html',
  });
  assert.deepEqual(result.buffer, body);
  assert.equal(result.bytes, body.length);
  assert.equal(http.calls[0].opts.headers.Referer, 'https://www.subtitlecat.com/subs/472/IPX-920.zh.LLW.html');
});

// ---------------------------------------------------------------------------
// local: matching + sorting
// ---------------------------------------------------------------------------
async function makeLocalTree() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'subs-local-'));
  const dir = path.join(root, 'direct');
  const second = path.join(root, 'second');
  await fsp.mkdir(path.join(dir, 'sub', 'deep', 'more'), { recursive: true });
  await fsp.mkdir(second, { recursive: true });

  const write = (rel, content) => fsp.writeFile(path.join(root, rel), content);
  await write(path.join('direct', 'IPX-920 简体.srt'), '1\n'); // smallest, preferred hint
  await write(path.join('direct', 'IPX-920-zh.srt'), '1\n'.repeat(60)); // largest, no hint
  await write(path.join('direct', 'IPX-920.srt'), '1\n'.repeat(20)); // medium, no hint
  await write(path.join('direct', 'SSIS-001.srt'), '1\n'.repeat(3)); // other code
  await write(path.join('direct', 'IPX-9201.srt'), '1\n'.repeat(3)); // digit-boundary mismatch
  await write(path.join('direct', 'IPX-920 简体.ass'), '1\n'.repeat(3)); // .ass is out of scope for now
  await write(path.join('direct', 'readme.txt'), 'not a subtitle');
  await write(path.join('direct', 'sub', 'ipx_920 中文字幕.srt'), '1\n'.repeat(30)); // depth 1, preferred
  await write(path.join('direct', 'sub', 'deep', 'IPX920.srt'), '1\n'.repeat(10)); // depth 2
  await write(path.join('direct', 'sub', 'deep', 'more', 'IPX-920 deep3.srt'), '1\n'.repeat(5)); // depth 3
  await write(path.join('second', 'IPX-920 [中文字幕].srt'), '1\n'.repeat(40)); // second dir, preferred

  return { root, dir, second };
}

test('local: matches IPX-920 variants across dirs and depth <= 2', async (t) => {
  const { root, dir, second } = await makeLocalTree();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const source = createLocalSource({ dirs: [dir, second] });
  assert.equal(source.name, 'local');
  const candidates = await source.listCandidates('IPX-920');

  const names = candidates.map((candidate) => candidate.name);
  assert.equal(candidates.length, 6);
  for (const expected of [
    'IPX-920 简体.srt',
    'IPX-920-zh.srt',
    'IPX-920.srt',
    'ipx_920 中文字幕.srt',
    'IPX920.srt',
    'IPX-920 [中文字幕].srt',
  ]) {
    assert.ok(names.includes(expected), `expected ${expected} in ${names.join(', ')}`);
  }
  // digit-boundary / unrelated files must not match
  assert.ok(!names.includes('IPX-9201.srt'));
  assert.ok(!names.includes('SSIS-001.srt'));
  assert.ok(!names.includes('IPX-920 简体.ass'), '.ass subtitles are out of scope');
  assert.ok(!names.includes('readme.txt'));
  // depth-3 file is out of scope for maxDepth=2
  assert.ok(!candidates.some((candidate) => candidate.name === 'IPX-920 deep3.srt'));

  for (const candidate of candidates) {
    assert.equal(candidate.source, 'local');
    assert.equal(candidate.lang, 'zh');
    assert.ok(path.isAbsolute(candidate.localPath));
    assert.ok(Number.isFinite(candidate.sizeHint) && candidate.sizeHint > 0);
    const stat = await fsp.stat(candidate.localPath);
    assert.equal(candidate.sizeHint, stat.size);
  }
  // Simplified-hint names rank first...
  assert.match(candidates[0].name, /简体|中文/);
  // ...then plain versions by size descending: -zh (120B), IPX-920 (40B), IPX920 (20B).
  const plain = candidates.filter((candidate) => !/简体|中文/.test(candidate.name));
  assert.deepEqual(plain.map((candidate) => candidate.name), ['IPX-920-zh.srt', 'IPX-920.srt', 'IPX920.srt']);
});

test('local: maxDepth=1 skips nested directories; case-insensitive code', async (t) => {
  const { root, dir } = await makeLocalTree();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const shallow = createLocalSource({ dirs: [dir], maxDepth: 1 });
  const candidates = await shallow.listCandidates('ipx-920');
  assert.equal(candidates.length, 4, '3 files in direct/ + 1 in direct/sub/');
  assert.ok(!candidates.some((candidate) => candidate.localPath.includes(`${path.sep}deep${path.sep}`)));

  // depth 0 = only the listed directory itself
  const flat = createLocalSource({ dirs: [dir], maxDepth: 0 });
  assert.equal((await flat.listCandidates('IPX-920')).length, 3);
});

test('local: missing directories and unknown codes return [] without throwing', async () => {
  const source = createLocalSource({ dirs: [path.join(os.tmpdir(), 'subs-local-does-not-exist-xyz')] });
  assert.deepEqual(await source.listCandidates('IPX-920'), []);
  assert.equal(await source.find('IPX-920'), null);

  assert.deepEqual(await createLocalSource({ dirs: [] }).listCandidates('IPX-920'), []);
  assert.deepEqual(await createLocalSource().listCandidates('IPX-920'), []);

  const { root, dir } = await makeLocalTree();
  try {
    // an unreadable/missing entry mixed with a real dir must not poison the scan
    const mixed = createLocalSource({ dirs: [path.join(root, 'nope'), dir], maxDepth: 0 });
    assert.equal((await mixed.listCandidates('IPX-920')).length, 3);
    assert.deepEqual(await mixed.listCandidates('ZZZ-000'), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('local: accepts the config `localDirs` alias and an array shorthand', async (t) => {
  const { root, dir } = await makeLocalTree();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const alias = createLocalSource({ localDirs: [dir], maxDepth: 0 });
  assert.equal((await alias.listCandidates('IPX-920')).length, 3);
  const shorthand = createLocalSource([dir]);
  assert.equal((await shorthand.listCandidates('IPX-920')).length, 5);
  assert.throws(() => createLocalSource({ dirs: 'not-an-array' }), /dirs must be an array/);
  assert.throws(() => createLocalSource({ dirs: [], maxDepth: -1 }), /maxDepth/);
});

test('local: nameMatchesCode tolerates separators, leading zeros and noise', () => {
  assert.ok(nameMatchesCode('IPX-920 简体.srt', 'IPX-920'));
  assert.ok(nameMatchesCode('IPX920.srt', 'IPX-920'));
  assert.ok(nameMatchesCode('ipx_920-zh.srt', 'IPX-920'));
  assert.ok(nameMatchesCode('[中文字幕] IPX-920.srt', 'IPX-920'));
  assert.ok(nameMatchesCode('IPX-0920 中文字幕.srt', 'IPX-920'));
  assert.ok(nameMatchesCode('SSIS-001.srt', 'ssis-001'));
  assert.ok(!nameMatchesCode('IPX-9201.srt', 'IPX-920'));
  assert.ok(!nameMatchesCode('IPX-92.srt', 'IPX-920'));
  assert.ok(!nameMatchesCode('SSIS-001.srt', 'IPX-920'));
  assert.deepEqual(new Set(codeKeys('IPX-920')), new Set(['IPX920', 'IPX0920', 'IPX00920']));
});

// ---------------------------------------------------------------------------
// local: download
// ---------------------------------------------------------------------------
test('local: download reads the candidate file from disk', async (t) => {
  const { root, dir } = await makeLocalTree();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const source = createLocalSource({ dirs: [dir] });
  const [candidate] = await source.listCandidates('IPX-920');
  const result = await source.download(candidate);
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.bytes, result.buffer.length);
  assert.equal(result.bytes, candidate.sizeHint);
  assert.equal(result.buffer.toString('utf8'),
    await fsp.readFile(candidate.localPath, 'utf8'));

  await assert.rejects(source.download({}), (err) => err.code === 'LOCAL_SUB_BAD_FOUND');
  await assert.rejects(
    source.download({ localPath: path.join(root, 'missing.srt') }),
    (err) => err.code === 'LOCAL_SUB_READ_FAILED',
  );
});
