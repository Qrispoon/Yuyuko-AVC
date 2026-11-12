// GUI backend: zero-dependency HTTP + SSE service around the pipeline.
// Bind 127.0.0.1 only. Start: node src/server.mjs [--port 17890] [--open]
// API spec: docs/SERVICE_API.md (frozen v1)
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { scanDirectory, runDirectory, createContext, processFile, listVideos, durationSecOf, normalizeManualCode } from './pipeline.mjs';
import { annotateJournal, fingerprint, ensureJournalEntry, journalPathFor } from './core/rename.mjs';
import { createOperationPlan, loadPlan, savePlan, validatePlan, assertPlanRequest, resolveConflicts, reportHTML, digest } from './core/workflow.mjs';
import {withMutation,mutationBusy} from './core/mutations.mjs';
import {writeJsonDurable,throwIfAborted,createSnapshotWriter} from './core/durable.mjs';
import {listenerPolicy,evaluateRequest} from './core/request-policy.mjs';
import {readAuthorizedFile} from './core/authorized-reader.mjs';
import {createCandidateContexts} from './core/candidate-context.mjs';
import {undoAndProject} from './core/undo.mjs';
import {reconcileEmbeds} from './core/embed-reconcile.mjs';
import { clearCaches } from './core/maintenance.mjs';
import { runGuiSupervisor } from './core/gui-supervisor.mjs';
import { openState } from './core/state.mjs';
import { createHttp,withHttpSignal } from './net/http.mjs';
import { extractCandidates } from './core/code.mjs';
import { createSubtitleCatalog } from './subs/manual.mjs';
import { createBackup, listBackups, restoreBackup } from './core/backup.mjs';
import { decodeToUtf8, parseSrt } from './subs/verify.mjs';
import { readSettings, writeSettings } from './core/assembly-settings.mjs';
import { discover,createMuxPlan,claimMuxPlan,loadMuxPlan,executeMux,undoMux } from './core/assembly.mjs';
import { searchFrame,MAX_IMAGE_BYTES } from './sources/frame-search.mjs';
import { runTool } from './media/mux.mjs';
import { muxReportHTML } from './core/assembly-report.mjs';

/** SRT timestamp for preview payload (seconds -> HH:MM:SS,mmm). */
function fmtSrtTime(sec) {
  const total = Math.max(0, Number(sec) || 0);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// 远程封面代理缓存（1 小时）
const coverCache = new Map();
let coverHttp = null;
function getCoverHttp(config) {
  if (!coverHttp) coverHttp = createHttp(config.network);
  return coverHttp;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const PACKAGE_FILE = path.join(ROOT, 'package.json');
// F18：版本单一来源 = package.json（避免源码/文档里的版本号漂移）
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(fsSync.readFileSync(PACKAGE_FILE, 'utf8'));
    return String(pkg.version || 'unknown');
  } catch {
    return 'unknown';
  }
})();

// 配置查找顺序：--config > config.local.json（本机，已 gitignore）> config.example.json（模板）
const LOCAL_CONFIG = path.join(ROOT, 'config.local.json');
const EXAMPLE_CONFIG = path.join(ROOT, 'config.example.json');

// 运行时状态：由 startServer(opts) 设定；模块导入时不读 argv、不监听端口（F20 可导入）。
let CONFIG_FILE = LOCAL_CONFIG;
let CONFIG_WRITE = LOCAL_CONFIG;
let HOST = '127.0.0.1';

// ---------------- config ----------------
let configCache = null;
async function loadConfig() {
  if (configCache) return configCache;
  // 首次运行：没有本机配置就从模板复制一份
  if (!fsSync.existsSync(CONFIG_FILE)) {
    await fs.copyFile(EXAMPLE_CONFIG, CONFIG_FILE);
  }
  configCache = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  return configCache;
}
async function saveConfig(next) {
  configCache = next;
  await fs.writeFile(CONFIG_WRITE, JSON.stringify(next, null, 2), 'utf8');
  return configCache;
}
const dataDirOf = (config) => path.resolve(ROOT, config?.paths?.dataDir || 'data');

// ---------------- F19 logging ----------------
// 日志：<dataDir>/logs/avc-YYYY-MM-DD.log，行格式 `ISO8601 LEVEL msg`；启动时清理 14 天前日志。
// 日志失败绝不影响主流程（全部 try/catch 吞掉）。
const LOG_RETENTION_DAYS = 14;

function logsDir() {
  try {
    return path.join(dataDirOf(configCache || {}), 'logs');
  } catch {
    return path.join(ROOT, 'data', 'logs');
  }
}

function logDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function logFilePath(d = new Date()) {
  return path.join(logsDir(), `avc-${logDateStr(d)}.log`);
}

function formatLogLine(level, msg) {
  return `${new Date().toISOString()} ${level} ${String(msg).replace(/\r?\n/g, ' | ')}\n`;
}

let logChain=Promise.resolve(),logError=null;
function writeLog(level, msg) {
  const dir=logsDir(),file=logFilePath(),line=formatLogLine(level,msg);
  const write=logChain.catch(()=>{}).then(async()=>{await fs.mkdir(dir,{recursive:true});await fs.appendFile(file,line,'utf8');});
  logChain=write;write.catch(e=>{logError=e;});return write;
}

function writeLogSync(level, msg) {
  try {
    fsSync.mkdirSync(logsDir(), { recursive: true });
    fsSync.appendFileSync(logFilePath(), formatLogLine(level, msg), 'utf8');
  } catch { /* ignore */ }
}

/** 删除 logs 目录下 14 天前的 avc- 与 crash- 日志（按 mtime）。 */
async function cleanupOldLogs(days = LOG_RETENTION_DAYS) {
  const dir = logsDir();
  const names = await fs.readdir(dir).catch(() => []);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  let removed = 0;
  for (const name of names) {
    if (!/^(?:avc|crash)-.*\.log$/i.test(name)) continue;
    const full = path.join(dir, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (st.mtimeMs < cutoff) {
      await fs.rm(full, { force: true }).catch(() => {});
      removed++;
    }
  }
  return removed;
}

async function listLogFiles() {
  const dir = logsDir();
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /^avc-.*\.log$/i.test(n)).sort();
  return { dir, names };
}

/** `/api/diagnose` 与诊断包共用：日志目录 + 最新日志文件名。 */
async function latestLogInfo() {
  const { dir, names } = await listLogFiles();
  return { dir: path.resolve(dir), latest: names.length ? names[names.length - 1] : null };
}

/** 读最新一份日志的尾部 N 行（诊断包用，不写文件）。 */
async function readLogTail(maxLines = 300) {
  const { dir, names } = await listLogFiles();
  if (!names.length) return [];
  const text = await fs.readFile(path.join(dir, names[names.length - 1]), 'utf8').catch(() => '');
  return text.split(/\r?\n/).filter((line) => line.length > 0).slice(-Math.max(1, maxLines));
}

/** 崩溃日志：<dataDir>/logs/crash-<ts>.log（含栈）。uncaughtException 与 unhandledRejection 共用。 */
function writeCrashLogSync(error, kind = 'uncaughtException') {
  const dir = logsDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const body = `${new Date().toISOString()} FATAL ${kind}\n${error?.stack || String(error)}\n`;
  try {
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, `crash-${ts}.log`), body, 'utf8');
  } catch { /* ignore */ }
  writeLogSync('FATAL', `${kind}: ${error?.stack || error}`);
}

let globalHandlersInstalled = false;
function installGlobalHandlers() {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;
  process.on('uncaughtException', (error) => {
    writeCrashLogSync(error, 'uncaughtException');
    process.exit(1);
  });
  // unhandledRejection 只写 crash 日志并继续运行（F19）
  process.on('unhandledRejection', (reason) => {
    writeCrashLogSync(reason, 'unhandledRejection');
  });
}

// ---------------- F6 diagnose helpers ----------------
// 配置 schema：仅用于 /api/diagnose 提示拼错的键，不参与运行时校验（保持既有宽松语义）。
// v0.7 补：metadata.r18、subs.extraLangs（media.probeDuration 已有）。
const CONFIG_SCHEMA = {
  network: ['proxy', 'autoDiscover', 'proxyHosts', 'directHosts', 'defaultRoute', 'timeoutMs', 'retry', 'minIntervalMs'],
  rename: ['template', 'maxLength', 'stripActressFromTitle'],
  subs: ['lang', 'sources', 'localDirs', 'maxCandidatesPerSource', 'subtitlecatLimit', 'maxDurationDeltaMin', 'fit', 'writeSiblingSrt', 'extraLangs'],
  covers: ['download', 'posterWhenSingle', 'embed'],
  scan: ['videoExtensions', 'skipNormalized'],
  paths: ['dataDir'],
  fs: ['enabled', 'allowedRoots', 'maxEntries', 'showFiles'],
  media: ['probeDuration'],
  metadata: ['r18'],
};
// 配置模板里存在、但 v0.6 仍未实现（不算 unknownKeys，但要在 warnings 里提示未生效）。
const CONFIG_UNIMPLEMENTED = [
  ['network', 'autoDiscover'],
  ['rename', 'stripActressFromTitle'],
  ['subs', 'writeSiblingSrt'],
  ['scan', 'skipNormalized'],
];
const DIAG_HOSTS = [
  { name: 'javbus', url: 'https://www.javbus.com/' },
  { name: 'manko', url: 'https://manko.fun/' },
  { name: 'subtitlecat', url: 'https://www.subtitlecat.com/' },
  { name: 'cover-cdn', url: 'https://image.healertanker.com/' },
];

function configDiagnostics(config) {
  const unknownKeys = [];
  const warnings = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, unknownKeys, warnings: ['config root must be an object'] };
  }
  for (const [key, value] of Object.entries(config)) {
    const allowed = CONFIG_SCHEMA[key];
    if (!allowed) { unknownKeys.push(key); continue; }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value)) if (!allowed.includes(k)) unknownKeys.push(`${key}.${k}`);
    }
  }
  for (const [section, key] of CONFIG_UNIMPLEMENTED) {
    if (config[section] && Object.prototype.hasOwnProperty.call(config[section], key)) {
      warnings.push(`${section}.${key} 已在配置中，但当前版本未生效`);
    }
  }
  return { valid: true, unknownKeys, warnings };
}

