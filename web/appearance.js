import { t, onLocaleChange, bindTranslations } from './i18n.js';
// 本地外观偏好；不接触业务配置、任务或媒体文件。
export const APPEARANCE_KEY = 'avc.appearance.v2';
export const DEFAULTS = Object.freeze({
  mode: 'cover', zoom: 100, strength: 40, blur: 3, image: '', x: 50, y: 50,
  filter: 'rose', filterStrength: 18, brightness: 100, saturation: 90, vignette: 12,
  material: 'mist', opacity: 94, glassBlur: 12,
  petals: 'sparse', size: 20, speed: 75, wind: 30, petalOpacity: 45, depth: true, branches: true,
  timeMode: 'auto', timeStrength: 55, nightTheme: false, rotation: 'off',
});
const enumValues = {
  mode: ['cover', 'contain', 'stretch', 'tile', 'custom'], filter: ['original', 'rose', 'warm', 'muted'],
  material: ['solid', 'mist', 'glass'], petals: ['off', 'sparse', 'medium'],
  timeMode: ['auto', 'dawn', 'day', 'dusk', 'night', 'off'], rotation: ['off', 'startup', '5', '15', '30'],
};
const ranges = { zoom: [25, 300], strength: [0, 100], blur: [0, 16], x: [0, 100], y: [0, 100],
  filterStrength: [0, 60], brightness: [60, 140], saturation: [0, 140], vignette: [0, 50],
  opacity: [75, 100], glassBlur: [0, 24], size: [10, 36], speed: [30, 150], wind: [-100, 100],
  petalOpacity: [10, 85], timeStrength: [0, 100] };

export function safeImage(value) {
  return typeof value === 'string' && (/^https?:\/\//i.test(value) || /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(value)) ? value : '';
}
export function normalizeAppearance(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const p = { ...DEFAULTS };
  for (const [key, values] of Object.entries(enumValues)) if (values.includes(raw[key])) p[key] = raw[key];
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const n = typeof raw[key] === 'boolean' ? (key === 'blur' ? (raw[key] ? 3 : 0) : NaN) : Number(raw[key]);
    if (raw[key] != null && Number.isFinite(n)) p[key] = Math.min(max, Math.max(min, n));
  }
  for (const key of ['depth', 'nightTheme', 'branches']) if (typeof raw[key] === 'boolean') p[key] = raw[key];
  p.image = safeImage(raw.image);
  return p;
}

const PHASES = [
  { hour: 0, name: '夜间', key: 'night', rgb: [70, 47, 92], brightness: .76 },
  { hour: 5, name: '晨光', key: 'dawn', rgb: [255, 195, 169], brightness: .96 },
  { hour: 9, name: '日间', key: 'day', rgb: [255, 239, 247], brightness: 1.03 },
  { hour: 16, name: '暮色', key: 'dusk', rgb: [240, 160, 159], brightness: .94 },
  { hour: 20, name: '夜间', key: 'night', rgb: [70, 47, 92], brightness: .76 },
  { hour: 24, name: '夜间', key: 'night', rgb: [70, 47, 92], brightness: .76 },
];
export function timeAtmosphere(date = new Date(), mode = 'auto') {
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  if (mode === 'off') return { key: 'off', name: '已关闭', rgb: [0, 0, 0], brightness: 1, dark: false };
  if (mode !== 'auto') {
    const phase = PHASES.find(p => p.key === mode) || PHASES[2];
    return { ...phase, dark: phase.key === 'night' };
  }
  const index = PHASES.findIndex((p, i) => hour >= p.hour && hour < PHASES[i + 1]?.hour);
  const from = PHASES[Math.max(0, index)], to = PHASES[Math.max(0, index) + 1];
  const t = (hour - from.hour) / (to.hour - from.hour);
  const weight = t * t * (3 - 2 * t);
  return { key: from.key, name: from.name,
    rgb: from.rgb.map((v, i) => Math.round(v + (to.rgb[i] - v) * weight)),
    brightness: from.brightness + (to.brightness - from.brightness) * weight,
    dark: hour < 6 || hour >= 20 };
}
export function backgroundSize(mode, zoom) {
  return ({ contain: 'contain', stretch: '100% 100%', tile: 'auto', custom: `${zoom}% auto` })[mode] || 'cover';
}

