import { t, onLocaleChange } from './i18n.js';

export function initMaintenance({ api, confirmDialog, toast, invalidatePlan }) {
  const clear = document.querySelector('#btnClearCache');
  const restart = document.querySelector('#btnRestart');
  const status = document.querySelector('#maintenanceStatus');
  let health = null, busy = false, message = '', count = 0, bytes = 0;
  const render = () => {
    const blocked = busy || !health || !!health.running || health.queued > 0 || !!health.maintenance;
    clear.disabled = blocked;
    restart.disabled = blocked || !health.restartSupported;
    status.textContent = message === 'cleared'
      ? t('已清理缓存项：') + count + ' · ' + t('缓存内容大小：') + bytes + ' B'
      : t(message || (!health ? '正在连接后端…' : blocked ? '任务运行或维护中，结束后可操作。' : !health.restartSupported ? '当前后端由外部程序托管，请通过启动脚本运行以启用重启。' : '仅在没有运行或等待中的任务时可操作。'));
  };
  const update = value => { health = value; render(); };
  const post = url => api(url, { method: 'POST', body: '{}' });
  const errorText = error => ({
    task_running: '任务运行或维护中，结束后可操作。',
    maintenance_in_progress: '任务运行或维护中，结束后可操作。',
    restart_unavailable: '当前后端由外部程序托管，请通过启动脚本运行以启用重启。',
    unsafe_cache_directory: '缓存目录包含链接或异常路径，未执行清理。',
  })[error.body?.error] || '维护操作失败，请稍后重试。';
  clear.onclick = async () => {
    if (!await confirmDialog(t('删除缓存'), t('将删除元数据查询缓存、字幕对比临时文件和封面代理缓存。媒体、人工修正、历史、撤销记录、配置与壁纸均保留。当前预演会清除，需要重新预演。'), t('删除缓存'))) return;
    busy = true; message = '正在清理缓存…'; render();
    try {
      const result = await post('/api/maintenance/cache');
      invalidatePlan(); count = result.entries; bytes = result.bytes;
      message = 'cleared'; toast(t('缓存已清理'), 'ok');
    } catch (error) { message = errorText(error); toast(t(message), 'err'); }
    finally { busy = false; render(); }
  };
  restart.onclick = async () => {
    if (!await confirmDialog(t('一键重启前后端'), t('将重启当前后端进程，连接恢复后重新播放启动动画。未保存的设置会丢失，请先保存。'), t('重启'))) return;
    busy = true; message = '正在重启后端，等待重新连接…'; render();
    try {
      const previous = await post('/api/maintenance/restart');
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const response = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(1200) });
          const next = await response.json();
          if (response.ok && next.ok && next.instanceId && next.instanceId !== previous.instanceId) {
            try { sessionStorage.setItem('avc.restart.complete', '1'); } catch { /* optional */ }
            location.replace(`/startup.html${location.search}${location.hash}`); return;
          }
        } catch { /* The old server is expected to disconnect briefly. */ }
      }
      throw new Error('restart_timeout');
    } catch (error) {
      message = error.message === 'restart_timeout' ? '重启后未能连接，请检查启动窗口并手动重新启动。' : errorText(error);
      toast(t(message), 'err'); busy = false; render();
    }
  };
  onLocaleChange(render);
  render();
  try {
    if (sessionStorage.getItem('avc.restart.complete')) {
      sessionStorage.removeItem('avc.restart.complete');
      toast(t('前后端已重启'), 'ok');
    }
  } catch { /* Storage restrictions must not prevent maintenance. */ }
  return { update };
}
