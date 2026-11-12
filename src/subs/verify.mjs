// Subtitle verification: encoding detection, SRT structural parsing, Simplified-vs-Traditional
// classification, and an overall accept/reject verdict.
//
// Zero dependencies. Encoding detection uses Node's built-in ICU TextDecoder
// (utf-8 / gb18030 / big5), with a replacement-character + CJK-plausibility heuristic
// to pick between the two legacy Chinese encodings.
import fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Simplified <-> Traditional character evidence
// ---------------------------------------------------------------------------
// Only unambiguous one-to-one variant pairs: every "simplified-only" character must not
// appear in normal Traditional text and vice versa. Ambiguous characters (e.g. 只/隻,
// 干/幹, 台/臺, 里 is kept out) are deliberately excluded.
const VARIANT_PAIRS = [
  ['这', '這'], ['说', '說'], ['时', '時'], ['国', '國'], ['东', '東'], ['车', '車'], ['马', '馬'],
  ['门', '門'], ['问', '問'], ['间', '間'], ['关', '關'], ['对', '對'], ['动', '動'], ['过', '過'],
  ['还', '還'], ['进', '進'], ['头', '頭'], ['发', '發'], ['长', '長'], ['来', '來'], ['见', '見'],
  ['电', '電'], ['话', '話'], ['语', '語'], ['认', '認'], ['识', '識'], ['为', '為'], ['个', '個'],
  ['们', '們'], ['开', '開'], ['无', '無'], ['与', '與'], ['业', '業'], ['专', '專'], ['书', '書'],
  ['买', '買'], ['卖', '賣'], ['点', '點'], ['热', '熱'], ['爱', '愛'], ['风', '風'], ['飞', '飛'],
  ['习', '習'], ['乐', '樂'], ['样', '樣'], ['儿', '兒'], ['后', '後'], ['会', '會'], ['义', '義'],
  ['议', '議'], ['让', '讓'], ['请', '請'], ['谢', '謝'], ['谁', '誰'], ['吗', '嗎'], ['资', '資'],
  ['讯', '訊'], ['网', '網'], ['络', '絡'], ['视', '視'], ['频', '頻'], ['声', '聲'], ['设', '設'],
  ['备', '備'], ['图', '圖'], ['画', '畫'], ['线', '線'], ['试', '試'], ['验', '驗'], ['证', '證'],
  ['实', '實'], ['际', '際'], ['优', '優'], ['质', '質'], ['员', '員'], ['题', '題'], ['别', '別'],
  ['张', '張'], ['难', '難'], ['应', '應'], ['该', '該'], ['总', '總'], ['阶', '階'], ['级', '級'],
  ['结', '結'], ['构', '構'], ['处', '處'], ['务', '務'], ['组', '組'], ['织', '織'], ['计', '計'],
  ['划', '劃'], ['经', '經'], ['济', '濟'], ['战', '戰'], ['斗', '鬥'], ['军', '軍'], ['听', '聽'],
  ['读', '讀'], ['写', '寫'], ['学', '學'], ['觉', '覺'], ['现', '現'], ['边', '邊'], ['当', '當'],
  ['双', '雙'], ['万', '萬'], ['岁', '歲'], ['从', '從'], ['带', '帶'], ['帮', '幫'], ['变', '變'],
  ['态', '態'], ['环', '環'], ['场', '場'], ['转', '轉'], ['换', '換'], ['数', '數'], ['据', '據'],
  ['节', '節'], ['规', '規'], ['压', '壓'], ['执', '執'], ['气', '氣'], ['体', '體'], ['欢', '歡'],
  ['满', '滿'], ['种', '種'], ['类', '類'], ['给', '給'], ['兴', '興'], ['财', '財'], ['术', '術'],
  ['药', '藥'], ['产', '產'], ['亲', '親'], ['独', '獨'], ['顾', '顧'], ['愿', '願'], ['惊', '驚'],
  ['惨', '慘'], ['骗', '騙'], ['贼', '賊'], ['杀', '殺'], ['伤', '傷'], ['抢', '搶'], ['么', '麼'],
  ['页', '頁'], ['够', '夠'], ['湿', '濕'], ['痒', '癢'], ['贝', '貝'], ['恋', '戀'], ['温', '溫'],
  ['梦', '夢'], ['抚', '撫'], ['紧', '緊'], ['严', '嚴'], ['迟', '遲'], ['尽', '盡'], ['层', '層'],
  ['属', '屬'], ['岛', '島'], ['币', '幣'], ['师', '師'], ['庆', '慶'], ['库', '庫'], ['广', '廣'],
  ['庄', '莊'], ['闭', '閉'], ['闻', '聞'], ['阳', '陽'], ['阴', '陰'], ['陆', '陸'], ['险', '險'],
  ['随', '隨'], ['虽', '雖'], ['终', '終'], ['绿', '綠'], ['罗', '羅'], ['罚', '罰'], ['职', '職'],
  ['联', '聯'], ['脑', '腦'], ['脸', '臉'], ['举', '舉'], ['旧', '舊'], ['艺', '藝'], ['华', '華'],
  ['协', '協'], ['单', '單'], ['卫', '衛'], ['历', '歷'], ['厅', '廳'], ['县', '縣'], ['烟', '煙'],
  ['厌', '厭'], ['妇', '婦'], ['尔', '爾'], ['摊', '攤'], ['颜', '顏'],
];
// de-duplicate pairs while keeping the derived sets disjoint and deterministic
const seenPairs = new Set();
const SIMPLIFIED_ONLY = new Set();
const TRADITIONAL_ONLY = new Set();
for (const [simp, trad] of VARIANT_PAIRS) {
  const key = `${simp}|${trad}`;
  if (seenPairs.has(key) || simp === trad) continue;
  seenPairs.add(key);
  SIMPLIFIED_ONLY.add(simp);
  TRADITIONAL_ONLY.add(trad);
}

