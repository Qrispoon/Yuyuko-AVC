// Capability preflight: pure byte parsing and fake req/fs/socket/clock only.
// Never opens a real port, sends a request, or creates a filesystem link.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {evaluateRequest,listenerPolicy,forwardRequestHeaders} from '../src/core/request-policy.mjs';
import {readAuthorizedFile} from '../src/core/authorized-reader.mjs';
import {parseResponse} from '../src/net/response-parser.mjs';
import {connectTls,exchange} from '../src/net/transport-attempt.mjs';
import {fullCodeMatches} from '../src/core/code.mjs';
import {createCandidateContexts} from '../src/core/candidate-context.mjs';
import {assertPlanRequest,requestContract,digest} from '../src/core/workflow.mjs';
import {createSnapshotWriter} from '../src/core/durable.mjs';
import {createHttp} from '../src/net/http.mjs';
import {createSubtitlecatSource} from '../src/subs/source-subtitlecat.mjs';

test('R07 fake requests enforce listener authority, same origin and exact route media type',()=>{
  const policy=listenerPolicy('127.0.0.1',12345),request=(extra={})=>({method:'POST',url:'/api/jobs',headers:{host:'127.0.0.1:12345','content-type':'application/json',...extra}});
  assert.equal(evaluateRequest(request(),policy),null);
  assert.equal(evaluateRequest(request({origin:'http://localhost:12345'}),policy),null);
  for(const origin of ['null','https://foreign.invalid','http://127.0.0.1:54321'])assert.equal(evaluateRequest(request({origin}),policy).status,403);
  assert.equal(evaluateRequest(request({host:'foreign.invalid:12345',origin:'http://foreign.invalid:12345'}),policy).error,'invalid_host');
  for(const mime of ['text/plain','application/x-www-form-urlencoded','multipart/form-data','application/jsonp'])assert.equal(evaluateRequest(request({'content-type':mime}),policy).status,415);
  assert.equal(evaluateRequest({...request({'content-type':'image/png'}),url:'/api/assembly/search'},policy),null);
  const assemblyRead={...request(),method:'GET',url:'/api/assembly/settings'};
  assert.equal(evaluateRequest(assemblyRead,policy),null);
  assert.equal(evaluateRequest({...assemblyRead,headers:{...assemblyRead.headers,origin:'http://localhost:12345'}},policy),null);
  assert.equal(evaluateRequest({...assemblyRead,headers:{...assemblyRead.headers,origin:'https://foreign.invalid'}},policy).status,403);
});
test('R08 fake filesystem reads the checked handle and closes on every rejection',async()=>{
  const root=path.resolve('fake-root'),file=path.join(root,'cover.jpg');let closed=0,read=0,link=false,outside=false,mismatch=false;
  const st={dev:1,ino:7,birthtimeMs:4,size:3,mtimeMs:2,isFile:()=>true,isSymbolicLink:()=>link};
  const io={realpath:async p=>outside&&p===file?path.resolve('outside/cover.jpg'):p,lstat:async()=>st,stat:async()=>({...st,ino:mismatch?8:7}),open:async()=>({stat:async()=>st,readFile:async()=>{read++;return Buffer.from('jpg');},close:async()=>{closed++;}})};
  assert.equal((await readAuthorizedFile(file,[root],{io})).toString(),'jpg');assert.equal(read,1);assert.equal(closed,1);
  mismatch=true;await assert.rejects(readAuthorizedFile(file,[root],{io}),{code:'PATH_CHANGED'});assert.equal(read,1);assert.equal(closed,2);mismatch=false;
  outside=true;await assert.rejects(readAuthorizedFile(file,[root],{io}),{code:'fs_forbidden'});outside=false;
  link=true;await assert.rejects(readAuthorizedFile(file,[root],{io}),{code:'PATH_LINK_UNSUPPORTED'});link=false;
  await assert.rejects(readAuthorizedFile(file,[root],{io,requireFinalPath:true}),{code:'FINAL_HANDLE_PATH_UNSUPPORTED'});assert.equal(closed,3);
});

