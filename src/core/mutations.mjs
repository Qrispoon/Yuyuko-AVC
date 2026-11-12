import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { throwIfAborted } from './durable.mjs';

const context = new AsyncLocalStorage(), owners = new Map();
export const mutationBusy = dataDir => owners.has(path.resolve(dataDir));

/** Cooperating processes only. Unknown/stale leases are never stolen automatically. */
export async function withMutation(dataDir, fn, { signal } = {}) {
  const root = path.resolve(dataDir), existing = context.getStore();
  if (existing?.root === root && owners.get(root) === existing) return fn(existing);
  throwIfAborted(signal);
  if (owners.has(root)) throw Object.assign(new Error('task_running'), { code: 'MUTATION_LOCKED', status: 409 });
  const owner = { root, token: randomUUID(), epoch: randomUUID() };
  owners.set(root, owner);
  const lease = path.join(root, '.mutator-lease.json');
  let acquired = false;
  try {
    await fs.mkdir(root, { recursive: true });
    let handle;
    try { handle = await fs.open(lease, 'wx'); }
    catch (e) { if (e.code === 'EEXIST') throw Object.assign(new Error('data directory lease requires review'), { code: 'MUTATION_LOCKED', status: 409, lease }); throw e; }
    acquired = true;
    try { await handle.writeFile(JSON.stringify({ ...owner, pid: process.pid, at: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
    throwIfAborted(signal);
    return await context.run(owner, () => fn(owner));
  } finally {
    try {
      if (acquired) {
        const current = JSON.parse(await fs.readFile(lease, 'utf8'));
        if (current.token !== owner.token) throw Object.assign(new Error('lease ownership changed'), { code: 'LEASE_CHANGED' });
        await fs.unlink(lease);
      }
    } finally { if (owners.get(root) === owner) owners.delete(root); }
  }
}
