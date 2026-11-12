(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const study = $('study-layer'), finish = $('finish-layer'), image = $('painting');
  const chapters = [...document.querySelectorAll('.chapter')];
  const { duration, animations, master, strokeCount } = createStartupArtwork(document);
  const phases = [
    { at: 0, name: '落笔 · 逐线勾勒', status: '线稿正徐徐展开' },
    { at: 2.9, name: '入色 · 水彩晕染', status: '肤色轻渗，发色与衣料错峰铺开' },
    { at: 5.5, name: '叠映 · 光影浮现', status: '颜色带着画边向外渗开，笔触渐渐沉淀' },
    { at: 8.0, name: '成画 · 春意渐浓', status: '画卷已成，留一刻春色' },
  ];
  let time = 0, rate = 1, playing = false, loading = true, ready = false;
  let failed = false, settled = false, resumeWhenVisible = false, frame = 0, lastUI = 0, previousPhase = -1;
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  function enableControls(enabled) {
    for (const node of [$('play'), $('replay'), $('timeline'), $('speed'), ...chapters]) node.disabled = !enabled;
  }
  function updateButton() {
    $('play').setAttribute('aria-label', playing ? '暂停' : '播放');
    $('play').setAttribute('aria-pressed', String(playing));
    $('play-symbol').textContent = playing ? 'Ⅱ' : '▶';
  }
  function phaseIndex() { return phases.reduce((found, phase, i) => time >= phase.at ? i : found, 0); }
  function render() {
    $('timeline').value = String(time);
    $('timeline').style.setProperty('--progress', `${time / duration * 100}%`);
    $('timeline').setAttribute('aria-valuetext', `${time.toFixed(1)} 秒`);
    $('elapsed').textContent = time.toFixed(1).padStart(4, '0');
    const index = phaseIndex();
    document.documentElement.dataset.phase = loading ? 'preparing' : (time >= duration ? 'complete' : String(index));
    if (index !== previousPhase || time >= duration) {
      previousPhase = index;
      $('phase').textContent = time >= duration ? '一幅春色，落笔完成' : phases[index].name;
      $('status').textContent = phases[index].status;
      for (let i = 0; i < chapters.length; i++) {
        chapters[i].classList.toggle('active', i === index && time < duration);
        chapters[i].classList.toggle('complete', i < index || time >= duration);
        if (i === index && time < duration) chapters[i].setAttribute('aria-current', 'step');
        else chapters[i].removeAttribute('aria-current');
      }
    }
  }
  function settle() {
    if (settled) return;
    settled = true;
    // Freeze the existing effects instead of replacing/cancelling them. Either
    // change can make the browser choose a different SVG raster scale and cause
    // a visible change in edge sharpness after the painting is already complete.
    for (const animation of animations) { animation.pause(); animation.currentTime = duration * 1000; }
  }
  function restore() {
    if (!settled) return;
    settled = false;
    for (const animation of animations) { animation.pause(); animation.currentTime = time * 1000; }
  }
  function sync() {
    const now = document.timeline.currentTime;
    for (const animation of animations) {
      animation.playbackRate = rate;
      animation.currentTime = time * 1000;
      animation.play();
      animation.startTime = now - time * 1000 / rate;
    }
  }
  function sample() { if (!settled) time = clamp(Number(master.currentTime) / 1000, 0, duration); }
  function tick(stamp) {
    if (!playing) return;
    sample();
    if (time >= duration - .001) {
      time = duration; playing = false; frame = 0;
      render(); updateButton(); settle(); return;
    }
    if (stamp - lastUI > 30) { render(); lastUI = stamp; }
    frame = requestAnimationFrame(tick);
  }
  function pause() {
    if (playing) sample();
    playing = false; cancelAnimationFrame(frame); frame = 0;
    if (!settled) for (const animation of animations) { animation.pause(); animation.currentTime = time * 1000; }
    if (!loading) render(); updateButton();
  }
  function seek(value) {
    if (loading || !Number.isFinite(Number(value))) return;
    const active = playing;
    pause(); time = clamp(Number(value), 0, duration); restore();
    for (const animation of animations) animation.currentTime = time * 1000;
    render();
    if (time >= duration) settle();
    else if (active) play();
  }
  function play() {
    if (playing || loading || failed) return;
    if (time >= duration) { time = 0; restore(); }
    playing = true; sync(); render(); updateButton();
    frame = requestAnimationFrame(tick);
  }
  function replay() {
    if (failed) { location.reload(); return; }
    if (loading) return;
    if (reduced.matches) { pause(); seek(duration); return; }
    pause(); seek(0); play();
  }
  function setRate(value) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return;
    const active = playing; pause(); rate = clamp(next, .25, 4);
    $('speed').value = String(rate); if (active) play();
  }

  let preparing = false;
  const deadline = setTimeout(() => fail('画卷加载超时，请点击重试。'), 20000);
  function fail(message) {
    if (ready || failed) return;
    failed = true; clearTimeout(deadline);
    document.documentElement.classList.add('failed');
    $('status').textContent = message;
    $('phase').textContent = '画卷尚未准备好';
    $('preparation').querySelector('p').textContent = '画卷加载失败';
    $('preparation').querySelector('span').hidden = true;
    $('replay').disabled = false; $('replay').textContent = '重试';
    $('composition').setAttribute('aria-busy', 'false');
  }
  async function prepared() {
    if (ready || failed || preparing) return;
    preparing = true;
    try { await image.decode(); } catch { /* Check natural dimensions below. */ }
    if (failed) return;
    if (!image.complete || !image.naturalWidth) { fail('精细成画加载失败，请点击重试。'); return; }
    ready = true; clearTimeout(deadline);
    // Prepare paths, masks and the detailed image while the paper loader stays
    // visible. Decoding alone does not pay the browser's first SVG paint cost.
    document.documentElement.classList.add('warming');
    for (const animation of animations) animation.currentTime = 7200;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const animation of animations) animation.currentTime = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.documentElement.classList.remove('warming');
    document.documentElement.classList.remove('preparing');
    $('preparation').hidden = true;
    $('composition').setAttribute('aria-busy', 'false');
    loading = false; enableControls(true); render();
    if (reduced.matches) seek(duration);
    else if (document.hidden) resumeWhenVisible = true;
    else play();
  }
  enableControls(false);
  image.addEventListener('load', prepared, { once: true });
  image.addEventListener('error', () => fail('精细成画加载失败，请点击重试。'), { once: true });
  if (image.complete) image.naturalWidth ? prepared() : fail('精细成画加载失败，请点击重试。');
  $('play').addEventListener('click', () => playing ? pause() : play());
  $('replay').addEventListener('click', replay);
  $('timeline').addEventListener('input', event => { const next = +event.target.value; pause(); seek(next); });
  $('speed').addEventListener('change', event => setRate(event.target.value));
  for (const node of chapters) node.addEventListener('click', () => { pause(); seek(+node.dataset.time); if (!reduced.matches) play(); });
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || /INPUT|SELECT|BUTTON|TEXTAREA/.test(event.target.tagName)) return;
    event.preventDefault(); playing ? pause() : play();
  });
  document.addEventListener('visibilitychange', () => {
    if (loading) return;
    if (document.hidden) { resumeWhenVisible = playing; if (playing) pause(); }
    else if (resumeWhenVisible) { resumeWhenVisible = false; play(); }
  });
  reduced.addEventListener('change', event => { if (event.matches && !loading) { pause(); seek(duration); } });
  window.drawingDemo = Object.freeze({ play, pause, seek, replay, setRate,
    getState: () => ({ time, duration, playing, rate, loading, ready, failed, settled, phase: phaseIndex(), strokeCount }),
  });
  updateButton();
})();
