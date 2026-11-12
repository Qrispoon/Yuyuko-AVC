#!/usr/bin/env node
// Full official test entry for all supported Node versions. --list is read-only.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { discoverTestFiles, parseTestOptions, testArguments } from './lib/test-discovery.mjs';

export async function runTests({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), argv = [], spawnProcess = spawn, output = console.log } = {}) {
  const options = parseTestOptions(argv);
  const files = await discoverTestFiles(root);
  if (options.list) {
    output(JSON.stringify({ files: files.map(file => path.relative(root, file).split(path.sep).join('/')), count: files.length }, null, 2));
    return 0;
  }
  const args = testArguments(files, options);
  // A child is a new test run, including when this helper is itself tested.
  // Inheriting node:test's internal context would silently suppress its suite.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  output(`Running ${files.length} test files${options.coverage ? ' with coverage' : ''} (${process.version})`);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, args, { cwd: root, shell: false, stdio: 'inherit', windowsHide: true, env });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTerminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.removeListener('SIGINT', forwardInterrupt);
      process.removeListener('SIGTERM', forwardTerminate);
    };
    process.once('SIGINT', forwardInterrupt);
    process.once('SIGTERM', forwardTerminate);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runTests({ argv: process.argv.slice(2) }); }
  catch (error) { console.error(`FAIL: ${error.code || error.message}`); process.exitCode = 1; }
}
