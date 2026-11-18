import { HOURS, normalizePhone, cancellationReason, renderWebhookPayload } from './policy.js';

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
      const reason = waiting ? null : cancellationReason(await gateway.inspect(canonical), canonical, config);
      if (reason) return { enrolled: false, reason };
      await save({ lead: canonical, status: waiting?'waiting_initial':'pending', steps: {}, nextHour: 1,
        nextDueAt:new Date(waiting?now():anchor+3600000).toISOString() });
      return { enrolled: true };
    });
  }
  async function process(key) {
    if(!config.enabled || !config.ready)return;
    return store.withContact(key.channel,key.phone,async (record,save) => {
      if (!record) return;
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
      if (record.status !== 'pending') return;
      const lead = record.lead;
      const reason = cancellationReason(await gateway.inspect(lead),lead,config);
      if (reason) { record.status = 'cancelled'; record.reason = reason; await save(record); return; }
      const hour = record.nextHour;
      if (!HOURS.includes(hour) || now() < Date.parse(lead.initialAt)+hour*3600000) return;
      // A process may have died after dispatch; never resend an uncertain message.
      if (record.steps[hour]) { record.status = 'review'; await save(record); return; }
      // Do not send obsolete reminders in a burst after downtime.
      const latest = HOURS.filter(h=>now() >= Date.parse(lead.initialAt)+h*3600000).at(-1);
      if (latest !== hour) {
        for (const h of HOURS.filter(h=>h>=hour && h<latest)) record.steps[h] = { status:'skipped_expired' };
        record.nextHour = latest;
        record.nextDueAt=new Date(Date.parse(lead.initialAt)+latest*3600000).toISOString();
        await save(record);
        return;
      }
      const checked = await gateway.inspect(lead);
      const freshReason = cancellationReason(checked,lead,config);
      if (freshReason) { record.status='cancelled'; record.reason=freshReason; await save(record); return; }
      const key = `followup:${lead.channel}:${lead.phone}:${lead.id}:${hour}`;
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
        record.nextHour = HOURS[HOURS.indexOf(hour)+1] || null;
        record.status = hour===72 ? 'handoff_pending' : 'pending';
        record.nextDueAt=new Date(record.nextHour ? Date.parse(lead.initialAt)+record.nextHour*3600000 : now()).toISOString();
        await save(record);
      } catch {
        record.steps[hour].status='unknown'; record.status='review'; await save(record); return;
      }
      if (hour===72) await handoff(record,save);
    });
  }
  async function handoff(record,save) {
    const snapshot=await gateway.inspect(record.lead);
    if(record.assignedTo && snapshot.verified===true && snapshot.stage===config.targetStage
      && String(snapshot.responsible)===record.assignedTo && String(snapshot.id)===record.lead.id
      && normalizePhone(snapshot.phone)===record.lead.phone && String(snapshot.category)===config.category){
      record.status='completed';await save(record);return;
    }
    // Once the 72-hour template has been accepted, the user requires the stage
    // change immediately, even if the quick reply races the acknowledgement.
    // Citas, human intervention, identity and CRM changes remain protected.
    const reason=cancellationReason({...snapshot,incoming:false},record.lead,config);
    if (reason) {record.status='cancelled';record.reason=reason;await save(record);return;}
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
      record.status='cancelled';record.reason='customer_replied';await save(record);
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
            if(record && ['waiting_initial','pending','handoff_pending'].includes(record.status)){
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
