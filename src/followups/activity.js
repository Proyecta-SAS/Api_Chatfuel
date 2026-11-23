const time = value => Date.parse(value || '');
const latest = values => values.filter(value => Number.isFinite(time(value)))
  .sort((a,b) => time(b)-time(a))[0] || null;
const normalized = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .trim().toLowerCase().replace(/[.!]+$/,'');

export function explicitOptOut(value) {
  return normalized(value).split(/[.!?;\n]+/).some(sentence =>
    /^(?:(?:muchas )?gracias[, ]*)?(?:no[, ]+gracias|no me interesa|no interesa|no quiero (?:continuar|seguir)(?: con (?:esto|el proceso|esta conversacion))?|no quiero mas mensajes|no me escribas|no me escriban|no me contacten|dejen de escribirme|cancelar|baja|stop)(?:[, ]*(?:gracias|por favor|por ahora))?$/.test(sentence.trim()));
}

export function conversationActivity(messages, native = {}, since) {
  const rows = messages.filter(m => Number.isFinite(time(m.created_at)) && time(m.created_at)>=time(since));
  const incoming = rows.filter(m=>m.type==='in');
  const prompts = rows.filter(m=>m.type==='out' && m.message_type!=='template'
    && ['delivered','read'].includes(m.status) && !m.error_code);
  const lastIncomingAt = latest([...incoming.map(m=>m.created_at),native.lastIncomingAt]);
  const lastPromptAt = latest([...prompts.map(m=>m.created_at),native.lastPromptAt]);
  // A later acknowledgement or bot reply must not erase a customer's withdrawal.
  const optOut = incoming.some(m=>explicitOptOut(m.message)) || native.optOut===true
    || time(native.lastIncomingAt)>=time(since) && explicitOptOut(native.lastIncomingText);
  return {activityVerified:true,lastIncomingAt,lastPromptAt,optOut};
}

// Returns true when a new answer invalidates the old pending reminder. A new
// cycle begins only after the bot has actually answered that latest message.
export function refreshInactivity(record, snapshot, now) {
  if(snapshot.activityVerified!==true)throw new Error('FOLLOWUP_ACTIVITY_UNVERIFIED');
  const incoming=time(snapshot.lastIncomingAt), initial=time(record.lead.initialAt);
  if(!Number.isFinite(incoming) || incoming<initial)return false;
  if(incoming>now)throw new Error('FOLLOWUP_ACTIVITY_UNVERIFIED');
  if(incoming<=time(record.lastIncomingAt) && record.status!=='awaiting_activity')return false;
  const prompt=time(snapshot.lastPromptAt);
  if(Number.isFinite(prompt) && prompt>=incoming && prompt<=now){
    if(record.steps && Object.keys(record.steps).length){
      record.previousCycles=[...(record.previousCycles||[]),{anchorAt:record.anchorAt||record.lead.initialAt,
        steps:record.steps}].slice(-10);
    }
    record.cycle=(record.cycle||0)+1;
    record.anchorAt=new Date(prompt).toISOString();
    record.steps={};record.nextHour=1;record.status='pending';
    record.nextDueAt=new Date(prompt+3600000).toISOString();
  }else{
    record.status='awaiting_activity';record.nextDueAt=new Date(now+60000).toISOString();
  }
  record.lastIncomingAt=new Date(incoming).toISOString();
  return true;
}
