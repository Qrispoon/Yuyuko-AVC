// v0.7.5: confirmed operations, disk validation and offline reports.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fingerprint } from './rename.mjs';
import { sanitizeFileName } from './template.mjs';
import { verifySubtitle } from '../subs/verify.mjs';
import { isImage } from '../media/covers.mjs';
import { writeJsonDurable } from './durable.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const planPath = (config,id) => {
  if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('invalid_plan_id');
  return path.join(config.paths?.dataDir || 'data','plans',`${id}.json`);
};
export async function savePlan(config,plan) {
  const file=planPath(config,plan.id);await writeJsonDurable(file,plan);
  return plan;
}
export async function loadPlan(config,id) { return JSON.parse(await fs.readFile(planPath(config,id),'utf8')); }
export async function diskAssets(file,durationSec=null) {
  const stem=file.slice(0,-path.extname(file).length), out={subtitles:{},cover:null};
  for (const lang of ['zh','zh-TW','en','ko']) {
    const target=stem+(lang==='zh'?'':'.'+lang)+'.srt';
    const stat=await fs.stat(target).catch(()=>null);
    if (!stat?.isFile() || stat.size>8*1024*1024) continue;
    const b=await fs.readFile(target);
    const check=verifySubtitle({buffer:b,lang:lang==='zh'?'zh':lang,expectedDurationMin:durationSec?durationSec/60:null});
    if(check.ok) out.subtitles[lang]={path:target,...await fingerprint(target)};
  }
  for (const ext of ['jpg','png','webp']) {
    const target=stem+'.'+ext, st=await fs.stat(target).catch(()=>null);
    if(st?.isFile() && st.size<=8*1024*1024 && isImage(await fs.readFile(target))) {out.cover={path:target,...await fingerprint(target)};break;}
  }
  return out;
}
export function workflowOptions(input={}) {
  return {mode:input.mode==='missing'?'missing':'complete',metadata:input.metadata!==false,subtitles:input.subtitles!==false,covers:input.covers!==false,extraSubtitles:input.extraSubtitles!==false,rename:input.mode!=='missing'||input.rename===true};
}
export function requestContract(options={}) {
  return {only:Array.isArray(options.only)?[...new Set(options.only.map(p=>path.resolve(p)))].sort():null,
    overrides:Object.fromEntries(Object.entries(options.overrides||{}).map(([p,c])=>[path.resolve(p),String(c)]).sort(([a],[b])=>a.localeCompare(b))),
    workflow:workflowOptions(options.workflow),force:!!options.force,downloadSubs:options.downloadSubs!==false,
    limit:Number(options.limit||0),concurrency:Number(options.concurrency||1),fileTimeoutMs:Number(options.fileTimeoutMs||180000),maxConsecutiveFailures:Number(options.maxConsecutiveFailures||5)};
}
export function assertPlanRequest(plan,dir,options) {
  if(path.resolve(dir)!==path.resolve(plan.dir)||!plan.requestDigest||plan.requestDigest!==digest(requestContract(options)))throw Object.assign(new Error('plan_scope_or_options_changed'),{code:'NEEDS_REVIEW',status:409});
  if(plan.scopeDigest!==digest(plan.entries.map(e=>path.resolve(e.file)).sort()))throw Object.assign(new Error('plan_scope_changed'),{code:'NEEDS_REVIEW',status:409});
  return true;
}
export function effectiveMetadata(source,previous,fields,missing=false) {
  const out={...source};
  if(missing) for(const [k,v] of Object.entries(previous||{})) if(v != null && v!=='' && (!Array.isArray(v)||v.length)) out[k]=v;
  for(const [k,entry] of Object.entries(fields||{})) if(k!=='code' && entry.locked) out[k]=entry.value;
  return out;
}
export async function createOperationPlan(report,config,state,options={}) {
  const plan={id:randomUUID(),version:1,revision:0,createdAt:Date.now(),dir:path.resolve(report.dir),config:structuredClone(config),options:structuredClone(options),entries:[],state:'preview'};
  for(const r of report.results) {
    const from=r.rename?.from || r.originalFile || r.file;
    const record=state.record(from);
    const entry={file:from,identity:record.id,revision:record.revision,fingerprint:await fingerprint(from).catch(()=>null),result:structuredClone(r),decision:null};
    entry.extraLangs=workflowOptions(options.workflow).extraSubtitles?(config.subs?.extraLangs||[]).filter(l=>['zh-TW','en','ko'].includes(l)):[];
    entry.assets=await diskAssets(from,r.meta?.durationSec);
    entry.targets={};
    for(const target of targetsFor(entry)) entry.targets[target]=await fingerprint(target).catch(()=>null);
    plan.entries.push(entry);
  }
  // Reserve video and all sidecar paths together, case-insensitively.
  plan.requestDigest=digest(requestContract(options));
  plan.scopeDigest=digest(plan.entries.map(e=>path.resolve(e.file)).sort());
  const seen=new Map();
  for(const e of plan.entries) for(const target of targetsFor(e)) {
    const key=target.toLowerCase();
    if(seen.has(key) && seen.get(key)!==e) {e.result.rename && (e.result.rename.batchConflict=true);const other=seen.get(key);other.result.rename && (other.result.rename.batchConflict=true);}
    else seen.set(key,e);
  }
  report.planId=plan.id; report.planRevision=0;
  for(let i=0;i<report.results.length;i++) report.results[i].rename=plan.entries[i].result.rename;
  for(const e of plan.entries) {
    const row=state.getFile(e.file);
    if(row?.data?.stage==='plan')state.upsertFile(e.file,{data:{...row.data,rename:e.result.rename,planId:plan.id}});
  }
  await savePlan(config,plan); return plan;
}
function targetsFor(e) {
  const r=e.result, video=r.rename?.to || e.file, stem=video.slice(0,-path.extname(video).length);
  return [video,...(r.sub?.targetPath?[stem+'.srt']:[]),...(e.extraLangs||[]).map(l=>stem+'.'+l+'.srt'),...(r.coverPlanned?[stem+'.jpg',stem+'.png',stem+'.webp']:[]),...(r.coverPlanned?.alsoPoster?['jpg','png','webp'].map(ext=>path.join(path.dirname(video),'poster.'+ext)):[])];
}
function conflict(e) {return e.result.rename && (e.result.rename.batchConflict || ['skip_conflict','skip_duplicate'].includes(e.result.rename.action) || e.result.rename.reason==='renamed_conflict');}
export async function resolveConflicts(plan,decisions) {
  const reservations=new Set();
  for(const e of plan.entries) if(!conflict(e) && !decisions[e.file] && !e.result.skipOperation) for(const target of targetsFor(e))reservations.add(target.toLowerCase());
  for(const e of plan.entries) {
    const d=decisions[e.file];
    if(!conflict(e) && !d)continue;
    if(!d && conflict(e) && !e.decision) continue;
    if(d?.strategy==='skip') { e.decision=d; e.result.rename={from:e.file,to:e.file,action:'skip_user'};e.result.skipOperation=true;e.targets={[e.file]:await fingerprint(e.file)};continue; }
    let target=e.result.rename?.to || e.file;
    if(d) {
      const ext=path.extname(e.file);
      let name=d.strategy==='custom'?String(d.name||''):path.basename(target);
      if(!name.toLowerCase().endsWith(ext.toLowerCase())) name+=ext;
      if(!name || sanitizeFileName(name,230)!==name || name.length>230) throw new Error('invalid_windows_name');
      target=path.join(path.dirname(e.file),name);
      if(d.strategy==='suffix') {
        const stem=name.slice(0,-ext.length).replace(/ \(\d+\)$/,'');let n=2;
        const busy=async()=>{const probe={...e,result:{...e.result,rename:{...e.result.rename,to:target}}};for(const t of targetsFor(probe))if(reservations.has(t.toLowerCase()) || (t.toLowerCase()!==e.file.toLowerCase() && await fs.stat(t).catch(()=>null)))return true;return false;};
        while(await busy()) {if(n>1000)throw new Error('no_available_suffix');target=path.join(path.dirname(e.file),`${stem} (${n++})${ext}`);}
      }
      if(target.length>245) throw new Error('path_too_long');
      e.result.rename={from:e.file,to:target,action:target===e.file?'skip_same':'rename'};
      e.result.newName=path.basename(target);e.decision=d;e.result.skipOperation=false;
      const stem=target.slice(0,-ext.length);
      if(e.result.sub?.targetPath)e.result.sub.targetPath=stem+'.srt';
      if(e.result.coverPlanned)e.result.coverPlanned.targetPath=stem+(e.result.coverPlanned.localPath?path.extname(e.result.coverPlanned.localPath):'.jpg');
    }
    for(const t of targetsFor(e)) {
      if(reservations.has(t.toLowerCase())) throw new Error('duplicate_target_in_batch');
      if(d && t!==e.file && await fs.stat(t).catch(()=>null)) throw new Error('target_occupied');
      reservations.add(t.toLowerCase());
    }
    if(d) {e.targets={}; for(const t of targetsFor(e))e.targets[t]=await fingerprint(t).catch(()=>null);}
  }
  plan.revision++; return plan;
}
export async function validatePlan(plan,state) {
  const reasons=[];
  for(const e of plan.entries) {
    const rec=state.record(e.file), current=await fingerprint(e.file).catch(()=>null);
    if(rec.id!==e.identity || rec.revision!==e.revision)reasons.push({file:e.file,reason:'correction_changed'});
    if(JSON.stringify(current)!==JSON.stringify(e.fingerprint))reasons.push({file:e.file,reason:'source_changed'});
    if(conflict(e) && !e.decision) reasons.push({file:e.file,reason:'conflict_unresolved'});
    for(const [t,fp]of Object.entries(e.targets)) if(JSON.stringify(await fingerprint(t).catch(()=>null))!==JSON.stringify(fp))reasons.push({file:e.file,reason:'target_changed',target:t});
    if(JSON.stringify(await diskAssets(e.file,e.result.meta?.durationSec))!==JSON.stringify(e.assets))reasons.push({file:e.file,reason:'sidecars_changed'});
  }
  if(reasons.length) throw Object.assign(new Error('NEEDS_REVIEW'),{code:'NEEDS_REVIEW',reasons});
  return true;
}
const escapeHTML=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function reportHTML(report,{english=false,theme='auto',fontSize=14}={}) {
  fontSize=Math.max(12,Math.min(20,Number(fontSize)||14));theme=['light','dark'].includes(theme)?theme:'auto';
  const tr=(zh,en)=>english?en:zh;
  const labels={ok:tr('处理完成','Completed'),error:tr('执行失败','Failed'),no_subtitle:tr('缺少可用中字','No usable Chinese subtitle'),no_code:tr('未识别番号','Unrecognized code'),unresolved:tr('资料未确认','Metadata unresolved'),out_of_scope:tr('范围外，跳过','Out of scope'),skipped:tr('已跳过','Skipped'),interrupted:tr('中断前已处理','Processed before interruption'),metadata:tr('元数据','Metadata'),rename:tr('文件名','Filename'),subtitles:tr('主字幕','Primary subtitle'),covers:tr('封面','Cover'),extraSubtitles:tr('附加字幕','Additional subtitles'),all:tr('本项','Item'),completed:tr('已完成','Completed'),preserved:tr('保留','Preserved'),disabled:tr('未启用','Disabled'),fill_missing:tr('仅填空值','Filled empty fields only'),resolved:tr('采用已解析资料','Resolved metadata'),planned:tr('待执行','Planned'),not_found:tr('无可用来源','No usable source'),not_available:tr('未找到可用内容','No usable asset found'),blocked:tr('尚未执行','Not executed'),failed:tr('失败','Failed'),skip_same:tr('名称相同，保留','Same filename, preserved'),skip_user:tr('用户选择跳过','Skipped by user'),skip_duplicate:tr('疑似重复，待确认','Suspected duplicate'),skip_conflict:tr('名称冲突，待确认','Name conflict'),titleJa:tr('日文标题','Japanese title'),titleZh:tr('中文标题','Chinese title'),actress:tr('出演','Performers'),releaseDate:tr('发行日期','Release date'),maker:tr('厂牌','Studio'),coverUrl:tr('封面地址','Cover URL'),code:tr('番号','Code')};
  const label=k=>labels[k]||k, base=p=>String(p||'').split(/[\\/]/).pop();
  const fileLink=(p,text)=>p?`<span title="${escapeHTML(p)}">${escapeHTML(text||base(p))}</span>`:'';
  const pathDetails=paths=>paths.filter(Boolean).length?`<details><summary>${tr('完整路径','Full paths')}</summary>${paths.filter(Boolean).map(p=>'<div class="path">'+escapeHTML(p)+'</div>').join('')}</details>`:'';
  const rows=(report.results||[]).map(r=>{
    const writes=!!(r.renamedTo||r.sub?.writtenBytes||r.cover?.bytes||r.extraSubs?.length),failure=r.status==='error'||!!r.cover?.error;
    const subtitle=report.apply?r.sub?.writtenBytes?tr('已写入','Written')+' · '+fileLink(r.sub.path):r.sub?.source==='existing'?tr('保留有效字幕','Valid subtitle preserved'):r.actions?.subtitles?escapeHTML(label(r.actions.subtitles)):tr('未记录写入','No recorded write'):r.sub?.targetPath?tr('计划安装','Planned install')+' · '+fileLink(r.sub.targetPath):r.sub?.source==='existing'?tr('保留有效字幕','Valid subtitle preserved'):escapeHTML(label(r.actions?.subtitles||'not_available'));
    const cover=report.apply?r.cover?.bytes?tr('已写入','Written')+' · '+fileLink(r.cover.path):r.cover?.preserved?tr('保留有效图片','Valid cover preserved'):r.cover?.error?escapeHTML(r.cover.error):r.actions?.covers?escapeHTML(label(r.actions.covers)):tr('未记录写入','No recorded write'):r.coverPlanned?.targetPath?tr('计划下载','Planned download')+' · '+fileLink(r.coverPlanned.targetPath):escapeHTML(label(r.actions?.covers||'not_available'));
    const locks=Object.entries(r.locks||{}).filter(([,v])=>v.locked).map(([k])=>label(k));
    const notes=[r.error||r.rename?.reason,...Object.entries(r.actions||{}).map(([k,v])=>label(k)+' · '+(k==='rename'&&v==='rename'?tr('计划改名','Planned rename'):label(v))),locks.length?tr('锁定：','Locked: ')+locks.join('、'):null].filter(Boolean);
    const paths=[r.originalFile||r.rename?.from||r.file,r.renamedTo||(!report.apply?r.rename?.to:null),report.apply?r.sub?.path:r.sub?.targetPath,report.apply?r.cover?.path:r.coverPlanned?.targetPath,...(r.backups||[]),...(r.extraSubs||[]).map(s=>s.path)];
    return `<tr data-kind="${failure?'failure':writes?'write':'preserved'}"><td><strong>${escapeHTML(r.name||base(r.originalFile||r.file))}</strong>${r.code?'<br><small>'+escapeHTML(r.code)+'</small>':''}</td><td>${r.renamedTo?fileLink(r.renamedTo):!report.apply&&r.rename?.to?fileLink(r.rename.to):tr('文件名保留','Filename preserved')}</td><td><span class="status ${failure?'failure':''}">${escapeHTML(label(r.status))}</span></td><td>${subtitle}${r.sub?.source?'<br><small>'+escapeHTML(tr('来源：','Source: ')+r.sub.source)+'</small>':''}${r.extraSubs?.length?'<p>'+tr('附加字幕：','Additional subtitles: ')+r.extraSubs.map(s=>escapeHTML(s.lang)+' · '+fileLink(s.path)).join('<br>')+'</p>':''}</td><td>${cover}${r.cover?.posterPath?'<br>'+tr('海报：','Poster: ')+fileLink(r.cover.posterPath):''}</td><td>${notes.map(n=>'<div>'+escapeHTML(n)+'</div>').join('')||tr('未记录其他操作','No further actions recorded')}${r.backups?.length?'<p>'+tr('备份：','Backups: ')+r.backups.map(p=>fileLink(p)).join('<br>')+'</p>':''}${pathDetails([...new Set(paths)])}</td></tr>`;
  }).join('');
  const summary=Object.entries(report.summary||{}).map(([k,v])=>`<span class="metric"><strong>${escapeHTML(v)}</strong> ${escapeHTML(label(k))}</span>`).join('');
  return `<!doctype html><html lang="${english?'en':'zh-CN'}" data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AVC ${tr('任务报告','Run report')}</title><style>body{background:#faf5f7;color:#332b32;font:${fontSize}px/1.7 system-ui;margin:24px}h1{color:#a64668;font-size:1.85em;margin-bottom:8px}main{max-width:1400px;margin:auto}.intro,.summary{overflow-wrap:anywhere}.summary{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.metric{padding:9px 16px;background:#fff;border:1px solid #e6d4dc;border-radius:12px}.metric strong{font-size:1.4em;color:#a64668;margin-right:6px}.table-wrap{overflow-x:auto;border:1px solid #e6d4dc;border-radius:12px}table{width:100%;min-width:800px;border-collapse:collapse;background:white}td,th{padding:13px 12px;text-align:left;border-bottom:1px solid #ecdfe5;overflow-wrap:anywhere;vertical-align:top}th{background:#f8edf2;white-space:nowrap}td:nth-child(1),td:nth-child(2){width:18%}td:last-child{width:25%}button{font:inherit;color:inherit;padding:7px 12px;margin:4px;background:#fff;border:1px solid #dcbccc;border-radius:8px;cursor:pointer}small{color:#756570}details{font-size:.86em;color:#756570;margin-top:8px}.path{margin:5px 0;overflow-wrap:anywhere}.status{color:#754254;white-space:nowrap}.failure{color:#b03d53}@media(max-width:650px){body{margin:12px}h1{font-size:22px}}html[data-theme=dark] body{background:#231d24;color:#eedee6}html[data-theme=dark] :is(table,.metric,button){background:#302631;color:inherit}html[data-theme=dark] th{background:#3b2b39}html[data-theme=dark] :is(.metric,button,.table-wrap,td,th){border-color:#604456}html[data-theme=dark] :is(small,details){color:#c5aab8}html[data-theme=dark] .status{color:#eeb5ce}html[data-theme=dark] :is(h1,.metric strong){color:#f0a4c6}@media(prefers-color-scheme:dark){html[data-theme=auto] body{background:#231d24;color:#eedee6}html[data-theme=auto] :is(table,.metric,button){background:#302631;color:inherit}html[data-theme=auto] th{background:#3b2b39}html[data-theme=auto] :is(.metric,button,.table-wrap,td,th){border-color:#604456}html[data-theme=auto] :is(small,details){color:#c5aab8}html[data-theme=auto] .status{color:#eeb5ce}html[data-theme=auto] :is(h1,.metric strong){color:#f0a4c6}}@media print{button{display:none}body{margin:0;background:white}.table-wrap{overflow:visible;border:0}table{min-width:0}thead{display:table-header-group}tr{break-inside:avoid}details{display:none}}</style><main><h1>AVC · ${report.apply?tr('执行报告','Execution report'):tr('预演报告','Preview report')}</h1><p class="intro">${escapeHTML(report.dir)}<br><small>${escapeHTML(new Date(report.startedAt).toLocaleString(english?'en':'zh-CN'))}${report.partial?' · '+tr('中断后的部分结果','Partial results after interruption'):''}</small></p><div class="summary">${summary}</div><p class="intro"><small>${tr('本页记录任务当时的结果；旧报告中缺少的信息显示为未记录。撤销日志：','This page records the task snapshot. Missing legacy facts are not inferred. Undo journal: ')}${escapeHTML(report.journal||tr('无','None'))}</small></p><p>${['all','failure','write','preserved'].map((v,i)=>`<button onclick="filter('${v}')">${tr(['全部','失败','有写入','保留 / 跳过'][i],['All','Failures','Writes','Preserved / skipped'][i])}</button>`).join('')}<button onclick="print()">${tr('打印 / PDF','Print / PDF')}</button></p><div class="table-wrap"><table><thead><tr>${[tr('原文件','Original'),tr('目标 / 结果','Destination / result'),tr('状态','Status'),tr('字幕','Subtitle'),tr('封面','Cover'),tr('说明 / 操作','Notes / actions')].map(x=>'<th>'+x+'</th>').join('')}</tr></thead><tbody>${rows}</tbody></table></div></main><script>function filter(k){document.querySelectorAll('tbody tr').forEach(r=>r.hidden=k!=='all'&&r.dataset.kind!==k)}</script></html>`;
}
