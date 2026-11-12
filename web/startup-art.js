// Shared by the startup page and its approved standalone preview.
globalThis.createStartupArtwork = function createStartupArtwork(root = document) {
  const $ = id => root.getElementById(id);
  const duration = 8.6;
  const animations = [];
  const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
  const penEase = 'cubic-bezier(.25,.55,.35,1)';

  // Speeds, rather than positions: interpolate the velocity smoothly and
  // integrate it once. Each stroke can slow down and pick up again without
  // stopping abruptly at intermediate keyframes. All curves remain monotonic.
  const speeds = {
    entrance: [[0, .28], [.22, .55], [.6, 1.3], [.85, 1.85], [1, .2]],
    sweep: [[0, 1.8], [.06, 9], [.18, 5.5], [.3, .14], [.69, .12], [.79, 2.8], [.91, .4], [1, .02]],
    detail: [[0, .12], [.2, .65], [.46, .27], [.75, 1.2], [.9, .7], [1, .06]],
    // Cloth keeps moving through the middle of the pass. A broad speed peak
    // replaces the old near-stop and second burst, while retaining a fast lead.
    folds: [[0, 1.3], [.16, 2.2], [.42, 1.75], [.7, 1.1], [.88, .65], [1, .18]],
    skin: [[0, .08], [.2, .5], [.4, .3], [.68, 1.25], [.88, .55], [1, .04]],
    bloom: [[0, .25], [.07, 5.5], [.19, 3.8], [.3, .15], [.66, .12], [.77, 3.4], [.9, .45], [1, .02]],
    flood: [[0, .45], [.16, 1.7], [.38, 2.1], [.65, 1.45], [.86, .85], [1, .25]],
    diffuse: [[0, .4], [.22, 1.4], [.52, 1.55], [.8, 1.05], [1, .2]],
  };
  const paceCurves = Object.fromEntries(Object.entries(speeds).map(([name, knots]) => {
    const points = [[0, 0]];
    let distance = 0, segment = 0;
    for (let i = 1; i <= 48; i++) {
      const t = (i - .5) / 48;
      while (segment < knots.length - 2 && t > knots[segment + 1][0]) segment++;
      const [a, va] = knots[segment], [b, vb] = knots[segment + 1];
      const mix = (1 - Math.cos(Math.PI * (t - a) / (b - a))) / 2;
      distance += (va + (vb - va) * mix) / 48;
      if (i % 2 === 0) points.push([i / 48, distance]);
    }
    return [name, points.map(([t, value]) => [t, value / distance])];
  }));
  function pacedStops(start, span, curve, from = 1, to = 0) {
    return paceCurves[curve].map(([t, value]) => [start + t * span, from + (to - from) * value]);
  }
  // Spend more real time on the first marks, then catch up continuously before
  // the hand/clothing sequence. Retiming every stop also slows the pen itself.
  const entranceTime = at => at < 1.7 ? 1.7 * Math.pow(at / 1.7, .65) : at;

  function animate(node, property, stops, trim = true) {
    const points = stops.map(([at, value, easing]) => ({ at, value, easing: easing || 'linear' }));
    if (trim) {
      while (points.length > 2 && points[0].value === points[1].value) points.shift();
      while (points.length > 2 && points.at(-1).value === points.at(-2).value) points.pop();
    }
    const begin = points[0].at, span = points.at(-1).at - begin;
    const animation = node.animate(points.map(point => ({
      offset: (point.at - begin) / span, [property]: point.value, easing: point.easing,
    })), { duration: span * 1000, delay: begin * 1000, fill: 'both' });
    animation.pause(); animation.currentTime = 0;
    animations.push(animation);
    return animation;
  }

  // Every contour is extracted from the original detailed illustration. The
  // study and final image share a viewBox, preserving alignment through the fade.
  const strokes = [...root.querySelectorAll('.drawing-stroke')];
  // at / spread control the region's launch cadence; short / long control
  // individual pen passes. Fine facial marks have more time per unit length.
  const inkRegions = {
    hair:             { at: .16, spread: .94, short: .075, long: .24, curve: 'entrance' },
    bonnet:           { at: .32, spread: .80, short: .10, long: .27, curve: 'folds' },
    face:             { at: .42, spread: 1.16, short: .29, long: .58, curve: 'detail' },
    eyes:             { at: 1.18, spread: .83, short: .30, long: .40, curve: 'detail' },
    hand:             { at: 1.96, spread: .79, short: .28, long: .52, curve: 'detail' },
    'sleeve-frills':   { at: 2.10, spread: .80, short: .10, long: .28, curve: 'folds' },
    ribbons:          { at: 2.30, spread: .68, short: .10, long: .28, curve: 'folds' },
    kimono:           { at: 2.20, spread: .84, short: .10, long: .29, curve: 'folds' },
    'cherry-blossoms': { at: 2.66, spread: .65, short: .15, long: .28, curve: 'detail' },
    atmosphere:       { at: 2.85, spread: .50, short: .07, long: .18, curve: 'sweep' },
  };
  for (const [region, config] of Object.entries(inkRegions)) {
    const paths = strokes.filter(path => path.id.replace(/^ink-/, '').replace(/-\d+$/, '') === region);
    const sourceStarts = paths.map(path => +path.dataset.start);
    const first = Math.min(...sourceStarts), spread = Math.max(...sourceStarts) - first;
    const spans = paths.map(path => +path.dataset.span), longest = Math.max(...spans);
    for (const [index, path] of paths.entries()) {
      const position = spread ? (+path.dataset.start - first) / spread : 0;
      // A small deterministic variation keeps short marks from landing as a
      // uniform block, without changing the original drawing order.
      const variation = ((index * 37 % 29) / 28 - .5) * .055;
      // Clothing launches continuously with a smooth change in density. The
      // two separated bursts made whole folds appear to stop between runs.
      const launch = config.curve === 'detail' || config.curve === 'entrance' ? position
        : config.curve === 'folds' ? position - .10 * Math.sin(Math.PI * position)
        : position < .52 ? position * .15 / .52
        : position < .62 ? .15 + (position - .52) * .61 / .10
        : .76 + (position - .62) * .24 / .38;
      const start = path.id === 'ink-hair-021' ? .04
        : config.at + config.spread * launch + variation * Math.sin(Math.PI * position);
      const length = longest > .23 ? clamp((+path.dataset.span - .23) / (longest - .23)) : (index * 13 % 17) / 16;
      // The central fringe is the first sustained mark, giving the eye a focal
      // point before the surrounding short contours accelerate into view.
      const span = path.id === 'ink-hair-021' ? .62
        : config.short + (config.long - config.short) * Math.sqrt(length);
      const stops = pacedStops(start, span, config.curve).map(([at, value]) => [entranceTime(at), value]);
      animate(path, 'strokeDashoffset', [[0, 1], ...stops, [duration, 0]]);
    }
  }
  // Regional wash travel and sideways diffusion have independent rhythms.
  // Width stays restrained over skin; broad cloth takes the faster sweep.
  // Each branch starts at the same wet seed and follows an already-painted
  // route before it grows outward. In particular, the old background brush had
  // three disconnected M subpaths that exposed strips of blank paper at once.
  const faceRoute = 'M248 270C310 302 428 285 442 359C456 422 371 453 327 426';
  const crownRoute = 'M248 270C270 240 300 205 300 174';
  const shoulderRoute = `${faceRoute}C300 475 275 520 279 593`;
  const washRoutes = {
    face: faceRoute,
    'hair-left': `${crownRoute}C211 185 122 265 153 334C176 394 65 457 130 494`,
    'hair-right': 'M248 270C310 302 428 285 442 310C470 290 478 230 478 210C578 252 594 330 549 400C502 468 628 468 649 524',
    bonnet: `${crownRoute}C260 130 185 100 125 93C302 37 531 25 621 102C663 139 660 190 640 220`,
    hand: `${faceRoute}C390 460 430 500 455 549C490 582 500 630 528 685C550 732 567 799 594 858L646 950`,
    kimono: `${shoulderRoute}C233 700 225 823 350 900C453 948 508 1107 623 1175`,
    ruffles: `${shoulderRoute}C270 680 230 780 180 820C145 845 125 855 116 861C241 760 384 747 405 851C417 901 285 938 232 933`,
    background: `${faceRoute}C260 430 205 430 160 440C80 500 65 680 55 870C40 1050 170 1170 330 1170C520 1190 740 1160 745 1010C760 810 725 650 660 520C620 400 670 270 560 170C460 70 270 65 140 150`,
  };
  const washes = {
    face:         { at: 2.90, span: 2.25, travel: 'skin',  spread: 'skin',  seed: .04 },
    'hair-left':  { at: 3.12, span: 1.60, travel: 'bloom', spread: 'bloom', seed: .03, width: 260 },
    'hair-right': { at: 3.34, span: 1.40, travel: 'sweep', spread: 'bloom', seed: .06, width: 245 },
    bonnet:       { at: 3.35, span: 1.35, travel: 'flood', spread: 'diffuse', seed: .03, width: 350 },
    hand:         { at: 3.70, span: 2.02, travel: 'skin',  spread: 'skin',  seed: .03 },
    kimono:       { at: 3.90, span: 1.45, travel: 'flood', spread: 'diffuse', seed: .03 },
    ruffles:      { at: 4.25, span: 1.45, travel: 'flood', spread: 'diffuse', seed: .03 },
    background:   { at: 4.15, span: 2.15, travel: 'flood', spread: 'diffuse', seed: .015, width: 300 },
  };
  for (const brush of root.querySelectorAll('.wash-brush')) {
    const region = brush.id.replace(/^brush-/, ''), config = washes[region];
    const width = config.width || +brush.dataset.width;
    brush.setAttribute('d', washRoutes[region]);
    animate(brush, 'strokeDashoffset', [[0, 1], ...pacedStops(config.at, config.span, config.travel), [duration, 0]]);
    const widths = pacedStops(config.at + .06, config.span + .18, config.spread, config.seed, 1);
    animate(brush, 'strokeWidth', [[0, '0px'], [config.at, '0px'],
      ...widths.map(([at, value]) => [at, `${width * value}px`]), [duration, `${width}px`]]);
  }
  animate($('underpainting'), 'opacity', [[0, 0], [2.84, 0], [3.08, .94], [4.7, 1], [duration, 1]]);
  animate($('color-settle'), 'opacity', [[0, 0], [6.5, 0, penEase], [7.2, 1], [duration, 1]]);
  animate($('gesture-layer'), 'opacity', [[0, .86], [3.8, .86], [5.2, .6], [6.7, .18], [7.7, 0], [duration, 0]]);
  // The masked SVG already contains the full finished artwork and its bleed.
  // Keep the preparation image hidden: a second fade would expose the whole
  // outer edge at once. This constant effect only supplies the clock.
  const master = animate($('finish-layer'), 'opacity', [[0, 0], [duration, 0]], false);

  return { duration, animations, master, strokeCount: strokes.length };
}
