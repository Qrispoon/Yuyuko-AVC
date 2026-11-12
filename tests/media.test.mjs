// Offline unit tests for T-MEDIA (cover download + ffmpeg capability layer).
//
// Nothing here executes ffmpeg/ffprobe: detection and embedding are driven through an
// injected `execFile` mock, and command construction is tested through the pure
// `buildEmbedArgs` export. Writes go to OS temp dirs and are cleaned up.
//
// Covers:
//   src/media/ffmpeg.mjs  detectFfmpeg (success / missing / ffprobe-missing / timeout / cache),
//                         probeDurationSec, buildEmbedArgs (mp4/mkv), embedCover atomic replace,
//                         error codes (FFMPEG_MISSING, UNSUPPORTED_CONTAINER, FFMPEG_NO_OUTPUT)
//   src/media/covers.mjs  pickCoverUrl priority, isImage magic numbers, coverSidecarPath,
//                         downloadCover (image / html / http errors), writeCover (+ poster)
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  detectFfmpeg,
  probeDurationSec,
  embedCover,
  buildEmbedArgs,
  coverKindFor,
  tmpCoverPath,
  resetDetectCache,
} from '../src/media/ffmpeg.mjs';
import {
  pickCoverUrl,
  isImage,
  coverSidecarPath,
  downloadCover,
  writeCover,
} from '../src/media/covers.mjs';

// ---------------------------------------------------------------------------
// fixtures: valid magic-number byte prefixes
// ---------------------------------------------------------------------------
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body', 'latin1')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png', 'latin1')]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.from('fake-webp', 'latin1')]);

/** execFile mock: records calls, delegates to `handler`. */
function makeExec(handler) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts: opts || {} });
    return handler(cmd, args, opts || {});
  };
  exec.calls = calls;
  return exec;
}

const okVersionExec = () => ({ stdout: '' });
// Deterministic probe metadata only; these bytes are never claimed to be real media.
function probeFixture(args) {
  const output=path.basename(path.dirname(args.at(-1))).startsWith('.avc-cover-');
  const cover=path.extname(args.at(-1))==='.mkv'?{codec_type:'attachment',codec_name:'mjpeg'}:{codec_type:'video',codec_name:'mjpeg',disposition:{attached_pic:1}};
  return {stdout:JSON.stringify({format:{duration:'10'},streams:[{codec_type:'video',codec_name:'h264',disposition:{attached_pic:0}},...(output?[cover]:[])]})};
}

/** execFile mock that rejects with ENOENT (ffmpeg absent). */
function missingExec() {
  return makeExec(() => {
    throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
  });
}

/** execFile mock that always times out. */
function timeoutExec() {
  return makeExec(() => {
    throw Object.assign(new Error('ffmpeg timed out after 3000ms'), { code: 'FFMPEG_TIMEOUT' });
  });
}

