import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {validateImage,normalizeSearchResults,searchFrame} from '../src/sources/frame-search.mjs';
import {upload} from '../src/net/upload.mjs';
import {validateSettings,readSettings,writeSettings} from '../src/core/assembly-settings.mjs';
import {discover,createMuxPlan,claimMuxPlan,executeMux,undoMux,identity} from '../src/core/assembly.mjs';
import {runTool,probe,hashFile,subtitleText} from '../src/media/mux.mjs';
import {startServer} from '../src/server.mjs';
import {muxReportHTML} from '../src/core/assembly-report.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=','base64');
const srt='1\n00:00:00,200 --> 00:00:01,200\n测试字幕 / Hello\n\n2\n00:00:01,400 --> 00:00:02,500\nSecond line\n';
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'avc-assembly-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const post=(base,route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function server(t,handler){const s=http.createServer(handler);s.listen(0,'127.0.0.1');await once(s,'listening');t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return `http://127.0.0.1:${s.address().port}`;}

test('frame image validation rejects oversize, animation, invalid dimensions and malformed segment bounds',()=>{
 assert.deepEqual(validateImage(png),{type:'image/png',width:1,height:1});
 assert.throws(()=>validateImage(Buffer.alloc(8000001)),{code:'INVALID_IMAGE_SIZE'});
 const huge=Buffer.from(png);huge.writeUInt32BE(10000,16);huge.writeUInt32BE(10000,20);assert.throws(()=>validateImage(huge),{code:'INVALID_IMAGE'});
 assert.throws(()=>validateImage(png.subarray(0,40)),{code:'INVALID_IMAGE'});
 const jpeg=Buffer.alloc(25,0);jpeg.set([255,216,255,192,0,2]);assert.throws(()=>validateImage(jpeg),{code:'INVALID_IMAGE'});
 const animated=Buffer.from(png);animated.write('acTL',37,'ascii');assert.throws(()=>validateImage(animated),{code:'ANIMATED_IMAGE'});
});
test('frame normalization uses percent scores, strips unsafe codes and returns timestamps without thumbnails',()=>{
 const result=normalizeSearchResults({results:[{video_code:'ABC-123',best_similarity:98.7,frames:[{image_name:'ABC-123_02-01-28.jpg'}]},{video_code:'<script>',best_similarity:100},{video_code:'DEF-234',best_similarity:101},{video_code:'abc-123',best_similarity:100}]});
 assert.deepEqual(result,[{code:'ABC-123',similarity:98.7,timestamps:['02:01:28']},{code:'DEF-234',similarity:null,timestamps:[]}]);
 assert.throws(()=>normalizeSearchResults({}),{code:'SEARCH_INVALID_RESPONSE'});
});
test('upload sends one bounded multipart file request, supports optional auth, and never follows redirects',async t=>{
 let count=0,requestBody,auth;const base=await server(t,async(req,res)=>{count++;auth=req.headers.authorization;const chunks=[];for await(const c of req)chunks.push(c);requestBody=Buffer.concat(chunks);if(req.url==='/redirect'){res.writeHead(307,{Location:base+'/search'});res.end();return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({results:[{video_code:'ABC-123',best_similarity:99.98,frames:[]}]}));});
 const r=await searchFrame(png,{endpoint:base+'/search',secret:'test-only',limit:10});assert.equal(r.results[0].similarity,99.98);assert.equal(auth,'Bearer test-only');assert.ok(requestBody.includes(Buffer.from('name="file"')));assert.ok(requestBody.includes(png));
 await assert.rejects(()=>searchFrame(png,{endpoint:base+'/redirect'}),{code:'SEARCH_REDIRECT'});assert.equal(count,2);
});
test('upload response bounds, cancellation, timeout and rate limiting have stable errors',async t=>{
 const base=await server(t,(req,res)=>{req.resume();if(req.url==='/large'){res.end('x'.repeat(100));return;}if(req.url==='/rate'){res.writeHead(429);res.end();}});
 await assert.rejects(()=>upload(base+'/large',png,{maxResponseBytes:20}),{code:'SEARCH_RESPONSE_TOO_LARGE'});
 await assert.rejects(()=>upload(base+'/wait',png,{timeoutMs:50}),{code:'SEARCH_TIMEOUT'});
 const ctrl=new AbortController();const pending=upload(base+'/wait',png,{signal:ctrl.signal});ctrl.abort();await assert.rejects(()=>pending,{code:'SEARCH_CANCELLED'});
 await assert.rejects(()=>searchFrame(png,{endpoint:base+'/rate'}),{code:'SEARCH_RATE_LIMITED'});
});
test('assembly settings keep secret separate and validate endpoints / auth headers',async t=>{
 const dir=await temporary(t);await writeSettings(dir,{endpoint:'https://avscan.cc/search',secret:'private-test',ffmpeg:'C:\\Tools\\ffmpeg.exe'});
 assert.equal((await readSettings(dir)).secret,undefined);assert.equal((await readSettings(dir)).hasSecret,true);
 assert.ok(!(await fs.readFile(path.join(dir,'assembly-settings.json'),'utf8')).includes('private-test'));
 await writeSettings(dir,{limit:20});assert.equal((await readSettings(dir,{privateValues:true})).secret,'private-test');await writeSettings(dir,{secret:''});assert.equal((await readSettings(dir)).hasSecret,false);
 for(const input of [{endpoint:'http://example.com/search'},{endpoint:'https://user:pass@example.com/search'},{endpoint:'file:///secret'},{authHeader:'Host'},{authHeader:'Authorization\r\nX-foo: x'}])assert.throws(()=>validateSettings(input));
});
test('local discovery prefers exact SRT and confines real paths; existing files are never selected implicitly',async t=>{
 const dir=await temporary(t);for(const name of ['example.mp4','example.srt','example.zh.srt','example2.srt'])await fs.writeFile(path.join(dir,name),'test');
 const r=await discover(dir,p=>p===dir||p.startsWith(dir+path.sep));assert.equal(r.files.length,1);assert.equal(r.files[0].subtitle,path.join(dir,'example.srt'));assert.equal(r.files[0].subtitles.length,2);
 await assert.rejects(()=>discover(dir,()=>false),{code:'fs_forbidden'});
});
test('media process cancellation waits for child exit and returns a stable error',async()=>{
 const ctrl=new AbortController();const p=runTool(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:ctrl.signal});setTimeout(()=>ctrl.abort(),50);await assert.rejects(()=>p,{code:'CANCELLED'});
});
test('mux undo removes only matching owned output and preserves changed output and source',async t=>{
 const dir=await temporary(t),source=path.join(dir,'source.mp4'),output=path.join(dir,'source.softsub.mp4'),journal=path.join(dir,'journal.json');await fs.writeFile(source,'source');await fs.writeFile(output,'output');
 const record={version:2,type:'mux-create-output',items:[{output,source,size:6,sha256:await hashFile(output),phase:'publishing'}]};await fs.writeFile(journal,JSON.stringify(record));assert.equal((await undoMux(journal)).removed,1);assert.equal(await fs.readFile(source,'utf8'),'source');
 await fs.writeFile(output,'change');record.items[0].phase='published';await fs.writeFile(journal,JSON.stringify(record));const r=await undoMux(journal);assert.equal(r.removed,0);assert.equal(r.failed[0].error,'OUTPUT_CHANGED');assert.equal(await fs.readFile(output,'utf8'),'change');
 const html=muxReportHTML({results:[{file:'<script>',output,status:'error',detail:'<img>'}],summary:{error:1}},{english:true});assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('Subtitle mux report'));
});
test('assembly HTTP APIs keep uploads ephemeral and reject cross-origin access and unknown job kinds',async t=>{
 const root=await temporary(t),data=path.join(root,'data'),configFile=path.join(root,'config.json');await fs.writeFile(configFile,JSON.stringify({paths:{dataDir:data},fs:{enabled:true,allowedRoots:[root]}}));
 const remote=await server(t,(req,res)=>{req.resume();res.setHeader('Content-Type','application/json');res.end('{"results":[]}');});
 const app=await startServer({port:0,configFile,quiet:true});t.after(()=>app.close());const base=`http://127.0.0.1:${app.port}`;
 assert.equal((await post(base,'/api/assembly/settings',{endpoint:remote+'/search',secret:'test-key'})).status,200);
 const publicSettings=await(await fetch(base+'/api/assembly/settings')).json();assert.equal(publicSettings.secret,undefined);assert.equal(publicSettings.hasSecret,true);
 assert.equal((await fetch(base+'/api/assembly/search',{method:'POST',headers:{'Content-Type':'image/png'},body:png})).status,200);
 assert.equal((await fetch(base+'/api/assembly/settings',{headers:{Origin:'https://evil.invalid'}})).status,403);
 assert.equal((await post(base,'/api/jobs',{kind:'mux',dir:root})).status,400);
 assert.equal((await post(base,'/api/assembly/plan',{files:[]})).status,400);
 assert.equal((await fs.readdir(data)).some(n=>/image|upload|result/.test(n)),false);
});

