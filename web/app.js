import { t, getLocale, onLocaleChange } from './i18n.js';
import { initAssembly } from './assembly.js';
let assemblyUi = null;
import { initWorkflows } from './workflow.js';
let workflows = null;
import { initMaintenance } from './maintenance.js';
import { initWorkPanel } from './work-panel.js';
let maintenanceUi = null;
import { initAppearance } from './appearance.js';
import { initEffects } from './effects.js';
let effectsUi = null;
import { initUpdates } from './updates.js';
import { initSakura } from './sakura.js';
import { initUiPreferences } from './preferences.js';
// AVC 正式界面 · 零依赖前端逻辑（对接 docs/SERVICE_API.md）
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  dir: '',
  items: [],            // 扫描结果（与 file-done 合并）
  itemByPath: new Map(),
  job: null,            // 当前任务
  es: null,
  running: false,
  lastPlan: null,       // 最近一次成功的 plan 报告
  config: null,
  backoff: 0,
  logs: [],
  manualCodes: {},      // 用户手动补录的番号：path -> raw input
  selected: new Set(),  // 勾选参与预演/应用的文件路径
  total: 0,             // 本任务文件总数（start 事件）
  progressDone: 0,      // 本任务已处理数（含 file-skipped）
  starting: false,      // 正在创建任务（防重复提交）
  finishedJobId: null,  // 已收尾的任务 id（snapshot + job-finished 只处理一次）
  esErrors: 0,          // SSE 连续中断次数（>=3 显示「重新同步」）
  drawerPath: '',       // 当前详情抽屉的文件路径
  filter: { q: '', statuses: new Set(), sort: 'name' }, // F10 列表筛选/排序（纯前端）
  queued: 0,            // 后端排队任务数（/api/health.queued）
  jobStartedAt: null,   // 当前任务开始时间（B6 ETA 用）
  lastJobStats: null,   // 最近任务 { durationMs, count }（B5 预计耗时用）
  density: 'comfort',   // B16 列表密度：comfort | compact
  cols: { date: true, maker: true, duration: true, size: true }, // B16 行内显示列
};

const BASE_TITLE = 'AVC 补全器';
const FLT_KEY = 'avc.flt.v1'; // B2 筛选/排序持久化

/** B2：读取/保存/清除筛选排序（刷新后恢复） */
function loadFilterPrefs() {
  try {
    const raw = localStorage.getItem(FLT_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return;
    state.filter.q = typeof p.q === 'string' ? p.q : '';
    state.filter.sort = ['name', 'code', 'size', 'status'].includes(p.sort) ? p.sort : 'name';
    state.filter.statuses = new Set(Array.isArray(p.statuses) ? p.statuses.filter((x) => typeof x === 'string') : []);
  } catch { /* ignore */ }
}
function saveFilterPrefs() {
  try {
    localStorage.setItem(FLT_KEY, JSON.stringify({ q: state.filter.q, statuses: [...state.filter.statuses], sort: state.filter.sort }));
  } catch { /* ignore */ }
}
function clearFilterPrefs() {
  try { localStorage.removeItem(FLT_KEY); } catch { /* ignore */ }
}

// ---------------- SPEC5 Phase2：B14 hash 路由 / B15 主题 / B16 密度与列 ----------------
const THEME_KEY = 'avc.theme.v1';
const DENSITY_KEY = 'avc.density.v1';
const COLS_KEY = 'avc.cols.v1';
const VIEWS = ['work', 'history', 'assembly', 'settings'];
let themeMode = 'auto';
let timeTheme = null;

function viewFromHash(hash) {
  const m = /^#\/([a-z]+)$/.exec(String(hash || ''));
  return m && VIEWS.includes(m[1]) ? m[1] : null;
}
function currentView() {
  return VIEWS.find((v) => { const el = $('#view-' + v); return el && !el.classList.contains('hidden'); }) || 'work';
}
function updateHash(name) {
  try {
    if (typeof history !== 'undefined' && typeof history.replaceState === 'function') history.replaceState(null, '', '#/' + name);
    else if (typeof location !== 'undefined') location.hash = '#/' + name;
  } catch { /* ignore */ }
}

function preferredDark() {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}
function resolvedTheme() {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return timeTheme || (preferredDark() ? 'dark' : 'light');
}
function themeLabel() {
  return themeMode === 'auto' ? t('自动') : themeMode === 'light' ? t('浅色') : t('深色');
}
function applyTheme() {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (root) {
    const mode = resolvedTheme();
    if (root.dataset) root.dataset.theme = mode;
    else if (typeof root.setAttribute === 'function') root.setAttribute('data-theme', mode);
  }
  const btn = $('#btnTheme');
  if (btn) btn.textContent = t`主题：${themeLabel()}`;
}
function loadThemePref() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'auto' || t === 'light' || t === 'dark') themeMode = t;
  } catch { /* ignore */ }
  applyTheme();
}
function cycleTheme() {
  themeMode = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto';
  try { localStorage.setItem(THEME_KEY, themeMode); } catch { /* ignore */ }
  applyTheme();
  toast(t`主题：${themeLabel()}`);
}
function initTheme() {
  loadThemePref();
  if ($('#btnTheme')) $('#btnTheme').onclick = cycleTheme;
  try {
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', () => { if (themeMode === 'auto') applyTheme(); });
    }
  } catch { /* ignore */ }
}

/** B16：读取/保存密度与列显示偏好 */
function loadViewPrefs() {
  try {
    const d = localStorage.getItem(DENSITY_KEY);
    if (d === 'comfort' || d === 'compact') state.density = d;
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c && typeof c === 'object') {
        state.cols = { date: c.date !== false, maker: c.maker !== false, duration: c.duration !== false, size: c.size !== false };
      }
    }
  } catch { /* ignore */ }
  applyDensity();
  syncColsUi();
}
function saveDensity() {
  try { localStorage.setItem(DENSITY_KEY, state.density); } catch { /* ignore */ }
}
function saveCols() {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(state.cols)); } catch { /* ignore */ }
}
function applyDensity() {
  const body = typeof document !== 'undefined' ? document.body : null;
  if (body) {
    if (body.dataset) body.dataset.density = state.density;
    else if (typeof body.setAttribute === 'function') body.setAttribute('data-density', state.density);
  }
  const btn = $('#densityToggle');
  if (btn) btn.textContent = state.density === 'compact' ? t('紧凑') : t('舒适');
}
function syncColsUi() {
  const map = { '#colDate': 'date', '#colMaker': 'maker', '#colDuration': 'duration', '#colSize': 'size' };
  for (const [id, key] of Object.entries(map)) {
    const el = $(id);
    if (el) el.checked = state.cols[key] !== false;
  }
}
function toggleDensity() {
  state.density = state.density === 'compact' ? 'comfort' : 'compact';
  saveDensity();
  applyDensity();
  renderList();
  toast(state.density === 'compact' ? t('列表已切换为紧凑模式') : t('列表已切换为舒适模式'));
}
function setColVisible(key, on) {
  state.cols[key] = !!on;
  saveCols();
  syncColsUi();
  renderList();
}

/** B15：打开弹层时聚焦第一个可操作元素 */
function focusFirst(el) {
  if (!el) return;
  try {
    let f = null;
    for (const sel of ['button', '[tabindex]', 'input', 'select', 'textarea']) {
      f = el.querySelector(sel);
      if (f) break;
    }
    if (!f || typeof f.focus !== 'function') return;
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    const inside = ae && typeof el.contains === 'function' && el.contains(ae);
    if (!inside) f.focus();
  } catch { /* ignore */ }
}


const ROW_LIMIT = 2000; // F11：筛选后渲染行数上限（超出提示缩小范围）
const STATUS_ORDER = { error: 0, running: 1, ok: 2, no_subtitle: 3, unresolved: 4, out_of_scope: 5, no_code: 6, scanned: 7, skipped: 8 };

const STATUS = {
  scanned:      { get label() { return t('待预演'); },        cls: 's-skip' },
  ok:           { label: '✓ ok',        cls: 's-ok' },
  no_subtitle:  { get label() { return t('有元数据·无中字'); }, cls: 's-warn' },
  unresolved:   { get label() { return t('未确认番号'); },    cls: 's-warn' },
  out_of_scope: { get label() { return t('范围外'); },        cls: 's-skip' },
  no_code:      { get label() { return t('未识别'); },        cls: 's-skip' },
  error:        { get label() { return t('失败'); },          cls: 's-err' },
  running:      { get label() { return t('处理中'); },        cls: 's-run' },
  skipped:      { get label() { return t('已处理·跳过'); },    cls: 's-skip' },
};

// 状态 → 中文（历史页/摘要/终态统一使用）
const STATUS_TEXT = {
  get ok() { return t('成功'); }, get no_subtitle() { return t('无中字'); }, get unresolved() { return t('未确认'); }, get out_of_scope() { return t('范围外'); },
  get no_code() { return t('未识别'); }, get error() { return t('失败'); }, get skipped() { return t('跳过'); }, get scanned() { return t('待预演'); }, get running() { return t('处理中'); },
};
const JOB_STATUS_TEXT = { get queued() { return t('排队中'); }, get running() { return t('运行中'); }, get done() { return t('已完成'); }, get cancelled() { return t('已取消'); }, get aborted() { return t('已中止'); }, get failed() { return t('失败'); }, get needs_review() { return t('待复核'); } };
const RENAME_ACTION_TEXT = {
  get rename() { return t('将改名'); }, get skip_same() { return t('已是目标名'); }, get skip_conflict() { return t('目标名冲突'); },
  get skip_duplicate() { return t('目标处已有同大小文件'); }, get skip_exists() { return t('目标已存在'); }, get no_change() { return t('无需改名'); },
};

// 后端错误码 → 中文（§3.6）
const ERRMSG = {
  get dir_not_found() { return t('目录不存在'); },
  get dir_required() { return t('请填写视频目录'); },
  get fs_forbidden() { return t('目录不在允许范围内（检查 config.fs.allowedRoots）'); },
  get fs_disabled() { return t('文件浏览已被禁用'); },
  get file_required() { return t('缺少文件路径'); },
  get not_video() { return t('不是受支持的视频文件'); },
  get file_not_found() { return t('文件不存在'); },
  get task_running() { return t('任务运行中，完成后再试'); },
  get job_finished() { return t('任务已结束'); },
  get undo_failed() { return t('撤销失败'); },
  get invalid_config() { return t('配置无效'); },
  get report_not_ready() { return t('报告尚未生成'); },
  get body_too_large() { return t('请求体过大'); },
  get job_not_found() { return t('任务不存在'); },
  get path_required() { return t('缺少路径'); },
  get preview_failed() { return t('预演失败'); },
  get cover_fetch_failed() { return t('封面下载失败'); },
  get lookup_failed() { return t('反查失败（搜索服务不可用）'); },
  get keyword_required() { return t('请输入标题或演员名'); },
  get keyword_too_long() { return t('关键词太长（最多 200 字）'); },
  get cover_url_missing() { return t('该作品没有可用封面地址'); },
  get invalid_url() { return t('封面地址无效（仅支持 http/https）'); },
  get code_required() { return t('缺少番号（请先填写或在文件名里识别）'); },
  get candidate_required() { return t('缺少要安装的字幕候选'); },
  get subtitle_rejected() { return t('字幕被拒绝（文件结构或内容不合法）'); },
  get subtitles_failed() { return t('字幕服务出错'); },
  get not_found() { return t('接口不存在（后端版本可能较旧）'); },
  get invalid_template() { return t('模板无效（需为 ≤300 字符的字符串）'); },
  get invalid_backup() { return t('备份目录无效（需要包含 state.db）'); },
  get BODY_TOO_LARGE() { return t('请求体过大'); },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return v.toFixed(v < 10 ? 2 : 1) + ' ' + u[i];
};
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString(getLocale(), { hour12: false }) : '—';
/** 秒 → h:mm:ss（字幕末条结束时间等） */
const fmtDurationSec = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
};

// ---------------- 基础设施 ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, 3600);
}

/** 把后端错误码/异常转成中文文案（§3.6） */
function errText(e) {
  const body = e && e.body;
  const code = (body && body.error) || (e && e.code) || '';
  if (code && ERRMSG[code]) return t(ERRMSG[code]);
  if (body && body.message) return String(body.message).split('\n')[0];
  const msg = String((e && e.message) || e || t('未知错误'));
  return msg.split('\n')[0];
}
function toastErr(prefix, e) {
  const msg = errText(e);
  toast(prefix + (msg === prefix ? '' : '：' + msg), 'err');
}

/** 任务 summary（{ok:32,no_subtitle:2,...}）→ 中文摘要 */
function summaryText(summary) {
  if (!summary || typeof summary !== 'object') return '—';
  const order = ['ok', 'no_subtitle', 'unresolved', 'out_of_scope', 'no_code', 'error', 'skipped'];
  const parts = order.filter((k) => summary[k]).map((k) => `${t(STATUS_TEXT[k] || k)} ${summary[k]}`);
  return parts.length ? parts.join(' · ') : '—';
}

const pathBase = (p) => String(p || '').split(/[\\/]/).pop();
const pathDir = (p) => { const s = String(p || ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i > 0 ? s.slice(0, i) : s; };
const fmtClock = (ts) => { const d = new Date(Number(ts) || 0); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); };

// ---------------- 本轮任务选项（F5，localStorage 持久化） ----------------
const OPTS_KEY = 'avc.opts.v1';
const OPTS_DEFAULT = { force: false, downloadSubs: true, concurrency: 1, limit: 0, notify: false };

function readRunOpts() {
  try {
    const raw = localStorage.getItem(OPTS_KEY);
    if (!raw) return { ...OPTS_DEFAULT };
    return { ...OPTS_DEFAULT, ...JSON.parse(raw) };
  } catch { return { ...OPTS_DEFAULT }; }
}
function currentRunOpts() {
  const force = $('#optForce');
  const subs = $('#optDownloadSubs');
  const conc = $('#optConcurrency');
  const lim = $('#optLimit');
  const notify = $('#optNotify');
  return {
    force: !!(force && force.checked),
    downloadSubs: subs ? !!subs.checked : true,
    concurrency: Math.max(1, Math.min(4, Number(conc && conc.value) || 1)),
    limit: Math.max(0, Number(lim && lim.value) || 0),
    notify: !!(notify && notify.checked),
  };
}
function loadRunOpts() {
  const o = readRunOpts();
  if ($('#optForce')) $('#optForce').checked = !!o.force;
  if ($('#optDownloadSubs')) $('#optDownloadSubs').checked = o.downloadSubs !== false;
  if ($('#optConcurrency')) $('#optConcurrency').value = String(o.concurrency || 1);
  if ($('#optLimit')) $('#optLimit').value = String(o.limit || 0);
  if ($('#optNotify')) $('#optNotify').checked = !!o.notify;
}
function saveRunOpts() {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(currentRunOpts())); } catch { /* ignore */ }
}

