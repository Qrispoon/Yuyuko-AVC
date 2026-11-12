import fs from 'node:fs/promises';
import path from 'node:path';

export const defaults = {ffmpeg:'ffmpeg',ffprobe:'ffprobe',endpoint:'',authHeader:'Authorization',timeoutMs:30000,limit:10,proxy:''};
const err=code=>Object.assign(new Error(code),{code,status:400});
export function validateSettings(input) {
  const s={...defaults};
  for(const k of ['ffmpeg','ffprobe','endpoint','authHeader','proxy']) if(input[k]!=null)s[k]=String(input[k]).trim();
  if(!s.ffmpeg||!s.ffprobe||[s.ffmpeg,s.ffprobe].some(x=>x.length>2048||/[\r\n\0]/.test(x)))throw err('INVALID_TOOL_PATH');
  if(s.endpoint){let u;try{u=new URL(s.endpoint);}catch{throw err('INVALID_ENDPOINT');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.hash||u.search)throw err('INVALID_ENDPOINT');if(u.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw err('HTTPS_REQUIRED');}
  if(!/^(Authorization|X-[A-Za-z0-9-]{1,60})$/i.test(s.authHeader))throw err('INVALID_AUTH_HEADER');
  if(s.proxy){let u;try{u=new URL(s.proxy);}catch{throw err('INVALID_PROXY');}if(u.protocol!=='http:')throw err('INVALID_PROXY');}
  s.timeoutMs=Math.max(3000,Math.min(120000,Number(input.timeoutMs)||30000));
  s.limit=Math.max(1,Math.min(20,Math.round(Number(input.limit)||10)));
  return s;
}
export async function readSettings(dataDir,{privateValues=false}={}) {
  const file=path.join(dataDir,'assembly-settings.json');
  let raw;try{raw=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;raw={};}
  const s=validateSettings(raw);
  let secret='';try{secret=await fs.readFile(path.join(dataDir,'assembly-secret'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  return privateValues?{...s,secret}:{...s,hasSecret:!!secret};
}
export async function writeSettings(dataDir,input) {
  const current=await readSettings(dataDir,{privateValues:true}),next=validateSettings({...current,...input});
  await fs.mkdir(dataDir,{recursive:true});
  if(input.secret!=null){const secret=String(input.secret);if(secret.length>4096||/[\r\n\0]/.test(secret))throw err('INVALID_SECRET');await fs.writeFile(path.join(dataDir,'assembly-secret'),secret,{mode:0o600});}
  const tmp=path.join(dataDir,'assembly-settings.tmp');await fs.writeFile(tmp,JSON.stringify(next,null,2));await fs.rename(tmp,path.join(dataDir,'assembly-settings.json'));
  return readSettings(dataDir);
}
