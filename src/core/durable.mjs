import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Atomic replacement of an application-owned JSON document; never hides write errors. */
export async function writeJsonDurable(file, value, { create = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = create ? file : `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    if (!create) await fs.rename(temp, file);
  } finally {
    await handle?.close();
    if (!create) await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
}

export const throwIfAborted = signal => {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('operation cancelled'), { code: 'ABORT_ERR' });
};

/** Capture before any await; serialize per file and provide a shared closing barrier. */
export function createSnapshotWriter({write=writeJsonDurable}={}) {
  const tails=new Map();let accepting=true,closePromise;
  return {
    enqueue(file,value) {
      if(!accepting)throw Object.assign(new Error('snapshot writer is closed'),{code:'WRITER_CLOSED'});
      const snapshot=structuredClone(value),target=path.resolve(file);
      const next=(tails.get(target)||Promise.resolve()).catch(()=>{}).then(()=>write(target,snapshot));
      tails.set(target,next);return next;
    },
    close() {if(closePromise)return closePromise;accepting=false;closePromise=Promise.all([...tails.values()]).then(()=>{});return closePromise;},
  };
}
