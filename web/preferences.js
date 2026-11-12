import { bindTranslations, onLocaleChange, setLocale, t } from './i18n.js';

export const UI_PREFS_KEY = 'avc.ui.v1';
export const UI_DEFAULTS = Object.freeze({ language: 'zh-CN', fontSize: 14 });
export function normalizeUiPreferences(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    language: value.language === 'en' ? 'en' : 'zh-CN',
    fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize)
      ? Math.min(20, Math.max(12, Math.round(value.fontSize))) : 14,
  };
}
export function readUiPreferences(storage) {
  try { return normalizeUiPreferences(JSON.parse(storage.getItem(UI_PREFS_KEY))); }
  catch { return { ...UI_DEFAULTS }; }
}
export function initUiPreferences() {
  let storage;
  try { storage = localStorage; } catch { /* Private browsing can deny storage access. */ }
  let prefs = readUiPreferences(storage);
  let saved = !!storage;
  const $ = id => document.getElementById(id);
  // Capture the original Chinese document before any dynamic views render.
  bindTranslations(document);
  const status = () => {
    $('uiPreferenceStatus').textContent = saved ? t('已自动保存到此浏览器') : t('无法保存偏好，本次设置仍然生效');
  };
  const sync = () => {
    document.documentElement.style.setProperty('--font-scale', String(prefs.fontSize / 14));
    document.documentElement.dataset.fontSize = String(prefs.fontSize);
    $('uiLanguage').value = prefs.language;
    $('uiFontSize').value = String(prefs.fontSize);
    $('uiFontValue').textContent = `${prefs.fontSize} px · ${Math.round(prefs.fontSize / 14 * 100)}%`;
    $('uiFontSize').setAttribute('aria-valuetext', `${prefs.fontSize} px`);
    $('uiFontDecrease').disabled = prefs.fontSize === 12;
    $('uiFontIncrease').disabled = prefs.fontSize === 20;
    document.querySelectorAll('[data-font-size]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.fontSize) === prefs.fontSize)));
  };
  const update = patch => {
    prefs = normalizeUiPreferences({ ...prefs, ...patch });
    try { storage.setItem(UI_PREFS_KEY, JSON.stringify(prefs)); saved = true; }
    catch { saved = false; }
    sync();
    setLocale(prefs.language);
    status();
  };
  $('uiLanguage').addEventListener('change', event => update({ language: event.target.value }));
  $('uiFontSize').addEventListener('input', event => update({ fontSize: Number(event.target.value) }));
  $('uiFontDecrease').addEventListener('click', () => update({ fontSize: prefs.fontSize - 1 }));
  $('uiFontIncrease').addEventListener('click', () => update({ fontSize: prefs.fontSize + 1 }));
  document.querySelectorAll('[data-font-size]').forEach(button => button.addEventListener('click', () => update({ fontSize: Number(button.dataset.fontSize) })));
  $('uiReset').addEventListener('click', () => update(UI_DEFAULTS));
  document.querySelectorAll('.settings-menu a').forEach(link => link.addEventListener('click', event => {
    event.preventDefault();
    const section = document.querySelector(link.getAttribute('href'));
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('.settings-menu a').forEach(item => item.classList.toggle('settings-menu-current', item === link));
  }));
  onLocaleChange(() => { sync(); status(); });
  sync(); setLocale(prefs.language); status();
  return { getPreferences: () => ({ ...prefs }) };
}