const PRESETS = {
  clear: { strength: 40, blur: 2, filter: 'rose', filterStrength: 12, brightness: 100, saturation: 95, vignette: 8, material: 'mist', opacity: 96, glassBlur: 8, petals: 'sparse', speed: 75, petalOpacity: 40, timeStrength: 40 },
  soft: { strength: 55, blur: 7, filter: 'rose', filterStrength: 28, brightness: 105, saturation: 80, vignette: 18, material: 'glass', opacity: 86, glassBlur: 18, petals: 'sparse', speed: 60, petalOpacity: 45, timeStrength: 55 },
  quiet: { strength: 30, blur: 5, filter: 'muted', filterStrength: 25, brightness: 85, saturation: 60, vignette: 25, material: 'solid', opacity: 100, glassBlur: 0, petals: 'off', timeStrength: 65 },
};
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const range = (key, label, unit = '%') => `<label class="ap-range" for="ap-${key}"><span><span data-i18n-source="${esc(label)}">${t(label)}</span><output data-value="${key}"></output></span><input id="ap-${key}" data-pref="${key}" type="range" min="${ranges[key][0]}" max="${ranges[key][1]}" step="1" data-unit="${unit}"></label>`;
const select = (key, label, options) => `<label class="ap-field" for="ap-${key}"><span data-i18n-source="${esc(label)}">${t(label)}</span><select id="ap-${key}" data-pref="${key}">${options.map(([value, text]) => {
  const title = value === 'off' ? '已关闭' : text;
  return `<option value="${value}" data-i18n-source="${esc(title)}">${t(title)}</option>`;
}).join('')}</select></label>`;
const toggle = (key, label) => `<label class="ap-toggle"><input type="checkbox" data-pref="${key}"><span data-i18n-source="${esc(label)}">${t(label)}</span></label>`;

function quickMenuHtml() {
  return `<div class="ap-quick-heading"><span class="ap-quick-thumb" aria-hidden="true"></span><div><strong id="ap-quick-title">外观与氛围</strong><small>常用设置，随手调整</small></div></div>
    <div class="ap-presets" aria-label="快速外观预设"><button type="button" data-preset="clear"><i class="ap-swatch clear"></i>清透</button><button type="button" data-preset="soft"><i class="ap-swatch soft"></i>柔雾</button><button type="button" data-preset="quiet"><i class="ap-swatch quiet"></i>静谧</button></div>
    <div class="ap-quick-actions"><button type="button" class="btn sm" id="apQuickImage">更换图片</button><button type="button" class="btn sm" id="apQuickPeek">只看壁纸</button></div>
    <label class="ap-quick-toggle"><span>飘落樱花</span><input id="apQuickPetals" type="checkbox" role="switch"></label>
    <label class="ap-quick-toggle"><span>跟随现实时间</span><input id="apQuickTime" type="checkbox" role="switch"></label>
    <button type="button" class="ap-more" id="apMore" aria-controls="bgPanel">更多设置 <span aria-hidden="true">›</span></button>`;
}

