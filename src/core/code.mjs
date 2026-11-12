// Number (code) extraction for JAV file names.
//
// Candidates are classified with a `scope` field so the pipeline can decide what
// to do without re-parsing names:
//   'censored' — mainstream studio label (the only in-scope kind)
//   'fc2'      — FC2-PPV / FC2
//   'heyzo'    — HEYZO (uncensored-only studio)
//   'series'   — amateur/date-code series: 10musume / 1pondo / caribbeancom / ...
//   'unknown'  — a code-like token we could not classify
// The pipeline skips any `scope !== 'censored'` file and reports it as
// out-of-scope, without querying metadata/subtitles.
//
// Zero dependencies, Node >= 22 (regular-expression lookbehind is used).
//
// Pipeline for one file name:
//   basename -> strip extension -> NFKC/lowercase -> strip ad domains (NO trailing
//   word boundary: `@nya2p.comipx-920` is glued) -> strip CJK promo text -> strip
//   quality/format noise -> multi-rule candidate generation -> score -> dedupe/sort.

const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.wmv', '.mov', '.flv', '.ts', '.m2ts', '.mts', '.m2t',
  '.rmvb', '.rm', '.webm', '.mpg', '.mpeg', '.m4v', '.3gp', '.ogv', '.vob',
  '.iso', '.asf', '.divx', '.f4v', '.dat', '.tp', '.trp',
]);

// Mainstream censored-label table (lowercase). Used only for ranking: an unknown
// label is still a valid candidate, it just scores lower.
const KNOWN_LABELS = new Set(
  `abp abw abs aby abz adn aika aki akbs apex apns aroma asw atid avop
   bgn bkd bokd
   cawd cead chn chrv cnd cwp
   dand dasd ddt dldss dmx docp doks dvaj dvdms dwd
   ebod ebwh ekdv emaz emoi etqz
   fan fns fsdss
   gigl giro gmem gne gvh
   hans hdz hjt hmn hnd hodv homa hone hunta
   iess ipit iptd ipx ipz ipzz
   jfb jkn jks jmty jrzd jul juq juy
   kagp kagr kaho kawd kmhr knmb kpx ktds kuse
   lady lae lux
   maan maid mane mbt mdd mds meyd miaa miae mibd mide midv mifd migd mik mird mism miu mizd mkd mmp mntj msfh msz mudr mukd
   nacs natr nawz nene ngod nhdta nkkd nmnp npx nsfs ntk nttr
   ofje okb onez onib onsd oppai ore ovg
   pppd pred prst pstu ptj
   rbd rbc rctd rki rmd rng royd
   saba sacr saim savr sdde sden sdmf sdmu sdtm seat sek sga shkd silk sim siro snf snis sod sone sono sshn ssis ssni sspd sss stars start stol suji suke syd
   tek tki tpp tpr tsubomi ttt tus
   vec venx vrtm
   waaa wanz
   xrw xvsr
   ymdd yrmd
   zex`.split(/\s+/).filter(Boolean),
);

// Labels that are almost always format/quality/part markers, never real codes.
const NOISE_LABELS = new Set(
  `cd dvd bd br hd fhd uhd sd hq lq web hdtv tv mp mp4 mkv avi wmv mov flv
   part pt vol disc disk ep episode chs cht zh cn ch jp eng sub subs subbed
   dubbed chinese uncensored leak crack cracked sample trailer preview
   x264 x265 h264 h265 hevc avc vp9 av1 aac ac3 dts flac hdr sdr 10bit 8bit
   cd1 cd2 cd3 disc1 disc2 part1 part2 vol1 vol2`.split(/\s+/).filter(Boolean),
);

// Amateur / date-code series (out of scope but still extracted so the report can
// say *why* a file was skipped). Longest alternatives first.
const SERIES_LABEL_ALT =
  '10musume|10mu|1pondo|1pon|caribbeancom|caribbean|carib|pacopacomama|pacopaco|muramura|gachinco|heydouga|tokyo[\\s-]?hot|xxx[\\s-]?av|h0930|h4610|mirei';
const SERIES_LABELS = new Set([
  '10musume', '10mu', '1pondo', '1pon', 'caribbeancom', 'caribbean', 'carib',
  'pacopacomama', 'pacopaco', 'muramura', 'gachinco', 'heydouga', 'tokyohot',
  'xxxav', 'h0930', 'h4610', 'mirei',
]);

