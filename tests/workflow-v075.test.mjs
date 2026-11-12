import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openState} from '../src/core/state.mjs';
import {createOperationPlan,validatePlan,resolveConflicts,diskAssets,reportHTML,effectiveMetadata} from '../src/core/workflow.mjs';
import {ensureJournalEntry,annotateJournal,undoJournal,applyRenames,backupFile} from '../src/core/rename.mjs';
import {createSubtitleCatalog} from '../src/subs/manual.mjs';
import {createContext,processFile,runDirectory} from '../src/pipeline.mjs';
import {createBackup,restoreBackup} from '../src/core/backup.mjs';
import {startServer} from '../src/server.mjs';
import {requestJson,waitForJob} from './helpers/job-lifecycle.mjs';

const srt='1\n00:00:01,000 --> 00:00:04,000\n这是一个测试，我们说话\n\n2\n00:00:05,000 --> 00:00:08,000\n这些时间请认真看\n';
async function setup(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'avc-075-'));const videos=path.join(root,'videos');await fs.mkdir(videos);const file=path.join(videos,'IPX-920.mp4');await fs.writeFile(file,'test-video');const config={paths:{dataDir:path.join(root,'data')},scan:{videoExtensions:['.mp4']},rename:{template:'{code} {title}'},network:{proxy:'',defaultRoute:'direct',timeoutMs:300,retry:0,minIntervalMs:0},media:{probeDuration:'off'},metadata:{r18:false},subs:{sources:['local'],localDirs:[root],extraLangs:[],fit:{mode:'none'}},covers:{download:false,embed:false},fs:{enabled:true,allowedRoots:[root]}};const state=openState(path.join(config.paths.dataDir,'state.db'));t.after(async()=>{state.close();await fs.rm(root,{recursive:true,force:true});});return {root,videos,file,config,state};}
function report(file,to=file){return {dir:path.dirname(file),startedAt:Date.now(),apply:false,summary:{ok:1},results:[{file:to,originalFile:file,name:path.basename(file),code:'IPX-920',status:'ok',meta:{titleJa:'Source title',maker:'Maker',actress:['A'],releaseDate:'2026-01-01'},rename:{from:file,to,action:to===file?'skip_same':'rename'}}]};}

