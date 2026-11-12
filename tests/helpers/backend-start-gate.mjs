// Test-only preload: hold backend module evaluation until the owning test
// releases its private file gate. The launcher itself runs normally.
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const gate = process.env.AVC_TEST_BACKEND_START_GATE;
if (gate && path.basename(process.argv[1] || '') === 'server.mjs') {
  const shutdown = message => { if (message?.type === 'shutdown') process.exit(0); };
  process.on('message', shutdown);
  try {
    await fs.writeFile(gate + '.held', 'held');
    for (;;) {
      try { await fs.access(gate); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await pause(10);
    }
  } finally {
    process.removeListener('message', shutdown);
  }
}
