// Tests for src/core/code.mjs (T2 number extractor).
//   node --test tests/code.test.mjs
//
// 17 个边界文件名直接写在测试里（不依赖磁盘夹具文件，仓库无需提交任何样例文件名）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCandidates,
  toLookupVariants,
  isNormalizedName,
} from '../src/core/code.mjs';

// 10 in-scope (censored) fixtures: expected first candidate.
const CENSORED = new Map([
  ['@nya2p.comipx-920.mp4', 'IPX-920'],
  ['ipx-451.mp4', 'IPX-451'],
  ['hhd800.com@MIDV-123_4K.mp4', 'MIDV-123'],
  ['www.98t.la@STARS-500.mp4', 'STARS-500'],
  ['[thz.la]SSIS-001-C.mp4', 'SSIS-001'],
  ['[javdb.com]PRED-123[中文字幕].mp4', 'PRED-123'],
  ['IPX-920 4K 中文字幕.mp4', 'IPX-920'],
  ['SSIS001.mp4', 'SSIS-001'],
  ['SSNI-999-C_ch.mp4', 'SSNI-999'],
  ['ABP00984 中文字幕.mp4', 'ABP-00984'],
]);

// 3 noise-only fixtures: no candidates at all.
const NOISE = new Set([
  '1080p.mp4',
  'S01E02.mkv',
  '2023.05.12 collection.mp4',
]);

// 4 out-of-scope fixtures: candidates exist but none is 'censored'.
const OUT_OF_SCOPE = new Map([
  ['FC2-PPV-1234567.mp4', { code: 'FC2-1234567', scope: 'fc2' }],
  ['heyzo-2345.mp4', { code: 'HEYZO-2345', scope: 'heyzo' }],
  ['10musume-071423_01.mp4', { code: '10MUSUME-071423-01', scope: 'series' }],
  ['caribbeancom-123456-789.mp4', { code: 'CARIBBEANCOM-123456-789', scope: 'series' }],
]);

test('fixtures: 17 boundary names, all covered by the three expectation sets', () => {
  const names = [...CENSORED.keys(), ...NOISE, ...OUT_OF_SCOPE.keys()];
  assert.equal(new Set(names).size, 17);
  for (const n of names) {
    assert.ok(CENSORED.has(n) || NOISE.has(n) || OUT_OF_SCOPE.has(n), `fixture not covered: ${n}`);
  }
});

test('censored fixtures: first candidate code is correct', () => {
  for (const [name, expected] of CENSORED) {
    const r = extractCandidates(name);
    assert.equal(r.stem, name.replace(/\.[a-z0-9]{1,5}$/i, ''), `stem: ${name}`);
    assert.ok(r.candidates.length > 0, `no candidate: ${name}`);
    assert.equal(r.candidates[0].code, expected, `first code: ${name}`);
    assert.equal(r.candidates[0].scope, 'censored', `scope: ${name}`);
    assert.equal(r.candidates[0].rule, 'std', `rule: ${name}`);
    for (const c of r.candidates) {
      if (c.rule === 'std' && c.scope === 'censored') assert.equal(c.known, true, name);
    }
  }
});

test('ABP00984: padded candidate first, lookup variants include ABP-984', () => {
  const r = extractCandidates('ABP00984 中文字幕.mp4');
  assert.equal(r.candidates[0].code, 'ABP-00984');
  const variants = toLookupVariants(r.candidates[0].code);
  assert.ok(variants.includes('ABP-984'), 'variants must retry ABP-984');
  assert.ok(variants.includes('ABP984'), 'variants must retry ABP984');
});

test('noise fixtures: exactly zero candidates', () => {
  for (const name of NOISE) {
    const r = extractCandidates(name);
    assert.equal(r.candidates.length, 0, `unexpected candidate: ${name}`);
    assert.deepEqual(r.candidates, [], name);
    assert.ok(r.notes.includes('no-code'), `notes should explain no code: ${name}`);
  }
});

test('out-of-scope fixtures: candidates exist and none is censored', () => {
  for (const [name, expected] of OUT_OF_SCOPE) {
    const r = extractCandidates(name);
    assert.ok(r.candidates.length > 0, `no candidate: ${name}`);
    assert.notEqual(r.candidates[0].scope, 'censored', name);
    assert.equal(r.candidates[0].scope, expected.scope, `scope: ${name}`);
    assert.equal(r.candidates[0].code, expected.code, `code: ${name}`);
    assert.ok(
      r.notes.some((n) => n.startsWith('out-of-scope:')),
      `missing out-of-scope note: ${name}`,
    );
    for (const c of r.candidates) assert.notEqual(c.scope, 'censored', name);
  }
});

test('out-of-scope detection also handles glued (no-separator) spellings', () => {
  const fc2 = extractCandidates('FC2PPV1234567.mp4');
  assert.equal(fc2.candidates[0].code, 'FC2-1234567');
  assert.equal(fc2.candidates[0].scope, 'fc2');

  const heyzo = extractCandidates('heyzo2345.mp4');
  assert.equal(heyzo.candidates[0].code, 'HEYZO-2345');
  assert.equal(heyzo.candidates[0].scope, 'heyzo');

  const series = extractCandidates('10musume07142301.mp4');
  assert.equal(series.candidates[0].code, '10MUSUME-071423-01');
  assert.equal(series.candidates[0].scope, 'series');

  const carib = extractCandidates('caribbeancom123456789.mp4');
  assert.equal(carib.candidates[0].code, 'CARIBBEANCOM-123456-789');
  assert.equal(carib.candidates[0].scope, 'series');
});

