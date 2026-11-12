#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectPublicFiles, readPublicEntries } from './lib/public-files.mjs';
import { updateReleaseChecksum, writeReleaseZip } from './lib/release-output.mjs';

const NODE_MIT_LICENSE = 'Node.js is licensed for use as follows:\n\nCopyright Node.js contributors. All rights reserved.\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.\n';

export async function buildPortable({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outputDir = path.join(root, 'dist'), withNode = true, runtimePath = process.execPath } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version "${version}" is not x.y.z`);
  const publicFiles = await collectPublicFiles(root);
  const sourceEntries = await readPublicEntries(root, { files: publicFiles });
  const entries = sourceEntries.map(({ path: rel, data, mtime }) => ({ name: `AVC/${rel}`, data, mtime }));
  if (withNode) entries.push({ name: 'AVC/node-runtime/node.exe', data: await fs.readFile(runtimePath), mtime: (await fs.stat(runtimePath)).mtime });
  const licensePath = path.join(path.dirname(runtimePath), 'LICENSE');
  const hasLicense = withNode && await fs.stat(licensePath).then(s => s.isFile()).catch(() => false);
  entries.push({ name: 'AVC/LICENSE.node.txt', data: hasLicense ? await fs.readFile(licensePath) : Buffer.from(NODE_MIT_LICENSE) });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const zipName = `AVC-v${version}-win64-portable${withNode ? '' : '-slim'}.zip`;
  const versionFiles = entries.map(entry => ({ path: entry.name.slice(4), bytes: entry.data.length, sha256: crypto.createHash('sha256').update(entry.data).digest('hex') }));
  const versionText = `${JSON.stringify({ product: 'avc', version, node: withNode ? process.version : null, platform: process.platform, arch: process.arch, builtAt: new Date().toISOString(), files: versionFiles }, null, 2)}\n`;
  entries.push({ name: 'AVC/VERSION.json', data: Buffer.from(versionText), mtime: new Date() });
  const result = await writeReleaseZip(outputDir, zipName, entries, { compress: true });
  const hash = crypto.createHash('sha256').update(result.buffer).digest('hex').toUpperCase();
  await updateReleaseChecksum(outputDir, zipName, hash);
  return { ...result, zipName, hash, files: versionFiles };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await buildPortable({ withNode: !process.argv.includes('--no-node') }); console.log(`built ${result.zipName} (${result.buffer.length} bytes, ${result.files.length} files + VERSION.json)`); console.log(`${result.hash}  ${result.zipName}`); }
  catch (error) { console.error(`FAIL: ${error.code || error.message}`); process.exitCode = 1; }
}
