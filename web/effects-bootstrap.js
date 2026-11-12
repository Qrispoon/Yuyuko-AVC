// Apply only the saved presentation preference before the first paint.
// Theme, wallpaper preferences and business state remain owned by their modules.
(() => {
  const root = document.documentElement;
  let enabled = false;
  try { enabled = localStorage.getItem('avc.effects.v1') === 'on'; } catch { /* private storage */ }
  root.dataset.effects = enabled ? 'on' : 'off';
  const view = /^#\/(work|history|assembly|settings)$/.exec(location.hash)?.[1] || 'work';
  root.dataset.effectsView = view;
})();
