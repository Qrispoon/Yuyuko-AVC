import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, toLookupVariants } from '../src/core/code.mjs';
import { normalizeManualCode, canonCode } from '../src/pipeline.mjs';

// 用户大测试集里"无法识别"的真实文件名（v0.4.4 修复）
const FIXTURES = [
  ['CAWD-315_CH-nyap2p.com.mp4', 'CAWD-315'],
  ['CAWD-350_CH-nyap2p.com.mp4', 'CAWD-350'],
  ['DASS-201_CH-nyap2p.com.mp4', 'DASS-201'],
  ['FSDSS-242_CH-nyap2p.com.mp4', 'FSDSS-242'],
  ['FSDSS-421_CH-nyap2p.com.mp4', 'FSDSS-421'],
  ['IPX-475-uncensored-nyap2p.com.mp4', 'IPX-475'],
  ['IPX-848_CH-nyap2p.com.mp4', 'IPX-848'],
  ['IPZZ-162-uncensored-nyap2p.com.mp4', 'IPZZ-162'],
  ['SSIS-374_CH-nyap2p.com.mp4', 'SSIS-374'],
  ['SSIS-595_CH-nyap2p.com.mp4', 'SSIS-595'],
  ['SSNI-535-uncensored-nyap2p.com.mp4', 'SSNI-535'],
];

for (const [name, expected] of FIXTURES) {
  test(`extracts ${expected} from ${name}`, () => {
    const { candidates, notes } = extractCandidates(name);
    assert.ok(candidates.length > 0, `no candidates; notes=${notes.join(',')}`);
    assert.equal(candidates[0].code, expected);
  });
}

test('glued studio suffix: pgd00844hhb_000 -> PGD-00844 (variants include PGD-844)', () => {
  const { candidates } = extractCandidates('pgd00844hhb_000.mp4');
  assert.ok(candidates.length > 0, 'should find a candidate');
  assert.equal(candidates[0].code, 'PGD-00844');
  const variants = toLookupVariants(candidates[0].code);
  assert.ok(variants.includes('PGD-844'), 'must try the zero-stripped form');
});

test('ad-domain rule does not swallow a hyphenated code', () => {
  const { candidates } = extractCandidates('ipx-475-uncensored-any-domain.com.mp4');
  assert.equal(candidates[0].code, 'IPX-475');
});

test('manual code keeps official leading zeros', () => {
  assert.equal(normalizeManualCode('MIDE-001'), 'MIDE-001');
  assert.equal(normalizeManualCode('ssis 001'), 'SSIS-001');
  assert.equal(normalizeManualCode('ipx920'), 'IPX-920');
  assert.equal(normalizeManualCode('  abp-0984 '), 'ABP-0984');
  assert.equal(normalizeManualCode('not a code'), null);
});

test('canonCode treats padded and unpadded numbers as equal', () => {
  assert.equal(canonCode('MIDE-001'), canonCode('MIDE-1'));
  assert.equal(canonCode('SSIS-001'), canonCode('SSIS-1'));
  assert.equal(canonCode('MIDE-001'), 'MIDE-1');
  assert.equal(canonCode('SSIS-001'), 'SSIS-1');
  assert.notEqual(canonCode('MIDE-001'), canonCode('MIDE-991'));
});
