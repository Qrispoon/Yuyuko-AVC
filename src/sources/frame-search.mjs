import crypto from 'node:crypto';
import {upload} from '../net/upload.mjs';

export const MAX_IMAGE_BYTES=8000000;
const error=(code,status=400)=>Object.assign(new Error(code),{code,status});
export function validateImage(buffer) {
  if(!Buffer.isBuffer(buffer)||buffer.length<20||buffer.length>MAX_IMAGE_BYTES)throw error('INVALID_IMAGE_SIZE');
  let type,width,height;
  if(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    type='image/png';if(buffer.toString('ascii',12,16)!=='IHDR'||buffer.length<33)throw error('INVALID_IMAGE');width=buffer.readUInt32BE(16);height=buffer.readUInt32BE(20);
    let end=false;for(let p=8;p+12<=buffer.length;){const length=buffer.readUInt32BE(p),name=buffer.toString('ascii',p+4,p+8);if(length>buffer.length-p-12)throw error('INVALID_IMAGE');if(name==='acTL')throw error('ANIMATED_IMAGE');p+=12+length;if(name==='IEND'){end=true;break;}}if(!end)throw error('INVALID_IMAGE');
  }else if(buffer[0]===255&&buffer[1]===216){
    type='image/jpeg';let p=2;
    while(p+4<buffer.length){if(buffer[p++]!==255)continue;let marker=buffer[p++];while(marker===255&&p<buffer.length)marker=buffer[p++];if(marker===217||marker===218)break;if(marker===0||marker===1||(marker>=208&&marker<=215))continue;if(p+2>buffer.length)throw error('INVALID_IMAGE');const length=buffer.readUInt16BE(p);if(length<2||p+length>buffer.length)throw error('INVALID_IMAGE');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){if(length<8)throw error('INVALID_IMAGE');height=buffer.readUInt16BE(p+3);width=buffer.readUInt16BE(p+5);break;}p+=length;}
  }else if(buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP'){
    type='image/webp';if(buffer.readUInt32LE(4)+8!==buffer.length)throw error('INVALID_IMAGE');
    for(let p=12;p+8<=buffer.length;){const name=buffer.toString('ascii',p,p+4),len=buffer.readUInt32LE(p+4),q=p+8;if(q+len>buffer.length)throw error('INVALID_IMAGE');if(name==='ANIM'||name==='ANMF')throw error('ANIMATED_IMAGE');if(name==='VP8X'&&len>=10){if(buffer[q]&2)throw error('ANIMATED_IMAGE');width=buffer.readUIntLE(q+4,3)+1;height=buffer.readUIntLE(q+7,3)+1;}else if(name==='VP8 '&&len>=10){width=buffer.readUInt16LE(q+6)&16383;height=buffer.readUInt16LE(q+8)&16383;}else if(name==='VP8L'&&len>=5){const bits=buffer.readUInt32LE(q+1);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}p=q+len+(len%2);}
  }
  if(!type||!width||!height||width*height>25000000)throw error('INVALID_IMAGE');
  return {type,width,height};
}
export function normalizeSearchResults(payload,limit=10) {
  if(!payload||!Array.isArray(payload.results))throw error('SEARCH_INVALID_RESPONSE',502);
  const seen=new Set();return payload.results.slice(0,20).flatMap(item=>{
    const code=String(item?.video_code||'').trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{1,48}$/.test(code)||seen.has(code))return [];seen.add(code);
    const value=item.best_similarity,similarity=typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?value:null;
    const timestamps=[...new Set((Array.isArray(item.frames)?item.frames:[]).slice(0,20).flatMap(frame=>{const m=String(frame?.image_name||'').match(/_(\d{2,3})-([0-5]\d)-([0-5]\d)\.(?:jpg|jpeg|png|webp)$/i);return m?[m.slice(1).join(':')]:[];}))];
    return [{code,similarity,timestamps}];
  }).sort((a,b)=>(b.similarity??-1)-(a.similarity??-1)).slice(0,Math.max(1,Math.min(20,Number(limit)||10)));
}
export async function searchFrame(buffer,settings,{signal,transport=upload}={}) {
  const image=validateImage(buffer);if(!settings.endpoint)throw error('SEARCH_NOT_CONFIGURED');
  const boundary='avc-'+crypto.randomBytes(18).toString('hex');
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="frame.${image.type.split('/')[1]}"\r\nContent-Type: ${image.type}\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const headers={'Content-Type':'multipart/form-data; boundary='+boundary,'User-Agent':'AVC-Frame-Search'};
  if(settings.secret){headers[settings.authHeader||'Authorization']=settings.authHeader&&settings.authHeader.toLowerCase()!=='authorization'?settings.secret:'Bearer '+settings.secret;}
  const response=await transport(settings.endpoint,body,{headers,timeoutMs:settings.timeoutMs,proxy:settings.proxy,signal});
  if(response.status===429)throw error('SEARCH_RATE_LIMITED',429);
  if([401,403].includes(response.status))throw error('SEARCH_ACCESS_DENIED',502);
  if(response.status>=300&&response.status<400)throw error('SEARCH_REDIRECT',502);
  if(response.status!==200)throw error(response.status===400?'SEARCH_IMAGE_REJECTED':'SEARCH_SERVICE_ERROR',502);
  let data;try{data=JSON.parse(response.body.toString('utf8'));}catch{throw error('SEARCH_INVALID_RESPONSE',502);}
  return {results:normalizeSearchResults(data,settings.limit)};
}