// Out-of-scope category detection. Matched against the cleaned lowercase name,
// so `-`/`_`/spaces already became spaces. FC2 is matched loosely because the
// glued form `fc2ppv1234567` is common; other labels must be followed by a
// non-letter (digits/space/end) so `caribbeancom123456` is still caught.
const RE_OOS_FC2 = /(?:^|[^a-z0-9])fc2/;
const RE_OUT_OF_SCOPE = new RegExp(
  `(?:^|[^a-z0-9])(${SERIES_LABEL_ALT}|heyzo)(?=[^a-z]|$)`,
);

// Dedicated out-of-scope rules (also cover glued names the std rule cannot).
const RE_FC2 = /(?:^|[^a-z0-9])fc2[\s-]*(?:ppv[\s-]*)?(\d{5,8})(?!\d)/;
const RE_HEYZO = /(?:^|[^a-z0-9])heyzo[\s-]*(\d{3,4})(?!\d)/;
const RE_SERIES = new RegExp(
  `(?:^|[^a-z0-9])(${SERIES_LABEL_ALT})[\\s-]*(\\d{6})(?:[\\s-]*(\\d{1,4}))?(?![a-z0-9])`,
);
const RE_SERIES_SINGLE = new RegExp(
  `(?:^|[^a-z0-9])(${SERIES_LABEL_ALT})[\\s-]*(\\d{3,6})(?![a-z0-9])`,
);

// Popular top-level domains for ad-domain stripping. Sorted by length at build
// time so `com` wins over `co` (glued case `...comipx-920`).
const TLD_LIST = [
  'download', 'website', 'stream', 'online', 'design', 'network', 'digital',
  'porn', 'media', 'video', 'space', 'cloud', 'store', 'today', 'world', 'email',
  'group', 'travel', 'museum', 'aero', 'coop', 'jobs', 'mobi', 'asia', 'name',
  'info', 'site', 'shop', 'live', 'link', 'work', 'tech', 'club', 'wiki', 'blog',
  'news', 'life', 'art', 'icu', 'buzz', 'wang', 'app', 'dev', 'com', 'net', 'org',
  'biz', 'pro', 'top', 'vip', 'fun', 'xyz', 'cc', 'tv', 'me', 'io', 'co', 'cn',
  'ru', 'jp', 'hk', 'tw', 'kr', 'de', 'fr', 'nl', 'se', 'no', 'fi', 'dk', 'pl',
  'eu', 'ws', 'sx', 'li', 'ly', 'to', 'gg', 'gl', 'fm', 'am', 'is', 'it', 'es',
  'pt', 'br', 'mx', 'ar', 'cl', 'id', 'my', 'sg', 'th', 'vn', 'ph', 'tr', 'ir',
  'ae', 'sa', 'il', 'kz', 'ua', 'by', 'su', 'us', 'uk', 'in', 'la',
];
const TLD_ALT = TLD_LIST.slice().sort((a, b) => b.length - a.length).join('|');

// A normal domain. Labels must NOT contain '-' so a code like `ipx-475-uncensored`
// is not swallowed whole by the domain rule; the boundary allows '-' so a domain
// glued after a hyphen (`...-uncensored-nyap2p.com`) is still found.
const RE_DOMAIN = new RegExp(
  `(?<![a-z0-9])(?:[a-z0-9]+\\.)+(?:${TLD_ALT})(?![a-z0-9])`,
  'g',
);
// `@nya2p.comipx-920`: the TLD is glued to the code, so NO trailing boundary.
const RE_DOMAIN_GLUED = new RegExp(`@(?:[a-z0-9-]+\\.)+(?:${TLD_ALT})`, 'g');

// CJK letters + CJK punctuation + fullwidth leftovers. Promo text is dropped.
const CJK =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe4f\uff00-\uffef\u2018-\u201f\u2026\u00b7]/g;

const NOISE_TOKEN_ALT = [
  '1080p', '720p', '480p', '360p', '2160p', '1440p', '1440', '60fps', '30fps',
  '24fps', '10bit', '8bit', 'x264', 'x265', 'h264', 'h265', 'hevc', 'vp9',
  'av1', 'avc', 'webrip', 'webdl', 'web-dl', 'bluray', 'blu-ray', 'bdrip',
  'brrip', 'dvdrip', 'hdrip', 'hdtv', 'remux', 'proper', 'repack', 'uncensored',
  'cracked', 'crack', 'leak', 'chinese', 'hardsub', 'softsub', 'subbed',
  'dubbed', 'subs', 'sample', 'trailer', 'preview', 'watermark', 'aac', 'ac3',
  'eac3', 'dts', 'flac', 'opus', 'hdr', 'sdr', 'uhd', 'fhd', 'qhd', '4k', '8k',
  '2k', 'hd', 'sd', 'web', 'chs', 'cht', 'eng', 'jpn', 'jap', 'sub', 'dl', 'cd1',
  'cd2', 'cd3', 'disc1', 'disc2', 'part1', 'part2', 'vol1', 'vol2',
].sort((a, b) => b.length - a.length).join('|');
const RE_NOISE_TOKEN = new RegExp(
  `(?:^|[^a-z0-9])(?:${NOISE_TOKEN_ALT})(?=[^a-z0-9]|$)`,
  'g',
);

