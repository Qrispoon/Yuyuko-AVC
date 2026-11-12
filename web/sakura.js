import { t } from './i18n.js';
// 一阵短暂的樱花雨，与长期天气偏好独立；只使用本地 SVG 和 CSS。
export function initSakura({ toast = () => {} } = {}) {
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let rainLayer, timer, clickCount = 0, lastClick = 0;
  let suspended = root.dataset.effects === 'on';
  const clearRain = () => {
    clearTimeout(timer); rainLayer?.remove(); rainLayer = null;
    root.classList.remove('sakura-raining');
  };
  function rain() {
    if (suspended) return;
    if (motion.matches) { toast(t('已遵循系统的减少动态效果设置，樱花雨暂不播放')); return; }
    if (document.hidden || rainLayer) return;
    rainLayer = document.createElement('div');
    rainLayer.className = 'sakura-burst'; rainLayer.setAttribute('aria-hidden', 'true');
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 64; index++) {
      const petal = document.createElement('span'); petal.className = 'weather-petal';
      const size = 10 + index * 7 % 18;
      petal.style.cssText = `left:${(index * 37 + 1) % 100}%;width:${size}px;height:${size * 1.3}px;--petal-duration:${4.4 + index % 7 * .3}s;--petal-delay:${index % 9 * .11}s;--petal-drift:${-80 + index * 19 % 240}px;--petal-sway:${12 + index % 5 * 6}px;--petal-alpha:${.40 + index % 5 * .09};--petal-blur:${index % 4 === 0 ? 1 : 0}px;--petal-color:${['#f9a8d4', '#f4a5bc', '#fbcfe8'][index % 3]}`;
      petal.appendChild(document.createElement('i')); fragment.appendChild(petal);
    }
    rainLayer.appendChild(fragment); document.body.appendChild(rainLayer);
    root.classList.add('sakura-raining'); timer = setTimeout(clearRain, 8200);
    toast(t('接住这一场樱花雨。'));
  }
  document.querySelector('#sakuraEgg')?.addEventListener('click', () => {
    const now = Date.now(); clickCount = now - lastClick < 900 ? clickCount + 1 : 1; lastClick = now;
    if (clickCount >= 3) { clickCount = 0; rain(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearRain(); });
  window.addEventListener('blur', clearRain);
  motion.addEventListener('change', () => { if (motion.matches) clearRain(); });
  return { rain, setSuspended(value) { suspended = Boolean(value); if (suspended) { clearRain(); clickCount = 0; } } };
}
