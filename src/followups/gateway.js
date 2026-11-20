import { normalizePhone } from './policy.js';
import { isAtlasflowWebhook, atlasflowRequest, atlasflowAccepted, atlasflowReceipt } from './atlasflow.js';
import { conversationActivity } from './activity.js';

const CAMPAIGNS=['RCH-03/2026-CAMP-META','RCH-02/2026-CAMP-META','RCH - 04/ SEPT 2026',
  'NOV TESTING- RCH- LEADS QA','NOV TESTING- RCH- LEADS NORM'];

export function createFollowupGateway({config,bitrix,bookingHandler,fetchImpl=fetch}) {
  async function history(channel,phone) {
    const messages=[];
    let state;
    for(let page=1;page<=50;page++) {
      const url=new URL(`https://api-ws.wasapi.io/api/v1/whatsapp-messages/${phone}`);
      url.search=new URLSearchParams({from_id:config.channels[channel].fromId,per_page:'100',page:String(page)});
      const response=await fetchImpl(url,{headers:{Authorization:`Bearer ${config.apiKey}`,Accept:'application/json'},
        signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!response.ok)throw new Error('FOLLOWUP_PROVIDER_UNAVAILABLE');
      const data=await response.json();
      if(!Array.isArray(data.data) || data.data.some(row=>String(row.from_id)!==config.channels[channel].fromId
        || normalizePhone(row.wa_id)!==phone))throw new Error('FOLLOWUP_PROVIDER_IDENTITY_MISMATCH');
      if(!Number.isInteger(Number(data.last_page)) || Number(data.last_page)<page)throw new Error('FOLLOWUP_PROVIDER_INVALID_PAGE');
      messages.push(...data.data);state=data.conversation_status;
      if(page===Number(data.last_page))return {messages,state};
    }
    throw new Error('FOLLOWUP_PROVIDER_PAGINATION_LIMIT');
  }
  async function inspect(lead) {
    const deal=await bitrix.call('crm.deal.get',{id:lead.id});
    const source=await history(lead.channel,lead.phone);
    const native=lead.channel==='Chatfuel'
      ? await bookingHandler.followupContext(config.contactPrefix+lead.phone) : {};
    const activity=config.inactivity ? conversationActivity(source.messages,native,lead.initialAt||lead.createdAt) : {};
    if(config.inactivity && lead.channel==='Chatfuel' && native.activityVerified!==true)throw new Error('FOLLOWUP_ACTIVITY_UNVERIFIED');
    return {verified:true,id:String(deal.ID),phone:deal.UF_CRM_1584616588730,
      category:String(deal.CATEGORY_ID),stage:deal.STAGE_ID,responsible:String(deal.ASSIGNED_BY_ID),
      incoming:source.messages.some(m=>m.type==='in') || native.incoming===true,
      ...activity,optOut:native.optOut===true || activity.optOut===true,
      human:['human','livechat','assigned','open'].includes(source.state) || native.human===true,
      appointment:Boolean(deal.UF_CRM_1726241234) || native.appointment===true,
      rejected:deal.CLOSED==='Y' || native.rejected===true};
  }
  return {
    inspect,
    async delivery(lead,messageId){
      if(!/^[1-9]\d*$/.test(String(messageId||'')))throw new Error('FOLLOWUP_RECEIPT_UNVERIFIED');
      const source=await history(lead.channel,lead.phone);
      const matches=source.messages.filter(row=>String(row.id)===String(messageId));
      if(!matches.length)return {status:'pending'};
      if(matches.length!==1 || matches[0].type!=='out' || matches[0].message_type!=='template'){
        throw new Error('FOLLOWUP_RECEIPT_UNVERIFIED');
      }
      const row=matches[0];
      if(row.status==='failed' || row.error_code)return {status:'failed',errorCode:String(row.error_code||'unknown')};
      if(['delivered','read'].includes(row.status))return {status:'delivered'};
      return {status:'pending'};
    },
    async initialContact(lead){
      const source=await history(lead.channel,lead.phone);
      return source.messages.filter(m=>m.type==='out' && m.message_type==='template'
        && Date.parse(m.created_at)>=Date.parse(lead.createdAt || config.enrollAfter)
        && ['read','delivered'].includes(m.status)).sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at))[0]?.created_at || null;
    },
    async discover(after,last='0') {
      const out=[];
        const rows=await bitrix.call('crm.deal.list',{filter:{CATEGORY_ID:config.category,'>=DATE_CREATE':after,
          '>ID':last,UF_CRM_679B8F8F8B917:CAMPAIGNS},order:{ID:'ASC'},select:['ID','TITLE','DATE_CREATE','ASSIGNED_BY_ID',
            'CATEGORY_ID','STAGE_ID','UF_CRM_1584616588730','UF_CRM_679B8F8F8B917']});
        if(!Array.isArray(rows))throw new Error('FOLLOWUP_CRM_INVALID_PAGE');
        for(const deal of rows) {
          if(!CAMPAIGNS.includes(deal.UF_CRM_679B8F8F8B917))continue;
          const channel=deal.UF_CRM_679B8F8F8B917===config.channels.DalIA.campaign?'DalIA':'Chatfuel';
          const phone=normalizePhone(deal.UF_CRM_1584616588730);
          if(!phone || deal.STAGE_ID!==config.channels[channel].stage)continue;
          out.push({id:String(deal.ID),phone,channel,name:deal.TITLE,initialAt:null,createdAt:deal.DATE_CREATE,
            responsible:String(deal.ASSIGNED_BY_ID)});
        }
        if(!rows.length)return {leads:out,cursor:last};
        const next=String(rows.at(-1)?.ID);
        if(!/^\d+$/.test(next)||BigInt(next)<=BigInt(last))throw new Error('FOLLOWUP_CRM_CURSOR_INVALID');
        return {leads:out,cursor:next};
    },
    async send({url,body,key,context}) {
      const atlas=isAtlasflowWebhook(url);
      if(atlas){const request=atlasflowRequest(url,context);url=request.url;body=request.body;}
      const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},
        body:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});
      if(!response.ok)throw new Error('FOLLOWUP_DISPATCH_UNCERTAIN');
      const result=await response.json();
      if(atlas){
        if(!atlasflowAccepted(result))throw new Error('FOLLOWUP_DISPATCH_UNCERTAIN');
        return {accepted:true,...(atlasflowReceipt(result,context)||{})};
      }
      const accepted=config.acceptField.split('.').reduce((value,key)=>value && typeof value==='object'
        && Object.hasOwn(value,key)?value[key]:undefined,result);
      if(accepted!==true || result.error || result.success===false || result.ok===false)throw new Error('FOLLOWUP_DISPATCH_UNCERTAIN');
      // The automation accepted the request; this is not proof of WhatsApp delivery.
      return {accepted:true};
    },
    async handoff(lead,target,setterId) {
      const current=await bitrix.call('crm.deal.get',{id:lead.id});
      if(String(current.ID)!==lead.id || normalizePhone(current.UF_CRM_1584616588730)!==lead.phone
        || String(current.CATEGORY_ID)!==config.category)throw new Error('FOLLOWUP_CRM_CHANGED');
      if(current.STAGE_ID===target && String(current.ASSIGNED_BY_ID)===setterId)return;
      if(String(current.ASSIGNED_BY_ID)!==lead.responsible)throw new Error('FOLLOWUP_CRM_CHANGED');
      if(current.STAGE_ID!==config.channels[lead.channel].stage)throw new Error('FOLLOWUP_CRM_CHANGED');
      const stages=await bitrix.call('crm.status.list',{filter:{ENTITY_ID:`DEAL_STAGE_${config.category}`}});
      if(!Array.isArray(stages)||!stages.some(s=>s.STATUS_ID===target && /SIN RESPUESTA 3 D[IÍ]AS/i.test(s.NAME)))throw new Error('FOLLOWUP_TARGET_STAGE_UNVERIFIED');
      // The CRM webhook need not have user-directory scope. Setter IDs are
      // verified against the existing advisor configuration before activation.
      if(!config.setterIds.includes(setterId))throw new Error('FOLLOWUP_SETTER_UNVERIFIED');
      if(await bitrix.call('crm.deal.update',{id:lead.id,fields:{STAGE_ID:target,ASSIGNED_BY_ID:setterId}})!==true)throw new Error('FOLLOWUP_HANDOFF_UNVERIFIED');
      const verified=await bitrix.call('crm.deal.get',{id:lead.id});
      if(verified.STAGE_ID!==target || String(verified.ASSIGNED_BY_ID)!==setterId)throw new Error('FOLLOWUP_HANDOFF_UNVERIFIED');
    },
  };
}
