// Capability preflight: source text + pure-memory DOM/API substitutes only.
// No browser, service, network, child process, or product-data access.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../web/app.js',import.meta.url),'utf8');
const translate=(text,...values)=>Array.isArray(text)?text.reduce((s,part,i)=>s+part+(values[i]??''),''):text;
function section(start,end){const from=source.indexOf(start),to=source.indexOf(end,from);assert.ok(from>=0&&to>from);return source.slice(from,to);}

test('R17 late A candidate response cannot populate B or install onto B; fresh B installs its bound context',async()=>{
  const nodes=new Map(),pending=[],sent=[],toasts=[];
  const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',value:'',classList:{toggle(){}}});return nodes.get(key);};
  const state={drawerPath:'A',itemByPath:new Map([['A',{path:'A',code:'IPX-920'}],['B',{path:'B',code:'IPX-921'}]])};
  const sandbox={state,AbortController,Object,Array,String,ERRMSG:{},t:translate,$:node,esc:String,pathBase:x=>x,
    currentDrawerItem:()=>state.itemByPath.get(state.drawerPath),workflows:null,
    api:async(route,options)=>{const body=JSON.parse(options.body);sent.push({route,body});if(route.endsWith('candidates'))return new Promise(resolve=>pending.push({resolve,signal:options.signal}));return {path:'B.srt',cues:1,bytes:40};},
    toast:(...args)=>toasts.push(args),errText:String,invalidatePlan(){},patchRow(){},renderDrawer(){}};
  const context=vm.createContext(sandbox);
  vm.runInContext(section("const SUB_BACKUP_NOTE =",'function coverFetchErrorText'),context);
  const first=vm.runInContext('listSubtitleCandidates()',context);
  state.drawerPath='B';vm.runInContext('resetSubManualUi()',context);
  const second=vm.runInContext('listSubtitleCandidates()',context);
  assert.equal(pending[0].signal.aborted,true);
  pending[0].resolve({file:'A',code:'IPX-920',contextToken:'A-token',candidates:[{name:'A.srt',contextToken:'A-token'}]});await first;
  assert.equal(node('#subCandidates').innerHTML,'');
  sandbox.stale={name:'A.srt',contextToken:'A-token'};
  await vm.runInContext('applySubtitleCandidate(stale)',context);assert.equal(sent.length,2);
  pending[1].resolve({file:'B',code:'IPX-921',contextToken:'B-token',candidates:[{name:'B.srt',contextToken:'B-token'}]});await second;
  assert.match(node('#subCandidates').innerHTML,/B\.srt/);assert.doesNotMatch(node('#subCandidates').innerHTML,/A\.srt/);
  await vm.runInContext('applySubtitleCandidate(subCandidates[0])',context);
  assert.equal(sent[2].body.file,'B');assert.equal(sent[2].body.code,'IPX-921');assert.equal(sent[2].body.candidate.contextToken,'B-token');
  assert.equal(state.itemByPath.get('A').sub,undefined);assert.equal(state.itemByPath.get('B').sub.path,'B.srt');
  vm.runInContext('resetSubManualUi()',context);assert.equal(node('#subCandidates').innerHTML,'');
  assert.equal(toasts.at(-1)[1],'ok');
});

test('R01/R05/R09 UI distinguishes partial undo/state retry and retained embedded content',async()=>{
  for(const result of [
    {undoComplete:false,restored:1,failed:[{reason:'media_changed'}]},
    {undoComplete:false,restored:1,stateError:'synthetic projection failure',failed:[]},
    {undoComplete:true,restored:1,failed:[],retainedEffects:['embedded_cover']},
  ]) {
    const toasts=[],confirmations=[],calls=[];let refreshed=0;
    const context=vm.createContext({state:{running:false},t:translate,
      confirmDialog:async(...args)=>{confirmations.push(args);return true;},
      api:async(route,options)=>{calls.push({route,body:JSON.parse(options.body)});return result;},
      toast:(...args)=>toasts.push(args),toastErr:()=>assert.fail('unexpected API failure'),loadHistory:()=>refreshed++});
    vm.runInContext(section('async function undoJournalFile(', '/** B12'),context);
    await vm.runInContext("undoJournalFile('fixture-journal','fixture')",context);
    assert.match(confirmations[0][1],/不能恢复嵌入前/);assert.equal(calls[0].body.journal,'fixture-journal');assert.equal(refreshed,1);
    const [message,kind]=toasts[0];
    if(result.undoComplete===false){assert.equal(kind,'err');assert.match(message,/部分撤销/);assert.doesNotMatch(message,/撤销完成/);}
    if(result.stateError)assert.match(message,/状态更新待重试/);
    if(result.retainedEffects){assert.equal(kind,'ok');assert.match(message,/嵌入的封面已保留/);assert.match(message,/未恢复嵌入前的视频内容/);}
  }
});