/** B7：用户开始任务且开关开启时请求通知权限 */
function maybeRequestNotify(enabled) {
  try {
    if (!enabled || typeof Notification === 'undefined') return;
    if (Notification.permission === 'default' && typeof Notification.requestPermission === 'function') {
      const p = Notification.requestPermission();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch { /* ignore */ }
}

/** B7：任务终态发送浏览器通知（需已授权且开关开启） */
function notifyJobFinished(kind, job) {
  try {
    if (!readRunOpts().notify) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const label = kind === 'apply' ? t('应用') : t('预演');
    let body = '';
    if (job.status === 'done') body = t`${label}完成：${summaryText(job.summary)}`;
    else {
      const first = job.error ? String(job.error).split('\n')[0] : '';
      body = `${label}${JOB_STATUS_TEXT[job.status] || job.status || t('结束')}${first ? '：' + first : ''}`;
    }
    new Notification(t('AVC 补全器'), { body });
  } catch { /* ignore */ }
}

// ---------------- 预演计划（lastPlan）与变更预览（F1/F2） ----------------
function invalidatePlan() {
  state.lastPlan = null;
  clearPlanSummary();
  updateStats();
}
function clearPlanSummary() {
  const box = $('#planSummary');
  if (!box) return;
  box.classList.add('hidden');
  box.innerHTML = '';
}
function isRenameResult(r) {
  return r.rename?.action === 'rename' || (!r.rename && r.newName && r.newName !== r.name);
}
function planCounts(rep) {
  const results = Array.isArray(rep && rep.results) ? rep.results : [];
  const c = { count: results.length, rename: 0, ok: 0, no_subtitle: 0, unresolved: 0, out_of_scope: 0, no_code: 0, error: 0, skipped: 0, conflict: 0, subs: 0, covers: 0 };
  for (const r of results) {
    const st = r.status || 'unresolved';
    if (st in c) c[st]++;
    if (isRenameResult(r)) c.rename++;
    if (r.rename && (r.rename.batchConflict || r.rename.reason || ['skip_conflict','skip_duplicate'].includes(r.rename.action))) c.conflict++;
    if (r.sub) c.subs++;
    if (r.coverPlanned || r.cover) c.covers++;
  }
  c.duplicates = state.items.filter((it) => it.duplicates?.length).length;
  return c;
}
/** 预演完成后在列表上方渲染「变更预览」卡片 */
function renderPlanSummary() {
  const box = $('#planSummary');
  if (!box) return;
  const rep = state.lastPlan;
  if (!rep) { clearPlanSummary(); return; }
  const c = planCounts(rep);
  const entries = [
    [t('将改名'), c.rename, 'ok'],
    [t('成功'), c.ok, 'ok'],
    [t('无中字'), c.no_subtitle, 'warn'],
    [t('未确认'), c.unresolved, 'warn'],
    [t('范围外'), c.out_of_scope, 'skip'],
    [t('失败'), c.error, 'err'],
    [t('目标冲突'), c.conflict, 'err'],
    [t('重复番号'), c.duplicates, 'warn'],
  ];
  if (c.skipped) entries.push([t('跳过'), c.skipped, 'skip']);
  if (c.no_code) entries.push([t('未识别'), c.no_code, 'skip']);
  const pills = entries.filter(([, n]) => n > 0)
    .map(([label, n, cls]) => `<span class="ps-pill ${cls}">${esc(label)} <b>${n}</b></span>`).join('');
  box.innerHTML = t`
    <div class="ps-head">
      <strong>变更预览</strong>
      <span class="note" title="${esc(rep.dir || state.dir || '')}">${esc(rep.dir || state.dir || '')} · ${c.count} 个文件</span>
      <span class="grow"></span>
      ${c.conflict ? t('<button class="btn sm" data-resolve-conflicts>解决预演冲突</button>') : ''}
      <button class="btn sm" data-clear-plan>清除预览</button>
    </div>
    <div class="ps-pills">${pills || t('<span class="note">没有可应用的变更</span>')}</div>
    <div class="ps-note">将写入 <b>${c.subs}</b> 个字幕、<b>${c.covers}</b> 张封面（可在详情核对）；确认前不会改动任何文件。</div>
    ${c.conflict ? t('<div class="ps-note warn">有目标名冲突：请先打开「解决预演冲突」确认策略，或修改番号后重新预演。</div>') : ''}`;
  box.classList.remove('hidden');
  const resolve = $('[data-resolve-conflicts]', box);
  if (resolve) resolve.onclick = () => workflows?.openConflicts();
  const clear = $('[data-clear-plan]', box);
  if (clear) clear.onclick = () => { state.lastPlan = null; clearPlanSummary(); updateStats(); toast(t('已清除预览')); };
}

function confirmDialog(title, text, okLabel = t('确定')) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmYes').textContent = okLabel;
    $('#confirmModal').classList.add('open');
    focusFirst($('#confirmModal'));
    const done = (v) => {
      $('#confirmModal').classList.remove('open');
      $('#confirmYes').onclick = null;
      $('#confirmNo').onclick = null;
      resolve(v);
    };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

function setPill(kind, text) {
  const pill = $('#pill');
  pill.className = 'pill' + (kind ? ' ' + kind : '');
  pill.innerHTML = `<i></i>${esc(text)}`;
}

// ---------------- 日志（F11：rAF 批量追加 / DOM 上限 500 / 仅贴底时跟随 / 只看错误） ----------------
const LOG_DOM_MAX = 500;   // DOM 节点上限（超出删最旧）
const LOG_MEM_MAX = 1000;  // 内存保留行数（切换「只看错误」时用于重建）
let logQueue = [];
let logRaf = 0;
let logHasContent = false;

const scheduleFrame = typeof requestAnimationFrame === 'function'
  ? (fn) => requestAnimationFrame(fn)
  : (fn) => setTimeout(fn, 16);

function logLine(line, cls = '') {
  state.logs.push({ line, cls });
  if (state.logs.length > LOG_MEM_MAX) state.logs.splice(0, state.logs.length - LOG_MEM_MAX);
  logQueue.push({ line, cls });
  if (logRaf) return;
  logRaf = scheduleFrame(flushLog);
}

function logErrOnlyChecked() {
  const cb = $('#logErrOnly');
  return !!(cb && cb.checked);
}

/** 只有滚动条在底部附近时才自动跟随，避免用户回看日志时被拽走 */
function nearLogBottom(box) {
  if (!box) return true;
  try {
    if (!box.scrollHeight) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  } catch { return true; }
}

/** rAF 批量：一次帧回调里把所有排队日志插入 DOM */
function flushLog() {
  logRaf = 0;
  const box = $('#log');
  const queue = logQueue;
  logQueue = [];
  if (!box) return;
  const onlyErr = logErrOnlyChecked();
  const stick = nearLogBottom(box) || !logHasContent;
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const item of queue) {
    if (onlyErr && item.cls !== 'er') continue;
    const div = document.createElement('div');
    if (item.cls) div.className = item.cls;
    div.textContent = item.line;
    frag.appendChild(div);
    added++;
  }
  if (!added) return;
  if (!logHasContent) { box.innerHTML = ''; logHasContent = true; }
  box.appendChild(frag);
  while (box.children.length > LOG_DOM_MAX && box.firstElementChild) box.removeChild(box.firstElementChild);
  if (stick) box.scrollTop = box.scrollHeight;
}

function clearLog() {
  state.logs = [];
  logQueue = [];
  logRaf = 0;
  logHasContent = false;
  const box = $('#log');
  if (box) box.innerHTML = '';
}

/** 「只看错误」切换时用内存日志重建 DOM */
function renderLog() {
  const box = $('#log');
  if (!box) return;
  const onlyErr = logErrOnlyChecked();
  const items = state.logs.filter((x) => !onlyErr || x.cls === 'er').slice(-LOG_DOM_MAX);
  const frag = document.createDocumentFragment();
  for (const item of items) {
    const div = document.createElement('div');
    if (item.cls) div.className = item.cls;
    div.textContent = item.line;
    frag.appendChild(div);
  }
  box.innerHTML = '';
  box.appendChild(frag);
  logHasContent = items.length > 0;
  box.scrollTop = box.scrollHeight;
}

// ---------------- 健康检查 ----------------
/** SPEC4 A3：工作台「排队 N」（N=0 隐藏） */
function setQueueInfo(n) {
  const q = Math.max(0, Number(n) || 0);
  state.queued = q;
  const el = $('#queueInfo');
  if (!el) return;
  if (q > 0) { el.textContent = t`排队 ${q}`; el.classList.remove('hidden'); }
  else { el.textContent = ''; el.classList.add('hidden'); }
}

async function checkHealth() {
  try {
    const h = await api('/api/health');
    maintenanceUi?.update(h);
    state.running = !!h.running;
    applyRunningUi();
    setQueueInfo(h.queued);
    setPill(h.proxy ? '' : 'warn', h.proxy ? t`代理已连接 · ${h.proxy.replace('http://', '')}` : t('未配置代理'));
    $('#ver').textContent = 'v' + (h.version || '1.0');
    $('#backendInfo').innerHTML = t`
      <dt>状态</dt><dd>在线</dd>
      <dt>版本</dt><dd>${esc(h.version)}</dd>
      <dt>Node</dt><dd>${esc(h.node)} / ${esc(h.platform)}</dd>
      <dt>代理</dt><dd>${esc(h.proxy || t('未配置（javbus 会失败）'))}</dd>
      <dt>工作目录</dt><dd>${esc(h.dir)}</dd>
      <dt>运行中任务</dt><dd>${h.running ? esc(h.running.slice(0, 8)) : t('无')}</dd>
      <dt>排队任务</dt><dd>${Number(h.queued) > 0 ? esc(h.queued) : t('无')}</dd>`;
    return true;
  } catch (e) {
    maintenanceUi?.update(null);
    setQueueInfo(0);
    setPill('bad', t('后端未连接'));
    $('#backendInfo').innerHTML = t`<dt>状态</dt><dd style="color:var(--red)">离线 —— 请确认已运行 <code>node src/server.mjs</code></dd>`;
    return false;
  }
}

// ---------------- 视图切换 ----------------
function showView(name, opts = {}) {
  const target = VIEWS.includes(name) ? name : 'work';
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === target));
  VIEWS.forEach((v) => $('#view-' + v).classList.toggle('hidden', v !== target));
  effectsUi?.setView(target, { animate: opts.animate !== false });
  if (!opts.fromHash) updateHash(target); // B14：切换 tab 同步 hash
  if (target === 'history') loadHistory();
  if (target === 'assembly') assemblyUi?.refresh();
  if (target === 'settings') loadSettings();
}

// ---------------- 目录 ----------------
function setDir(dir) {
  const next = String(dir || '').trim();
  // 目录变化 → 上一次预演结果失效
  if (next !== state.dir) invalidatePlan();
  state.dir = next;
  $('#dir').value = state.dir;
  try { localStorage.setItem('avc.dir', state.dir); } catch {}
}

// 说明：Windows 原生目录对话框已移除。
// 后端进程（尤其后台/服务方式启动）创建的窗口可能落在不可见桌面上，
// 表现为「点了没反应」；统一改用下方由后端 FS API 驱动的目录浏览器。


let fsPath = '';
let fsParent = null;
let fsRoots = [];

function renderDrives() {
  $('#fsDrives').innerHTML = fsRoots
    .map((d) => `<button class="drive" data-drive="${esc(d)}" title="${esc(d)}">${esc(d.replace(/\\$/, ''))}</button>`)
    .join('');
  $$('#fsDrives .drive').forEach((b) => { b.onclick = () => fsList(b.dataset.drive); });
  markDrive();
}

function markDrive() {
  const current = (fsPath || '').slice(0, 2).toLowerCase();
  $$('#fsDrives .drive').forEach((b) => b.classList.toggle('on', b.dataset.drive.slice(0, 2).toLowerCase() === current));
}

