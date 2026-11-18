import { timingSafeEqual } from 'node:crypto';
import { isFollowupButton, isFollowupDecline } from './policy.js';

export function createFollowupHandler({service,bookingHandler,secret,contactPrefix,testPhones=[]}) {
  const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
  return async request=>{
    if(!secret || secret.length<32)return json({error:'NOT_CONFIGURED'},503);
    const actual=Buffer.from(request.headers.get('authorization')||''),expected=Buffer.from(`Bearer ${secret}`);
    if(actual.length!==expected.length || !timingSafeEqual(actual,expected))return json({error:'UNAUTHORIZED'},401);
    const path=new URL(request.url).pathname;
    if(path==='/followups/status' && request.method==='GET')return json({...service.status});
    if(request.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
    let body;try{body=await request.json();}catch{return json({error:'INVALID_JSON'},400);}
    if(!body || typeof body!=='object' || Array.isArray(body))return json({error:'INVALID_BODY'},422);
    try{
      if(path==='/followups/resume'){
        if(!contactPrefix)return json({error:'NOT_CONFIGURED'},503);
        if(typeof body.contactId!=='string' || !body.contactId.startsWith(contactPrefix)
          || !/^\d{8,15}$/.test(body.contactId.slice(contactPrefix.length))
          || !(isFollowupButton(body.message)||isFollowupDecline(body.message)))return json({error:'INVALID_FOLLOWUP_BUTTON'},422);
        const snapshot=await bookingHandler.followupContext(body.contactId);
        await service.cancel('Chatfuel',snapshot.phone);
        if(!isFollowupDecline(body.message)){
          const guard=await service.resumeGuard('Chatfuel',snapshot.phone);
          if(guard.protected && !(!guard.known && testPhones.includes(snapshot.phone)))return json({message:guard.known
            ? 'Tu caso ya tiene una gestión o atención registrada. El equipo puede ayudarte a continuar por este chat.'
            : 'No encuentro un seguimiento automático pendiente para este mensaje. El equipo puede ayudarte a revisar tu solicitud.',human:'si',done:'si'});
        }
        return json(await (isFollowupDecline(body.message)
          ? bookingHandler.stopFollowup(body.contactId) : bookingHandler.resumeFollowup(body.contactId)));
      }
      if(path==='/followups/cancel'){
        if(!['DalIA','Chatfuel'].includes(body.channel))return json({error:'INVALID_CHANNEL'},422);
        const result=await service.cancel(body.channel,body.phone);
        return json({ok:true,cancelled:result.cancelled===true});
      }
      return json({error:'NOT_FOUND'},404);
    }catch{return json({error:'FOLLOWUP_STATE_UNAVAILABLE'},503);}
  };
}
