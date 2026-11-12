import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { collectPublicFiles, readPublicEntries, safePublicPath, PUBLIC_FILES, PUBLIC_DOC_FILES, DELIVERY_ROOT_FILES, publicNpmFiles } from '../tools/lib/public-files.mjs';
import { buildPortable } from '../tools/build-portable.mjs';
import { buildDocsZip } from '../tools/build-docs-zip.mjs';

function zipNames(buffer) {
  const entries = [];
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  let offset = buffer.readUInt32LE(buffer.length - 6);
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localOffset = buffer.readUInt32LE(offset + 42);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const method = buffer.readUInt16LE(offset + 10);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(start, start + compressedSize);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(payload) : payload });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.ok(entries.length > 0, 'zip central directory should contain entries');
  return entries;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-repair-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src', 'core'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs', 'audits'), { recursive: true });
  await fs.mkdir(path.join(root, 'web', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.8.0' }));
  for (const file of new Set([...PUBLIC_FILES, ...DELIVERY_ROOT_FILES])) {
    if (file === 'package.json' || file.startsWith('src/')) continue;
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), `fixture:${file}`);
  }
  await fs.writeFile(path.join(root, 'src', 'core', 'entry.mjs'), 'export const fixture = true;');
  await fs.writeFile(path.join(root, 'docs', 'audits', 'private.png'), 'SENSITIVE_AUDIT_SENTINEL');
  await fs.writeFile(path.join(root, 'web', 'assets', 'unknown-screenshot.png'), 'SENSITIVE_SCREENSHOT_SENTINEL');
  return root;
}

test('A12: portable and delivery archives include only public manifest files and preserve checksums', async t => {
  const root = await fixture(t);
  const outputDir = path.join(root, 'isolated-output');
  const portable = await buildPortable({ root, outputDir, withNode: false });
  const delivery = await buildDocsZip({ root, outputDir });
  const portableEntries = zipNames(portable.buffer);
  const deliveryEntries = zipNames(delivery.buffer);
  const portableNames = portableEntries.map(entry => entry.name);
  const deliveryNames = deliveryEntries.map(entry => entry.name);
  assert.ok(portableNames.includes('AVC/src/core/entry.mjs'));
  assert.ok(portableNames.includes('AVC/web/assets/bg-default.jpg'));
  assert.ok(portableNames.includes('AVC/VERSION.json'));
  assert.ok(deliveryNames.includes('AVC-v0.8.0-交付文档/docs/ARCHITECTURE.md'));
  assert.ok(!portableNames.some(name => /audits\/|screenshot|unknown/i.test(name)));
  assert.ok(!deliveryNames.some(name => /audits\/|screenshot|unknown/i.test(name)));
  assert.ok(!portableEntries.some(entry => entry.data.includes(Buffer.from('SENSITIVE_AUDIT_SENTINEL'))));
  assert.ok(!deliveryEntries.some(entry => entry.data.includes(Buffer.from('SENSITIVE_SCREENSHOT_SENTINEL'))));
  assert.deepEqual(portable.files.map(file => file.path).sort(), ['LICENSE.node.txt', ...await collectPublicFiles(root)].sort());
  const version = JSON.parse(portableEntries.find(entry => entry.name === 'AVC/VERSION.json').data.toString('utf8'));
  assert.equal(version.files.length, portable.files.length);
  for (const item of version.files) assert.equal(item.sha256, crypto.createHash('sha256').update(portableEntries.find(entry => entry.name === `AVC/${item.path}`).data).digest('hex'));
  const sums = await fs.readFile(path.join(outputDir, 'SHA256SUMS.txt'), 'utf8');
  assert.ok(sums.includes(`${portable.hash}  ${portable.zipName}`));
  assert.ok(sums.includes(`${delivery.hash}  ${delivery.zipName}`));
  await assert.rejects(buildPortable({ root, outputDir, withNode: false }), { code: 'EEXIST' });
  assert.ok(publicNpmFiles((await collectPublicFiles(root)).filter(file => file.startsWith('src/'))).includes('src/core/entry.mjs'));
  assert.ok(!PUBLIC_DOC_FILES.some(file => file.includes('audits/')));
});

