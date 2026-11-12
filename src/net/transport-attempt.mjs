import net from 'node:net';
import tls from 'node:tls';
import {parseResponse} from './response-parser.mjs';
const fault=code=>Object.assign(new Error(code),{code});

// One attempt owns every raw/TLS socket, timer and listener until close converges.
export async function connectTls({host,port,proxy,timeoutMs,signal},factories={}) {
  const netConnect=factories.netConnect||net.connect,tlsConnect=factories.tlsConnect||tls.connect;
  const setTimer=factories.setTimer||setTimeout,clearTimer=factories.clearTimer||clearTimeout;
  const sockets=new Set(),listeners=[];let timer,disposing;
  const on=(sock,event,fn)=>{sock.on(event,fn);listeners.push([sock,event,fn]);};
  const dispose=()=>disposing||=(async()=>{
    if(timer!==undefined)clearTimer(timer);signal?.removeEventListener('abort',abort);
    for(const [s,e,f]of listeners)s.removeListener(e,f);
    await Promise.all([...sockets].map(s=>new Promise(resolve=>{
      if(s.closed)return resolve();
      const swallow=()=>{},closed=()=>{s.removeListener('error',swallow);resolve();};
      s.once('error',swallow);s.once('close',closed);s.setTimeout?.(0);s.destroy();
    })));
  })();
  let fail;
  const abort=()=>fail(signal.reason||fault('ABORT_ERR'));
  const socket=await new Promise((resolve,reject)=>{
    let settled=false;
    fail=error=>{if(settled)return;settled=true;void dispose().then(()=>reject(error),reject);};
    const watch=s=>{sockets.add(s);on(s,'error',fail);on(s,'end',()=>fail(fault('INCOMPLETE_RESPONSE')));return s;};
    const secure=raw=>{
      try {
        const s=watch(tlsConnect({...(raw?{socket:raw}:{host,port}),servername:host,ALPNProtocols:['http/1.1']}));
        on(s,'secureConnect',()=>{if(settled)return;settled=true;if(timer!==undefined)clearTimer(timer);signal?.removeEventListener('abort',abort);for(const [sock,event,fn]of listeners)sock.removeListener(event,fn);resolve(s);});
      }catch(e){fail(e);}
    };
    if(signal?.aborted){fail(signal.reason||fault('ABORT_ERR'));return;}
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimer(()=>fail(fault('TIMEOUT')),timeoutMs);
    if(!proxy){secure(null);return;}
    try {
      const raw=watch(netConnect({host:proxy.host,port:proxy.port}));let head=Buffer.alloc(0);
      on(raw,'connect',()=>raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
      const data=chunk=>{
        head=Buffer.concat([head,chunk]);if(head.length>16384)return fail(fault('RESPONSE_TOO_LARGE'));
        const end=head.indexOf('\r\n\r\n');if(end<0)return;
        raw.removeListener('data',data);
        if(!/^HTTP\/1\.[01] 2\d\d(?: |\r)/.test(head.toString('latin1')))return fail(fault('PROXY_REJECTED'));
        if(head.length!==end+4)return fail(fault('INVALID_RESPONSE'));
        raw.setTimeout?.(0);secure(raw);
      };on(raw,'data',data);
    }catch(e){fail(e);}
  });
  return {socket,dispose};
}
export async function exchange({url,method='GET',headers={},body=null,proxy,timeoutMs,jar,signal,ua,maxBodyBytes},factories={}) {
  const setTimer=factories.setTimer||setTimeout,clearTimer=factories.clearTimer||clearTimeout;
  const u=new URL(url);if(u.protocol!=='https:')throw fault('ONLY_HTTPS_SUPPORTED');
  const owned=await connectTls({host:u.hostname,port:Number(u.port||443),proxy,timeoutMs,signal},factories),sock=owned.socket;
  try {
    const response=await new Promise((resolve,reject)=>{
      let settled=false,raw=Buffer.alloc(0);const subscriptions=[];
      const on=(event,fn)=>{sock.on(event,fn);subscriptions.push([event,fn]);};
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimer(timer);signal?.removeEventListener('abort',abort);for(const [e,f]of subscriptions)sock.removeListener(e,f);error?reject(error):resolve(value);};
      const abort=()=>finish(signal.reason||fault('ABORT_ERR'));
      const timer=setTimer(()=>finish(fault('TIMEOUT')),timeoutMs);
      const parse=eof=>{const result=parseResponse(raw,{method,eof,maxBodyBytes});if(result.state==='error')finish(result.error);else if(result.state==='complete')finish(null,result.response);};
      on('data',chunk=>{raw=Buffer.concat([raw,chunk]);parse(false);});on('end',()=>parse(true));on('close',()=>{if(!settled)finish(fault('INCOMPLETE_RESPONSE'));});on('error',e=>finish(e));
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
      const cookie=jar?.header(u.hostname),requestHeaders={Host:u.host,'User-Agent':ua,Accept:'*/*','Accept-Encoding':'identity',Connection:'close',...headers};
      if(cookie)requestHeaders.Cookie=cookie;if(body!=null)requestHeaders['Content-Length']=Buffer.byteLength(body);
      sock.write(`${method} ${u.pathname+u.search} HTTP/1.1\r\n`+Object.entries(requestHeaders).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');if(body!=null)sock.write(body);
    });
    jar?.absorb(u.hostname,response.headers['set-cookie']);return response;
  } finally {await owned.dispose();}
}
