#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PUBLIC_DOC_FILES, DELIVERY_ROOT_FILES, readPublicEntries } from './lib/public-files.mjs';
import { updateReleaseChecksum, writeReleaseZip } from './lib/release-output.mjs';

export async function buildDocsZip({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outputDir = path.join(root, 'dist') } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json version must be x.y.z');
  const docs = await readPublicEntries(root, { files: PUBLIC_DOC_FILES });
  const roots = await readPublicEntries(root, { files: DELIVERY_ROOT_FILES });
  const prefix = `AVC-v${version}-交付文档/`;
  const entries = [...roots, ...docs].map(({ path: rel, data, mtime }) => ({ name: prefix + rel, data, mtime }));
  const zipName = `AVC-v${version}-交付文档.zip`;
  const result = await writeReleaseZip(outputDir, zipName, entries);
  const hash = crypto.createHash('sha256').update(result.buffer).digest('hex').toUpperCase();
  await updateReleaseChecksum(outputDir, zipName, hash);
  return { ...result, zipName, hash, files: entries.map(e => e.name) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await buildDocsZip(); console.log(`built ${result.zipName} (${result.buffer.length} bytes, ${result.files.length} files)`); console.log(`${result.hash}  ${result.zipName}`); }
  catch (error) { console.error(`FAIL: ${error.code || error.message}`); process.exitCode = 1; }
}
