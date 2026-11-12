// Capability preflight: dedicated ordinary synthetic files/SQLite, fake embed bytes,
// normal same-origin loopback requests only. No outside Origin, links, abnormal TLS,
// real media/tools, existing service/data, child processes, or fixture cleanup.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openState} from '../src/core/state.mjs';
import {applyRenames,ensureJournalEntry,readJournal,writeJournalSidecar} from '../src/core/journal.mjs';
import {undoAndProject} from '../src/core/undo.mjs';
import {fileEvidence} from '../src/core/file-operations.mjs';
import {prepareEmbed,reconcileEmbeds} from '../src/core/embed-reconcile.mjs';
import {createBackup,restoreBackup,recoverRestore} from '../src/core/backup.mjs';
import {runDirectory,configSignature,withDeadline} from '../src/pipeline.mjs';
import {startServer} from '../src/server.mjs';
import {main} from '../src/cli.mjs';
const root=path.resolve('tmp/repair-2026-11-11-3e77b77c/fixtures',`integration-${randomUUID()}`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const srt='1\n00:00:01,000 --> 00:00:03,000\n这是测试，我们说话\n';
async function setup(){
  const dir=path.join(root,randomUUID()),videos=path.join(dir,'videos'),subs=path.join(dir,'subtitles'),data=path.join(dir,'data');await fs.mkdir(videos,{recursive:true});await fs.mkdir(subs);
  const file=path.join(videos,'IPX-920.mp4');await fs.writeFile(file,'AAAA');
  const config={paths:{dataDir:data},scan:{videoExtensions:['.mp4']},rename:{template:'{code} {title}'},network:{proxy:'',defaultRoute:'direct',timeoutMs:100,retry:0,minIntervalMs:0},media:{probeDuration:'off'},metadata:{r18:false},subs:{sources:['local'],localDirs:[subs],extraLangs:[],fit:{mode:'none'}},covers:{download:false,embed:false},fs:{enabled:true,allowedRoots:[dir]}};
  const state=openState(path.join(data,'state.db'));state.putCode('IPX-920',{meta:{titleJa:'Frozen',maker:'M',actress:['A'],releaseDate:'2026-01-01'}});
  return {dir,videos,subs,data,file,config,state};
}
test('R04 deadline aborts before new effect and waits for the owned work to settle',async()=>{
  let settled=false,effects=0;const started=Date.now();
  await assert.rejects(withDeadline(async signal=>{await pause(25);settled=true;if(signal.aborted)throw signal.reason;effects++;},2,'fake-operation'),{code:'FILE_TIMEOUT'});
  assert.equal(settled,true);assert.ok(Date.now()-started>=20);assert.equal(effects,0);await pause(10);assert.equal(effects,0);
});
test('R18 same-path same-size external replacement is processed on the first run without inherited locks',async()=>{
  const x=await setup();try {
    const old=x.state.record(x.file);x.state.correct(x.file,{maker:{value:'Old lock',locked:true}},0);
    x.state.upsertFile(x.file,{status:'ok',data:{size:4,applied:true,planSig:configSignature(x.config)}});
    await fs.rename(x.file,path.join(x.dir,'external-old.mp4'));await fs.writeFile(x.file,'BBBB');
    const result=await runDirectory({dir:x.videos,config:x.config,apply:true,downloadSubs:false});assert.equal(result.count,1);assert.equal(result.results[0].status,'ok');
    const effective=result.results[0].renamedTo||x.file,next=x.state.record(effective);assert.notEqual(next.id,old.id);assert.deepEqual(next.fields,{});
    assert.equal(x.state.db.prepare('SELECT count(*) n FROM corrections WHERE record_id=?').get(old.id).n,1);
    assert.equal((await runDirectory({dir:x.videos,config:x.config,apply:true,downloadSubs:false})).count,0);
  }finally{x.state.close();}
});
test('R05 fake replacement reconciliation preserves the current record/locks and undo retains embedded output',async()=>{
  const x=await setup();try {
    const record=x.state.record(x.file);x.state.correct(x.file,{maker:{value:'Locked',locked:true}},0);
    const target=path.join(x.videos,'Renamed.mp4'),{journal}=await applyRenames([{from:x.file,to:target,action:'rename'}],{dataDir:x.data});x.state.moveRecord(x.file,target);
    const embedding=await prepareEmbed({dataDir:x.data,journal,media:target,record:x.state.record(target)}),temp=path.join(x.videos,'synthetic-output');await fs.writeFile(temp,'FAKE EMBED OUTPUT');
    await embedding.beforePublish({outputEvidence:await fileEvidence(temp,{content:true})});await fs.rename(temp,target);
    await assert.rejects(reconcileEmbeds(x.data,{replaceRecordIdentity(){throw new Error('synthetic database failure');}}));
    assert.throws(()=>x.state.record(target),{code:'EMBED_RECONCILE_PENDING'});await reconcileEmbeds(x.data,x.state);
    const after=x.state.record(target);assert.equal(after.id,record.id);assert.equal(after.fields.maker.value,'Locked');assert.equal(after.revision,2);
    assert.equal((await readJournal(journal)).items[0].embed.phase,'committed');
    const undone=await undoAndProject(journal,{dataDir:x.data});assert.equal(undone.undoComplete,true);assert.deepEqual(undone.retainedEffects,['embedded_cover']);assert.equal(await fs.readFile(x.file,'utf8'),'FAKE EMBED OUTPUT');assert.equal(x.state.record(x.file).id,record.id);assert.equal(x.state.record(x.file).fields.maker.value,'Locked');
  }finally{x.state.close();}
});
test('R05 cancelled pre-publication embed allows path undo; later user media edits block undo',async()=>{
  const x=await setup();try {
    const target=path.join(x.videos,'Renamed.mp4'),{journal}=await applyRenames([{from:x.file,to:target,action:'rename'}],{dataDir:x.data});x.state.record(x.file);x.state.moveRecord(x.file,target);
    await prepareEmbed({dataDir:x.data,journal,media:target,record:x.state.record(target)});await reconcileEmbeds(x.data,x.state);assert.equal((await readJournal(journal)).items[0].embed.phase,'cancelled');
    await fs.appendFile(target,'USER CHANGE');const result=await undoAndProject(journal,{dataDir:x.data});assert.equal(result.undoComplete,false);assert.equal(await fs.readFile(target,'utf8'),'AAAAUSER CHANGE');
  }finally{x.state.close();}
});
test('R09 database projection resets application flags once while preserving corrections',async()=>{
  const x=await setup();try {
    const record=x.state.record(x.file);x.state.correct(x.file,{titleJa:{value:'Title lock',locked:true}},0);
    const to=path.join(x.videos,'new.mp4'),{journal}=await applyRenames([{from:x.file,to,action:'rename'}],{dataDir:x.data});x.state.moveRecord(x.file,to);x.state.upsertFile(x.file,{status:'ok',data:{applied:true,planSig:'old'}});x.state.upsertFile(to,{status:'ok',data:{applied:true}});
    const first=await undoAndProject(journal,{dataDir:x.data});assert.equal(first.undoComplete,true);assert.equal(x.state.getFile(x.file).data,null);assert.equal(x.state.getFile(x.file).status,'discovered');assert.equal(x.state.getFile(to),null);assert.equal(x.state.record(x.file).id,record.id);
    x.state.upsertFile(x.file,{status:'ok',data:{applied:true,planSig:'later'}});const again=await undoAndProject(journal,{dataDir:x.data});assert.equal(again.reset,0);assert.equal(x.state.getFile(x.file).data.planSig,'later');
  }finally{x.state.close();}
});
test('R15 interrupted whole-generation restore rolls back and repeated recovery has no effect',async()=>{
  const source=await setup(),target=await setup();try {
    source.state.upsertFile(source.file,{status:'ok',data:{generation:'source'}});target.state.upsertFile(target.file,{status:'ok',data:{generation:'target'}});
    await fs.writeFile(path.join(target.data,'journal-target.json'),'target history');const backup=await createBackup({dataDir:source.data});target.state.close();
    await assert.rejects(restoreBackup({backupDir:backup.path,dataDir:target.data,force:true,onPhase:async phase=>{if(phase==='installed')throw new Error('synthetic interruption');}}),{code:'RESTORE_PENDING'});
    assert.throws(()=>openState(path.join(target.data,'state.db')),{code:'RESTORE_PENDING'});const recovered=await recoverRestore(target.data);assert.equal(recovered.recovered,true);assert.equal(recovered.committed,false);
    const reopened=openState(path.join(target.data,'state.db'));try{assert.equal(reopened.getFile(target.file).data.generation,'target');}finally{reopened.close();}
    assert.equal(await fs.readFile(path.join(target.data,'journal-target.json'),'utf8'),'target history');assert.equal((await recoverRestore(target.data)).reason,'no_pending_restore');
  }finally{source.state.close();target.state.close();}
});

test('R09 partial sidecar undo projects completed video identity once and preserves later applied state',async()=>{
  const x=await setup();try {
    const record=x.state.record(x.file);x.state.correct(x.file,{maker:{value:'Locked',locked:true}},0);
    x.state.upsertFile(x.file,{status:'ok',data:{applied:true,planSig:'before'}});
    const to=path.join(x.videos,'new.mp4'),sidecar=path.join(x.videos,'new.srt');
    const {journal}=await applyRenames([{from:x.file,to,action:'rename'}],{dataDir:x.data});x.state.moveRecord(x.file,to);
    await writeJournalSidecar(journal,to,sidecar,'AAAA');await fs.writeFile(sidecar,'BBBB');
    x.state.upsertFile(to,{status:'ok',data:{applied:true}});
    const result=await undoAndProject(journal,{dataDir:x.data});assert.equal(result.undoComplete,false);assert.equal(result.restored,1);assert.equal(result.completedItems.length,0);assert.equal(result.videoDoneItems.length,1);assert.equal(result.reset,1);
    assert.match(result.failed[0].reason,/sidecar_changed/);assert.equal(await fs.readFile(sidecar,'utf8'),'BBBB');assert.equal(await fs.readFile(x.file,'utf8'),'AAAA');
    const current=x.state.record(x.file);assert.equal(current.id,record.id);assert.equal(current.fields.maker.value,'Locked');assert.equal(current.fields.maker.locked,true);
    assert.equal(x.state.db.prepare('SELECT count(*) n FROM corrections WHERE record_id=?').get(record.id).n,1);assert.equal(x.state.getFile(to),null);assert.equal(x.state.getFile(x.file).status,'discovered');
    x.state.upsertFile(x.file,{status:'ok',data:{applied:true,planSig:'later'}});
    const again=await undoAndProject(journal,{dataDir:x.data});assert.equal(again.undoComplete,false);assert.equal(again.reset,0);assert.equal(x.state.getFile(x.file).data.planSig,'later');assert.equal(x.state.record(x.file).id,record.id);
  }finally{x.state.close();}
});

test('R05 partial undo still discloses retained embedded content and projects its same record',async()=>{
  const x=await setup();try {
    const record=x.state.record(x.file),to=path.join(x.videos,'embedded.mp4'),sidecar=path.join(x.videos,'embedded.srt');
    const {journal}=await applyRenames([{from:x.file,to,action:'rename'}],{dataDir:x.data});x.state.moveRecord(x.file,to);
    const embedding=await prepareEmbed({dataDir:x.data,journal,media:to,record:x.state.record(to)}),temp=path.join(x.videos,'fake-output');await fs.writeFile(temp,'EMBED OUTPUT');await embedding.beforePublish({outputEvidence:await fileEvidence(temp,{content:true})});await fs.rename(temp,to);await reconcileEmbeds(x.data,x.state);
    await writeJournalSidecar(journal,to,sidecar,'AAAA');await fs.writeFile(sidecar,'BBBB');
    const result=await undoAndProject(journal,{dataDir:x.data});assert.equal(result.undoComplete,false);assert.deepEqual(result.retainedEffects,['embedded_cover']);assert.equal(result.reset,1);assert.equal(x.state.record(x.file).id,record.id);assert.equal(await fs.readFile(x.file,'utf8'),'EMBED OUTPUT');assert.equal(await fs.readFile(sidecar,'utf8'),'BBBB');
  }finally{x.state.close();}
});

test('R15 CLI recovery accepts no backup path and reports no pending generation clearly',async()=>{
  const x=await setup();x.state.close();const configFile=path.join(x.dir,'config.json');await fs.writeFile(configFile,JSON.stringify(x.config));
  const logs=[],errors=[],oldLog=console.log,oldError=console.error;
  console.log=(...args)=>logs.push(args.join(' '));console.error=(...args)=>errors.push(args.join(' '));
  try {assert.equal(await main(['restore','--recover','--config',configFile]),0);}
  finally {console.log=oldLog;console.error=oldError;}
  assert.deepEqual(errors,[]);assert.match(logs.join('\n'),/no_pending_restore/);assert.doesNotMatch(logs.join('\n'),/undefined|usage:/);
});
test('R16/R17/R21 normal same-origin API keeps scope/context and exposes terminal only after persistence',async()=>{
  const x=await setup(),other=path.join(x.videos,'IPX-921.mp4');await fs.writeFile(other,'CCCC');await fs.writeFile(path.join(x.subs,'IPX-920.srt'),srt);
  x.state.putCode('IPX-921',{meta:{titleJa:'Other',maker:'M',actress:['A'],releaseDate:'2026-01-01'}});
  const configFile=path.join(x.dir,'config.json');await fs.writeFile(configFile,JSON.stringify(x.config));const server=await startServer({port:0,configFile,quiet:true});
  const base=`http://127.0.0.1:${server.port}`,get=async p=>(await fetch(base+p)).json(),post=async(p,body)=>{const response=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const wait=async id=>{for(let n=0;n<250;n++){const job=await get('/api/jobs/'+id);if(['done','failed','needs_review','cancelled'].includes(job.status))return job;await pause(10);}throw new Error('job did not converge');};
  try {
    const listed=await post('/api/subtitles/candidates',{file:x.file});assert.equal(listed.status,200);assert.ok(listed.body.candidates.length);
    const candidate=listed.body.candidates[0];assert.equal((await post('/api/subtitles/apply',{file:other,candidate})).status,409);
    x.state.correct(x.file,{maker:{value:'Revision change',locked:true}},0);assert.equal((await post('/api/subtitles/apply',{file:x.file,candidate})).status,409);
    const fresh=await post('/api/subtitles/candidates',{file:x.file});const installed=await post('/api/subtitles/apply',{file:x.file,candidate:fresh.body.candidates[0]});assert.equal(installed.status,200,JSON.stringify(installed.body));assert.equal(await fs.readFile(x.file.replace('.mp4','.srt'),'utf8'),srt);
    const options={only:[x.file,other],force:true,downloadSubs:false,workflow:{covers:false,extraSubtitles:false}};
    let created=await post('/api/jobs',{kind:'plan',dir:x.videos,options});assert.equal(created.status,202);let job=await wait(created.body.jobId);assert.equal(job.status,'done',job.error);const report=await get('/api/jobs/'+job.id+'/report');
    const disk=JSON.parse(await fs.readFile(path.join(x.data,'jobs',job.id+'.json'),'utf8'));assert.equal(disk.status,'done');assert.ok(disk.seq>0);assert.equal(disk.reportJson,job.reportJson);assert.deepEqual(JSON.parse(await fs.readFile(job.reportJson,'utf8')).summary,job.summary);
    created=await post('/api/jobs',{kind:'apply',dir:x.videos,options:{...options,only:[x.file],requirePlan:true,planId:report.planId,planRevision:0}});assert.equal((await wait(created.body.jobId)).status,'needs_review');assert.equal(JSON.parse(await fs.readFile(path.join(x.data,'plans',report.planId+'.json'),'utf8')).state,'preview');assert.equal(await fs.readFile(other,'utf8'),'CCCC');
    created=await post('/api/jobs',{kind:'apply',dir:x.videos,options:{...options,requirePlan:true,planId:report.planId,planRevision:0}});job=await wait(created.body.jobId);assert.equal(job.status,'done',job.error);assert.equal((await get('/api/jobs/'+job.id+'/report')).results.length,2);
    x.state.close();const recovery=await post('/api/restore',{recover:true});assert.equal(recovery.status,200);assert.equal(recovery.body.reason,'no_pending_restore');
    const a=server.close(),b=server.close();assert.equal(a,b);await a;
    const before=(await fs.stat(path.join(x.data,'jobs',job.id+'.json'))).mtimeMs;await pause(30);assert.equal((await fs.stat(path.join(x.data,'jobs',job.id+'.json'))).mtimeMs,before);
  }finally{await server.close();x.state.close();}
});