async function openFsBrowser(start) {
  $('#fsModal').classList.add('open');
  focusFirst($('#fsModal'));
  $('#fsList').innerHTML = t('<div class="empty">加载中…</div>');
  try {
    if (!fsRoots.length) {
      const roots = await api('/api/fs/roots');
      fsRoots = roots.drives || [];
      renderDrives();
    }
    const fallback = fsRoots[0] || 'C:\\';
    await fsList(start || fsPath || fallback);
  } catch (e) {
    $('#fsList').innerHTML = t`<div class="empty">无法读取目录：${esc(e.message)}</div>`;
  }
}
async function fsList(path) {
  $('#fsList').innerHTML = t('<div class="empty">加载中…</div>');
  try {
    const r = await api('/api/fs/list?path=' + encodeURIComponent(path));
    if (r.error) throw new Error(r.error);
    fsPath = r.dir;
    fsParent = r.parent;
    markDrive();
    $('#fsPath').textContent = r.dir;
    $('#fsCrumbs').innerHTML = `<code>${esc(r.dir)}</code>`;
    const rows = r.entries || [];
    const dirs = rows.filter((x) => x.isDir);
    const files = rows.filter((x) => !x.isDir);
    $('#fsList').innerHTML = dirs.length
      ? dirs.map((d) => `<div class="fsitem" data-dir="${esc(d.path)}"><span class="ico">▸</span>${esc(d.name)}</div>`).join('')
      : t('<div class="empty">没有子目录</div>');
    if (files.length) {
      $('#fsList').insertAdjacentHTML('beforeend',
        t`<div class="empty" style="margin:10px 0 4px;padding:10px">本目录 ${files.length} 个文件（${files.filter((f) => /\.(mp4|mkv|avi|wmv|mov|ts|m2ts)$/i.test(f.name)).length} 个视频）</div>`);
    }
    $$('.fsitem').forEach((el) => el.onclick = () => fsList(el.dataset.dir));
  } catch (e) {
    $('#fsList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------------- 列表（F10 筛选/排序/批量选择 + F11 增量渲染） ----------------
function statusOf(it) {
  return it.status || (it.code ? 'unresolved' : 'no_code');
}

function itemPill(it) {
  const st = statusOf(it);
  const s = STATUS[st] || STATUS.unresolved;
  return `<span class="stat-pill ${s.cls}">${esc(t(s.label))}</span>`;
}

/** 搜索匹配：文件名 / 番号 / 标题 / 女优（忽略大小写） */
function itemSearchText(it) {
  const meta = it.meta || {};
  return [
    it.name, it.code, it.newName,
    meta.titleJa, meta.titleZh, meta.title,
    Array.isArray(meta.actress) ? meta.actress.join(' ') : meta.actress,
    meta.maker,
  ].filter(Boolean).join(' ').toLowerCase();
}

function matchesFilter(it) {
  const q = state.filter.q.trim().toLowerCase();
  if (q && !itemSearchText(it).includes(q)) return false;
  if (state.filter.statuses.size) {
    if (!state.filter.statuses.has(statusOf(it))) return false;
  }
  return true;
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
function compareItems(a, b) {
  switch (state.filter.sort) {
    case 'code': {
      const ac = String(a.code || '');
      const bc = String(b.code || '');
      if (!ac || !bc) return ac ? -1 : bc ? 1 : collator.compare(pathBase(a.name), pathBase(b.name));
      return collator.compare(ac, bc) || collator.compare(pathBase(a.name), pathBase(b.name));
    }
    case 'size':
      return (Number(b.size) || 0) - (Number(a.size) || 0);
    case 'status':
      return (STATUS_ORDER[statusOf(a)] ?? 99) - (STATUS_ORDER[statusOf(b)] ?? 99)
        || collator.compare(pathBase(a.name), pathBase(b.name));
    case 'name':
    default:
      return collator.compare(pathBase(a.name), pathBase(b.name));
  }
}

/** 当前筛选 + 排序后的列表（纯前端，不修改 state.items 顺序） */
function visibleItems() {
  const out = state.items.filter(matchesFilter);
  out.sort(compareItems);
  return out;
}

/** 封面状态（五态，SPEC3）：
 *  local = 本地文件已存在；failed = 下载失败（cover.error）；planned = 预演计划将下载；
 *  remote = 仅有元数据 coverUrl（待下载）；none = 无封面信息。 */
function coverStateOf(it) {
  if (!it) return 'none';
  const meta = it.meta || {};
  if (it.cover?.path) return 'local';
  if (it.cover?.error) return 'failed';
  if (it.coverPlanned) return 'planned';
  if (meta.coverUrl) return 'remote';
  return 'none';
}

function coverErrorLabel(cover) {
  const e = cover?.error;
  if (!e) return '';
  if (typeof e === 'string') return e;
  const code = e.code || e.error || '';
  const msg = e.message || '';
  if (code && msg && msg !== code) return `${code}：${msg}`;
  return code || msg || t('未知错误');
}

function coverStatusText(it) {
  switch (coverStateOf(it)) {
    case 'local': return t('封面 ✓');
    case 'failed': return t`封面失败（${coverErrorLabel(it.cover) || t('未知错误')}）`;
    case 'planned': return t('封面将下载');
    case 'remote': return t('封面待下载');
    default: return t('没有可用封面');
  }
}

/** 列表行 metaline 里的封面状态（无封面时返回空串，避免所有行都写「封面待下载」） */
function coverFlagHtml(it) {
  const state = coverStateOf(it);
  if (state === 'none') return '';
  const cls = state === 'local' ? 'ok' : state === 'failed' ? 'err' : 'muted';
  return `<span class="cover-flag ${cls}">${esc(coverStatusText(it))}</span>`;
}

/** 可下载封面用的 URL：优先计划里的 url，其次元数据 coverUrl */
function coverSourceUrl(it) {
  return String(it?.coverPlanned?.url || it?.meta?.coverUrl || '');
}

function coverTargetPath(it) {
  return String(it?.cover?.path || it?.coverPlanned?.targetPath || '');
}

/** 可用于展示的封面地址：本地文件优先，其次远程 URL（列表缩略图/大图弹层共用） */
function coverDisplaySrc(it) {
  if (it?.cover?.path) return '/api/cover?path=' + encodeURIComponent(it.cover.path);
  if (it?.meta?.coverUrl) return '/api/cover?url=' + encodeURIComponent(it.meta.coverUrl);
  return '';
}

function rowBodyHtml(it) {
  const meta = it.meta || {};
  const sub = it.sub || null;
  const code = it.code || '';
  const hasNew = !!it.newName;
  const title = hasNew ? String(it.newName).replace(/\.[^.]+$/, '') : it.name;
  const cols = state.cols || {};
  const metaBits = [
    meta.actress?.length ? esc(meta.actress.join('、')) : '',
    cols.date !== false && meta.releaseDate ? esc(meta.releaseDate) : '',
    cols.maker !== false && meta.maker ? esc(meta.maker) : '',
    cols.duration !== false && meta.durationMin ? esc(meta.durationMin) + ' min' : '',
    cols.size !== false ? fmtSize(it.size) : '',
    sub ? t`字幕 <b>${esc(sub.source || '')}${sub.cues ? ' · ' + sub.cues + ' cue' : ''}${sub.candidates > 1 ? t(' · 候选×') + sub.candidates : ''}</b>` : '',
    sub?.fit ? t`校正 ${esc(sub.fit.applied)}` : '',
  ].filter(Boolean).join('<span></span>');
  const hintText = it.code ? t('已识别番号，预演后才会补全标题与字幕') : t('未识别番号：可在下方「未识别」区补番号');
  const baseBits = hasNew ? metaBits : [hintText, metaBits].filter(Boolean).join('<span></span>');
  // 封面状态对已预演/未预演的行都显示（五态精确，不再所有行都写「封面待下载」）
  const hintBits = [baseBits, coverFlagHtml(it)].filter(Boolean).join('<span></span>');
  return `<div class="titlerow">
        ${code ? `<span class="tag">${esc(code)}</span>` : ''}
        <span class="newtitle">${esc(title)}</span>
      </div>
      ${hasNew ? `<div class="oldname">${esc(it.name)}${it.normalized ? t(' · 已是规范名') : ''}</div>` : ''}
      <div class="metaline">${hintBits}</div>`;
}

function thumbHtml(it, idx) {
  const coverSrc = coverDisplaySrc(it);
  return t`<div class="thumb${idx % 2 ? ' alt' : ''}" title="${coverSrc ? t('点击查看大图') : ''}">
        <span class="cover-label">封面</span>
        ${coverSrc ? `<img src="${esc(coverSrc)}" alt="" loading="lazy" onerror="this.style.display='none';this.parentNode.classList.add('cover-fail')">` : ''}
        <span class="cover-fail-tip">封面加载失败</span>
      </div>`;
}

function rowActionsHtml(it) {
  return t`<div class="row-actions">
        ${it.code ? t`<button type="button" class="row-act" data-row-act="copy-code" title="复制番号">番号</button>` : ''}
        <button type="button" class="row-act" data-row-act="copy-new" title="复制新文件名">新名</button>
        <button type="button" class="row-act" data-row-act="copy-path" title="复制完整路径">路径</button>
        <button type="button" class="row-act" data-row-act="rerun" title="仅重跑此文件（预演）">仅重跑</button>
      </div>`;
}

function rowHtml(it, idx) {
  const picked = state.selected.has(it.path);
  const selectable = !!it.code;
  return `<div class="row${selectable && !picked ? ' off' : ''}" data-path="${esc(it.path)}">
      <label class="pick" title="${selectable ? t('勾选后才参与预演/应用') : t('未识别番号：先在下方「未识别」区补番号')}"><input type="checkbox" data-path="${esc(it.path)}" ${picked ? 'checked' : ''} ${selectable ? '' : 'disabled'} /></label>
      ${thumbHtml(it, idx)}
      <div class="body">${rowBodyHtml(it)}</div>
      ${itemPill(it)}
      ${rowActionsHtml(it)}
    </div>`;
}

function emptyListHtml() {
  if (!state.items.length) return t('<div class="empty" id="empty">还没有扫描结果。输入或选择一个视频目录，点击「扫描」。</div>');
  return t('<div class="empty">没有符合当前筛选的文件。可以清空搜索词或点「清除筛选」。</div>');
}

let rowEls = new Map(); // path -> row element（供 patchRow 单行更新）

function renderMore(total) {
  const box = $('#fltMore');
  if (!box) return;
  if (total > ROW_LIMIT) {
    box.classList.remove('hidden');
    box.textContent = t`筛选结果 ${total} 行，超过 ${ROW_LIMIT} 行上限：当前只渲染前 ${ROW_LIMIT} 行，请用筛选缩小范围（搜索词或状态 chips）。`;
  } else {
    box.classList.add('hidden');
    box.textContent = '';
  }
}

/** 全量渲染行（仅筛选/排序/扫描/勾选集合结构变化时调用），不重建封面 img 之外的 DOM */
function renderRows() {
  const box = $('#fltRows');
  if (!box) return;
  const vis = visibleItems();
  const shown = vis.slice(0, ROW_LIMIT);
  box.innerHTML = shown.length ? shown.map((it, idx) => rowHtml(it, idx)).join('') : emptyListHtml();
  rowEls = new Map($$('#fltRows .row').map((el) => [el.dataset.path, el]));
  renderMore(vis.length);
  window.__lastRender = {
    at: Date.now(),
    covers: state.items.map((it) => (it.cover && it.cover.path) || (it.meta && it.meta.coverUrl) || null),
    imgs: document.querySelectorAll('#fltRows .thumb img').length,
    rows: shown.length,
  };
}

function syncFilterUi() {
  const q = $('#fltSearch');
  if (q) q.value = state.filter.q;
  const sort = $('#fltSort');
  if (sort) sort.value = state.filter.sort;
  $$('#fltStatus .flt-chip').forEach((chip) => chip.classList.toggle('on', state.filter.statuses.has(chip.dataset.status)));
}

/** B5：预计每个文件的耗时（优先上次任务的 durationMs/处理数，兜底 8 秒/文件） */
function estimatePerFileSec() {
  const rep = state.lastPlan;
  const n = Array.isArray(rep?.results) ? rep.results.length : 0;
  if (rep && Number(rep.durationMs) > 0 && n > 0) return Number(rep.durationMs) / 1000 / n;
  const stats = state.lastJobStats;
  if (stats && Number(stats.durationMs) > 0 && Number(stats.count) > 0) return Number(stats.durationMs) / 1000 / Number(stats.count);
  return 8;
}

/** B5：已选 N · 总大小 X · 预计耗时 Y */
function updateSelectionSummary() {
  const el = $('#selSummary');
  if (!el) return;
  const chosen = state.items.filter((it) => it.code && state.selected.has(it.path));
  if (!chosen.length) { el.innerHTML = t('已选 0 · 总大小 0 B · 预计耗时 —'); return; }
  const size = chosen.reduce((s, it) => s + (Number(it.size) || 0), 0);
  const sec = estimatePerFileSec() * chosen.length;
  el.innerHTML = t`已选 <b>${chosen.length}</b> · 总大小 ${esc(fmtSize(size))} · 预计耗时 ${esc(fmtDurationSec(sec))}`;
}

/** 计数：已选（跨筛选保留的总数）/ 当前筛选 / 全部 */
function updateCounts(vis) {
  const list = vis || visibleItems();
  const counts = $('#fltCounts');
  if (counts) counts.innerHTML = t`已选 <b>${state.selected.size}</b> / 筛选 ${list.length} / 全部 ${state.items.length}`;
  const all = $('#chkAll');
  if (all) {
    const selectable = list.filter((it) => it.code);
    const chosen = selectable.filter((it) => state.selected.has(it.path)).length;
    all.checked = selectable.length > 0 && chosen === selectable.length;
    all.indeterminate = chosen > 0 && chosen < selectable.length;
  }
  updateSelectionSummary();
}

/** 只更新勾选状态（不重建行，避免封面 img 闪烁） */
function syncRowsSelection() {
  const vis = visibleItems();
  for (const row of $$('#fltRows .row')) {
    const it = state.itemByPath.get(row.dataset.path);
    if (!it) continue;
    const picked = state.selected.has(it.path);
    row.classList.toggle('off', !!it.code && !picked);
    const box = row.querySelector('.pick input');
    if (box) box.checked = picked;
  }
  updateCounts(vis);
  updateStats();
}

function renderList() {
  syncFilterUi();
  const bar = $('#fltBar');
  if (bar) bar.classList.toggle('hidden', !state.items.length);
  renderRows();
  updateCounts();
  renderManual();
  updateStats();
}

let fltSearchTimer = 0; // 搜索防抖定时器（清除筛选时取消）

function resetFilter() {
  clearTimeout(fltSearchTimer);
  fltSearchTimer = 0;
  state.filter.q = '';
  state.filter.statuses.clear();
  saveFilterPrefs();
  renderList();
}

/** B2：「重置筛选」清空搜索/状态/排序并清除 localStorage */
function resetFilterAll() {
  clearTimeout(fltSearchTimer);
  fltSearchTimer = 0;
  state.filter.q = '';
  state.filter.statuses.clear();
  state.filter.sort = 'name';
  clearFilterPrefs();
  renderList();
  toast(t('筛选已重置'));
}

function setFilterQuery(q) {
  state.filter.q = String(q ?? '');
  saveFilterPrefs();
  renderList();
}

function toggleFilterStatus(key) {
  if (state.filter.statuses.has(key)) state.filter.statuses.delete(key);
  else state.filter.statuses.add(key);
  saveFilterPrefs();
  renderList();
}

/** 只选筛选结果：把勾选替换为当前筛选里可勾选（有番号）的文件 */
function selectFiltered() {
  const vis = visibleItems();
  state.selected = new Set(vis.filter((it) => it.code).map((it) => it.path));
  invalidatePlan();
  syncRowsSelection();
  toast(t`已勾选筛选结果的 ${state.selected.size} 个文件`, 'ok');
}

/** 只选失败：跨筛选保留的快捷批量（作用于全部文件的失败项） */
function selectFailed() {
  const failed = state.items.filter((it) => it.code && statusOf(it) === 'error');
  state.selected = new Set(failed.map((it) => it.path));
  invalidatePlan();
  syncRowsSelection();
  toast(failed.length ? t`已勾选 ${failed.length} 个失败文件` : t('当前没有失败文件'), failed.length ? 'ok' : '');
}

function invertSelection() {
  const vis = visibleItems().filter((it) => it.code);
  for (const it of vis) {
    if (state.selected.has(it.path)) state.selected.delete(it.path);
    else state.selected.add(it.path);
  }
  invalidatePlan();
  syncRowsSelection();
}

function clearSelection() {
  state.selected.clear();
  invalidatePlan();
  syncRowsSelection();
}

/** 全选只作用于当前筛选结果（有番号的行） */
function selectAllFiltered(on) {
  const vis = visibleItems().filter((it) => it.code);
  for (const it of vis) {
    if (on) state.selected.add(it.path); else state.selected.delete(it.path);
  }
  invalidatePlan();
  syncRowsSelection();
}

// ---------------- SPEC5 Phase1：B1/B3/B4/B9 交互 ----------------
/** B1/共用：设置单行勾选并刷新（不重建列表） */
function setRowSelected(path, on) {
  if (on) state.selected.add(path); else state.selected.delete(path);
  const row = rowEls.get(path) || listRowElements().find((r) => r.dataset.path === path);
  if (row) {
    const item = state.itemByPath.get(path);
    row.classList.toggle('off', !!item?.code && !on);
    const box = row.querySelector('.pick input');
    if (box) box.checked = on;
  }
  invalidatePlan();
  updateCounts();
  updateStats();
}

/** B1：列表键盘导航 */
function listRowElements() { return $$('#fltRows .row'); }
function activeRowElement() { return $('#fltRows .row.active'); }
function setActiveRow(idx) {
  const rows = listRowElements();
  rows.forEach((r) => r.classList.remove('active'));
  if (!rows.length) return;
  const i = Math.max(0, Math.min(rows.length - 1, idx));
  rows[i].classList.add('active');
  if (typeof rows[i].scrollIntoView === 'function') rows[i].scrollIntoView({ block: 'nearest' });
}
function moveActiveRow(delta) {
  const rows = listRowElements();
  if (!rows.length) return;
  const cur = rows.findIndex((r) => r.classList.contains('active'));
  setActiveRow(cur < 0 ? (delta > 0 ? 0 : rows.length - 1) : cur + delta);
}

/** B3：复制文本（navigator.clipboard，失败降级并 toast） */
async function copyText(text, label) {
  const val = String(text ?? '');
  if (!val) { toast(t`没有可复制的${label}`, 'err'); return; }
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(val);
    toast(t`已复制${label}`, 'ok');
  } catch {
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = val;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      if (document.body) document.body.appendChild(ta);
      ta.select();
      ok = typeof document.execCommand === 'function' && document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
    if (ok) toast(t`已复制${label}`, 'ok');
    else toast(t('复制失败：浏览器不允许访问剪贴板'), 'err');
  }
}

function handleRowAction(act, it) {
  if (!it) return;
  if (act === 'copy-code') { copyText(it.code || '', t('番号')); return; }
  if (act === 'copy-new') { copyText(it.newName || it.name || '', t('新文件名')); return; }
  if (act === 'copy-path') { copyText(it.path || '', t('路径')); return; }
  if (act === 'rerun') {
    if (state.running) { toast(t('任务运行中，完成后再试'), 'err'); return; }
    rerunOne(it, 'plan');
  }
}

/** B9：封面大图弹层 */
function openCoverModal(it) {
  const modal = $('#coverModal');
  if (!modal || !it) return;
  const src = coverDisplaySrc(it);
  if (!src) { toast(t('该文件没有可预览的封面'), 'err'); return; }
  const title = $('#coverModalTitle');
  if (title) title.textContent = t`封面 · ${it.code || pathBase(it.name)}`;
  const body = $('#coverModalBody');
  if (body) {
    body.innerHTML = `<img class="cover-modal-img" src="${esc(src)}" alt="cover">`;
    const img = body.querySelector('img');
    if (img) img.onerror = () => { body.innerHTML = t('<div class="empty">封面加载失败</div>'); };
  }
  modal.classList.add('open');
  focusFirst(modal);
  const closeBtn = $('#coverModalClose');
  if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
}
function closeCoverModal() {
  const modal = $('#coverModal');
  if (modal) modal.classList.remove('open');
}

/** B3：抽屉上一项/下一项（按当前筛选顺序） */
function navigateDrawer(delta) {
  const list = visibleItems();
  if (!list.length) return;
  const idx = list.findIndex((it) => it.path === state.drawerPath);
  const next = idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + delta));
  if (next === idx) return;
  state.drawerPath = list[next].path;
  renderDrawer();
}
function updateDrawerNav() {
  const list = visibleItems();
  const idx = list.findIndex((it) => it.path === state.drawerPath);
  const prev = $('#drawerPrev');
  const next = $('#drawerNext');
  if (prev) prev.disabled = idx <= 0;
  if (next) next.disabled = idx < 0 || idx >= list.length - 1;
}

/** B4：重试失败项 → 筛选失败并直接开始预演 */
function retryFailed() {
  if (state.running) { toast(t('任务运行中，完成后再试'), 'err'); return; }
  const failed = state.items.filter((it) => it.code && statusOf(it) === 'error');
  if (!failed.length) { toast(t('没有可重试的失败项')); return; }
  state.filter.q = '';
  state.filter.statuses = new Set(['error']);
  saveFilterPrefs();
  state.selected = new Set(failed.map((it) => it.path));
  renderList();
  invalidatePlan();
  toast(t`重试 ${failed.length} 个失败项…`, 'ok');
  startJob('plan');
}

/** F11：只 patch 单行 DOM（状态 pill / 标题 / 元数据 / 勾选态），缩略图 img 保持原节点 */
function applyRowContent(row, it) {
  const st = STATUS[statusOf(it)] || STATUS.unresolved;
  const pill = row.querySelector('.stat-pill');
  if (pill) { pill.className = 'stat-pill ' + st.cls; pill.textContent = t(st.label); }
  const body = row.querySelector('.body');
  if (body) body.innerHTML = rowBodyHtml(it);
  const picked = state.selected.has(it.path);
  row.classList.toggle('off', !!it.code && !picked);
  const box = row.querySelector('.pick input');
  if (box) { box.checked = picked; box.disabled = !it.code; }
}

function patchRow(path) {
  if (typeof document === 'undefined') return;
  const it = state.itemByPath.get(path) || state.items.find((x) => x.path === path);
  if (!it) return;
  const rowsBox = $('#fltRows');
  if (!rowsBox) return;
  const vis = visibleItems();
  const idx = vis.findIndex((x) => x.path === path);
  let row = rowEls.get(path) || null;
  if (idx < 0 || idx >= ROW_LIMIT) {
    if (row) { row.remove(); rowEls.delete(path); }
  } else if (!row) {
    const wrap = document.createElement('div');
    wrap.innerHTML = rowHtml(it, idx);
    row = wrap.firstElementChild;
    rowEls.set(path, row);
    const current = $$('#fltRows .row');
    const ref = current[idx] || null;
    const placeholder = rowsBox.querySelector('.empty');
    if (placeholder) placeholder.remove();
    if (ref) rowsBox.insertBefore(row, ref); else rowsBox.appendChild(row);
  } else {
    const current = $$('#fltRows .row');
    const curIdx = current.indexOf(row);
    if (curIdx !== idx && curIdx >= 0) {
      if (curIdx < idx) {
        const anchor = current[idx] ? current[idx].nextElementSibling : null;
        rowsBox.insertBefore(row, anchor);
      } else {
        rowsBox.insertBefore(row, current[idx] || null);
      }
    }
  }
  if (row) applyRowContent(row, it);
  if (!rowEls.size) {
    const rbox = $('#fltRows');
    if (rbox && !rbox.querySelector('.row')) rbox.innerHTML = emptyListHtml();
  }
  renderMore(vis.length);
  updateCounts(vis);
  updateStats();
}

/** 未识别（no_code）单独一区，支持手动补番号。 */
function renderManual() {
  const noCode = state.items.filter((it) => !it.code);
  const panel = $('#manualPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', noCode.length === 0);
  $('#manualCount').textContent = String(noCode.length);
  if (!noCode.length) { $('#manualList').innerHTML = ''; return; }
  $('#manualList').innerHTML = noCode.map((it) => {
    const saved = state.manualCodes[it.path] || it.manualCode || '';
    return t`<div class="manual-row" data-path="${esc(it.path)}">
      <span class="name" title="${esc(it.name)}">${esc(it.name)}</span>
      <span class="size">${fmtSize(it.size)}</span>
      <input type="text" placeholder="如 IPX-920" value="${esc(saved)}" spellcheck="false" />
      <span class="ok-tip">${saved ? t('已填') : ''}</span>
    </div>`;
  }).join('');
  $$('#manualList .manual-row').forEach((row) => {
    const input = row.querySelector('input');
    const tip = row.querySelector('.ok-tip');
    input.oninput = () => {
      const v = input.value.trim();
      if (v) state.manualCodes[row.dataset.path] = v; else delete state.manualCodes[row.dataset.path];
      tip.textContent = v ? t('已填') : '';
      invalidatePlan();
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') startJob('plan'); };
  });
}

function normalizedManualInput(raw) {
  const s = String(raw || '').normalize('NFKC').trim().toUpperCase();
  const m = /^([A-Z]{2,8})[-_ .]?(\d{1,6})$/.exec(s);
  return m ? `${m[1]}-${m[2].replace(/^0+(?=\d)/, '')}` : null;
}

// ---------------- 扫描 ----------------
async function scan() {
  const dir = ($('#dir').value || '').trim();
  if (!dir) { toast(t('请先填写或选择视频目录')); return; }
  setDir(dir);
  invalidatePlan();
  const rowsBox = $('#fltRows');
  if ($('#fltBar')) $('#fltBar').classList.add('hidden');
  if (rowsBox) rowsBox.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  try {
    const r = await api('/api/scan', { method: 'POST', body: JSON.stringify({ dir }) });
    state.items = (r.items || []).map((it) => ({
      ...it,
      status: it.status || (it.code ? 'scanned' : 'no_code'),
      rename: it.rename || null,
      duplicates: Array.isArray(it.duplicates) ? it.duplicates : [],
      applied: it.applied === true,
      stage: it.stage || null,
      candidates: Array.isArray(it.candidates) ? it.candidates : [],
      // SPEC3：后端新增 coverPlanned（预演计划将下载的封面）；缺失时归一为 null
      cover: it.cover || null,
      coverPlanned: it.coverPlanned || null,
      coverPath: it.coverPath || it.cover?.path || null,
    }));
    state.itemByPath = new Map(state.items.map((it) => [it.path, it]));
    state.lastPlan = null;
    clearPlanSummary();
    if (!state.running) {state.job = null;state.total = 0;state.progressDone = 0;}
    // 恢复已保存的手动番号（重跑/刷新后仍可见）
    state.manualCodes = {};
    for (const it of state.items) if (it.manualCode) state.manualCodes[it.path] = it.manualCode;
    // 默认全选所有能识别番号的文件；手动补过番号的文件也默认选中
    state.selected = new Set(state.items.filter((it) => it.code).map((it) => it.path));
    for (const it of state.items) if (it.code && it.manualCode) state.selected.add(it.path);
    clearLog();
    renderList();
    toast(t`扫描完成：${r.count} 个视频，识别 ${state.items.filter((i) => i.code).length} 个`, 'ok');
    setStep(1, 'done');
  } catch (e) {
    if (rowsBox) rowsBox.innerHTML = t`<div class="empty">扫描失败：${esc(errText(e))}${e.body?.dir ? `<br/><span class="note">${esc(e.body.dir)}</span>` : ''}</div>`;
    toastErr(t('扫描失败'), e);
  }
}

// ---------------- 任务 ----------------
function setStep(n, mode) {
  $$('#steps .step').forEach((el) => {
    const k = Number(el.dataset.step);
    el.classList.toggle('done', k < n || (k === n && mode === 'done'));
    el.classList.toggle('on', k === n && mode !== 'done');
  });
}

function updateProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#ringTxt').textContent = pct + '%';
  const C = 2 * Math.PI * 45; // 282.7
  $('#ringFill').style.strokeDashoffset = String(C * (1 - pct / 100));
  $('#bar').style.width = pct + '%';
  $('#kDone').textContent = `${done} / ${total}`;
  if (label) $('#jobState').textContent = label;
  updateEtaUi(done, total, pct);
}

/** B6：运行中显示「预计剩余 X」；B7：运行中标题栏显示进度百分比 */
function updateEtaUi(done, total, pct) {
  const el = $('#etaInfo');
  if (!state.running || !total) {
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
    resetDocumentTitle();
    return;
  }
  if (typeof document !== 'undefined') document.title = `${pct}% · ${t(BASE_TITLE)}`;
  if (!el) return;
  el.classList.remove('hidden');
  if (!done) { el.textContent = t('预计剩余 计算中…'); return; }
  const started = state.jobStartedAt || Date.now();
  const elapsed = Math.max(0, (Date.now() - started) / 1000);
  const remain = Math.max(0, (elapsed / done) * Math.max(0, total - done));
  el.textContent = t`预计剩余 ${fmtDurationSec(remain)}`;
}

function resetDocumentTitle() {
  if (typeof document !== 'undefined' && document.title !== t(BASE_TITLE)) document.title = t(BASE_TITLE);
}

function updateStats() {
  const coded = state.items.filter((i) => i.code);
  const chosen = coded.filter((i) => state.selected.has(i.path));
  const subs = coded.filter((i) => i.sub);
  $('#kSub').textContent = String(subs.length);
  const by = {};
  for (const s of subs) by[s.sub.source || '?'] = (by[s.sub.source || '?'] || 0) + 1;
  const total = subs.length || 1;
  $('#subStats').innerHTML = Object.keys(by).length
    ? Object.entries(by).map(([k, v]) => `<div class="sub-item"><span>${esc(k)}</span><b>${v}</b><span class="minibar"><i style="width:${Math.round(v / total * 100)}%"></i></span></div>`).join('')
    : t('<div class="empty" style="padding:10px">暂无数据</div>');
  // 运行中显示任务真实进度（done/total，含跳过），否则显示「勾选且有番号」的静态处理情况
  if (state.running && state.total) {
    updateProgress(state.progressDone, state.total, JOB_STATUS_TEXT.running);
  } else {
    const done = chosen.filter((i) => ['ok', 'no_subtitle', 'out_of_scope', 'error'].includes(i.status)).length;
    updateProgress(done, chosen.length);
  }
  const manualCount = Object.values(state.manualCodes || {}).filter((v) => normalizedManualInput(v)).length;
  const canApply = !!state.lastPlan && !state.running && (chosen.length > 0 || manualCount > 0);
  $('#btnApply').disabled = !canApply;
  $('#btnPlan').disabled = state.running || (chosen.length === 0 && manualCount === 0);
  $('#btnCancel').disabled = !state.running;
  $('#btnExport').disabled = !state.lastPlan && !state.job;
  $('#applyHint').textContent = canApply
    ? t`预演已完成：将处理 ${chosen.length + manualCount} 个文件（已勾选 ${chosen.length}${manualCount ? t` + 手动番号 ${manualCount}` : ''}）。`
    : state.running ? t('任务运行中…') : t('先勾选文件并完成一次「预演」才能应用。');
  applyRunningUi();
}

/** 任务运行中禁用扫描/浏览目录/目录输入（§3.6） */
function applyRunningUi() {
  const run = state.running || !!state.starting;
  for (const id of ['#btnScan', '#btnPick', '#dir', '#btnManualPlan', '#retryFailed']) {
    const el = $(id);
    if (el) el.disabled = run;
  }
  if (run && $('#fsUse')) $('#fsModal').classList.remove('open');
}

async function startJob(kind, extra = {}) {
  const dir = String(extra.dir || ($('#dir').value || '').trim() || state.dir || '').trim();
  if (!dir) { toast(t('请先填写或选择视频目录')); return; }
  if (state.starting || state.running) { toast(ERRMSG.task_running, 'err'); return; }
  if(kind==='apply'&&Array.isArray(extra.only)) {
    const planned=(state.lastPlan?.results||[]).map(r=>r.rename?.from||r.originalFile||r.file).sort();
    if(JSON.stringify(planned)!==JSON.stringify([...extra.only].sort())) {toast(t('请先确认该文件的独立预演，再应用'), 'err');return startJob('plan',extra);}
  }
  if (kind === 'apply' && !extra.only && !state.lastPlan) { toast(t('请先完成一次「预演」再应用'), 'err'); return; }
  state.starting = true;
  setDir(dir);
  clearLog();
  state.job = null;
  state.finishedJobId = null;
  state.total = 0;
  state.progressDone = 0;
  if ($('#kTime')) $('#kTime').textContent = '—';
  if ($('#jobState')) $('#jobState').textContent = JOB_STATUS_TEXT.running;
  if ($('#btnResync')) $('#btnResync').classList.add('hidden');
  // 注意：原地修改，不能重建数组（否则 itemByPath 会指向旧对象，SSE 更新丢失）
  const targets = extra.only ? state.items.filter((i) => extra.only.includes(i.path)) : state.items;
  for (const it of targets) it.status = it.code ? 'scanned' : 'no_code';
  for (const it of targets) patchRow(it.path);
  updateStats();
  setStep(kind === 'plan' ? 2 : 3, 'on');
  $('#liveDots').innerHTML = t('<i></i>运行中');
  try {
    // overrides：手动补录的番号（键为文件绝对路径）；单文件重跑时用调用方给的覆盖
    let overrides = {};
    if (extra.overrides) {
      overrides = { ...extra.overrides };
    } else {
      for (const [p, raw] of Object.entries(state.manualCodes || {})) {
        const norm = normalizedManualInput(raw);
        if (norm) overrides[p] = norm;
      }
    }
    // only：调用方指定（单文件）或「勾选了一部分」
    let only = Array.isArray(extra.only) && extra.only.length ? extra.only.slice() : null;
    if (!only) {
      const coded = state.items.filter((i) => i.code);
      const chosen = coded.filter((i) => state.selected.has(i.path)).map((i) => i.path);
      if (!chosen.length && !Object.keys(overrides).length) {
        throw new Error(t('请先勾选至少一个文件（或给「未识别」文件补番号）'));
      }
      if (chosen.length) only = chosen;
    }
    const ro = currentRunOpts();
    saveRunOpts();
    maybeRequestNotify(ro.notify);
    const force = extra.force != null ? !!extra.force : ro.force;
    const downloadSubs = extra.downloadSubs != null ? !!extra.downloadSubs : ro.downloadSubs;
    const options = {
      downloadSubs, workflow:workflows?.options() || {},
      ...(kind==='apply'?{requirePlan:true,planId:state.lastPlan?.planId,planRevision:state.lastPlan?.planRevision}:{}),
      ...(force ? { force: true } : {}),
      ...(ro.concurrency > 1 ? { concurrency: ro.concurrency } : {}),
      ...(ro.limit > 0 ? { limit: ro.limit } : {}),
      ...(Object.keys(overrides).length ? { overrides } : {}),
      ...(only ? { only } : {}),
      ...(extra.options || {}),
    };
    const body = { kind, dir, options };
    if (only) logLine(t`仅处理 ${only.length} 个文件${extra.only ? t('（单文件）') : t('（已勾选）')}`);
    if (Object.keys(overrides).length) logLine(t`手动番号 ${Object.keys(overrides).length} 个：` + Object.values(overrides).join(', '));
    logLine(t`本轮选项：${force ? t('强制重跑 · ') : ''}${downloadSubs ? t('下载字幕 · ') : t('不下载字幕 · ')}并发 ${ro.concurrency}${ro.limit ? t` · 前 ${ro.limit} 条` : ''}`);
    const r = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    state.job = { id: r.jobId, kind, dir, status: 'running' };
    state.jobStartedAt = Date.now();
    state.running = true;
    state.lastPlan = null;
    clearPlanSummary();
    updateStats();
    logLine(t`任务已创建：${r.jobId.slice(0, 8)}（${kind === 'plan' ? t('预演') : t('应用')}）`);
    openEvents(r.jobId);
    checkHealth(); // SPEC4 A3：刷新排队数/运行状态
  } catch (e) {
    state.running = false;
    $('#liveDots').innerHTML = t('<i></i>空闲');
    toastErr(t('创建任务失败'), e);
    updateStats();
  } finally {
    state.starting = false;
  }
}

/** 统一收尾：snapshot 里已是终态 / job-finished 事件 / 手动重新同步 都走这里（幂等） */
function finishJob(job) {
  if (!job || !job.id) return;
  if (state.finishedJobId === job.id) return;
  state.finishedJobId = job.id;
  const kind = job.kind || (state.job && state.job.kind) || 'plan';
  state.running = false;
  state.job = { id: job.id, kind, dir:job.dir, status: job.status, journal: job.journal || null };
  if (state.es) { try { state.es.close(); } catch { /* ignore */ } state.es = null; }
  $('#liveDots').innerHTML = t('<i></i>空闲');
  if ($('#btnResync')) $('#btnResync').classList.add('hidden');
  const label = JOB_STATUS_TEXT[job.status] || job.status || t('已结束');
  $('#jobState').textContent = label;
  const p = job.progress || null;
  const total = Number((p && p.total) || state.total || 0);
  if (total) { state.total = total; state.progressDone = total; updateProgress(total, total, label); }
  // B5：记录本次任务耗时/处理数，供「预计耗时」使用
  const t0 = job.startedAt || state.jobStartedAt || job.createdAt;
  if (t0 && job.finishedAt && total > 0) state.lastJobStats = { durationMs: job.finishedAt - t0, count: total };
  state.jobStartedAt = null;
  if ($('#kTime').textContent === '—') {
    const t0s = job.startedAt || job.createdAt;
    if (job.finishedAt && t0s) $('#kTime').textContent = ((job.finishedAt - t0s) / 1000).toFixed(1) + 's';
  }
  if (job.status === 'done') {
    toast(kind === 'apply' ? t('应用完成') : t('预演完成'), 'ok');
    if (kind === 'apply') {
      setStep(3, 'done');
      loadReport(job.id, 'apply');
      setTimeout(() => scan(), 600);
    } else {
      setStep(2, 'done');
      loadReport(job.id, 'plan');
    }
  } else if (job.status === 'cancelled') {
    toast(t('任务已取消，已完成的部分会保留'));
    setStep(1, 'on');
  } else if (job.status === 'aborted') {
    toast(t('任务因连续失败中止，请检查代理/VPN'), 'err');
    setStep(1, 'on');
  } else {
    const first = job.error ? String(job.error).split('\n')[0] : '';
    toast(t('任务失败：') + (first === 'interrupted_by_restart' ? t('任务因后端重启中断') : (first || label)), 'err');
    setStep(1, 'on');
  }
  updateStats();
  resetDocumentTitle();
  notifyJobFinished(kind, job); // B7：终态浏览器通知
  const histView = $('#view-history');
  if (histView && !histView.classList.contains('hidden')) loadHistory(); // B13：运行结束恢复撤销按钮
  checkHealth(); // SPEC4 A3：任务结束刷新排队数
}

/** 事件流多次断开后：重新拉取后端状态（§3.6） */
async function resync() {
  if ($('#btnResync')) $('#btnResync').classList.add('hidden');
  state.esErrors = 0;
  await checkHealth();
  if (state.job?.id) {
    try {
      const job = await api(`/api/jobs/${state.job.id}`);
      if (job && job.status && !['queued', 'running'].includes(job.status)) finishJob(job);
      else if (!state.es) {
        state.running = true;
        openEvents(state.job.id);
        updateStats();
      }
    } catch (e) { toastErr(t('重新同步任务失败'), e); }
  }
  toast(t('已重新同步后端状态'), 'ok');
  if (!$('#view-history').classList.contains('hidden')) loadHistory();
}

function openEvents(jobId) {
  if (state.es) { try { state.es.close(); } catch { /* ignore */ } state.es = null; }
  state.esErrors = 0;
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  state.es = es;
  es.onmessage = (ev) => {
    state.esErrors = 0;
    if ($('#btnResync')) $('#btnResync').classList.add('hidden');
    let data; try { data = JSON.parse(ev.data); } catch { return; }
    const draftChanged=state.job?.dir && state.dir && state.job.dir.toLowerCase()!==state.dir.toLowerCase();
    if(draftChanged && ['start','file-start','file-done','file-error','file-skipped'].includes(data.type))return;
    switch (data.type) {
      case 'snapshot': {
        const tail = Array.isArray(data.tail) ? data.tail : [];
        tail.forEach((t) => logLine(typeof t === 'string' ? t : (t.line || '')));
        const job = data.job || {};
        const p = job.progress || null;
        if (p && p.total) { state.total = Number(p.total) || 0; state.progressDone = Number(p.done) || 0; }
        if (job.status && !['queued', 'running'].includes(job.status)) {
          logLine(t`任务状态：${JOB_STATUS_TEXT[job.status] || job.status}`);
          finishJob(job);
        } else if (state.total) {
          if (!state.jobStartedAt) state.jobStartedAt = Date.now();
          updateProgress(state.progressDone, state.total, JOB_STATUS_TEXT.running);
        }
        break;
      }
      case 'log': logLine(String(data.line ?? '')); break;
      case 'start': {
        state.total = Number(data.total) || 0;
        state.progressDone = 0;
        if (!state.jobStartedAt) state.jobStartedAt = Date.now();
        logLine(t`开始处理：${data.total} 个文件（${data.apply ? t('应用') : t('预演')}）`);
        updateProgress(0, state.total, JOB_STATUS_TEXT.running);
        break;
      }
      case 'file-start': {
        const it = state.itemByPath.get(data.file);
        if (it) { it.status = 'running'; }
        if (it) patchRow(data.file);
        break;
      }
      case 'file-done': {
        state.progressDone++;
        const it = state.itemByPath.get(data.file);
        if (it) {
          Object.assign(it, {
            status: data.status,
            code: data.code || it.code,
            newName: data.newName || it.newName,
            sub: data.sub || it.sub,
            meta: data.result?.meta || it.meta,
            renamedTo: data.result?.renamedTo || it.renamedTo,
            rename: data.result?.rename || it.rename,
            // SPEC3：应用/预演结果直接携带封面落地信息，行内立即显示「封面 ✓」
            cover: data.result?.cover || it.cover,
            coverPath: data.result?.cover?.path || it.coverPath,
            coverPlanned: data.result?.coverPlanned ?? it.coverPlanned,
            applied: data.result?.applied ?? it.applied,
            stage: data.result?.stage || it.stage,
          });
        }
        logLine(`→ ${data.status}${data.code ? ' ' + data.code : ''}${data.sub ? t(' | 字幕 ') + data.sub.source : ''}`);
        patchRow(data.file);
        updateProgress(state.progressDone, state.total || state.items.length, JOB_STATUS_TEXT.running);
        break;
      }
      case 'file-error': {
        state.progressDone++;
        const it = state.itemByPath.get(data.file);
        if (it) it.status = 'error';
        logLine(`! ${data.name || data.file}：${data.error}`, 'er');
        patchRow(data.file);
        updateProgress(state.progressDone, state.total || state.items.length, JOB_STATUS_TEXT.running);
        break;
      }
      case 'file-skipped': {
        state.progressDone++;
        const it = state.itemByPath.get(data.file);
        if (it) it.status = data.status || 'skipped';
        logLine(t`- 跳过（已处理）：${data.name || data.file}`, 'wr');
        patchRow(data.file);
        updateProgress(state.progressDone, state.total || state.items.length, JOB_STATUS_TEXT.running);
        break;
      }
      case 'done': {
        state.total = Number(data.total) || state.total || state.progressDone;
        state.progressDone = state.total;
        if (state.total) updateProgress(state.total, state.total, data.cancelled ? t('正在取消…') : t('收尾中…'));
        const ms = Number(data.durationMs) || 0;
        if ($('#kTime')) $('#kTime').textContent = (ms / 1000).toFixed(1) + 's';
        logLine(t`完成：${summaryText(data.summary)} · ${(ms / 1000).toFixed(1)}s`, 'ok');
        break;
      }
      case 'job-finished': finishJob(data.job || {}); break;
      case 'job-started': break;
      default: break;
    }
  };
  es.onerror = () => {
    state.esErrors = (state.esErrors || 0) + 1;
    if (state.esErrors >= 3) {
      if ($('#btnResync')) $('#btnResync').classList.remove('hidden');
      logLine(t('实时事件连续中断：请点「重新同步」恢复后端状态'), 'wr');
    } else {
      logLine(t`事件流断开（第 ${state.esErrors} 次），尝试重连…`, 'wr');
    }
  };
}

async function loadReport(jobId, kind) {
  try {
    const rep = await api(`/api/jobs/${jobId}/report`);
    if (state.dir && rep.dir && state.dir.toLowerCase()!==rep.dir.toLowerCase()) {return;}
    if (kind === 'plan') state.lastPlan = rep;
    // B5：报告里带 durationMs 时缓存，用于「预计耗时」
    const repN = Array.isArray(rep.results) ? rep.results.length : 0;
    if (Number(rep.durationMs) > 0 && repN > 0) state.lastJobStats = { durationMs: Number(rep.durationMs), count: repN };
    // 合并报告里的结果（保证状态一致）；只 patch 单行，不整表重建
    const touched = new Set();
    for (const r of rep.results || []) {
      const it = state.itemByPath.get(r.originalFile) || state.itemByPath.get(r.file) || state.itemByPath.get(r.renamedTo)
        || state.items.find((x) => x.path === r.file || x.renamedTo === r.file || x.path === r.renamedTo);
      if (it) {
        Object.assign(it, {
          status: r.status,
          code: r.code || it.code,
          newName: r.newName || it.newName,
          sub: r.sub || it.sub,
          meta: r.meta || it.meta,
          renamedTo: r.renamedTo || it.renamedTo,
          rename: r.rename || it.rename,
          // SPEC3：report 结果同名字段合并，应用后行内立即显示「封面 ✓」
          cover: r.cover || it.cover,
          coverPath: r.cover?.path || it.coverPath,
          coverPlanned: r.coverPlanned ?? it.coverPlanned,
          applied: rep.apply === true,
          stage: rep.apply ? 'apply' : 'plan',
        });
        if (it.code && it.manualCode) state.selected.add(it.path);
        touched.add(it.path);
      }
    }
    for (const p of touched) patchRow(p);
    if (kind === 'plan') renderPlanSummary();
    updateStats();
    return rep;
  } catch (e) {
    // report 可能还没写盘；把错误留给调试面板
    window.__lastLoadReportError = String((e && e.stack) || e);
    console.error('loadReport failed:', e);
  }
}

async function cancelJob() {
  if (!state.job?.id) return;
  const ok = await confirmDialog(t('取消任务'), t('当前文件会处理完再停止，已完成的部分会保留。确定取消？'), t('取消任务'));
  if (!ok) return;
  try {
    await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' });
    toast(t('已请求取消'));
    checkHealth(); // SPEC4 A3：取消后刷新排队数
  } catch (e) { toastErr(t('取消失败'), e); }
}

async function exportReport() {
  const jobs = await api('/api/jobs').catch(() => null);
  let jobId = state.job?.id;
  if (!jobId && jobs?.jobs?.length) jobId = jobs.jobs[0].id;
  if (!jobId) { toast(t('没有可导出的报告')); return; }
  try {
    const rep = await api(`/api/jobs/${jobId}/report`);
    const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `avc-run-${jobId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t('报告已导出'), 'ok');
  } catch (e) { toastErr(t('导出失败'), e); }
}

// ---------------- 详情抽屉（F8：番号修正 / 单文件预演 / 仅重跑） ----------------
function normalizeCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    const code = typeof c === 'string'
      ? String(c).replace(/\(.*$/, '').trim()
      : String(c?.code || '').trim();
    if (!code || seen.has(code.toUpperCase())) continue;
    seen.add(code.toUpperCase());
    out.push({ code, score: typeof c === 'object' && c ? c.score : null });
  }
  return out;
}

function renameActionHtml(rename) {
  if (!rename || !rename.from) return '';
  const act = RENAME_ACTION_TEXT[rename.action] || rename.action || t('计划');
  const bad = rename.action === 'skip_conflict' || rename.action === 'skip_duplicate';
  const warn = !bad && !!rename.batchConflict;
  return `<div class="rename-info"><span class="r-act${bad ? ' bad' : warn ? ' warn' : ''}">${esc(act)}</span>${esc(pathBase(rename.from))}${rename.to && rename.to !== rename.from ? ` → <b>${esc(pathBase(rename.to))}</b>` : ''}${rename.reason ? t`<div class="note">原因：${esc(rename.reason)}</div>` : ''}${rename.batchConflict ? t('<div class="note">同批多个文件指向同一个目标名</div>') : ''}</div>`;
}

function currentDrawerItem() {
  return state.items.find((x) => x.path === state.drawerPath) || state.itemByPath.get(state.drawerPath) || null;
}

function renderDrawer() {
  const filePath = state.drawerPath;
  const it = currentDrawerItem();
  if (!it) { closeDrawer(); return; }
  const meta = it.meta || {};
  const sub = it.sub || null;
  const st = STATUS[it.status] || STATUS.unresolved;
  const localCover = it.cover?.path ? '/api/cover?path=' + encodeURIComponent(it.cover.path) : '';
  const remoteCover = meta.coverUrl ? '/api/cover?url=' + encodeURIComponent(meta.coverUrl) : '';
  const coverSrc = localCover || remoteCover;
  const cover = coverSrc
    ? t`<span class="cover-label">封面</span><img src="${esc(coverSrc)}" alt="cover" loading="lazy" onerror="this.style.display='none';this.parentNode.classList.add('cover-fail')"><span class="cover-fail-tip">封面加载失败</span>`
    : t('<span class="cover-label">封面</span>');
  const chips = normalizeCandidates(it.candidates);
  const applied = it.applied === true || it.stage === 'apply' || !!it.renamedTo;
  const coverState = coverStateOf(it);
  const coverUrl = coverSourceUrl(it);
  const canFetchCover = !!coverUrl;
  // 静态字幕候选块：渲染前先从旧位置摘除（保留节点与已绑定事件），渲染后移动进字幕区
  const subBox = $('#subManualBox');
  if (subBox) subBox.remove();
  $('#dTitle').textContent = it.code || t('详情');
  $('#drawerBody').innerHTML = t`
    <div class="cover">${cover}</div>
    <div class="titlerow" style="margin-bottom:6px">
      <span class="stat-pill ${st.cls}">${esc(st.label)}</span>
      ${it.code ? `<span class="tag">${esc(it.code)}</span>` : ''}
      ${it.duplicates?.length ? t('<span class="stat-pill s-warn">重复番号</span>') : ''}
    </div>
    <div style="font-weight:600;font-size:calc(14px * var(--font-scale,1));line-height:1.5">${esc((it.newName || it.name).replace(/\.[^.]+$/, ''))}</div>
    <div class="oldname" style="margin-top:4px">${esc(it.name)}</div>
    <h4>番号与单文件操作</h4>
    <div class="codeedit">
      <input class="d-code" type="text" value="${esc(it.code || '')}" placeholder="如 IPX-920" spellcheck="false" autocomplete="off" />
      <button class="btn sm" data-act="preview">预演此文件</button>
    </div>
    ${chips.length ? `<div class="chips">${chips.map((c) => `<button class="chip" data-code="${esc(c.code)}" title="${esc(c.score != null ? t('评分 ') + c.score : t('候选番号'))}">${esc(c.code)}${c.score != null ? ' · ' + esc(c.score) : ''}</button>`).join('')}</div>` : ''}
    ${renameActionHtml(it.rename)}
    <div class="d-actions">
      <button class="btn sm" data-act="rerun-plan">仅重跑此文件（预演）</button>
      ${applied ? t('<button class="btn sm solid" data-act="rerun-apply">仅应用此文件</button>') : ''}
    </div>
    <h4>元数据 <button class="btn sm" id="wfEditFields">${t('修正与锁定')}</button></h4>
    <dl class="kv">
      <dt>番号</dt><dd>${esc(it.code || '—')}</dd>
      <dt>标题</dt><dd>${esc(meta.titleJa || meta.titleZh || '—')}</dd>
      <dt>女优</dt><dd>${esc(meta.actress?.join('、') || '—')}</dd>
      <dt>厂牌</dt><dd>${esc(meta.maker || '—')}</dd>
      <dt>发行</dt><dd>${esc(meta.releaseDate || '—')}</dd>
      <dt>片长</dt><dd>${meta.durationMin ? esc(meta.durationMin) + t(' 分钟') : '—'}${meta.durationSource === 'probe' ? t('（实测）') : ''}</dd>
      <dt>大小</dt><dd>${fmtSize(it.size)}</dd>
    </dl>
    <h4>字幕</h4>
    ${sub
      ? t`<dl class="kv">
          <dt>来源</dt><dd>${esc(sub.source || '—')}${sub.name ? ' · ' + esc(sub.name) : ''}</dd>
          <dt>语言</dt><dd>${esc(sub.verdict || 'zh')}</dd>
          <dt>条数</dt><dd>${sub.cues != null ? esc(sub.cues) : '—'} cue${sub.candidates ? t`（共 ${esc(sub.candidates)} 个候选）` : ''}</dd>
          <dt>字节</dt><dd>${sub.bytes != null ? fmtSize(sub.bytes) : '—'}</dd>
          ${sub.fit ? t`<dt>时间校正</dt><dd>${esc(sub.fit.applied)}${sub.fit.factor ? ' ×' + Number(sub.fit.factor).toFixed(4) : ''}${sub.fit.shiftSec ? ' ' + Number(sub.fit.shiftSec).toFixed(1) + 's' : ''}</dd>` : ''}
          <dt>文件</dt><dd>${esc(sub.path || sub.targetPath || '—')}</dd>
          ${sub.warnings?.length ? t`<dt>警告</dt><dd style="color:var(--amber)">${esc(sub.warnings.join(', '))}</dd>` : ''}
        </dl>`
      : `<div class="tip">${it.status === 'no_subtitle' ? t('已尝试全部字幕源，没有找到简体中文字幕。可以点下方「列出候选字幕」手动选择。') : t('尚未处理或未识别。可以点下方「列出候选字幕」手动选择。')}</div>`}
    ${(sub?.path || sub?.targetPath) ? t`<div class="sub-actions"><button class="btn sm" data-act="sub-preview">预览字幕</button><span class="note">只读预览前 30 条，不会修改文件</span></div>` : ''}
    <div class="sub-manual-slot"></div>
    <h4>封面</h4>
    <dl class="kv">
      <dt>状态</dt><dd class="${coverState === 'failed' ? 'cover-dd-err' : ''}">${esc(coverStatusText(it))}</dd>
      ${coverState === 'local' ? t`
        <dt>文件</dt><dd>${esc(it.cover.path)}</dd>
        ${it.cover.posterPath ? `<dt>poster</dt><dd>${esc(it.cover.posterPath)}</dd>` : ''}
        ${it.cover.embedded ? t`<dt>已嵌入</dt><dd>${esc(it.cover.method || 'yes')}</dd>` : t`<dt>嵌入</dt><dd>${esc(it.cover.embedSkipped || it.cover.embedError || t('未嵌入'))}</dd>`}` : ''}
      ${coverState === 'planned' ? t`
        <dt>来源</dt><dd class="drawer-url">${esc(coverUrl || '—')}</dd>
        <dt>目标</dt><dd class="drawer-url">${esc(coverTargetPath(it) || t('（应用时确定）'))}</dd>` : ''}
      ${coverState === 'failed' ? t`
        <dt>错误</dt><dd class="cover-dd-err">${esc(coverErrorLabel(it.cover) || t('未知错误'))}</dd>
        ${coverTargetPath(it) ? t`<dt>目标</dt><dd class="drawer-url">${esc(coverTargetPath(it))}</dd>` : ''}` : ''}
      ${coverState === 'remote' ? t`
        <dt>来源</dt><dd class="drawer-url">${esc(coverUrl)}</dd>
        <dt>说明</dt><dd>预演/应用后会下载到视频旁（同名图片）。</dd>` : ''}
      ${coverState === 'none' ? t('<dt>说明</dt><dd>该作品没有封面地址；可先「预演此文件」重新获取元数据。</dd>') : ''}
    </dl>
    <div class="cover-actions">
      <button class="btn sm" data-act="cover-fetch" ${canFetchCover ? '' : 'disabled'} title="${canFetchCover ? t('立即下载封面到视频旁（会备份已有同名图片）') : t('没有可用的封面地址')}">下载封面</button>
      <span class="note">覆盖前会备份已有同名封面/poster。</span>
    </div>
    <h4>路径</h4>
    <div class="pathbox">${esc(it.path)}</div>
    ${it.renamedTo ? t`<h4>已重命名为</h4><div class="pathbox">${esc(it.renamedTo)}</div>` : ''}
    ${it.error ? t`<h4>错误</h4><div class="pathbox" style="color:var(--red)">${esc(it.error)}</div>` : ''}
  `;
  const slot = $('#drawerBody').querySelector('.sub-manual-slot');
  if (slot && subBox) slot.parentNode.replaceChild(subBox, slot);
  // B9：抽屉封面点击看大图；加载失败显示占位（不静默移除）
  const coverBox = $('#drawerBody .cover');
  if (coverBox) {
    coverBox.onclick = () => { if (coverDisplaySrc(it)) openCoverModal(it); };
    const img = coverBox.querySelector('img');
    if (img) img.onerror = () => { coverBox.classList.add('cover-fail'); if (img.parentNode) img.style.display = 'none'; };
  }
  if($('#wfEditFields'))$('#wfEditFields').onclick=()=>workflows?.openEditor(it.path);
  resetSubManualUi();
  updateDrawerNav();
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute?.('aria-hidden','false');
  focusFirst($('#drawer'));
}

function openDrawer(filePath) {
  state.drawerPath = filePath;
  renderDrawer();
}
function closeDrawer() { resetSubManualUi();$('#drawer').classList.remove('open');$('#drawer').setAttribute?.('aria-hidden','true'); }

// ---------------- 手动字幕候选 / 手动下载封面（SPEC3） ----------------
const SUB_BACKUP_NOTE = '手动选择的字幕会覆盖同名 .srt；旧文件会备份为 .avc-bak-*。';
let subCandidates = [];
let subGeneration=0,subContext=null,subRequest=null;

function setSubTip(text, isErr) {
  const tip = $('#subTip');
  if (!tip) return;
  tip.textContent = text || t(SUB_BACKUP_NOTE);
  tip.classList.toggle('err', !!isErr);
}

/** 每次重绘抽屉时重置手动字幕区（候选不跨文件/跨刷新保留） */
function resetSubManualUi() {
  subGeneration++;subRequest?.abort();subRequest=null;subContext=null;
  subCandidates = [];
  const list = $('#subCandidates');
  if (list) list.innerHTML = '';
  setSubTip('', false);
  const btn = $('#subListBtn');
  if (btn) { btn.disabled = false; btn.textContent = t('列出候选字幕'); }
}

function subtitleSourceLabel(source) {
  if (source === 'local') return t('本地');
  return source || t('未知源');
}

function renderSubCandidates(cands) {
  const box = $('#subCandidates');
  if (!box) return;
  const list = Array.isArray(cands) ? cands : [];
  if (!list.length) { box.innerHTML = t('<div class="sub-empty">没有可用的字幕候选。</div>'); return; }
  box.innerHTML = list.map((c, i) => {
    const name = String(c.name || c.localPath || t('未命名字幕'));
    const title = String(c.localPath || c.url || name);
    return t`<div class="sub-cand">
      <span class="sub-cand-tag">${esc(subtitleSourceLabel(c.source))}</span>
      <span class="sub-cand-lang">${esc(c.lang || 'zh')}</span>
      <span class="sub-cand-name" title="${esc(title)}">${esc(pathBase(name))}</span>
      <button class="btn sm" data-sub-apply="${i}">下载此字幕</button>
    </div>`;
  }).join('') + `<button class="btn sm" id="wfCompareCandidates">${t('对比两个候选')}</button>`;
  $('#wfCompareCandidates').onclick=()=>workflows?.openCompare(state.drawerPath,list);
}

function subtitleErrorText(e) {
  if (e && e.status === 404) return t('后端未提供字幕接口（需要更新后端版本）');
  if (e && e.status === 409) return t('任务运行中，稍后再试');
  const body = (e && e.body) || {};
  if (body.error === 'code_required') return t('该文件没有识别到番号，请先在番号框填写或补番号');
  if (body.error === 'candidate_required') return t('缺少要安装的字幕候选');
  const reason = body.reason ? String(body.reason) : '';
  if (reason) {
    const map = { not_srt: t('不是有效的 SRT 字幕文件'), empty: t('字幕内容为空') };
    return map[reason] || t`字幕被拒绝：${reason}`;
  }
  if (body.error && ERRMSG[body.error]) return ERRMSG[body.error];
  return errText(e);
}

async function listSubtitleCandidates() {
  const it = currentDrawerItem();
  if (!it) return;
  resetSubManualUi();
  const generation=subGeneration,file=it.path,controller=new AbortController();subRequest=controller;
  const btn = $('#subListBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('列出中…'); }
  setSubTip(t('正在列出候选字幕…'), false);
  const box = $('#subCandidates');
  if (box) box.innerHTML = '';
  try {
    const codeInput = $('#drawerBody .d-code');
    const code = String((codeInput && codeInput.value) || it.code || '').trim();
    const r = await api('/api/subtitles/candidates', {
      method: 'POST',
      signal:controller.signal,
      body: JSON.stringify({ file: it.path, ...(code ? { code } : {}) }),
    });
    if(generation!==subGeneration||state.drawerPath!==file||r.file!==file)return;
    subContext=Object.freeze({file,code:r.code,token:r.contextToken,generation});
    subCandidates = Array.isArray(r.candidates) ? r.candidates : [];
    renderSubCandidates(subCandidates);
    if (subCandidates.length) {
      setSubTip(t`共 ${subCandidates.length} 个候选${r.code ? t`（番号 ${r.code}）` : ''}；点击「下载此字幕」安装。${t(SUB_BACKUP_NOTE)}`, false);
    } else {
      setSubTip(t('没有找到可用的字幕候选，可以换个番号或稍后重试。'), false);
    }
  } catch (e) {
    if(generation!==subGeneration||controller.signal.aborted)return;
    subCandidates = [];
    setSubTip(subtitleErrorText(e), true);
    toast(t('列字幕候选失败：') + subtitleErrorText(e), 'err');
  } finally {
    if (generation===subGeneration&&btn) { btn.disabled = false; btn.textContent = t('列出候选字幕'); }
  }
}

async function applySubtitleCandidate(candidate, btn) {
  const context=subContext,it=context&&state.itemByPath.get(context.file);
  if (!it || !candidate||context.generation!==subGeneration||state.drawerPath!==context.file||candidate.contextToken!==context.token) return;
  if (btn) { btn.disabled = true; btn.textContent = t('安装中…'); }
  try {
    const r = await api('/api/subtitles/apply', { method: 'POST', body: JSON.stringify({ file: context.file,code:context.code,candidate }) });
    if(context.generation!==subGeneration||state.drawerPath!==context.file)return;
    it.sub = {
      ...(it.sub || {}),
      source: candidate.source || r.source || it.sub?.source,
      lang: candidate.lang || r.lang || it.sub?.lang,
      name: candidate.name || it.sub?.name,
      path: r.path,
      bytes: r.bytes,
      cues: r.cues,
      verdict: r.verdict,
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
      backup: r.backup || null,
      fit: r.fit || null,
    };
    if (it.status === 'no_subtitle') it.status = 'ok';
    invalidatePlan();
    patchRow(it.path);
    renderDrawer();
    const wh = Array.isArray(r.warnings) && r.warnings.length ? t` · 警告：${r.warnings.join(', ')}` : '';
    toast(t`字幕已安装：${r.cues != null ? r.cues + ' cue' : t('已写入')} · ${r.verdict || candidate.lang || 'zh'}${r.backup ? t(' · 旧字幕已备份') : ''}${wh}`, 'ok');
  } catch (e) {
    const msg = subtitleErrorText(e);
    setSubTip(msg, true);
    toast(t('字幕安装失败：') + msg, 'err');
    if (btn) { btn.disabled = false; btn.textContent = t('下载此字幕'); }
  }
}

function coverFetchErrorText(e) {
  if (e && e.status === 404) return t('后端未提供 /api/cover/fetch 接口（需要更新后端版本）');
  if (e && e.status === 409) return t('任务运行中，稍后再试');
  if (e && e.status === 502) return t('封面下载失败（网络或代理问题），请稍后重试');
  const code = (e && e.body && e.body.error) || '';
  if (code && ERRMSG[code]) return t(ERRMSG[code]);
  if (code === 'cover_url_missing') return t('该作品没有可用封面地址');
  return errText(e);
}

/** SPEC3：手动下载封面（POST /api/cover/fetch），成功后刷新行 + 抽屉 */
async function fetchCover(it) {
  const item = it || currentDrawerItem();
  if (!item) return;
  const url = coverSourceUrl(item);
  if (!url) { toast(t('该作品没有可用封面地址，无法下载'), 'err'); return; }
  const btn = $('#drawerBody [data-act="cover-fetch"]');
  if (btn) { btn.disabled = true; btn.textContent = t('下载中…'); }
  try {
    const body = { file: item.path };
    // 状态库里没有 meta.coverUrl 时显式带上计划 URL，避免后端取不到封面地址
    if (!item.meta?.coverUrl) body.url = url;
    const r = await api('/api/cover/fetch', { method: 'POST', body: JSON.stringify(body) });
    item.cover = { ...(item.cover || {}), ...r, path: r.path, posterPath: r.posterPath || null, error: null };
    item.coverPath = r.path || item.coverPath;
    item.coverPlanned = null;
    patchRow(item.path);
    renderDrawer();
    toast(t`封面已下载：${pathBase(r.path)}（${fmtSize(r.bytes)}）${r.backup ? t(' · 旧封面已备份') : ''}`, 'ok');
  } catch (e) {
    const msg = coverFetchErrorText(e);
    toast(t('下载封面失败：') + msg, 'err');
    if (btn) { btn.disabled = false; btn.textContent = t('下载封面'); }
  }
}

/** SPEC4 C2：字幕内容预览（只读，前 30 条） */
function subtitlePreviewErrorText(e) {
  const code = e && e.body && e.body.error;
  const map = {
    path_required: t('缺少字幕路径'),
    not_srt: t('不是 .srt 字幕文件，无法预览'),
    fs_forbidden: t('字幕文件不在允许的目录范围内'),
    not_found: t('字幕文件不存在（可能已被移动或删除）'),
    file_too_large: t('字幕文件太大（>8MB），无法预览'),
  };
  if (code && map[code]) return map[code];
  if (e && e.status === 404) return t('后端未提供字幕预览接口（需要更新后端版本）');
  return errText(e);
}

function renderCueHtml(c) {
  const start = String(c?.start || '');
  const end = String(c?.end || '');
  const text = String(c?.text ?? '');
  return `<div class="cue"><div class="cue-time">${esc(start)} --&gt; ${esc(end)}</div><div class="cue-text">${esc(text)}</div></div>`;
}

async function previewSubtitle(subPath) {
  const modal = $('#subPreviewModal');
  if (!modal) return;
  const pathStr = String(subPath || '');
  if (!pathStr) { toast(t('当前文件没有字幕路径，无法预览'), 'err'); return; }
  $('#subPreviewTitle').textContent = t`字幕预览 · ${pathBase(pathStr)}`;
  const meta = $('#subPreviewMeta');
  const body = $('#subPreviewBody');
  if (meta) meta.textContent = t('加载中…');
  if (body) body.innerHTML = t('<div class="empty">加载中…</div>');
  modal.classList.add('open');
  focusFirst(modal);
  try {
    const r = await api('/api/subtitle/preview?path=' + encodeURIComponent(pathStr) + '&lines=30');
    const cues = Array.isArray(r.cues) ? r.cues : [];
    if (meta) {
      const bits = [
        t`编码 ${esc(r.encoding || '?')}`,
        t`共 ${esc(r.count ?? '?')} 条`,
        t`大小 ${fmtSize(r.bytes)}`,
        r.lastEndSec != null ? t`末条结束 ${fmtDurationSec(r.lastEndSec)}` : '',
        r.truncated ? t`显示前 ${cues.length} 条` : '',
      ].filter(Boolean);
      meta.innerHTML = bits.map((b) => `<span class="subpreview-chip">${b}</span>`).join('');
    }
    if (body) body.innerHTML = cues.length ? cues.map(renderCueHtml).join('') : t('<div class="empty">字幕内容为空</div>');
  } catch (e) {
    const msg = subtitlePreviewErrorText(e);
    if (meta) meta.textContent = '';
    if (body) body.innerHTML = t`<div class="empty">预览失败：${esc(msg)}</div>`;
  }
}

/** F8：POST /api/preview 预演单个文件（不落盘），成功后合并进 item 并刷新 */
async function previewFile(it) {
  const input = $('#drawerBody .d-code');
  const code = input ? input.value.trim().toUpperCase() : '';
  const btn = $('#drawerBody [data-act="preview"]');
  if (btn) { btn.disabled = true; btn.textContent = t('预演中…'); }
  try {
    const r = await api('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ file: it.path, code: code || null, downloadSubs: currentRunOpts().downloadSubs }),
    });
    Object.assign(it, {
      status: r.status || it.status,
      code: r.code || code || it.code,
      meta: r.meta || it.meta,
      newName: r.newName || it.newName,
      sub: r.sub !== undefined ? r.sub : it.sub,
      rename: r.rename || it.rename,
      candidates: Array.isArray(r.candidates) ? r.candidates : it.candidates,
      cover: r.cover || it.cover,
      coverPlanned: r.coverPlanned ?? it.coverPlanned,
    });
    if (r.sub) state.selected.add(it.path);
    invalidatePlan();
    patchRow(it.path);
    renderDrawer();
    const conflict = r.rename && (r.rename.action === 'skip_conflict' || r.rename.batchConflict);
    const act = r.rename ? (RENAME_ACTION_TEXT[r.rename.action] || r.rename.action) : '';
    toast(t`预演完成：${r.code || t('无番号')}${act ? ' · ' + act : ''}`, conflict ? 'err' : 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('预演此文件'); }
    const msg = e.status === 404 ? t('后端未提供 /api/preview 接口（需要 v0.6 后端）') : errText(e);
    toast(t('预演失败：') + msg, 'err');
  }
}

/** F8：仅重跑/仅应用此文件（only + overrides + force） */
function rerunOne(it, kind) {
  const input = $('#drawerBody .d-code');
  const code = input ? input.value.trim().toUpperCase() : '';
  const overrides = code ? { [it.path]: code } : {};
  closeDrawer();
  startJob(kind, { dir: state.dir || pathDir(it.path), only: [it.path], overrides, force: true });
}

function onDrawerClick(e) {
  const chip = e.target.closest('.chip');
  if (chip) {
    const input = $('#drawerBody .d-code');
    if (input) input.value = chip.dataset.code || '';
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const it = currentDrawerItem();
  if (!it) return;
  const act = btn.dataset.act;
  if (act === 'preview') previewFile(it);
  else if (act === 'rerun-plan') rerunOne(it, 'plan');
  else if (act === 'rerun-apply') rerunOne(it, 'apply');
  else if (act === 'cover-fetch') fetchCover(it);
  else if (act === 'sub-preview') previewSubtitle(it.sub?.path || it.sub?.targetPath || '');
}

/** F16：无番号反查（按标题/演员），候选 chips 点击填入番号输入框 */
function lookupChipHtml(c) {
  const code = String(c?.code || '').trim();
  if (!code) return '';
  const bits = [c.maker, c.releaseDate].filter(Boolean).map((x) => esc(x)).join(' · ');
  const title = String(c.title || '');
  return `<button type="button" class="flt-chip flt-cand" data-code="${esc(code)}" title="${esc(title || code)}"><b>${esc(code)}</b>${bits ? `<span class="flt-cand-meta">${bits}</span>` : ''}</button>`;
}

function renderLookupCandidates(list) {
  const box = $('#lookupResults');
  const tip = $('#lookupTip');
  if (!box) return;
  const cands = Array.isArray(list) ? list : [];
  box.innerHTML = cands.map(lookupChipHtml).join('');
  if (tip) {
    tip.classList.remove('err');
    tip.textContent = cands.length ? t`找到 ${cands.length} 个候选，点击即可填入番号。` : '';
  }
}

function lookupErrorText(e) {
  if (e && e.status === 404) return t('后端未提供 /api/lookup 接口（需要更新到 v0.7 后端）');
  if (e && e.status === 502) return t('反查失败：搜索服务暂时不可用（检查网络或代理后重试）');
  if (e && !e.status) return t('反查失败：无法连接后端（请确认服务已启动）');
  return errText(e);
}

async function runLookup() {
  const input = $('#lookupKeyword');
  const btn = $('#btnLookup');
  const tip = $('#lookupTip');
  const box = $('#lookupResults');
  const keyword = String(input?.value || '').trim();
  if (!keyword) {
    if (tip) { tip.classList.add('err'); tip.textContent = t('请输入标题或演员名再反查。'); }
    input?.focus();
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = t('反查中…'); }
  if (tip) { tip.classList.remove('err'); tip.textContent = t('正在搜索候选番号…'); }
  try {
    const r = await api('/api/lookup', { method: 'POST', body: JSON.stringify({ keyword }) });
    renderLookupCandidates(r?.candidates);
    if (tip && !(Array.isArray(r?.candidates) && r.candidates.length)) {
      tip.textContent = t('没有找到匹配的番号，换个标题或演员名再试。');
    }
  } catch (e) {
    if (box) box.innerHTML = '';
    if (tip) { tip.classList.add('err'); tip.textContent = lookupErrorText(e); }
    toast(t('反查失败：') + lookupErrorText(e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('反查'); }
  }
}

function onLookupResultsClick(e) {
  const chip = e.target.closest('[data-code]');
  if (!chip) return;
  const code = chip.dataset.code || '';
  const input = $('#drawerBody .d-code');
  if (input) { input.value = code; input.focus(); }
  toast(t`已填入番号 ${code}`, 'ok');
}

// ---------------- 历史与日志（F9） ----------------
function jobStatusPill(status) {
  const cls = status === 'done' ? 's-ok'
    : status === 'failed' ? 's-err'
      : (status === 'cancelled' || status === 'aborted') ? 's-skip' : 's-warn';
  return `<span class="stat-pill ${cls}">${esc(t(JOB_STATUS_TEXT[status] || status))}</span>`;
}

async function showJobLog(jobId, label) {
  $('#logModalTitle').textContent = t`任务日志 · ${label || String(jobId).slice(0, 8)}`;
  $('#logModalBody').innerHTML = t('<div class="empty">加载中…</div>');
  $('#logModal').classList.add('open');
  focusFirst($('#logModal'));
  try {
    const r = await api(`/api/jobs/${jobId}/log`);
    const logs = Array.isArray(r.logs) ? r.logs : [];
    if (!logs.length) { $('#logModalBody').innerHTML = t('<div class="empty">日志为空</div>'); return; }
    $('#logModalBody').innerHTML = logs
      .map((l) => `<div class="logline"><span class="lg-t">${fmtClock(typeof l === 'object' && l ? l.t : 0)}</span>${esc(typeof l === 'string' ? l : (l.line || ''))}</div>`)
      .join('');
    $('#logModalBody').scrollTop = $('#logModalBody').scrollHeight;
  } catch (e) {
    $('#logModalBody').innerHTML = t`<div class="empty">读取日志失败：${esc(errText(e))}</div>`;
  }
}

/** 任务级撤销：journal → POST /api/undo（成功后状态库由后端回滚） */
async function undoJournalFile(journal, label) {
  if (state.running) { toast(t('任务运行中，完成后再撤销'), 'err'); return; }
  const ok = await confirmDialog(t('撤销本次应用'), t`将把${label ? '「' + label + '」' : t('本次应用')}重命名的视频恢复原名，并恢复有依据的旁车。嵌入视频的封面继续保留，不能恢复嵌入前的视频内容。确定？`, t('撤销'));
  if (!ok) return;
  try {
    const r = await api('/api/undo', { method: 'POST', body: JSON.stringify({ journal }) });
    const n = Array.isArray(r.restoredItems) ? r.restoredItems.length : (Number(r.restored) || 0);
    const removed = Number(r.removed) || 0;
    const extras = Array.isArray(r.restoredExtras) ? r.restoredExtras.length : 0;
    const failed = Array.isArray(r.failed) ? r.failed.length : 0;
    const partial=r.undoComplete===false||failed>0||!!r.stateError;
    const retained=r.retainedEffects?.includes('embedded_cover')?t('；嵌入的封面已保留，未恢复嵌入前的视频内容'):'';
    const pending=r.stateError?t`；文件操作已记录，状态更新待重试：${r.stateError}`:'';
    toast(t`${partial?t('部分撤销，仍有待处理项'):t('撤销完成')}：视频路径 ${n} 个${removed ? t`，隔离 ${removed} 项` : ''}${extras ? t`，还原备份 ${extras} 个` : ''}${failed ? t`，冲突 ${failed}` : ''}${retained}${pending}`, partial ? 'err' : 'ok');
    loadHistory();
  } catch (e) { toastErr(t('撤销失败'), e); }
}

/** B12：相对时间（3 分钟前 / 昨天 12:30 / 3 天前 / 2026-01-01） */
function relativeTime(ts) {
  const timestamp = Number(ts);
  if (!timestamp || !Number.isFinite(timestamp)) return '—';
  const d = new Date(timestamp);
  const now = new Date();
  const diff = Math.max(0, now.getTime() - timestamp);
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('刚刚');
  if (min < 60) return t`${min} 分钟前`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return t`${Math.floor(min / 60)} 小时前`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) {
    return t`昨天 ${hh}:${mm}`;
  }
  if (diff < 7 * 24 * 3600 * 1000) return t`${Math.floor(diff / 86400000)} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** B12：按目录关键字 + 状态筛选任务 */
function historyFilteredJobs(jobs) {
  const q = String($('#histSearch')?.value || '').trim().toLowerCase();
  const status = String($('#histStatus')?.value || '');
  return jobs.filter((x) => {
    if (status && x.status !== status) return false;
    if (q && !String(x.dir || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

async function loadHistory() {
  const running = !!state.running;
  let allJobs = [];
  try {
    const j = await api('/api/jobs');
    allJobs = Array.isArray(j.jobs) ? j.jobs : [];
    const jobs = historyFilteredJobs(allJobs);
    const countEl = $('#histCount');
    if (countEl) countEl.textContent = t`显示 ${jobs.length} / 共 ${allJobs.length}`;
    $('#jobs').innerHTML = jobs.length
      ? jobs.map((x) => {
        const errLine = x.error ? String(x.error).split('\n')[0] : '';
        const undoDisabled = running;
        return t`<div class="job">
          ${jobStatusPill(x.status)}
          <div class="meta">
            <div class="name" title="${esc(x.dir)}">${esc(x.kind === 'mux' ? t('字幕嵌入') : x.kind === 'apply' ? t('应用') : t('预演'))} · ${esc(x.dir)}</div>
            <div class="sub" title="${esc(fmtTime(x.createdAt))}">${esc(relativeTime(x.createdAt))} · ${esc(summaryText(x.summary))}${errLine ? ` · <span style="color:var(--red)">${esc(errLine)}</span>` : ''}</div>
          </div>
          <span class="jobbtns">
            <button class="btn sm" data-log="${esc(x.id)}">查看日志</button>
            <button class="btn sm" data-readable="${esc(x.id)}">${t('查看报告')}</button>
            <button class="btn sm" data-report="${esc(x.id)}">导出报告</button>
            ${x.journal ? t`<button class="btn sm danger" data-undo-job="${esc(x.id)}" ${undoDisabled ? 'disabled' : ''} title="${undoDisabled ? t('任务运行中，完成后再撤销') : t('撤销本次应用')}">撤销本次应用</button>` : ''}
          </span>
        </div>`;
      }).join('')
      : `<div class="empty">${allJobs.length ? t('没有符合筛选条件的任务') : t('暂无任务')}</div>`;
    $$('#jobs [data-readable]').forEach(btn=>btn.onclick=()=>workflows?.openReport(btn.dataset.readable));
    $$('#jobs [data-report]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const rep = await api(`/api/jobs/${btn.dataset.report}/report`);
          const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `avc-run-${btn.dataset.report.slice(0, 8)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          toast(t('报告已导出'), 'ok');
        } catch (e) { toastErr(t('导出失败'), e); }
      };
    });
    $$('#jobs [data-log]').forEach((btn) => {
      const job = jobs.find((x) => x.id === btn.dataset.log);
      btn.onclick = () => showJobLog(btn.dataset.log, job ? `${job.kind === 'mux' ? t('字幕嵌入') : job.kind === 'apply' ? t('应用') : t('预演')} ${fmtTime(job.createdAt)}` : '');
    });
    $$('#jobs [data-undo-job]').forEach((btn) => {
      const job = jobs.find((x) => x.id === btn.dataset.undoJob);
      btn.onclick = () => {
        if (running) { toast(t('任务运行中，完成后再撤销'), 'err'); return; }
        undoJournalFile(job?.journal, job?.dir ? pathBase(String(job.dir).replace(/[\\/]+$/, '')) : '');
      };
    });
  } catch (e) {
    $('#jobs').innerHTML = t`<div class="empty">读取任务失败：${esc(errText(e))}</div>`;
  }

  try {
    const j = await api('/api/journals');
    const js = j.journals || [];
    $('#journals').innerHTML = js.length
      ? js.map((x) => t`<div class="job">
          <span class="stat-pill s-skip">${x.items} 项</span>
          <div class="meta">
            <div class="name" title="${esc(x.file)}">${esc(pathBase(x.file))}</div>
            <div class="sub">${esc(x.createdAt ? relativeTime(Date.parse(x.createdAt) || x.createdAt) : '')} · <span title="${esc(x.file)}">${esc(x.file)}</span></div>
          </div>
          <span class="jobbtns">
            <button class="btn sm" data-copy-journal="${esc(x.file)}">复制路径</button>
            <button class="btn sm danger" data-undo="${esc(x.file)}" ${running ? 'disabled' : ''} title="${running ? t('任务运行中，完成后再撤销') : t('撤销这份 journal')}">撤销</button>
          </span>
        </div>`).join('')
      : t('<div class="empty">暂无 journal（应用一次改名后会出现）</div>');
    $$('#journals [data-copy-journal]').forEach((btn) => {
      btn.onclick = () => copyText(btn.dataset.copyJournal, t('journal 路径'));
    });
    $$('#journals [data-undo]').forEach((btn) => {
      btn.onclick = () => {
        if (running) { toast(t('任务运行中，完成后再撤销'), 'err'); return; }
        undoJournalFile(btn.dataset.undo);
      };
    });
  } catch (e) {
    $('#journals').innerHTML = t`<div class="empty">读取 journal 失败：${esc(errText(e))}</div>`;
  }
}

// ---------------- 设置 ----------------
const SRC_META = {
  manko: { get label() { return t('manko · 简体 ZH（API 直连）'); }, get desc() { return t('官方字幕，通常 1 个候选'); } },
  subtitlecat: { get label() { return t('subtitlecat · zh-CN（需代理）'); }, get desc() { return t('多版本，常有机翻 / 人工校对版'); } },
  local: { get label() { return t('本地字幕目录'); }, get desc() { return t('按番号在你配置的目录里找 .srt'); } },
};
let srcOrder = [];
let srcEnabled = new Set(); // 启用的字幕源 id（保存时 sources = 按 srcOrder 顺序的启用项）

function renderSrcOrder() {
  $('#srcOrder').innerHTML = srcOrder.map((id, i) => t`
    <div class="srcrow${srcEnabled.has(id) ? '' : ' off'}" data-id="${esc(id)}" data-enabled="${srcEnabled.has(id) ? '1' : '0'}">
      <label class="src-enable" title="启用/停用该字幕源"><input type="checkbox" data-src="${esc(id)}" ${srcEnabled.has(id) ? 'checked' : ''} /></label>
      <span class="idx">${i + 1}</span>
      <span class="lbl">${esc(t(SRC_META[id]?.label || id))}
        <br/><span class="desc">${esc(t(SRC_META[id]?.desc || ''))}</span>
      </span>
      <button class="mv" data-mv="up" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
      <button class="mv" data-mv="down" ${i === srcOrder.length - 1 ? 'disabled' : ''} title="下移">↓</button>
    </div>`).join('');
  $$('#srcOrder .mv').forEach((b) => {
    b.onclick = () => {
      const id = b.closest('.srcrow').dataset.id;
      const i = srcOrder.indexOf(id);
      const j = b.dataset.mv === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= srcOrder.length) return;
      [srcOrder[i], srcOrder[j]] = [srcOrder[j], srcOrder[i]];
      renderSrcOrder();
    };
  });
  $$('#srcOrder input[data-src]').forEach((cb) => {
    cb.onchange = () => {
      const id = cb.dataset.src;
      if (cb.checked) srcEnabled.add(id); else srcEnabled.delete(id);
      const row = cb.closest('.srcrow');
      if (row) {
        row.dataset.enabled = cb.checked ? '1' : '0';
        row.classList.toggle('off', !cb.checked);
      }
    };
  });
}

// ---------------- SPEC4 A2/C4：数据备份 + 配置导入导出 ----------------
function dataOpErrorText(e) {
  if (e && e.status === 404) return t('后端未提供该接口（需要更新后端版本）');
  if (e && e.status === 409) return t('任务运行中，稍后再试');
  const code = e && e.body && e.body.error;
  const map = {
    fs_forbidden: t('目录不在允许范围内（检查 config.fs.allowedRoots）'),
    invalid_backup: t('备份目录无效（需要包含 state.db）'),
    backup_failed: t('备份失败'),
    restore_failed: t('恢复失败'),
    invalid_config: t('配置无效'),
  };
  if (code && map[code]) return map[code];
  return errText(e);
}

async function loadBackups() {
  const box = $('#backupList');
  if (!box) return;
  try {
    const r = await api('/api/backups');
    const list = Array.isArray(r.backups) ? r.backups : [];
    if (!list.length) {
      box.innerHTML = t('<div class="empty">还没有备份。点「立即备份」创建第一个。</div>');
      return;
    }
    box.innerHTML = list.map((b) => t`<div class="backup-row">
      <div class="backup-meta">
        <div class="backup-name" title="${esc(b.dir || '')}">${esc(b.name || pathBase(b.dir || ''))}</div>
        <div class="backup-sub">${b.createdAt ? esc(fmtTime(b.createdAt)) : '—'} · ${Number(b.files) || 0} 个文件</div>
      </div>
      <button class="btn sm" data-restore="${esc(b.dir || '')}">恢复</button>
    </div>`).join('');
    $$('#backupList [data-restore]').forEach((btn) => { btn.onclick = () => restoreBackup(btn.dataset.restore); });
  } catch (e) {
    box.innerHTML = t`<div class="empty">读取备份列表失败：${esc(dataOpErrorText(e))}</div>`;
  }
}

async function backupNow() {
  const btn = $('#btnBackupNow');
  if (btn) { btn.disabled = true; btn.textContent = t('备份中…'); }
  try {
    const r = await api('/api/backup', { method: 'POST', body: JSON.stringify({}) });
    toast(t`备份完成：${Number(r.files) || 0} 个文件 → ${r.path || ''}`, 'ok');
    await loadBackups();
  } catch (e) {
    toast(t('备份失败：') + dataOpErrorText(e), 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('立即备份'); }
  }
}

async function restoreBackup(dir) {
  const target = String(dir || '');
  if (!target) return;
  const ok = await confirmDialog(
    t('恢复备份'),
    t`将把备份内容复制回数据目录：\n${target}\n\n已存在的文件会被覆盖（force）。恢复前建议先「立即备份」当前数据。`,
    t('覆盖恢复'),
  );
  if (!ok) return;
  try {
    const r = await api('/api/restore', { method: 'POST', body: JSON.stringify({ dir: target, force: true }) });
    const skipped = Number(r.skipped) || 0;
    toast(t`恢复完成：复制 ${Number(r.copied) || 0} 个文件${skipped ? t`，跳过 ${skipped}` : ''}`, 'ok');
    await loadSettings();
    checkHealth();
  } catch (e) {
    toast(t('恢复失败：') + dataOpErrorText(e), 'err');
  }
}

async function exportConfig() {
  try {
    const cfg = await api('/api/config');
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `avc-config-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t('配置已导出'), 'ok');
  } catch (e) { toastErr(t('导出配置失败'), e); }
}

/** SPEC4 C4：导入配置对象（校验 + 确认 + PUT 整体替换） */
async function importConfigObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    toast(t('导入失败：配置必须是 JSON 对象'), 'err');
    return;
  }
  const ok = await confirmDialog(
    t('导入配置'),
    t('将用所选文件整体替换当前配置（network / subs / covers / paths 等）。\n路径、代理等设置可能与当前环境不符，确认继续？'),
    t('导入并覆盖'),
  );
  if (!ok) return;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(obj) });
    toast(t('配置已导入'), 'ok');
    await loadSettings();
    checkHealth();
  } catch (e) {
    toast(t('导入配置失败：') + dataOpErrorText(e), 'err');
  }
}

async function importConfigFile(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast(t('导入失败：配置文件过大（>4MB）'), 'err'); return; }
  let obj = null;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    toast(t('导入失败：不是合法的 JSON 文件'), 'err');
    return;
  }
  await importConfigObject(obj);
}

async function loadSettings() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    $('#setProxy').value = cfg.network?.proxy || '';
    $('#setTpl').value = cfg.rename?.template || '{code} {title} [{actress}]';
    $('#setData').value = cfg.paths?.dataDir || 'data';

    const configured = (cfg.subs?.sources || []).filter((x) => SRC_META[x]);
    srcOrder = [...new Set([...configured, ...Object.keys(SRC_META)])];
    // 未配置任何源时默认全部启用（避免用户无法保存）
    srcEnabled = new Set(configured.length ? configured : [...Object.keys(SRC_META)]);
    renderSrcOrder();

    $('#setLocalDirs').value = (cfg.subs?.localDirs || []).join('\n');
    $('#setSubcatLimit').value = String(cfg.subs?.subtitlecatLimit ?? 4);
    $('#setFit').value = cfg.subs?.fit?.mode || 'auto';
    const extraLangs = Array.isArray(cfg.subs?.extraLangs) ? cfg.subs.extraLangs : [];
    if ($('#setExtraZhTw')) $('#setExtraZhTw').checked = extraLangs.includes('zh-TW');
    if ($('#setExtraEn')) $('#setExtraEn').checked = extraLangs.includes('en');
    if ($('#setExtraKo')) $('#setExtraKo').checked = extraLangs.includes('ko');
    if ($('#setProbeDuration')) $('#setProbeDuration').value = cfg.media?.probeDuration === 'off' ? 'off' : 'auto';
    if ($('#setR18')) $('#setR18').checked = cfg.metadata?.r18 !== false;
    loadBackups();
    $('#setCoverDownload').checked = cfg.covers?.download !== false;
    $('#setCoverPoster').checked = cfg.covers?.posterWhenSingle !== false;
    $('#setCoverEmbed').checked = !!cfg.covers?.embed;

    try {
      const m = await api('/api/media/health');
      lastMediaHealth = m;
      const el = $('#ffmpegStatus');
      if (m.ffmpeg?.available) {
        el.textContent = t`ffmpeg 已安装（${m.ffmpeg.version}）：可以把封面嵌入视频文件`;
        $('#setCoverEmbed').disabled = false;
      } else {
        el.textContent = t('ffmpeg 未安装：封面只会保存为同名 .jpg（播放器/媒体库可用），不会写进视频文件。需要嵌入请安装 ffmpeg。');
        $('#setCoverEmbed').disabled = true;
        $('#setCoverEmbed').checked = false;
      }
    } catch { /* media health 可选 */ }
  } catch (e) {
    toastErr(t('读取配置失败'), e);
  }
}

