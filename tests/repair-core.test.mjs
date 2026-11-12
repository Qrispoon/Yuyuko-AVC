// Capability preflight: ordinary synthetic files + dedicated SQLite only. No network,
// links/junction experiments, child process, real data, or destructive cleanup.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {moveNoReplace,fileEvidence,convergeMove} from '../src/core/file-operations.mjs';
import {applyRenames,ensureJournalEntry,writeJournalSidecar,undoJournal,readJournal,updateJournal} from '../src/core/journal.mjs';
import {withMutation} from '../src/core/mutations.mjs';
import {openState} from '../src/core/state.mjs';
import {createBackup,restoreBackup} from '../src/core/backup.mjs';
import {installSubtitle,installSubtitleAs} from '../src/subs/install.mjs';

const root=path.resolve('tmp/repair-2026-11-11-3e77b77c/fixtures',`core-${randomUUID()}`);
async function fixture(){const dir=path.join(root,randomUUID());await fs.mkdir(dir,{recursive:true});return dir;}
const absent=async p=>{await assert.rejects(fs.stat(p),{code:'ENOENT'});};
const srt='1\n00:00:00,000 --> 00:00:02,000\n这是测试\n';

test('R02 normal no-replace move converges; occupied target preserves both bytes',async()=>{
  const dir=await fixture(),a=path.join(dir,'a'),b=path.join(dir,'b');
  await fs.writeFile(a,'owned');await moveNoReplace(a,b);await absent(a);assert.equal(await fs.readFile(b,'utf8'),'owned');
  await fs.writeFile(a,'new source');await assert.rejects(moveNoReplace(a,b),{code:'NEEDS_REVIEW'});
  assert.equal(await fs.readFile(a,'utf8'),'new source');assert.equal(await fs.readFile(b,'utf8'),'owned');
});
test('R02/R03 publication interrupted after link has recoverable evidence and convergence',async()=>{
  const dir=await fixture(),a=path.join(dir,'a'),b=path.join(dir,'b');await fs.writeFile(a,'same');const expected=await fileEvidence(a);
  await assert.rejects(moveNoReplace(a,b,{onPhase:async phase=>{if(phase==='published_dual')throw new Error('synthetic persistence failure');}}));
  assert.equal((await fileEvidence(a)).identity,(await fileEvidence(b)).identity);
  await convergeMove(a,b,{expected});await absent(a);assert.equal(await fs.readFile(b,'utf8'),'same');
});
test('R01 typed undo restores sidecar once; repeated undo preserves a later user sidecar',async()=>{
  const dir=await fixture(),a=path.join(dir,'a.mp4'),b=path.join(dir,'b.mp4'),target=path.join(dir,'b.srt');
  await fs.writeFile(a,'video');await fs.writeFile(target,'old subtitle');
  const {journal}=await applyRenames([{from:a,to:b,action:'rename'}],{dataDir:dir});
  await writeJournalSidecar(journal,b,target,Buffer.from('new subtitle'));
  const first=await undoJournal(journal);assert.equal(first.undoComplete,true);assert.equal(await fs.readFile(target,'utf8'),'old subtitle');assert.equal(await fs.readFile(a,'utf8'),'video');await absent(b);
  await fs.writeFile(target,'later user edit');const second=await undoJournal(journal);assert.equal(second.undoComplete,true);assert.equal(await fs.readFile(target,'utf8'),'later user edit');
});
test('R01 modified same-length sidecar is retained with conflict',async()=>{
  const dir=await fixture(),media=path.join(dir,'a.mp4'),target=path.join(dir,'a.srt'),journal=path.join(dir,'journal.json');await fs.writeFile(media,'media');
  await ensureJournalEntry(journal,media);await writeJournalSidecar(journal,media,target,'AAAA');await fs.writeFile(target,'BBBB');
  const result=await undoJournal(journal);assert.equal(result.undoComplete,false);assert.match(result.failed[0].reason,/sidecar_changed/);assert.equal(await fs.readFile(target,'utf8'),'BBBB');
});
test('R01 legacy missing evidence never deletes user files',async()=>{
  const dir=await fixture(),target=path.join(dir,'user.srt'),journal=path.join(dir,'old.json');await fs.writeFile(target,'user');await fs.writeFile(journal,JSON.stringify({version:1,items:[{to:'missing',srt:target}]}));
  assert.equal((await undoJournal(journal)).failed[0].reason,'legacy_unverifiable');assert.equal(await fs.readFile(target,'utf8'),'user');
});
test('R01 Windows case-only undo restores original spelling',async()=>{
  const dir=await fixture(),a=path.join(dir,'Original.mp4'),b=path.join(dir,'original.mp4');await fs.writeFile(a,'case media');
  const {journal}=await applyRenames([{from:a,to:b,action:'rename'}],{dataDir:dir});assert.ok((await fs.readdir(dir)).includes('original.mp4'));
  assert.equal((await undoJournal(journal)).undoComplete,true);assert.ok((await fs.readdir(dir)).includes('Original.mp4'));
});
test('R03 corrupt journal blocks effects and concurrent updates keep every entry',async()=>{
  const dir=await fixture(),a=path.join(dir,'a'),b=path.join(dir,'b'),journal=path.join(dir,'journal.json');await fs.writeFile(a,'source');await fs.writeFile(journal,'{');
  await assert.rejects(applyRenames([{from:a,to:b,action:'rename'}],{dataDir:dir,journalFile:journal}));assert.equal(await fs.readFile(a,'utf8'),'source');await absent(b);
  const good=path.join(dir,'good.json');await updateJournal(good,d=>{}, {create:true});await Promise.all(Array.from({length:10},(_,n)=>updateJournal(good,d=>d.items.push({n}))));assert.equal((await readJournal(good)).items.length,10);
});
test('R06 competing owner rejects while same owner can reenter, then releases',async()=>{
  const dir=await fixture();let release,started;const ready=new Promise(r=>started=r);const hold=withMutation(dir,async()=>{await withMutation(dir,async()=>{});started();await new Promise(r=>release=r);});await ready;
  await assert.rejects(withMutation(dir,async()=>{}),{code:'MUTATION_LOCKED'});release();await hold;await withMutation(dir,async()=>{});await absent(path.join(dir,'.mutator-lease.json'));
});
test('R15 WAL snapshot is standalone, default skips generation, force preserves old generation',async()=>{
  const dir=await fixture(),data=path.join(dir,'data'),restored=path.join(dir,'restored');const state=openState(path.join(data,'state.db'));
  try {
    state.upsertFile('synthetic',{status:'ok',data:{value:'snapshot'}});await fs.writeFile(path.join(data,'journal-owned.json'),'old generation');
    const backup=await createBackup({dataDir:data});assert.ok(!(await fs.readdir(backup.path)).some(n=>/-wal|-shm/.test(n)));
    await restoreBackup({backupDir:backup.path,dataDir:restored});let copy=openState(path.join(restored,'state.db'));try{assert.equal(copy.getFile('synthetic').data.value,'snapshot');copy.upsertFile('target-only',{status:'ok'});}finally{copy.close();}
    await fs.writeFile(path.join(restored,'journal-owned.json'),'target generation');
    const skipped=await restoreBackup({backupDir:backup.path,dataDir:restored});assert.equal(skipped.copied,0);assert.equal(await fs.readFile(path.join(restored,'journal-owned.json'),'utf8'),'target generation');
    const forced=await restoreBackup({backupDir:backup.path,dataDir:restored,force:true});assert.equal(await fs.readFile(path.join(forced.retained,'old','journal-owned.json'),'utf8'),'target generation');
    copy=openState(path.join(restored,'state.db'));try{assert.equal(copy.getFile('target-only'),null);assert.equal(copy.getFile('synthetic').status,'ok');}finally{copy.close();}
  }finally{state.close();}
});
test('R15 active registered connection prevents force switch',async()=>{
  const dir=await fixture(),data=path.join(dir,'data');const state=openState(path.join(data,'state.db'));
  try{const b=await createBackup({dataDir:data});await assert.rejects(restoreBackup({backupDir:b.path,dataDir:data,force:true}),{code:'DATABASE_IN_USE'});}finally{state.close();}
});
test('R19 final malformed or reversed subtitle rejects before journal backup for every language',async()=>{
  const dir=await fixture(),media=path.join(dir,'a.mp4'),target=path.join(dir,'a.srt'),journal=path.join(dir,'journal.json');await fs.writeFile(media,'video');await fs.writeFile(target,'user subtitle');await ensureJournalEntry(journal,media);
  for(const lang of ['zh','zh-TW','en','ko'])for(const text of ['bad text','1\n00:00:05,000 --> 00:00:02,000\nx\n','1\n00:61:00,000 --> 01:02:00,000\nx\n'])await assert.rejects(lang==='zh'?installSubtitle(media,text,{journal}):installSubtitleAs(media,text,lang,{journal}),{code:'INVALID_SUBTITLE_TIMING'});
  assert.equal(await fs.readFile(target,'utf8'),'user subtitle');assert.equal((await readJournal(journal)).items[0].sidecars.length,0);
  await installSubtitle(media,srt,{journal});assert.equal(await fs.readFile(target,'utf8'),srt);
});