/** @returns {{ simplifiedHits:number, traditionalHits:number, verdict:'zh-CN'|'zh-TW'|'unknown' }} */
export function classifyChinese(text, opts = {}) {
  const minHits = opts.minHits == null ? 3 : opts.minHits;
  const s = String(text || '');
  let simplifiedHits = 0;
  let traditionalHits = 0;
  for (const ch of s) {
    if (SIMPLIFIED_ONLY.has(ch)) simplifiedHits++;
    else if (TRADITIONAL_ONLY.has(ch)) traditionalHits++;
  }
  let verdict = 'unknown';
  if (simplifiedHits > traditionalHits && simplifiedHits >= minHits) verdict = 'zh-CN';
  else if (traditionalHits > simplifiedHits && traditionalHits >= minHits) verdict = 'zh-TW';
  return { simplifiedHits, traditionalHits, verdict };
}

// ---------------------------------------------------------------------------
// Encoding detection
// ---------------------------------------------------------------------------
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWithBytes(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function decodeUtf16be(buf) {
  const swapped = Buffer.from(buf);
  for (let i = 0; i + 1 < swapped.length; i += 2) {
    const t = swapped[i];
    swapped[i] = swapped[i + 1];
    swapped[i + 1] = t;
  }
  return swapped.toString('utf16le');
}

/** Try a strict UTF-8 decode. Returns null when the bytes are not valid UTF-8. */
function tryStrictUtf8(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const REPLACEMENT_RE = /\uFFFD/g;
const ASCII_RE = /[\x20-\x7E]/g;
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Plausibility score for a candidate decode; higher is better. */
function scoreDecoded(text) {
  if (!text) return 0;
  const fffd = (text.match(REPLACEMENT_RE) || []).length;
  const cjk = (text.match(CJK_RE) || []).length;
  const ascii = (text.match(ASCII_RE) || []).length;
  const ctrl = (text.match(CTRL_RE) || []).length;
  const { simplifiedHits, traditionalHits } = classifyChinese(text);
  // Real Chinese text yields many common feature characters; wrong legacy decodings
  // mostly yield rare CJK glyphs / replacement chars.
  return cjk * 2 + (simplifiedHits + traditionalHits) * 4 + ascii * 0.1 - fffd * 120 - ctrl * 30;
}

function decodeLegacy(buf, encoding) {
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Decode a subtitle buffer to UTF-8 text.
 * Strips BOM (UTF-8 / UTF-16 LE / UTF-16 BE), then probes UTF-8 → GB18030 → BIG5.
 * @param {Buffer|Uint8Array} buffer
 * @param {{forceEncoding?:string, encodings?:string[]}} [opts]
 * @returns {{ text:string, encoding:string, hadBom:boolean }}
 */
export function decodeToUtf8(buffer, opts = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const rawStrings = opts.encodings || ['gb18030', 'big5'];

  if (startsWithBytes(buf, UTF8_BOM)) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8', hadBom: true };
  }
  if (startsWithBytes(buf, UTF16LE_BOM)) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', hadBom: true };
  }
  if (startsWithBytes(buf, UTF16BE_BOM)) {
    return { text: decodeUtf16be(buf.subarray(2)), encoding: 'utf-16be', hadBom: true };
  }
  if (buf.length === 0) return { text: '', encoding: 'utf-8', hadBom: false };

  if (opts.forceEncoding) {
    const forced = decodeLegacy(buf, opts.forceEncoding);
    if (forced == null) throw Object.assign(new Error(`UNSUPPORTED_ENCODING ${opts.forceEncoding}`), { encoding: opts.forceEncoding });
    return { text: forced, encoding: opts.forceEncoding, hadBom: false };
  }

  const utf8 = tryStrictUtf8(buf);
  if (utf8 != null) return { text: utf8, encoding: 'utf-8', hadBom: false };

  // Legacy Chinese encodings: pick the most plausible decode.
  let best = null;
  for (const encoding of rawStrings) {
    const text = decodeLegacy(buf, encoding);
    if (text == null) continue;
    const score = scoreDecoded(text);
    if (!best || score > best.score) best = { text, encoding, score };
  }
  if (best) return { text: best.text, encoding: best.encoding, hadBom: false };

  // Last resort: lossy UTF-8 (keeps replacement markers visible).
  return { text: buf.toString('utf8'), encoding: 'utf-8', hadBom: false };
}

// ---------------------------------------------------------------------------
// SRT parsing
// ---------------------------------------------------------------------------
// Tolerates CRLF / LF / CR mixing, BOM-less text, missing numeric indices and
// comma/dot millisecond separators.
const TIMING_RE = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function timingToSec(h, m, s, frac) {
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + ms / 1000;
}

/**
 * Parse SRT text into cues with seconds-based timing.
 * @returns {{ cues:Array<{index:number,start:number,end:number,text:string}>,
 *             count:number, lastEndSec:number, problems:string[] }}
 */
export function parseSrt(text) {
  const cues = [];
  const problemSet = new Set();
  if (text == null) return { cues, count: 0, lastEndSec: 0, problems: ['empty'] };
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n[ \t]*\n+/);
  let prevStart = -Infinity;

  for (const blockRaw of blocks) {
    const block = blockRaw.replace(/^\n+|\n+$/g, '');
    if (!block.trim()) continue;
    const lines = block.split('\n');
    let timingLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (TIMING_RE.test(lines[i])) { timingLine = i; break; }
    }
    if (timingLine < 0) {
      // WEBVTT header or stray text block; only mark it if it looks like a cue block.
      if (/\d{1,3}:\d{2}:\d{2}/.test(block)) problemSet.add('malformed_block');
      continue;
    }
    const m = lines[timingLine].match(TIMING_RE);
    const start = timingToSec(m[1], m[2], m[3], m[4]);
    const end = timingToSec(m[5], m[6], m[7], m[8]);
    let index = cues.length + 1;
    if (timingLine > 0) {
      const maybe = lines[timingLine - 1].trim();
      if (/^\d+$/.test(maybe)) index = Number(maybe);
    }
    const cueText = lines.slice(timingLine + 1).join('\n').replace(/\s+$/g, '');
    cues.push({ index, start, end, text: cueText });

    if (end < start) problemSet.add('reversed_timing');
    if (start + 0.001 < prevStart) problemSet.add('out_of_order');
    prevStart = start;
  }

  let lastEndSec = 0;
  for (const cue of cues) if (cue.end > lastEndSec) lastEndSec = cue.end;
  if (!cues.length) problemSet.add('no_cues');
  return { cues, count: cues.length, lastEndSec, problems: [...problemSet] };
}

