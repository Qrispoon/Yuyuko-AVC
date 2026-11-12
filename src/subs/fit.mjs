// 字幕时间轴校正：常量平移 / 线性缩放 / 自动兜底。
// 只处理 SRT 文本，不读取视频内容。
import { parseSrt } from './verify.mjs';

const TIMING_LINE = /^([ \t]*)(\d{1,3}:[0-5]\d:[0-5]\d,\d{3})([ \t]*-->[ \t]*)(\d{1,3}:[0-5]\d:[0-5]\d,\d{3})([^\r\n]*)$/gm;

export function parseSeconds(text) {
  const all = [...String(text || '').matchAll(/\b(\d{1,3}):([0-5]\d):([0-5]\d),(\d{3})(?!\d)\s*-->\s*(\d{1,3}):([0-5]\d):([0-5]\d),(\d{3})(?!\d)/g)];
  if (!all.length) return { first: null, last: null, count: 0 };
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const first = toSec(all[0][1], all[0][2], all[0][3], all[0][4]);
  const last = toSec(all[all.length - 1][5], all[all.length - 1][6], all[all.length - 1][7], all[all.length - 1][8]);
  return { first, last, count: all.length };
}

function fmt(sec) {
  if (!Number.isFinite(sec)) throw fitError('non_finite_timestamp');
  // Round once, before splitting units: 0.9996s is 1s, never ",1000".
  const total = Math.round(Math.max(0, sec) * 1000);
  if (!Number.isSafeInteger(total) || total > 3599999999) throw fitError('timestamp_out_of_range');
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function fitError(reason) {
  return Object.assign(new RangeError(`INVALID_SUBTITLE_TIMING: ${reason}`), { code: 'INVALID_SUBTITLE_TIMING', reason });
}

function mapTimestamps(text, fn) {
  const input = String(text || '');
  const before = parseSrt(input);
  const convert = timestamp => {
    const [h, mi, s, ms] = timestamp.split(/[:,]/).map(Number);
    return fmt(fn(h * 3600 + mi * 60 + s + ms / 1000));
  };
  const output = input.replace(TIMING_LINE, (line, prefix, start, arrow, end, suffix) => {
    return prefix + convert(start) + arrow + convert(end) + suffix;
  });
  if (before.count) {
    const after = parseSrt(output);
    if (before.problems.includes('malformed_block') || before.problems.includes('reversed_timing') ||
        after.count !== before.count || after.problems.includes('malformed_block') ||
        after.problems.includes('reversed_timing') || after.problems.includes('out_of_order') && !before.problems.includes('out_of_order') ||
        after.cues.some((cue, i) => cue.end <= cue.start || cue.text !== before.cues[i].text || cue.index !== before.cues[i].index)) {
      throw fitError('invalid_transformed_cues');
    }
  }
  return output;
}

/** 整体平移（秒，可为负）。 */
export function shiftSrt(text, seconds) {
  const shift = Number(seconds);
  if (!Number.isFinite(shift)) throw fitError('invalid_shift');
  return mapTimestamps(text, (sec) => sec + shift);
}

/** 线性缩放（factor = 目标时长 / 当前时长）。 */
export function scaleSrt(text, factor) {
  const scale = Number(factor);
  if (!Number.isFinite(scale) || scale <= 0) throw fitError('invalid_scale');
  return mapTimestamps(text, (sec) => sec * scale);
}

/**
 * 自动校正策略（保守）：
 *  - 视频时长未知 → 不处理
 *  - 字幕末条超出视频时长（> tolerance）→ 按比例缩放到视频时长内（防末条超出 EOF）
 *  - 其余情况不动（避免把正常字幕平移错）
 * @returns {{text:string, applied:'none'|'scale'|'shift', factor?:number, shiftSec?:number, reason?:string}}
 */
export function autoFitSrt(text, { videoDurationSec, mode = 'auto', toleranceSec = 2, maxShiftSec = 90 } = {}) {
  videoDurationSec = Number(videoDurationSec);
  toleranceSec = Number(toleranceSec);
  maxShiftSec = Number(maxShiftSec);
  const { last } = parseSeconds(text);
  if (!last || !Number.isFinite(videoDurationSec) || videoDurationSec <= 0) {
    return { text, applied: 'none', reason: 'no_duration' };
  }
  if (!Number.isFinite(toleranceSec) || toleranceSec < 0 || !Number.isFinite(maxShiftSec) || maxShiftSec < 0) {
    return { text, applied: 'none', reason: 'invalid_fit_options' };
  }
  const overflow = last - videoDurationSec;
  // 安全护栏：末条时间离谱（超过片长 3 倍）或缩放系数极端（<0.5 / >2）时不动，
  // 大概率是字幕时间戳损坏或选错了字幕，强行缩放会毁掉字幕。
  if (last > videoDurationSec * 3) {
    return { text, applied: 'none', reason: 'last_cue_unreasonable' };
  }

  if (mode === 'none') return { text, applied: 'none', reason: 'disabled' };

  if (mode === 'scale') {
    const factor = (videoDurationSec - 1) / last;
    if (Math.abs(factor - 1) < 1e-4) return { text, applied: 'none', reason: 'already_fit' };
    if (factor < 0.5 || factor > 2) return { text, applied: 'none', reason: 'scale_out_of_range' };
    return { text: scaleSrt(text, factor), applied: 'scale', factor };
  }

  if (mode === 'shift') {
    const shift = videoDurationSec - last - 1;
    if (Math.abs(shift) > maxShiftSec || Math.abs(shift) < 1) return { text, applied: 'none', reason: 'shift_out_of_range' };
    return { text: shiftSrt(text, shift), applied: 'shift', shiftSec: shift };
  }

  // auto
  if (overflow > toleranceSec) {
    const factor = (videoDurationSec - 1) / last;
    if (factor < 0.5 || factor > 2) return { text, applied: 'none', reason: 'scale_out_of_range' };
    return { text: scaleSrt(text, factor), applied: 'scale', factor, reason: 'overflow' };
  }
  return { text, applied: 'none', reason: 'within_tolerance' };
}

export default { parseSeconds, shiftSrt, scaleSrt, autoFitSrt };