test('A12: sensitive source paths fail closed before archive creation', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src', 'tmp'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'tmp', 'secret.mjs'), 'secret');
  await assert.rejects(collectPublicFiles(root), { code: 'RELEASE_PATH_UNSAFE' });
});

test('A12: mixed-case unsafe paths and linked public parents are rejected using memory fakes', async () => {
  for (const candidate of ['docs/Screenshots/LOCAL/a.png', 'src/Tmp/private.mjs', '../outside.txt', 'C:/private.txt', 'src/credentials.mjs', 'src/private.key']) assert.throws(() => safePublicPath(candidate), { code: 'RELEASE_PATH_UNSAFE' });
  await assert.rejects(readPublicEntries('synthetic', { files: ['docs/ARCHITECTURE.md'], fsApi: {
    lstat: async () => ({ isSymbolicLink: () => true }),
    readFile: async () => { throw new Error('must not read linked input'); },
  } }), { code: 'RELEASE_LINK_UNSUPPORTED' });
});

test('A12: full archive borrows this existing runtime and retains its license and manifest hash', async t => {
  const root = await fixture(t);
  const full = await buildPortable({ root, outputDir: path.join(root, 'full-output') });
  const entries = zipNames(full.buffer);
  const runtime = entries.find(entry => entry.name === 'AVC/node-runtime/node.exe');
  const actual = await fs.readFile(process.execPath);
  assert.deepEqual(runtime.data, actual);
  const version = JSON.parse(entries.find(entry => entry.name === 'AVC/VERSION.json').data);
  assert.equal(version.node, process.version);
  assert.equal(version.files.find(file => file.path === 'node-runtime/node.exe').sha256, crypto.createHash('sha256').update(actual).digest('hex'));
  assert.ok(entries.find(entry => entry.name === 'AVC/LICENSE.node.txt').data.includes(Buffer.from('Permission is hereby granted')));
});

test('A12: package files agrees with the shared policy and current runtime modules', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, publicNpmFiles((await collectPublicFiles(root)).filter(file => file.startsWith('src/'))));
});

test('A12: npm pack dry-run in an isolated fixture honors exact files and excludes evidence', async t => {
  const source = path.resolve(import.meta.dirname, '..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-repair-npm-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  pkg.name = 'avc-repair-isolated-fixture'; pkg.version = '0.0.0'; pkg.private = true;
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const rel of await collectPublicFiles(source)) {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, rel), target);
  }
  await fs.mkdir(path.join(root, 'docs/audits/2026-11-11'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/audits/2026-11-11/private.txt'), 'sensitive');
  const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  const npmCandidates = [process.env.npm_execpath, ...new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)].filter(Boolean))].flatMap(item => item?.endsWith('npm-cli.js') ? [item] : item ? [path.join(item, 'node_modules/npm/bin/npm-cli.js'), path.resolve(item, '../lib/node_modules/npm/bin/npm-cli.js')] : []);
  let npmCli;
  for (const candidate of npmCandidates) if (await fs.stat(candidate).then(stat => stat.isFile()).catch(() => false)) { npmCli = candidate; break; }
  assert.ok(npmCli, 'an existing npm installation is required; no runtime or tooling is downloaded');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  const pack = JSON.parse(result.stdout)[0];
  const names = pack.files.map(file => file.path.replaceAll('\\', '/'));
  assert.ok(names.includes('src/server.mjs'));
  assert.ok(names.includes('web/index.html'));
  assert.ok(names.includes('docs/PROJECT_AUDIT_PROMPT.md'));
  assert.ok(!names.some(name => /audits|private\.txt|tests\/|tmp\//i.test(name)));
  assert.equal(await fs.readdir(root).then(entries => entries.some(name => name.endsWith('.tgz'))), false);
});
