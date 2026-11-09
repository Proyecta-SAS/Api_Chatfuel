import { phoneVariants } from '../phone.js';
import { evaluateRchEligibility } from './rchEligibility.js';

export const REJECTION_STAGE = 'C370:UC_ELJQDE';
export const REJECTION_SOURCE_STAGE = 'C370:NEW';
const PHONE_FIELD = 'UF_CRM_1584616588730';
const APPOINTMENT_FIELD = 'UF_CRM_1726241234';
const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Only the deterministic eligibility result can request this transition. */
export async function synchronizeRejection({ profile, registered, store, bitrix }) {
  const eligibility = evaluateRchEligibility(profile.data?.answers);
  if (eligibility.status !== 'NO_APLICA') return { status:'skipped', reason:'NOT_DISQUALIFIED' };
  if (!registered) return { status:'pending', reason:'DEAL_NOT_LINKED' };
  const dealId = String(registered.id_negociacion);
  if (!/^[1-9]\d{0,15}$/.test(dealId)) fail('INVALID_REJECTION_DEAL');
  return store.withLock('sync:' + dealId, async locked => {
    if (await locked.hasActiveAppointment(profile.clientCode)) return { status:'skipped', reason:'BOOKING_EXISTS', dealId };
    const read = async () => {
      const deal = await bitrix.call('crm.deal.get', { id:dealId });
      if (String(deal.ID) !== dealId || String(deal.CATEGORY_ID) !== '370') fail('INVALID_REJECTION_DEAL');
      return deal;
    };
    const deal = await read();
    const phone = String(deal[PHONE_FIELD] ?? '').replace(/\D/g, '');
    if (!phone || !phoneVariants(profile.phone).includes(phone)) return { status:'skipped', reason:'PHONE_NOT_VERIFIED', dealId };
    if (deal.CLOSED === 'Y' || deal[APPOINTMENT_FIELD]) return { status:'skipped', reason:'DEAL_HAS_APPOINTMENT_OR_CLOSED', dealId };
    if (deal.STAGE_ID === REJECTION_STAGE) return { status:'completed', dealId, stageId:REJECTION_STAGE, reason:eligibility.reason };
    if (deal.STAGE_ID !== REJECTION_SOURCE_STAGE) return { status:'skipped', reason:'DEAL_STAGE_CHANGED', dealId };
    if (await bitrix.call('crm.deal.update', { id:dealId, fields:{STAGE_ID:REJECTION_STAGE} }) !== true) fail('REJECTION_NOT_CONFIRMED');
    if ((await read()).STAGE_ID !== REJECTION_STAGE) fail('REJECTION_NOT_CONFIRMED');
    return { status:'completed', dealId, stageId:REJECTION_STAGE, reason:eligibility.reason };
  });
}
