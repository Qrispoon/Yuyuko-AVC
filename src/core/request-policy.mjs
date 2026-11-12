// Pure request policy. The trusted authority comes from the actual listener.
export function listenerPolicy(host,port) {
  const names=['127.0.0.1','localhost','::1'].includes(host)?['127.0.0.1','localhost','[::1]']:[host.includes(':')?`[${host}]`:host];
  const authorities=new Set(names.map(h=>`${h}:${port}`.toLowerCase()));
  return {authorities,origins:new Set([...authorities].map(a=>`http://${a}`))};
}
export function evaluateRequest(req,policy) {
  const authority=String(req.headers?.host||'').toLowerCase();
  if(!policy.authorities.has(authority))return {status:403,error:'invalid_host'};
  const target=String(req.url||'/');
  if(!target.startsWith('/')||target.startsWith('//'))return {status:400,error:'invalid_request_target'};
  const method=String(req.method||'GET').toUpperCase();
  const pathname=target.split('?')[0];
  const safeMethod=['GET','HEAD','OPTIONS'].includes(method);
  const origin=req.headers?.origin;
  // Assembly already protects its readable settings, including GET requests.
  if((!safeMethod||pathname.startsWith('/api/assembly/'))&&origin!=null && (typeof origin!=='string'||!policy.origins.has(origin.toLowerCase())))return {status:403,error:'invalid_origin'};
  if(safeMethod)return null;
  const mime=String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();
  if(pathname==='/api/assembly/search')return /^image\/(png|jpeg|webp)$/.test(mime)?null:{status:415,error:'INVALID_IMAGE'};
  if((pathname.startsWith('/api/')||pathname==='/__avc/retry') && mime!=='application/json')return {status:415,error:'json_content_type_required'};
  return null;
}

// The launcher validates the public listener before translating its authority.
// Never let an arbitrary incoming Host/Origin become trusted by the worker.
export function forwardRequestHeaders(req,publicPolicy,host,port) {
  const rejected=evaluateRequest(req,publicPolicy);
  if(rejected)throw Object.assign(new Error(rejected.error),rejected);
  const origin=req.headers?.origin;
  if(origin!=null&&(typeof origin!=='string'||!publicPolicy.origins.has(origin.toLowerCase())))throw Object.assign(new Error('invalid_origin'),{status:403,error:'invalid_origin'});
  const authority=`${host.includes(':')?`[${host}]`:host}:${port}`;
  return {...req.headers,host:authority,...(origin!=null?{origin:`http://${authority}`}:{})};
}
