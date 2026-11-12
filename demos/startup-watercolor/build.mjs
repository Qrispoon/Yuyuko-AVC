import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPainting } from './render-painting.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(dir, '../yuyuko-svg/index.html'), 'utf8');
const start = source.indexOf('<svg id="illustration"');
const end = source.indexOf('</svg>', start) + 6;
if (start < 0 || end < 6) throw new Error('Original detailed illustration was not found.');
const original = source.slice(start, end);
const opening = original.slice(0, original.indexOf('>') + 1)
  .replace('width="785" height="1200" viewBox="0 0 785 1200"', 'width="915" height="1330" viewBox="-65 -65 915 1330"');
const description = original.slice(original.indexOf('>') + 1, original.indexOf('<defs>'));
const defs = original.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
const gestureStart = original.indexOf('<g id="gesture-layer"');
const finishedStart = original.indexOf('<g id="finished-painting"');
if (!defs || gestureStart < 0 || finishedStart < 0) throw new Error('Source layers were not found.');

// Extract balanced groups without altering any original path geometry.
function groupAt(at) {
  const tags = /<\/?g\b[^>]*>/g;
  tags.lastIndex = at;
  let depth = 0;
  for (let match; (match = tags.exec(original));) {
    depth += match[0].startsWith('</') ? -1 : (match[0].endsWith('/>') ? 0 : 1);
    if (depth === 0) return original.slice(at, tags.lastIndex);
  }
  throw new Error('Unbalanced SVG group.');
}

const gestures = groupAt(gestureStart);
const edgeStart = original.indexOf('<g id="edge-washes"');
const perimeter = 'mask="url(#soft-paper-perimeter)"';
// Reveal the complete painting, including its outer bleed, through one mask.
// Referencing the same decoded asset used for the resting frame keeps the
// original detail without adding thousands of live pigment paths to the DOM.
const studyDefs = defs.replace('<rect id="color-settle" width="785" height="1200"',
  '<rect id="color-settle" x="-65" y="-65" width="915" height="1330"');
const preview = `${opening.replace('id="illustration"', 'id="study"')}\n${description}${studyDefs}\n<g id="underpainting" mask="url(#paint-flow-mask)" aria-label="主体与外沿色晕同步显色"><image id="wash-painting" href="assets/painting.png" x="-65" y="-65" width="915" height="1330"/></g>\n<g ${perimeter}>${gestures}</g></svg>`;
const finished = `${opening.replace('id="illustration"', 'id="detailed-artwork"')}\n${description}${defs}\n<style>.pigment-pass{stroke-width:.48}.pigment-pass path{paint-order:stroke fill}</style>\n${groupAt(edgeStart)}\n<g ${perimeter}>${groupAt(finishedStart)}</g></svg>`;
const template = await fs.readFile(path.join(dir, 'template.html'), 'utf8');
await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
await fs.writeFile(path.join(dir, 'assets/painting.svg'), finished, 'utf8');
await renderPainting(dir);
await fs.writeFile(path.join(dir, 'index.html'), template.replace('<!-- ORIGINAL_STUDY -->', preview), 'utf8');
console.log(JSON.stringify({ previewBytes: Buffer.byteLength(preview), paintingBytes: Buffer.byteLength(finished), originalGeometry: true }));
