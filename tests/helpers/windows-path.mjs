import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
const run=promisify(execFile);

// Only resolve aliases of test-owned directories; no links or system changes.
export async function shortPath(t,directory) {
  if(/[\r\n"%!&|<>^]/.test(directory))throw new Error('Unsupported characters in temporary test path');
  const {stdout}=await run('cmd.exe',['/d','/c',`for %I in ("${directory}") do @echo %~sI`],{windowsHide:true,windowsVerbatimArguments:true});
  const alias=stdout.trim(),real=await fs.realpath(directory);
  if(!alias)throw new Error('No short path returned');
  if(alias.toLowerCase()===real.toLowerCase()){t.skip('8.3 aliases are unavailable on this volume');return null;}
  if((await fs.realpath(alias)).toLowerCase()!==real.toLowerCase())throw new Error('Short path resolved to a different directory');
  return alias;
}