/** Stub http transport (same shape as createHttp().getFollow). */
function makeStubHttp(entries) {
  const calls = [];
  const http = {
    calls,
    async getFollow(url, opts = {}) {
      calls.push({ url, opts });
      let entry = entries[url];
      if (typeof entry === 'function') entry = entry(url, opts);
      if (entry && entry.throw) throw entry.throw;
      if (!entry) throw Object.assign(new Error(`NO_STUB_ROUTE ${url}`), { code: 'NO_ROUTE' });
      const text = entry.text ?? '';
      return {
        status: entry.status ?? 200,
        text,
        buffer: entry.buffer ?? Buffer.from(text, 'utf8'),
        headers: entry.headers ?? {},
        url,
        route: 'direct',
        ms: 1,
      };
    },
  };
  return http;
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-test-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// ffmpeg: command construction (pure)
// ===========================================================================
test('ffmpeg: buildEmbedArgs mp4 uses stream copy + attached_pic disposition', () => {
  const args = buildEmbedArgs('mp4-attached-pic', 'C:\\vids\\IPX-920.mp4', 'C:\\vids\\IPX-920.jpg', 'C:\\vids\\IPX-920.mp4.tmp-cover.mp4');
  assert.deepEqual(args, [
    '-y',
    '-i', 'C:\\vids\\IPX-920.mp4',
    '-i', 'C:\\vids\\IPX-920.jpg',
    '-map', '0',
    '-map', '1',
    '-c', 'copy',
    '-disposition:v:1', 'attached_pic',
    '-metadata:s:v:1', 'title=Cover',
    'C:\\vids\\IPX-920.mp4.tmp-cover.mp4',
  ]);
  // must never re-encode
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.ok(!args.includes('-c:v'));
});

test('ffmpeg: buildEmbedArgs mkv attaches the image as a file attachment', () => {
  const args = buildEmbedArgs('mkv-attachment', 'D:\\v\\ABP-984.mkv', 'D:\\v\\ABP-984.jpg', 'D:\\v\\ABP-984.mkv.tmp-cover.mkv');
  assert.deepEqual(args, [
    '-y',
    '-i', 'D:\\v\\ABP-984.mkv',
    '-attach', 'D:\\v\\ABP-984.jpg',
    '-metadata:s:t', 'mimetype=image/jpeg',
    '-metadata:s:t', 'filename=cover.jpg',
    '-c', 'copy',
    'D:\\v\\ABP-984.mkv.tmp-cover.mkv',
  ]);
});

test('ffmpeg: buildEmbedArgs mkv derives mimetype/filename from the image extension', () => {
  const args = buildEmbedArgs('mkv-attachment', 'a.mkv', 'cover.PNG', 'a.mkv.tmp-cover.mkv');
  assert.ok(args.includes('mimetype=image/png'));
  assert.ok(args.includes('filename=cover.png'));
  assert.ok(!args.includes('mimetype=image/jpeg'));
});

test('ffmpeg: buildEmbedArgs rejects unknown kinds with UNSUPPORTED_CONTAINER', () => {
  assert.throws(() => buildEmbedArgs('avi-magic', 'a.avi', 'c.jpg', 'tmp'), (err) => err.code === 'UNSUPPORTED_CONTAINER');
});

test('ffmpeg: coverKindFor / tmpCoverPath map extensions', () => {
  assert.equal(coverKindFor('a.mp4'), 'mp4-attached-pic');
  assert.equal(coverKindFor('a.M4V'), 'mp4-attached-pic');
  assert.equal(coverKindFor('a.mkv'), 'mkv-attachment');
  assert.equal(coverKindFor('a.MKV'), 'mkv-attachment');
  assert.equal(coverKindFor('a.avi'), null);
  assert.equal(coverKindFor('a.wmv'), null);
  assert.equal(coverKindFor(''), null);

  assert.equal(tmpCoverPath('C:\\v\\a.mp4'), 'C:\\v\\a.mp4.tmp-cover.mp4');
  assert.equal(tmpCoverPath('C:\\v\\a.mkv'), 'C:\\v\\a.mkv.tmp-cover.mkv');
});

// ===========================================================================
// ffmpeg: detection (injected exec only — never the real binary)
// ===========================================================================
test('ffmpeg: detectFfmpeg returns version + ffprobe on success', async () => {
  const exec = makeExec((cmd) => (
    cmd === 'ffmpeg'
      ? { stdout: 'ffmpeg version 6.1.1-full_build-www.gyan.dev Copyright (c) 2000-2023', stderr: '' }
      : { stdout: 'ffprobe version 6.1.1-full_build', stderr: '' }
  ));
  const det = await detectFfmpeg({ execFile: exec });
  assert.deepEqual(det, { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: '6.1.1-full_build-www.gyan.dev' });
  assert.equal(exec.calls.length, 2);
  assert.equal(exec.calls[0].cmd, 'ffmpeg');
  assert.deepEqual(exec.calls[0].args, ['-version']);
  assert.equal(exec.calls[1].cmd, 'ffprobe');
});

test('ffmpeg: detectFfmpeg returns null when ffmpeg is missing', async () => {
  const exec = missingExec();
  assert.equal(await detectFfmpeg({ execFile: exec }), null);
  // must not even look for ffprobe
  assert.equal(exec.calls.length, 1);
});

test('ffmpeg: detectFfmpeg returns null when the probe times out', async () => {
  const exec = timeoutExec();
  assert.equal(await detectFfmpeg({ execFile: exec }), null);
  assert.equal(exec.calls[0].opts.timeoutMs, 3000);
});

test('ffmpeg: ffmpeg without ffprobe reports ffprobe=null', async () => {
  const exec = makeExec((cmd) => {
    if (cmd === 'ffmpeg') return { stdout: 'ffmpeg version 7.0.2\n' };
    throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
  });
  const det = await detectFfmpeg({ execFile: exec });
  assert.equal(det.ffmpeg, 'ffmpeg');
  assert.equal(det.ffprobe, null);
  assert.equal(det.version, '7.0.2');
});

test('ffmpeg: detection result is cached per exec function', async () => {
  const exec = makeExec((cmd) => ({ stdout: cmd === 'ffmpeg' ? 'ffmpeg version 5.0.1' : 'ffprobe version 5.0.1' }));
  const first = await detectFfmpeg({ execFile: exec });
  const second = await detectFfmpeg({ execFile: exec });
  assert.equal(first, second, 'same cached object should be returned');
  assert.equal(exec.calls.length, 2, 'second call must not shell out again');

  resetDetectCache();
  await detectFfmpeg({ execFile: exec });
  assert.equal(exec.calls.length, 4, 'resetDetectCache forces re-probing');
});

// ===========================================================================
// ffmpeg: duration probing
// ===========================================================================
test('ffmpeg: probeDurationSec parses the ffprobe json duration', async () => {
  const exec = makeExec(() => ({ stdout: '{"format":{"duration":"1234.567000"}}' }));
  const video = 'C:\\vids\\IPX-920.mp4';
  const sec = await probeDurationSec(video, { ffprobe: 'ffprobe', execFile: exec });
  assert.equal(sec, 1234.567);
  assert.deepEqual(exec.calls[0].args, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video]);
  assert.equal(exec.calls[0].cmd, 'ffprobe');
  assert.ok(exec.calls[0].opts.timeoutMs > 0);
});

