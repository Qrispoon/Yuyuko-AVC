// Zero-dependency ZIP writer (UTF-8 names, store or deflate via node:zlib).
// Used by tools/build-docs-zip.mjs (store) and tools/build-portable.mjs (deflate).
// Safe for deliverables < 4 GB, no Zip64.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const input = date instanceof Date ? date : new Date();
  const d = Number.isNaN(input.getTime()) ? new Date() : input;
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * Build a ZIP buffer from entries.
 * @param {{name:string, data:Buffer|string, mtime?:Date}[]} entries
 *   name uses forward slashes; directories are implicit (created by zip readers).
 * @param {{compress?:boolean, level?:number}} [opts]
 *   compress=false (default) stores entries; compress=true deflates when smaller.
 * @returns {Buffer}
 */
export function buildZip(entries, opts = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const compress = !!opts.compress;
  const level = Number.isInteger(opts.level) ? opts.level : 9;
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const seen = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) throw new TypeError('entry.name is required');
    const name = entry.name.replace(/\\/g, '/');
    if (name.startsWith('/') || name.includes('..')) throw new Error(`unsafe zip entry: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate zip entry: ${name}`);
    seen.add(name);

    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime);
    const flags = 0x0800; // bit 11: file name is UTF-8

    let method = 0;
    let payload = data;
    if (compress && data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central directory disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/** Write a ZIP (built by buildZip) to disk. */
export async function writeZip(filePath, entries, opts = {}) {
  const buffer = buildZip(entries, opts);
  await fs.writeFile(filePath, buffer);
  return { filePath, bytes: buffer.length, count: entries.length };
}

export default { crc32, buildZip, writeZip };