// ---------------- 自检面板（F6） ----------------
let lastMediaHealth = null;
let lastDiagnosis = null;
function refreshMediaCopy() {
  if (!lastMediaHealth) return;
  $('#ffmpegStatus').textContent = lastMediaHealth.ffmpeg?.available
    ? t`ffmpeg 已安装（${lastMediaHealth.ffmpeg.version}）：可以把封面嵌入视频文件`
    : t('ffmpeg 未安装：封面只会保存为同名 .jpg（播放器/媒体库可用），不会写进视频文件。需要嵌入请安装 ffmpeg。');
}
function diagMark(ok) { return ok ? '<span class="mark-ok">✓</span>' : '<span class="mark-bad">✗</span>'; }

function renderDiagnose(d) {
  const out = [];
  const net = d.network || {};
  const hosts = Array.isArray(net.hosts) ? net.hosts : [];
  out.push(t`<div class="diag-section"><h4>网络</h4>
    <div class="diag-row"><span class="dname">代理</span><span>${esc(net.proxy || t('未配置'))}</span><span class="droute">${esc(net.defaultRoute || 'direct')}</span></div>
    ${hosts.length ? hosts.map((h) => `<div class="diag-row">${diagMark(h.ok)}<span class="dname">${esc(h.name)}</span><span class="droute">${esc(h.route || '—')}</span>${h.status ? `<span class="droute">HTTP ${esc(h.status)}</span>` : ''}${h.error ? `<span class="note" style="color:var(--red)">${esc(h.error)}</span>` : ''}<span class="dms">${h.ms != null ? esc(h.ms) + ' ms' : '—'}</span></div>`).join('') : t('<div class="diag-empty">无探测结果</div>')}
  </div>`);
  const fm = d.ffmpeg || {};
  out.push(`<div class="diag-section"><h4>ffmpeg / ffprobe</h4>
    <div class="diag-row">${diagMark(fm.available)}<span class="dname">ffmpeg</span><span>${esc(fm.version || t('未安装（封面只写同名 .jpg）'))}</span></div>
    <div class="diag-row">${diagMark(fm.ffprobe)}<span class="dname">ffprobe</span><span>${fm.ffprobe ? t('可用（实测片长）') : t('不可用（退回元数据片长）')}</span></div>
  </div>`);
  const dd = d.dataDir || {};
  out.push(t`<div class="diag-section"><h4>数据目录</h4>
    <div class="diag-row">${diagMark(dd.writable)}<span>${dd.writable ? t('可写') : t('不可写')}</span></div>
    <div class="diag-path">${esc(dd.path || '—')}</div>
    ${dd.error ? `<div class="diag-warn">${esc(dd.error)}</div>` : ''}
  </div>`);
  const cfg = d.config || {};
  const warns = Array.isArray(cfg.warnings) ? cfg.warnings : [];
  const unknown = Array.isArray(cfg.unknownKeys) ? cfg.unknownKeys : [];
  out.push(t`<div class="diag-section"><h4>配置</h4>
    <div class="diag-row">${diagMark(cfg.valid !== false)}<span>${cfg.valid === false ? t('无效') : t('有效')}</span></div>
    <div class="diag-path">${esc(cfg.path || '—')}</div>
    ${unknown.length ? t`<div class="diag-warn">未知配置项：${esc(unknown.join(', '))}</div>` : ''}
    ${warns.length ? warns.map((w) => `<div class="diag-warn">${esc(w)}</div>`).join('') : ''}
  </div>`);
  const st = d.state || {};
  out.push(t`<div class="diag-section"><h4>状态库</h4>
    <div class="diag-row"><span class="dname">db</span><span class="diag-path">${esc(st.db || '—')}</span></div>
    <div class="diag-row"><span class="dname">文件数</span><span>${st.files == null ? t('读取失败') : esc(st.files)}</span></div>
        ${st.byStatus && Object.keys(st.byStatus).length ? `<div class="diag-row" style="flex-wrap:wrap">${Object.entries(st.byStatus).map(([k, v]) => `<span class="droute">${esc(t(STATUS_TEXT[k] || k))} ${esc(v)}</span>`).join('')}</div>` : ''}
  </div>`);
  return out.join('');
}