test('ffmpeg: probeDurationSec degrades to null on any failure', async () => {
  const badJson = makeExec(() => ({ stdout: 'not json' }));
  assert.equal(await probeDurationSec('a.mp4', { ffprobe: 'ffprobe', execFile: badJson }), null);

  const na = makeExec(() => ({ stdout: '{"format":{"duration":"N/A"}}' }));
  assert.equal(await probeDurationSec('a.mp4', { ffprobe: 'ffprobe', execFile: na }), null);

  const zero = makeExec(() => ({ stdout: '{"format":{"duration":"0"}}' }));
  assert.equal(await probeDurationSec('a.mp4', { ffprobe: 'ffprobe', execFile: zero }), null);

  const boom = makeExec(() => { throw Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' }); });
  assert.equal(await probeDurationSec('a.mp4', { ffprobe: 'ffprobe', execFile: boom }), null);

  // no ffprobe available at all -> null, no throw
  const noProbe = missingExec();
  assert.equal(await probeDurationSec('a.mp4', { execFile: noProbe }), null);

  assert.equal(await probeDurationSec('', { execFile: noProbe }), null);
  assert.equal(await probeDurationSec(null, { execFile: noProbe }), null);
});

// ===========================================================================
// ffmpeg: embedCover (mock exec writes the temp file, no real ffmpeg)
// ===========================================================================
test('ffmpeg: embedCover atomically replaces the mp4 after a successful run', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'IPX-920.mp4');
    const cover = path.join(dir, 'IPX-920.jpg');
    await fsp.writeFile(video, 'ORIGINAL');
    await fsp.writeFile(cover, JPG);

    const tmp = tmpCoverPath(video);
    const exec = makeExec(async (cmd, args) => {
      if(cmd==='ffprobe')return probeFixture(args);
      assert.equal(cmd, 'ffmpeg');
      assert.deepEqual(args, buildEmbedArgs('mp4-attached-pic', video, cover, args.at(-1)));
      assert.ok(path.basename(path.dirname(args.at(-1))).startsWith('.avc-cover-'));
      await fsp.writeFile(args[args.length - 1], 'NEW-WITH-COVER');
      return { stdout: 'ffmpeg done', stderr: '' };
    });

    const res = await embedCover(video, cover, { ffmpeg: 'ffmpeg', execFile: exec });
    assert.equal(res.ok, true);
    assert.equal(res.method, 'mp4-attached-pic');
    assert.equal(typeof res.elapsedMs, 'number');
    assert.ok(res.elapsedMs >= 0);
    assert.equal(await fsp.readFile(video, 'utf8'), 'NEW-WITH-COVER');
    await assert.rejects(() => fsp.stat(tmp), (err) => err.code === 'ENOENT');
    assert.equal(exec.calls.length, 3);
  });
});

