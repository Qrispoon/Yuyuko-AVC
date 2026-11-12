// r18.dev 代理回退：直连失败但配置了代理时，自动走代理重试一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createR18 } from '../src/sources/r18.mjs';

const DETAIL = {
  dvd_id: 'IPX-920',
  title: 'テスト',
  release_date: '2022-08-05',
  runtime_minutes: 120,
  maker_name: 'IDEA POCKET',
  genres: [{ name: '単体作品' }],
  actresses: [{ name: '明里つむぎ' }],
  images: { jacket_image: { large_url: 'https://img.example/x.jpg' } },
};

test('r18：直连失败且已配置代理时回退到 proxy 路由', async () => {
  const calls = [];
  const http = {
    config: { proxy: 'http://127.0.0.1:10090' },
    getFollow: async (url, opts = {}) => {
      calls.push(opts.route || 'default');
      if (opts.route !== 'proxy') throw Object.assign(new Error('ECONNRESET'), { code: 'NET_ERR' });
      return { status: 200, text: JSON.stringify(DETAIL), url };
    },
  };
  const r18 = createR18(http);
  const meta = await r18.findByCode('IPX-920');
  assert.ok(meta, 'meta should be resolved through the proxy fallback');
  assert.equal(meta.code, 'IPX-920');
  assert.equal(meta.durationMin, 120);
  assert.equal(meta.actress[0], '明里つむぎ');
  assert.deepEqual(calls.slice(0, 2), ['default', 'proxy']);
});

test('r18：未配置代理时不回退，直接抛错', async () => {
  let attempts = 0;
  const http = {
    config: { proxy: null },
    getFollow: async () => {
      attempts++;
      throw Object.assign(new Error('ECONNRESET'), { code: 'NET_ERR' });
    },
  };
  const r18 = createR18(http);
  await assert.rejects(() => r18.findByCode('IPX-920'), (e) => e.code === 'R18_HTTP');
  assert.equal(attempts, 1);
});