async function runDiagnose() {
  const box = $('#diagBox');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = t('<div class="empty">自检中…（联网探测可能耗时数秒）</div>');
  const btn = $('#btnDiagnose');
  if (btn) btn.disabled = true;
  try {
    const d = await api('/api/diagnose');
    lastDiagnosis = d;
    box.innerHTML = renderDiagnose(d);
  } catch (e) {
    const msg = e.status === 404 ? t('后端未提供 /api/diagnose 接口（需要 v0.6 后端）') : errText(e);
    box.innerHTML = t`<div class="empty">自检不可用：${esc(msg)}</div>`;
    toast(t('自检失败：') + msg, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** F19：导出脱敏诊断包 —— 后端返回 JSON 附件（Content-Disposition: attachment） */
function exportDiagnostics() {
  toast(t('已开始下载诊断包（JSON，含脱敏配置与最近日志）…'), 'ok');
  window.location.href = '/api/diagnostics/export';
}
async function saveNetwork() {
  if (!state.config) await loadSettings();
  const next = { ...state.config, network: { ...(state.config.network || {}), proxy: $('#setProxy').value.trim() || null } };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
    state.config = next;
    toast(t('网络设置已保存'), 'ok');
    checkHealth();
  } catch (e) { toastErr(t('保存失败'), e); }
}

async function saveMisc() {
  if (!state.config) await loadSettings();
  const enabledSources = srcOrder.filter((id) => srcEnabled.has(id));
  if (!enabledSources.length) { toast(t('至少启用一个字幕源'), 'err'); return; }
  const localDirs = $('#setLocalDirs').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const extraLangs = [];
  if ($('#setExtraZhTw')?.checked) extraLangs.push('zh-TW');
  if ($('#setExtraEn')?.checked) extraLangs.push('en');
  if ($('#setExtraKo')?.checked) extraLangs.push('ko');
  const next = {
    ...state.config,
    rename: { ...(state.config.rename || {}), template: $('#setTpl').value.trim() || '{code} {title} [{actress}]' },
    subs: {
      ...(state.config.subs || {}),
      sources: enabledSources,
      extraLangs,
      localDirs,
      subtitlecatLimit: Number($('#setSubcatLimit').value) || 4,
      fit: { ...(state.config.subs?.fit || {}), mode: $('#setFit').value },
    },
    media: { ...(state.config.media || {}), probeDuration: $('#setProbeDuration')?.value === 'off' ? 'off' : 'auto' },
    metadata: { ...(state.config.metadata || {}), r18: $('#setR18') ? !!$('#setR18').checked : true },
    covers: {
      download: $('#setCoverDownload').checked,
      posterWhenSingle: $('#setCoverPoster').checked,
      embed: $('#setCoverEmbed').checked && !$('#setCoverEmbed').disabled,
    },
    paths: { ...(state.config.paths || {}), dataDir: $('#setData').value.trim() || 'data' },
  };
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
    state.config = next;
    srcEnabled = new Set(enabledSources);
    toast(t('设置已保存（下次任务生效）'), 'ok');
  } catch (e) { toastErr(t('保存失败'), e); }
}

/** 应用确认框：前 10 条「旧名 → 新名」+ 状态计数 + 说明（F2） */
async function onApplyClick() {
  if (!state.lastPlan) { toast(t('请先完成一次「预演」再应用'), 'err'); return; }
  const c = planCounts(state.lastPlan);
  const results = Array.isArray(state.lastPlan.results) ? state.lastPlan.results : [];
  if(results.some(r=>r.rename && (r.rename.batchConflict || r.rename.reason || ['skip_conflict','skip_duplicate'].includes(r.rename.action)))) {await workflows?.openConflicts();return;}
  const renames = results.filter((r) => r.rename && r.rename.to && r.rename.to !== r.rename.from);
  const lines = renames.slice(0, 10).map((r) => `${pathBase(r.rename.from)}  →  ${pathBase(r.rename.to)}`);
  const more = renames.length > 10 ? t`\n… 还有 ${renames.length - 10} 条` : '';
  const counts = [
    t`将改名 ${c.rename} 个`, t`成功 ${c.ok}`, t`无中字 ${c.no_subtitle}`, t`未确认 ${c.unresolved}`,
    ...(c.out_of_scope ? [t`范围外 ${c.out_of_scope}`] : []),
    t`失败 ${c.error}`,
    ...(c.conflict ? [t`目标冲突 ${c.conflict}`] : []),
    ...(c.duplicates ? [t`重复番号 ${c.duplicates}`] : []),
  ].join(' · ');
  const text = t`${counts}\n\n${lines.length ? t`前 ${lines.length} 条改名：\n${lines.join('\n')}${more}` : t('没有需要改名的文件。')}\n\n会同时写入字幕 ${c.subs} 个、封面 ${c.covers} 张。完成后可在「历史与撤销」里恢复文件名和有恢复依据的旁车；嵌入视频的封面会保留，不能恢复嵌入前的视频内容。`;
  const ok = await confirmDialog(t('应用（改名 + 字幕）'), text, t('应用（改名 + 字幕）'));
  if (ok) startJob('apply');
}

// ---------------- SPEC5 Phase1：B1 快捷键 ----------------
function isEditableTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/** F5：只刷新后端状态（不刷新页面） */
async function refreshBackendState() {
  await checkHealth();
  if (state.job?.id) {
    try {
      const job = await api(`/api/jobs/${state.job.id}`);
      if (job && job.status && !['queued', 'running'].includes(job.status)) finishJob(job);
      else if (job?.progress) {
        state.total = Number(job.progress.total) || state.total;
        state.progressDone = Number(job.progress.done) || state.progressDone;
        updateStats();
      }
    } catch { /* ignore */ }
  }
  const historyView = $('#view-history');
  if (historyView && !historyView.classList.contains('hidden')) loadHistory();
  toast(t('已刷新后端状态'), 'ok');
}

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    closeDrawer();
    for (const id of ['#fsModal', '#confirmModal', '#logModal', '#subPreviewModal', '#coverModal']) {
      const el = $(id);
      if (el) el.classList.remove('open');
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  // F5：刷新后端状态（阻止浏览器默认刷新）
  if (e.key === 'F5') { e.preventDefault(); refreshBackendState(); return; }
  // Ctrl+F：聚焦列表搜索框
  if (mod && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'f') {
    e.preventDefault();
    const s = $('#fltSearch');
    if (s) { s.focus(); if (typeof s.select === 'function') s.select(); }
    return;
  }
  // 输入框/下拉框内不拦截其余快捷键
  if (isEditableTarget(e.target)) return;
  // Ctrl+A：全选当前筛选结果
  if (mod && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === 'a') {
    e.preventDefault();
    selectAllFiltered(true);
    return;
  }
  // Ctrl+Enter：开始预演
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    if (!state.running && !state.starting) startJob('plan');
    return;
  }
  // 抽屉打开：←/→ 切换上一项/下一项
  const drawer = $('#drawer');
  if (drawer && drawer.classList.contains('open')) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); navigateDrawer(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateDrawer(1); return; }
  }
  // 列表容器获得焦点时：↑/↓ 高亮、Enter 打开、Space 勾选
  if (e.target && typeof e.target.closest === 'function' && e.target.closest('#list')) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActiveRow(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveActiveRow(-1); return; }
    if (e.key === 'Enter') {
      const row = activeRowElement();
      if (row) { e.preventDefault(); openDrawer(row.dataset.path); }
      return;
    }
    if (e.key === ' ' || e.code === 'Space') {
      const row = activeRowElement();
      if (row) {
        e.preventDefault();
        const box = row.querySelector('.pick input');
        if (box && !box.disabled) setRowSelected(row.dataset.path, !box.checked);
      }
    }
  }
}

