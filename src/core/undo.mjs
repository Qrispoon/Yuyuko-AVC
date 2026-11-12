import path from 'node:path';
import {readJournal,decodeJournal,undoJournal,updateJournal} from './journal.mjs';
import {undoMux} from './assembly.mjs';
import {openState} from './state.mjs';
import {withMutation} from './mutations.mjs';

export async function undoAndProject(file,{dataDir=path.dirname(path.resolve(file))}={}) {
  return withMutation(dataDir,async()=>{
    const journal=await readJournal(file);
    if(decodeJournal(journal)==='mux')return undoMux(file);
    const result=await undoJournal(file,{dataDir});let state,reset=0;
    try {
      const items=result.videoDoneItems||[];
      if(!items.length)return {...result,reset};
      const operationIds=items.map(item=>item.operationId);
      await updateJournal(file,data=>{data.stateProjection={phase:'pending',operationIds};});
      state=openState(path.join(dataDir,'state.db'));
      for(const item of items)if(state.projectUndo(item))reset++;
      state.close();state=null;
      await updateJournal(file,data=>{data.stateProjection={phase:'committed',operationIds,at:new Date().toISOString()};});
      return {...result,reset};
    }catch(e){return {...result,reset,stateError:e.code||e.message,undoComplete:false};}
    finally{state?.close();}
  });
}