/** ffmpeg/ffprobe 检测（/api/media/health 与 /api/diagnose 共用）。 */
async function detectMediaCapability() {
  try {
    const mod = await import('./media/ffmpeg.mjs');
    const cap = await mod.detectFfmpeg();
    if (cap) return { available: true, version: cap.version || null, ffprobe: !!cap.ffprobe };
    return { available: false, version: null, ffprobe: false };
  } catch (e) {
    return { available: false, version: null, ffprobe: false, error: e.code || e.message };
  }
}

/** dataDir 可写性探测：mkdir -p 后写/删一个临时文件（只留这一个副作用）。 */
async function probeDataDir(dataDir) {
  const dir = path.resolve(dataDir);
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, '.avc-probe');
    await fs.writeFile(probe, String(Date.now()), 'utf8');
    await fs.rm(probe, { force: true });
    return { path: dir, writable: true, error: null };
  } catch (e) {
    return { path: dir, writable: false, error: e.code || e.message };
  }
}

/** Promise.race 超时保护（不改变原 promise 状态）。 */
async function withTimeoutMs(promise, ms, code, controller) {
  let expired=false;
  const timer=setTimeout(()=>{expired=true;controller?.abort(Object.assign(new Error(code),{code}));},ms);
  try {const value=await promise;if(expired)throw Object.assign(new Error(code),{code});return value;}finally{clearTimeout(timer);}
}

// ---------------- jobs ----------------
const jobs = new Map();
const sseClients = new Map(); // jobId -> Set<res>
const queue = [];
let running = null;
let maintenance = null;
let activeRequests = 0;
let assemblyBusy = false;
let restartServer = null;
let instanceId = crypto.randomUUID();
let requestPolicy,closing=false,drainPromise=null;
const activeOperations=new Set(),requestControllers=new Set();
const candidateContexts=createCandidateContexts();
let jobWriter=createSnapshotWriter();

function broadcast(job, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients.get(job.id) || []) {
    try { res.write(payload); } catch { /* dropped */ }
  }
}

function publicJob(job) {
  return {
    needsReview: job.needsReview || null,
    id: job.id, kind: job.kind, dir: job.dir, options: job.options,
    status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    summary: job.summary || null, error: job.error || null, logCount: job.logs.length,
    progress: job.progress || null,
    reportJson: job.reportJson || null, journal: job.report?.journal || null,
  };
}

/** F9：按 runDirectory 事件维护 {done,total} 进度。 */
function updateProgress(job, ev) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.type === 'start') {
    job.progress = { done: 0, total: Number(ev.total) || 0 };
    return;
  }
  if (ev.type === 'file-done' || ev.type === 'file-error' || ev.type === 'file-skipped') {
    const p = job.progress || (job.progress = { done: 0, total: Number(ev.total) || 0 });
    p.done = (p.done || 0) + 1;
    if (p.total) p.done = Math.min(p.done, p.total);
    return;
  }
  if (ev.type === 'done') {
    const total = Number(job.progress?.total) || 0;
    job.progress = { done: total, total };
  }
}

const TERMINAL_STATUSES = new Set(['done', 'aborted', 'cancelled', 'failed', 'needs_review']);

/**
 * F9：启动时从 <dataDir>/jobs/*.json 恢复历史任务。
 * 只恢复终态任务；running/queued 的持久记录改成 aborted(interrupted_by_restart)。
 * 按 createdAt 倒序保留最近 100 条。
 */
let persistedJobsLoaded = false;
async function loadPersistedJobs() {
  if (persistedJobsLoaded) return;
  persistedJobsLoaded = true;
  const config = await loadConfig();
  const dir = path.join(dataDirOf(config), 'jobs');
  const names = await fs.readdir(dir).catch(() => []);
  const loaded = [];
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    let persisted;
    try {
      persisted = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue; // 坏文件跳过，不影响启动
    }
    if (!persisted || typeof persisted !== 'object' || typeof persisted.id !== 'string' || !persisted.id) continue;
    if (jobs.has(persisted.id)) continue;
    const job = {
      ...persisted,
      logs: Array.isArray(persisted.logs) ? persisted.logs : [],
      report: persisted.report || null,
      controller: null,
    };
    if (!TERMINAL_STATUSES.has(job.status)) {
      job.status = 'aborted';
      job.error = 'interrupted_by_restart';
      if(!job.report && job.partial?.length)job.report={dir:job.dir,apply:job.kind==='apply'||job.kind==='mux',startedAt:job.startedAt,summary:{interrupted:job.partial.length},results:job.partial,partial:true};
      job.finishedAt = job.finishedAt || Date.now();
    }
    loaded.push(job);
  }
  loaded.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  for (const job of loaded.slice(0, 100)) jobs.set(job.id, job);
}

function pushLog(job, line) {
  job.logs.push({ t: Date.now(), line });
  if (job.logs.length > 5000) job.logs.shift();
  broadcast(job, { type: 'log', line, t: Date.now() });
}

function persistJob(job,override={}) {
  const dir = path.join(job.dataDir || dataDirOf(configCache||{}), 'jobs');
  job.seq=(job.seq||0)+1;
  const payload=structuredClone({...publicJob(job),dataDir:job.dataDir,seq:job.seq,partial:job.partial,logs:job.logs.slice(-2000),report:job.report||null,...override});
  job.persistChain=jobWriter.enqueue(path.join(dir,job.id+'.json'),payload);
  return job.persistChain;
}
async function finalizeJob(job,status) {
  const finishedAt=Date.now(),report=job.report||{dir:job.dir,apply:job.kind!=='plan',results:job.partial||[],summary:job.summary||{},error:job.error||null};
  const reportJson=path.join(job.dataDir,`run-${job.kind}-${job.id}.json`);
  await writeJsonDurable(reportJson,report);
  const reportHash=digest(report);
  await persistJob(job,{status,finishedAt,reportJson,reportHash,report});
  Object.assign(job,{status,finishedAt,reportJson,reportHash,report});
  broadcast(job,{type:'job-finished',job:publicJob(job)});
  for(const res of sseClients.get(job.id)||[])res.end();sseClients.delete(job.id);
}

async function createJob(kind, dir, options) {
  const job = {
    id: crypto.randomUUID(), kind, dir: path.resolve(dir), options: options || {},
    status: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null,
    summary: null, error: null, logs: [], report: null, reportJson: null, progress: null,
    controller: new AbortController(),dataDir:dataDirOf(await loadConfig()),seq:0,
  };
  await persistJob(job);
  jobs.set(job.id, job);queue.push(job);
  return job;
}

let draining = false;
function drain() {
  if(drainPromise)return drainPromise;
  drainPromise=drainOwned().finally(()=>{drainPromise=null;});return drainPromise;
}
async function drainOwned() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length && !running) {
      const job = queue.shift();
      if (job.status === 'cancelled') continue;
      try {
      await withMutation(job.dataDir,async()=>{
      running=job;
      let terminalStatus='done';
      job.status = 'running';
      job.startedAt = Date.now();
      await persistJob(job);
      await writeLog('INFO', `job started ${job.id} kind=${job.kind} dir=${job.dir}`);
      broadcast(job, { type: 'job-started', job: publicJob(job) });
      try {
        let config = await loadConfig();
        if(job.kind==='mux') {
          const plan=await loadMuxPlan(dataDirOf(config),job.options.muxPlanId);
          const report=await executeMux(dataDirOf(config),plan,{signal:job.controller.signal,allowed:p=>isAllowedPath(config,p),jobId:job.id,
            onProgress:progress=>{job.progress=progress;broadcast(job,{type:'mux-progress',progress});},
            onResult:async(result,journal)=>{job.partial=job.partial||[];job.partial.push(result);pushLog(job,`mux ${result.status}: ${result.file}${result.error?' · '+result.error:''}`);job.report={kind:'mux',dir:job.dir,apply:true,results:job.partial,journal,summary:{},partial:true};await persistJob(job);}});
          job.report=report;job.summary=report.summary;terminalStatus=report.cancelled?'cancelled':'done';
          return;
        }
        let operationPlan=null;
        const store=openState(path.join(dataDirOf(config),'state.db'));
        try {
          if(job.options.planId) {
            operationPlan=await loadPlan(config,job.options.planId);
            assertPlanRequest(operationPlan,job.dir,job.options);
            if(path.resolve(job.dir)!==path.resolve(operationPlan.dir))throw Object.assign(new Error('plan_directory_changed'),{code:'NEEDS_REVIEW'});
            if(operationPlan.state!=='preview' || operationPlan.revision!==job.options.planRevision)throw Object.assign(new Error('plan_changed'),{code:'NEEDS_REVIEW'});
            await validatePlan(operationPlan,store);config=operationPlan.config;
            operationPlan.state='executing';await savePlan(config,operationPlan);
          } else if(job.kind==='apply' && job.options.requirePlan) throw Object.assign(new Error('plan_required'),{code:'NEEDS_REVIEW'});
        } finally {store.close();}
        const executionOptions=operationPlan?.options || job.options;
        const report = await runDirectory({
          dir: job.dir,
          config,
          apply: job.kind === 'apply',
          limit: Number(executionOptions.limit || 0),
          force: !!executionOptions.force,
          downloadSubs: executionOptions.downloadSubs !== false,
          concurrency: Number(executionOptions.concurrency || 1),
          fileTimeoutMs: Number(executionOptions.fileTimeoutMs || 180000),
          maxConsecutiveFailures: Number(executionOptions.maxConsecutiveFailures || 5),
          overrides: executionOptions.overrides && typeof executionOptions.overrides === 'object' ? executionOptions.overrides : null,
          only: Array.isArray(executionOptions.only) ? executionOptions.only.map(String) : null,
          workflow:executionOptions.workflow || {}, operationPlan,
          signal: job.controller.signal,
          logger: (line) => pushLog(job, line),
          onEvent: (ev) => { updateProgress(job, ev); if(ev.result?._subtitle) {ev={...ev,result:{...ev.result,_subtitle:undefined}};} broadcast(job, ev); if(ev.type==='file-done' || ev.type==='file-error'){job.partial=job.partial||[];job.partial.push(ev.result||{file:ev.file,status:'error',error:ev.error});persistJob(job).catch(e=>{job.persistenceError=e;});} },
        });
        if(job.kind==='plan') {
          const store=openState(path.join(dataDirOf(config),'state.db'));
          try {await createOperationPlan(report,config,store,job.options);} finally {store.close();}
        }
        if(operationPlan) {operationPlan.state='consumed';await savePlan(config,operationPlan);report.planId=operationPlan.id;}
        for(const r of report.results)delete r._subtitle;
        job.report = report;
        job.summary = report.summary;
        terminalStatus = report.cancelled ? 'cancelled' : report.aborted ? 'aborted' : 'done';
      } catch (e) {
        terminalStatus = e.code==='NEEDS_REVIEW'?'needs_review':job.controller.signal.aborted?'cancelled':'failed';
        if(!job.report && job.partial?.length)job.report={dir:job.dir,apply:job.kind==='apply'||job.kind==='mux',startedAt:job.startedAt,summary:job.partial.reduce((a,r)=>{a[r.status]=(a[r.status]||0)+1;return a;},{}),results:job.partial,partial:true};
        job.needsReview=e.reasons||null;
        job.error = e.stack || e.message;
        pushLog(job, `FATAL: ${e.message}`);
      } finally {
        try {
          await writeLog('INFO',`job finishing ${job.id} status=${terminalStatus}`);
          await finalizeJob(job,terminalStatus);
          running=null;
        }catch(e){job.finalizationError=e;job.progress={...job.progress,finalizing:true,error:e.code||e.message};throw e;}
      }
      });
      }catch(e) {
        if(e.code==='MUTATION_LOCKED'&&!job.startedAt) {
          queue.unshift(job);
          if(!closing)setTimeout(()=>{if(!closing)void drain().catch(error=>{job.finalizationError=error;});},1000).unref();
          break;
        }
        throw e;
      }
    }
  } finally {
    draining = false;
  }
}