// ---------------- 事件绑定 ----------------
function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab?.dataset.view) showView(tab.dataset.view);
  });
  $('#btnRefresh').onclick = () => { checkHealth(); if (!$('#view-history').classList.contains('hidden')) loadHistory(); };
  $('#btnPick').onclick = () => openFsBrowser(($('#dir').value || '').trim());
  $('#fsClose').onclick = () => $('#fsModal').classList.remove('open');
  $('#fsUp').onclick = () => fsParent && fsList(fsParent);
  $('#fsUse').onclick = () => { if (fsPath) { setDir(fsPath); $('#fsModal').classList.remove('open'); scan(); } };
  $('#btnScan').onclick = scan;
  $('#btnManualPlan').onclick = () => {
    const filled = Object.values(state.manualCodes || {}).filter((v) => normalizedManualInput(v));
    if (!filled.length) { toast(t('请先在「未识别」区填写至少一个番号'), 'err'); return; }
    startJob('plan');
  };
  $('#btnPlan').onclick = () => startJob('plan');
  $('#btnApply').onclick = onApplyClick;
  $('#btnCancel').onclick = cancelJob;
  $('#btnExport').onclick = exportReport;
  $('#drawerClose').onclick = closeDrawer;
  $('#drawerBody').addEventListener('input',event=>{if(event.target?.matches?.('.d-code'))resetSubManualUi();});
  if ($('#drawerPrev')) $('#drawerPrev').onclick = () => navigateDrawer(-1);
  if ($('#drawerNext')) $('#drawerNext').onclick = () => navigateDrawer(1);
  if ($('#coverModalClose')) $('#coverModalClose').onclick = closeCoverModal;
  if ($('#coverModal')) $('#coverModal').addEventListener('click', (e) => { if (e.target === $('#coverModal')) closeCoverModal(); });
  $('#drawerBody').addEventListener('click', onDrawerClick);
  $('#btnSaveNet').onclick = saveNetwork;
  $('#btnSaveMisc').onclick = saveMisc;
  $('#btnDiagnose').onclick = runDiagnose;
  $('#btnDiagnostics').onclick = exportDiagnostics;
  // B15 主题 / B16 密度与列 / B14 hashchange
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('hashchange', () => {
      const v = viewFromHash(location.hash);
      if (v && v !== currentView()) showView(v, { fromHash: true });
    });
  }
  if ($('#densityToggle')) $('#densityToggle').onclick = toggleDensity;
  if ($('#colsBtn')) {
    $('#colsBtn').onclick = () => { const p = $('#colsPanel'); if (p) p.classList.toggle('hidden'); };
  }
  for (const [id, key] of [['#colDate', 'date'], ['#colMaker', 'maker'], ['#colDuration', 'duration'], ['#colSize', 'size']]) {
    const el = $(id);
    if (el) el.addEventListener('change', () => setColVisible(key, el.checked));
  }
  document.addEventListener('click', (e) => {
    const panel = $('#colsPanel');
    if (!panel || panel.classList.contains('hidden')) return;
    if (!e.target || typeof e.target.closest !== 'function' || !e.target.closest('.flt-colswrap')) panel.classList.add('hidden');
  });
  // B12 历史页筛选
  if ($('#histSearch')) $('#histSearch').addEventListener('input', () => loadHistory());
  if ($('#histStatus')) $('#histStatus').addEventListener('change', () => loadHistory());
  // SPEC4 A2/C4：数据与备份 / 配置导入导出
  if ($('#btnBackupNow')) $('#btnBackupNow').onclick = backupNow;
  if ($('#btnExportConfig')) $('#btnExportConfig').onclick = exportConfig;
  if ($('#btnImportConfig') && $('#configFile')) {
    $('#btnImportConfig').onclick = () => $('#configFile').click();
    $('#configFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      try { await importConfigFile(file); } finally { e.target.value = ''; }
    });
  }
  // SPEC4 C2：字幕预览弹层
  if ($('#subPreviewClose')) $('#subPreviewClose').onclick = () => $('#subPreviewModal').classList.remove('open');
  $('#btnResync').onclick = resync;
  $('#logModalClose').onclick = () => $('#logModal').classList.remove('open');
  // F16 抽屉反查
  if ($('#btnLookup')) $('#btnLookup').onclick = runLookup;
  if ($('#lookupKeyword')) {
    $('#lookupKeyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') runLookup(); });
  }
  if ($('#lookupResults')) $('#lookupResults').addEventListener('click', onLookupResultsClick);
  // SPEC3 手动字幕候选（静态节点会被 renderDrawer 移动，事件绑定保留）
  if ($('#subListBtn')) $('#subListBtn').onclick = listSubtitleCandidates;
  if ($('#subCandidates')) {
    $('#subCandidates').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sub-apply]');
      if (!btn) return;
      const cand = subCandidates[Number(btn.dataset.subApply)];
      if (cand) applySubtitleCandidate(cand, btn);
    });
  }
  // F10 工具条：搜索（防抖）/ 状态 chips / 排序 / 批量勾选
  if ($('#fltSearch')) {
    $('#fltSearch').addEventListener('input', (e) => {
      const v = e.target.value;
      clearTimeout(fltSearchTimer);
      fltSearchTimer = setTimeout(() => { state.filter.q = v; saveFilterPrefs(); renderList(); }, 120);
    });
  }
  if ($('#fltSort')) {
    $('#fltSort').addEventListener('change', (e) => {
      state.filter.sort = e.target.value;
      saveFilterPrefs();
      renderList();
    });
  }
  if ($('#fltStatus')) {
    $('#fltStatus').addEventListener('click', (e) => {
      const chip = e.target.closest('.flt-chip');
      if (chip) toggleFilterStatus(chip.dataset.status);
    });
  }
  if ($('#chkAll')) $('#chkAll').addEventListener('change', (e) => selectAllFiltered(e.target.checked));
  if ($('#selFiltered')) $('#selFiltered').onclick = selectFiltered;
  if ($('#selFailed')) $('#selFailed').onclick = selectFailed;
  if ($('#selInvert')) $('#selInvert').onclick = invertSelection;
  if ($('#selNone')) $('#selNone').onclick = clearSelection;
  if ($('#retryFailed')) $('#retryFailed').onclick = retryFailed;
  if ($('#fltReset')) $('#fltReset').onclick = resetFilterAll;
  if ($('#fltClear')) {
    $('#fltClear').onclick = () => { resetFilter(); toast(t('已清除筛选')); };
  }
  if ($('#logErrOnly')) $('#logErrOnly').addEventListener('change', renderLog);
  // F11 行内点击/勾选（事件委托，行会被增量 patch / 重排）
  if ($('#fltRows')) {
    $('#fltRows').addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      const it = row ? state.itemByPath.get(row.dataset.path) : null;
      const actionBtn = e.target.closest('[data-row-act]');
      if (actionBtn) { handleRowAction(actionBtn.dataset.rowAct, it); return; }
      if (e.target.closest('.pick')) return;
      if (e.target.closest('.thumb')) {
        if (!it) return;
        if (coverDisplaySrc(it)) openCoverModal(it);
        else toast(t('该文件没有可预览的封面'), 'err');
        return;
      }
      if (row) openDrawer(row.dataset.path);
    });
    $('#fltRows').addEventListener('change', (e) => {
      const box = e.target.closest('input[data-path]');
      if (!box) return;
      setRowSelected(box.dataset.path, box.checked);
    });
  }
  // 本轮选项：变更即持久化（F5）
  for (const id of ['#optForce', '#optDownloadSubs', '#optNotify', '#optConcurrency', '#optLimit']) {
    const el = $(id);
    if (el) el.addEventListener('change', saveRunOpts);
  }
  $('#dir').addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });
  document.addEventListener('keydown', onGlobalKeydown);
}