test('ffmpeg: embedCover writes to outPath and leaves the source untouched', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'ABP-984.mkv');
    const cover = path.join(dir, 'ABP-984.jpg');
    const outPath = path.join(dir, 'out', 'ABP-984.embedded.mkv');
    await fsp.writeFile(video, 'ORIGINAL-MKV');
    await fsp.writeFile(cover, JPG);

    const exec = makeExec(async (cmd, args) => {
      if(cmd==='ffprobe')return probeFixture(args);
      await fsp.writeFile(args[args.length - 1], 'NEW-MKV');
      return { stdout: '' };
    });
    const res = await embedCover(video, cover, { outPath, ffmpeg: 'ffmpeg', execFile: exec });
    assert.equal(res.method, 'mkv-attachment');
    assert.equal(await fsp.readFile(outPath, 'utf8'), 'NEW-MKV');
    assert.equal(await fsp.readFile(video, 'utf8'), 'ORIGINAL-MKV');
  });
});

test('ffmpeg: embedCover auto-detects ffmpeg when not supplied', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'a.mp4');
    const cover = path.join(dir, 'a.jpg');
    await fsp.writeFile(video, 'ORIGINAL');
    await fsp.writeFile(cover, JPG);

    const exec = makeExec(async (cmd, args) => {
      if (args[0] === '-version') return { stdout: `${cmd} version 6.0-test` };
      if(cmd==='ffprobe')return probeFixture(args);
      await fsp.writeFile(args[args.length - 1], 'EMBEDDED');
      return { stdout: '' };
    });
    // no `ffmpeg` option: detectFfmpeg runs against the injected mock
    const res = await embedCover(video, cover, { execFile: exec });
    assert.equal(res.ok, true);
    assert.equal(await fsp.readFile(video, 'utf8'), 'EMBEDDED');
    assert.ok(exec.calls.some((c) => c.args[0] === '-version'), 'detection should have run');
  });
});

test('ffmpeg: embedCover throws FFMPEG_MISSING and never touches the video', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'a.mp4');
    const cover = path.join(dir, 'a.jpg');
    await fsp.writeFile(video, 'ORIGINAL');
    await fsp.writeFile(cover, JPG);

    await assert.rejects(
      () => embedCover(video, cover, { execFile: missingExec() }),
      (err) => err.code === 'FFMPEG_MISSING',
    );
    assert.equal(await fsp.readFile(video, 'utf8'), 'ORIGINAL');
    await assert.rejects(() => fsp.stat(tmpCoverPath(video)), (err) => err.code === 'ENOENT');
  });
});

test('ffmpeg: embedCover rejects unsupported containers before running anything', async () => {
  const exec = missingExec();
  await assert.rejects(
    () => embedCover('C:\\v\\a.avi', 'C:\\v\\a.jpg', { ffmpeg: 'ffmpeg', execFile: exec }),
    (err) => err.code === 'UNSUPPORTED_CONTAINER',
  );
  assert.equal(exec.calls.length, 0);
});

