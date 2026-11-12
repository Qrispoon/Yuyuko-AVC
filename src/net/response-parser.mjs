const fault=(code,message=code)=>({state:'error',error:Object.assign(new Error(message),{code})});
const need=eof=>eof?fault('INCOMPLETE_RESPONSE'):{state:'need_more'};
export function parseResponse(raw,{eof=false,method='GET',maxHeaderBytes=65536,maxBodyBytes=16*1024*1024,maxTrailerBytes=16384}={}) {
  const buf=Buffer.from(raw);
  if(buf.length>maxHeaderBytes+maxBodyBytes*2+maxTrailerBytes)return fault('RESPONSE_TOO_LARGE');
  let start=0,header;
  for(let interim=0;interim<17;interim++) {
    const end=buf.indexOf('\r\n\r\n',start);
    if(end<0)return buf.length-start>maxHeaderBytes?fault('RESPONSE_TOO_LARGE'):need(eof);
    if(end-start>maxHeaderBytes)return fault('RESPONSE_TOO_LARGE');
    const lines=buf.subarray(start,end).toString('latin1').split('\r\n'),status=/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines.shift());
    if(!status)return fault('INVALID_RESPONSE','invalid status line');
    const headers={},lengths=[],encodings=[];
    for(const line of lines) {
      const m=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/.exec(line);
      if(!m)return fault('INVALID_RESPONSE','invalid header');
      const name=m[1].toLowerCase(),value=m[2].trim();
      if(name==='content-length')lengths.push(...value.split(',').map(s=>s.trim()));
      if(name==='transfer-encoding')encodings.push(...value.toLowerCase().split(',').map(s=>s.trim()));
      if(name==='set-cookie')headers[name]=[...(headers[name]||[]),value];else headers[name]=headers[name]?headers[name]+', '+value:value;
    }
    if(lengths.some(v=>!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))||new Set(lengths.map(Number)).size>1)return fault('INVALID_RESPONSE','conflicting length');
    if(encodings.length && (lengths.length || encodings.length!==1 || encodings[0]!=='chunked'))return fault('INVALID_RESPONSE','ambiguous transfer framing');
    header={status:Number(status[1]),statusText:status[2]||'',headers};start=end+4;
    if(header.status>=100&&header.status<200) {if(header.status===101)return fault('INVALID_RESPONSE','upgrade unsupported');continue;}
    break;
  }
  if(!header||header.status<200)return fault('INVALID_RESPONSE','too many interim responses');
  const done=(buffer,consumed)=>({state:'complete',response:{...header,buffer},consumed});
  if(method==='HEAD'||header.status===204||header.status===304)return done(Buffer.alloc(0),start);
  const te=header.headers['transfer-encoding'],cl=header.headers['content-length'];
  if(te) {
    let cursor=start,total=0;const chunks=[];
    for(;;) {
      const lineEnd=buf.indexOf('\r\n',cursor);
      if(lineEnd<0)return buf.length-cursor>8192?fault('RESPONSE_TOO_LARGE'):need(eof);
      const sizeLine=buf.subarray(cursor,lineEnd).toString('latin1');
      if(sizeLine.length>8192)return fault('RESPONSE_TOO_LARGE');
      if(!/^[0-9A-Fa-f]+(?:;[^\x00-\x1f\x7f]*)?$/.test(sizeLine))return fault('INVALID_RESPONSE','invalid chunk size');
      const size=Number.parseInt(sizeLine.split(';')[0],16);
      if(!Number.isSafeInteger(size)||size>maxBodyBytes-total)return fault('RESPONSE_TOO_LARGE');
      cursor=lineEnd+2;
      if(size===0) {
        const trailerStart=cursor;
        for(;;) {
          const end=buf.indexOf('\r\n',cursor);
          if(end<0)return buf.length-trailerStart>maxTrailerBytes?fault('RESPONSE_TOO_LARGE'):need(eof);
          if(end-trailerStart>maxTrailerBytes)return fault('RESPONSE_TOO_LARGE');
          if(end===cursor)return done(Buffer.concat(chunks,total),end+2);
          const line=buf.subarray(cursor,end).toString('latin1');
          if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:[^\x00-\x08\x0a-\x1f\x7f]*$/.test(line)||/^(content-length|transfer-encoding):/i.test(line))return fault('INVALID_RESPONSE','invalid trailer');
          cursor=end+2;
        }
      }
      if(buf.length<cursor+size+2)return need(eof);
      if(buf[cursor+size]!==13||buf[cursor+size+1]!==10)return fault('INVALID_RESPONSE','missing chunk CRLF');
      chunks.push(buf.subarray(cursor,cursor+size));total+=size;cursor+=size+2;
    }
  }
  if(cl!=null) {
    const length=Number(cl.split(',')[0]);if(length>maxBodyBytes)return fault('RESPONSE_TOO_LARGE');
    if(buf.length-start<length)return need(eof);
    return done(buf.subarray(start,start+length),start+length);
  }
  if(buf.length-start>maxBodyBytes)return fault('RESPONSE_TOO_LARGE');
  return eof?done(buf.subarray(start),buf.length):need(false);
}