const RE_DATE_ONLY = /^\d{4}\s+\d{1,2}\s+\d{1,2}$/;
const RE_EPISODE_LIKE = /\bs\d{1,2}\s*e\d{1,2}\b/;

// Std candidate: optional separator, 2-5 digits, optional sub marker (-C / -CH
// / -UC ...). `(?!\d)` stops a 6+ digit number from being cut short; the
// lookbehind keeps us from matching in the middle of a glued domain/word.
const RE_STD =
  /(?<![a-z0-9])([a-z]{2,7})[-_. ]?(\d{2,5})(?!\d)(?:[-_. ]?(c|ch|uc|cc|cs))?/g;

// Studio-style glued suffix: `pgd00844hhb_000` -> label `pgd` + digits `00844`
// followed by extra letters. Canonical code is derived from the stripped digits (PGD-844).
const RE_GLUED_LETTERS =
  /(?<![a-z0-9])([a-z]{2,7})(\d{3,5})(?=[a-z]{1,8}(?:[-_. ]|$))/g;

// Markers that mean "already renamed": a code followed by a real title, with no
// pre-rename noise left.
const NORMALIZED_NOISE =
  /(?:4k|8k|1080p|720p|2160p|1440p|无码|無碼|破解|中文字幕|中字|字幕|uncensored|\bch\b)/i;