test('corrections survive reset/reopen and are isolated by record; intentional empty locks are respected',async t=>{
 const {state,file,root}=await setup(t),r=state.record(file);state.correct(file,{titleJa:{value:'',locked:true},maker:{value:'Custom',locked:true}},r.revision);
 assert.equal(effectiveMetadata({titleJa:'Source'},null,state.record(file).fields).titleJa,'');state.resetFile(file);assert.equal(state.record(file).fields.maker.value,'Custom');
 const other=path.join(root,'IPX-920.mp4');assert.notEqual(state.record(other).id,r.id);assert.deepEqual(state.record(other).fields,{});
 const renamed=path.join(root,'new.mp4');state.moveRecord(file,renamed);assert.equal(state.record(renamed).id,r.id);state.moveRecord(renamed,file);assert.equal(state.record(file).fields.maker.value,'Custom');
 assert.equal(state.correctionHistory(file).length,1);assert.throws(()=>state.correct(file,{},0),/revision_changed/);
});
test('external replacement at the same path receives a new identity and no old locks',async t=>{
 const {state,file,root}=await setup(t),old=state.record(file);state.correct(file,{maker:{value:'Old lock',locked:true}},0);
 await fs.rename(file,path.join(root,'external-move.mp4'));await fs.writeFile(file,'different-video');const next=state.record(file);assert.notEqual(next.id,old.id);assert.deepEqual(next.fields,{});
});
test('correction validation rejects malformed dates and unsafe cover URLs',async t=>{
 const {state,file}=await setup(t);
 for(const value of ['2026-02-30','2026-13-01','yesterday'])assert.throws(()=>state.correct(file,{releaseDate:{value,locked:true}},0),/invalid_date/);
 for(const value of ['javascript:alert(1)','file:///C:/private.jpg','https://user:secret@example.test/cover'])assert.throws(()=>state.correct(file,{coverUrl:{value,locked:true}},0),/invalid_cover_url/);
 assert.equal(state.record(file).revision,0);state.correct(file,{releaseDate:{value:'2026-11-09',locked:true},coverUrl:{value:'https://example.test/cover.jpg',locked:true}},0);
 assert.equal(state.record(file).revision,1);
});
test('missing-only optional rename copies valid sidecars without network and undo keeps originals',async t=>{
 const {file,state,config}=await setup(t);const subtitle=file.replace('.mp4','.srt'),cover=file.replace('.mp4','.jpg'),english=file.replace('.mp4','.en.srt');
 await fs.writeFile(subtitle,srt);await fs.writeFile(english,srt);await fs.writeFile(cover,Buffer.from([255,216,255,1,2]));config.subs.extraLangs=['en'];
 state.upsertFile(file,{code:'IPX-920',data:{meta:{titleJa:'Existing title',actress:['A'],releaseDate:'2026-01-01',maker:'M'}}});
 const ctx=createContext(config,{state,logger:()=>{}});ctx.javbus.search=async()=>{throw new Error('must not resolve complete metadata');};ctx.http.getFollow=async()=>{throw new Error('must not download valid sidecars');};
 const r=await processFile(ctx,{path:file,name:path.basename(file),size:10},{apply:true,workflow:{mode:'missing',rename:true}});
 assert.ok(r.renamedTo);assert.equal(await fs.readFile(r.renamedTo.replace('.mp4','.srt'),'utf8'),srt);assert.equal(await fs.readFile(r.renamedTo.replace('.mp4','.en.srt'),'utf8'),srt);assert.ok(await fs.stat(r.cover.path));
 assert.equal(r.actions.metadata,'preserved');const undone=await undoJournal(r.journal);assert.equal(undone.failed.length,0);assert.equal(await fs.readFile(subtitle,'utf8'),srt);assert.ok(await fs.stat(cover));assert.ok(await fs.stat(file));
});
test('failed subtitle write retains the real rename, journal and transferred field locks in the report',async t=>{
 const {file,state,config}=await setup(t),target=file.replace('.mp4',' Renamed.mp4');await fs.mkdir(target.replace('.mp4','.srt'));
 state.correct(file,{maker:{value:'Locked',locked:true}},0);const ctx=createContext(config,{state,logger:()=>{}});
 const confirmed={code:'IPX-920',meta:{titleJa:'Frozen'},newName:path.basename(target),rename:{from:file,to:target,action:'rename'},_selectedSubtitle:true,_subtitle:{base64:Buffer.from(srt).toString('base64'),source:'local',bytes:Buffer.byteLength(srt),check:{ok:true,cues:2}}};
 const result=await processFile(ctx,{path:file,name:path.basename(file),size:10},{apply:true,confirmed,workflow:{covers:false,extraSubtitles:false}});
 assert.equal(result.status,'error');assert.equal(result.renamedTo,target);assert.ok(result.journal);assert.ok(await fs.stat(target));assert.equal(state.record(target).fields.maker.value,'Locked');assert.equal(result.actions.subtitles,'failed');
});
test('explicit empty selection never expands to folder contents or manual overrides',async t=>{
 const {file,videos,config}=await setup(t);const result=await runDirectory({dir:videos,config,only:[],overrides:{[file]:'IPX-920'},logger:()=>{}});assert.equal(result.count,0);
});
test('data backup and restore includes confirmed plans together with correction state',async t=>{
 const {file,state,config,root}=await setup(t);state.correct(file,{maker:{value:'Custom',locked:true}},0);const plan=await createOperationPlan(report(file),config,state,{});
 const backup=await createBackup({dataDir:config.paths.dataDir,destRoot:path.join(root,'backups')});assert.ok(await fs.stat(path.join(backup.path,'plans',plan.id+'.json')));
 const restored=path.join(root,'restored');await restoreBackup({backupDir:backup.path,dataDir:restored});assert.ok(await fs.stat(path.join(restored,'plans',plan.id+'.json')));const db=openState(path.join(restored,'state.db'));try{assert.equal(db.record(file).fields.maker.value,'Custom');}finally{db.close();}
});
test('confirmed plans reject source mutations, changed corrections and occupied targets before writes',async t=>{
 const {file,state,config}=await setup(t),rep=report(file,file.replace('.mp4',' new.mp4')),p=await createOperationPlan(rep,config,state,{});await validatePlan(p,state);
 await fs.writeFile(rep.results[0].rename.to,'occupied');await assert.rejects(()=>validatePlan(p,state),e=>e.reasons.some(r=>r.reason==='target_changed'));await fs.rm(rep.results[0].rename.to);
 state.correct(file,{maker:{value:'X',locked:true}},0);await assert.rejects(()=>validatePlan(p,state),e=>e.reasons.some(r=>r.reason==='correction_changed'));
 const fresh=await createOperationPlan(report(file),config,state,{});await fs.appendFile(file,'changed');await assert.rejects(()=>validatePlan(fresh,state),e=>e.reasons.some(r=>r.reason==='source_changed'));
});
test('batch conflict strategies reserve sidecars and suffixes; malformed Windows names never apply',async t=>{
 const {file,videos,state,config}=await setup(t),other=path.join(videos,'IPX-921.mp4');await fs.writeFile(other,'other');const target=path.join(videos,'Combined.mp4');
 const rep=report(file,target);rep.results.push({...rep.results[0],originalFile:other,name:'IPX-921.mp4',rename:{from:other,to:target,action:'rename'}});
 const p=await createOperationPlan(rep,config,state,{});assert.ok(p.entries.every(e=>e.result.rename.batchConflict));await assert.rejects(()=>validatePlan(p,state));
 await resolveConflicts(p,{[file]:{strategy:'suffix'},[other]:{strategy:'suffix'}});assert.notEqual(p.entries[0].result.rename.to.toLowerCase(),p.entries[1].result.rename.to.toLowerCase());await validatePlan(p,state);
 const invalid=await createOperationPlan(report(file),config,state,{});await assert.rejects(()=>resolveConflicts(invalid,{[file]:{strategy:'custom',name:'CON.mp4'}}),/invalid_windows_name/);
});
test('rename refuses occupied targets even after preview (never overwrites)',async t=>{const {file,root,config}=await setup(t),target=path.join(root,'occupied.mp4');await fs.writeFile(target,'keep');await assert.rejects(()=>applyRenames([{from:file,to:target,action:'rename'}],{dataDir:config.paths.dataDir}),/target_occupied/);assert.equal(await fs.readFile(target,'utf8'),'keep');});
test('standalone sidecar undo restores backups while keeping video and corrections',async t=>{
 const {file,state,root}=await setup(t),sub=file.replace('.mp4','.srt'),journal=path.join(root,'journal.json');await fs.writeFile(sub,'original');await ensureJournalEntry(journal,file);const backup=await backupFile(sub);await fs.writeFile(sub,srt);await annotateJournal(journal,file,{srt:sub,srtBackup:backup});state.correct(file,{maker:{value:'Locked',locked:true}},0);
 const result=await undoJournal(journal);assert.equal(result.failed.length,0);assert.equal(await fs.readFile(sub,'utf8'),'original');assert.equal(await fs.readFile(file,'utf8'),'test-video');assert.equal(state.record(file).fields.maker.value,'Locked');
});
test('missing-only second apply preserves valid subtitle/image and produces no sidecar journal',async t=>{
 const {file,state,config}=await setup(t),sub=file.replace('.mp4','.srt'),cover=file.replace('.mp4','.jpg');await fs.writeFile(sub,srt);await fs.writeFile(cover,Buffer.from([255,216,255,1,2]));state.putCode('IPX-920',{meta:{titleJa:'Source',maker:'Maker',actress:[],coverUrl:'https://invalid.test/cover.jpg'}});state.upsertFile(file,{data:{meta:{titleJa:'Existing title'}}});
 const ctx=createContext(config,{state,logger:()=>{}});ctx.http.getFollow=async()=>{throw new Error('must not download');};const f={path:file,name:path.basename(file),size:10};
 const a=await processFile(ctx,f,{apply:true,workflow:{mode:'missing'}}),b=await processFile(ctx,f,{apply:true,workflow:{mode:'missing'}});assert.equal(a.meta.titleJa,'Existing title');assert.equal(b.sub.source,'existing');assert.equal(b.cover.preserved,true);assert.equal(b.renamedTo,undefined);assert.equal(b.journal,undefined);assert.equal((await diskAssets(file)).cover.path,cover);
});
test('confirmed apply installs cached chosen subtitles without refetching metadata or candidates',async t=>{
 const {file,state,config}=await setup(t),ctx=createContext(config,{state,logger:()=>{}});ctx.javbus.search=async()=>{throw new Error('must not resolve');};const chosen={code:'IPX-920',meta:{titleJa:'Frozen title'},rename:{from:file,to:file,action:'skip_same'},_selectedSubtitle:true,_subtitle:{base64:Buffer.from(srt).toString('base64'),source:'local',bytes:Buffer.byteLength(srt),check:{ok:true,cues:2,verdict:'zh-CN'}}};
 const r=await processFile(ctx,{path:file,name:path.basename(file),size:10},{apply:true,confirmed:chosen,workflow:{extraSubtitles:false}});assert.equal(r.meta.titleJa,'Frozen title');assert.equal(await fs.readFile(file.replace('.mp4','.srt'),'utf8'),srt);assert.ok(r.journal);
});
test('candidate analysis shares time window, returns unknown coverage without duration, writes no media files',async t=>{
 const {file,root,videos,config}=await setup(t),candidatePath=path.join(root,'IPX-920.srt');await fs.writeFile(candidatePath,srt);const catalog=createSubtitleCatalog({config,http:{getFollow:async()=>{throw new Error('network');}}});const r=await catalog.analyze({candidate:{source:'local',localPath:candidatePath,lang:'zh'},startSec:4});assert.equal(r.coverage,null);assert.equal(r.cues,2);assert.equal(r.original.length,2);assert.deepEqual(await fs.readdir(videos),[path.basename(file)]);
});
test('offline report escapes untrusted names, distinguishes preview from actual and does not infer writes',()=>{
 const rep=report('C:/<script>alert(1)</script>.mp4');rep.apply=true;rep.results[0].coverPlanned={targetPath:'planned.jpg'};const html=reportHTML(rep);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('未记录写入'));assert.ok(!html.includes('planned.jpg'));assert.ok(!html.includes('src="http'));
});
test('server plan/apply freezes chosen metadata, rejects stale revisions, and exports actual readable reports',async t=>{
 const {root,file,videos,config,state}=await setup(t);state.putCode('IPX-920',{meta:{titleJa:'Frozen',maker:'M',actress:['A'],releaseDate:'2026-01-01'}});const configFile=path.join(root,'config.json');await fs.writeFile(configFile,JSON.stringify(config));const srv=await startServer({port:0,configFile,quiet:true});
 const base=`http://127.0.0.1:${srv.port}`,get=p=>requestJson(base,p);
 const post=(p,body)=>requestJson(base,p,{method:'POST',body,status:202});
 const wait=id=>waitForJob(base,id);
 try {
  let job=await post('/api/jobs',{kind:'plan',dir:videos,options:{only:[file],force:true,downloadSubs:false,workflow:{covers:false,extraSubtitles:false}}});assert.equal((await wait(job.jobId)).status,'done');let rep=await get('/api/jobs/'+job.jobId+'/report');assert.ok(rep.planId);
  state.correct(file,{maker:{value:'New maker',locked:true}},0);job=await post('/api/jobs',{kind:'apply',dir:videos,options:{only:[file],force:true,downloadSubs:false,workflow:{covers:false,extraSubtitles:false},requirePlan:true,planId:rep.planId,planRevision:0}});assert.equal((await wait(job.jobId)).status,'needs_review');assert.ok(await fs.stat(file));
  job=await post('/api/jobs',{kind:'plan',dir:videos,options:{only:[file],force:true,downloadSubs:false,workflow:{covers:false,extraSubtitles:false}}});assert.equal((await wait(job.jobId)).status,'done');rep=await get('/api/jobs/'+job.jobId+'/report');state.putCode('IPX-920',{meta:{titleJa:'Must not replace plan'}});
  job=await post('/api/jobs',{kind:'apply',dir:videos,options:{only:[file],force:true,downloadSubs:false,workflow:{covers:false,extraSubtitles:false},requirePlan:true,planId:rep.planId,planRevision:0}});const applied=await wait(job.jobId);assert.equal(applied.status,'done',applied.error);const result=await get('/api/jobs/'+job.jobId+'/report');assert.equal(result.results[0].meta.titleJa,'Frozen');assert.ok(result.results[0].renamedTo);assert.equal(state.record(result.results[0].renamedTo).fields.maker.value,'New maker');const html=await (await fetch(`http://127.0.0.1:${srv.port}/api/jobs/${job.jobId}/html?lang=en`)).text();assert.ok(html.includes('Execution report'));assert.ok(html.includes('Frozen'));
 } finally {await srv.close();}
});
