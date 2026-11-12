#!/usr/bin/env node
// CLI: doctor / scan / run / undo / report / backup / restore
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createHttp } from './net/http.mjs';
import { extractCandidates } from './core/code.mjs';
import { looksNormalized } from './core/template.mjs';
import { openState } from './core/state.mjs';
import { undoJournal } from './core/rename.mjs';
import { undoMux } from './core/assembly.mjs';
import {undoAndProject} from './core/undo.mjs';
import { createBackup, restoreBackup } from './core/backup.mjs';
import { listVideos, runDirectory, scanDirectory } from './pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const args = { cmd, dir: null, flags: {}, opts: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) { args.opts[key] = next; i++; }
      else args.flags[key] = true;
    } else if (!args.dir) args.dir = a;
    else (args.extra ||= []).push(a);
  }
  return args;
}

async function loadConfig(opts = {}) {
  const local = path.join(ROOT, 'config.local.json');
  const example = path.join(ROOT, 'config.example.json');
  const file = opts.config ? path.resolve(opts.config) : (fsSync.existsSync(local) ? local : example);
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  if (opts.proxy) config.network.proxy = opts.proxy;
  if (opts['no-proxy']) config.network.proxy = null;
  return config;
}

const c = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const ok = (s) => `${c.green}${s}${c.reset}`;
const bad = (s) => `${c.red}${s}${c.reset}`;
const warn = (s) => `${c.yellow}${s}${c.reset}`;

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

async function cmdDoctor(args) {
  const config = await loadConfig(args.opts);
  const http = createHttp(config.network);
  const targets = [
    ['javbus', 'https://www.javbus.com/'],
    ['javbus-search', 'https://www.javbus.com/search/ABP-984&type=&parent=ce'],
    ['manko-front', 'https://manko.fun/'],
    ['manko-api', 'https://healertanker.com/swx/movie/search?keyword=ABP-984&size=1&page=1&can_manko=true'],
    ['subtitlecat', 'https://www.subtitlecat.com/'],
  ];
  console.log(`${c.cyan}AVC doctor${c.reset}  proxy=${config.network.proxy || '(none)'}  defaultRoute=${config.network.defaultRoute}`);
  console.log(`${c.dim}${'target'.padEnd(14)}${'route'.padEnd(8)}${'status'.padEnd(8)}ms${c.reset}`);
  let fail = 0;
  for (const [name, url] of targets) {
    const r = await http.probe(url, 12000);
    const route = r.route || http.routeFor(url);
    const statusText = r.ok ? ok(String(r.status)) : bad(r.error || 'fail');
    if (!r.ok) fail++;
    console.log(`${pad(name, 14)}${pad(route, 8)}${pad(statusText, 8)}${r.ms}`);
  }
  console.log(`\nstats: ${JSON.stringify(http.stats)}`);
  return fail ? 1 : 0;
}

async function cmdScan(args) {
  const config = await loadConfig(args.opts);
  if (!args.dir) throw new Error('usage: avc scan <dir>');
  const dir = path.resolve(args.dir);
  const rows = await scanDirectory(dir, config);
  console.log(`${c.cyan}scan${c.reset} ${dir}  (${rows.length} video files)`);
  for (const r of rows) {
    const mark = r.code ? ok(r.code.padEnd(14)) : bad('(none)'.padEnd(14));
    const scope = r.scope && r.scope !== 'censored' ? warn(`[${r.scope}]`) : '';
    console.log(`${mark} ${r.score == null ? '  ' : String(r.score).padStart(2)}  ${r.name} ${scope}`);
  }
  const found = rows.filter((r) => r.code && r.scope === 'censored').length;
  const oos = rows.filter((r) => r.scope && r.scope !== 'censored').length;
  console.log(`\n识别 ${found}/${rows.length}${oos ? `（另有 ${oos} 个范围外）` : ''}${rows.length - found - oos ? warn(`  ${rows.length - found - oos} 个未识别`) : ''}`);
  if (args.opts.json) {
    await fs.writeFile(path.resolve(args.opts.json), JSON.stringify(rows, null, 2), 'utf8');
    console.log(`saved ${args.opts.json}`);
  }
}

