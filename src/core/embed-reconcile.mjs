import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeJsonDurable} from './durable.mjs';
import {fileEvidence,sameEvidence} from './file-operations.mjs';
import {updateJournal} from './journal.mjs';

export async function prepareEmbed({dataDir,journal,media,record}) {
  const old=await fileEvidence(media,{content:true});
  if(record.source_id!==old.identity)throw Object.assign(new Error('media identity changed'),{code:'NEEDS_REVIEW'});
  const operationId=randomUUID(),file=path.join(dataDir,`.identity-pending-${operationId}.json`);
  const intent={type:'embed-replace',version:1,operationId,media:path.resolve(media),journal:path.resolve(journal),recordId:record.id,oldIdentity:old.identity,old,phase:'prepared',output:null};
  await writeJsonDurable(file,intent,{create:true});
  await saveEmbedJournal(intent);
  return {
    intent,file,
    async beforePublish({outputEvidence}) {
      if(!sameEvidence(await fileEvidence(media,{content:true}),old))throw Object.assign(new Error('media changed before replacement'),{code:'NEEDS_REVIEW'});
      intent.phase='ready';intent.output=outputEvidence;
      await writeJsonDurable(file,intent);await saveEmbedJournal(intent);
    },
  };
}
async function saveEmbedJournal(intent,output=null) {
  return updateJournal(intent.journal,data=>{
    const item=[...data.items].reverse().find(i=>path.resolve(i.to)===intent.media&&!i.undo?.complete);
    if(!item)throw new Error('embed_journal_entry_missing');
    item.embed=structuredClone(intent);
    if(output){item.output=output;item.embed.phase='committed';item.retainedEffects=[...new Set([...(item.retainedEffects||[]),'embedded_cover'])];}
  });
}
export async function reconcileEmbeds(dataDir,state) {
  const names=await fs.readdir(dataDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for(const name of names.filter(n=>/^\.identity-pending-[a-f0-9-]{36}\.json$/.test(n))) {
    const file=path.join(dataDir,name),intent=JSON.parse(await fs.readFile(file,'utf8'));
    if(intent.type!=='embed-replace'||intent.version!==1||path.dirname(intent.journal)!==path.resolve(dataDir))throw new Error('embed_intent_invalid');
    const current=await fileEvidence(intent.media,{content:true});
    if(sameEvidence(current,intent.old)) {
      intent.phase='cancelled';await saveEmbedJournal(intent);await fs.unlink(file);continue;
    }
    if(!intent.output||!sameEvidence(current,intent.output))throw Object.assign(new Error('embedding requires identity review'),{code:'EMBED_RECONCILE_PENDING',intent:file});
    state.replaceRecordIdentity({recordId:intent.recordId,filePath:intent.media,oldIdentity:intent.oldIdentity,newIdentity:current.identity,operationId:intent.operationId});
    await saveEmbedJournal(intent,current);
    await fs.unlink(file);
  }
}
