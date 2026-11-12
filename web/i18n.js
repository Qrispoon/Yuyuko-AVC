import { EN } from './locales/en.js';

let locale = 'zh-CN';
const listeners = new Set();
const bindings = new Set();
const registered = new WeakSet();
export const getLocale = () => locale;
export const onLocaleChange = listener => { listeners.add(listener); return () => listeners.delete(listener); };

// Only authored literal segments pass through this function. Interpolated values
// (paths, filenames, metadata, subtitle text and server logs) stay untouched.
export function translateLiteral(text, language = locale) {
  if (language !== 'en') return String(text);
  return String(text).replace(/[^<>"\n]+/g, part => {
    const key = part.trim();
    if (!Object.hasOwn(EN, key)) return part;
    const start = part.indexOf(key);
    const leading = part.slice(0, start), trailing = part.slice(start + key.length);
    let translation = EN[key];
    if (leading.endsWith(' ')) translation = translation.replace(/^ +/, '');
    if (trailing.startsWith(' ')) translation = translation.replace(/ +$/, '');
    return leading + translation + trailing;
  });
}
export function t(source, ...values) {
  if (Array.isArray(source) && Object.hasOwn(source, 'raw')) {
    return source.reduce((text, part, index) => text + translateLiteral(part) + (index < values.length ? values[index] : ''), '');
  }
  return translateLiteral(source);
}

export function setLocale(value) {
  const next = value === 'en' ? 'en' : 'zh-CN';
  const changed = next !== locale;
  locale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  refreshTranslations();
  if (changed) for (const listener of listeners) listener(locale);
}

// Register static UI once, before dynamic renderers take ownership of their
// containers. Never walk live library data or observe arbitrary DOM mutations.
export function bindTranslations(root) {
  const remember = (node, attribute, source, previous = source) => {
    if (!/\p{Script=Han}/u.test(source)) return;
    const binding = { node, attribute, source, previous };
    bindings.add(binding);
  };
  const visit = element => {
    const known = registered.has(element);
    registered.add(element);
    if (element.nodeType === 3) { if (!known) remember(element, null, element.nodeValue); return; }
    if (element.nodeType !== 1 && element.nodeType !== 9) return;
    if (element.nodeType === 1) {
      if (element.matches('script,style,[data-no-i18n]')) return;
      const source = element.getAttribute('data-i18n-source');
      if (source && element.firstChild?.nodeType === 3) remember(element.firstChild, null, source, element.firstChild.nodeValue);
      for (const name of known ? [] : ['title','placeholder','aria-label']) {
        if (element.hasAttribute(name)) remember(element, name, element.getAttribute(name));
      }
    }
    for (const child of element.childNodes) visit(child);
  };
  visit(root);
  refreshTranslations();
}
function refreshTranslations() {
  for (const binding of bindings) {
    const { node, attribute, source, previous } = binding;
    if (!node.isConnected) { bindings.delete(binding); continue; }
    const current = attribute ? node.getAttribute(attribute) : node.nodeValue;
    // A renderer changed this node: it owns further localization.
    if (current !== previous) { bindings.delete(binding); continue; }
    const next = t(source);
    if (attribute) node.setAttribute(attribute, next); else node.nodeValue = next;
    binding.previous = next;
  }
}