// ---------------- helpers ----------------
const json = (res, status, body) => {
  if(res.deferJson){res.pendingJson={status,body};return;}
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
};
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8' };

// ---------------- read-only filesystem API (authorized via config.fs) ----------------
const SYS_SKIP = new Set(['$recycle.bin', 'system volume information', 'recovery', 'perflogs', 'config.msi']);

function listDrives() {
  const out = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try { if (fsSync.existsSync(root)) out.push(root); } catch { /* skip */ }
  }
  return out;
}

function fsConfig(config) {
  const fs = config.fs || {};
  const allowedRoots = (Array.isArray(fs.allowedRoots) && fs.allowedRoots.length ? fs.allowedRoots : listDrives())
    .map((r) => path.resolve(r).replace(/[\\/]+$/, '') + path.sep);
  return { enabled: fs.enabled !== false, allowedRoots, maxEntries: Number(fs.maxEntries || 5000), showFiles: fs.showFiles !== false };
}

function isAllowedPath(config, target) {
  const { enabled, allowedRoots } = fsConfig(config);
  if (!enabled) return false;
  const abs = path.resolve(target).toLowerCase();
  return allowedRoots.some((root) => abs === root.toLowerCase().replace(/[\\/]+$/,'') || abs.startsWith(root.toLowerCase()));
}

async function listDirectory(config, target) {
  const { maxEntries, showFiles } = fsConfig(config);
  const abs = path.resolve(target);
  if (!isAllowedPath(config, abs)) {
    return { error: 'fs_forbidden', dir: abs, hint: '把目录加入 config.json → fs.allowedRoots 后重试' };
  }
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) return { error: 'dir_not_found', dir: abs };

  const dirents = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  const entries = [];
  for (const d of dirents) {
    if (entries.length >= maxEntries) break;
    if (d.name.startsWith('.') || SYS_SKIP.has(d.name.toLowerCase())) continue;
    const full = path.join(abs, d.name);
    const meta = await fs.stat(full).catch(() => null);
    if (!meta) continue;
    const isDir = meta.isDirectory();
    if (!isDir && !showFiles) continue;
    entries.push({
      name: d.name, path: full, isDir,
      size: isDir ? null : meta.size,
      mtimeMs: Math.round(meta.mtimeMs),
      ext: isDir ? null : path.extname(d.name).toLowerCase(),
    });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : a.isDir ? -1 : 1));
  const parent = path.dirname(abs);
  return {
    dir: abs,
    parent: parent !== abs && isAllowedPath(config, parent) ? parent : null,
    entries,
    truncated: entries.length >= maxEntries,
  };
}

const POWERSHELL = 'powershell.exe';

function runPs(script, timeoutMs) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(POWERSHELL, ['-NoProfile', '-STA', '-Command', script],
        { timeout: timeoutMs, windowsHide: false, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          if (err) return resolve({ error: err.killed ? 'timeout' : 'failed', message: String(stderr || err.message).slice(0, 400) });
          resolve({ ok: true, out: String(stdout || '').trim() });
        });
    }).catch((e) => resolve({ error: 'failed', message: e.message }));
  });
}

let interactiveCache = null;
async function checkInteractive() {
  if (interactiveCache !== null) return interactiveCache;
  const r = await runPs('[Environment]::UserInteractive', 8000);
  interactiveCache = r.ok ? /^true$/i.test(r.out) : false;
  return interactiveCache;
}

function normalizePick(out) {
  const picked = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
  return picked ? { path: picked } : { cancelled: true };
}

/**
 * 弹原生目录选择框。优先 FolderBrowserDialog，失败再试 Shell.Application。
 * 没有交互桌面（服务由后台/无窗口方式启动）时立刻返回 no_interactive_desktop，
 * 让前端切换到内置目录浏览器，而不是干等 2 分钟。
 */
async function pickFolderNative() {
  if (!(await checkInteractive())) {
    return {
      error: 'no_interactive_desktop',
      message: '当前后端进程没有交互桌面，无法弹出系统对话框。请用项目根目录的 start-gui.cmd 启动，或使用「浏览…」。',
    };
  }
  const dirA = await runPs([
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    // 用一个置顶的隐藏 owner 窗口，避免对话框弹到浏览器后面
    '$o = New-Object System.Windows.Forms.Form',
    '$o.TopMost = $true',
    '$o.ShowInTaskbar = $false',
    '$o.Opacity = 0',
    '$o.StartPosition = "Manual"',
    '$o.Location = New-Object System.Drawing.Point(-4000, -4000)',
    '$o.Size = New-Object System.Drawing.Size(1, 1)',
    '$o.Show()',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = '选择视频目录'",
    '$f.ShowNewFolderButton = $true',
    '$r = $f.ShowDialog($o)',
    '$o.Close()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }',
  ].join('; '), 45000);
  if (dirA.error === 'timeout') return { error: 'native_dialog_timeout' };
  if (dirA.ok) return normalizePick(dirA.out);

  const dirB = await runPs([
    '$shell = New-Object -ComObject Shell.Application',
    "$f = $shell.BrowseForFolder(0, '选择视频目录', 0, 0)",
    'if ($f) { [Console]::Out.Write($f.Self.Path) }',
  ].join('; '), 45000);
  if (dirB.error === 'timeout') return { error: 'native_dialog_timeout' };
  if (dirB.ok) return normalizePick(dirB.out);

  return { error: 'native_dialog_failed', message: `${dirA.message || ''} | ${dirB.message || ''}`.slice(0, 500) };
}


async function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(WEB_DIR, decodeURIComponent(rel));
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    json(res, 404, { error: 'not_found', path: rel, hint: 'web/ 目录尚未构建 GUI（见 docs/ARCHITECTURE.md）' });
  }
}

// ---------------- F6/F19 diagnose ----------------
/** 自检数据（`/api/diagnose` 与 `/api/diagnostics/export` 共用；不写盘，只做 dataDir 临时探测）。 */
async function buildDiagnose() {
  let config = null;
  let configError = null;
  try {
    config = await loadConfig();
  } catch (e) {
    configError = e.code || e.message;
  }
  const diag = configDiagnostics(config || {});
  const env = {
    ok: true,
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    network: { proxy: config?.network?.proxy || null, defaultRoute: config?.network?.defaultRoute || 'direct', hosts: [] },
    ffmpeg: { available: false, version: null, ffprobe: false },
    dataDir: { path: path.resolve(dataDirOf(config)), writable: false, error: 'not_checked' },
    config: { path: CONFIG_FILE, valid: !configError && diag.valid, ...(configError ? { error: configError } : {}), unknownKeys: diag.unknownKeys, warnings: diag.warnings },
    state: { db: path.resolve(path.join(dataDirOf(config), 'state.db')), files: null, byStatus: {} },
    logs: { dir: path.resolve(path.join(dataDirOf(config), 'logs')), latest: null },
  };

  // network：4 个关键域名并行探测，失败只体现在对应项，接口本身始终 200
  try {
    const http = createHttp(config?.network || {});
    const timeoutMs = Math.min(Number(config?.network?.timeoutMs) || 8000, 8000);
    env.network.hosts = await Promise.all(DIAG_HOSTS.map(async (h) => {
      try {
        const r = await http.probe(h.url, timeoutMs);
        return { name: h.name, url: h.url, ok: !!r.ok, status: Number(r.status) || 0, ms: Number(r.ms) || 0, route: r.route || http.routeFor(h.url), error: r.error || null };
      } catch (e) {
        return { name: h.name, url: h.url, ok: false, status: 0, ms: 0, route: http.routeFor(h.url), error: e.code || e.message };
      }
    }));
  } catch (e) {
    env.network.hosts = DIAG_HOSTS.map((h) => ({ name: h.name, url: h.url, ok: false, status: 0, ms: 0, route: 'direct', error: e.code || e.message }));
  }

  // ffmpeg / ffprobe
  env.ffmpeg = await detectMediaCapability();

  // dataDir 可写性
  env.dataDir = await probeDataDir(dataDirOf(config));

  // state.db 统计：库不存在时不去创建它（诊断接口尽量零副作用）
  const dbFile = path.join(dataDirOf(config), 'state.db');
  try {
    if (fsSync.existsSync(dbFile)) {
      const state = openState(dbFile);
      try {
        env.state.files = state.listFiles().length;
        env.state.byStatus = state.summary();
      } finally { state.close(); }
    } else {
      env.state.files = 0;
      env.state.byStatus = {};
    }
  } catch (e) {
    env.state = { db: path.resolve(dbFile), files: null, byStatus: {}, error: e.code || e.message };
  }

  // F19：日志目录与最新日志文件
  env.logs = await latestLogInfo();
  return env;
}

