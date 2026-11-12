import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildZip } from './zip.mjs';

export async function writeReleaseZip(outputDir, name, entries, { compress = false } = {}) {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, name);
  const buffer = buildZip(entries, { compress });
  const tempPath = path.join(outputDir, `.${name}.${randomUUID()}.tmp`);
  const file = await fs.open(tempPath, 'wx');
  try {
    await file.writeFile(buffer); await file.sync(); await file.close();
    await fs.link(tempPath, filePath);
  } finally {
    await file.close().catch(() => {});
    await fs.unlink(tempPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { filePath, buffer };
}

export async function updateReleaseChecksum(outputDir, zipName, hash) {
  const sums = path.join(outputDir, 'SHA256SUMS.txt');
  const existing = await fs.readFile(sums, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const lines = existing.split(/\r?\n/).filter(Boolean).filter(line => line.trim().split(/\s{2,}/).pop() !== zipName);
  lines.push(`${hash}  ${zipName}`);
  const temp = `${sums}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(`${lines.join('\n')}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temp, sums); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