async function cmdRun(args) {
  const config = await loadConfig(args.opts);
  if (!args.dir) throw new Error('usage: avc run <dir> [--apply]');
  const dir = path.resolve(args.dir);
  const apply = !!args.flags.apply;
  const limit = Number(args.opts.limit || 0);
  const force = !!args.flags.force;
  const downloadSubs = !args.flags['no-subs'];
  const fileTimeoutMs = Number(args.opts['file-timeout'] || 180000);
  const maxConsecutiveFailures = Number(args.opts['max-failures'] || 5);
  const concurrency = Number(args.opts.concurrency || 1);
  const dataDir = path.resolve(config.paths?.dataDir || 'data');

  console.log(`${c.cyan}AVC run${c.reset} ${dir}`);
  console.log(`${c.dim}mode=${apply ? 'APPLY (will rename files)' : 'DRY-RUN (no disk changes)'}  subs=${downloadSubs ? 'on' : 'off'}  limit=${limit || '∞'}  concurrency=${concurrency}  fileTimeout=${fileTimeoutMs / 1000}s${c.reset}`);

  // pre-flight: warn early instead of failing 200 times
  if (!args.flags['no-preflight']) {
    const probeHttp = createHttp(config.network);
    const checks = [['javbus', 'https://www.javbus.com/']];
    if (downloadSubs) checks.push(['subtitlecat', 'https://www.subtitlecat.com/']);
    let badCount = 0;
    for (const [name, url] of checks) {
      const r = await probeHttp.probe(url, 12000);
      console.log(`  ${c.dim}preflight${c.reset} ${pad(name, 12)} ${r.ok ? ok('ok') : bad(r.error || 'fail')}  route=${r.route}`);
      if (!r.ok) badCount++;
    }
    if (badCount) console.log(warn('  ! 预检失败：请检查代理/VPN；仍会继续尝试（可用 --no-preflight 跳过预检）\n'));
    else console.log('');
  }

  await fs.mkdir(dataDir, { recursive: true });
  const logFile = path.join(dataDir, `run-${Date.now()}.log`);
  const logStream = fsSync.createWriteStream(logFile, { flags: 'a' });
  const controller = new AbortController();
  const onSigint = () => {
    console.log(warn('\n收到 Ctrl+C：正在完成当前文件后停止…（再按一次强制退出）'));
    controller.abort();
    process.once('SIGINT', () => process.exit(130));
  };
  process.once('SIGINT', onSigint);

  const logger = (line) => {
    console.log(line);
    logStream.write(line + '\n');
  };

  try {
    const report = await runDirectory({
      dir, config, apply, limit, force, downloadSubs,
      logger,
      signal: controller.signal,
      fileTimeoutMs,
      maxConsecutiveFailures,
      concurrency,
    });
    console.log(`\n${c.cyan}summary${c.reset} ${JSON.stringify(report.summary)}  (${(report.durationMs / 1000).toFixed(1)}s)`);
    console.log(`http: ${JSON.stringify(report.http)}`);
    if (report.aborted) console.log(bad(`ABORTED: ${report.aborted}`));
    if (report.cancelled) console.log(warn('CANCELLED by user (进度已保存，下次运行自动续跑)'));
    if (report.journal) console.log(`journal: ${report.journal}  ${c.dim}(avc undo 可整体回滚)${c.reset}`);

    const outFile = path.resolve(args.opts.json || path.join(dataDir, `run-${Date.now()}.json`));
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');
    console.log(`report: ${outFile}`);
    console.log(`log:    ${logFile}`);
    if (!apply) console.log(warn('\n这是 DRY-RUN，磁盘未改动。确认无误后加 --apply 执行。'));
    const failed = (report.summary.error || 0) + (report.aborted ? 1 : 0);
    return failed ? 1 : 0;
  } finally {
    try { logStream.end(); } catch {}
    process.removeListener('SIGINT', onSigint);
  }
}

