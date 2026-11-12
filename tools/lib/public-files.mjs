import fs from 'node:fs/promises';
import path from 'node:path';

export const PUBLIC_ROOT_FILES = ['package.json', 'config.example.json', 'README.md', 'LICENSE', 'start-gui.cmd'];
export const PUBLIC_SOURCE_ROOTS = ['src'];
export const PUBLIC_WEB_FILES = [
  'web/index.html', 'web/app.js', 'web/workflow.js', 'web/work-panel.js', 'web/updates.js', 'web/i18n.js',
  'web/preferences.js', 'web/maintenance.js', 'web/assembly.js', 'web/appearance.js', 'web/effects.js',
  'web/effects-bootstrap.js', 'web/sakura.js', 'web/startup.html', 'web/startup.js', 'web/startup-art.js',
  'web/styles.css', 'web/workflow.css', 'web/updates.css', 'web/preferences.css', 'web/assembly.css',
  'web/appearance.css', 'web/effects.css', 'web/startup.css', 'web/locales/en.js',
  'web/assets/app-icon.svg', 'web/assets/bg-default.jpg', 'web/assets/sakura-branch.svg',
  'web/assets/yuyuko-startup.svg', 'web/assets/yuyuko-startup.png', 'web/assets/yuyuko-avatar.jpg',
  'web/assets/effects/work.jpg', 'web/assets/effects/history.jpg', 'web/assets/effects/settings.jpg', 'web/assets/effects/assembly.jpg',
];
export const PUBLIC_DOC_FILES = [
  'docs/ARCHITECTURE.md', 'docs/CONTRACTS.md', 'docs/SERVICE_API.md', 'docs/MORE_EFFECTS.md', 'docs/V081_RELIABILITY.md', 'docs/ASSET_NOTICES.md',
  'docs/V075_WORKFLOWS.md', 'docs/V075_VALIDATION.md', 'docs/V080_SUPER_ASSEMBLY.md',
  'docs/PROJECT_AUDIT_PROMPT.md', 'docs/demos/README.md', 'docs/demos/LUCIDE-LICENSE.txt', 'docs/demos/avc-v08-demo.html',
];
export const PUBLIC_FILES = [...PUBLIC_ROOT_FILES, ...PUBLIC_WEB_FILES, ...PUBLIC_DOC_FILES];
export const DELIVERY_ROOT_FILES = ['README.md', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'config.example.json'];

const deniedSegment = /^(?:screenshots|local|audits|data|tmp|fixtures|node_modules|dist|pack|backups?)$/i;
export function safePublicPath(file) {
  const normalized = file.replaceAll('\\', '/');
  if (/^(?:\/|[a-z]:)/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..' || deniedSegment.test(part)) || /(?:^|\/)(?:config\.local|\.env|secrets?|credentials?)(?:\.|$)/i.test(normalized) || /\.(?:pem|key|pfx|p12|bak)$/i.test(normalized)) {
    throw Object.assign(new Error(`release manifest rejects unsafe path: ${normalized}`), { code: 'RELEASE_PATH_UNSAFE' });
  }
  return normalized;
}

async function validateFile(root, file, fsApi) {
  const rel = safePublicPath(file);
  const components = rel.split('/');
  for (let index = 0; index < components.length; index++) {
    const stat = await fsApi.lstat(path.join(root, ...components.slice(0, index + 1)));
    if (stat.isSymbolicLink()) throw Object.assign(new Error(`release input is linked: ${rel}`), { code: 'RELEASE_LINK_UNSUPPORTED' });
    if (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw Object.assign(new Error(`required public file is invalid: ${rel}`), { code: 'RELEASE_INPUT_MISSING' });
  }
}

export async function collectPublicFiles(root, { fsApi = fs } = {}) {
  const files = [...PUBLIC_FILES];
  async function sourceFiles(dir) {
    let entries;
    try { entries = await fsApi.readdir(path.join(root, dir), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') throw Object.assign(new Error(`missing required public directory: ${dir}`), { code: 'RELEASE_INPUT_MISSING', cause: error }); throw error; }
    for (const entry of entries) {
      const rel = safePublicPath(path.posix.join(dir, entry.name));
      if (entry.isSymbolicLink()) throw Object.assign(new Error(`release source contains a linked entry: ${rel}`), { code: 'RELEASE_LINK_UNSUPPORTED' });
      if (entry.isDirectory()) await sourceFiles(rel);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(rel);
    }
  }
  for (const dir of PUBLIC_SOURCE_ROOTS) {
    const st = await fsApi.lstat(path.join(root, dir));
    if (!st.isDirectory() || st.isSymbolicLink()) throw Object.assign(new Error(`release source root invalid: ${dir}`), { code: 'RELEASE_LINK_UNSUPPORTED' });
    await sourceFiles(dir);
  }
  const seen = new Set();
  for (const file of files) {
    safePublicPath(file);
    if (seen.has(file)) throw new Error(`duplicate public release path: ${file}`);
    seen.add(file);
    await validateFile(root, file, fsApi);
  }
  return files.sort();
}

export async function readPublicEntries(root, { fsApi = fs, files = null } = {}) {
  const selected = files || await collectPublicFiles(root, { fsApi });
  return Promise.all(selected.map(async rel => {
    await validateFile(root, rel, fsApi);
    const stat = await fsApi.stat(path.join(root, rel));
    return { path: rel, data: await fsApi.readFile(path.join(root, rel)), mtime: stat.mtime };
  }));
}

export function publicNpmFiles(sourceFiles) {
  if (!Array.isArray(sourceFiles) || !sourceFiles.length) throw new Error('explicit public source files required');
  for (const file of sourceFiles) if (!safePublicPath(file).startsWith('src/') || !file.endsWith('.mjs')) throw new Error('invalid public source file');
  return [...sourceFiles, ...PUBLIC_WEB_FILES, ...PUBLIC_DOC_FILES, 'config.example.json', 'start-gui.cmd', 'README.md', 'LICENSE'];
}
