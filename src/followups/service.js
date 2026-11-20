import { HOURS, normalizePhone, cancellationReason, renderWebhookPayload } from './policy.js';
import { refreshInactivity } from './activity.js';

export function createFollowupService({ config, store, gateway, now = () => Date.now() }) {
  let running = false;
  const status = { enabled: config.enabled, ready: config.ready, running: false, lastRun: null, lastError: null };
  async function enroll(lead) {
    if (!config.enabled || !config.ready) return { enrolled: false, disabled: true };
    const phone = normalizePhone(lead.phone);
    if (!phone || !config.channels[lead.channel] || !/^\d+$/.test(String(lead.id))) throw new Error('INVALID_FOLLOWUP_LEAD');
    const waiting=!lead.initialAt;
    const anchor=Date.parse(waiting ? lead.createdAt : lead.initialAt);
    if (!Number.isFinite(anchor) || anchor < Date.parse(config.enrollAfter) || anchor > now()) return { enrolled: false };
    const canonical = { ...lead, id:String(lead.id), responsible:String(lead.responsible), phone };
    return store.withContact(lead.channel, phone, async (existing, save) => {
      if (existing) return { enrolled: false, existing: true };
      const snapshot=waiting ? null : await gateway.inspect(canonical);
      const reason = waiting ? null : cancellationReason(snapshot, canonical, config);
      if (reason) return { enrolled: false, reason };
      const record={ lead: canonical, status: waiting?'waiting_initial':'pending', steps: {}, nextHour: 1,
        nextDueAt:new Date(waiting?now():anchor+3600000).toISOString() };
      if(config.inactivity && snapshot)refreshInactivity(record,snapshot,now());
      await save(record);
      return { enrolled: true };
    });
  }
  async function process(key) {
    if(!config.enabled || !config.ready)return;
    return store.withContact(key.channel,key.phone,async (record,save) => {
      if (!record) return;
      if(record.status==='delivery_pending')return confirmDelivery(record,save);
      if (record.status==='handoff_pending') return handoff(record,save);
      if(record.status==='waiting_initial'){
        const reason=cancellationReason(await gateway.inspect(record.lead),record.lead,config);
        if(reason){record.status='cancelled';record.reason=reason;await save(record);return;}
        const initialAt=await gateway.initialContact(record.lead);
        if(initialAt){
          if(!Number.isFinite(Date.parse(initialAt)) || Date.parse(initialAt)<Date.parse(config.enrollAfter)
            || Date.parse(initialAt)>now()){
            record.status='cancelled';record.reason='initial_contact_outside_activation';
          }else{
            record.lead.initialAt=initialAt;record.status='pending';
            record.nextDueAt=new Date(Date.parse(initialAt)+3600000).toISOString();
          }
        }else{record.nextDueAt=new Date(now()+60000).toISOString();}
        await save(record);return;
      }
      if (!['pending','awaiting_activity'].includes(record.status)) return;
      const lead = record.lead;
      const snapshot=await gateway.inspect(lead);
      const reason = cancellationReason(snapshot,lead,config);
      if (reason) { record.status = 'cancelled'; record.reason = reason; await save(record); return; }
      if(config.inactivity && refreshInactivity(record,snapshot,now())){await save(record);return;}
      if(record.status==='awaiting_activity'){
        record.nextDueAt=new Date(now()+60000).toISOString();await save(record);return;
      }
      const anchor=Date.parse(record.anchorAt||lead.initialAt);
      const hour = record.nextHour;
      if (!HOURS.includes(hour) || now() < anchor+hour*3600000) return;
      // A process may have died after dispatch; never resend an uncertain message.
      if (record.steps[hour]) { record.status = 'review'; await save(record); return; }
      // Do not send obsolete reminders in a burst after downtime.
      const latest = HOURS.filter(h=>now() >= anchor+h*3600000).at(-1);
      if (latest !== hour) {
        for (const h of HOURS.filter(h=>h>=hour && h<latest)) record.steps[h] = { status:'skipped_expired' };
        record.nextHour = latest;
        record.nextDueAt=new Date(anchor+latest*3600000).toISOString();
        await save(record);
        return;
      }
      const checked = await gateway.inspect(lead);
      const freshReason = cancellationReason(checked,lead,config);
      if (freshReason) { record.status='cancelled'; record.reason=freshReason; await save(record); return; }
      if(config.inactivity && refreshInactivity(record,checked,now())){await save(record);return;}
      const key = `followup:${lead.channel}:${lead.phone}:${lead.id}:${hour}${config.inactivity?':'+anchor:''}`;
      const body = renderWebhookPayload(config.payload,{ phone:lead.phone, name:lead.name || '', channel:lead.channel,
        fromId:config.channels[lead.channel].fromId, dealId:lead.id, template:config.templates[lead.channel][hour], hours:hour, idempotencyKey:key });
      record.steps[hour] = { status:'dispatching', key, at:new Date(now()).toISOString() };
      await save(record);
      try {
        const sent = await gateway.send({url:config.webhooks[lead.channel][hour],body,key,context:{
          phone:lead.phone,name:lead.name||'',channel:lead.channel,dealId:lead.id,
          fromId:config.channels[lead.channel].fromId}});
        if (sent?.accepted !== true) throw new Error('FOLLOWUP_DELIVERY_UNCERTAIN');
        record.steps[hour].status = 'accepted';
        if(!/^[1-9]\d*$/.test(String(sent.messageId||'')))throw new Error('FOLLOWUP_RECEIPT_UNVERIFIED');
        record.steps[hour].messageId=String(sent.messageId);
        record.awaitingHour=hour;
        record.nextHour = HOURS[HOURS.indexOf(hour)+1] || null;
        record.status = 'delivery_pending';
        record.nextDueAt=new Date(now()+60000).toISOString();
        await save(record);
      } catch {
        record.steps[hour].status='unknown'; record.status='review'; await save(record); return;
      }
      await confirmDelivery(record,save);
    });
  }
  async function confirmDelivery(record,save){
    const hour=record.awaitingHour,step=record.steps[hour];
    if(!step?.messageId){record.status='review';record.reason='receipt_unverified';await save(record);return;}
    const result=await gateway.delivery(record.lead,step.messageId);
    if(result.status==='failed'){
      step.status='failed';step.errorCode=result.errorCode;
      record.status='review';record.reason='provider_rejected';
      if(result.errorCode==='131049')step.retryNotBefore=new Date(now()+24*3600000).toISOString();
      await save(record);return;
    }
    if(result.status!=='delivered'){
      if(now()-Date.parse(step.at)>=15*60000){record.status='review';record.reason='delivery_unconfirmed';}
      else record.nextDueAt=new Date(now()+60000).toISOString();
      await save(record);return;
    }
    step.status='delivered';
    record.status=hour===72?'handoff_pending':'pending';
    record.nextDueAt=new Date(record.nextHour?Date.parse(record.anchorAt||record.lead.initialAt)+record.nextHour*3600000:now()).toISOString();
    await save(record);
    if(hour===72)await handoff(record,save);
  }
  async function handoff(record,save) {
    const snapshot=await gateway.inspect(record.lead);
    if(record.assignedTo && snapshot.verified===true && snapshot.stage===config.targetStage
      && String(snapshot.responsible)===record.assignedTo && String(snapshot.id)===record.lead.id
      && normalizePhone(snapshot.phone)===record.lead.phone && String(snapshot.category)===config.category){
      record.status='completed';await save(record);return;
    }
    // Once WhatsApp confirms the 72-hour template delivery, change stage
    // immediately, even if the quick reply races that confirmation.
    // Citas, human intervention, identity and CRM changes remain protected.
    const reason=cancellationReason({...snapshot,incoming:false},record.lead,config);
    if (reason) {record.status='cancelled';record.reason=reason;await save(record);return;}
    if(config.inactivity && refreshInactivity(record,snapshot,now())){await save(record);return;}
    if(!record.assignedTo){record.assignedTo=await store.nextSetter(config.setterIds);await save(record);}
    await gateway.handoff(record.lead,config.targetStage,record.assignedTo);
    record.status='completed';await save(record);
  }
  async function cancel(channel,phone) {
    phone=normalizePhone(phone);
    if (!phone || !config.channels[channel]) throw new Error('INVALID_FOLLOWUP_CONTACT');
    return store.withContact(channel,phone,async (record,save)=>{
      if (!record) return { cancelled:false };
      // Keep the durable dispatch evidence, including ambiguous delivery.
      record.status=config.inactivity && !['review','completed','handoff_pending','delivery_pending'].includes(record.status)
        ? 'awaiting_activity':'cancelled';
      record.nextDueAt=new Date(now()+60000).toISOString();record.reason='customer_replied';await save(record);
      return {cancelled:true,lead:record.lead};
    });
  }
  async function resumeGuard(channel,phone){
    phone=normalizePhone(phone);
    return store.withContact(channel,phone,async(record)=>{
      if(!record)return {known:false,protected:true};
      const snapshot=await gateway.inspect(record.lead);
      if(snapshot.verified!==true)throw new Error('FOLLOWUP_STATE_UNVERIFIED');
      return {known:true,protected:Boolean(snapshot.optOut || snapshot.human || snapshot.appointment || snapshot.rejected
        || String(snapshot.id)!==record.lead.id || normalizePhone(snapshot.phone)!==record.lead.phone
        || String(snapshot.category)!==config.category || snapshot.stage!==config.channels[channel].stage
        || String(snapshot.responsible)!==record.lead.responsible)};
    });
  }
  async function tick() {
    if (!config.enabled || !config.ready || running) return;
    running=true;status.running=true;
    status.lastError=null;
    try {
      for (const key of await store.pending(new Date(now()).toISOString())) {
        try {await process(key);} catch {
          await store.withContact(key.channel,key.phone,async(record,save)=>{
            if(record && ['waiting_initial','pending','awaiting_activity','delivery_pending','handoff_pending'].includes(record.status)){
              record.nextDueAt=new Date(now()+60000).toISOString();await save(record);
            }
          });
          status.lastError='FOLLOWUP_CHECK_FAILED';
        }
      }
      const page=await gateway.discover(config.enrollAfter,await store.discoveryCursor());
      for(const lead of page.leads)await enroll(lead);
      await store.advanceCursor(page.cursor);
      status.lastRun=new Date(now()).toISOString();
    } catch {status.lastError='FOLLOWUP_CHECK_FAILED';}
    finally {running=false;status.running=false;}
  }
  return {enroll,process,cancel,resumeGuard,tick,status};
}

export function startFollowupWorker(service,{intervalMs=60000}={}) {
  if (!service.status.enabled) return ()=>{};
  const timer=setInterval(()=>void service.tick(),intervalMs);timer.unref();
  void service.tick();return ()=>clearInterval(timer);
}
