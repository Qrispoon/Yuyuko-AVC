// Cover (poster) handling: choose a URL from merged metadata, validate downloaded bytes by
// magic number, and write the cover beside the video.
//
// Layout convention (sibling files, same directory as the video):
//   `<video stem>.jpg`      cover, extension chosen from the actual bytes (jpg/png/webp)
//   `poster.jpg`            optional second copy for media centres (Jellyfin/Emby/Kodi)
//
// Zero dependencies; the HTTP transport is injected (`http.getFollow` from src/net/http.mjs)
// so this module never touches the network by itself.
//
// Stable error codes:
//   NOT_IMAGE       downloaded/written bytes are not a supported image
//   COVER_HTTP      non-200 response while downloading
//   COVER_BAD_URL   empty/invalid URL
//   COVER_TOO_LARGE response exceeded maxBytes
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJournalSidecar } from '../core/journal.mjs';
import { throwIfAborted } from '../core/durable.mjs';

/** Metadata fields that may carry a cover URL, strongest first. */
export const COVER_URL_KEYS = ['coverUrl', 'cover_image', 'wide_thumbnail', 'thumbnail_image'];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function coverError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** Accept Buffer / Uint8Array / ArrayBuffer / string; normalise to Buffer (or null). */
function toBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return null;
}

/**
 * Pick the best cover URL from metadata.
 *
 * Priority: `coverUrl` (already merged by the pipeline) > `cover_image` (manko detail) >
 * `wide_thumbnail` > `thumbnail_image` (manko list records). Empty/whitespace/non-string
 * values are skipped.
 *
 * @param {object|null|undefined} meta
 * @returns {string|null}
 */
export function pickCoverUrl(meta) {
  if (!meta || typeof meta !== 'object') return null;
  for (const key of COVER_URL_KEYS) {
    const value = meta[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === 'string' && v.trim());
      if (first) return first.trim();
    }
  }
  return null;
}

/**
 * Sniff an image by magic number.
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer
 * @returns {'jpg'|'png'|'webp'|null}
 */
export function isImage(buffer) {
  const buf = toBuffer(buffer);
  if (!buf || buf.length < 3) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => buf[i] === byte)) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * Sibling cover path for a video: `<same dir>/<stem><suffix>.<ext>`.
 *
 * @param {string} videoPath
 * @param {{ suffix?: string, ext?: string }} [opts] `suffix` is inserted before the extension.
 * @returns {string}
 */
export function coverSidecarPath(videoPath, opts = {}) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  const suffix = String(opts.suffix == null ? '' : opts.suffix);
  const ext = String(opts.ext || 'jpg').replace(/^\./, '').toLowerCase() || 'jpg';
  const dir = path.dirname(videoPath);
  const videoExt = path.extname(videoPath);
  const stem = videoExt ? path.basename(videoPath, videoExt) : path.basename(videoPath);
  return path.join(dir, `${stem}${suffix}.${ext}`);
}

/**
 * Download a cover image through the injected HTTP transport.
 *
 * @param {{ getFollow: Function }} http  transport from `createHttp(config.network)`
 * @param {string} url
 * @param {{ headers?: object, timeoutMs?: number, retry?: number, maxBytes?: number }} [opts]
 * @returns {Promise<{ buffer: Buffer, ext: 'jpg'|'png'|'webp', contentType: string|null }>}
 * @throws code COVER_BAD_URL | COVER_HTTP | COVER_TOO_LARGE | NOT_IMAGE
 */
export async function downloadCover(http, url, opts = {}) {
  const target = String(url || '').trim();
  if (!target) throw coverError('COVER_BAD_URL: empty cover url', 'COVER_BAD_URL', { url });
  if (!http || typeof http.getFollow !== 'function') throw new TypeError('downloadCover: http.getFollow is required');

  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const res = await http.getFollow(target, {
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.8', ...(opts.headers || {}) },
    timeoutMs: opts.timeoutMs,
    retry: opts.retry,
  });

  if (!res || res.status !== 200) {
    const status = res ? res.status : 0;
    throw coverError(`COVER_HTTP_${status}`, 'COVER_HTTP', { status, url: res?.url || target });
  }

  const buffer = toBuffer(res.buffer) || toBuffer(res.text) || Buffer.alloc(0);
  if (buffer.length > maxBytes) {
    throw coverError(`COVER_TOO_LARGE ${buffer.length} > ${maxBytes}`, 'COVER_TOO_LARGE', { bytes: buffer.length, maxBytes, url: res.url || target });
  }
  const contentTypeHeader = res.headers?.['content-type'] || res.headers?.['Content-Type'] || null;
  const contentType = contentTypeHeader ? String(contentTypeHeader).split(';')[0].trim().toLowerCase() : null;
  const ext = isImage(buffer);
  if (!ext) {
    const sample = buffer.subarray(0, 16).toString('hex');
    throw coverError(`NOT_IMAGE ${contentType || '(no content-type)'} bytes=${buffer.length} head=${sample}`, 'NOT_IMAGE', {
      contentType,
      bytes: buffer.length,
      url: res.url || target,
    });
  }
  return { buffer, ext, contentType };
}

/**
 * Write the cover beside the video. The extension follows the sniffed bytes, not the URL.
 *
 * @param {string} videoPath
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer raw image bytes
 * @param {{ alsoPoster?: boolean }} [opts] also write `poster.jpg` (media-centre convention)
 * @returns {Promise<{ path: string, posterPath: string|null, bytes: number }>}
 * @throws code NOT_IMAGE when the bytes are not a supported image
 */
export async function writeCover(videoPath, buffer, opts = {}) {
  if (!videoPath || typeof videoPath !== 'string') throw new TypeError('videoPath must be a non-empty string');
  const bytes = toBuffer(buffer);
  const ext = isImage(bytes);
  if (!ext) {
    throw coverError('NOT_IMAGE: cover bytes are not a jpg/png/webp image', 'NOT_IMAGE', { bytes: bytes ? bytes.length : 0 });
  }

  const target = coverSidecarPath(videoPath, { ext });
  throwIfAborted(opts.signal);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const write = async (file,kind) => {
    if(opts.journal)return writeJournalSidecar(opts.journal,videoPath,file,bytes,{kind,signal:opts.signal});
    const h=await fs.open(file,'wx');try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}
    return {backup:null};
  };
  const cover=await write(target,'cover');

  let posterPath = null;
  if (opts.alsoPoster) {
    // `poster.jpg` is the conventional name; keep the real extension if the bytes are png/webp
    // so the file never lies about its content type.
    posterPath = path.join(path.dirname(target), `poster.${ext}`);
    var poster=await write(posterPath,'poster');
  }

  return {
    path: path.resolve(target),
    posterPath: posterPath ? path.resolve(posterPath) : null,
    bytes: bytes.length,
    backup:cover.backup, posterBackup:poster?.backup||null,
  };
}

export default { pickCoverUrl, isImage, coverSidecarPath, downloadCover, writeCover };