test('ffmpeg: a failed run cleans up the temp file and keeps the original', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'a.mp4');
    const cover = path.join(dir, 'a.jpg');
    await fsp.writeFile(video, 'ORIGINAL');
    await fsp.writeFile(cover, JPG);

    const tmp = tmpCoverPath(video);
    const exec = makeExec(async (cmd, args) => {
      await fsp.writeFile(args[args.length - 1], 'PARTIAL');
      throw Object.assign(new Error('ffmpeg exited with code 1'), { code: 'FFMPEG_EXIT' });
    });
    await assert.rejects(
      () => embedCover(video, cover, { ffmpeg: 'ffmpeg', execFile: exec }),
      (err) => err.code === 'FFMPEG_EXIT',
    );
    assert.equal(await fsp.readFile(video, 'utf8'), 'ORIGINAL');
    await assert.rejects(() => fsp.stat(tmp), (err) => err.code === 'ENOENT');
  });
});

test('ffmpeg: embedCover reports FFMPEG_NO_OUTPUT when ffmpeg writes nothing', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'a.mp4');
    const cover = path.join(dir, 'a.jpg');
    await fsp.writeFile(video, 'ORIGINAL');
    await fsp.writeFile(cover, JPG);

    const exec = makeExec(() => ({ stdout: '' })); // resolves without creating the tmp file
    await assert.rejects(
      () => embedCover(video, cover, { ffmpeg: 'ffmpeg', execFile: exec }),
      (err) => err.code === 'FFMPEG_NO_OUTPUT',
    );
    assert.equal(await fsp.readFile(video, 'utf8'), 'ORIGINAL');
  });
});

test('ffmpeg: embedCover keeps a timeout error code and cleans up', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'a.mkv');
    const cover = path.join(dir, 'a.jpg');
    await fsp.writeFile(video, 'ORIGINAL');
    await fsp.writeFile(cover, JPG);

    const exec = timeoutExec();
    await assert.rejects(
      () => embedCover(video, cover, { ffmpeg: 'ffmpeg', execFile: exec, timeoutMs: 50 }),
      (err) => err.code === 'FFMPEG_TIMEOUT',
    );
    assert.equal(await fsp.readFile(video, 'utf8'), 'ORIGINAL');
    assert.equal(exec.calls[0].opts.timeoutMs, 50);
  });
});

test('ffmpeg: embedCover validates its arguments', async () => {
  await assert.rejects(() => embedCover('', 'c.jpg', { ffmpeg: 'ffmpeg', execFile: okVersionExec }), TypeError);
  await assert.rejects(() => embedCover('a.mp4', '', { ffmpeg: 'ffmpeg', execFile: okVersionExec }), TypeError);
});

// ===========================================================================
// covers: metadata URL picking
// ===========================================================================
test('covers: pickCoverUrl follows the documented field priority', () => {
  assert.equal(
    pickCoverUrl({
      coverUrl: 'https://cdn/coverUrl.jpg',
      cover_image: 'https://cdn/cover_image.jpg',
      wide_thumbnail: 'https://cdn/wide.jpg',
      thumbnail_image: 'https://cdn/thumb.jpg',
    }),
    'https://cdn/coverUrl.jpg',
  );
  assert.equal(pickCoverUrl({ cover_image: 'https://cdn/cover_image.jpg', wide_thumbnail: 'https://cdn/wide.jpg', thumbnail_image: 'https://cdn/thumb.jpg' }), 'https://cdn/cover_image.jpg');
  assert.equal(pickCoverUrl({ wide_thumbnail: 'https://cdn/wide.jpg', thumbnail_image: 'https://cdn/thumb.jpg' }), 'https://cdn/wide.jpg');
  assert.equal(pickCoverUrl({ thumbnail_image: 'https://cdn/thumb.jpg' }), 'https://cdn/thumb.jpg');
});

test('covers: pickCoverUrl skips empty values and returns null when nothing usable', () => {
  assert.equal(pickCoverUrl({}), null);
  assert.equal(pickCoverUrl(null), null);
  assert.equal(pickCoverUrl(undefined), null);
  assert.equal(pickCoverUrl('string'), null);
  assert.equal(pickCoverUrl({ coverUrl: '   ', cover_image: '', wide_thumbnail: null, thumbnail_image: undefined }), null);
  assert.equal(pickCoverUrl({ coverUrl: ' https://cdn/x.jpg ' }), 'https://cdn/x.jpg');
  // a non-string JSON type must not leak through
  assert.equal(pickCoverUrl({ coverUrl: { href: 'https://cdn/x.jpg' } }), null);
  // arrays (some sources return candidate lists) pick the first non-empty entry
  assert.equal(pickCoverUrl({ cover_image: ['', 'https://cdn/a.jpg', 'https://cdn/b.jpg'] }), 'https://cdn/a.jpg');
});