test('ad domain glued to the code is stripped, never read as a label', () => {
  const r = extractCandidates('@nya2p.comipx-920会所最新更新热片.mp4');
  assert.equal(r.candidates[0].code, 'IPX-920');
  assert.ok(r.notes.includes('ad-domain'));
  assert.equal(
    r.candidates.some((c) => /COMIPX|NYA2P/.test(c.label)),
    false,
    'glued domain must not become a label',
  );
});

test('std candidates carry a pipeline scope; unclassifiable labels are "unknown"', () => {
  const r = extractCandidates('XYZ-123 テスト.mp4');
  assert.equal(r.candidates[0].code, 'XYZ-123');
  assert.equal(r.candidates[0].scope, 'unknown');
  assert.equal(r.candidates[0].known, false);

  const known = extractCandidates('IPX-920 4K 无码破解版 中文字幕.mp4');
  assert.equal(known.candidates[0].scope, 'censored');
  assert.equal(known.candidates[0].known, true);
});

test('extractCandidates result shape + sorted by score', () => {
  const r = extractCandidates('IPX-920 4K 无码破解版 中文字幕.mp4');
  assert.equal(r.stem, 'IPX-920 4K 无码破解版 中文字幕');
  assert.equal(typeof r.cleaned, 'string');
  assert.ok(Array.isArray(r.notes));
  const c = r.candidates[0];
  assert.equal(c.code, 'IPX-920');
  assert.equal(c.label, 'IPX');
  assert.equal(c.num, '920');
  assert.equal(c.rule, 'std');
  assert.equal(typeof c.score, 'number');
  for (let i = 1; i < r.candidates.length; i += 1) {
    assert.ok(r.candidates[i - 1].score >= r.candidates[i].score, 'score must be desc');
  }
});

test('full paths are tolerated (only the basename is used)', () => {
  const r = extractCandidates('D:\\videos\\IPX-920 4K.mp4');
  assert.equal(r.stem, 'IPX-920 4K');
  assert.equal(r.candidates[0].code, 'IPX-920');
});

test('extractCandidates still finds the code in already-normalized names', () => {
  const a = extractCandidates('IPX-920 美人家庭教師つむぎ先生.mp4');
  assert.equal(a.candidates[0].code, 'IPX-920');
  const b = extractCandidates(
    'ABP-984 中出し 射精執行官 05 ドS執行官が爆速騎乗位で、不純精子を搾り取る！！ [涼森れむ].mp4',
  );
  assert.equal(b.candidates[0].code, 'ABP-984');
});

test('toLookupVariants: covers padded / unseparated spellings', () => {
  const v = toLookupVariants('ABP-984');
  assert.equal(v[0], 'ABP-984');
  for (const want of ['ABP-00984', 'ABP984', 'ABP-0984']) {
    assert.ok(v.includes(want), `missing variant ${want}`);
  }
  assert.equal(new Set(v).size, v.length, 'variants must be unique');

  assert.ok(toLookupVariants('ABP-00984').includes('ABP-984'));
  assert.equal(toLookupVariants('ipx-920')[0], 'IPX-920');
  assert.deepEqual(toLookupVariants(''), []);
  // multi-part / non-standard codes are passed through instead of being guessed
  assert.deepEqual(toLookupVariants('CARIBBEANCOM-123456-789'), ['CARIBBEANCOM-123456-789']);
});

test('isNormalizedName: canonical "<CODE> <title>" only', () => {
  // true: already renamed by this pipeline
  assert.equal(isNormalizedName('IPX-920 美人家庭教師つむぎ先生'), true);
  assert.equal(isNormalizedName('IPX-920 美人家庭教師つむぎ先生.mp4'), true);
  assert.equal(
    isNormalizedName(
      'ABP-984 中出し 射精執行官 05 ドS執行官が爆速騎乗位で、不純精子を搾り取る！！ [涼森れむ].mp4',
    ),
    true,
  );

  // false: pre-rename noise left in the name (must NOT be skipped)
  assert.equal(isNormalizedName('IPX-920 4K 无码破解版 中文字幕'), false);
  assert.equal(isNormalizedName('IPX-920 4K 无码破解版 中文字幕.mp4'), false);

  // false: not the canonical form
  assert.equal(isNormalizedName('IPX-920.mp4'), false); // no title yet
  assert.equal(isNormalizedName('ipx-451.mp4'), false); // lowercase
  assert.equal(isNormalizedName('SSIS001.mp4'), false); // no separator
  assert.equal(isNormalizedName('ABP00984 中文字幕.mp4'), false); // padded + noise
  assert.equal(isNormalizedName('1080p.mp4'), false);
  assert.equal(isNormalizedName('@nya2p.comipx-920会所最新更新热片.mp4'), false);
});
