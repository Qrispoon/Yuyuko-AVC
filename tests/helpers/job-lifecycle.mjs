import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

// A deadline bounds a failed test; success depends on state, never elapsed time.
export async function waitFor(check, description, { timeoutMs = 5000, details = () => '' } = {}) {
  const deadline = performance.now() + timeoutMs;
  let last;
  do {
    last = await check();
    if (last) return last;
    await pause(10);
  } while (performance.now() < deadline);
  assert.fail(`Timed out waiting for ${description}; ${details() || `last result: ${JSON.stringify(last)}`}`);
}

export async function requestJson(base, route, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(base + route, {
    method, signal: AbortSignal.timeout(5000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`);
  return value;
}

export async function waitForJob(base, id) {
  assert.equal(typeof id, 'string', 'submission must return a jobId before polling');
  assert.match(id, /^[a-f0-9-]{36}$/i);
  let last;
  return waitFor(async () => {
    last = await requestJson(base, '/api/jobs/' + id);
    return ['done', 'failed', 'needs_review', 'cancelled', 'aborted'].includes(last.status) && last;
  }, `job ${id} to finish`, { details: () => `last job: ${JSON.stringify(last)}` });
}
