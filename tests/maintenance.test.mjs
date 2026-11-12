import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { clearCaches } from '../src/core/maintenance.mjs';
import { openState } from '../src/core/state.mjs';
import { startServer } from '../src/server.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avc-maintenance-'));
  const data = path.join(root, 'data'), videos = path.join(root, 'videos');
  await fs.mkdir(videos);
  const file = path.join(videos, 'unknown.mp4');
  await fs.writeFile(file, 'QA placeholder video');
  const config = { paths: {dataDir:data}, network: {defaultRoute:'direct',retry:0,timeoutMs:100},
    scan: {videoExtensions:['.mp4']}, media: {probeDuration:'off'},
    subs: {sources:['local'],localDirs:[root]}, covers: {download:false,embed:false},
    fs: {enabled:true,allowedRoots:[root]} };
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(config));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  return {root,data,videos,file,config,configFile};
}
const post = (base, route, body = {}) => fetch(base + route, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('cache clear removes only disposable entries and preserves media, locks, plans and undo/history', async t => {
  const {data,file} = await fixture(t), state = openState(path.join(data,'state.db'));
  state.putCode('IPX-920', {meta:{titleJa:'Cached title'}});
  state.correct(file, {maker:{value:'Manual lock',locked:true}}, 0);
  state.upsertFile(file, {status:'ok',data:{meta:{titleJa:'Historical result'}}});
  state.putSubtitle({code:'IPX-920',source:'local',local_path:file+'.srt'});
  state.close();
  for (const [name,content] of [['journal-qa.json','undo'],['jobs/qa.json','history'],['plans/qa.json','confirmed subtitle bytes'],['wallpapers/qa.png','wallpaper'],['subtitle-previews/keep.txt','unknown file'],['subtitle-previews/'+ 'a'.repeat(64)+'.json','cached analysis']]) {
    const dest=path.join(data,name); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,content);
  }
  await fs.writeFile(file+'.srt','installed sidecar');
  const covers = new Map([['cover',{buf:Buffer.from('cover bytes')}] ]);
  const cleared=await clearCaches(data,covers);
  assert.equal(cleared.entries,3); assert.equal(cleared.metadataEntries,1); assert.equal(cleared.previewFiles,1); assert.ok(cleared.bytes>0); assert.equal(covers.size,0);
  for(const [name,content] of [['journal-qa.json','undo'],['jobs/qa.json','history'],['plans/qa.json','confirmed subtitle bytes'],['wallpapers/qa.png','wallpaper'],['subtitle-previews/keep.txt','unknown file']]) assert.equal(await fs.readFile(path.join(data,name),'utf8'),content);
  assert.equal(await fs.readFile(file+'.srt','utf8'),'installed sidecar');
  const next=openState(path.join(data,'state.db'));
  try { assert.equal(next.getCode('IPX-920'),null); assert.equal(next.record(file).fields.maker.value,'Manual lock'); assert.equal(next.correctionHistory(file).length,1); assert.equal(next.getFile(file).data.meta.titleJa,'Historical result'); assert.equal(next.subtitlesFor('IPX-920').length,1); } finally {next.close();}
  assert.equal((await clearCaches(data,covers)).entries,0);
});

test('cache clear refuses linked cache directories without deleting external files or DB cache', async t => {
  const {root,data}=await fixture(t),outside=path.join(root,'outside');
  await fs.mkdir(data); await fs.mkdir(outside);
  const target=path.join(outside,'b'.repeat(64)+'.json'); await fs.writeFile(target,'keep');
  await fs.symlink(outside,path.join(data,'subtitle-previews'),process.platform==='win32'?'junction':'dir');
  const state=openState(path.join(data,'state.db'));state.putCode('IPX-920',{meta:{titleJa:'Cached'}});state.close();
  await assert.rejects(()=>clearCaches(data), /unsafe_cache_directory/);
  assert.equal(await fs.readFile(target,'utf8'),'keep');
  const next=openState(path.join(data,'state.db'));try{assert.ok(next.getCode('IPX-920'));}finally{next.close();}
});

