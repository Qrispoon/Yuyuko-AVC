import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import {decodeToUtf8,parseSrt} from '../subs/verify.mjs';

export const fault=(code,status=400)=>Object.assign(new Error(code),{code,status});
export function checkAbort(signal){if(signal?.aborted)throw fault('CANCELLED');}
// Abort and timeout resolve only after close: no child may continue writing after cleanup.
export function runTool(command,args,{signal,onProgress,timeoutMs=60000,maxBytes=16*1024*1024}={}) {
  checkAbort(signal);
  return new Promise((resolve,reject)=>{
    let child,output='',errors='',cancelled=false,timedOut=false,overflow=false,pending='';
    const abort=()=>{cancelled=true;child?.kill('SIGKILL');};
    try{child=spawn(command,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});}catch(e){reject(e);return;}
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);timer.unref?.();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>maxBytes){overflow=true;child.kill('SIGKILL');}if(onProgress){pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){const m=/^out_time_us=(\d+)/.exec(line);if(m)onProgress(Number(m[1])/1e6);}}});
    child.stderr.on('data',c=>{errors=(errors+c.toString()).slice(-4000);});
    child.once('error',e=>{errors=e.code||e.message;});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(cancelled)reject(fault('CANCELLED'));else if(timedOut)reject(fault('MEDIA_TIMEOUT'));else if(overflow)reject(fault('MEDIA_OUTPUT_TOO_LARGE'));else if(code!==0)reject(Object.assign(fault(errors==='ENOENT'?'FFMPEG_MISSING':'MEDIA_PROCESS_FAILED'),{detail:errors||`Process exit code: ${code}`}));else resolve(output);});
  });
}
export async function probe(file,settings,signal) {
  const raw=await runTool(settings.ffprobe,['-v','error','-show_streams','-show_format','-show_chapters','-of','json',file],{signal});
  let info;try{info=JSON.parse(raw);}catch{throw fault('INVALID_MEDIA');}
  if(!info.streams?.some(s=>s.codec_type==='video'&&!s.disposition?.attached_pic))throw fault('NO_VIDEO_STREAM');
  return info;
}
export function subtitleText(bytes) {
  const {text,encoding}=decodeToUtf8(bytes),parsed=parseSrt(text);
  if(!parsed.cues?.length||parsed.problems?.length||parsed.cues.some(c=>!c.text.trim()||c.end<=c.start))throw fault('INVALID_SRT');
  const normalized=parsed.cues.map(c=>[c.start,c.end,String(c.text).replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim()]);
  return {text:text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n'),encoding,digest:crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex')};
}
export async function hashFile(file,signal,onProgress){const h=crypto.createHash('sha256');let bytes=0;for await(const chunk of createReadStream(file)){checkAbort(signal);h.update(chunk);bytes+=chunk.length;onProgress?.(bytes);}checkAbort(signal);return h.digest('hex');}
const textCodecs=new Set(['subrip','srt','ass','ssa','webvtt','mov_text','text']);
export async function inspectTracks(file,info,subtitle,settings,signal) {
  const tracks=[];
  for(const s of info.streams.filter(s=>s.codec_type==='subtitle')){
    let identical=false,readable=false;
    if(textCodecs.has(s.codec_name))try{const extracted=await runTool(settings.ffmpeg,['-v','error','-copyts','-i',file,'-map',`0:${s.index}`,'-f','srt','-'],{signal});identical=subtitleText(Buffer.from(extracted)).digest===subtitle.digest;readable=true;}catch(e){checkAbort(signal);}
    tracks.push({index:s.index,codec:s.codec_name,language:s.tags?.language||'und',title:s.tags?.title||'',identical,readable});
  }
  return tracks;
}
export function muxArgs(source,subtitle,output,info,{container,language='zho',title='Chinese',makeDefault=false}) {
  const count=info.streams.filter(s=>s.codec_type==='subtitle').length;
  const args=['-v','error','-nostdin','-n','-copyts','-i',source,'-i',subtitle,'-map','0','-map','1:0','-map_metadata','0','-map_chapters','0','-c','copy'];
  args.push(`-c:s:${count}`,container==='mp4'?'mov_text':'srt',`-metadata:s:s:${count}`,`language=${language}`,`-metadata:s:s:${count}`,`title=${title}`,`-disposition:s:${count}`,makeDefault?'default':'0');
  if(container==='mp4')args.push(`-metadata:s:s:${count}`,`handler_name=${title}`);
  if(makeDefault)for(let i=0;i<count;i++)args.push(`-disposition:s:${i}`,'-default');
  args.push('-avoid_negative_ts','disabled','-progress','pipe:1','-nostats',output);return args;
}
export function checkContainer(info,container) {
  if(!['mp4','mkv'].includes(container))throw fault('INVALID_CONTAINER');
  // Existing streams are copied, never silently dropped or transcoded.
  if(container==='mp4'&&info.streams.some(s=>s.codec_type==='attachment'||s.codec_type==='data'||(s.codec_type==='subtitle'&&s.codec_name!=='mov_text')))throw fault('USE_MKV_TO_PRESERVE_TRACKS');
  if(container==='mkv'&&info.streams.some(s=>s.codec_type==='data'||s.codec_name==='mov_text'))throw fault('UNSUPPORTED_EXISTING_TRACK');
}
export async function verifyMux(sourceInfo,output,settings,options,signal) {
  const result=await probe(output,settings,signal),a=sourceInfo.streams,b=result.streams;
  if(b.length!==a.length+1)throw fault('MUX_VERIFY_FAILED');
  const added=b.filter(s=>s.codec_type==='subtitle').at(-1),old=b.filter(s=>s!==added);
  // Matroska reports attachments after all tracks, regardless of -map order.
  for(const type of new Set(a.map(s=>s.codec_type))){const before=a.filter(s=>s.codec_type===type),after=old.filter(s=>s.codec_type===type);if(before.length!==after.length)throw fault('MUX_VERIFY_FAILED');for(let i=0;i<before.length;i++){const s=before[i],t=after[i];if(s.codec_name!==t.codec_name||s.width!==t.width||s.height!==t.height||s.channels!==t.channels||(type==='attachment'&&s.tags?.filename!==t.tags?.filename))throw fault('MUX_VERIFY_FAILED');}}
  if((sourceInfo.chapters?.length||0)!==(result.chapters?.length||0))throw fault('MUX_VERIFY_FAILED');
  if(!added||added.codec_name!==(options.container==='mp4'?'mov_text':'subrip'))throw fault('MUX_VERIFY_FAILED');
  const before=Number(sourceInfo.format?.duration),after=Number(result.format?.duration);if(before&&(!after||Math.abs(after-before)>2))throw fault('MUX_VERIFY_FAILED');
  return result;
}
