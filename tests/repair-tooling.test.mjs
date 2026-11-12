// A10/A11: memory-only policy tests and explicitly owned synthetic runner files.
// Does not import or run the repository's other test modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { discoverTestFiles, testArguments, parseTestOptions } from '../tools/lib/test-discovery.mjs';
import { runTests } from '../tools/test.mjs';
import { collectDocPaths, invalidDocPaths } from '../tools/lib/doc-paths.mjs';

const entry = (name, kind = 'file') => ({ name, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' });

test('A10: recursive complete discovery is sorted and never imports files', async () => {
  const root = path.resolve('synthetic discovery');
  const tree = new Map([
    [path.join(root, 'tests'), [entry('z.test.mjs'), entry('helpers', 'dir'), entry('nested', 'dir'), entry('readme.md')]],
    [path.join(root, 'tests', 'helpers'), [entry('factory.mjs')]],
    [path.join(root, 'tests', 'nested'), [entry('b.test.cjs'), entry('a.test.js')]],
  ]);
  const files = await discoverTestFiles(root, { fsApi: { readdir: async dir => tree.get(dir) } });
  assert.deepEqual(files, [path.join(root, 'tests/nested/a.test.js'), path.join(root, 'tests/nested/b.test.cjs'), path.join(root, 'tests/z.test.mjs')].sort());
  assert.deepEqual(testArguments(files), ['--test', ...files]);
  assert.deepEqual(testArguments(files, { coverage: true }), ['--experimental-test-coverage', '--test', ...files]);
});

test('A10: unreadable, empty, linked or excessively long discovery fails visibly', async () => {
  await assert.rejects(discoverTestFiles('.', { fsApi: { readdir: async () => [] } }), { code: 'NO_TEST_FILES' });
  await assert.rejects(discoverTestFiles('.', { fsApi: { readdir: async () => [entry('synthetic.test.mjs', 'link')] } }), /refuses linked entry/);
  await assert.rejects(discoverTestFiles('.', { fsApi: { readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }), { code: 'EACCES' });
  assert.throws(() => testArguments([]), { code: 'NO_TEST_FILES' });
  assert.throws(() => testArguments(['a'.repeat(29000)]), { code: 'TEST_ARGUMENTS_TOO_LONG' });
  assert.deepEqual(parseTestOptions(['--list', '--coverage']), { list: true, coverage: true });
  assert.throws(() => parseTestOptions(['--unknown']), /Unknown/);
});

async function runnerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-repair-tooling-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'synthetic.test.mjs'), "import test from 'node:test'; import fs from 'node:fs/promises'; test('synthetic runner case', async () => { await fs.writeFile('executed.marker', 'executed'); });\n");
  return root;
}

test('A10: runner forwards all file arguments without a shell and preserves failure status', async t => {
  const root = await runnerFixture(t);
  let invocation;
  const status = await runTests({ root, argv: ['--coverage'], output: () => {}, spawnProcess: (exe, args, options) => {
    invocation = { exe, args, options };
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => child.emit('close', 7, null));
    return child;
  } });
  assert.equal(status, 7);
  assert.equal(invocation.exe, process.execPath);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, root);
  assert.equal(Object.hasOwn(invocation.options.env, 'NODE_TEST_CONTEXT'), false);
  assert.deepEqual(invocation.args, ['--experimental-test-coverage', '--test', path.join(root, 'tests/synthetic.test.mjs')]);
  let listed;
  assert.equal(await runTests({ root, argv: ['--list'], output: text => { listed = JSON.parse(text); }, spawnProcess: () => { throw new Error('must not spawn'); } }), 0);
  assert.deepEqual(listed, { files: ['tests/synthetic.test.mjs'], count: 1 });
});

test('A10: real runner executes only its own one-file synthetic suite', async t => {
  const root = await runnerFixture(t);
  const run = async () => {
    let output = '';
    const status = await runTests({ root, output: () => {}, spawnProcess: (exe, args, options) => {
      const child = spawn(exe, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      return child;
    } });
    return { status, output };
  };
  const passed = await run();
  assert.equal(passed.status, 0, passed.output);
  assert.equal(await fs.readFile(path.join(root, 'executed.marker'), 'utf8'), 'executed');
  await fs.writeFile(path.join(root, 'tests', 'synthetic.test.mjs'), "import test from 'node:test'; test('synthetic intentional failure', () => { throw new Error('expected fixture failure'); });\n");
  const failed = await run();
  assert.notEqual(failed.status, 0, failed.output);
  assert.match(failed.output, /expected fixture failure/);
});

test('A11: only the explicitly declared audit date template is exempt', async () => {
  const text = '将完整报告保存到 `docs/audits/YYYY-MM-DD/PROJECT_AUDIT.md`，日期采用实际审查日期。';
  let calls = 0;
  assert.deepEqual(await invalidDocPaths(text, { documentPath: 'docs/PROJECT_AUDIT_PROMPT.md', exists: async () => { calls++; return false; } }), []);
  assert.equal(calls, 0);
  assert.equal((await invalidDocPaths(text, { documentPath: 'docs/OTHER.md', exists: async () => false })).length, 1);
  assert.equal(collectDocPaths('`docs/UPPERCASE.md`')[0].kind, 'literal');
});

test('A11: actual dates, real missing links and unsafe paths are still checked', async () => {
  const source = 'Example\n`docs/audits/2026-11-11/PROJECT_AUDIT.md` and `src/exists.mjs`.\n`src/missing.mjs`\n`docs/../../outside.md`';
  const checked = [];
  const invalid = await invalidDocPaths(source, { documentPath: 'README.md', exists: async value => { checked.push(value); return value === 'src/exists.mjs'; } });
  assert.deepEqual(invalid.map(x => [x.path, x.line, x.kind]), [
    ['docs/audits/2026-11-11/PROJECT_AUDIT.md', 2, 'literal'],
    ['src/missing.mjs', 3, 'literal'],
    ['docs/../../outside.md', 4, 'unsafe'],
  ]);
  assert.equal(checked.length, 3);
});