test('R07 fake launcher verifies public authority before converting Host/Origin for its worker',()=>{
  const outer=listenerPolicy('127.0.0.1',17890),inner=listenerPolicy('127.0.0.1',18900);
  const request={method:'POST',url:'/api/jobs',headers:{host:'localhost:17890',origin:'http://localhost:17890','content-type':'application/json'}};
  assert.equal(evaluateRequest(request,outer),null);assert.equal(evaluateRequest(request,inner).error,'invalid_host');
  const headers=forwardRequestHeaders(request,outer,'127.0.0.1',18900);
  assert.equal(headers.host,'127.0.0.1:18900');assert.equal(headers.origin,'http://127.0.0.1:18900');assert.equal(evaluateRequest({...request,headers},inner),null);
  assert.equal(request.headers.host,'localhost:17890');
  for(const changed of [{host:'foreign.invalid:17890'},{origin:'http://foreign.invalid:17890'},{'content-type':'text/plain'}])assert.throws(()=>forwardRequestHeaders({...request,headers:{...request.headers,...changed}},outer,'127.0.0.1',18900));
  assert.equal(evaluateRequest({...request,url:'http://localhost:17890/api/jobs'},outer).error,'invalid_request_target');
  assert.equal(evaluateRequest({...request,url:'/__avc/retry',headers:{...request.headers,'content-type':'text/plain'}},outer).status,415);
  const noOrigin={...request,headers:{host:'127.0.0.1:17890','content-type':'application/json'}};
  assert.equal(forwardRequestHeaders(noOrigin,outer,'127.0.0.1',18900).origin,undefined);
});
test('R13 every truncated prefix of chunked/length response rejects at EOF',()=>{
  for(const response of ['HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello','HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Test: yes\r\n\r\n']) {
    const bytes=Buffer.from(response);for(let n=0;n<bytes.length;n++){const part=bytes.subarray(0,n);assert.equal(parseResponse(part).state,'need_more',`prefix ${n}`);assert.equal(parseResponse(part,{eof:true}).error.code,'INCOMPLETE_RESPONSE');}
    assert.equal(parseResponse(bytes).state,'complete');assert.equal(parseResponse(bytes).response.buffer.toString(),response.includes('chunked')?'abc':'hello');
  }
});
test('R13 invalid framing, chunk terminators and budgets fail without partial success',()=>{
  const invalid=[
    'Content-Length: 5\r\nContent-Length: 6\r\n\r\nabcdef','Content-Length: -1\r\n\r\n','Content-Length: 1x\r\n\r\nx',
    'Transfer-Encoding: chunked\r\nContent-Length: 1\r\n\r\n0\r\n\r\n','Transfer-Encoding: gzip, chunked\r\n\r\n',
    'Transfer-Encoding: chunked\r\n\r\nxyz\r\nx\r\n0\r\n\r\n','Transfer-Encoding: chunked\r\n\r\n1\r\nxZZ0\r\n\r\n','Transfer-Encoding: chunked\r\n\r\n0\r\nContent-Length: 2\r\n\r\n'];
  for(const wire of invalid)assert.equal(parseResponse(Buffer.from('HTTP/1.1 200 OK\r\n'+wire),{eof:true}).state,'error');
  assert.equal(parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n'),{maxBodyBytes:8}).error.code,'RESPONSE_TOO_LARGE');
  assert.equal(parseResponse(Buffer.from('HTTP/1.1 200 OK\r\n'+ 'x'.repeat(50)),{maxHeaderBytes:16}).error.code,'RESPONSE_TOO_LARGE');
});
test('R13 HEAD, no-body, interim and normal close-delimited framing',()=>{
  assert.equal(parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n'),{method:'HEAD'}).state,'complete');
  assert.equal(parseResponse(Buffer.from('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n')).response.status,204);
  const bytes=Buffer.from('HTTP/1.1 200 OK\r\n\r\nclose body');assert.equal(parseResponse(bytes).state,'need_more');assert.equal(parseResponse(bytes,{eof:true}).response.buffer.toString(),'close body');
});
class FakeSocket extends EventEmitter {
  closed=false;destroyed=false;writes=[];
  setTimeout(){return this;}
  write(data){this.writes.push(data);this.respond?.();return true;}
  destroy(){if(this.closed)return;this.destroyed=true;queueMicrotask(()=>{this.closed=true;this.emit('close');});}
}
test('R14 CONNECT timeout with fake timer id zero cleans its owned socket before rejection',async()=>{
  const raw=new FakeSocket();let expire,cleared=[];
  const promise=connectTls({host:'example.invalid',port:443,proxy:{host:'proxy.invalid',port:1},timeoutMs:10},{netConnect:()=>raw,tlsConnect:()=>{throw new Error('unexpected TLS');},setTimer:fn=>{expire=fn;return 0;},clearTimer:id=>cleared.push(id)});
  expire();await assert.rejects(promise,{code:'TIMEOUT'});assert.equal(raw.closed,true);assert.deepEqual(cleared,[0]);assert.equal(raw.eventNames().length,0);
});
test('R14 TLS/HTTP success and incomplete close clean listeners and await socket close',async()=>{
  for(const normalEnd of [true,false]) {
    const sock=new FakeSocket();sock.respond=()=>{sock.respond=null;queueMicrotask(()=>{sock.emit('data',Buffer.from('HTTP/1.1 200 OK\r\n\r\nbody'));if(normalEnd)sock.emit('end');else{sock.closed=true;sock.emit('close');}});};
    const factories={tlsConnect:()=>{queueMicrotask(()=>sock.emit('secureConnect'));return sock;}};
    const promise=exchange({url:'https://example.invalid/',timeoutMs:100,ua:'fake'},factories);
    if(normalEnd)assert.equal((await promise).buffer.toString(),'body');else await assert.rejects(promise,{code:'INCOMPLETE_RESPONSE'});
    assert.equal(sock.closed,true);assert.equal(sock.eventNames().length,0);
  }
});
test('R16 exact scope and option changes fail before plan consumption',()=>{
  const options={only:['a','b'],workflow:{mode:'missing'}},plan={dir:path.resolve('.'),entries:[{file:'a'},{file:'b'}],requestDigest:digest(requestContract(options)),scopeDigest:digest(['a','b'].map(p=>path.resolve(p)).sort()),state:'preview'};
  assert.equal(assertPlanRequest(plan,'.',options),true);
  for(const changed of [{...options,only:['a']},{...options,downloadSubs:false},{...options,force:true},{...options,workflow:{mode:'complete'}}])assert.throws(()=>assertPlanRequest(plan,'.',changed),{code:'NEEDS_REVIEW'});
  assert.equal(plan.state,'preview');
});
test('R17 candidate immutable context rejects other file/revision/content/expired result',()=>{
  let now=1;const contexts=createCandidateContexts({now:()=>now}),context={file:'A',revision:0,source:'object-a'},candidate={source:'local',localPath:'fake.srt',lang:'zh'};
  const issued=contexts.issue(context,[candidate]),bound=issued.candidates[0];assert.deepEqual(contexts.resolve(bound,context),candidate);
  for(const other of [{...context,file:'B'},{...context,revision:1},{...context,source:'object-b'}])assert.throws(()=>contexts.resolve(bound,other),{code:'CANDIDATE_CONTEXT_CHANGED'});
  assert.throws(()=>contexts.resolve({...bound,localPath:'other'},context),{code:'CANDIDATE_CONTEXT_CHANGED'});now=3600002;assert.throws(()=>contexts.resolve(bound,context),{code:'CANDIDATE_CONTEXT_CHANGED'});
});
test('R20 complete code token equivalence rejects longer codes and labels',()=>{
  for(const label of ['IPX-920','ipx00920.zh-CN.srt','[IPX_00920] 简体','IPX 920'])assert.equal(fullCodeMatches(label,'IPX-920'),true,label);
  for(const label of ['IPX-9201','IPX-1920','XIPX-920','IPX-920A','ABIPX920','IPX-92010'])assert.equal(fullCodeMatches(label,'IPX-920'),false,label);
});
test('R20 fake HTML adapter rejects unrelated rows before detail/HEAD and guards every link',async()=>{
  const calls=[],search='<a href="subs/1/wrong.html">IPX-9201 简体</a><a href="subs/1/good.html">IPX 00920 简体校对</a>';
  const http={getFollow:async(url,opts)=>{calls.push({url,opts});if(url.includes('index.php'))return {status:200,text:search};if(url.endsWith('good.html'))return {status:200,text:'<h2>IPX-920</h2><a href="IPX-920-zh-CN.srt">ok</a><a href="IPX-9201-zh-CN.srt">wrong</a><a href="IPX-920-zh-TW.srt">traditional</a>'};throw new Error('rejected row reached detail');}};
  const result=await createSubtitlecatSource(http).listCandidates('IPX-920');assert.equal(result.length,1);assert.ok(result[0].url.endsWith('IPX-920-zh-CN.srt'));assert.equal(result[0].matcherVersion,2);assert.equal(calls.length,3);assert.equal(calls[2].opts.method,'HEAD');assert.ok(calls[2].url.endsWith('IPX-920-zh-CN.srt'));assert.ok(calls.every(c=>!c.url.includes('wrong.html')));
});
test('R14 retry starts only after fake previous socket is closed',async()=>{
  let active=0,created=0,maxActive=0;const sockets=[];
  const http=createHttp({proxy:{host:'fake.invalid',port:1},defaultRoute:'proxy',retry:1,minIntervalMs:0,timeoutMs:1},{
    netConnect:()=>{assert.equal(active,0);const s=new FakeSocket();sockets.push(s);active++;created++;maxActive=Math.max(maxActive,active);s.once('close',()=>active--);return s;},
    setTimer:fn=>{queueMicrotask(fn);return 0;},clearTimer:()=>{},
  });
  await assert.rejects(http.get('https://fake.invalid/',{route:'proxy'}),{code:'TIMEOUT'});assert.equal(created,2);assert.equal(active,0);assert.equal(maxActive,1);assert.ok(sockets.every(s=>s.closed));
});
test('R21 immutable snapshot order and close barrier expose save failures and reject later writes',async()=>{
  const values=[];let release;
  const writer=createSnapshotWriter({write:async(file,value)=>{if(value.seq===1)await new Promise(r=>release=r);values.push(value);if(value.fail)throw new Error('synthetic save failure');}});
  const payload={seq:1,nested:{status:'running'}};const first=writer.enqueue('fake-job.json',payload);payload.seq=99;payload.nested.status='done';const second=writer.enqueue('fake-job.json',{seq:2});
  await Promise.resolve();await Promise.resolve();const a=writer.close(),b=writer.close();assert.equal(a,b);assert.throws(()=>writer.enqueue('fake-job.json',{seq:3}),{code:'WRITER_CLOSED'});release();await Promise.all([first,second,a]);assert.deepEqual(values,[{seq:1,nested:{status:'running'}},{seq:2}]);
  const failing=createSnapshotWriter({write:async()=>{throw new Error('save rejected');}});await assert.rejects(failing.enqueue('fail.json',{}),/save rejected/);await assert.rejects(failing.close(),/save rejected/);
});
