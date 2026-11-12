// Optional real-browser regression check. No browser package is shipped with AVC.
// Use an installed Playwright package or set AVC_PLAYWRIGHT_PATH to its location.
// The backend/config/database and browser storage used here are all disposable.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AVC_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const currentVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'docs/screenshots/local/more-effects');
const scratch = await fs.mkdtemp(path.join(root, 'tmp-effects-qa-'));
const checks = [], errors = [], external = [], failedResponses = [];
let server, browser;
const check = (name, result = true) => { assert.ok(result, name); checks.push(name); console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = async page => {
  await page.waitForFunction(() => !document.documentElement.classList.contains('effects-native-switch'));
  await pause(650);
};
async function contextPage(options = {}, prefs = {}) {
  const context = await browser.newContext({ viewport:{width:1440,height:1000}, ...options });
  await context.addInitScript(({ values, version }) => {
    // Seed only new storage. Reloads must exercise the persisted user choices.
    if (!localStorage.getItem('avc.updates.dismissed')) localStorage.setItem('avc.updates.dismissed',version);
    if (!sessionStorage.getItem('effects-qa-seeded')) {
      Object.entries(values).forEach(([key,value]) => localStorage.setItem(key,value));
      sessionStorage.setItem('effects-qa-seeded','true');
    }
  }, { values: prefs, version: currentVersion });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`${msg.text()} ${msg.location().url}`); });
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:') && /^https?:/.test(request.url())) external.push(request.url()); });
  page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
  return { context, page };
}
async function open(page, view = 'work') {
  await page.goto(`http://127.0.0.1:${server.port}/#/${view}`);
  await page.waitForFunction(() => window.__AVC_TEST__ && document.querySelector('.effects-tab-indicator'));
  await settle(page);
}
async function snapshot(page, name) { await pause(300); await page.screenshot({path:path.join(output,`${name}.png`)}); }
async function navigate(page, view) {
  await page.locator(`#tabs [data-view="${view}"]`).click();
  await page.waitForFunction(v => document.documentElement.dataset.effectsView === v, view);
  await settle(page);
}
async function mode(page, value) {
  const current = await page.evaluate(() => document.documentElement.dataset.effects === 'on');
  if (current !== value) await page.evaluate(() => document.getElementById('btnEffects').click());
  await page.waitForFunction(v => document.documentElement.dataset.effects === (v?'on':'off'), value);
  await settle(page);
}
async function coverage(page, label) {
  const sizes = await page.evaluate(() => ({viewport:innerWidth,width:document.documentElement.scrollWidth}));
  check(`${label}: no horizontal overflow`,sizes.width <= sizes.viewport + 1);
  const tabs = await page.locator('#tabs .tab').evaluateAll(elements => elements.map(el => ({r:el.getBoundingClientRect().toJSON(), text:el.scrollWidth,client:el.clientWidth})));
  check(`${label}: navigation visible`,tabs.every(x=>x.r.left>=0 && x.r.right<=sizes.viewport+1 && x.r.width>0 && x.text<=x.client+1));
}