// ---------------- F19 诊断包（脱敏） ----------------
const WIN_PATH_RE = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g;

/** 递归把字符串里的 Windows 绝对路径替换为 `<path>`（默认脱敏行为）。 */
function redactDeep(value) {
  if (typeof value === 'string') return value.replace(WIN_PATH_RE, '<path>');
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/** 构造诊断包内容（不写文件、不含原始日志文件）。 */
async function buildDiagnosticsExport({ jobId = null } = {}) {
  const diagnostics = await buildDiagnose();
  let config = null;
  try { config = await loadConfig(); } catch { config = null; }
  // config 去掉 paths（含本机数据目录等敏感位置）
  let exportConfig = {};
  if (config && typeof config === 'object') {
    const { paths, ...rest } = config;
    exportConfig = rest;
  }
  const logs = await readLogTail(300);
  const payload = {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    diagnostics,
    config: exportConfig,
    logs,
  };
  if (jobId) {
    const job = jobs.get(jobId);
    payload.job = job
      ? { ...publicJob(job), reportSummary: job.report?.summary || null }
      : null;
  }
  return payload;
}

// ---------------- F：详情页手动字幕 / 手动封面 ----------------
async function resolveManualFile(config, raw) {
  const abs = path.resolve(String(raw || ''));
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return { error: 'file_not_found', path: abs };
  const exts = new Set((config.scan?.videoExtensions || ['.mp4', '.mkv', '.avi', '.mov', '.wmv']).map((e) => String(e).toLowerCase()));
  if (!exts.has(path.extname(abs).toLowerCase())) return { error: 'not_video', path: abs };
  return { path: abs, size: st.size };
}

/** Newest journal (latest 50) that contains this file as its old or new path. */
async function findJournalEntryFor(config, filePath) {
  const dir = dataDirOf(config);
  const abs = path.resolve(filePath);
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /^journal-.*\.json$/.test(n)).sort().reverse().slice(0, 50);
  for (const name of names) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      const item = (Array.isArray(data.items) ? data.items : []).find((i) => i && (path.resolve(String(i.to || '')) === abs || path.resolve(String(i.from || '')) === abs));
      if (item) return { file: path.join(dir, name), toPath: item.to };
    } catch { /* skip broken journal */ }
  }
  return null;
}

