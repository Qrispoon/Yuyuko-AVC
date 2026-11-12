import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {probe,subtitleText,inspectTracks,checkContainer,muxArgs,runTool,verifyMux,hashFile,checkAbort,fault} from '../media/mux.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const exists=file=>fs.lstat(file).then(()=>true, e=>{if(e.code==='ENOENT')return false;throw e;});
async function writeJson(file,data){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);}
export async function identity(file){const s=await fs.stat(file);if(!s.isFile())throw fault('FILE_REQUIRED');return {size:s.size,mtimeMs:s.mtimeMs,ino:String(s.ino),dev:String(s.dev),birthtimeMs:s.birthtimeMs};}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function readSub(file){if((await fs.stat(file)).size>8*1024*1024)throw fault('SUBTITLE_TOO_LARGE');const bytes=await fs.readFile(file);return {...subtitleText(bytes),hash:sha(bytes)};}
// authorizedPath supplies a real path; resolve configured roots the same way.
export async function createPathAuthorizer(roots,{enabled=true}={}) {
  if(!enabled)return ()=>false;
  const canonicalRoots=(await Promise.all(roots.map(async root=>{
    try{return await fs.realpath(path.resolve(root));}
    catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}
  }))).filter(Boolean);
  return target=>canonicalRoots.some(root=>{
    const relative=path.relative(root,target);
    return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
  });
}
export async function authorizedPath(input,allowed,{directory=false}={}) {
  if(typeof input!=='string'||!input.trim())throw fault('PATH_REQUIRED');
  const real=await fs.realpath(path.resolve(input));if(!allowed(real))throw fault('fs_forbidden',403);
  const stat=await fs.stat(real);if(directory?!stat.isDirectory():!stat.isFile())throw fault(directory?'DIRECTORY_REQUIRED':'FILE_REQUIRED');return real;
}
export async function discover(dir,allowed){
  const root=await authorizedPath(dir,allowed,{directory:true}),entries=await fs.readdir(root,{withFileTypes:true});
  const subtitles=entries.filter(e=>e.isFile()&&/\.srt$/i.test(e.name));
  const files=[];
  for(const e of entries.filter(e=>e.isFile()&&/\.(mp4|m4v|mkv|avi|mov|wmv|ts|m2ts|webm)$/i.test(e.name)).slice(0,1000)){
    const stem=path.parse(e.name).name.toLowerCase();const candidates=subtitles.filter(s=>{const name=s.name.toLowerCase();return name===stem+'.srt'||name.startsWith(stem+'.')||name.startsWith(stem+'_');}).map(s=>path.join(root,s.name));
    candidates.sort((a,b)=>(path.basename(a).toLowerCase()===stem+'.srt'?-1:0)-(path.basename(b).toLowerCase()===stem+'.srt'?-1:0)||a.localeCompare(b));
    files.push({file:path.join(root,e.name),name:e.name,subtitles:candidates,subtitle:candidates[0]||'',size:(await fs.stat(path.join(root,e.name))).size});
  }
  return {dir:root,files};
}
export async function createMuxPlan(dataDir,body,settings,allowed,signal){
  if(!Array.isArray(body.files)||!body.files.length||body.files.length>100)throw fault('SELECT_1_TO_100_FILES');
  const options={container:body.container||'mp4',language:body.language||'zho',title:String(body.title||'Chinese').slice(0,100),makeDefault:!!body.makeDefault};
  if(!/^[a-z]{3}$/.test(options.language))throw fault('INVALID_LANGUAGE');
  const outputDir=body.outputDir?await authorizedPath(body.outputDir,allowed,{directory:true}):null;
  const items=[],seen=new Set();
  for(const entry of body.files){
    checkAbort(signal);let item={file:String(entry.file||''),status:'error'};
    try{
      item.file=await authorizedPath(entry.file,allowed);if(seen.has(item.file.toLowerCase()))throw fault('DUPLICATE_SELECTION');seen.add(item.file.toLowerCase());
      item.subtitle=await authorizedPath(entry.subtitle,allowed);if(!/\.srt$/i.test(item.subtitle))throw fault('SRT_REQUIRED');
      item.identity=await identity(item.file);const sub=await readSub(item.subtitle);item.subtitleHash=sub.hash;item.subtitleDigest=sub.digest;item.encoding=sub.encoding;
      item.output=path.join(outputDir||path.dirname(item.file),path.parse(item.file).name+'.softsub.'+options.container);
      if(item.output.toLowerCase()===item.file.toLowerCase())throw fault('SOURCE_OUTPUT_COLLISION');
      item.outputDir=await fs.realpath(path.dirname(item.output));
      item.info=await probe(item.file,settings,signal);checkContainer(item.info,options.container);
      item.tracks=await inspectTracks(item.file,item.info,sub,settings,signal);
      if(item.tracks.some(s=>s.identical)){item.status='duplicate';item.error='SUBTITLE_ALREADY_EMBEDDED';}
      else if(await exists(item.output)){item.status='blocked';item.error='OUTPUT_EXISTS';}
      else {item.status='ready';item.requiresConfirmation=item.tracks.length>0;}
    }catch(e){checkAbort(signal);item.error=e.code||'ANALYSIS_FAILED';}
    items.push(item);
  }
  const targets=new Set();for(const item of items.filter(x=>x.status==='ready')){const key=item.output.toLowerCase();if(targets.has(key)){item.status='blocked';item.error='OUTPUT_COLLISION';}targets.add(key);}
  const plan={id:crypto.randomUUID(),createdAt:Date.now(),state:'preview',options,settings:{ffmpeg:settings.ffmpeg,ffprobe:settings.ffprobe},items};
  await writeJson(path.join(dataDir,'assembly','plans',plan.id+'.json'),plan);return plan;
}
export async function loadMuxPlan(dataDir,id){if(!/^[0-9a-f-]{36}$/i.test(String(id)))throw fault('INVALID_PLAN');return JSON.parse(await fs.readFile(path.join(dataDir,'assembly','plans',id+'.json'),'utf8'));}
async function validateItem(item,allowed){
  if(await authorizedPath(item.file,allowed)!==item.file||!equal(await identity(item.file),item.identity))throw fault('SOURCE_CHANGED',409);
  if(await authorizedPath(item.subtitle,allowed)!==item.subtitle||(await readSub(item.subtitle)).hash!==item.subtitleHash)throw fault('SUBTITLE_CHANGED',409);
  if(await authorizedPath(path.dirname(item.output),allowed,{directory:true})!==item.outputDir)throw fault('OUTPUT_DIRECTORY_CHANGED',409);
  if(await exists(item.output))throw fault('OUTPUT_EXISTS',409);
}
export async function claimMuxPlan(dataDir,id,{keepExisting=false}={},allowed){
  const p=await loadMuxPlan(dataDir,id);if(p.state!=='preview'||Date.now()-p.createdAt>24*3600*1000)throw fault('PLAN_EXPIRED',409);
  const ready=p.items.filter(i=>i.status==='ready');if(!ready.length)throw fault('NO_READY_FILES');
  if(ready.some(i=>i.requiresConfirmation)&&!keepExisting)throw fault('CONFIRM_KEEP_EXISTING_TRACKS',409);
  for(const item of ready)await validateItem(item,allowed);
  p.state='executing';await writeJson(path.join(dataDir,'assembly','plans',id+'.json'),p);return p;
}
export async function executeMux(dataDir,plan,{signal,allowed,onProgress=()=>{},onResult=async()=>{},jobId=crypto.randomUUID()}={}){
  const journalFile=path.join(dataDir,`journal-mux-${Date.now()}-${jobId}.json`),journal={version:2,type:'mux-create-output',createdAt:new Date().toISOString(),items:[]};
  await writeJson(journalFile,journal);
  const report={kind:'mux',dir:path.dirname(plan.items.find(i=>i.status==='ready').file),apply:true,startedAt:Date.now(),journal:journalFile,results:[],summary:{},cancelled:false};
  const ready=plan.items.filter(i=>i.status==='ready');let done=0;
  for(const item of ready){
    let temporary,result={file:item.file,originalFile:item.file,name:path.basename(item.file),output:item.output,status:'error'};
    const progress=(stage,percent=0)=>onProgress({done,total:ready.length,stage,file:item.file,percent:Math.round(percent)});
    try{
      checkAbort(signal);progress('prepare');await validateItem(item,allowed);
      temporary=await fs.mkdtemp(path.join(item.outputDir,'.avc-mux-'));
      const sub=await readSub(item.subtitle),subFile=path.join(temporary,'subtitle.srt'),out=path.join(temporary,'output.'+plan.options.container);
      await fs.writeFile(subFile,sub.text);const duration=Number(item.info.format?.duration)||0;
      await runTool(plan.settings.ffmpeg,muxArgs(item.file,subFile,out,item.info,plan.options),{signal,timeoutMs:24*3600*1000,onProgress:seconds=>progress('mux',duration?Math.min(85,seconds/duration*85):0),maxBytes:64*1024*1024});
      progress('verify',86);await verifyMux(item.info,out,plan.settings,plan.options,signal);
      const outputInfo=await probe(out,plan.settings,signal),last=outputInfo.streams.filter(s=>s.codec_type==='subtitle').at(-1);
      const text=await runTool(plan.settings.ffmpeg,['-v','error','-copyts','-i',out,'-map',`0:${last.index}`,'-f','srt','-'],{signal});
      if(subtitleText(Buffer.from(text)).digest!==sub.digest)throw fault('SUBTITLE_VERIFY_FAILED');
      progress('hash',90);const size=(await fs.stat(out)).size,hash=await hashFile(out,signal,n=>progress('hash',90+(size?n/size*9:0)));
      await validateItem(item,allowed);checkAbort(signal);
      const record={output:item.output,source:item.file,sha256:hash,size,phase:'publishing',subtitleDigest:sub.digest};journal.items.push(record);await writeJson(journalFile,journal);
      // Hard-link publication is atomic and refuses any pre-existing target (including symlinks).
      checkAbort(signal);await fs.link(out,item.output);record.phase='published';record.identity=await identity(item.output);await writeJson(journalFile,journal);
      result.status='ok';result.sha256=hash;progress('complete',100);
    }catch(e){result.error=e.code||'MUX_FAILED';if(e.detail)result.detail=e.detail;if(signal?.aborted||e.code==='CANCELLED'){report.cancelled=true;result.status='cancelled';}}
    finally{if(temporary)await fs.rm(temporary,{recursive:true,force:true}).catch(()=>{});}
    report.results.push(result);report.summary[result.status]=(report.summary[result.status]||0)+1;done++;onProgress({done,total:ready.length,stage:report.cancelled?'cancelled':'complete',file:item.file,percent:0});await onResult(result,journalFile);
    if(report.cancelled)break;
  }
  plan.state='consumed';await writeJson(path.join(dataDir,'assembly','plans',plan.id+'.json'),plan);report.finishedAt=Date.now();return report;
}
export async function undoMux(file){
  const j=JSON.parse(await fs.readFile(file,'utf8'));if(j.version!==2||j.type!=='mux-create-output')throw fault('INVALID_MUX_JOURNAL');
  let removed=0;const failed=[];
  for(const item of j.items){if(item.phase==='undone')continue;try{const s=await fs.lstat(item.output);if(!s.isFile()||s.isSymbolicLink()||s.size!==item.size||await hashFile(item.output)!==item.sha256)throw fault('OUTPUT_CHANGED');if(item.identity&&!equal(await identity(item.output),item.identity))throw fault('OUTPUT_CHANGED');await fs.unlink(item.output);item.phase='undone';removed++;await writeJson(file,j);}catch(e){if(e.code==='ENOENT'){item.phase='undone';await writeJson(file,j);}else failed.push({file:item.output,error:e.code||e.message});}}
  return {removed,restored:0,failed,restoredItems:[]};
}
