export function initWorkPanel() {
  const panel = document.querySelector('.side');
  let pending = false;
  const fit = () => {
    pending = false;
    if (panel.getClientRects().length) panel.style.setProperty('--work-panel-top', Math.max(16, panel.getBoundingClientRect().top) + 'px');
  };
  const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(fit); } };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  observer.observe(document.querySelector('header'));
  observer.observe(document.querySelector('.hero'));
  schedule();
}
