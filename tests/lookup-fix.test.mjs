// F16 反查修复：javbus 关键词搜索（演员名/标题片段）+ manko 番号回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSearchItems } from '../src/sources/javbus.mjs';
import { createLookup } from '../src/sources/lookup.mjs';
import { makeMankoSearchJson } from './helpers/factory.mjs';

const SEARCH_HTML = `
<div id="waterfall">
  <div class="item">
    <a class="movie-box" href="https://www.javbus.com/FNS-257">
      <div class="photo-frame"><img src="/pics/thumb/cmj3.jpg" title="お互いの恋人に浮気された… 明里つむぎ"></div>
      <div class="photo-info"><span>…<date>FNS-257</date> / <date>2026-10-22</date></span></div>
    </a>
  </div>
  <div class="item">
    <a class="movie-box" href="https://www.javbus.com/FNS-207">
      <div class="photo-frame"><img src="/pics/thumb/cbmj.jpg" title="セックスの相性… 明里つむぎ"></div>
      <div class="photo-info"><span>…<date>FNS-207</date> / <date>2026-06-18</date></span></div>
    </a>
  </div>
  <div class="item">
    <a class="movie-box" href="https://www.javbus.com/FNS-257">
      <div class="photo-frame"><img src="/pics/thumb/cmj3.jpg" title="duplicate"></div>
      <div class="photo-info"><span>…<date>FNS-257</date> / <date>2026-10-22</date></span></div>
    </a>
  </div>
</div>`;

const CODE_SEARCH_HTML = `
<div id="waterfall">
  <div class="item"><a class="movie-box" href="https://www.javbus.com/IPX-921">
    <div class="photo-frame"><img src="/pics/thumb/a.jpg" title="other"></div>
    <div class="photo-info"><span>…<date>IPX-921</date> / <date>2022-01-01</date></span></div>
  </a></div>
  <div class="item"><a class="movie-box" href="https://www.javbus.com/IPX-920">
    <div class="photo-frame"><img src="/pics/thumb/b.jpg" title="wanted"></div>
    <div class="photo-info"><span>…<date>IPX-920</date> / <date>2022-08-05</date></span></div>
  </a></div>
</div>`;

function javbusHttp(html, { fail = false } = {}) {
  return {
    getFollow: async (url) => {
      if (fail) throw Object.assign(new Error('javbus down'), { code: 'NET_ERR' });
      if (String(url).includes('javbus.com/search/')) return { status: 200, text: html, url, route: 'proxy' };
      throw Object.assign(new Error('unexpected url ' + url), { code: 'NET_ERR' });
    },
  };
}

function mankoHttp(payloadJson) {
  return {
    getFollow: async (url) => {
      if (String(url).includes('healertanker.com') || String(url).includes('alpharomeo.shop')) {
        return { status: 200, text: payloadJson, url, route: 'direct' };
      }
      throw Object.assign(new Error('javbus down'), { code: 'NET_ERR' });
    },
  };
}

test('parseSearchItems 解析番号/标题/封面/日期并去重', () => {
  const items = parseSearchItems(SEARCH_HTML);
  assert.equal(items.length, 2, 'duplicate code must be dropped');
  assert.equal(items[0].code, 'FNS-257');
  assert.equal(items[0].url, 'https://www.javbus.com/FNS-257');
  assert.match(items[0].title, /明里つむぎ/);
  assert.equal(items[0].coverUrl, 'https://www.javbus.com/pics/thumb/cmj3.jpg');
  assert.equal(items[0].releaseDate, '2026-10-22');
  assert.equal(parseSearchItems(SEARCH_HTML, { limit: 1 }).length, 1);
  assert.deepEqual(parseSearchItems(''), []);
});

test('lookup 通过 javbus 关键词搜索返回演员名候选', async () => {
  const lookup = createLookup({ http: javbusHttp(SEARCH_HTML), config: {} });
  const candidates = await lookup.byKeyword('明里つむぎ', { limit: 10 });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].source, 'javbus');
  assert.equal(candidates[0].code, 'FNS-257');
  assert.match(candidates[0].title, /明里つむぎ/);
  assert.equal(candidates[0].coverUrl, 'https://www.javbus.com/pics/thumb/cmj3.jpg');
  // 日期倒序
  assert.deepEqual(candidates.map((c) => c.code), ['FNS-257', 'FNS-207']);
});

test('lookup 输入番号时精确候选优先', async () => {
  const lookup = createLookup({ http: javbusHttp(CODE_SEARCH_HTML), config: {} });
  const candidates = await lookup.byKeyword('IPX-920');
  assert.equal(candidates[0].code, 'IPX-920');
  assert.equal(candidates[1].code, 'IPX-921');
});

test('lookup 在 javbus 不可用时回退 manko（番号）', async () => {
  const envelope = makeMankoSearchJson([
    { title: 'IPX-920', _id: 'abc', share_date: '2022-08-05', wide_thumbnail: 'https://img/x.jpg', maker: 'IDEA' },
  ]);
  const lookup = createLookup({ http: mankoHttp(envelope), config: {} });
  const candidates = await lookup.byKeyword('IPX-920');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].source, 'manko');
  assert.equal(candidates[0].movieId, 'abc');
});

test('lookup 两个源都失败时抛错', async () => {
  const failing = {
    getFollow: async () => { throw Object.assign(new Error('all down'), { code: 'NET_ERR' }); },
  };
  const lookup = createLookup({ http: failing, config: {} });
  await assert.rejects(() => lookup.byKeyword('明里つむぎ'));
});
