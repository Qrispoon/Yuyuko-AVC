import test from 'node:test';
import assert from 'node:assert/strict';
import { EN } from '../web/locales/en.js';
import { RELEASE_HISTORY } from '../web/updates.js';
import { UI_DEFAULTS, UI_PREFS_KEY, normalizeUiPreferences, readUiPreferences } from '../web/preferences.js';
import { setLocale, t, getLocale } from '../web/i18n.js';

test('UI preferences normalize and persist language and a bounded readable font size', () => {
  assert.deepEqual(UI_DEFAULTS, { language: 'zh-CN', fontSize: 14 });
  assert.deepEqual(normalizeUiPreferences({ language: 'en', fontSize: 19.6 }), { language: 'en', fontSize: 20 });
  assert.deepEqual(normalizeUiPreferences({ language: 'fr', fontSize: 7 }), { language: 'zh-CN', fontSize: 12 });
  assert.deepEqual(normalizeUiPreferences({ fontSize: Infinity }), UI_DEFAULTS);
  const store = new Map([[UI_PREFS_KEY, JSON.stringify({ language: 'en', fontSize: 18 })]]);
  assert.deepEqual(readUiPreferences({ getItem: key => store.get(key) }), { language: 'en', fontSize: 18 });
  assert.deepEqual(readUiPreferences({ getItem: () => '{' }), UI_DEFAULTS);
});

test('English UI copy covers primary settings, navigation, appearance and release notes', () => {
  for (const key of [
    '外观与语言', '界面语言', '字体大小', '工作台', '历史与撤销', '设置',
    '只看壁纸', '更多设置', '樱花小天气', '夜间联动深色主题（仅主题为自动时）',
    ...RELEASE_HISTORY.flatMap(release => release.sections.flatMap(section => [section.label, ...section.items])),
  ]) assert.ok(EN[key], `Missing English copy for ${key}`);
});

test('template localization changes authored copy but keeps interpolated media data verbatim', () => {
  setLocale('en');
  const mediaName = '中文字幕 1080p.mp4';
  assert.equal(t`主题：${mediaName}`, `Theme: ${mediaName}`);
  assert.equal(t('外观与语言'), 'Appearance & Language');
  setLocale('zh-CN');
  assert.equal(getLocale(), 'zh-CN');
});

test('dynamic list and history labels follow locale without translating media names', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await import('../web/app.js');
    const ui = globalThis.window.__AVC_TEST__;
    setLocale('en');
    const item = { path: 'D:/Videos/IPX-920 中文字幕.mp4', name: 'IPX-920 中文字幕.mp4', code: 'IPX-920', status: 'scanned', size: 1000 };
    const html = ui.rowHtml(item, 0);
    assert.ok(html.includes(item.name));
    assert.ok(html.includes('Ready to preview'));
    assert.ok(html.includes('Copy code'));
    assert.equal(ui.relativeTime(Date.now() - 3 * 60000), '3 min ago');
    assert.equal(ui.relativeTime(null), '—');
    setLocale('zh-CN');
    assert.ok(ui.rowHtml(item, 0).includes('待预演'));
  } finally {
    setLocale('zh-CN');
    globalThis.window = previousWindow;
  }
});
