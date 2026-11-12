import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { writeJsonDurable } from './durable.mjs';
import { withMutation } from './mutations.mjs';
import { stateConnectionCount, SCHEMA_VERSION } from './state.mjs';
import { moveNoReplace,convergeMove,fileEvidence } from './file-operations.mjs';

const DB_NAMES = ['state.db', 'state.db-wal', 'state.db-shm'];
const FOLDERS = ['jobs', 'plans', 'assembly'];
const managed = rel => !path.isAbsolute(rel) && !rel.split(/[\\/]/).some(p => !p || p === '..' || p === '.') && (DB_NAMES.includes(rel) || /^(journal-|run-)[^/\\]+\.json$/i.test(rel) || FOLDERS.includes(rel.split('/')[0]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async p => { try { return await fs.lstat(p); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } };
const err = (code, message = code) => Object.assign(new Error(message), {code});

export async function listFilesRelative(dir) {
  const out = [];
  async function walk(current, prefix) {
    for(const entry of await fs.readdir(current, {withFileTypes:true})) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if(entry.isSymbolicLink()) throw err('BACKUP_LINK_UNSUPPORTED');
      if(entry.isDirectory()) await walk(path.join(current,entry.name),rel);
      else if(entry.isFile()) out.push(rel);
      else throw err('BACKUP_FILE_UNSUPPORTED');
    }
  }
  await walk(path.resolve(dir),'');
  return out.sort();
}
export function uniquePath(base) { let target=base; for(let n=2;fsSync.existsSync(target);n++)target=`${base}-${n}`; return target; }
async function managedRoots(root) {
  return (await fs.readdir(root,{withFileTypes:true})).filter(e=>DB_NAMES.includes(e.name)||FOLDERS.includes(e.name)||/^(journal-|run-).*\.json$/i.test(e.name)).map(e=>e.name).sort();
}
async function managedFiles(root) {
  const out=[];
  for(const rel of await managedRoots(root)) {
    const st=await fs.lstat(path.join(root,rel));
    if(st.isSymbolicLink())throw err('BACKUP_LINK_UNSUPPORTED');
    if(st.isDirectory() && FOLDERS.includes(rel)) out.push(...(await listFilesRelative(path.join(root,rel))).map(p=>`${rel}/${p}`));
    else if(st.isFile())out.push(rel);
    else throw err('BACKUP_FILE_UNSUPPORTED');
  }
  return out.sort();
}
async function copySynced(from,to) {
  await fs.mkdir(path.dirname(to),{recursive:true});
  const h=await fs.open(to,'wx');
  try { await h.writeFile(await fs.readFile(from)); await h.sync(); } finally {await h.close();}
}
function validateDb(file) {
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const check=db.prepare('PRAGMA integrity_check').all();
    if(check.length!==1 || Object.values(check[0])[0]!=='ok')throw err('BACKUP_DB_INVALID');
    const schema=Number(db.prepare('PRAGMA user_version').get().user_version);
    if(schema>SCHEMA_VERSION)throw err('BACKUP_SCHEMA_UNSUPPORTED');
    return schema;
  } finally {db.close();}
}
async function fingerprints(root,files) {return Promise.all(files.map(async rel=>({path:rel,sha256:hash(await fs.readFile(path.join(root,rel)))})));}
async function validateBackup(source) {
  if(!(await exists(source))?.isDirectory())throw err('BACKUP_DIR_NOT_FOUND');
  if((await fs.readdir(source)).some(n=>/^\.identity-pending-/.test(n)))throw err('EMBED_RECONCILE_PENDING');
  if(!(await exists(path.join(source,'state.db')))?.isFile())throw err('INVALID_BACKUP','state.db missing');
  const files=await managedFiles(source);
  const raw=await fs.readFile(path.join(source,'BACKUP_MANIFEST.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(raw) {
    const manifest=JSON.parse(raw);
    if(manifest.type!=='avc-data-backup'||manifest.version!==2||!Array.isArray(manifest.files))throw err('INVALID_BACKUP_MANIFEST');
    const names=manifest.files.map(f=>f.path).sort();
    if(new Set(names).size!==names.length || names.some(p=>!managed(p)||DB_NAMES.slice(1).includes(p)) || JSON.stringify(names)!==JSON.stringify(files))throw err('INVALID_BACKUP_MANIFEST');
    for(const entry of manifest.files)if(hash(await fs.readFile(path.join(source,entry.path)))!==entry.sha256)throw err('BACKUP_HASH_MISMATCH');
  } else if(files.some(p=>DB_NAMES.slice(1).includes(p)))throw err('BACKUP_CONSISTENCY_UNVERIFIABLE');
  return {files,schema:validateDb(path.join(source,'state.db'))};
}
export async function createBackup({dataDir='data',destRoot,name}={}) {
  const source=path.resolve(dataDir);
  return withMutation(source,async()=>{
    if(await exists(path.join(source,'.restore-intent.json')))throw err('RESTORE_PENDING');
    if((await fs.readdir(source)).some(n=>/^\.identity-pending-/.test(n)))throw err('EMBED_RECONCILE_PENDING');
    if(!(await exists(path.join(source,'state.db')))?.isFile())throw err('DATA_DIR_NOT_FOUND');
    const root=path.resolve(destRoot||path.join(source,'backups'));
    await fs.mkdir(root,{recursive:true});
    if(name && (path.basename(name)!==name || name==='.' || name==='..'))throw err('INVALID_BACKUP_NAME');
    let target;
    for(let n=1;;n++) {target=path.join(root,`${name||`avc-backup-${Date.now()}`}${n===1?'':`-${n}`}`);try{await fs.mkdir(target);break;}catch(e){if(e.code!=='EEXIST')throw e;}}
    const db=new DatabaseSync(path.join(source,'state.db'),{readOnly:true});
    try {db.exec(`VACUUM INTO '${path.join(target,'state.db').replace(/'/g,"''")}'`);} finally {db.close();}
    const schema=validateDb(path.join(target,'state.db'));
    const h=await fs.open(path.join(target,'state.db'),'r+');try{await h.sync();}finally{await h.close();}
    for(const rel of await managedFiles(source))if(!DB_NAMES.includes(rel))await copySynced(path.join(source,rel),path.join(target,rel));
    const files=await managedFiles(target);
    await writeJsonDurable(path.join(target,'BACKUP_MANIFEST.json'),{type:'avc-data-backup',version:2,epoch:randomUUID(),createdAt:new Date().toISOString(),schema,files:await fingerprints(target,files)},{create:true});
    return {path:target,files:files.length};
  });
}
function validateIntent(intent,target) {
  const work=path.resolve(intent.work||'');
  if(intent.type!=='avc-restore'||intent.version!==1||intent.target!==target||path.dirname(work)!==path.dirname(target)||!path.basename(work).startsWith('.avc-restore-')||!Array.isArray(intent.newFiles)||!Array.isArray(intent.oldRoots)||intent.newFiles.some(f=>!managed(f.path))||intent.oldRoots.some(p=>!managed(p)||p.includes('/')))throw err('RESTORE_INTENT_INVALID');
  return work;
}
async function noConnections(target){if(stateConnectionCount(path.join(target,'state.db')))throw err('DATABASE_IN_USE');}
export async function recoverRestore(dataDir) {
  const target=path.resolve(dataDir);
  return withMutation(target,async()=>{
    await noConnections(target);
    const intentFile=path.join(target,'.restore-intent.json');
    const raw=await fs.readFile(intentFile,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(!raw)return {recovered:false,reason:'no_pending_restore'};
    const intent=JSON.parse(raw),work=validateIntent(intent,target);
    if(intent.phase==='committed') {
      for(const entry of intent.newFiles)if(hash(await fs.readFile(path.join(target,entry.path)))!==entry.sha256)throw err('RESTORE_CONTENT_CHANGED');
      validateDb(path.join(target,'state.db'));await fs.unlink(intentFile);return {recovered:true,committed:true};
    }
    const archived=[];
    for(const root of intent.oldRoots)if(await exists(path.join(work,'old',root)))archived.push(root);
    for(const root of archived) {
      const st=await fs.lstat(path.join(work,'old',root));
      const files=st.isDirectory()?(await listFilesRelative(path.join(work,'old',root))).map(p=>`${root}/${p}`):[root];
      const expected=(intent.oldFiles||[]).filter(f=>f.path.split('/')[0]===root);
      if(JSON.stringify(files.sort())!==JSON.stringify(expected.map(f=>f.path).sort()))throw err('RESTORE_OLD_GENERATION_CHANGED');
      for(const entry of expected)if(hash(await fs.readFile(path.join(work,'old',entry.path)))!==entry.sha256)throw err('RESTORE_OLD_GENERATION_CHANGED');
    }
    for(const rel of await managedFiles(target)) {
      const root=rel.split('/')[0];
      if(intent.oldRoots.includes(root)&&!archived.includes(root))continue;
      const expected=intent.newFiles.find(f=>f.path===rel);
      if(!expected || hash(await fs.readFile(path.join(target,rel)))!==expected.sha256)throw err('RESTORE_CONTENT_CHANGED');
    }
    for(const rel of await managedFiles(target)) {
      const root=rel.split('/')[0];
      if(intent.oldRoots.includes(root)&&!archived.includes(root))continue;
      const from=path.join(target,rel),to=path.join(work,'new-retained',rel);
      await fs.mkdir(path.dirname(to),{recursive:true});await convergeMove(from,to,{expected:await fileEvidence(from,{content:true})});
    }
    async function removeEmpty(dir) {
      const st=await exists(dir);if(!st?.isDirectory())return;
      for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isDirectory())await removeEmpty(path.join(dir,e.name));else throw err('RESTORE_CONTENT_CHANGED');}
      await fs.rmdir(dir);
    }
    for(const root of archived) {
      const to=path.join(target,root);
      if((await exists(to))?.isDirectory())await removeEmpty(to);
      if(await exists(to))throw err('RESTORE_TARGET_OCCUPIED');
      await fs.rename(path.join(work,'old',root),to);
    }
    const receipt=path.join(work,'recovery-receipt.json');
    try{await writeJsonDurable(receipt,{epoch:intent.epoch,recoveredAt:new Date().toISOString(),mode:'rollback'},{create:true});}catch(e){if(e.code!=='EEXIST'||JSON.parse(await fs.readFile(receipt,'utf8')).epoch!==intent.epoch)throw e;}
    await fs.unlink(intentFile);
    return {recovered:true,committed:false,retained:work};
  });
}
export async function restoreBackup({backupDir,dataDir='data',force=false,recover=false,onPhase=async()=>{}}={}) {
  const target=path.resolve(dataDir);
  if(recover)return recoverRestore(target);
  const source=path.resolve(backupDir||'');
  return withMutation(target,async()=>{
    if(await exists(path.join(target,'.restore-intent.json')))throw err('RESTORE_PENDING');
    if((await fs.readdir(target)).some(n=>/^\.identity-pending-/.test(n)))throw err('EMBED_RECONCILE_PENDING');
    const {files}=await validateBackup(source);
    if(!force && (await Promise.all(DB_NAMES.map(p=>exists(path.join(target,p))))).some(Boolean))return {copied:0,skipped:files.length,generationSkipped:true};
    await noConnections(target);
    const work=path.join(path.dirname(target),`.avc-restore-${randomUUID()}`),stage=path.join(work,'stage');
    await fs.mkdir(stage,{recursive:true});
    for(const rel of files)await copySynced(path.join(source,rel),path.join(stage,rel));
    validateDb(path.join(stage,'state.db'));
    const intent={type:'avc-restore',version:1,epoch:randomUUID(),target,work,phase:'prepared',oldRoots:await managedRoots(target),oldFiles:await fingerprints(target,await managedFiles(target)),newFiles:await fingerprints(stage,files)};
    const intentFile=path.join(target,'.restore-intent.json');
    await writeJsonDurable(intentFile,intent,{create:true});
    try {
      await fs.mkdir(path.join(work,'old'),{recursive:true});
      for(const root of intent.oldRoots) {
        intent.step={kind:'archive',root};await writeJsonDurable(intentFile,intent);
        await fs.rename(path.join(target,root),path.join(work,'old',root));
        await onPhase('archived',{root});
      }
      intent.phase='installing';await writeJsonDurable(intentFile,intent);
      for(const rel of files) {
        intent.step={kind:'install',path:rel};await writeJsonDurable(intentFile,intent);
        const to=path.join(target,rel);await fs.mkdir(path.dirname(to),{recursive:true});await moveNoReplace(path.join(stage,rel),to);
        await onPhase('installed',{path:rel});
      }
      validateDb(path.join(target,'state.db'));
      intent.phase='committed';delete intent.step;await writeJsonDurable(intentFile,intent);
      await writeJsonDurable(path.join(work,'restore-receipt.json'),intent,{create:true});
      await fs.unlink(intentFile);
      return {copied:files.length,skipped:0,retained:work};
    } catch(e) {throw Object.assign(err('RESTORE_PENDING','restore interrupted; explicit recovery required'),{cause:e,intent:intentFile,retained:work});}
  });
}
export async function listBackups(dataDir) {
  const root=path.resolve(dataDir||'data','backups'),out=[];
  for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})) {
    if(!entry.isDirectory()||!/^avc-backup-/.test(entry.name))continue;
    const dir=path.join(root,entry.name),stat=await fs.stat(dir);
    out.push({dir,name:entry.name,files:(await listFilesRelative(dir)).length,createdAt:Math.round(stat.mtimeMs)});
  }
  return out.sort((a,b)=>b.createdAt-a.createdAt).slice(0,20);
}
export default {createBackup,restoreBackup,recoverRestore,listBackups,listFilesRelative,uniquePath};
