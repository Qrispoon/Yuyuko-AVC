const $ = id => document.getElementById(id);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const art = createStartupArtwork(document);
const image = $('painting');
const openingDelay = 600;
const enterRevealDelay = 1000;
const enterRevealDuration = 1600;
let enterAvailable = false, enterFadeTimer;
let done = false, backendReady = false, backendFailed = false;
let prepared = false, preparing = false, artworkDone = false;
let playing = false, time = 0, frame = 0, pollTimer, openingTimer;
let openingRemaining = openingDelay, openingStarted = null;

function updateEnter() {
  $('enter').disabled = done || !enterAvailable || (!backendReady && !backendFailed);
}

// Reserve the button's space from the first frame, but keep it unfocusable and
// unclickable until the delayed reveal has completed, even on a fast backend.
const enterRevealTimer = setTimeout(() => {
  if (done) return;
  $('enter').classList.add('enter-visible');
  enterFadeTimer = setTimeout(() => {
    enterAvailable = true;
    updateEnter();
  }, reduced.matches ? 0 : enterRevealDuration);
}, enterRevealDelay);

function stopArtwork() {
  if (playing) time = Math.min(art.duration, Number(art.master.currentTime) / 1000);
  playing = false;
  cancelAnimationFrame(frame);
  for (const animation of art.animations) { animation.pause(); animation.currentTime = time * 1000; }
}

function enterWorkbench() {
  if (done || !backendReady) return;
  done = true;
  clearTimeout(pollTimer); clearTimeout(openingTimer); clearTimeout(loadDeadline);
  clearTimeout(enterRevealTimer); clearTimeout(enterFadeTimer);
  stopArtwork();
  $('enter').disabled = true;
  $('studio').setAttribute('aria-busy', 'false');
  document.body.classList.add('leaving');
  setTimeout(() => {
    // At /#/settings the launcher may have served this startup document.
    // Replacing the same URL with a fragment is only a same-document navigation;
    // reload explicitly so the now-ready launcher actually serves the workbench.
    if (location.pathname === '/') location.reload();
    else location.replace(`/${location.search}${location.hash}`);
  }, reduced.matches ? 0 : 300);
}

function finishArtwork() {
  time = art.duration; playing = false; artworkDone = true;
  for (const animation of art.animations) { animation.pause(); animation.currentTime = time * 1000; }
  if (!document.hidden && backendReady) enterWorkbench();
}

function tick() {
  if (!playing || done) return;
  time = Number(art.master.currentTime) / 1000;
  if (time >= art.duration - .001) { finishArtwork(); return; }
  frame = requestAnimationFrame(tick);
}

function playArtwork() {
  if (done || artworkDone || document.hidden || !prepared) return;
  if (reduced.matches) { finishArtwork(); return; }
  playing = true;
  const now = document.timeline.currentTime;
  for (const animation of art.animations) {
    animation.currentTime = time * 1000; animation.play();
    animation.startTime = now - time * 1000;
  }
  frame = requestAnimationFrame(tick);
}

function scheduleOpening() {
  if (!prepared || done || artworkDone || document.hidden || openingStarted !== null || playing) return;
  if (reduced.matches) { finishArtwork(); return; }
  if (openingRemaining <= 0) { playArtwork(); return; }
  openingStarted = performance.now();
  openingTimer = setTimeout(() => {
    openingRemaining = 0; openingStarted = null; playArtwork();
  }, openingRemaining);
}

const loadDeadline = setTimeout(artworkUnavailable, 20000);
function artworkUnavailable() {
  if (prepared || artworkDone || done) return;
  clearTimeout(loadDeadline);
  artworkDone = true;
  // Keep the same two visible labels on failure; a healthy backend can enter.
  if (backendReady && !document.hidden) enterWorkbench();
}

async function prepareArtwork() {
  if (preparing || prepared || artworkDone || done) return;
  preparing = true;
  try {
    await image.decode();
    if (!image.naturalWidth) throw new Error('startup_artwork_unavailable');
    clearTimeout(loadDeadline);
    document.documentElement.classList.add('warming');
    for (const animation of art.animations) animation.currentTime = 7200;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (done || artworkDone) return;
    for (const animation of art.animations) animation.currentTime = 0;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (done || artworkDone) return;
    clearTimeout(loadDeadline); prepared = true;
    document.documentElement.classList.remove('warming', 'preparing');
    scheduleOpening();
  } catch { artworkUnavailable(); }
}

async function poll() {
  if (done) return;
  try {
    let response = await fetch('/__avc/startup', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    // The standalone backend serves the same animation without the GUI launcher.
    const standalone = response.status === 404;
    if (standalone) response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`startup_http_${response.status}`);
    const value = await response.json();
    const state = standalone ? { phase: value.ok ? 'ready' : 'failed' } : value;
    if (done) return;
    backendReady = state.phase === 'ready'; backendFailed = state.phase === 'failed';
    updateEnter();
    if (backendReady && artworkDone && !document.hidden) { enterWorkbench(); return; }
  } catch {
    backendReady = false; backendFailed = false; $('enter').disabled = true;
  }
  pollTimer = setTimeout(poll, 550);
}

$('enter').addEventListener('click', async () => {
  if (done || !enterAvailable) return;
  if (backendReady) { enterWorkbench(); return; }
  // Reuse the sole enter control for recovery instead of adding another UI.
  if (!backendFailed) return;
  backendFailed = false; $('enter').disabled = true;
  clearTimeout(pollTimer);
  await fetch('/__avc/retry', { method: 'POST',headers:{'Content-Type':'application/json'},body:'{}' }).catch(() => {});
  poll();
});

document.addEventListener('visibilitychange', () => {
  if (done) return;
  if (document.hidden) {
    if (openingStarted !== null) {
      openingRemaining = Math.max(0, openingRemaining - (performance.now() - openingStarted));
      openingStarted = null; clearTimeout(openingTimer);
    }
    stopArtwork();
  } else if (artworkDone && backendReady) enterWorkbench();
  else scheduleOpening();
});
reduced.addEventListener('change', event => {
  if (event.matches && prepared && !done) {
    clearTimeout(openingTimer); openingStarted = null; stopArtwork(); finishArtwork();
  }
});
image.addEventListener('load', prepareArtwork, { once: true });
image.addEventListener('error', artworkUnavailable, { once: true });
if (image.complete) image.naturalWidth ? prepareArtwork() : artworkUnavailable();
poll();
