import fs from 'node:fs/promises';
import path from 'node:path';
import { openState } from './state.mjs';

// Only disposable, application-owned cache files. Never follow a linked cache
// directory, walk arbitrary subdirectories, or remove installed media sidecars.
export async function clearCaches(dataDir, covers = new Map()) {
  const dir = path.join(path.resolve(dataDir), 'subtitle-previews');
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const stat = await fs.lstat(dir).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await fs.realpath(dir)) !== canonical(dir))) {
    throw Object.assign(new Error('unsafe_cache_directory'), { status: 409 });
  }
  let previewFiles = 0, previewBytes = 0;
  for (const name of stat ? await fs.readdir(dir) : []) {
    if (!/^[a-f0-9]{64}\.json$/i.test(name)) continue;
    const file = path.join(dir, name), item = await fs.lstat(file);
    if (!item.isFile() || item.isSymbolicLink()) continue;
    await fs.unlink(file);
    previewFiles++;
    previewBytes += item.size;
  }
  const store = openState(path.join(dataDir, 'state.db'));
  let metadata;
  try { metadata = store.clearCodeCache(); } finally { store.close(); }
  const coverEntries = covers.size;
  const coverBytes = [...covers.values()].reduce((n, c) => n + (c.buf?.length || 0), 0);
  covers.clear();
  return { metadataEntries: metadata.entries, previewFiles, coverEntries,
    entries: metadata.entries + previewFiles + coverEntries,
    bytes: metadata.bytes + previewBytes + coverBytes };
}
