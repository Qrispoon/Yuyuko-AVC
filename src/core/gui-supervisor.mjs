import { spawn } from 'node:child_process';

// The launcher owns one worker. Exit code 75 is an explicit, idle-only restart;
// crashes are reported normally. Never find or kill another process by port.
export function runGuiSupervisor(entry, args = process.argv.slice(2)) {
  args = [...args];
  let worker, stopping = false;
  const stop = () => { stopping = true; worker?.kill(); };
  const launch = () => {
    worker = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      cwd: process.cwd(), stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, AVC_GUI_WORKER: '1' },
      windowsHide: true,
    });
    worker.on('message', value => {
      if (value?.type !== 'listening') return;
      for (const [flag, setting] of [['port', value.port], ['host', value.host], ['config', value.configFile]]) {
        const index = args.indexOf('--' + flag);
        if (index < 0) args.push('--' + flag, String(setting));
        else args[index + 1] = String(setting);
      }
    });
    worker.once('error', error => { console.error(error.message); process.exitCode = 1; });
    worker.once('exit', (code, signal) => {
      if (!stopping && code === 75) { launch(); return; }
      for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, stop);
      process.removeListener('message', message);
      process.removeListener('disconnect', stop);
      process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
      if (process.connected) process.disconnect();
    });
  };
  const message = value => { if (value?.type === 'stop') stop(); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
  if (process.send) { process.on('message', message); process.on('disconnect', stop); }
  launch();
}