function panelHtml() {
  return `<div class="bgp-head"><div><strong id="ap-title">外观与氛围</strong><small>让粉樱界面，成为你喜欢的样子</small></div><button class="iconbtn" id="bgClose" aria-label="关闭外观面板">关闭</button></div>
  <div class="ap-scroll"><div class="ap-preview" id="bgPreview" role="img" aria-label="背景取景预览，可拖动调整位置"><span>拖动取景</span></div>
  <div class="ap-presets" aria-label="外观预设"><button data-preset="clear"><i class="ap-swatch clear"></i>清透</button><button data-preset="soft"><i class="ap-swatch soft"></i>柔雾</button><button data-preset="quiet"><i class="ap-swatch quiet"></i>静谧</button></div>
  <div class="ap-tabs" role="tablist" aria-label="外观分类">${[['background','背景'],['surface','面板'],['weather','樱花'],['time','时间']].map(([id, title], i) => `<button role="tab" id="ap-tab-${id}" aria-controls="ap-page-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-tab="${id}">${title}</button>`).join('')}</div>
  <section class="ap-page" id="ap-page-background" role="tabpanel" aria-labelledby="ap-tab-background">
    <div class="ap-actions"><button class="btn sm" id="bgPickFile">添加本地图片</button><button class="btn sm" id="ap-default-image">默认壁纸</button><button class="btn sm" id="ap-peek">只看壁纸</button></div><input type="file" id="bgFile" accept="image/*" multiple hidden>
    <div class="bgp-url"><input id="bgUrl" type="url" placeholder="粘贴 http(s) 图片地址" aria-label="图片地址" spellcheck="false"><button class="btn sm" id="bgUrlApply">添加</button></div>
    <div class="ap-gallery" id="apGallery" aria-label="收藏的背景图"></div><p class="ap-help">本地图片仅保存在此浏览器中；最多收藏 8 张。</p>
    ${select('rotation', '收藏轮换', [['off','关闭'],['startup','每次打开随机'],['5','每 5 分钟'],['15','每 15 分钟'],['30','每 30 分钟']])}
    ${select('mode', '图片适配', [['cover','覆盖填满'],['contain','完整显示'],['stretch','拉伸铺满'],['tile','平铺'],['custom','自定义缩放']])}
    ${range('zoom','缩放比例')}${range('x','水平取景')}${range('y','垂直取景')}${range('strength','背景强度')}${range('blur','背景模糊','px')}
    ${select('filter','调色滤镜',[['original','原图'],['rose','柔粉'],['warm','暖光'],['muted','低饱和']])}
    ${range('filterStrength','滤镜强度')}${range('brightness','亮度')}${range('saturation','饱和度')}${range('vignette','边缘暗角')}
  </section>
  <section class="ap-page" id="ap-page-surface" role="tabpanel" aria-labelledby="ap-tab-surface" hidden>
    <h3>细腻的光影与材质</h3><p class="ap-help">正文保持清晰，卡片上沿保留一道柔和高光。</p>
    ${select('material','卡片材质',[['solid','清晰 · 不透明'],['mist','微透 · 柔和层次'],['glass','磨砂 · 毛玻璃']])}${range('opacity','面板不透明度')}${range('glassBlur','磨砂强度','px')}
    <div class="ap-material-sample"><strong>粉樱面板</strong><p>标题清楚，背景隐约可见。</p><span>字幕已就绪</span></div>
  </section>
  <section class="ap-page" id="ap-page-weather" role="tabpanel" aria-labelledby="ap-tab-weather" hidden>
    <h3>樱花小天气</h3><p class="ap-help">近处花瓣轻盈，远处花瓣更小、更模糊。页面进入后台或失去焦点时自动暂停。</p>
    ${select('petals','花瓣数量',[['off','关闭'],['sparse','稀疏 · 14 片'],['medium','适中 · 30 片']])}${range('size','花瓣大小','px')}${range('speed','飘落速度')}${range('wind','风向与风力')}
    <p class="ap-help">负值向左，0 为静风，正值向右。</p>${range('petalOpacity','花瓣透明度')}${toggle('depth','开启远近景深')}
    ${toggle('branches','显示角落樱花枝')}<button type="button" class="btn sm" id="apPetalRain">下一场樱花雨</button>
    <p class="ap-help">小彩蛋：也可以连续轻点左上角头像三次。花雨短暂播放，不改变天气设置。</p>
    <p class="ap-motion-note" id="apMotionNote"></p>
  </section>
  <section class="ap-page" id="ap-page-time" role="tabpanel" aria-labelledby="ap-tab-time" hidden>
    <div class="ap-clock"><span id="apClock"></span><strong id="apPhase"></strong><small id="apTimezone"></small></div>
    ${select('timeMode','时间氛围',[['auto','跟随现实时间'],['dawn','固定 · 晨光'],['day','固定 · 日间'],['dusk','固定 · 暮色'],['night','固定 · 夜间'],['off','关闭']])}${range('timeStrength','氛围强度')}${toggle('nightTheme','夜间联动深色主题（仅主题为自动时）')}
    <div class="ap-dayline" aria-hidden="true"><i id="apClockMarker"></i></div><div class="ap-times"><span>00:00 夜</span><span>05:00 晨</span><span>09:00 日</span><span>16:00 暮</span><span>20:00 夜</span></div>
    <p class="ap-help">按电脑本地时间平滑改变背景色温与亮度，每分钟更新。自动模式下 20:00–06:00 可联动深色；手动主题优先。无需联网或定位。</p>
  </section></div>
  <div class="ap-footer"><span id="apSaveStatus" role="status" aria-live="polite">实时预览 · 自动保存</span><button class="btn sm" id="bgReset">恢复默认</button></div>`;
}

// 图片使用 IndexedDB，避免把多张图片塞进 localStorage。
function openGallery() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('avc-wallpapers', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function galleryStore(action, value) {
  const db = await openGallery();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('images', action === 'getAll' ? 'readonly' : 'readwrite');
      const req = value == null ? tx.objectStore('images')[action]() : tx.objectStore('images')[action](value);
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () => reject(tx.error || req.error);
    });
  } finally { db.close(); }
}

export function initAppearance({ toast = () => {}, onTimeTheme = () => {}, onPetalRain = () => {} } = {}) {
  const $ = s => document.querySelector(s);
  const root = document.documentElement, panel = $('#bgPanel'), host = $('#petals');
  if (!panel || !host) return;
  let prefs;
  try { prefs = normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY) || localStorage.getItem('avc.bg.v1') || '{}')); }
  catch { prefs = normalizeAppearance(); }
  let gallery = [], saveTimer, rotationTimer, weatherSignature = '', requestId = 0;
  let suspended = root.dataset.effects === 'on', clockTimer;
  let startupRotationPending = prefs.rotation === 'startup';
  let lastTimeTheme;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  panel.innerHTML = panelHtml();
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-labelledby', 'ap-title');
  const quick = document.createElement('div');
  quick.id = 'apQuick'; quick.className = 'ap-quick hidden';
  quick.setAttribute('role', 'dialog'); quick.setAttribute('aria-labelledby', 'ap-quick-title');
  quick.innerHTML = quickMenuHtml(); panel.before(quick);
  bindTranslations(panel); bindTranslations(quick);
  const controls = $('#bgBtn').closest('.bgctrl');
  let lastPetals = prefs.petals === 'off' ? 'sparse' : prefs.petals;
  const set = (name, value) => root.style.setProperty(name, value);
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(prefs)); $('#apSaveStatus').textContent = t('已保存到此浏览器'); }
      catch { $('#apSaveStatus').textContent = t('保存失败，当前仅预览'); toast(t('外观保存失败，浏览器存储空间可能不足'), 'err'); }
    }, 180);
  }
  function updateClock() {
    if (suspended) return;
    const date = new Date(), time = timeAtmosphere(date, prefs.timeMode);
    const strength = prefs.timeMode === 'off' ? 0 : prefs.timeStrength / 100;
    set('--time-color', time.rgb.join(' ')); set('--time-opacity', (strength * .30).toFixed(3));
    set('--time-brightness', (1 + (time.brightness - 1) * strength).toFixed(3));
    root.dataset.atmosphere = time.key;
    $('#apClock').textContent = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    $('#apPhase').textContent = `${prefs.timeMode === 'auto' ? t('此刻 · ') : ''}${t(time.name)}`;
    $('#apTimezone').textContent = t`本地时间 · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    $('#apClockMarker').style.left = `${(date.getHours() * 60 + date.getMinutes()) / 14.4}%`;
    const theme = prefs.nightTheme && prefs.timeMode !== 'off' ? (time.dark ? 'dark' : 'light') : null;
    if (lastTimeTheme !== theme) { lastTimeTheme = theme; onTimeTheme(theme); }
  }
  function renderWeather() {
    if (suspended) { host.replaceChildren(); weatherSignature = ''; return; }
    const signature = JSON.stringify([prefs.petals, prefs.size, prefs.speed, prefs.wind, prefs.petalOpacity, prefs.depth, motion.matches]);
    if (signature === weatherSignature) return;
    weatherSignature = signature; host.replaceChildren();
    const count = motion.matches ? 0 : ({ sparse: 14, medium: 30 }[prefs.petals] || 0);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const petal = document.createElement('span'); petal.className = 'weather-petal';
      const depth = prefs.depth ? [.55, .78, 1.12][i % 3] : 1;
      const size = prefs.size * depth * (.8 + (i * 7 % 9) / 20);
      petal.style.cssText = `left:${(i * 37 + 3) % 100}%;width:${size}px;height:${size * 1.3}px;--petal-duration:${(18 + i * 5 % 17) * 100 / prefs.speed / depth}s;--petal-delay:-${(i * 2.9 % 35).toFixed(2)}s;--petal-drift:${prefs.wind * 3}px;--petal-sway:${(12 + i % 5 * 5)}px;--petal-alpha:${prefs.petalOpacity / 100 * (.65 + depth * .25)};--petal-blur:${prefs.depth && depth < .7 ? 1.2 : 0}px;--petal-color:${['#f9a8d4','#f4a5bc','#fbcfe8','#eeb2ce'][i % 4]}`;
      petal.innerHTML = '<i></i>'; fragment.appendChild(petal);
    }
    host.appendChild(fragment);
    $('#apMotionNote').textContent = motion.matches ? t('系统已启用减少动态效果，樱花已暂停。') : t('已启用后台暂停与轻量 CSS 动画。');
    pauseWeather();
  }
  function pauseWeather() { root.classList.toggle('atmosphere-paused', document.hidden || !document.hasFocus()); }
  function apply(sync = true) {
    if (suspended) return;
    const image = prefs.image ? `url(${JSON.stringify(prefs.image)})` : 'url("assets/bg-default.jpg")';
    set('--bg-image', image); set('--bg-size', backgroundSize(prefs.mode, prefs.zoom));
    set('--bg-position', `${prefs.x}% ${prefs.y}%`); set('--bg-repeat', prefs.mode === 'tile' ? 'repeat' : 'no-repeat');
    set('--bg-blur', `${prefs.blur}px`); set('--bg-veil', (.95 - prefs.strength * .0075).toFixed(3));
    set('--image-brightness', prefs.brightness / 100); set('--image-saturation', (prefs.saturation / 100) * (prefs.filter === 'muted' ? 1 - prefs.filterStrength / 100 : 1));
    set('--filter-color', ({ rose: '244 163 197', warm: '255 202 150', muted: '190 177 194' })[prefs.filter] || '0 0 0');
    set('--filter-opacity', prefs.filter === 'original' ? 0 : prefs.filterStrength / 100);
    set('--vignette', prefs.vignette / 100); set('--surface-opacity', prefs.material === 'solid' ? 1 : prefs.opacity / 100);
    set('--surface-blur', prefs.material === 'glass' ? `${prefs.glassBlur}px` : '0px');
    root.dataset.material = prefs.material;
    root.classList.toggle('sakura-branches-off', !prefs.branches);
    const preview = $('#bgPreview');
    preview.style.backgroundImage = image; preview.style.backgroundSize = backgroundSize(prefs.mode, prefs.zoom);
    preview.style.backgroundPosition = `${prefs.x}% ${prefs.y}%`; preview.style.backgroundRepeat = prefs.mode === 'tile' ? 'repeat' : 'no-repeat';
    if (sync) panel.querySelectorAll('[data-pref]').forEach(el => {
      const value = prefs[el.dataset.pref];
      if (el.type === 'checkbox') el.checked = value; else el.value = String(value);
    });
    panel.querySelectorAll('[data-value]').forEach(el => { const key = el.dataset.value; el.textContent = `${prefs[key]}${panel.querySelector(`[data-pref="${key}"]`).dataset.unit}`; });
    $('#ap-zoom').disabled = prefs.mode !== 'custom';
    $('#ap-opacity').disabled = prefs.material === 'solid'; $('#ap-glassBlur').disabled = prefs.material !== 'glass';
    $('#ap-filterStrength').disabled = prefs.filter === 'original'; $('#ap-timeStrength').disabled = prefs.timeMode === 'off';
    controls.querySelectorAll('[data-preset]').forEach(button => {
      const active = Object.entries(PRESETS[button.dataset.preset]).every(([key, value]) => prefs[key] === value);
      button.setAttribute('aria-pressed', String(active));
    });
    $('#apQuickPetals').checked = prefs.petals !== 'off';
    $('#apQuickTime').checked = prefs.timeMode === 'auto';
    if (prefs.petals !== 'off') lastPetals = prefs.petals;
    updateClock(); renderWeather();
  }
  function change() { apply(); $('#apSaveStatus').textContent = t('正在保存…'); save(); }
  function renderGallery() {
    $('#apGallery').innerHTML = gallery.map(item => t`<div class="ap-wallpaper"><button data-wallpaper="${item.id}" aria-label="使用 ${esc(item.name)}" aria-pressed="${item.image === prefs.image}"><img src="${esc(item.image)}" alt="" loading="lazy"><span>${esc(item.name)}</span></button><button class="ap-remove" data-remove="${item.id}" aria-label="移除收藏 ${esc(item.name)}">×</button></div>`).join('');
  }
  async function addImage(image, name) {
    if (gallery.some(item => item.image === image)) { prefs.image = image; change(); renderGallery(); return; }
    if (gallery.length >= 8) { toast(t('收藏已满，请先移除一张壁纸'), 'err'); return; }
    const item = { id: crypto.randomUUID(), image, name };
    try { await galleryStore('put', item); gallery.push(item); }
    catch { toast(t('收藏保存失败，仍可预览此图片'), 'err'); }
    prefs.image = image; change(); renderGallery();
  }
  function scheduleRotation() {
    clearInterval(rotationTimer);
    if (suspended) return;
    if (['5','15','30'].includes(prefs.rotation)) rotationTimer = setInterval(() => {
      if (document.hidden || gallery.length < 2) return;
      const next = gallery[(gallery.findIndex(item => item.image === prefs.image) + 1) % gallery.length];
      prefs.image = next.image; change(); renderGallery();
    }, Number(prefs.rotation) * 60000);
  }
  function open(opened) {
    if (suspended) return;
    quick.classList.add('hidden'); panel.classList.toggle('hidden', !opened);
    $('#bgBtn').setAttribute('aria-expanded', String(opened));
    if (opened) $('#bgClose').focus(); else $('#bgBtn').focus();
  }
  function openQuick() {
    if (suspended) return;
    panel.classList.add('hidden'); quick.classList.remove('hidden');
    $('#bgBtn').setAttribute('aria-expanded', 'true'); quick.querySelector('button').focus();
  }
  $('#bgBtn').setAttribute('aria-label', t('外观与氛围')); $('#bgBtn').setAttribute('aria-controls', 'apQuick bgPanel'); $('#bgBtn').setAttribute('aria-expanded', 'false'); $('#bgBtn').title = t('外观与氛围');
  onLocaleChange(() => {
    $('#bgBtn').setAttribute('aria-label', t('外观与氛围')); $('#bgBtn').title = t('外观与氛围');
    updateClock(); renderWeather(); renderGallery();
    $('#apMotionNote').textContent = motion.matches ? t('系统已启用减少动态效果，樱花已暂停。') : t('已启用后台暂停与轻量 CSS 动画。');
    $('#apSaveStatus').textContent = t('实时预览 · 自动保存');
    $('#apExitPeek').textContent = t('返回页面 · Esc');
  });
  $('#bgBtn').onclick = () => { if (panel.classList.contains('hidden') && quick.classList.contains('hidden')) openQuick(); else open(false); };
  $('#bgClose').onclick = () => open(false);
  $('#apPetalRain').onclick = onPetalRain;
  $('#apMore').onclick = () => open(true);
  $('#apQuickImage').onclick = () => $('#bgFile').click();
  $('#apQuickPetals').onchange = e => { prefs.petals = e.target.checked ? lastPetals : 'off'; change(); };
  $('#apQuickTime').onchange = e => { prefs.timeMode = e.target.checked ? 'auto' : 'off'; change(); };
  quick.addEventListener('click', e => {
    const preset = e.target.closest('[data-preset]');
    if (preset) { Object.assign(prefs, PRESETS[preset.dataset.preset]); change(); }
  });
  quick.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); open(false); }
  });
  panel.addEventListener('input', e => {
    const key = e.target.dataset.pref; if (!key) return;
    prefs[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? Number(e.target.value) : e.target.value;
    change(); if (key === 'rotation') scheduleRotation();
  });
  function activateTab(button) {
    panel.querySelectorAll('[data-tab]').forEach(tab => {
      const active = tab === button; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      $(`#ap-page-${tab.dataset.tab}`).hidden = !active;
    });
  }
  panel.addEventListener('click', async e => {
    const tab = e.target.closest('[data-tab]'); if (tab) activateTab(tab);
    const preset = e.target.closest('[data-preset]');
    if (preset) { Object.assign(prefs, PRESETS[preset.dataset.preset]); change(); }
    const wall = e.target.closest('[data-wallpaper]');
    if (wall) { prefs.image = gallery.find(item => item.id === wall.dataset.wallpaper).image; change(); renderGallery(); }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      try { await galleryStore('delete', remove.dataset.remove); gallery = gallery.filter(item => item.id !== remove.dataset.remove); renderGallery(); }
      catch { toast(t('移除收藏失败，请重试'), 'err'); }
    }
  });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); open(false); }
    if (e.target.matches('[data-tab]') && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
      e.preventDefault(); const tabs = [...panel.querySelectorAll('[data-tab]')], i = tabs.indexOf(e.target);
      const next = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? 3 : (i + (e.key === 'ArrowRight' ? 1 : 3)) % 4]; activateTab(next); next.focus();
    }
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.bgctrl')) { panel.classList.add('hidden'); quick.classList.add('hidden'); $('#bgBtn').setAttribute('aria-expanded','false'); } });
  $('#bgPickFile').onclick = () => $('#bgFile').click();
  $('#bgFile').onchange = async e => {
    const files = [...e.target.files]; e.target.value = '';
    for (const file of files) {
      if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) { toast(t('请选择 20MB 以内的图片'), 'err'); continue; }
      if (gallery.length >= 8) { toast(t('收藏已满（8 张）'), 'err'); break; }
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        await addImage(canvas.toDataURL('image/webp', .82), file.name);
      } catch { toast(t('无法读取这张图片，请尝试 JPG、PNG 或 WebP'), 'err'); }
    }
  };
  $('#bgUrlApply').onclick = async () => {
    const image = safeImage($('#bgUrl').value.trim());
    if (!image || image.startsWith('data:')) { toast(t('请输入 http(s) 图片地址'), 'err'); return; }
    const id = ++requestId, probe = new Image(); $('#bgUrlApply').disabled = true;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => { probe.onload = probe.onerror = null; probe.src = ''; reject(new Error('image_timeout')); }, 12000);
        probe.onload = resolve; probe.onerror = reject; probe.src = image;
      });
      if (id === requestId) { await addImage(image, new URL(image).hostname); $('#bgUrl').value = ''; }
    } catch { if (id === requestId) toast(t('图片无法加载，请检查地址或网络'), 'err'); }
    finally { clearTimeout(timer); $('#bgUrlApply').disabled = false; }
  };
  $('#ap-default-image').onclick = () => { prefs.image = ''; change(); renderGallery(); };
  $('#bgReset').onclick = () => { ++requestId; prefs = { ...DEFAULTS }; $('#bgUrl').value = ''; panel.querySelectorAll('[data-preset]').forEach(b => b.removeAttribute('aria-pressed')); change(); renderGallery(); scheduleRotation(); toast(t('已恢复默认外观，收藏图片保留'), 'ok'); };
  const exitPeek = () => { root.classList.remove('wallpaper-only'); $('#apExitPeek').hidden = true; $('#bgBtn').focus(); };
  const exit = document.createElement('button'); exit.id = 'apExitPeek'; exit.className = 'btn'; exit.hidden = true; exit.textContent = t('返回页面 · Esc'); exit.onclick = exitPeek; document.body.appendChild(exit);
  const enterPeek = () => { open(false); root.classList.add('wallpaper-only'); exit.hidden = false; exit.focus(); };
  $('#ap-peek').onclick = enterPeek; $('#apQuickPeek').onclick = enterPeek;
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('wallpaper-only')) { e.stopImmediatePropagation(); exitPeek(); } }, true);
  let drag;
  const preview = $('#bgPreview');
  preview.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, px: prefs.x, py: prefs.y }; preview.setPointerCapture(e.pointerId); });
  preview.addEventListener('pointermove', e => { if (!drag) return; const rect = preview.getBoundingClientRect(); prefs.x = Math.round(Math.max(0, Math.min(100, drag.px - (e.clientX - drag.x) / rect.width * 100))); prefs.y = Math.round(Math.max(0, Math.min(100, drag.py - (e.clientY - drag.y) / rect.height * 100))); apply(); });
  const finishDrag = () => { if (drag) { drag = null; save(); } };
  preview.addEventListener('pointerup', finishDrag); preview.addEventListener('pointercancel', finishDrag); preview.addEventListener('lostpointercapture', finishDrag);
  motion.addEventListener('change', () => renderWeather());
  document.addEventListener('visibilitychange', () => { pauseWeather(); if (!document.hidden) updateClock(); });
  window.addEventListener('blur', pauseWeather); window.addEventListener('focus', () => { pauseWeather(); updateClock(); });
  window.addEventListener('pagehide', () => { clearTimeout(saveTimer); try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(prefs)); } catch {} });
  function rotateAtStartup() {
    if (suspended || !startupRotationPending || !gallery.length) return;
    startupRotationPending = false;
    prefs.image = gallery[Math.floor(Math.random() * gallery.length)].image; change();
  }
  function setSuspended(value) {
    suspended = Boolean(value);
    clearInterval(clockTimer);
    controls.hidden = suspended;
    if (suspended) {
      panel.classList.add('hidden'); quick.classList.add('hidden');
      $('#bgBtn').setAttribute('aria-expanded', 'false');
      root.classList.remove('wallpaper-only'); exit.hidden = true;
      host.replaceChildren(); weatherSignature = '';
    } else {
      rotateAtStartup(); apply();
      clockTimer = setInterval(() => { if (!document.hidden) updateClock(); }, 60000);
    }
    scheduleRotation();
  }
  setSuspended(suspended);
  galleryStore('getAll').then(items => {
    gallery = items.filter(item => safeImage(item.image) && typeof item.id === 'string' && /^[\da-f-]{36}$/i.test(item.id)).slice(0,8);
    rotateAtStartup();
    renderGallery();
  }).catch(() => { $('#apGallery').textContent = t('图片收藏暂不可用，背景设置仍可使用。'); });
  return { getPreferences: () => ({ ...prefs }), setSuspended };
}