const ffmpeg=process.env.AVC_TEST_FFMPEG,ffprobe=process.env.AVC_TEST_FFPROBE;
test('real FFmpeg: MP4 / MKV mux, duplicate detection, frozen inputs, old tracks, no-overwrite and undo',{skip:!ffmpeg||!ffprobe},async t=>{
 await fs.mkdir(path.resolve('tmp'),{recursive:true});const dir=await fs.mkdtemp(path.resolve('tmp','avc-media-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const data=path.join(dir,'data'),source=path.join(dir,'sample.mp4'),subtitle=path.join(dir,'sample.srt'),settings={ffmpeg,ffprobe};const allowed=p=>p===dir||p.startsWith(dir+path.sep);
 await fs.writeFile(subtitle,srt);await runTool(ffmpeg,['-v','error','-f','lavfi','-i','color=c=pink:s=160x120:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);const sourceHash=await hashFile(source);
 const body={files:[{file:source,subtitle}],container:'mp4',language:'zho',title:'Chinese',makeDefault:true};
 const stale=await createMuxPlan(data,body,settings,allowed);await fs.appendFile(subtitle,'\n');await assert.rejects(()=>claimMuxPlan(data,stale.id,{},allowed),{code:'SUBTITLE_CHANGED'});await fs.writeFile(subtitle,srt);
 const occupied=await createMuxPlan(data,body,settings,allowed);await fs.writeFile(occupied.items[0].output,'do not replace');await assert.rejects(()=>claimMuxPlan(data,occupied.id,{},allowed),{code:'OUTPUT_EXISTS'});assert.equal(await fs.readFile(occupied.items[0].output,'utf8'),'do not replace');await fs.unlink(occupied.items[0].output);
 for(const container of ['mp4','mkv']){
  const plan=await createMuxPlan(data,{...body,container},settings,allowed);assert.equal(plan.items[0].status,'ready',JSON.stringify(plan.items[0]));await claimMuxPlan(data,plan.id,{},allowed);const report=await executeMux(data,plan,{allowed});assert.equal(report.results[0].status,'ok',JSON.stringify(report));const out=report.results[0].output,info=await probe(out,settings);assert.equal(info.streams.filter(s=>s.codec_type==='subtitle').length,1);assert.equal(await hashFile(source),sourceHash);
  const embedded=await createMuxPlan(data,{...body,files:[{file:out,subtitle}],container},settings,allowed);assert.equal(embedded.items[0].status,'duplicate',JSON.stringify(embedded.items[0]));
  const second=path.join(dir,'different.srt');await fs.writeFile(second,srt.replace('Second line','A different line'));const withOld=await createMuxPlan(data,{...body,files:[{file:out,subtitle:second}],container},settings,allowed);assert.equal(withOld.items[0].status,'ready',JSON.stringify(withOld.items[0]));await assert.rejects(()=>claimMuxPlan(data,withOld.id,{},allowed),{code:'CONFIRM_KEEP_EXISTING_TRACKS'});await claimMuxPlan(data,withOld.id,{keepExisting:true},allowed);const added=await executeMux(data,withOld,{allowed});assert.equal(added.results[0].status,'ok',JSON.stringify(added));assert.equal((await probe(added.results[0].output,settings)).streams.filter(s=>s.codec_type==='subtitle').length,2);assert.equal((await undoMux(added.journal)).removed,1);
  assert.equal((await undoMux(report.journal)).removed,1);assert.equal(await hashFile(source),sourceHash);
 }
 const cancelPlan=await createMuxPlan(data,body,settings,allowed);await claimMuxPlan(data,cancelPlan.id,{},allowed);const controller=new AbortController();const cancelled=await executeMux(data,cancelPlan,{allowed,signal:controller.signal,onProgress:p=>{if(p.stage==='hash')controller.abort();}});assert.equal(cancelled.cancelled,true);assert.equal(cancelled.results[0].status,'cancelled');assert.equal((await fs.readdir(dir)).some(n=>n.startsWith('.avc-mux-')),false);await assert.rejects(()=>fs.stat(cancelPlan.items[0].output),{code:'ENOENT'});
 const attachment=path.join(dir,'notes.txt'),metadata=path.join(dir,'chapters.txt'),rich=path.join(dir,'rich.mkv');await fs.writeFile(attachment,'test attachment');await fs.writeFile(metadata,';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=3000\ntitle=Test chapter\n');
 await runTool(ffmpeg,['-v','error','-i',source,'-f','ffmetadata','-i',metadata,'-map','0','-map_metadata','1','-map_chapters','1','-c','copy','-attach',attachment,'-metadata:s:t','mimetype=text/plain','-avoid_negative_ts','disabled',rich]);
 const richPlan=await createMuxPlan(data,{...body,files:[{file:rich,subtitle}],container:'mkv'},settings,allowed);assert.equal(richPlan.items[0].status,'ready',JSON.stringify(richPlan.items[0]));await claimMuxPlan(data,richPlan.id,{},allowed);const richReport=await executeMux(data,richPlan,{allowed});assert.equal(richReport.results[0].status,'ok',JSON.stringify(richReport));const richInfo=await probe(richReport.results[0].output,settings);assert.equal(richInfo.chapters.length,1);assert.equal(richInfo.streams.filter(s=>s.codec_type==='attachment').length,1);assert.equal((await undoMux(richReport.journal)).removed,1);
});