// ---------------------------------------------------------------------------
// Overall verification
// ---------------------------------------------------------------------------
/**
 * @param {{buffer:Buffer, expectedDurationMin?:number, lang?:string,
 *          maxDurationDeltaMin?:number, allowTraditional?:boolean}} input
 * @returns {{ ok:boolean, verdict:string, encoding:string, cues:number,
 *             lastEndSec:number, durationDeltaMin:number|null,
 *             warnings:string[], reason:string|null, problems:string[], hadBom:boolean }}
 */
export function verifySubtitle(input = {}) {
  const {
    buffer,
    expectedDurationMin = null,
    lang = 'zh',
    maxDurationDeltaMin = 5,
    allowTraditional = false,
  } = input;

  const warnings = [];
  const decoded = decodeToUtf8(buffer);
  const { text, encoding, hadBom } = decoded;

  const result = {
    ok: false,
    verdict: 'unknown',
    encoding,
    cues: 0,
    lastEndSec: 0,
    durationDeltaMin: null,
    warnings,
    reason: null,
    problems: [],
    hadBom,
  };

  if (!text || !text.trim()) {
    result.reason = 'empty';
    return result;
  }

  const parsed = parseSrt(text);
  const verdict = classifyChinese(text).verdict;
  result.cues = parsed.count;
  result.lastEndSec = parsed.lastEndSec;
  result.problems = parsed.problems;
  result.verdict = verdict;

  if (parsed.count === 0) {
    result.reason = 'no_cues';
    return result;
  }
  if (verdict === 'zh-TW' && !allowTraditional && !String(lang).toLowerCase().startsWith('zh-tw')) {
    result.reason = 'traditional_only';
    return result;
  }
  if (parsed.problems.includes('reversed_timing')) {
    result.reason = 'reversed_timing';
    return result;
  }
  if (parsed.problems.includes('out_of_order')) warnings.push('out_of_order');
  if (verdict === 'unknown') warnings.push('lang_uncertain');

  const expectedMin = Number(expectedDurationMin);
  if (Number.isFinite(expectedMin) && expectedMin > 0) {
    const delta = result.lastEndSec / 60 - expectedMin;
    result.durationDeltaMin = Math.round(Math.abs(delta) * 100) / 100;
    if (Math.abs(delta) > maxDurationDeltaMin) warnings.push('duration_mismatch');
  }

  result.ok = true;
  result.reason = null;
  return result;
}

/** Convenience helper: read a subtitle file from disk and verify it. */
export async function verifySubtitleFile(filePath, opts = {}) {
  const buffer = await fs.readFile(filePath);
  return verifySubtitle({ ...opts, buffer });
}
