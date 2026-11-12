// Naming template + Windows filename sanitizing.
// Template placeholders: {code} {title} {actress} {date} {maker}
import path from 'node:path';

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Windows-safe file name (no reserved chars, no trailing dot/space, length capped). */
export function sanitizeFileName(name, maxLength = 170) {
  let s = cleanText(name).replace(/[. ]+$/, '');
  if (RESERVED.test(s.split('.')[0])) s = '_' + s;
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  return s;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * - strip a leading code ("ABP-984 中出し …" -> "中出し …")
 * - strip trailing actress names (javbus/manko titles often end with the actress)
 */
export function normalizeTitle(title, { code = '', actress = [] } = {}) {
  let t = cleanText(title);
  if (code) {
    const loose = escapeRegExp(code).replace(/-/g, '[-＿_ ]?');
    const lead = new RegExp(`^${loose}\\s*`, 'i');
    t = t.replace(lead, '').trim();
  }
  const names = actress.filter(Boolean).map((a) => cleanText(a)).sort((a, b) => b.length - a.length);
  for (const a of names) {
    for (const v of [a, a.replace(/\s+/g, '')]) {
      if (v && t.endsWith(v)) {
        t = t.slice(0, t.length - v.length).trim();
        break;
      }
    }
  }
  return t;
}

/**
 * Build the final file name (keeps original extension).
 * @param {{code:string,titleJa?:string,titleZh?:string,actress?:string[],
 *          releaseDate?:string,maker?:string,ext?:string,
 *          template?:string,maxLength?:number}} args
 */
export function buildNewName(args) {
  const {
    code = '',
    titleJa = '',
    titleZh = '',
    actress = [],
    releaseDate = '',
    maker = '',
    ext = '',
    template = '{code} {title} [{actress}]',
    maxLength = 170,
  } = args;

  const names = actress.map((a) => cleanText(a)).filter(Boolean);
  const title = normalizeTitle(titleJa || titleZh || '', { code, actress: names });

  let out = template
    .replace(/\{code\}/g, code)
    .replace(/\{title\}/g, title)
    .replace(/\{actress\}/g, names.join('、'))
    .replace(/\{date\}/g, releaseDate)
    .replace(/\{maker\}/g, maker);

  // drop empty groups like "[]" / "()" left when no actress
  out = out.replace(/\[\s*\]/g, ' ').replace(/\(\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const name = sanitizeFileName(out, maxLength);
  return ext && !name.toLowerCase().endsWith(ext.toLowerCase()) ? name + ext : name;
}

/** true if the file already looks like "<CODE> <something>" (idempotency helper). */
export function looksNormalized(baseName) {
  return /^[A-Z0-9]{2,7}-\d{2,5}(?:-\d{2,4})?\s+\S/.test(baseName);
}

export default { buildNewName, sanitizeFileName, normalizeTitle, cleanText, looksNormalized };
