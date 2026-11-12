import {randomUUID,createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error=()=>Object.assign(new Error('candidate_context_changed; list candidates again'),{code:'CANDIDATE_CONTEXT_CHANGED',status:409});
export function createCandidateContexts({now=Date.now}={}) {
  const issued=new Map();
  return {
    issue(context,candidates) {
      for(const [token,item] of issued)if(now()-item.at>3600000)issued.delete(token);
      const token=randomUUID(),snapshot=structuredClone(context),rows=structuredClone(candidates);
      issued.set(token,{context:snapshot,rows,at:now()});
      return {contextToken:token,context:snapshot,candidates:rows.map((row,index)=>({...row,contextToken:token,contextIndex:index}))};
    },
    resolve(candidate,current) {
      const value=issued.get(candidate?.contextToken),index=candidate?.contextIndex;
      if(!value||now()-value.at>3600000||!Number.isInteger(index)||!value.rows[index]||digest(value.context)!==digest(current))throw error();
      const {contextToken,contextIndex,...submitted}=candidate;
      if(digest(submitted)!==digest(value.rows[index]))throw error();
      return structuredClone(value.rows[index]);
    },
    context(candidate) {
      const value=issued.get(candidate?.contextToken);
      if(!value||now()-value.at>3600000)throw error();
      return structuredClone(value.context);
    },
    clear(){issued.clear();},
  };
}
