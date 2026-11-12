#!/usr/bin/env node
// Release consistency checks (zero dependencies).
//   node tools/check-release.mjs [--json]
//
// Checks:
//   1. package.json version === the product version example in docs/SERVICE_API.md
//   2. no leftover release placeholders in source/docs
//   3. repository paths referenced from README/docs (backtick paths) exist
//   4. CHANGELOG.md has a heading for the current version
//   5. no hardcoded product version constants left in src/
//
// Exit code 1 when anything fails; every problem is printed as a separate "FAIL: ..." line.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invalidDocPaths } from './lib/doc-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node tools/check-release.mjs [--json]\n\n退出码 0=全部通过，1=存在失败项。');
  process.exit(0);
}
const AS_JSON = argv.includes('--json');

const failures = [];
const checks = [];
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function check(name) {
  const record = { name, ok: true, failures: [] };
  checks.push(record);
  return {
    fail(message) {
      record.ok = false;
      record.failures.push(message);
      failures.push(`${name}: ${message}`);
    },
  };
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function readTextIfText(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 512 * 1024) return null;
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 1024).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();

// 1. package.json version === docs/SERVICE_API.md product version example
{
  const c = check('version-consistency');
  if (!version) c.fail('package.json has no version');
  const apiFile = path.join(ROOT, 'docs', 'SERVICE_API.md');
  const apiText = await readTextIfText(apiFile);
  if (apiText == null) {
    c.fail('docs/SERVICE_API.md not found');
  } else {
    const m = apiText.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
    if (!m) c.fail('docs/SERVICE_API.md has no product version example ("version": "x.y.z")');
    else if (m[1] !== version) c.fail(`docs/SERVICE_API.md example version ${m[1]} != package.json ${version}`);
  }
}

// 2. leftover release placeholders
{
  const c = check('release-placeholders');
  const tokens = [
    '<' + 'USER' + '>',
    '<' + '仓库名' + '>',
    '<' + '安全邮箱' + '>',
    '[' + 'Project name' + ']',
  ];
  const files = [];
  for (const dir of ['docs', 'src', 'web', 'tools', 'tests', '.github']) {
    files.push(...await walkFiles(path.join(ROOT, dir)));
  }
  for (const name of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ROADMAP.md', 'start-gui.cmd', 'package.json']) {
    const full = path.join(ROOT, name);
    if (await fs.stat(full).then((s) => s.isFile()).catch(() => false)) files.push(full);
  }
  for (const file of files) {
    const text = await readTextIfText(file);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    for (const token of tokens) {
      const hits = [];
      lines.forEach((line, index) => {
        if (line.includes(token)) hits.push(index + 1);
      });
      if (hits.length) c.fail(`${rel(file)}:${hits.slice(0, 5).join(',')} contains placeholder ${token}${hits.length > 5 ? ` (+${hits.length - 5} more lines)` : ''}`);
    }
  }
}

// 3. repository paths referenced from README/docs must exist
{
  const c = check('referenced-paths');
  // Only README + docs: CHANGELOG may keep historical references to removed paths.
  const docFiles = [path.join(ROOT, 'README.md')];
  docFiles.push(...await walkFiles(path.join(ROOT, 'docs')));
  for (const file of docFiles) {
    const text = await readTextIfText(file);
    if (text == null) continue;
    for (const reference of await invalidDocPaths(text, {
      documentPath: rel(file),
      exists: token => fs.stat(path.join(ROOT, token)).then(() => true).catch(() => false),
    })) c.fail(`${rel(file)}:${reference.line} references ${reference.kind === 'unsafe' ? 'unsafe' : 'missing'} path ${reference.path}`);
  }
}

// 4. CHANGELOG heading for the current version
{
  const c = check('changelog-version');
  const file = path.join(ROOT, 'CHANGELOG.md');
  const text = await readTextIfText(file);
  if (text == null) {
    c.fail('CHANGELOG.md not found');
  } else if (version) {
    const re = new RegExp(`^##\\s*\\[?${escapeRegExp(version)}\\]?(?:\\s|$)`, 'm');
    // heading examples: "## [0.6.0] - 2026-11-08" or "## 0.6.0"
    const reHeading = new RegExp(`^##\\s+\\[?${escapeRegExp(version)}\\]?(?:\\s|$)`, 'm');
    if (!re.test(text) && !reHeading.test(text)) c.fail(`CHANGELOG.md has no heading for version ${version}`);
  }
}

// 5. no hardcoded product version constants in src/
{
  const c = check('no-hardcoded-version');
  const re = /\b(?:const|let|var)\s+(?:VERSION|version)\s*=\s*['"]\d+\.\d+\.\d+['"]/;
  for (const file of await walkFiles(path.join(ROOT, 'src'))) {
    const text = await readTextIfText(file);
    if (text == null) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (re.test(line)) c.fail(`${rel(file)}:${index + 1} hardcodes a product version: ${line.trim()}`);
    });
  }
}

const ok = failures.length === 0;
if (AS_JSON) {
  console.log(JSON.stringify({ ok, version, checks, failures }, null, 2));
} else {
  for (const record of checks) {
    if (record.ok) console.log(`PASS: ${record.name}`);
    else for (const message of record.failures) console.log(`FAIL: ${message}`);
  }
  console.log(ok ? `OK: release checks passed (v${version})` : `FAILED: ${failures.length} problem(s) (v${version})`);
}
process.exitCode = ok ? 0 : 1;
