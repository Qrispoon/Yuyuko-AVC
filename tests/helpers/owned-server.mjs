import { setTimeout as pause } from 'node:timers/promises';

// These callers spawn the backend directly (AVC_GUI_WORKER=1), so its health
// PID must be the child PID before any test is allowed to mutate that service.
export async function waitForOwnedHealth(base, child, output = () => '', timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const checkChild = () => {
    if (child.exitCode !== null || child.signalCode != null) {
      throw new Error(`server exited before readiness (${child.exitCode ?? child.signalCode}): ${output()}`);
    }
  };
  while (Date.now() < deadline) {
    checkChild();
    let health;
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) health = await response.json();
    } catch { /* not listening yet */ }
    checkChild();
    if (health) {
      if (health.ok !== true || health.pid !== child.pid || !Number.isInteger(child.pid)) {
        throw Object.assign(new Error(`server identity mismatch at ${base}: expected PID ${child.pid}, got ${health.pid}; ${output()}`), { code: 'SERVER_IDENTITY_MISMATCH' });
      }
      return health;
    }
    await pause(100);
  }
  throw new Error(`server not ready at ${base}: ${output()}`);
}
