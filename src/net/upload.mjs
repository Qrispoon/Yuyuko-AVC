import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

// A single bounded POST. Never follows redirects or retries a user's upload.
export function upload(url, body, {headers={}, timeoutMs=30000, proxy='', signal, maxResponseBytes=2*1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    const target=new URL(url); let request, tunnel, socket, settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){request?.destroy();tunnel?.destroy();socket?.destroy();reject(error);}else resolve(value);};
    const fail=code=>finish(Object.assign(new Error(code),{code}));
    const abort=()=>fail('SEARCH_CANCELLED');
    const timer=setTimeout(()=>fail('SEARCH_TIMEOUT'),timeoutMs);timer.unref?.();
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    const send=(transport,options)=>{
      request=transport.request(options,res=>{
        const chunks=[];let length=0;
        res.on('data',chunk=>{length+=chunk.length;if(length>maxResponseBytes){res.destroy();fail('SEARCH_RESPONSE_TOO_LARGE');}else chunks.push(chunk);});
        res.on('error',()=>fail('SEARCH_NETWORK_ERROR'));
        res.on('end',()=>finish(null,{status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
      });
      request.on('error',()=>fail('SEARCH_NETWORK_ERROR'));request.end(body);
    };
    const base={method:'POST',headers:{...headers,'Content-Length':body.length},agent:false};
    if(!proxy){send(target.protocol==='https:'?https:http,{...base,protocol:target.protocol,hostname:target.hostname,port:target.port||undefined,path:target.pathname+target.search});return;}
    let p;try{p=new URL(proxy);}catch{fail('INVALID_PROXY');return;}
    if(p.protocol!=='http:'||target.protocol!=='https:'){fail('INVALID_PROXY');return;}
    const proxyHeaders={Host:`${target.hostname}:${target.port||443}`};
    if(p.username||p.password)proxyHeaders['Proxy-Authorization']='Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64');
    tunnel=http.request({hostname:p.hostname,port:p.port||80,method:'CONNECT',path:`${target.hostname}:${target.port||443}`,headers:proxyHeaders,agent:false});
    tunnel.on('error',()=>fail('SEARCH_NETWORK_ERROR'));
    tunnel.on('connect',(res,raw,head)=>{
      socket=raw;if(res.statusCode!==200){fail('PROXY_CONNECT_FAILED');return;}if(head.length)raw.unshift(head);
      socket=tls.connect({socket:raw,servername:target.hostname,rejectUnauthorized:true});
      socket.on('error',()=>fail('SEARCH_NETWORK_ERROR'));
      const agent=new https.Agent({keepAlive:false});agent.createConnection=()=>socket;
      send(https,{...base,hostname:target.hostname,port:target.port||443,path:target.pathname+target.search,agent});
    });tunnel.end();
  });
}
