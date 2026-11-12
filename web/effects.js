import { t, onLocaleChange } from './i18n.js';

export const EFFECTS_KEY = 'avc.effects.v1';
export const SCENES = Object.freeze({
  work: { image: 'assets/effects/work.jpg', kind: 'petal', count: 12 },
  history: { image: 'assets/effects/history.jpg', kind: 'dust', count: 17 },
  assembly: { image: 'assets/effects/assembly.jpg', kind: 'butterfly', count: 6 },
  settings: { image: 'assets/effects/settings.jpg', kind: 'mote', count: 9 },
});

// Event-driven coordination only: the ambient animation runs in CSS, with no
// permanent JS frame loop or changes to task state, inputs or section markup.
export function initEffects({ appearance, sakura, toast = () => {} } = {}) {
  const root = document.documentElement;
  const stage = document.getElementById('effectsStage');
  const button = document.getElementById('btnEffects');
  const theme = document.getElementById('btnTheme');
  const nav = document.getElementById('tabs');
  if (!stage || !button || !nav) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const mouse = matchMedia('(hover: hover) and (pointer: fine)');
  const sceneElements = new Map([...stage.querySelectorAll('[data-scene]')].map(el => [el.dataset.scene, el]));
  const indicator = document.createElement('span');
  indicator.className = 'effects-tab-indicator';
  indicator.setAttribute('aria-hidden', 'true');
  nav.prepend(indicator);
  let enabled = root.dataset.effects === 'on';
  let requestedEnabled = enabled, modeRevision = 0, nativeTransition;
  let activeView = Object.hasOwn(SCENES, root.dataset.effectsView) ? root.dataset.effectsView : 'work';
  let viewRevision = 0, switchTimer;
  const sceneLoads = new Map();
  const layoutAnimations = new Set();
  let pageAnimation;
  let focused = document.hasFocus();
  let parallaxFrame = 0, pointerX = 0, pointerY = 0;

  function resetParallax() {
    if (parallaxFrame) cancelAnimationFrame(parallaxFrame);
    parallaxFrame = 0;
    stage.style.removeProperty('--effects-shift-x');
    stage.style.removeProperty('--effects-shift-y');
  }

  function canMoveBackground() {
    return enabled && focused && !document.hidden && !motion.matches && mouse.matches;
  }

  function moveBackground(event) {
    if (event.pointerType !== 'mouse') { resetParallax(); return; }
    if (!canMoveBackground()) return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (parallaxFrame) return;
    // Coalesce pointer events, then let CSS ease toward the latest position.
    // No animation frame is requested again until the mouse actually moves.
    parallaxFrame = requestAnimationFrame(() => {
      parallaxFrame = 0;
      if (!canMoveBackground()) return;
      const x = Math.max(-1, Math.min(1, pointerX / Math.max(1, window.innerWidth) * 2 - 1));
      const y = Math.max(-1, Math.min(1, pointerY / Math.max(1, window.innerHeight) * 2 - 1));
      stage.style.setProperty('--effects-shift-x', `${(-x * 12).toFixed(2)}px`);
      stage.style.setProperty('--effects-shift-y', `${(-y * 8).toFixed(2)}px`);
    });
  }

  function mountScene(view) {
    if (sceneLoads.has(view)) return sceneLoads.get(view);
    const config = SCENES[view], scene = sceneElements.get(view);
    const host = scene.querySelector('.effects-atmosphere');
    scene.style.setProperty('--scene-image', `url("${config.image}")`);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < config.count; i++) {
      const particle = document.createElement('span');
      particle.className = `effects-particle effects-${config.kind}`;
      const depth = [.52, .78, 1.1][i % 3];
      // Bias decoration to the margins and leave the portrait on the right quiet.
      const x = view === 'work' ? [3, 13, 25, 43, 92, 98][i % 6] : [2, 7, 14, 25, 76, 87, 95, 99][i % 8];
      const duration = config.kind === 'petal' ? 23 + i * 7 % 18 : config.kind === 'butterfly' ? 22 + i * 3 : 28 + i * 5 % 23;
      const size = config.kind === 'petal' ? (11 + i % 4 * 3) * depth : config.kind === 'butterfly' ? 17 + i % 3 * 6 : (2.5 + i % 4) * depth;
      particle.style.cssText = `left:${x}%;top:${config.kind === 'petal' ? -8 : 15 + i * 17 % 76}%;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;--fx-duration:${duration}s;--fx-delay:-${(i * 4.7 % duration).toFixed(1)}s;--fx-drift:${18 + i * 13 % 65}px;--fx-sway:${9 + i % 4 * 6}px;--fx-alpha:${config.kind === 'butterfly' ? .16 + i % 3 * .045 : .20 + i % 4 * .07};--fx-turn:${i % 2 ? -1 : 1};`;
      if (config.kind === 'petal' && i % 3 === 2) particle.classList.add('effects-near');
      if (config.kind === 'butterfly') {
        particle.innerHTML = '<i class="effects-wing effects-wing-left"></i><i class="effects-wing effects-wing-right"></i><i class="effects-butterfly-body"></i>';
      } else if (config.kind === 'petal') particle.appendChild(document.createElement('i'));
      fragment.appendChild(particle);
    }
    host.appendChild(fragment);
    const image = new Image();
    const ready = new Promise(resolve => {
      image.onload = () => {
        scene.dataset.image = 'ready';
        // onload is a valid fallback for browsers without Image.decode.
        if (image.decode) image.decode().catch(() => {}).then(resolve); else resolve();
      };
      image.onerror = () => { scene.dataset.image = 'failed'; resolve(); };
      image.src = config.image;
    });
    sceneLoads.set(view, ready);
    return ready;
  }

  function syncPlayback() {
    const paused = !enabled || document.hidden || !focused || motion.matches;
    if (!canMoveBackground()) resetParallax();
    root.classList.toggle('effects-paused', paused);
    root.classList.toggle('effects-reduced', motion.matches);
    sceneElements.forEach((scene, view) => {
      scene.classList.toggle('is-current', enabled && view === root.dataset.effectsView);
    });
  }

  function syncIndicator() {
    if (!enabled) return;
    const selected = nav.querySelector('.tab.on');
    if (!selected || !selected.offsetWidth) return;
    indicator.style.width = `${selected.offsetWidth}px`;
    indicator.style.height = `${selected.offsetHeight}px`;
    indicator.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
  }

  function refreshCopy() {
    button.querySelector('.effects-button-label').textContent = t('更多动效（实验中）');
    button.setAttribute('aria-pressed', String(enabled));
    button.title = t(enabled ? '关闭更多动效，返回简洁模式' : '开启更多动效：玻璃界面与氛围背景');
    syncIndicator();
  }

  function cancelLayoutAnimations() {
    for (const animation of layoutAnimations) animation.cancel();
    layoutAnimations.clear();
  }

  function setEnabled(value, { animate = true, persist = true } = {}) {
    const next = Boolean(value);
    cancelLayoutAnimations();
    pageAnimation?.cancel();
    const headerItems = [...nav.parentElement.children].filter(el => el !== theme && !el.classList.contains('grow'));
    const before = animate && !motion.matches ? headerItems.map(el => el.getBoundingClientRect()) : [];
    enabled = next;
    requestedEnabled = next;
    ++viewRevision;
    if (next) mountScene(activeView);
    appearance?.setSuspended(next);
    sakura?.setSuspended(next);
    clearTimeout(switchTimer);
    root.classList.toggle('effects-switching', animate && !motion.matches);
    root.dataset.effects = next ? 'on' : 'off';
    root.dataset.effectsView = activeView;
    if (theme) theme.hidden = next;
    if (persist) {
      try { localStorage.setItem(EFFECTS_KEY, next ? 'on' : 'off'); }
      catch { toast(t('当前模式仅本次生效，浏览器无法保存偏好')); }
    }
    refreshCopy(); syncPlayback(); syncIndicator();
    if (before.length) headerItems.forEach((el, index) => {
      const after = el.getBoundingClientRect(), previous = before[index];
      const x = previous.left - after.left, y = previous.top - after.top;
      if ((!x && !y) || !el.animate) return;
      const animation = el.animate([{ translate: `${x}px ${y}px` }, { translate: '0 0' }], {
        duration: 520, easing: 'cubic-bezier(.22,1,.36,1)',
      });
      layoutAnimations.add(animation);
      animation.onfinish = () => layoutAnimations.delete(animation);
    });
    switchTimer = setTimeout(() => root.classList.remove('effects-switching'), 620);
  }

  async function setView(value, { animate = true } = {}) {
    const view = Object.hasOwn(SCENES, value) ? value : 'work';
    const changed = activeView !== view;
    activeView = view;
    const revision = ++viewRevision;
    syncIndicator();
    pageAnimation?.cancel();
    if (!enabled) { root.dataset.effectsView = view; return; }
    // Keep the previous picture until the new local file has decoded. Rapid
    // navigation invalidates stale requests instead of replaying transitions.
    await mountScene(view);
    if (revision !== viewRevision || !enabled) return;
    root.dataset.effectsView = view;
    syncPlayback();
    if (sceneElements.get(view).dataset.image === 'failed') toast(t('背景图片无法加载，已使用氛围底色'), 'err');
    const section = document.getElementById(`view-${view}`);
    if (changed && animate && !motion.matches && section?.animate) {
      pageAnimation = section.animate([{ opacity: .65 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
    }
  }

  async function toggleMode() {
    const next = !requestedEnabled, revision = ++modeRevision;
    requestedEnabled = next;
    nativeTransition?.skipTransition();
    if (next) await mountScene(activeView);
    if (revision !== modeRevision) return;
    if (motion.matches || document.hidden || typeof document.startViewTransition !== 'function') {
      root.classList.remove('effects-native-switch');
      setEnabled(next);
      return;
    }
    // Native snapshots interpolate materials as well as the navigation's
    // geometry. The live DOM keeps focus, scroll position and task identity.
    root.classList.add('effects-native-switch');
    try {
      const transition = document.startViewTransition(() => {
        if (revision === modeRevision) setEnabled(next, { animate: false });
      });
      nativeTransition = transition;
      transition.ready.catch(() => {});
      transition.finished.catch(() => {}).finally(() => {
        if (nativeTransition === transition) { root.classList.remove('effects-native-switch'); nativeTransition = null; }
      });
    } catch {
      root.classList.remove('effects-native-switch');
      setEnabled(next);
    }
  }
  button.addEventListener('click', toggleMode);
  nav.addEventListener('pointermove', event => {
    if (!enabled || motion.matches) return;
    const rect = nav.getBoundingClientRect();
    nav.style.setProperty('--glass-x', `${event.clientX - rect.left}px`);
    nav.style.setProperty('--glass-y', `${event.clientY - rect.top}px`);
  });
  nav.addEventListener('pointerleave', () => { nav.style.removeProperty('--glass-x'); nav.style.removeProperty('--glass-y'); });
  document.addEventListener('pointermove', moveBackground, { passive: true });
  document.addEventListener('pointerleave', resetParallax);
  document.addEventListener('pointercancel', resetParallax);
  mouse.addEventListener('change', resetParallax);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(syncIndicator) : null;
  observer?.observe(nav);
  window.addEventListener('resize', () => { resetParallax(); syncIndicator(); });
  window.addEventListener('blur', () => { focused = false; syncPlayback(); });
  window.addEventListener('focus', () => { focused = true; syncPlayback(); });
  document.addEventListener('visibilitychange', syncPlayback);
  motion.addEventListener('change', () => {
    if (motion.matches) { nativeTransition?.skipTransition(); cancelLayoutAnimations(); pageAnimation?.cancel(); root.classList.remove('effects-switching'); }
    syncPlayback();
  });
  onLocaleChange(refreshCopy);
  setEnabled(enabled, { animate: false, persist: false });
  document.fonts?.ready.then(syncIndicator);
  return { setView, setEnabled, isEnabled: () => enabled };
}