// ===========================================================================
// covers: magic-number sniffing
// ===========================================================================
test('covers: isImage detects jpg/png/webp magic numbers', () => {
  assert.equal(isImage(JPG), 'jpg');
  assert.equal(isImage(PNG), 'png');
  assert.equal(isImage(WEBP), 'webp');
});

test('covers: isImage returns null for non-images and short buffers', () => {
  assert.equal(isImage(Buffer.from('<html><body>Just a moment...</body></html>')), null);
  assert.equal(isImage(Buffer.from('GIF89a')), null);
  assert.equal(isImage(Buffer.from('RIFF....WAVE')), null); // RIFF but not WEBP
  assert.equal(isImage(Buffer.alloc(0)), null);
  assert.equal(isImage(Buffer.from([0xff, 0xd8])), null); // truncated jpeg
  assert.equal(isImage(null), null);
  assert.equal(isImage(undefined), null);
  assert.equal(isImage('not a buffer'), null);
});

// ===========================================================================
// covers: sidecar paths
// ===========================================================================
test('covers: coverSidecarPath keeps the directory and swaps the extension', () => {
  assert.equal(coverSidecarPath(path.join('C:', 'vids', 'IPX-920.mp4')), path.join('C:', 'vids', 'IPX-920.jpg'));
  assert.equal(coverSidecarPath(path.join('/media', 'a.b', 'ABP-984.4K.mkv')), path.join('/media', 'a.b', 'ABP-984.4K.jpg'));
  // suffix is inserted before the extension
  assert.equal(coverSidecarPath(path.join('C:', 'vids', 'IPX-920.mp4'), { suffix: '-cover' }), path.join('C:', 'vids', 'IPX-920-cover.jpg'));
  // explicit extension (writeCover passes the sniffed one)
  assert.equal(coverSidecarPath(path.join('C:', 'vids', 'IPX-920.mp4'), { ext: '.png' }), path.join('C:', 'vids', 'IPX-920.png'));
  assert.throws(() => coverSidecarPath(''), TypeError);
});

// ===========================================================================
// covers: downloadCover
// ===========================================================================
test('covers: downloadCover returns bytes + sniffed ext for an image response', async () => {
  const url = 'https://cdn.example/cover.jpg';
  const http = makeStubHttp({ [url]: { buffer: JPG, headers: { 'content-type': 'image/jpeg' } } });
  const out = await downloadCover(http, url);
  assert.deepEqual(out.buffer, JPG);
  assert.equal(out.ext, 'jpg');
  assert.equal(out.contentType, 'image/jpeg');
  assert.equal(http.calls.length, 1);
  assert.match(http.calls[0].opts.headers.Accept, /image\/\*/);
});

test('covers: downloadCover sniffs png/webp and trusts bytes over the header', async () => {
  const pngUrl = 'https://cdn.example/cover';
  const httpPng = makeStubHttp({ [pngUrl]: { buffer: PNG, headers: { 'content-type': 'application/octet-stream' } } });
  const png = await downloadCover(httpPng, pngUrl);
  assert.equal(png.ext, 'png');

  const webpUrl = 'https://cdn.example/cover2';
  const httpWebp = makeStubHttp({ [webpUrl]: { buffer: WEBP, headers: { 'content-type': 'image/webp' } } });
  assert.equal((await downloadCover(httpWebp, webpUrl)).ext, 'webp');

  // real image bytes behind a text/html content-type are still accepted
  const mislabeled = 'https://cdn.example/cover3';
  const httpMisl = makeStubHttp({ [mislabeled]: { buffer: JPG, headers: { 'content-type': 'text/html; charset=utf-8' } } });
  assert.equal((await downloadCover(httpMisl, mislabeled)).ext, 'jpg');
});

