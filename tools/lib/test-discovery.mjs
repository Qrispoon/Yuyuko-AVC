// Shared, import-safe test discovery. It never imports discovered tests.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function discoverTestFiles(root, { fsApi = fs } = {}) {
  const directory = path.resolve(root, 'tests');
  const files = [];
  async function walk(dir) {
    for (const entry of await fsApi.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`test discovery refuses linked entry: ${path.join(dir, entry.name)}`);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.test\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(full);
    }
  }
  await walk(directory);
  files.sort();
  if (!files.length) throw Object.assign(new Error('No test files discovered'), { code: 'NO_TEST_FILES' });
  return files;
}

export function testArguments(files, { coverage = false } = {}) {
  if (!Array.isArray(files) || !files.length) throw Object.assign(new Error('No test files supplied'), { code: 'NO_TEST_FILES' });
  const args = [...(coverage ? ['--experimental-test-coverage'] : []), '--test', ...files];
  // Fail visibly instead of truncating Windows' command line or omitting tests.
  if (args.reduce((n, arg) => n + String(arg).length + 3, 0) > 28000) {
    throw Object.assign(new Error('Test command exceeds the supported command-line length'), { code: 'TEST_ARGUMENTS_TOO_LONG' });
  }
  return args;
}

export function parseTestOptions(argv = []) {
  const options = { coverage: false, list: false };
  for (const arg of argv) {
    if (arg === '--coverage') options.coverage = true;
    else if (arg === '--list') options.list = true;
    else throw new Error(`Unknown test runner option: ${arg}`);
  }
  return options;
}
