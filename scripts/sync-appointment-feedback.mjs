import { createDatabase } from '../src/database.js';
import { createBitrixClient } from '../src/bitrix.js';
import { createSchedulingService, readAdvisors } from '../src/calendar/service.js';
import { withAppointmentSummary, DEAL_SUMMARY_FIELD } from '../src/calendar/profileSummary.js';

const id=process.argv[2];
if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id||'')) throw new Error('APPOINTMENT_ID_REQUIRED');
const db=createDatabase(process.env.MYSQL_URL);
try {
  const row=await db.scheduling.getAppointment(id);
  if(row?.status!=='confirmed'||!row.bitrixEventId) throw new Error('APPOINTMENT_NOT_CONFIRMED');
  const latest=await db.scheduling.latestAppointment(row.clientCode);
  if(latest?.id!==id) throw new Error('CURRENT_APPOINTMENT_CHANGED');
  const profile=await db.scheduling.getProfile(row.clientCode);
  if(!profile?.data?.summary) throw new Error('PROFILE_SUMMARY_REQUIRED');
  const advisors=readAdvisors(process.env),bitrix=createBitrixClient(process.env.BITRIX_WEBHOOK_URL);
  const service=createSchedulingService({database:db,bitrix,advisors});
  const preview=withAppointmentSummary(profile.data.summary,row,{advisorName:advisors.find(a=>a.id===row.advisorId)?.name||''});
  if(process.argv.includes('--apply')) {
    const sync=await service.syncAppointmentFeedback(id);
    if(sync?.status!=='completed') throw Object.assign(new Error('FEEDBACK_NOT_COMPLETED'),{code:sync?.lastError||sync?.reason||'FEEDBACK_NOT_COMPLETED'});
    const registered=await db.findClienteByPhone(profile.phone);
    const deal=await bitrix.call('crm.deal.get',{id:registered.id_negociacion});
    const summary=deal[DEAL_SUMMARY_FIELD]||'';
    if(!summary.includes('RESUMEN DE LA CITA')||!summary.includes('Identificador del evento en Bitrix: '+row.bitrixEventId)||summary.includes('No se registra una reserva de cita')) throw new Error('SUMMARY_NOT_VERIFIED');
    console.log(JSON.stringify({status:'updated_and_verified',eventId:row.bitrixEventId,dealId:registered.id_negociacion,section:summary.split('\n\nRESUMEN DE LA CITA\n').at(-1),bookingChanged:false,messagesSent:false}));
  } else console.log(JSON.stringify({status:'preview_only',eventId:row.bitrixEventId,section:preview.split('\n\nRESUMEN DE LA CITA\n').at(-1)}));
} catch(error) {
  console.log(JSON.stringify({status:'failed',cause:/^[A-Z_]{1,64}$/.test(error.code||error.message||'')?(error.code||error.message):'FEEDBACK_CHECK_FAILED'}));
  process.exitCode=1;
} finally {await db.close();}