async function cmdUndo(args) {
  if (!args.dir) throw new Error('usage: avc undo <journal.json>');
  const config = await loadConfig(args.opts);
  const file = path.resolve(args.dir);
  const journalData=JSON.parse(await fs.readFile(file,'utf8'));
  const res = await undoAndProject(file,{dataDir:config.paths?.dataDir||'data'});
  console.log(`${c.cyan}undo${c.reset} ${file}`);
  console.log(`restored=${res.restored} subtitles_removed=${res.removed || 0} failed=${res.failed.length}`);
  if(res.undoComplete===false)console.log(warn('undo is partial; unresolved effects are retained for review'));
  if(res.retainedEffects?.includes('embedded_cover'))console.log('Embedded cover is retained; original media bytes are not recoverable.');
  for (const f of res.failed) console.log(warn(`  ! ${f.to || f.from || f.file}  ${f.reason || f.error}`));
  // reset state rows so a restored file gets processed again next run
  if(res.stateError)console.log(warn(`state reconciliation pending: ${res.stateError}`));
  return res.failed.length || res.stateError ? 1 : 0;
}

async function cmdReport(args) {
  const config = await loadConfig(args.opts);
  const dir = args.dir ? path.resolve(args.dir) : null;
  const dbFile = path.join(config.paths?.dataDir || 'data', 'state.db');
  const state = openState(dbFile);
  const files = state.listFiles().filter((f) => !dir || path.dirname(f.path) === dir);
  console.log(`${c.cyan}report${c.reset} ${dbFile}${dir ? `  dir=${dir}` : ''}`);
  const counts = {};
  const shown = files.map((f) => {
    const exists = fsSync.existsSync(f.path);
    const status = exists ? f.status : 'missing';
    counts[status] = (counts[status] || 0) + 1;
    return { ...f, status };
  });
  console.log(`${c.dim}status counts: ${JSON.stringify(counts)}${c.reset}`);
  for (const f of shown) {
    const color = f.status === 'ok' ? ok : f.status === 'no_subtitle' ? warn : bad;
    console.log(`${color(pad(f.status, 12))} ${pad(f.code || '-', 12)} ${path.basename(f.path)}`);
  }
  state.close();
}

// ---------------------------------------------------------------------------
// F22: data-dir backup / restore（实现抽到 core/backup.mjs，CLI 与 GUI API 共用）
// ---------------------------------------------------------------------------

async function cmdBackup(args) {
  const config = await loadConfig(args.opts);
  const dataDir = path.resolve(config.paths?.dataDir || 'data');
  const destRoot = args.dir ? path.resolve(args.dir) : undefined;
  const { path: target, files } = await createBackup({ dataDir, destRoot });
  console.log(`${c.cyan}backup${c.reset} ${files} file(s) -> ${target}`);
  return 0;
}

async function cmdRestore(args) {
  const config = await loadConfig(args.opts);
  if (!args.dir&&!args.flags.recover) throw new Error('usage: avc restore <backup-dir> [--force] | avc restore --recover');
  const dataDir = path.resolve(config.paths?.dataDir || 'data');
  const result = await restoreBackup({
    backupDir: args.dir,
    dataDir,
    force: !!args.flags.force,
    recover:!!args.flags.recover,
  });
  if('recovered' in result){console.log(`${c.cyan}restore recovery${c.reset} ${result.recovered?result.committed?'committed generation verified':'previous generation restored':result.reason} -> ${dataDir}`);return 0;}
  const {copied,skipped}=result;
  console.log(`${c.cyan}restore${c.reset} ${copied} file(s) -> ${dataDir}`);
  if (skipped) console.log(warn(`  ! ${skipped} 个文件已存在，未覆盖（需要覆盖请加 --force）`));
  return 0;
}

const COMMANDS = {
  doctor: cmdDoctor, scan: cmdScan, run: cmdRun, undo: cmdUndo, report: cmdReport,
  backup: cmdBackup, restore: cmdRestore,
};

/**
 * CLI entry point, importable for tests (F20).
 * @param {string[]} [argv] defaults to `process.argv.slice(2)`
 * @returns {Promise<number>} exit code (the main-guard assigns it to `process.exitCode`)
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const fn = COMMANDS[args.cmd];
  if (!fn) {
    console.error('usage: avc <doctor|scan|run|undo|report|backup|restore> ...');
    return 2;
  }
  try {
    const code = await fn(args);
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    console.error(bad(`ERROR: ${e.message}`));
    if (process.env.DEBUG) console.error(e.stack);
    return 1;
  }
}

// main-guard: only run when executed directly (`node src/cli.mjs …`), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await main();
  if (typeof code === 'number') process.exitCode = code;
}