// ---------------- routes ----------------
async function subtitleContext(state,file,code,config) {
  const record=state.record(file);
  return {file,code,recordId:record.id,revision:record.revision,sourceId:record.source_id,fingerprint:await fingerprint(file),fit:config.subs?.fit||{}};
}
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;
  const method = req.method.toUpperCase();
  if(p.startsWith('/api/assembly/')) {
    const config=await loadConfig(),dataDir=dataDirOf(config),allowed=target=>isAllowedPath(config,target);
    if(p==='/api/assembly/settings'&&method==='GET')return json(res,200,await readSettings(dataDir));
    if(p==='/api/assembly/settings'&&method==='POST'){
      if(assemblyBusy||running||queue.length)return json(res,409,{error:'task_running'});
      return json(res,200,await writeSettings(dataDir,await readBody(req)));
    }
    if(p==='/api/assembly/capabilities'&&method==='GET'){
      const s=await readSettings(dataDir);const result={};for(const key of ['ffmpeg','ffprobe']){try{const out=await runTool(s[key],['-version'],{timeoutMs:4000});result[key]={available:true,version:out.split(/\r?\n/)[0]};}catch{result[key]={available:false};}}return json(res,200,result);
    }
    if(!['/api/assembly/files','/api/assembly/plan','/api/assembly/start','/api/assembly/search'].includes(p)||method!=='POST')return json(res,404,{error:'not_found'});
    if(assemblyBusy||running||queue.length||activeRequests>1)return json(res,409,{error:'task_running'});
    assemblyBusy=true;
    const controller=new AbortController();const disconnect=()=>{if(!res.writableFinished)controller.abort();};res.once('close',disconnect);
    try {
      if(p.endsWith('/search')){
        if(!/^image\/(png|jpeg|webp)(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'INVALID_IMAGE'});
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_IMAGE_BYTES)return json(res,413,{error:'INVALID_IMAGE_SIZE'});chunks.push(chunk);}
        const result=await searchFrame(Buffer.concat(chunks),await readSettings(dataDir,{privateValues:true}),{signal:controller.signal});return json(res,200,result);
      }
      const body=await readBody(req);
      if(p.endsWith('/files'))return json(res,200,await discover(body.dir,allowed));
      if(p.endsWith('/plan'))return json(res,200,await createMuxPlan(dataDir,body,await readSettings(dataDir),allowed,controller.signal));
      const plan=await claimMuxPlan(dataDir,body.planId,{keepExisting:!!body.keepExisting},allowed);
      const job=await createJob('mux',path.dirname(plan.items.find(i=>i.status==='ready').file),{muxPlanId:plan.id});return json(res,202,{jobId:job.id,job:publicJob(job)});
    } catch(e){if(!res.destroyed)return json(res,e.status||502,{error:e.code||'ASSEMBLY_FAILED'});}
    finally{assemblyBusy=false;res.removeListener('close',disconnect);}
    return;
  }
  if (p.startsWith('/api/maintenance/') && method === 'POST') {
    if (!['/api/maintenance/cache', '/api/maintenance/restart'].includes(p)) return json(res, 404, { error: 'not_found' });
    // Browser maintenance requests must be same-origin JSON; command-line API
    // clients without Origin are supported, with no arbitrary path/PID input.
    await readBody(req);
    if (running || queue.some(j => j.status === 'queued') || activeRequests) return json(res, 409, { error: 'task_running' });
    if (maintenance) return json(res, 409, { error: 'maintenance_in_progress' });
    if (p.endsWith('/restart')) {
      if (!restartServer) return json(res, 503, { error: 'restart_unavailable' });
      maintenance = 'restart';
      const restart = restartServer;
      res.once('finish', () => { setTimeout(() => restart().catch(async e => {
        maintenance = null;
        await writeLog('ERROR', `restart failed: ${e.message}`);
      }), 100).unref(); });
      return json(res, 202, { accepted: true, instanceId });
    }
    maintenance = 'cache';
    try {
      const result = await clearCaches(dataDirOf(await loadConfig()), coverCache);
      coverHttp = null;
      await writeLog('INFO', `cache cleared entries=${result.entries} bytes=${result.bytes}`);
      return json(res, 200, result);
    } finally { maintenance = null; }
  }
  if(p==='/api/corrections' && ['GET','POST'].includes(method)) {
    const body=method==='POST'?await readBody(req):{file:url.searchParams.get('file')};
    const config=await loadConfig(),target=await resolveManualFile(config,body.file);
    if(target.error)return json(res,400,{error:target.error});
    if(method==='POST' && running)return json(res,409,{error:'task_running'});
    const store=openState(path.join(dataDirOf(config),'state.db'));
    try {
      let record=store.record(target.path), row=store.getFile(target.path), source=row?.data?.sourceMeta || row?.data?.meta || {};
      if(method==='POST') {
        let fields=body.fields;
        if(body.revertId!=null) fields=store.correctionHistory(target.path).find(h=>h.id===body.revertId)?.fields;
        if(!fields || typeof fields!=='object')return json(res,400,{error:'fields_required'});
        const nextCode=fields.code?.locked?normalizeManualCode(fields.code.value):null;
        if(fields.code?.locked && !nextCode)return json(res,400,{error:'invalid_code'});
        const removingCode=!!record.fields.code && !fields.code?.locked;
        const changed=removingCode || (nextCode && nextCode!==(record.fields.code?.value || row?.code));
        if(changed && !['keep','clear'].includes(body.codeLocks))return json(res,409,{error:'code_lock_decision_required'});
        if(changed && body.codeLocks==='clear') fields=fields.code?{code:fields.code}:{};
        record=store.correct(target.path,fields,body.revision);
        if(changed) {store.resetFile(target.path);store.upsertFile(target.path,{code:nextCode,data:nextCode?{manualCode:nextCode}:{}});source={};}
        else if(row?.data) {
          const meta={...source};for(const [k,v] of Object.entries(record.fields))if(k!=='code')meta[k]=v.value;
          store.upsertFile(target.path,{data:{...row.data,meta,sourceMeta:source}});
        }
      }
      return json(res,200,{record,source,history:store.correctionHistory(target.path)});
    } catch(e) {return json(res,e.status||400,{error:e.message});}finally{store.close();}
  }
  const planMatch=p.match(/^\/api\/plans\/([a-f0-9-]{36})$/i);
  if(planMatch && ['GET','POST'].includes(method)) {
    const config=await loadConfig();let plan;
    try{plan=await loadPlan(config,planMatch[1]);}catch{return json(res,404,{error:'plan_not_found'});}
    if(method==='POST') {
      if(plan.state!=='preview')return json(res,409,{error:'plan_consumed'});
      const body=await readBody(req);
      if(body.revision!==plan.revision)return json(res,409,{error:'plan_changed'});
      try {
        if(body.decisions)await resolveConflicts(plan,body.decisions);
        if(body.candidateToken) {
          if(!/^[a-f0-9]{64}$/.test(body.candidateToken))throw new Error('invalid_token');
          const candidate=JSON.parse(await fs.readFile(path.join(dataDirOf(config),'subtitle-previews',body.candidateToken+'.json'),'utf8'));
          if(Date.now()-candidate.at>3600000 || candidate.file!==body.file)throw new Error('candidate_expired');
          const candidateState=openState(path.join(dataDirOf(config),'state.db'));
          try {if(!candidate.context||digest(candidate.context)!==digest(await subtitleContext(candidateState,candidate.file,candidate.context.code,config)))throw new Error('candidate_context_changed');}finally{candidateState.close();}
          if(!candidate.analysis.check?.ok)throw new Error('candidate_rejected');
          const entry=plan.entries.find(e=>e.file===body.file);if(!entry)throw new Error('file_not_in_plan');
          if(candidate.candidate.lang && !/^zh(?:-CN)?$/i.test(candidate.candidate.lang))throw new Error('primary_requires_zh');
          entry.result._selectedSubtitle=true;
          entry.result._subtitle={base64:candidate.analysis.base64,source:candidate.candidate.source,candidate:candidate.candidate,bytes:Buffer.from(candidate.analysis.base64,'base64').length,check:candidate.analysis.check,fit:candidate.analysis.fit};
          entry.result.sub={source:candidate.candidate.source,lang:'zh',cues:candidate.analysis.cues,bytes:candidate.analysis.bytes,targetPath:(entry.result.rename?.to || entry.file).replace(/\.[^.]+$/,'.srt')};
          entry.targets[entry.result.sub.targetPath]=await fingerprint(entry.result.sub.targetPath).catch(()=>null);
          plan.revision++;
        }
        await savePlan(config,plan);
        if(body.decisions) {
          const store=openState(path.join(dataDirOf(config),'state.db'));
          try {for(const e of plan.entries){const row=store.getFile(e.file);if(row?.data?.planId===plan.id)store.upsertFile(e.file,{newName:e.result.newName,data:{...row.data,rename:e.result.rename}});}}finally{store.close();}
        }
      }catch(e){return json(res,409,{error:e.message});}
    }
    const publicPlan=structuredClone(plan);delete publicPlan.config;
    for(const e of publicPlan.entries)delete e.result._subtitle;
    return json(res,200,publicPlan);
  }
  if(p==='/api/subtitles/analyze' && method==='POST') {
    const body=await readBody(req),config=await loadConfig(),target=await resolveManualFile(config,body.file);
    if(target.error)return json(res,400,{error:target.error});
    const store=openState(path.join(dataDirOf(config),'state.db'));
    try {
      const catalog=createSubtitleCatalog({config,http:createHttp(config.network)});
      const issuedContext=candidateContexts.context(body.candidate),context=await subtitleContext(store,target.path,body.code||issuedContext.code,config);
      const candidate=candidateContexts.resolve(body.candidate,context);
      const analysis=await withTimeoutMs(catalog.analyze({candidate,durationSec:durationSecOf(store.getFile(target.path)?.data?.meta),fit:body.fit||config.subs?.fit||{},startSec:Math.max(0,Number(body.startSec)||0)}),60000,'analysis_timeout',req.operationController);
      const token=digest([target.path,body.candidate,analysis.base64]),dir=path.join(dataDirOf(config),'subtitle-previews');await fs.mkdir(dir,{recursive:true});
      for(const name of await fs.readdir(dir))if(/^[a-f0-9]{64}\.json$/.test(name)) {const p=path.join(dir,name),st=await fs.stat(p).catch(()=>null);if(st && Date.now()-st.mtimeMs>3600000)await fs.unlink(p).catch(()=>{});}
      throwIfAborted(req.operationController.signal);
      await writeJsonDurable(path.join(dir,token+'.json'),{file:target.path,candidate,context,analysis,at:Date.now()});
      return json(res,200,{...analysis,base64:undefined,token});
    }catch(e){return json(res,400,{error:e.code||e.message});}finally{store.close();}
  }

  if (p === '/api/health' && method === 'GET') {
    const config = await loadConfig();
    return json(res, 200, {
      ok: true, instanceId, pid: process.pid, restartSupported: !!restartServer, maintenance, version: VERSION, node: process.version, platform: process.platform,
      proxy: config.network?.proxy || null, dir: ROOT,
      running: running ? running.id : null, queued: queue.length,
    });
  }

  // F6/F19：运行自检（网络探测/ffmpeg/dataDir/配置/状态库/日志位置）。除了 dataDir 探测的临时文件外不写盘。
  if (p === '/api/diagnose' && method === 'GET') {
    return json(res, 200, await buildDiagnose());
  }

  // F19：诊断包导出（JSON 附件；默认脱敏 Windows 绝对路径；不写任何新文件）
  if (p === '/api/diagnostics/export' && method === 'GET') {
    const jobId = url.searchParams.get('job') || null;
    const redact = url.searchParams.get('redact') !== '0';
    let payload;
    try {
      payload = await buildDiagnosticsExport({ jobId });
    } catch (e) {
      await writeLog('ERROR', `diagnostics export failed: ${e.code || e.message}`);
      return json(res, 500, { error: 'diagnostics_failed', message: e.code || e.message || 'diagnostics_failed' });
    }
    const body = redact ? redactDeep(payload) : payload;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const data = JSON.stringify(body, null, 2);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="avc-diagnostics-${ts}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  }

  // F16：无番号反查（关键词 → manko 候选；network 失败 502 lookup_failed）
  if (p === '/api/lookup' && method === 'POST') {
    const body = await readBody(req);
    const keyword = String(body?.keyword ?? '').trim();
    if (!keyword) return json(res, 400, { error: 'keyword_required', message: '缺少 keyword' });
    if (keyword.length > 200) return json(res, 400, { error: 'keyword_too_long', message: '关键词不能超过 200 字符' });
    let config;
    try {
      config = await loadConfig();
    } catch (e) {
      await writeLog('WARN', `lookup failed keyword=${keyword}: invalid_config`);
      return json(res, 502, { error: 'lookup_failed', message: 'invalid_config' });
    }
    try {
      const mod = await import('./sources/lookup.mjs');
      const http = createHttp(config.network);
      const lookup = mod.createLookup({ http, config });
      const limit = Math.max(1, Math.min(50, Number(body?.limit) || 10));
      const candidates = await withTimeoutMs(lookup.byKeyword(keyword, { limit }), 30_000, 'lookup_timeout');
      const list = Array.isArray(candidates) ? candidates : [];
      await writeLog('INFO', `lookup ok keyword=${keyword} candidates=${list.length}`);
      return json(res, 200, { keyword, candidates: list });
    } catch (e) {
      await writeLog('WARN', `lookup failed keyword=${keyword}: ${e.code || e.message}`);
      return json(res, 502, { error: 'lookup_failed', message: e.code || e.message || 'lookup_failed' });
    }
  }

  // ---------------- v0.7.2：备份/恢复、字幕预览、模板预览 ----------------
  if (p === '/api/backup' && method === 'POST') {
    if (running) return json(res, 409, { error: 'task_running', message: '任务运行中，完成后再备份' });
    const body = await readBody(req).catch(() => ({}));
    let config;
    try { config = await loadConfig(); } catch { return json(res, 400, { error: 'invalid_config' }); }
    const dest = body && body.dest ? path.resolve(String(body.dest)) : null;
    if (dest && !isAllowedPath(config, dest)) return json(res, 400, { error: 'fs_forbidden', path: dest });
    try {
      const result = await createBackup({ dataDir: dataDirOf(config), destRoot: dest || undefined });
      await writeLog('INFO', `backup created files=${result.files}`);
      return json(res, 200, result);
    } catch (e) {
      await writeLog('ERROR', `backup failed: ${e.code || e.message}`);
      return json(res, 500, { error: 'backup_failed', message: e.code || e.message });
    }
  }

  if (p === '/api/backups' && method === 'GET') {
    try {
      const config = await loadConfig();
      return json(res, 200, { backups: await listBackups(dataDirOf(config)) });
    } catch (e) {
      return json(res, 500, { error: 'backup_list_failed', message: e.code || e.message });
    }
  }

  if (p === '/api/restore' && method === 'POST') {
    if (running) return json(res, 409, { error: 'task_running', message: '任务运行中，完成后再恢复' });
    const body = await readBody(req).catch(() => ({}));
    if (!body || (!body.dir&&body.recover!==true)) return json(res, 400, { error: 'dir_required' });
    const config = await loadConfig();
    try {
      const result = await restoreBackup({ backupDir: body.dir?path.resolve(String(body.dir)):undefined, dataDir: dataDirOf(config), force: body.force === true,recover:body.recover===true });
      await writeLog('INFO', `restore ${JSON.stringify(result)}`);
      return json(res, 200, result);
    } catch (e) {
      const code = e.code === 'INVALID_BACKUP' ? 'invalid_backup' : e.code === 'BACKUP_DIR_NOT_FOUND' ? 'dir_not_found' : 'restore_failed';
      await writeLog('WARN', `restore failed: ${e.code || e.message}`);
      return json(res, code === 'restore_failed' ? 500 : 400, { error: code, message: e.message });
    }
  }

  if (p === '/api/subtitle/preview' && method === 'GET') {
    const raw = url.searchParams.get('path');
    if (!raw) return json(res, 400, { error: 'path_required' });
    const config = await loadConfig();
    const abs = path.resolve(raw);
    if (!isAllowedPath(config, abs)) return json(res, 400, { error: 'fs_forbidden', path: abs });
    if (path.extname(abs).toLowerCase() !== '.srt') return json(res, 400, { error: 'not_srt' });
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return json(res, 404, { error: 'not_found', path: abs });
    if (st.size > 8 * 1024 * 1024) return json(res, 413, { error: 'file_too_large' });
    try {
      const buffer = await fs.readFile(abs);
      const { text, encoding } = decodeToUtf8(buffer);
      const parsed = parseSrt(text);
      const lines = Math.max(1, Math.min(200, Number(url.searchParams.get('lines')) || 30));
      const cues = parsed.cues.slice(0, lines).map((c) => ({
        index: c.index,
        start: fmtSrtTime(c.start),
        end: fmtSrtTime(c.end),
        text: c.text,
      }));
      return json(res, 200, {
        path: abs, bytes: buffer.length, encoding, count: parsed.count,
        lastEndSec: parsed.lastEndSec, truncated: cues.length < parsed.count, cues,
      });
    } catch (e) {
      return json(res, 500, { error: 'subtitle_preview_failed', message: e.code || e.message });
    }
  }

  if (p === '/api/config') {
    if (method === 'GET') return json(res, 200, await loadConfig());
    if (method === 'PUT') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid_config' });
      const merged = { ...(await loadConfig()), ...body };
      await saveConfig(merged);
      return json(res, 200, merged);
    }
  }

  if (p === '/api/scan' && method === 'POST') {
    const { dir } = await readBody(req);
    if (!dir) return json(res, 400, { error: 'dir_required' });
    const abs = path.resolve(dir);
    const ok = await fs.stat(abs).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) return json(res, 400, { error: 'dir_not_found', dir: abs });
    const config = await loadConfig();
    const started = Date.now();
    const items = await scanDirectory(abs, config);
    // 合并状态库：让界面能直接显示已完成状态、元数据、封面与字幕信息
    const state = openState(path.join(dataDirOf(config), 'state.db'));
    let enriched;
    try {
      enriched = items.map((it) => {
        state.record(it.path);
        const row = state.getFile(it.path);
        const d = row?.data || {};
        return {
          ...it,
          status: row?.status || it.status || null,
          code: row?.code || it.code,
          newName: row?.new_name || null,
          meta: d.meta || null,
          sub: d.sub || null,
          cover: d.cover || null,
          coverPath: d.cover?.path || null,
          manualCode: d.manualCode || null,
          applied: d.applied === true,
          stage: d.stage || null,
          rename: d.rename || null,
          coverPlanned: d.coverPlanned || null,
          duplicates: Array.isArray(it.duplicates) ? it.duplicates : [],
        };
      });
    } finally { state.close(); }
    return json(res, 200, { dir: abs, count: enriched.length, ms: Date.now() - started, items: enriched });
  }

  // F8：单文件预演（不写盘、不建任务、不落状态库）
  if (p === '/api/preview' && method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !body.file) {
      return json(res, 400, { error: 'file_required', message: '缺少 file 参数' });
    }
    const abs = path.resolve(String(body.file));
    let config;
    try {
      config = await loadConfig();
    } catch (e) {
      return json(res, 500, { error: 'preview_failed', message: 'invalid_config' });
    }
    const exts = new Set((config.scan?.videoExtensions || ['.mp4', '.mkv', '.avi', '.mov', '.wmv']).map((e) => String(e).toLowerCase()));
    if (!exts.has(path.extname(abs).toLowerCase())) {
      return json(res, 400, { error: 'not_video', message: '不是受支持的视频文件' });
    }
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return json(res, 400, { error: 'file_not_found', message: '文件不存在' });

    let state = null;
    try {
      state = openState(path.join(dataDirOf(config), 'state.db'));
      const ctx = createContext(config, { state, logger: () => {} });
      const file = { path: abs, name: path.basename(abs), size: st.size };
      const result = await withTimeoutMs(processFile(ctx, file, {
        apply: false,
        downloadSubs: body.downloadSubs !== false,
        overrideCode: body.code ? String(body.code) : null,
        persist: false,
        signal:req.operationController.signal,
      }), 120_000, 'preview_timeout',req.operationController);
      const extracted = extractCandidates(file.name);
      return json(res, 200, {
        file: abs,
        name: file.name,
        status: result.status,
        code: result.code || null,
        candidates: (extracted.candidates || []).map((c) => ({ code: c.code, score: c.score, scope: c.scope || 'censored', rule: c.rule, known: !!c.known })),
        meta: result.meta || null,
        newName: result.newName || null,
        rename: result.rename || null,
        sub: result.sub || null,
        coverPlanned: result.coverPlanned || null,
      });
    } catch (e) {
      await writeLog('WARN', `preview failed file=${abs}: ${e.code === 'preview_timeout' ? 'preview_timeout' : (e.code || e.message)}`);
      return json(res, 500, { error: 'preview_failed', message: e.code === 'preview_timeout' ? 'preview_timeout' : (e.message || 'preview_failed') });
    } finally {
      try { state?.close(); } catch { /* ignore */ }
    }
  }

  // ---------------- F：详情页手动选字幕 / 手动下载封面（v0.7.1） ----------------
  if ((p === '/api/subtitles/candidates' || p === '/api/subtitles/apply' || p === '/api/cover/fetch') && method === 'POST') {
    if (running) return json(res, 409, { error: 'task_running', message: '任务运行中，完成后再操作' });
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== 'object' || !body.file) return json(res, 400, { error: 'file_required', message: '缺少 file 参数' });
    const config = await loadConfig();
    const target = await resolveManualFile(config, body.file);
    if (target.error) return json(res, 400, { error: target.error, message: target.error === 'not_video' ? '不是受支持的视频文件' : '文件不存在' });

    if (p === '/api/subtitles/candidates') {
      let state = null;
      try {
        state = openState(path.join(dataDirOf(config), 'state.db'));
        let code = body.code ? normalizeManualCode(body.code) : null;
        if (!code) {
          const row = state.getFile(target.path);
          code = row?.code || extractCandidates(path.basename(target.path)).candidates[0]?.code || null;
        }
        if (!code) return json(res, 400, { error: 'code_required', message: '需要先补番号' });
        const catalog = createSubtitleCatalog({ config, http: createHttp(config.network) });
        const limit = Math.max(1, Math.min(30, Number(body.limit) || 12));
        const candidates = await withTimeoutMs(catalog.list(code, { limit }), 60_000, 'candidates_timeout');
        const context=await subtitleContext(state,target.path,code,config);
        const bound=candidateContexts.issue(context,candidates);
        await writeLog('INFO', `subtitle candidates code=${code} n=${candidates.length}`);
        return json(res, 200, { file: target.path, code, ...bound });
      } catch (e) {
        await writeLog('WARN', `subtitle candidates failed: ${e.code || e.message}`);
        return json(res, 500, { error: 'subtitles_failed', message: e.code || e.message || 'subtitles_failed' });
      } finally { try { state?.close(); } catch { /* ignore */ } }
    }

    if (p === '/api/subtitles/apply') {
      let candidate = body.candidate;
      if (!candidate || typeof candidate !== 'object' || !candidate.source) {
        return json(res, 400, { error: 'candidate_required', message: '缺少 candidate' });
      }
      let state = null;
      try {
        state = openState(path.join(dataDirOf(config), 'state.db'));
        const prev = state.getFile(target.path);
        const code=body.code?normalizeManualCode(body.code):prev?.code||extractCandidates(path.basename(target.path)).candidates[0]?.code||null;
        candidate=candidateContexts.resolve(candidate,await subtitleContext(state,target.path,code,config));
        const journalFile=journalPathFor(dataDirOf(config));await ensureJournalEntry(journalFile,target.path);
        const journal={file:journalFile,toPath:target.path};
        const catalog = createSubtitleCatalog({ config, http: createHttp(config.network) });
        const result = await withTimeoutMs(catalog.installChosen({
          file: target.path,
          candidate,
          durationSec: durationSecOf(prev?.data?.meta || null),
          journal,
          signal:req.operationController.signal,
          fit: { ...(config.subs?.fit || {}), maxDurationDeltaMin: config.subs?.maxDurationDeltaMin ?? 5 },
        }), 120_000, 'apply_subtitle_timeout',req.operationController);
        state.upsertFile(target.path, {
          subPath: result.path,
          data: {
            ...(prev?.data || {}),
            sub: {
              source: candidate.source, lang: result.lang, name: candidate.name || null,
              bytes: result.bytes, cues: result.cues, verdict: result.verdict,
              warnings: result.warnings, fit: result.fit, path: result.path, manual: true,
            },
          },
        });
        await writeLog('INFO', `manual subtitle installed source=${candidate.source} bytes=${result.bytes}`);
        return json(res, 200, result);
      } catch (e) {
        if(e.status===409)return json(res,409,{error:e.code||e.message});
        if (e.code === 'SUBTITLE_REJECTED') return json(res, 400, { error: 'subtitle_rejected', reason: e.reason || e.message, message: e.message });
        if (e.code === 'CANDIDATE_REQUIRED') return json(res, 400, { error: 'candidate_required', message: e.message });
        await writeLog('WARN', `manual subtitle failed: ${e.code || e.message}`);
        return json(res, 500, { error: 'subtitles_failed', message: e.code || e.message || 'subtitles_failed' });
      } finally { try { state?.close(); } catch { /* ignore */ } }
    }

    // /api/cover/fetch
    let state = null;
    try {
      state = openState(path.join(dataDirOf(config), 'state.db'));
      const row = state.getFile(target.path);
      const url = String(body.url || row?.data?.meta?.coverUrl || '').trim();
      if (!url) return json(res, 400, { error: 'cover_url_missing', message: '没有封面地址，可在详情里手动填写' });
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: 'invalid_url' });
      const media = await import('./media/covers.mjs');
      const { buffer, ext } = await media.downloadCover(getCoverHttp(config), url);
      const dirVideos = (await listVideos(path.dirname(target.path), config)).length;
      const alsoPoster = config.covers?.posterWhenSingle !== false && dirVideos <= 1;
      const coverTarget = media.coverSidecarPath(target.path, { ext });
      const posterTarget = alsoPoster ? path.join(path.dirname(target.path), `poster.${ext}`) : null;
      const journalFile=journalPathFor(dataDirOf(config));await ensureJournalEntry(journalFile,target.path);
      const journal={file:journalFile,toPath:target.path};
      throwIfAborted(req.operationController.signal);
      const written = await media.writeCover(target.path, buffer, { alsoPoster,journal:journal.file,signal:req.operationController.signal });
      const coverBackup=written.backup,posterBackup=written.posterBackup;
      if (journal) {
        await annotateJournal(journal.file, journal.toPath, {
          cover: written.path,
          poster: written.posterPath || null,
          ...(coverBackup ? { coverBackup } : {}),
          ...(posterBackup ? { posterBackup } : {}),
        });
      }
      const prev = state.getFile(target.path);
      state.upsertFile(target.path, {
        data: { ...(prev?.data || {}), cover: { path: written.path, posterPath: written.posterPath || null, bytes: written.bytes, ext } },
      });
      await writeLog('INFO', `manual cover written bytes=${written.bytes}`);
      return json(res, 200, { journal:journal.file,path: written.path, posterPath: written.posterPath || null, bytes: written.bytes, backup: coverBackup || null });
    } catch (e) {
      await writeLog('WARN', `manual cover failed: ${e.code || e.message}`);
      return json(res, 502, { error: 'cover_fetch_failed', message: e.code || e.message || 'cover_fetch_failed' });
    } finally { try { state?.close(); } catch { /* ignore */ } }
  }

  if (p === '/api/cover' && method === 'GET') {
    const config = await loadConfig();
    const remote = url.searchParams.get('url');
    if (remote) {
      // 远程封面走服务端代理转发（javbus 图片域名浏览器直连会被墙/防盗链）
      if (!/^https?:\/\//i.test(remote)) return json(res, 400, { error: 'invalid_url' });
      const cacheKey = remote;
      const now = Date.now();
      const hit = coverCache.get(cacheKey);
      if (hit && now - hit.at < 3600_000) {
        res.writeHead(200, { 'Content-Type': hit.ct, 'Cache-Control': 'public, max-age=3600' });
        return res.end(hit.buf);
      }
      try {
        const http = getCoverHttp(config);
        const r = await http.getFollow(remote, { timeoutMs: 15000, retry: 1 });
        if (r.status !== 200 || !r.buffer?.length) return json(res, 502, { error: 'cover_fetch_failed', status: r.status });
        const ct = String(r.headers['content-type'] || 'image/jpeg').split(';')[0];
        if (!ct.startsWith('image/')) return json(res, 502, { error: 'not_image', contentType: ct });
        if (r.buffer.length > 12 * 1024 * 1024) return json(res, 413, { error: 'file_too_large' });
        coverCache.set(cacheKey, { buf: r.buffer, ct, at: now });
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
        return res.end(r.buffer);
      } catch (e) {
        return json(res, 502, { error: 'cover_fetch_failed', message: e.code || e.message });
      }
    }
    const target = url.searchParams.get('path');
    if (!target) return json(res, 400, { error: 'path_required' });
    const abs = path.resolve(target);
    if (!isAllowedPath(config, abs)) return json(res, 400, { error: 'fs_forbidden', path: abs });
    const ext = path.extname(abs).toLowerCase();
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext];
    if (!mime) return json(res, 415, { error: 'unsupported_image' });
    try {
      const buf = await readAuthorizedFile(abs,fsConfig(config).allowedRoots);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: 'not_found', path: abs });
    }
  }

  if (p === '/api/media/health' && method === 'GET') {
    const ffmpeg = await detectMediaCapability();
    const config = await loadConfig();
    return json(res, 200, {
      ffmpeg,
      covers: {
        download: config.covers?.download !== false,
        embed: !!config.covers?.embed,
        embedReady: ffmpeg.available,
      },
    });
  }

  if (p === '/api/state' && method === 'GET') {
    const dir = url.searchParams.get('dir');
    const config = await loadConfig();
    const state = openState(path.join(dataDirOf(config), 'state.db'));
    try {
      const files = state.listFiles();
      const scoped = dir ? files.filter((f) => path.dirname(f.path) === path.resolve(dir)) : files;
      return json(res, 200, {
        counts: state.summary(),
        files: scoped.map((f) => {
          const d = f.data || {};
          return {
            path: f.path, name: path.basename(f.path), status: f.status, code: f.code, newName: f.new_name, subPath: f.sub_path,
            exists: fsSync.existsSync(f.path), error: f.error,
            stage: d.stage || null, applied: d.applied === true, planSig: d.planSig || null,
          };
        }),
      });
    } finally { state.close(); }
  }

  if (p === '/api/jobs' && method === 'GET') {
    return json(res, 200, { jobs: [...jobs.values()].map(publicJob).sort((a, b) => b.createdAt - a.createdAt) });
  }
  if (p === '/api/jobs' && method === 'POST') {
    const body = await readBody(req);
    if(assemblyBusy)return json(res,409,{error:'task_running'});
    if(body.kind!=null&&!['plan','apply'].includes(body.kind))return json(res,400,{error:'invalid_job_kind'});
    const kind = body.kind === 'apply' ? 'apply' : 'plan';
    if (!body.dir) return json(res, 400, { error: 'dir_required' });
    const abs = path.resolve(body.dir);
    const ok = await fs.stat(abs).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) return json(res, 400, { error: 'dir_not_found', dir: abs });
    const job = await createJob(kind, abs, body.options || {});
    await writeLog('INFO', `job created ${job.id} kind=${job.kind} dir=${job.dir}`);
    return json(res, 202, { jobId: job.id, job: publicJob(job) });
  }

  const jobMatch = p.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/events|\/cancel|\/log|\/report|\/html)?$/i);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) return json(res, 404, { error: 'job_not_found' });
    const sub = jobMatch[2] || '';
    if (sub === '' && method === 'GET') return json(res, 200, publicJob(job));
    if (sub === '/log' && method === 'GET') return json(res, 200, { id: job.id, logs: job.logs });
    if(sub==='/html' && method==='GET') {if(!job.report)return json(res,404,{error:'report_not_ready'});res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"});return res.end((job.kind==="mux"?muxReportHTML:reportHTML)(job.report,{english:url.searchParams.get('lang')==='en',theme:url.searchParams.get('theme'),fontSize:url.searchParams.get('fontSize')}));}
    if (sub === '/report' && method === 'GET') {
      if (!job.report) return json(res, 404, { error: 'report_not_ready' });
      return json(res, 200, job.report);
    }
    if (sub === '/cancel' && method === 'POST') {
      if (TERMINAL_STATUSES.has(job.status)) {
        return json(res, 409, { error: 'job_finished', message: '任务已结束' });
      }
      try { job.controller?.abort(); } catch { /* ignore */ }
      if (job.status === 'queued') { const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);await finalizeJob(job,'cancelled'); }
      else await persistJob(job);
      return json(res, 200, publicJob(job));
    }
    if (sub === '/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`retry: 3000\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'snapshot', job: publicJob(job), tail: job.logs.slice(-50) })}\n\n`);
      // F1/F9：终态任务只回放 snapshot + job-finished 后立即结束，不注册到 sseClients（否则前端会一直等）
      if (!['queued', 'running'].includes(job.status)) {
        res.write(`data: ${JSON.stringify({ type: 'job-finished', job: publicJob(job) })}\n\n`);
        return res.end();
      }
      if (!sseClients.has(job.id)) sseClients.set(job.id, new Set());
      sseClients.get(job.id).add(res);
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(heartbeat); sseClients.get(job.id)?.delete(res); });
      return;
    }
  }

  if (p === '/api/journals' && method === 'GET') {
    const config = await loadConfig();
    const dir = dataDirOf(config);
    const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /^journal-.*\.json$/.test(n)).sort().reverse();
    const out = [];
    for (const n of names.slice(0, 50)) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
        out.push({ file: path.join(dir, n), createdAt: data.createdAt, items: (data.items || []).length });
      } catch { /* skip broken */ }
    }
    return json(res, 200, { journals: out });
  }

  if (p === '/api/undo' && method === 'POST') {
    const { journal } = await readBody(req);
    if (!journal) return json(res, 400, { error: 'journal_required' });
    // F9：任务运行中不允许撤销（文件可能正在被改名/写旁车）
    if (running) return json(res, 409, { error: 'task_running', message: '任务运行中，完成后再撤销' });
    const config = await loadConfig();
    const target = path.isAbsolute(journal) ? journal : path.join(dataDirOf(config), journal);
    let result;
    try {
      const journalData=JSON.parse(await fs.readFile(target,'utf8'));
      if(journalData.version===2&&journalData.type==='mux-create-output') {
        if(path.dirname(path.resolve(target))!==path.resolve(dataDirOf(config)))throw new Error('invalid_journal_path');
        result=await undoMux(target);
      }else result = await undoAndProject(target,{dataDir:dataDirOf(config)});
    } catch (e) {
      return json(res, 400, { error: 'undo_failed', message: e.message });
    }
    const restoredItems = (Array.isArray(result.completedItems) ? result.completedItems : [])
      .map((item) => ({ from: item.from, to: item.to }));
    // F4：撤销成功后把状态库同步回来（源路径重置为 discovered、目标路径删除）
    let reset = 0;
    let stateError = null;
    let state = null;
    try {
      reset=result.reset||0;stateError=result.stateError||null;
    } catch (e) {
      stateError = e.code || e.message;
    } finally {
      try { state?.close(); } catch { /* ignore */ }
    }
    return json(res, 200, {
      ...result,
      journal: target,
      restored: result.restored,
      removed: result.removed,
      failed: result.failed,
      restoredItems,
      reset,
      ...(stateError ? { stateError } : {}),
    });
  }

  // ---- read-only filesystem browse (folder picker) ----
  if (p === '/api/fs/roots' && method === 'GET') {
    const config = await loadConfig();
    const fs = fsConfig(config);
    return json(res, 200, { enabled: fs.enabled, drives: listDrives(), allowedRoots: fs.allowedRoots, platform: process.platform });
  }
  if (p === '/api/fs/list' && method === 'GET') {
    const config = await loadConfig();
    const target = url.searchParams.get('path') || listDrives()[0] || 'C:\\';
    const result = await listDirectory(config, target);
    return json(res, result.error ? 400 : 200, result);
  }
  if (p === '/api/fs/check' && method === 'GET') {
    const config = await loadConfig();
    const target = url.searchParams.get('path');
    if (!target) return json(res, 400, { error: 'path_required' });
    const abs = path.resolve(target);
    if (!isAllowedPath(config, abs)) return json(res, 400, { error: 'fs_forbidden', dir: abs });
    const st = await fs.stat(abs).catch(() => null);
    return json(res, 200, { path: abs, exists: !!st, isDir: !!st?.isDirectory(), isFile: !!st?.isFile() });
  }
  if (p === '/api/fs/pick-capable' && method === 'GET') {
    const interactive = await checkInteractive();
    return json(res, 200, { interactive, hint: interactive ? null : '后端没有交互桌面：请用 start-gui.cmd 启动，或使用「浏览…」' });
  }
  if (p === '/api/fs/pick-folder' && method === 'POST') {
    const config = await loadConfig();
    if (!fsConfig(config).enabled) return json(res, 403, { error: 'fs_disabled' });
    const picked = await pickFolderNative();
    if (picked.error === 'no_interactive_desktop') return json(res, 409, picked);
    if (picked.error === 'native_dialog_timeout') return json(res, 504, picked);
    if (picked.error) return json(res, 500, picked);
    if (picked.cancelled) return json(res, 200, { cancelled: true });
    return json(res, 200, { path: picked.path, allowed: isAllowedPath(config, picked.path) });
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found', path: p });
  return serveStatic(req, res, p);
}