test('removed APIs return 404; normal preview/history stay usable and restart requires a lifecycle owner', async t => {
  const {configFile,videos,file}=await fixture(t),srv=await startServer({port:0,configFile,quiet:true});
  t.after(()=>srv.close());const base=`http://127.0.0.1:${srv.port}`;
  assert.equal((await post(base,'/api/queue',{paused:true})).status,404);
  assert.equal((await fetch(base+'/api/issues')).status,404);
  assert.equal((await post(base,'/api/issues',{key:'old'})).status,404);
  const health=await (await fetch(base+'/api/health')).json();assert.equal(health.restartSupported,false);
  assert.equal((await post(base,'/api/maintenance/restart')).status,503);
  // Static contract update only in the 2026-11-11 repair; this restricted file was not executed.
  assert.equal((await fetch(base+'/api/maintenance/cache',{method:'POST',body:'{}'})).status,415);
  assert.equal((await fetch(base+'/api/maintenance/cache',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.test'},body:'{}'})).status,403);
  assert.equal((await post(base,'/api/maintenance/cache')).status,200);
  const created=await (await post(base,'/api/jobs',{kind:'plan',dir:videos,options:{only:[file],downloadSubs:false}})).json();
  for(let n=0;n<100;n++){const job=await (await fetch(base+'/api/jobs/'+created.jobId)).json();if(job.status==='done')break;await sleep(10);}
  const list=await (await fetch(base+'/api/jobs')).json();assert.ok(!('paused' in list));assert.ok(!('order' in list));assert.ok(!('position' in list.jobs[0]));assert.equal(list.jobs[0].status,'done');
});

test('maintenance rejects in-flight work and blocks new mutations during restart', async t => {
  const {configFile,videos,file}=await fixture(t);let restarted=false;
  const srv=await startServer({port:0,configFile,quiet:true,onRestart:()=>{restarted=true;}});
  t.after(()=>srv.close());const base=`http://127.0.0.1:${srv.port}`;
  // Hold a request body open to model another tab writing configuration.
  const http=await import('node:http');
  const held=http.request(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'}});
  held.on('error',()=>{});held.write('{');await sleep(30);
  assert.equal((await post(base,'/api/maintenance/cache')).status,409);
  assert.equal((await post(base,'/api/maintenance/restart')).status,409);
  held.end(JSON.stringify({kind:'plan',dir:videos,options:{only:[file],downloadSubs:false}}).slice(1));
  // Done is visible only after report/history persistence; maintenance also
  // waits for the remaining request lifecycle to become idle as the GUI does.
  let idle=false;
  for(let n=0;n<100;n++){
    const jobs=await (await fetch(base+'/api/jobs')).json();
    const health=await (await fetch(base+'/api/health')).json();
    if(jobs.jobs[0]?.status==='done' && !health.running && health.queued===0){idle=true;break;}
    await sleep(10);
  }
  assert.equal(idle,true,'report and history writes must finish before restarting');
  assert.equal((await post(base,'/api/maintenance/restart')).status,202);
  assert.equal((await post(base,'/api/jobs',{dir:videos})).status,409);
  for(let n=0;n<100&&!restarted;n++)await sleep(10);
  assert.equal(restarted,true);
});

test('real CLI restart changes worker PID on the same port and preserves config and locks', async t => {
  const {data,file,configFile}=await fixture(t);
  const state=openState(path.join(data,'state.db'));state.correct(file,{maker:{value:'Keep on restart',locked:true}},0);state.close();
  const worker=spawn(process.execPath,[path.join(rootDir,'src/server.mjs'),'--port','0','--config',configFile],{
    cwd:rootDir,env:{...process.env,AVC_GUI_WORKER:''},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,
  });
  let output='';worker.stdout.on('data',d=>output+=d);worker.stderr.on('data',d=>output+=d);
  t.after(async()=>{if(worker.exitCode===null){const done=once(worker,'exit');worker.send({type:'stop'});const timeout=setTimeout(()=>worker.kill(),2000);try{await done;}finally{clearTimeout(timeout);}}});
  let port;
  for(let n=0;n<100;n++){port=output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];if(port)break;await sleep(50);}
  assert.ok(port,output);const base=`http://127.0.0.1:${port}`;
  const before=await (await fetch(base+'/api/health')).json();assert.equal(before.restartSupported,true);
  assert.equal((await post(base,'/api/maintenance/restart')).status,202);
  let after;
  for(let n=0;n<150;n++){await sleep(50);try{const h=await (await fetch(base+'/api/health',{signal:AbortSignal.timeout(300)})).json();if(h.instanceId!==before.instanceId){after=h;break;}}catch{}}
  assert.ok(after,output);assert.notEqual(after.pid,before.pid);assert.equal(after.version,before.version);
  const cfg=await (await fetch(base+'/api/config')).json();assert.equal(cfg.paths.dataDir,data);
  const next=openState(path.join(data,'state.db'));try{assert.equal(next.record(file).fields.maker.value,'Keep on restart');}finally{next.close();}
});
