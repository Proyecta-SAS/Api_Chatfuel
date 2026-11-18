import { phoneVariants } from '../phone.js';

export const HOURS = [1, 24, 72];
export const BUTTONS = ['Sí, quiero saber', 'Sí, continuemos', 'Quiero retomar', 'Sí, me interesa'];
const normalized = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[.!]+$/, '');
export const isFollowupButton = value => BUTTONS.some(text => normalized(text) === normalized(value));
export const isFollowupDecline = value => normalized(value)==='no, gracias' || normalized(value)==='no gracias';
export const normalizePhone = value => phoneVariants(value)[0] || null;

export function readFollowupConfig(env = process.env) {
  const enabled = env.FOLLOWUPS_ENABLED === 'true';
  const channels = {
    DalIA: { fromId: '25152', stage: env.FOLLOWUPS_DALIA_STAGE_ID || 'C370:PREPARATION', campaign: 'NOV TESTING- RCH- LEADS NORM' },
    Chatfuel: { fromId: '24020', stage: 'C370:NEW' },
  };
  const webhooks = Object.fromEntries(Object.keys(channels).map(channel=>[channel,Object.fromEntries(HOURS.map(hour=>
    [hour,env[`FOLLOWUPS_${channel.toUpperCase()}_${hour}H_WEBHOOK_URL`] || env[`FOLLOWUPS_${hour}H_WEBHOOK_URL`] || '']))]));
  const templates=Object.fromEntries(Object.keys(channels).map(channel=>[channel,Object.fromEntries(HOURS.map(hour=>
    [hour,env[`FOLLOWUPS_${channel.toUpperCase()}_${hour}H_TEMPLATE_NAME`]||env[`FOLLOWUPS_${hour}H_TEMPLATE_NAME`]||'']))]));
  const missing = [];
  if (!env.WASAPI_API_KEY) missing.push('WASAPI_API_KEY');
  if(!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(env.FOLLOWUPS_WEBHOOK_ACCEPT_FIELD||''))missing.push('FOLLOWUPS_WEBHOOK_ACCEPT_FIELD');
  if(env.FOLLOWUPS_TEMPLATES_APPROVED!=='true')missing.push('FOLLOWUPS_TEMPLATES_APPROVED');
  const setterIds=String(env.FOLLOWUPS_SETTER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(setterIds.length!==2 || new Set(setterIds).size!==2 || setterIds.some(x=>!/^\d+$/.test(x)))missing.push('FOLLOWUPS_SETTER_IDS');
  if (!/^wa_\d+_\d+_$/.test(env.FOLLOWUPS_CHATFUEL_CONTACT_PREFIX || '')) missing.push('FOLLOWUPS_CHATFUEL_CONTACT_PREFIX');
  if (!Number.isFinite(Date.parse(env.FOLLOWUPS_ENROLL_AFTER || ''))) missing.push('FOLLOWUPS_ENROLL_AFTER');
  let payload;
  try { payload = JSON.parse(env.FOLLOWUPS_WEBHOOK_BODY_JSON || ''); } catch { missing.push('FOLLOWUPS_WEBHOOK_BODY_JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !JSON.stringify(payload).includes('{{phone}}')
    || !JSON.stringify(payload).includes('{{fromId}}')) {
    if (!missing.includes('FOLLOWUPS_WEBHOOK_BODY_JSON')) missing.push('FOLLOWUPS_WEBHOOK_BODY_JSON');
  }
  for (const hour of HOURS) {
    for(const channel of Object.keys(channels))if(!/^[a-z0-9_]{1,512}$/.test(templates[channel][hour]))missing.push(`FOLLOWUPS_${channel.toUpperCase()}_${hour}H_TEMPLATE_NAME`);
    for(const channel of Object.keys(channels))try {
      const url = new URL(webhooks[channel][hour]);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    } catch { missing.push(`FOLLOWUPS_${channel.toUpperCase()}_${hour}H_WEBHOOK_URL`); }
  }
  if (enabled && missing.length) throw new Error('FOLLOWUPS_CONFIGURATION_INCOMPLETE');
  return { enabled, ready: missing.length === 0, missing, channels, webhooks, payload,
    enrollAfter: env.FOLLOWUPS_ENROLL_AFTER, apiKey: env.WASAPI_API_KEY,
    targetStage: env.FOLLOWUPS_TARGET_STAGE_ID || 'C370:UC_4N24TP', category: '370',
    contactPrefix:env.FOLLOWUPS_CHATFUEL_CONTACT_PREFIX,setterIds,acceptField:env.FOLLOWUPS_WEBHOOK_ACCEPT_FIELD,
    testPhones:String(env.FOLLOWUPS_TEST_PHONES||'').split(',').map(normalizePhone).filter(Boolean),templates };
}

export function cancellationReason(snapshot, lead, config) {
  if (!snapshot || snapshot.verified !== true) throw new Error('FOLLOWUP_STATE_UNVERIFIED');
  if (String(snapshot.id) !== String(lead.id) || normalizePhone(snapshot.phone) !== lead.phone) return 'identity_changed';
  if (snapshot.incoming || snapshot.optOut) return 'customer_replied';
  if (snapshot.human || snapshot.appointment || snapshot.rejected) return 'protected_conversation';
  if (String(snapshot.category) !== config.category || snapshot.stage !== config.channels[lead.channel].stage) return 'crm_changed';
  if (String(snapshot.responsible) !== String(lead.responsible)) return 'responsible_changed';
  return null;
}

export function renderWebhookPayload(pattern, values) {
  if (typeof pattern === 'string') return pattern.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error('FOLLOWUP_UNKNOWN_PAYLOAD_FIELD');
    return String(values[key]);
  });
  if (Array.isArray(pattern)) return pattern.map(item => renderWebhookPayload(item, values));
  if (pattern && typeof pattern === 'object') return Object.fromEntries(Object.entries(pattern).map(([k,v]) => [k,renderWebhookPayload(v,values)]));
  return pattern;
}