// ---------------- server lifecycle (F20: importable) ----------------
function createAppServer() {
  return http.createServer((req,res)=>{
    const pending=handleRequest(req,res);activeOperations.add(pending);
    void pending.finally(()=>activeOperations.delete(pending)).catch(()=>{});
  });
}
async function handleRequest(req,res) {
    let counted = false;
    const controller=new AbortController();req.operationController=controller;requestControllers.add(controller);
    const disconnect=()=>{if(!res.writableFinished)controller.abort(Object.assign(new Error('request_closed'),{code:'ABORT_ERR'}));};res.once('close',disconnect);
    try {
      if(closing)return json(res,503,{error:'server_closing'});
      const rejection=evaluateRequest(req,requestPolicy);if(rejection)return json(res,rejection.status,{error:rejection.error});
      const pathname = new URL(req.url, `http://${req.headers.host || HOST}`).pathname;
      const operation = pathname.startsWith('/api/') && pathname !== '/api/health' && !pathname.startsWith('/api/maintenance/');
      if(assemblyBusy&&req.method!=='GET'&&!pathname.startsWith('/api/assembly/'))return json(res,409,{error:'task_running'});
      if (operation && maintenance) return json(res, 409, { error: 'maintenance_in_progress' });
      if (operation) { activeRequests++; counted = true; }
      const cancel=/^\/api\/jobs\/[a-f0-9-]{36}\/cancel$/i.test(pathname);
      const mutates=pathname.startsWith('/api/')&&(!['GET','HEAD','OPTIONS'].includes(req.method)||pathname==='/api/corrections');
      if(mutates&&!cancel) {
        const config=await loadConfig(),dataDir=dataDirOf(config);
        if(running||queue.length||mutationBusy(dataDir))return json(res,409,{error:'task_running'});
        res.deferJson=true;
        await withMutation(dataDir,async()=>{
          const pending=(await fs.readdir(dataDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).some(n=>/^\.identity-pending-/.test(n));
          if(pending) {const state=openState(path.join(dataDir,'state.db'));try{await reconcileEmbeds(dataDir,state);}finally{state.close();}}
          return withHttpSignal(controller.signal,()=>route(req,res));
        },{signal:controller.signal});
      }else await withHttpSignal(controller.signal,()=>route(req,res));
    } catch (e) {
      // F19：API 500 必须落日志
      await writeLog('ERROR', `api 500 ${req.method} ${req.url} ${e?.stack || e?.message || e}`);
      try { json(res, e.status || 500, { error: e.message || 'internal_error' }); } catch { /* ignore */ }
    } finally {
      if (counted) activeRequests--;requestControllers.delete(controller);res.removeListener('close',disconnect);
      res.deferJson=false;
      if(res.pendingJson&&!res.destroyed){const pending=res.pendingJson;res.pendingJson=null;json(res,pending.status,pending.body);}
      // Dispatch outside the route's ownership context, after its lease is released.
      if(queue.length&&!running&&!closing)setImmediate(()=>{void drain().catch(e=>{if(running)running.finalizationError=e;});});
    }
}

function installSignalHandlers(close) {
  const handler = () => {
    if (running) { try { running.controller.abort(); } catch { /* ignore */ } }
    void close().then(()=>process.exit(0),()=>process.exit(1));
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, handler);
  return () => { for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, handler); };
}

