import { normalizePhone } from './policy.js';

export function isAtlasflowWebhook(value) {
  try{const url=new URL(value);return url.protocol==='https:' && url.hostname==='atlasflow.proyectasolutions.co'
    && url.pathname==='/app-whatsapp-automation/bitrix' && !url.username && !url.password && !url.hash;}
  catch{return false;}
}

export function atlasflowRequest(value,context) {
  if(!isAtlasflowWebhook(value))throw new Error('ATLASFLOW_WEBHOOK_INVALID');
  const url=new URL(value),query=url.searchParams;
  const uuid=query.get('uuid'),fromId=query.get('from_id');
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(uuid||'')
    || fromId!==String(context.fromId))throw new Error('ATLASFLOW_TEMPLATE_OR_LINE_MISMATCH');
  if(!/^[1-9]\d*$/.test(String(context.dealId)) || normalizePhone(context.phone)!==context.phone)throw new Error('ATLASFLOW_RECIPIENT_INVALID');
  const macros={ID:String(context.dealId),TITLE:String(context.name||''),'TELÉFONO CLIENTE (DEF)':context.phone};
  const resolve=text=>String(text).replace(/\{\{([^{}]+)\}\}/g,(_,key)=>{
    if(!Object.hasOwn(macros,key))throw new Error('ATLASFLOW_UNKNOWN_MACRO');
    return macros[key];
  });
  let variables;
  try{variables=JSON.parse(query.get('variables')||'{}');}catch{throw new Error('ATLASFLOW_VARIABLES_INVALID');}
  if(!variables || typeof variables!=='object' || Array.isArray(variables)
    || Object.keys(variables).some(key=>!/^\d+$/.test(key)))throw new Error('ATLASFLOW_VARIABLES_INVALID');
  variables=Object.fromEntries(Object.entries(variables).map(([key,text])=>[key,resolve(text)]));
  // Replace every Bitrix macro with verified runtime values. Keep the automation's
  // stage label exactly as supplied; the sender and template are explicit.
  const body={deal_id:String(context.dealId),uuid,from_id:fromId,numero_cel:context.phone,
    etapa:query.get('etapa')||'',variables};
  if(Object.values(variables).some(text=>/[{}]/.test(text)))throw new Error('ATLASFLOW_UNRESOLVED_MACRO');
  url.search='';return {url:url.href,body};
}

export function atlasflowAccepted(result) {
  if(!result || result.error || result.accepted===false || result.legacy_status==='error'
    || result.business_result?.status==='error')return false;
  const delivery=result.actions_result?.primary_action?.artifacts?.delivery_result;
  let response;
  if(delivery){
    if(delivery.mode!=='wasapi' || delivery.status!=='submitted_wasapi' || delivery.can_dispatch!==true
      || !(delivery.http_status>=200 && delivery.http_status<300))return false;
    response=delivery.response_payload;
  }else{
    const legacy=result.legacy_response||result;
    if(legacy.status!=='ok')return false;
    response=legacy.respuesta;
  }
  return Boolean(response && !response.error && Number(response.sent)>0 && Number(response.not_sent)===0
    && !(Array.isArray(response.logs) && response.logs.some(log=>log.success===false || log.error || log.error_message)));
}
