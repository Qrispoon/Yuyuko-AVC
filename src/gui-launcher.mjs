import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {evaluateRequest,listenerPolicy,forwardRequestHeaders} from './core/request-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const HOST = '127.0.0.1';
const PORT = Number(process.env.AVC_PORT || 17890);
const workerPortRequest = Number(process.env.AVC_WORKER_PORT || 0);
let workerPort = workerPortRequest;
const CONFIG_FILE = process.env.AVC_CONFIG_FILE;
const STARTUP_DELAY_MS = Math.max(0, Number(process.env.AVC_STARTUP_DELAY_MS) || 0);
const state = { phase: 'starting', error: null, startedAt: Date.now() };
const STARTUP_TIMEOUT_MS = Math.max(10000, Number(process.env.AVC_STARTUP_TIMEOUT_MS) || 120000);
let worker;
let stopping = false;
let restartPending = false;
let stopPromise;

function stopWorker(current=worker) {
  if(!current)return Promise.resolve();
  if(current.exitCode!=null||current.signalCode!=null)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    current.once('exit',resolve);
    if(current.connected)current.send({type:'shutdown'},error=>{if(error)reject(error);});
    else reject(new Error('worker_shutdown_channel_unavailable'));
  });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

async function serveFile(res, name) {
  try {
    const body = await fs.readFile(path.join(WEB, name));
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('AVC startup files are missing.');
  }
}

function launchWorker() {
  state.phase = 'initializing';
  state.error = null;
  const args = [...process.execArgv, path.join(ROOT, 'src/server.mjs'), '--host', HOST, '--port', String(workerPort || workerPortRequest)];
  if (CONFIG_FILE) args.push('--config', path.resolve(CONFIG_FILE));
  worker = spawn(process.execPath, args, {
    cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, AVC_GUI_WORKER: '1' }, windowsHide: true,
  });
  const currentWorker = worker;
  worker.on('message', value => {
    if (worker !== currentWorker || stopping || value?.type !== 'listening') return;
    workerPort = Number(value.port);
    state.phase = 'checking';
  });
  worker.once('error', error => {
    if (worker !== currentWorker || stopping) return;
    state.phase = 'failed'; state.error = error.code || error.message;
  });
  worker.once('exit', (code, signal) => {
    if (worker !== currentWorker) return;
    worker = null;
    if (stopping) return;
    if (state.phase === 'failed') return;
    if (code === 75 || restartPending) {
      restartPending = false;
      state.phase = 'initializing';
      state.startedAt = Date.now();
      launchWorker();
      return;
    }
    state.phase = 'failed';
    state.error = signal ? `worker_stopped_${signal}` : `worker_exit_${code ?? 'unknown'}`;
  });
}

async function checkWorker() {
  if ((state.phase === 'initializing' || state.phase === 'checking') && Date.now() - state.startedAt > STARTUP_TIMEOUT_MS) {
    state.phase = 'failed';
    state.error = 'backend_start_timeout';
    await stopWorker();
    return;
  }
  if (state.phase !== 'checking' && state.phase !== 'ready') return;
  const checkedWorker = worker, checkedPort = workerPort;
  // A request started before restart may finish after the worker exits. It
  // must not mark the replacement ready or reset its initialization state.
  const stillCurrent = () => worker === checkedWorker && workerPort === checkedPort &&
    !stopping && (state.phase === 'checking' || state.phase === 'ready');
  try {
    const response = await fetch(`http://${HOST}:${checkedPort}/api/health`, { signal: AbortSignal.timeout(700) });
    if (!stillCurrent()) return;
    if (response.ok) { state.phase = 'ready'; state.error = null; }
    else if (response.status >= 500) {
      state.phase = 'failed';
      state.error = `backend_health_${response.status}`;
      await stopWorker();
    }
    else { state.phase = 'checking'; }
  } catch {
    if (stillCurrent() && worker) state.phase = 'checking';
  }
}

const server = http.createServer(async (req, res) => {
  const publicPolicy=listenerPolicy(HOST,server.address().port);
  const rejected=evaluateRequest(req,publicPolicy);
  if(rejected){res.writeHead(rejected.status,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:rejected.error}));}
  const url = new URL(req.url || '/', `http://${HOST}:${server.address().port}`);
  if (url.pathname === '/__avc/startup') {
    await checkWorker();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ...state, phase: worker ? state.phase : (state.phase === 'failed' ? 'failed' : 'initializing') }));
  }
  if (url.pathname === '/__avc/retry' && req.method === 'POST') {
    if (state.phase !== 'failed' || worker) { res.writeHead(409).end(); return; }
    state.startedAt = Date.now();
    res.writeHead(202, { 'Cache-Control': 'no-store' }).end();
    launchWorker();
    return;
  }
  // The workbench waits on health after a restart, without loading the startup
  // page. Advance readiness here as well, and before choosing the root page.
  if (url.pathname === '/api/health' || url.pathname === '/') await checkWorker();
  if (url.pathname === '/startup.html' || (url.pathname === '/' && state.phase !== 'ready')) return serveFile(res, 'startup.html');
  if (['/startup.css', '/startup.js', '/startup-art.js', '/assets/yuyuko-startup.png', '/assets/yuyuko-avatar.jpg'].includes(url.pathname)) {
    const rel = url.pathname.slice(1);
    if (rel.includes('..')) { res.writeHead(403).end(); return; }
    return serveFile(res, rel);
  }
  if (state.phase !== 'ready') {
    res.writeHead(state.phase === 'failed' ? 503 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1' });
    return res.end(JSON.stringify({ error: state.phase === 'failed' ? 'backend_start_failed' : 'backend_initializing' }));
  }
  let headers;
  try{headers=forwardRequestHeaders(req,publicPolicy,HOST,workerPort);}
  catch(error){res.writeHead(error.status||403,{'Content-Type':'application/json; charset=utf-8'});return res.end(JSON.stringify({error:error.error||'invalid_origin'}));}
  const upstream = http.request({ hostname: HOST, port: workerPort, method: req.method, path: req.url, headers }, upstreamRes => {
    if (url.pathname === '/api/maintenance/restart' && upstreamRes.statusCode === 202) {
      state.phase = 'restarting';
      restartPending = true;
    }
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: 'backend_restarting' })); }
  });
  req.pipe(upstream);
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
});

function stop() {
  return stopPromise||=(async()=>{
    stopping=true;
    const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await stopWorker();
    await closed;
    process.exit(0);
  })().catch(error=>{console.error(`AVC shutdown failed: ${error.message}`);process.exitCode=1;});
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('message',value=>{if(value?.type==='shutdown')void stop();});

server.once('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (response.ok && !process.env.AVC_NO_BROWSER) await import('node:child_process').then(({ exec }) => exec(`start "" "http://${HOST}:${PORT}/"`));
      else console.error(`AVC port ${PORT} is already in use.`);
      process.exitCode = response.ok ? 0 : 1;
    } catch { console.error(`AVC port ${PORT} is already in use by another program.`); process.exitCode = 1; }
    return;
  }
  console.error(`AVC startup failed: ${error.code || error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log(`AVC startup page -> http://${HOST}:${PORT}/`);
  setTimeout(launchWorker, STARTUP_DELAY_MS);
  if (!process.env.AVC_NO_BROWSER) setTimeout(() => import('node:child_process').then(({ exec }) => exec(`start "" "http://${HOST}:${PORT}/startup.html"`)).catch(() => {}), 250);
});