test('covers: downloadCover rejects HTML with NOT_IMAGE', async () => {
  const url = 'https://cdn.example/blocked';
  const html = '<html><head><title>Just a moment...</title></head></html>';
  const http = makeStubHttp({ [url]: { text: html, headers: { 'content-type': 'text/html' } } });
  await assert.rejects(() => downloadCover(http, url), (err) => {
    assert.equal(err.code, 'NOT_IMAGE');
    assert.equal(err.contentType, 'text/html');
    assert.equal(err.bytes, Buffer.byteLength(html));
    return true;
  });
});

test('covers: downloadCover rejects empty bodies, HTTP errors, bad urls and oversize payloads', async () => {
  const emptyUrl = 'https://cdn.example/empty';
  await assert.rejects(
    () => downloadCover(makeStubHttp({ [emptyUrl]: { buffer: Buffer.alloc(0) } }), emptyUrl),
    (err) => err.code === 'NOT_IMAGE',
  );

  const missingUrl = 'https://cdn.example/404';
  await assert.rejects(
    () => downloadCover(makeStubHttp({ [missingUrl]: { status: 404, text: 'nope' } }), missingUrl),
    (err) => err.code === 'COVER_HTTP' && err.status === 404,
  );

  await assert.rejects(
    () => downloadCover(makeStubHttp({}), ''),
    (err) => err.code === 'COVER_BAD_URL',
  );

  const bigUrl = 'https://cdn.example/big';
  const big = Buffer.concat([JPG, Buffer.alloc(1024)]);
  await assert.rejects(
    () => downloadCover(makeStubHttp({ [bigUrl]: { buffer: big } }), bigUrl, { maxBytes: 64 }),
    (err) => err.code === 'COVER_TOO_LARGE',
  );

  // network errors from the transport propagate untouched
  const netUrl = 'https://cdn.example/boom';
  const http = makeStubHttp({ [netUrl]: { throw: Object.assign(new Error('TLS_ERR'), { code: 'TLS_ERR' }) } });
  await assert.rejects(() => downloadCover(http, netUrl), /TLS_ERR/);
});

// ===========================================================================
// covers: writeCover
// ===========================================================================
test('covers: writeCover writes <stem>.jpg beside the video and verifies bytes', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'IPX-920 テスト.mp4');
    const out = await writeCover(video, JPG);
    assert.equal(out.path, path.resolve(path.join(dir, 'IPX-920 テスト.jpg')));
    assert.equal(out.posterPath, null);
    assert.equal(out.bytes, JPG.length);
    assert.deepEqual(await fsp.readFile(out.path), JPG);
    // the video itself must not be created/modified
    await assert.rejects(() => fsp.stat(video), (err) => err.code === 'ENOENT');
  });
});

test('covers: writeCover alsoPoster writes poster.jpg with identical bytes', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'ABP-984.mkv');
    const out = await writeCover(video, JPG, { alsoPoster: true });
    assert.equal(out.path, path.resolve(path.join(dir, 'ABP-984.jpg')));
    assert.equal(out.posterPath, path.resolve(path.join(dir, 'poster.jpg')));
    assert.deepEqual(await fsp.readFile(out.path), JPG);
    assert.deepEqual(await fsp.readFile(out.posterPath), JPG);
  });
});

test('covers: writeCover picks the extension from the magic number', async () => {
  await withTempDir(async (dir) => {
    const webp = await writeCover(path.join(dir, 'a.mp4'), WEBP, { alsoPoster: true });
    assert.equal(path.basename(webp.path), 'a.webp');
    assert.equal(path.basename(webp.posterPath), 'poster.webp');
    assert.deepEqual(await fsp.readFile(webp.path), WEBP);

    const png = await writeCover(path.join(dir, 'b.mp4'), PNG);
    assert.equal(path.basename(png.path), 'b.png');
    assert.deepEqual(await fsp.readFile(png.path), PNG);
  });
});

test('covers: writeCover refuses non-image bytes without writing anything', async () => {
  await withTempDir(async (dir) => {
    const video = path.join(dir, 'x.mp4');
    await assert.rejects(
      () => writeCover(video, Buffer.from('<html>nope</html>')),
      (err) => err.code === 'NOT_IMAGE',
    );
    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, []);
  });
});
