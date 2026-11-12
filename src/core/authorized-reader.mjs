import fs from 'node:fs/promises';
import path from 'node:path';
const error=code=>Object.assign(new Error(code),{code,status:403});
const inside=(root,target)=>{const rel=path.relative(root,target);return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));};
const identity=st=>`${st.dev}:${st.ino}:${st.birthtimeMs}`;

/** Read through the verified handle. Untrusted ancestor replacement requires a native
 * final-handle-path adapter; Node checks here cover stable ancestors and reject links. */
export async function readAuthorizedFile(target,roots,{io=fs,maxBytes=12*1024*1024,finalPathOf=null,requireFinalPath=false}={}) {
  const abs=path.resolve(target),canonicalRoots=await Promise.all(roots.map(r=>io.realpath(path.resolve(r))));
  let current=path.parse(abs).root;
  for(const component of abs.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,component);const st=await io.lstat(current);
    if(st.isSymbolicLink())throw error('PATH_LINK_UNSUPPORTED');
  }
  const canonical=await io.realpath(abs);
  if(!canonicalRoots.some(root=>inside(root,canonical)))throw error('fs_forbidden');
  const handle=await io.open(canonical,'r');
  try {
    const st=await handle.stat();
    if(!st.isFile()||st.size>maxBytes)throw error('FILE_NOT_ALLOWED');
    if(requireFinalPath&&!finalPathOf)throw error('FINAL_HANDLE_PATH_UNSUPPORTED');
    const final=finalPathOf?await finalPathOf(handle):await io.realpath(abs);
    if(!canonicalRoots.some(root=>inside(root,final)))throw error('fs_forbidden');
    const observed=await io.stat(final);
    if(identity(observed)!==identity(st))throw error('PATH_CHANGED');
    let buffer;
    if(handle.read) {
      const bounded=Buffer.allocUnsafe(st.size+1);let used=0;
      while(used<bounded.length){const {bytesRead}=await handle.read(bounded,used,bounded.length-used,used);if(!bytesRead)break;used+=bytesRead;}
      buffer=bounded.subarray(0,used);
    }else buffer=await handle.readFile(); // Pure injected adapters may provide this equivalent.
    const after=await handle.stat();
    if(identity(after)!==identity(st)||after.size!==st.size||after.mtimeMs!==st.mtimeMs||buffer.length!==st.size)throw error('FILE_CHANGED');
    return buffer;
  } finally {await handle.close();}
}