// ---------------- 启动 ----------------
async function init() {
  assemblyUi=initAssembly({api,toast,confirmDialog,getWorkbench:()=>({dir:state.dir||$('#dir').value,files:[...state.selected].map(p=>state.itemByPath.get(p)?.renamedTo||p)}),showHistory:()=>showView('history'),onActivity:()=>checkHealth()});
  maintenanceUi = initMaintenance({ api, confirmDialog, toast, invalidatePlan });
  workflows=initWorkflows({state,api,toast,openDrawer,confirmDialog,refresh:async()=>{invalidatePlan();await scan();},loadReport,scanDirectory:scan,renderPlan:()=>{for(const r of state.lastPlan?.results||[]){const it=state.itemByPath.get(r.rename?.from||r.originalFile||r.file);if(it){it.rename=r.rename;it.newName=r.newName;it.sub=r.sub;patchRow(it.path);}}renderPlanSummary();updateStats();}});
  bind();
  initUiPreferences();
  initWorkPanel();
  const sakura = initSakura({ toast });
  const appearance = initAppearance({ toast, onTimeTheme: (mode) => { timeTheme = mode; applyTheme(); }, onPetalRain: sakura.rain });
  initTheme();
  effectsUi = initEffects({ appearance, sakura, toast });
  onLocaleChange(() => {
    applyTheme(); applyDensity(); renderList(); updateStats(); renderSrcOrder(); refreshMediaCopy();
    renderPlanSummary(); loadBackups();
    if (lastDiagnosis) $('#diagBox').innerHTML = renderDiagnose(lastDiagnosis);
    $('#liveDots').innerHTML = state.running ? t('<i></i>运行中') : t('<i></i>空闲');
    if (state.job?.status) $('#jobState').textContent = JOB_STATUS_TEXT[state.job.status] || state.job.status;
    if (state.drawerPath) renderDrawer();
    if (!$('#view-history').classList.contains('hidden')) loadHistory();
    if (!$('#view-settings').classList.contains('hidden')) checkHealth();
    if (!state.running) resetDocumentTitle();
  });
  initUpdates();
  loadViewPrefs();
  loadRunOpts();
  loadFilterPrefs(); // B2：恢复上次筛选/排序
  if (typeof document !== 'undefined') document.title = t(BASE_TITLE);
  const saved = (() => { try { return localStorage.getItem('avc.dir') || ''; } catch { return ''; } })();
  const params = new URLSearchParams(location.search);
  const qs = params.get('dir');
  const autorun = params.get('autorun');
  if (qs) setDir(qs); else if (saved) $('#dir').value = saved;

  // Resolve the visible page before waiting for the backend. This also keeps
  // the restored effects background aligned with a direct settings/history URL.
  const hashView = viewFromHash(typeof location !== 'undefined' ? location.hash : '');
  if (hashView) showView(hashView, { fromHash: true, animate: false });
  else updateHash('work');

  const okHealth = await checkHealth();
  if (!okHealth) toast(t('后端未连接：请先运行 node src/server.mjs'), 'err');
  updateProgress(0, 0);
  updateStats();
  if (qs) {
    await scan();
    if (autorun === 'plan' || autorun === 'apply') startJob(autorun);
  }
}
// 浏览器里自动启动；Node 下（DOM 桩测试）由测试脚本手动驱动
if (typeof document !== 'undefined') init();

