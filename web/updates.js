// 启动更新日志；版本与 CHANGELOG 保持一致，不请求外部资源。
import { onLocaleChange, t } from './i18n.js';
export const UPDATE_DISMISS_KEY = 'avc.updates.dismissed';
export const RELEASE_HISTORY = [
  { version: "0.8.1", date: "2026-11-11", sections: [
    { label: "新增", items: ["新增“更多动效（实验中）”，可一键切换，默认关闭。", "各页面配有独立背景和花瓣、蝶影等动效。"] },
    { label: "优化", items: ["切换动效保留当前操作，关闭后恢复原有外观设置。", "后台自动暂停动效，并适配系统的减少动态效果设置。"] },
    { label: "修复", items: ["修复部分背景、文字和弹窗显示异常。", "改名时避免覆盖已有文件，撤销时保护后来修改过的文件。", "修复撤销后记录不同步、嵌入封面后字段锁丢失等问题。", "改善任务取消、重启、备份恢复和下载的稳定性。", "修复字幕匹配错误及时间轴进位问题。"] },
    { label: "使用提醒", items: ["嵌入封面会覆盖原视频；撤销无法恢复嵌入前的视频。", "旧版撤销记录可能需要手动检查；部分跨盘或网络盘操作暂不支持。"] },
  ] },
  { version: "0.8.0", date: "2026-11-09", sections: [
    { label: "新增", items: ["“超级拼装”新增字幕嵌入和图片反查。", "将本地字幕嵌入 MP4 / MKV，另存为新文件。", "选择、拖入或粘贴截图，查询并复制番号。"] },
    { label: "使用提醒", items: ["嵌入前请先准备本地字幕；图片反查需自行配置服务。"] },
  ] },
  { version: "0.7.5", date: "2026-11-09", sections: [
    { label: "新增", items: ["只补缺项，支持修改并锁定字段、保留原文件名。", "对比字幕候选，批量处理改名冲突。", "清理缓存、一键重启，历史报告支持筛选、打印和导出。"] },
    { label: "优化", items: ["操作前检查文件变化和目标占用，单独补字幕或封面也可撤销。"] },
  ] },
  { version: "0.7.4", date: "2026-11-08", sections: [
    { label: "新增", items: ["支持中英文切换和字号调节。", "更新日志可随时查看，也可关闭启动提示。", "壁纸、面板颜色与樱花动效可自定义，自动保存设置。"] },
    { label: "优化", items: ["保留原有外观设置，后台自动暂停动效。"] },
  ] },
  { version: "0.7.3", date: "2026-11-08", sections: [
    { label: "新增", items: ["常用快捷键、筛选记忆、行内复制和失败重试。", "显示已选数量、总大小和预计剩余时间，可开启完成通知。", "封面放大预览、深色主题，以及列表密度和列显示设置。"] },
    { label: "优化", items: ["完善历史筛选和键盘操作；任务运行时禁用撤销。"] },
  ] },
  { version: "0.7.2", date: "2026-11-08", sections: [
    { label: "新增", items: ["设置页支持备份恢复、配置导入导出、字幕预览和多语言字幕。"] },
    { label: "修复", items: ["改善标题和演员名反查，修复备用数据源的代理重试。"] },
  ] },
  { version: "0.7.1", date: "2026-11-08", sections: [
    { label: "新增", items: ["详情页可手动选择字幕、补下封面，覆盖前自动备份。"] },
    { label: "修复", items: ["封面状态更准确，处理后立即更新，失败时可重试。"] },
  ] },
  { version: "0.7.0", date: "2026-11-08", sections: [
    { label: "新增", items: ["支持列表搜索、筛选和批量勾选，处理大量文件更流畅。", "增加备用资料来源、标题和演员名反查，以及多语言字幕。", "支持导出诊断包、备份恢复，旧数据升级前自动备份。"] },
    { label: "修复", items: ["撤销时一并处理附加字幕，便携包移除测试资料。"] },
  ] },
  { version: "0.6.0", date: "2026-11-08", sections: [
    { label: "新增", items: ["可单独预演文件，查看改名、字幕、封面和冲突汇总。", "增加运行自检、重启后保留的任务历史和本轮处理选项。", "提示重复番号和片长偏差，断线后可恢复进度显示。"] },
  ] },
  { version: "0.5.0", date: "2026-11-08", sections: [
    { label: "新增", items: ["首次公开发布，支持逐项勾选文件。", "提供便携包和统一启动入口，本机配置单独保存。"] },
  ] },
  { version: "0.4.4", date: "2026-11-07", sections: [
    { label: "新增", items: ["未识别文件可手动补番号并预演。"] },
    { label: "修复", items: ["修复部分文件名和前导零识别错误，减少资料匹配出错。"] },
  ] },
  { version: "0.4.3", date: "2026-11-07", sections: [
    { label: "修复", items: ["修复中文、空格或括号路径下的启动问题，改善失败提示。"] },
  ] },
  { version: "0.4.2", date: "2026-11-07", sections: [
    { label: "修复", items: ["修复撤销记录丢失，以及撤销后遗留封面的问题。", "异常字幕时间轴不再强行校正。"] },
  ] },
  { version: "0.4.1", date: "2026-11-07", sections: [
    { label: "新增", items: ["可调整字幕候选数量。"] },
  ] },
  { version: "0.4.0", date: "2026-11-07", sections: [
    { label: "新增", items: ["支持调整字幕源顺序、使用本地字幕、自动选优和校正时间轴。", "支持下载、预览和嵌入封面。"] },
    { label: "修复", items: ["字幕保存到改名后的视频旁。"] },
  ] },
  { version: "0.3.0", date: "2026-11-07", sections: [
    { label: "新增", items: ["支持自定义壁纸、显示方式、背景强度和模糊效果。"] },
  ] },
  { version: "0.2.0", date: "2026-11-06", sections: [
    { label: "新增", items: ["新增工作台、历史与撤销、设置页面。", "支持目录浏览、任务排队、实时进度和报告导出。"] },
  ] },
  { version: "0.1.0", date: "2026-11-05", sections: [
    { label: "新增", items: ["命令行初版：识别番号、补全资料、改名、下载字幕并记录撤销。"] },
  ] },
];
export const CURRENT_RELEASE = RELEASE_HISTORY[0].version;
export function initUpdates() {
  const dialog = document.querySelector('#updatesDialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  const checkbox = dialog.querySelector('#updatesDismiss');
  const timeline = dialog.querySelector('#updatesTimeline');
  let returnFocus;
  function renderTimeline() {
    timeline.replaceChildren(...RELEASE_HISTORY.map(release => {
    const item = document.createElement('li');
    const current = release.version === CURRENT_RELEASE;
    if (current) item.className = 'updates-current';
    const heading = document.createElement('div'); heading.className = 'updates-release-head';
    const version = document.createElement('h3'); version.textContent = `v${release.version}`;
    heading.appendChild(version);
    if (current) {
      const badge = document.createElement('span'); badge.className = 'updates-badge'; badge.textContent = t('当前版本'); heading.appendChild(badge);
    }
    const date = document.createElement('time'); date.dateTime = release.date; date.textContent = release.date;
    heading.appendChild(date); item.appendChild(heading);
    for (const section of release.sections) {
      const group = document.createElement('section'); group.className = 'updates-section';
      const label = document.createElement('h4'); label.textContent = t(section.label);
      const list = document.createElement('ul');
      for (const text of section.items) {
        const change = document.createElement('li'); change.textContent = t(text); list.appendChild(change);
      }
      group.append(label, list); item.appendChild(group);
    }
    return item;
    }));
    dialog.querySelector('#updatesPeriod').textContent = t`${RELEASE_HISTORY.length} ${t('个版本 · 按发布时间倒序排列')}`;
  }
  renderTimeline();
  function isDismissed() {
    try { return localStorage.getItem(UPDATE_DISMISS_KEY) === CURRENT_RELEASE; }
    catch { return false; }
  }
  function open() {
    if (dialog.open) return;
    returnFocus = document.activeElement;
    checkbox.checked = isDismissed();
    dialog.showModal();
    dialog.querySelector('.updates-history').scrollTop = 0;
  }
  function close() { if (dialog.open) dialog.close(); }
  // 立即保存勾选，Esc、遮罩和按钮关闭保持同一种偏好行为。
  checkbox.addEventListener('change', () => {
    try {
      if (checkbox.checked) localStorage.setItem(UPDATE_DISMISS_KEY, CURRENT_RELEASE);
      else localStorage.removeItem(UPDATE_DISMISS_KEY);
      dialog.querySelector('#updatesPreference').textContent = '';
    } catch {
      dialog.querySelector('#updatesPreference').textContent = t('偏好暂未保存，下次仍会提示。');
    }
  });
  dialog.querySelectorAll('[data-updates-close]').forEach(button => button.addEventListener('click', close));
  document.querySelectorAll('[data-updates-open]').forEach(button => button.addEventListener('click', open));
  onLocaleChange(renderTimeline);
  dialog.addEventListener('keydown', event => {
    // 弹窗打开时，阻止工作台的全选、预演及 Esc 等快捷键穿透。
    event.stopPropagation();
  });
  let backdropPress = false;
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  dialog.addEventListener('pointerdown', event => { backdropPress = event.target === dialog && outside(event); });
  dialog.addEventListener('click', event => {
    if (backdropPress && event.target === dialog && outside(event)) close();
    backdropPress = false;
  });
  dialog.addEventListener('close', () => {
    const target = returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : document.querySelector('#ver');
    target?.focus({ preventScroll: true });
  });
  if (!isDismissed()) open();
  return { open, close };
}