try {
  await fs.mkdir(output,{recursive:true});
  const config=JSON.parse(await fs.readFile(path.join(root,'config.example.json'),'utf8'));
  config.paths={...config.paths,dataDir:path.join(scratch,'data'),outDir:path.join(scratch,'out')};
  const configFile=path.join(scratch,'config.json'); await fs.writeFile(configFile,JSON.stringify(config));
  server=await startServer({port:0,quiet:true,configFile});
  browser=await chromium.launch({channel:process.env.AVC_BROWSER_CHANNEL || 'msedge',headless:true});

  const {context,page}=await contextPage();
  const pictureRequests=[];page.on('request',r=>{if(r.url().includes('/assets/effects/'))pictureRequests.push(r.url());});
  await open(page);
  check('fresh storage defaults to simple mode',await page.getAttribute('html','data-effects')==='off');
  check('background assets are not fetched while never enabled',pictureRequests.length===0);
  check('button uses experimental label',await page.locator('#btnEffects').innerText()==='更多动效（实验中）');
  check('simple mode exposes theme and custom appearance',await page.locator('#btnTheme').isVisible() && await page.locator('#bgBtn').isVisible());
  await snapshot(page,'simple');
  await page.locator('#dir').fill('D:\\UI 检查\\尚未提交');
  await page.evaluate(()=>{
    const ui=window.__AVC_TEST__,state=ui.state;
    state.items=Array.from({length:7},(_,i)=>({path:`D:/UI-preview/DEMO-${100+i}.mp4`,name:`DEMO-${100+i} 示例文件.mp4`,code:`DEMO-${100+i}`,size:734003200+i*1024,status:['scanned','error','no_subtitle','skipped'][i%4]}));
    state.itemByPath=new Map(state.items.map(item=>[item.path,item]));
    state.selected=new Set([state.items[0].path,state.items[2].path]);
    state.job={id:'presentation-check',status:'running'};state.running=true;
    ui.renderList();
    window.effectsQaIdentity={items:state.items,selected:state.selected,job:state.job,dir:document.getElementById('dir'),scroll:0};
  });
  await mode(page,true);
  check('enhanced mode hides theme and custom appearance',!(await page.locator('#btnTheme').isVisible()) && !(await page.locator('#bgBtn').isVisible()));
  await snapshot(page,'work-list');
  check('input, selection and running-task identities survive entry',await page.evaluate(()=>{
    const s=window.__AVC__.state||window.__AVC__,o=window.effectsQaIdentity;
    return s.items===o.items && s.selected===o.selected && s.selected.size===2 && s.job===o.job && s.running && document.getElementById('dir')===o.dir && o.dir.value==='D:\\UI 检查\\尚未提交';
  }));
  await page.evaluate(()=>{scrollTo({top:240,behavior:'instant'});window.effectsQaIdentity.scroll=scrollY;});
  await mode(page,false);
  const scrollState=await page.evaluate(()=>({before:window.effectsQaIdentity.scroll,after:scrollY,sameTask:window.__AVC__.job===window.effectsQaIdentity.job}));
  console.log('scroll check',scrollState);
  check('mode switch preserves page scroll and selected task',scrollState.before===scrollState.after && scrollState.sameTask);
  await mode(page,true);
  await page.evaluate(()=>{window.__AVC__.running=false;window.__AVC__.job=null;window.__AVC__.items=[];window.__AVC__.itemByPath=new Map();window.__AVC__.selected=new Set();window.__AVC_TEST__.renderList();scrollTo(0,0);});
  for(const view of ['work','history','assembly','settings']) {
    await navigate(page,view);
    await snapshot(page,view);
    check(`${view}: one matching active atmosphere`,await page.evaluate(v=>{
      const scenes=[...document.querySelectorAll('.effects-scene')];
      return scenes.filter(s=>s.classList.contains('is-current')).length===1 && document.querySelector('.effects-scene.is-current').dataset.scene===v && document.querySelector(`.effects-scene[data-scene="${v}"]`).dataset.image==='ready' && scenes.filter(s=>!s.classList.contains('is-current')).every(s=>getComputedStyle(s.querySelector('.effects-light')).animationPlayState==='paused');
    },view));
    await coverage(page,view);
  }
  await page.locator('#ver').click();
  check('native release dialog works in enhanced mode',await page.locator('#updatesDialog').isVisible());
  await snapshot(page,'release-dialog');
  await page.keyboard.press('Escape');
  await navigate(page,'assembly');
  await page.locator('#view-assembly .asm-tools').first().click();
  check('assembly tool settings dialog opens',await page.locator('#asm-settings').isVisible());
  check('assembly dialog action footer fits inside its frame',await page.locator('#asm-settings').evaluate(el=>el.querySelector('.asm-settings-foot').getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom-10));
  await snapshot(page,'assembly-dialog');await page.keyboard.press('Escape');
  await navigate(page,'work');
  await page.locator('#dir').fill(scratch);
  await page.locator('#btnPick').click();
  await page.waitForFunction(()=>document.querySelector('#fsModal').classList.contains('open') && !document.querySelector('#fsList').textContent.includes('加载中'));
  check('directory browser opens without scanning or altering files',await page.locator('#fsModal').isVisible());
  await snapshot(page,'directory-dialog');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{for(let i=0;i<8;i++)document.querySelector('#btnEffects').click();});
  await settle(page);
  check('rapid even-numbered toggles keep final requested state',await page.getAttribute('html','data-effects')==='on');
  await page.evaluate(()=>{for(const view of ['history','work','assembly','history','settings'])window.__AVC_TEST__.showView(view);});
  await page.waitForFunction(()=>document.documentElement.dataset.effectsView==='settings');
  await settle(page);
  check('rapid routing discards stale backgrounds',await page.locator('.effects-scene.is-current').getAttribute('data-scene')==='settings');
  await page.reload();await page.waitForFunction(()=>document.querySelector('.effects-tab-indicator'));await settle(page);
  check('saved mode and direct route restore together',await page.getAttribute('html','data-effects')==='on' && await page.getAttribute('html','data-effects-view')==='settings' && await page.locator('#view-settings').isVisible());
  check('restored mode applies glass and dark panel material on first entry',await page.evaluate(()=>getComputedStyle(document.querySelector('#tabs')).backgroundImage!=='none' && getComputedStyle(document.querySelector('#view-settings .panel')).backgroundImage!=='none'));
  // Headless Chromium treats every page as foreground. Exercise the actual
  // window event handlers directly rather than claiming OS focus was changed.
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  check('window blur handler pauses background animations',await page.locator('html').evaluate(el=>el.classList.contains('effects-paused')));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  check('window focus handler resumes background animations',!(await page.locator('html').evaluate(el=>el.classList.contains('effects-paused'))));
  await page.emulateMedia({reducedMotion:'reduce'});await pause(80);
  check('reduced-motion removes particles',await page.locator('.effects-scene.is-current .effects-atmosphere').evaluate(el=>getComputedStyle(el).display==='none'));
  await snapshot(page,'reduced-motion');
  await context.close();

  // Exercise restoration with non-default material, time/theme and wallpaper.
  const custom=JSON.stringify({mode:'custom',zoom:137,x:36,y:64,image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',strength:63,material:'glass',opacity:83,glassBlur:17,petals:'medium',timeMode:'night',nightTheme:true,rotation:'5'});
  const restore=await contextPage({}, {'avc.appearance.v2':custom,'avc.theme.v1':'auto'});
  await open(restore.page);
  const before=await restore.page.evaluate(()=>({style:document.documentElement.style.cssText,prefs:localStorage.getItem('avc.appearance.v2'),theme:document.documentElement.dataset.theme}));
  await mode(restore.page,true);
  check('legacy petals are suspended',await restore.page.locator('#petals').evaluate(el=>el.childElementCount===0));
  const palette=await restore.page.evaluate(()=>getComputedStyle(document.body).color);
  await restore.page.emulateMedia({colorScheme:'light'});
  check('enhanced palette is independent of system day/night',await restore.page.evaluate(()=>getComputedStyle(document.body).color)===palette);
  await mode(restore.page,false);
  const after=await restore.page.evaluate(()=>({style:document.documentElement.style.cssText,prefs:localStorage.getItem('avc.appearance.v2'),theme:document.documentElement.dataset.theme}));
  check('custom image, material and night-theme preference restore',before.style===after.style && before.prefs===after.prefs && before.theme===after.theme);
  check('legacy weather resumes at original density',await restore.page.locator('#petals').evaluate(el=>el.childElementCount===30));
  await restore.context.close();

  const english=await contextPage({}, {'avc.effects.v1':'on','avc.ui.v1':JSON.stringify({language:'en',fontSize:20})});
  await open(english.page,'settings');
  check('English experimental copy follows language preference',await english.page.locator('#btnEffects').innerText()==='More effects (experimental)');
  check('saved enhanced material also initializes with English and 20px font',await english.page.locator('#view-settings .panel').first().evaluate(el=>getComputedStyle(el).backgroundImage!=='none'));
  for(const width of [1440,1024,768,390]) {
    await english.page.setViewportSize({width,height:1000});
    for(const view of ['work','history','assembly','settings']) {
      await navigate(english.page,view);await coverage(english.page,`English 20px ${width}px ${view}`);
    }
    await snapshot(english.page,`english-20px-${width}`);
    if(width===390) {
      await navigate(english.page,'assembly');
      await english.page.locator('#view-assembly .asm-tools').first().click();
      check('English 20px narrow dialog footer remains fully visible',await english.page.locator('#asm-settings').evaluate(el=>el.querySelector('.asm-settings-foot').getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom-10));
      await snapshot(english.page,'english-20px-390-dialog');await english.page.keyboard.press('Escape');
    }
  }
  await english.context.close();

  const fallback=await contextPage({}, {'avc.effects.v1':'on'});
  await fallback.page.addInitScript(()=>{document.startViewTransition=undefined;});
  await open(fallback.page);await mode(fallback.page,false);await mode(fallback.page,true);
  check('mode switching works without native view transitions',await fallback.page.getAttribute('html','data-effects')==='on');
  await fallback.page.emulateMedia({reducedMotion:'reduce'});await mode(fallback.page,false);await mode(fallback.page,true);
  check('reduced-motion toggle keeps static enhanced styling',await fallback.page.locator('#btnTheme').isHidden() && await fallback.page.locator('.effects-scene.is-current .effects-atmosphere').evaluate(el=>getComputedStyle(el).display==='none'));
  await fallback.context.close();
  check('no browser script/console errors',errors.length===0);
  check('no failed HTTP resources',failedResponses.length===0);
  check('no external HTTP requests',external.length===0);
} catch(error) {
  console.error(error);
  if(browser) for(const context of browser.contexts()) for(const page of context.pages()) {
    await page.screenshot({path:path.join(output,'check-failure.png')}).catch(()=>{});
    const overflow=await page.evaluate(()=>[...document.querySelectorAll('.shell *')].filter(el=>el.getClientRects().length && el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,id:el.id,class:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}))).catch(()=>[]);
    console.error('layout context',page.url(),overflow);
  }
  process.exitCode=1;
} finally {
  console.log(JSON.stringify({checks:checks.length,errors,external,failedResponses},null,2));
  await fs.writeFile(path.join(output,'checks.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,errors,external,failedResponses,passed:!process.exitCode},null,2)).catch(()=>{});
  await browser?.close();await server?.close();
  // Only this mkdtemp directory is removed; the user's config/data are untouched.
  if(path.dirname(path.resolve(scratch))===root && path.basename(scratch).startsWith('tmp-effects-qa-')) await fs.rm(scratch,{recursive:true,force:true});
}