function basename(fileName) {
  const s = String(fileName == null ? '' : fileName).trim();
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function stemOf(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  if (m && VIDEO_EXTS.has('.' + m[1].toLowerCase())) return name.slice(0, m.index);
  return name;
}

/** Normalize a stem into a (mostly) 'letters digits' token string. */
function cleanStem(stem) {
  const notes = [];
  let s = stem.normalize('NFKC').toLowerCase();
  s = s.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-');
  s = s.replace(/[\[\](){}<>【】〔〕「」『』《》〈〉（）｛｝［］]/g, ' ');

  // IMPORTANT: strip ad domains BEFORE turning '_' into '-'.
  // Otherwise `cawd-315_ch-nyap2p.com` becomes one long hyphen-label and the
  // domain rule eats the whole thing (real bug, v0.4.4).
  let domains = 0;
  s = s.replace(RE_DOMAIN, () => { domains += 1; return ' '; });
  s = s.replace(RE_DOMAIN_GLUED, () => { domains += 1; return ' '; });
  if (domains > 0) notes.push('ad-domain');
  s = s.replace(/@/g, ' ');

  s = s.replace(/[_＿]/g, '-');

  const beforeCjk = s.length;
  s = s.replace(CJK, ' ');
  if (s.length !== beforeCjk) notes.push('chinese-noise');

  let noise = 0;
  s = s.replace(RE_NOISE_TOKEN, () => { noise += 1; return ' '; });
  if (noise > 0) notes.push('quality-noise');

  s = s.replace(/[-_.\s]+/g, ' ').trim();
  return { cleaned: s, notes };
}

function scoreCandidate(label, num, known, index, textLength) {
  let score = 8;
  if (known) score += 5;
  if (num.length >= 3) score += 2;
  if (num.length === 5) score -= 1; // 5 digits usually means FC2/amateur
  if (num.startsWith('0')) score -= 0.5; // zero-padded form is less canonical
  // Earlier occurrence is more likely to be the real code (leading code wins).
  score += (1 - index / Math.max(textLength, 1)) * 2;
  return Math.round(score * 10) / 10;
}

/** Map a std-rule label to the pipeline scope. */
function classifyScope(label) {
  if (KNOWN_LABELS.has(label)) return 'censored';
  if (label === 'fc2') return 'fc2';
  if (label === 'heyzo') return 'heyzo';
  if (SERIES_LABELS.has(label)) return 'series';
  return 'unknown';
}

/** Dedicated FC2 / HEYZO / series extraction (only used when the name matched
 *  an out-of-scope category; returns candidates that all carry a non-censored
 *  scope so the pipeline can report and skip them). */
function extractOutOfScope(cleaned) {
  const found = [];
  const score = (index, base) =>
    Math.round((base + (1 - index / Math.max(cleaned.length, 1)) * 2) * 10) / 10;

  let m = RE_FC2.exec(cleaned);
  if (m) {
    const ppv = /ppv/.test(m[0]);
    found.push({
      index: m.index,
      cand: {
        code: `FC2-${m[1]}`,
        label: 'FC2',
        num: m[1],
        ...(ppv ? { sub: 'PPV' } : {}),
        rule: 'fc2',
        scope: 'fc2',
        score: score(m.index, 20),
        known: true,
      },
    });
  }

  m = RE_HEYZO.exec(cleaned);
  if (m) {
    found.push({
      index: m.index,
      cand: {
        code: `HEYZO-${m[1]}`,
        label: 'HEYZO',
        num: m[1],
        rule: 'heyzo',
        scope: 'heyzo',
        score: score(m.index, 20),
        known: true,
      },
    });
  }

  m = RE_SERIES.exec(cleaned);
  if (m) {
    const label = m[1].replace(/[\s-]+/g, '').toUpperCase();
    const num = m[2];
    const sub = m[3];
    found.push({
      index: m.index,
      cand: {
        code: sub ? `${label}-${num}-${sub}` : `${label}-${num}`,
        label,
        num,
        ...(sub ? { sub } : {}),
        rule: 'series',
        scope: 'series',
        score: score(m.index, 19),
        known: true,
      },
    });
  } else {
    m = RE_SERIES_SINGLE.exec(cleaned);
    if (m) {
      const label = m[1].replace(/[\s-]+/g, '').toUpperCase();
      found.push({
        index: m.index,
        cand: {
          code: `${label}-${m[2]}`,
          label,
          num: m[2],
          rule: 'series',
          scope: 'series',
          score: score(m.index, 18),
          known: true,
        },
      });
    }
  }

  found.sort((a, b) => b.cand.score - a.cand.score || a.index - b.index);
  return found.map((f) => f.cand);
}

function extractFromCleaned(cleaned) {
  const scored = [];
  RE_STD.lastIndex = 0;
  let m;
  while ((m = RE_STD.exec(cleaned)) !== null) {
    const label = m[1];
    const num = m[2];
    const known = KNOWN_LABELS.has(label);
    if (NOISE_LABELS.has(label)) continue;
    if (!known) {
      // Unknown labels need at least a plausible 3-4 digit number and no year.
      if (num.length < 3 || num.length > 4) continue;
      if (/^(?:19|20)\d{2}$/.test(num)) continue;
    }
    const key = `${label}-${num.replace(/^0+(?=\d)/, '')}`;
    if (scored.some((s) => s.key === key)) continue;
    const sub = m[3] ? m[3].toUpperCase() : undefined;
    const scope = classifyScope(label);
    const cand = {
      code: `${label.toUpperCase()}-${num}`,
      label: label.toUpperCase(),
      num,
      ...(sub ? { sub } : {}),
      rule: scope === 'heyzo' ? 'heyzo' : scope === 'series' ? 'series' : 'std',
      scope,
      score: scoreCandidate(label, num, known, m.index, cleaned.length),
      known: known || scope !== 'unknown',
    };
    scored.push({ cand, index: m.index, key });
  }

  // Second pass: label + digits + trailing letters glued together (`pgd00844hhb`).
  RE_GLUED_LETTERS.lastIndex = 0;
  while ((m = RE_GLUED_LETTERS.exec(cleaned)) !== null) {
    const label = m[1];
    const num = m[2];
    const known = KNOWN_LABELS.has(label);
    if (NOISE_LABELS.has(label)) continue;
    const strippedNum = num.replace(/^0+(?=\d)/, '');
    if (!known && (strippedNum.length < 3 || strippedNum.length > 4)) continue;
    if (/^(?:19|20)\d{2}$/.test(num)) continue;
    const key = `${label}-${strippedNum}`;
    if (scored.some((s) => s.key === key)) continue;
    const scope = classifyScope(label);
    const cand = {
      code: `${label.toUpperCase()}-${num}`,
      label: label.toUpperCase(),
      num,
      rule: scope === 'heyzo' ? 'heyzo' : scope === 'series' ? 'series' : 'std',
      scope,
      score: scoreCandidate(label, num, known, m.index, cleaned.length) - 0.2,
      known: known || scope !== 'unknown',
    };
    scored.push({ cand, index: m.index, key });
  }
  scored.sort((a, b) => b.cand.score - a.cand.score || a.index - b.index);
  return scored.map((s) => s.cand);
}

/**
 * Extract candidate codes from a file name.
 *
 * @param {string} fileName base name (a full path is tolerated)
 * @returns {{
 *   stem: string,
 *   cleaned: string,
 *   notes: string[],
 *   candidates: Array<{
 *     code: string, label: string, num: string, sub?: string,
 *     rule: 'std'|'fc2'|'heyzo'|'series', score: number, known: boolean,
 *     scope: 'censored'|'fc2'|'heyzo'|'series'|'unknown'
 *   }>
 * }}
 */
export function extractCandidates(fileName) {
  const stem = stemOf(basename(fileName));
  if (!stem) return { stem: '', cleaned: '', notes: ['no-code'], candidates: [] };

  const { cleaned, notes } = cleanStem(stem);

  if (RE_DATE_ONLY.test(cleaned)) notes.push('date-like');
  if (RE_EPISODE_LIKE.test(cleaned)) notes.push('episode-like');

  const oos = RE_OUT_OF_SCOPE.exec(cleaned);
  const fc2 = RE_OOS_FC2.exec(cleaned);
  if (oos || fc2) {
    notes.push(`out-of-scope:${fc2 ? 'fc2' : oos[1].replace(/[\s-]+/g, '')}`);
    const candidates = extractOutOfScope(cleaned);
    if (candidates.length === 0) notes.push('no-code');
    return { stem, cleaned, notes, candidates };
  }

  const candidates = extractFromCleaned(cleaned);
  if (candidates.length === 0) notes.push('no-code');
  return { stem, cleaned, notes, candidates };
}

/**
 * Lookup spellings for a code. `ABP-984` -> ['ABP-984', 'ABP-0984', 'ABP-00984',
 * 'ABP984', ...] so a lookup layer can retry the zero-padded / unseparated forms
 * that some sites use.
 *
 * @param {string} code
 * @returns {string[]}
 */
export function toLookupVariants(code) {
  const raw = String(code == null ? '' : code).normalize('NFKC').trim().toUpperCase();
  if (!raw) return [];

  const m = /^([A-Z]{2,8})[-_ .]?(\d{1,6})$/.exec(raw);
  if (!m) {
    const fallback = raw.replace(/[\s_.]+/g, '-').replace(/-+/g, '-');
    return fallback ? [fallback] : [];
  }

  const label = m[1];
  const num = m[2];
  const stripped = num.length >= 4 ? num.replace(/^0+(?=\d)/, '') : num;
  const out = [];
  const add = (v) => { if (v && !out.includes(v)) out.push(v); };

  add(`${label}-${num}`);
  if (stripped !== num) add(`${label}-${stripped}`);
  for (const width of [3, 4, 5]) {
    if (width > num.length) add(`${label}-${num.padStart(width, '0')}`);
  }
  add(`${label}${stripped}`);
  for (const width of [3, 4, 5]) {
    if (width > num.length) add(`${label}${num.padStart(width, '0')}`);
  }
  return out;
}

/**
 * True when a file name already looks like the pipeline's canonical output
 * `"<CODE> <title> [<actress>]"` — used by the outer pipeline to skip files it
 * has already renamed (idempotency).
 *
 * @param {string} baseName
 * @returns {boolean}
 */
export function isNormalizedName(baseName) {
  const stem = stemOf(basename(baseName));
  const m = /^([A-Z]{2,7})-(\d{2,5})(?:-\d{1,4})?\s+(\S.*)$/.exec(stem);
  if (!m) return false;

  const code = `${m[1]}-${m[2]}`;
  const rest = m[3].trim();
  if (rest.length < 2) return false;
  if (NORMALIZED_NOISE.test(rest)) return false;

  // The prefix must be the code the extractor would actually pick.
  const parsed = extractCandidates(stem);
  return parsed.candidates.length > 0 && parsed.candidates[0].code === code;
}
/** Full ASCII code token; separator/case/leading-zero differences are equivalent. */
export function fullCodeMatches(text,code) {
  const canonical=value=>{const m=/^([A-Z]{2,8})[-_ .]*(\d{1,6})$/i.exec(String(value||'').normalize('NFKC').trim());return m?`${m[1].toUpperCase()}-${Number(m[2])}`:null;};
  const wanted=canonical(code);if(!wanted)return false;
  const tokens=String(text||'').normalize('NFKC').matchAll(/(?<![A-Za-z0-9])([A-Za-z]{2,8})[-_ .]*(\d{1,6})(?![A-Za-z0-9])/g);
  for(const match of tokens)if(canonical(match[0])===wanted)return true;
  return false;
}
