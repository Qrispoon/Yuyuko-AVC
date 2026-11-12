// Pure in-memory A19 regression. No fixtures, subprocesses, services or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftSrt, scaleSrt, autoFitSrt, parseSeconds } from '../src/subs/fit.mjs';
import { parseSrt } from '../src/subs/verify.mjs';

test('A19: timestamp-shaped dialogue is preserved while the timing line changes', () => {
  const text = '1\r\n00:00:01,000 --> 00:00:02,000\r\nMeeting at 00:00:01,000\r\n';
  const result = shiftSrt(text, 2);
  assert.ok(result.includes('00:00:03,000 --> 00:00:04,000'));
  assert.equal(parseSrt(result).cues[0].text, 'Meeting at 00:00:01,000');
});

const cue = (start, end, text = 'Synthetic subtitle') => `1\n${start} --> ${end}\n${text}\n`;

test('A19: one millisecond rounding carries through seconds, minutes and hours', () => {
  for (const [input, expected] of [
    ['00:00:00,999', '00:00:01,000'],
    ['00:00:59,999', '00:01:00,000'],
    ['00:59:59,999', '01:00:00,000'],
    ['99:59:59,999', '100:00:00,000'],
  ]) {
    const result = shiftSrt(cue(input, '101:00:00,000'), 0.0006);
    assert.equal(result.split('\n')[1].split(' --> ')[0], expected);
  }
  assert.ok(shiftSrt(cue('00:00:00,999', '00:00:02,000'), 0.0004).includes('00:00:00,999 -->'));
  assert.ok(shiftSrt(cue('00:00:01,000', '00:00:02,000'), -1).includes('00:00:00,000 -->'));
});

test('A19: historical scale case retains both cues and their text', () => {
  const input = cue('00:00:01,000', '00:00:02,000', 'First') + '\n2\n00:00:10,000 --> 00:00:14,000\nSecond\n';
  const fitted = autoFitSrt(input, { mode: 'scale', videoDurationSec: 14.9972 });
  const parsed = parseSrt(fitted.text);
  assert.equal(fitted.applied, 'scale');
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.cues.map(c => c.text), ['First', 'Second']);
  assert.ok(!fitted.text.includes(',1000'));
  assert.equal(parsed.cues[0].start, 1);
  assert.equal(parsed.cues[0].end, 2);
});

test('A19: finite parameters and non-collapsed cue intervals are required', () => {
  const input = cue('00:00:01,000', '00:00:02,000');
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => shiftSrt(input, value), { code: 'INVALID_SUBTITLE_TIMING' });
    assert.throws(() => scaleSrt(input, value), { code: 'INVALID_SUBTITLE_TIMING' });
  }
  for (const value of [0, -1, 1e30]) assert.throws(() => scaleSrt(input, value), { code: 'INVALID_SUBTITLE_TIMING' });
  assert.throws(() => shiftSrt(input, -3), { code: 'INVALID_SUBTITLE_TIMING' });
  assert.throws(() => scaleSrt(input, 0.000001), { code: 'INVALID_SUBTITLE_TIMING' });
});

test('A19: none and valid shift/auto retain text, count and order', () => {
  const input = cue('00:00:01,000', '00:00:03,000', '这是一条合成测试字幕');
  assert.equal(autoFitSrt(input, { mode: 'none', videoDurationSec: 30 }).text, input);
  assert.deepEqual(parseSrt(shiftSrt(input, 1)).cues.map(c => [c.start, c.end, c.text]), [[2, 4, '这是一条合成测试字幕']]);
  assert.equal(autoFitSrt(input, { videoDurationSec: 30 }).applied, 'none');
  assert.equal(autoFitSrt(input, { videoDurationSec: Infinity }).reason, 'no_duration');
  assert.equal(autoFitSrt(input, { videoDurationSec: 30, toleranceSec: NaN }).reason, 'invalid_fit_options');
  assert.deepEqual(parseSeconds(cue('100:00:00,000', '100:00:01,000')), { first: 360000, last: 360001, count: 1 });
});

test('A19: malformed source cannot be silently transformed into fewer cues', () => {
  const malformed = cue('00:00:01,000', '00:00:02,000') + '\n2\n00:00:03,1000 --> 00:00:04,000\nBroken\n';
  assert.throws(() => scaleSrt(malformed, 1.2), { code: 'INVALID_SUBTITLE_TIMING' });
});