/**
 * 启动 GUI 后端（F20：可被测试/其它模块导入）。
 * @param {{port?:number, host?:string, configFile?:string, quiet?:boolean, onRestart?:Function}} [opts]
 *   默认从 process.argv/env 读取，保持既有 CLI 行为。
 * @returns {Promise<{server: import('node:http').Server, port: number, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const argv = process.argv.slice(2);
  const argOf = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const port = opts.port != null ? Number(opts.port) : Number(argOf('port', process.env.AVC_PORT || 17890));
  const host = String(opts.host || argOf('host', '127.0.0.1'));
  const configArg = opts.configFile || argOf('config', null);
  const configFile = path.resolve(configArg || (fsSync.existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : EXAMPLE_CONFIG));
  const quiet = !!opts.quiet;

  // 每次 startServer 重置模块级运行态：同一进程内可多次启停（CLI 只启动一次）。
  CONFIG_FILE = configFile;
  // 界面里的设置写回本机配置；--config / opts.configFile 时写回该文件；仓库模板永不修改
  CONFIG_WRITE = configArg ? configFile : LOCAL_CONFIG;
  HOST = host;
  configCache = null;
  persistedJobsLoaded = false;
  coverHttp = null;
  coverCache.clear();
  jobs.clear();
  queue.length = 0;
  sseClients.clear();
  running = null;
  maintenance = null;
  activeRequests = 0;
  assemblyBusy = false;
  restartServer = null;
  instanceId = crypto.randomUUID();
  closing=false;drainPromise=null;candidateContexts.clear();logError=null;logChain=Promise.resolve();
  jobWriter=createSnapshotWriter();
  installGlobalHandlers();

  // 配置读取失败不阻止启动（路由会 500，与既有行为一致）
  let configError = null;
  try { await loadConfig(); } catch (e) { configError = e; }

  // F19：日志目录 + 14 天前日志清理
  await cleanupOldLogs(LOG_RETENTION_DAYS).catch(() => {});
  if (configError) await writeLog('WARN', `config load failed: ${configError.code || configError.message}`);

  // F9：listen 前恢复历史任务（只恢复终态任务，running/queued 转为中断 interrupted_by_restart）
  try {
    await loadPersistedJobs();
  } catch (e) {
    await writeLog('WARN', `load persisted jobs failed: ${e.code || e.message}`);
  }

  const server = createAppServer();
  let removeSignals=()=>{};
  await new Promise((resolve, reject) => {
    const onError = (e) => { removeSignals(); reject(e); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const actualPort = server.address()?.port ?? port;
  requestPolicy=listenerPolicy(host,actualPort);
  let closePromise=null;
  const close = () => closePromise||=(async()=>{
    closing=true;
    removeSignals();
    if (running) { try { running.controller.abort(); } catch { /* ignore */ } }
    for(const controller of requestControllers)controller.abort(Object.assign(new Error('server_closing'),{code:'ABORT_ERR'}));
    const stopped=new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    server.closeAllConnections?.();
    const queued=queue.splice(0);for(const job of queued){job.controller.abort();await finalizeJob(job,'cancelled');}
    await Promise.all([...activeOperations]);
    if(drainPromise)await drainPromise;
    for(const clients of sseClients.values())for(const res of clients)res.end();sseClients.clear();
    await Promise.all([...jobs.values()].map(job=>job.persistChain));
    await jobWriter.close();
    await writeLog('INFO','server closed');await logChain;
    if(logError)throw logError;
    await stopped;
  })();
  removeSignals=installSignalHandlers(close);
  if (typeof opts.onRestart === 'function') restartServer = async () => { await close(); await opts.onRestart(); };

  if (isMainModule && process.send) process.send({ type: 'listening', port: actualPort, host, configFile: CONFIG_WRITE });

  await writeLog('INFO', `server started v${VERSION} http://${host}:${actualPort} config=${CONFIG_FILE}`);
  if (!quiet) {
    console.log(`AVC backend v${VERSION} -> http://${host}:${actualPort}  (web root: ${WEB_DIR})`);
    console.log('GUI API spec: docs/SERVICE_API.md');
  }
  if (!quiet && !configArg && argv.includes('--open')) {
    const url = `http://${host}:${actualPort}/`;
    import('node:child_process').then(({ exec }) => exec(`start "" "${url}"`)).catch(() => {});
  }

  return { server, port: actualPort, close };
}

// F20：main-guard —— 直接 `node src/server.mjs` 时启动；被 import 时不监听端口
const isMainModule = (() => {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMainModule && process.env.AVC_GUI_WORKER !== '1') {
  runGuiSupervisor(fileURLToPath(import.meta.url));
} else if (isMainModule) {
  startServer({ onRestart: process.send ? () => process.exit(75) : undefined }).then(app=>{
    process.on('message',value=>{if(value?.type==='shutdown')app.close().then(()=>process.exit(0),error=>{console.error(`AVC worker shutdown failed: ${error.message}`);process.exitCode=1;});});
  }).catch((e) => {
    console.error(`AVC backend start failed: ${e.code || e.message}`);
    process.exitCode = 1;
  });
}