// 便于调试 / 自动化验证
if (typeof window !== 'undefined') {
  window.__AVC__ = state;
  window.__AVC_TEST__ = {
    state, STATUS, STATUS_ORDER, ROW_LIMIT,
    visibleItems, matchesFilter, compareItems, itemSearchText, statusOf,
    rowHtml, rowBodyHtml, renderList, renderRows, renderMore, patchRow, applyRowContent,
    updateCounts, syncRowsSelection, resetFilter, setFilterQuery, toggleFilterStatus,
    selectFiltered, selectFailed, invertSelection, clearSelection, selectAllFiltered,
    logLine, flushLog, renderLog, clearLog,
    openEvents,
    coverStateOf, coverStatusText, coverFlagHtml, coverErrorLabel, coverSourceUrl, coverFetchErrorText, fetchCover,
    subtitleErrorText, subtitleSourceLabel, renderSubCandidates, listSubtitleCandidates,
    applySubtitleCandidate, resetSubManualUi, setSubTip, currentDrawerItem, renderDrawer,
    loadReport,
    setQueueInfo, emptyListHtml,
    // SPEC5 Phase1：B1/B2/B3/B4/B5/B6/B7/B9
    loadFilterPrefs, saveFilterPrefs, clearFilterPrefs, resetFilterAll,
    copyText, handleRowAction, openCoverModal, closeCoverModal, navigateDrawer, updateDrawerNav,
    moveActiveRow, setActiveRow, activeRowElement, setRowSelected, retryFailed,
    estimatePerFileSec, updateSelectionSummary, updateEtaUi, resetDocumentTitle,
    maybeRequestNotify, notifyJobFinished, refreshBackendState, onGlobalKeydown, coverDisplaySrc,
    // SPEC5 Phase2：B12/B13/B14/B15/B16
    relativeTime, historyFilteredJobs, loadHistory, showView, currentView, viewFromHash, updateHash,
    loadThemePref, applyTheme, cycleTheme, initTheme, themeLabel,
    loadViewPrefs, applyDensity, syncColsUi, toggleDensity, setColVisible, focusFirst,
    getTheme: () => themeMode,
    dataOpErrorText, loadBackups, backupNow, restoreBackup, exportConfig, importConfigObject, importConfigFile,
    previewSubtitle, subtitlePreviewErrorText, renderCueHtml,
    loadSettings, saveMisc, renderSrcOrder,
    checkHealth,
    getSrcState: () => ({ order: [...srcOrder], enabled: [...srcEnabled] }),
    setSrcEnabled: (ids) => { srcEnabled = new Set(Array.isArray(ids) ? ids : []); },
    lookupChipHtml, renderLookupCandidates, lookupErrorText, runLookup,
  };
}
