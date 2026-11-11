import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSchedulingService, readAdvisors, APPOINTMENT_DATE_FIELD } from '../src/calendar/service.js';
import { createDatabase } from '../src/database.js';
import { createHandler } from '../src/connector.mjs';
import { importCalendar } from '../scripts/import-calendar.mjs';
import { DEAL_SUMMARY_FIELD } from '../src/calendar/profileSummary.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const advisors = [{ id:'advisor-a', name:'Asesor prueba', bitrixUserId:'10' }];
const request = { startAt:'2026-11-03T09:00:00-05:00', durationMinutes:30, advisorId:'advisor-a', advisorPool:true };
function memoryStore() {
  const profiles = new Map(), bookings = new Map(), locks = new Map(), comments = new Set();
  return {
    async withLock(key, fn) {
      const previous = locks.get(key) || Promise.resolve();
      let unlock; const next = new Promise(resolve => { unlock=resolve; }); locks.set(key,next);
      await previous;
      try { return await fn(this); } finally { unlock(); if(locks.get(key)===next) locks.delete(key); }
    },
    async resolveProfile(phone, code) {
      const found = [...profiles.values()].find(p=>p.phone===phone);
      if(found) return found;
      const profile={ clientCode:code||`CF-${profiles.size}`, name:'Contacto WhatsApp', phone, data:{} };
      profiles.set(profile.clientCode,profile);return profile;
    },
    async getProfile(code) { return profiles.get(code); },
    async saveProfile(profile, body) { profiles.set(profile.clientCode,{...profile,name:body.contactName||profile.name,
      data:{...profile.data,...body,answers:{...profile.data?.answers,...body.answers}}}); },
    async hasActiveAppointment(code) { return [...bookings.values()].some(b=>b.clientCode===code&&['pending','confirmed'].includes(b.status)); },
    async saveRejectionSync(code,sync) { const p=profiles.get(code);p.data={...p.data,rejectionSync:structuredClone(sync)}; },
    async pendingRejectionProfiles(at) { return [...profiles.values()].filter(p=>p.data.rejectionSync?.status==='pending'
      && !p.data.rejectionSync.reviewRequired && p.data.rejectionSync.nextAttemptAt<=at).map(p=>p.clientCode); },
    async getByKey(key) { return structuredClone([...bookings.values()].find(b=>b.key===key)); },
    async getAppointment(id) { return structuredClone(bookings.get(id)); },
    async reservations() { return [...bookings.values()].filter(b=>['pending','confirmed'].includes(b.status)); },
    async insertPending(row) { bookings.set(row.id,structuredClone({...row,createdAt:new Date(NOW).toISOString()})); },
    async confirm(id,eventId,response) { Object.assign(bookings.get(id),{status:'confirmed',bitrixEventId:eventId,response:structuredClone(response)}); },
    async saveSync(id,response) { bookings.get(id).response=structuredClone(response); },
    async pendingCrmAppointments(at) { return [...bookings.values()].filter(row=>row.status==='confirmed'
      && row.response?.crmSync?.requiresResponsible && row.response.crmSync.status==='pending'
      && !row.response.crmSync.reviewRequired && (!row.response.crmSync.nextAttemptAt || row.response.crmSync.nextAttemptAt<=at)).map(row=>row.id); },
    async hasNewerBooking(row) { return [...bookings.values()].some(other=>other.id!==row.id && other.status==='confirmed'
      && other.response?.crmSync?.requiresResponsible && other.response.crmSync.dealId===row.response.crmSync.dealId
      && other.createdAt>=row.createdAt); },
    async claimComment(hash) { if(comments.has(hash)) return false;comments.add(hash);return true; },
    async confirmComment() {},
  };
}
function fixture(store = memoryStore(), pool = advisors) {
  let missingDeal=false,dealReadError=false;
  let failCreate=false, failStage=false, stage='C370:NEW', category='370', omitCalendar=false;
  let responsible='99', ignoreResponsible=false, blockedOwner=null, eventOverride={}, time=NOW;
  let registered = {id_negociacion:'777'};
  let summary = '', ignoreSummary = false;
  let appointmentDate = '', ignoreAppointmentDate = false;
  const calls=[], events=[];
  const database={scheduling:store,findClienteByPhone:async()=>registered};
  const bitrix={call:async(method,params)=>{
    calls.push({method,params});
    if(method==='calendar.accessibility.get') return omitCalendar ? {} : Object.fromEntries(pool.map(a=>[a.bitrixUserId,
      a.bitrixUserId===blockedOwner ? [{DATE_FROM:'2026-11-03T09:00:00-05:00',DATE_TO:'2026-11-03T09:10:00-05:00'}] : []]));
    if(method==='calendar.event.get') return structuredClone(events);
    if(method==='calendar.event.getbyid') return {...structuredClone(events.find(e=>e.ID===String(params.id))),...eventOverride};
    if(method==='calendar.event.add') {
      const id=String(100+events.length);
      events.push({ID:id,CAL_TYPE:'user',DELETED:'N',OWNER_ID:String(params.ownerId),DESCRIPTION:params.description,
        DATE_FROM:params.from,DATE_TO:params.to,TZ_FROM:'America/Bogota',TZ_TO:'America/Bogota',UF_CRM_CAL_EVENT:params.crm_fields||null});
      if(failCreate) throw new Error('Lost response');
      return id;
    }
    if(method==='crm.deal.get') {
      if(missingDeal)throw Object.assign(new Error('NEGOCIACION_NO_ENCONTRADA'),{code:'NEGOCIACION_NO_ENCONTRADA'});
      if(dealReadError)throw Object.assign(new Error('BITRIX_ERROR'),{code:'BITRIX_ERROR'});
      return {ID:'777',CATEGORY_ID:category,STAGE_ID:stage,ASSIGNED_BY_ID:responsible,CLOSED:'N',UF_CRM_1584616588730:'573000000001',[DEAL_SUMMARY_FIELD]:summary,[APPOINTMENT_DATE_FIELD]:appointmentDate};
    }
    if(method==='crm.deal.update') { if(failStage) throw new Error('CRM unavailable');
      if(params.fields.STAGE_ID) stage=params.fields.STAGE_ID;
      if(!ignoreSummary && Object.hasOwn(params.fields,DEAL_SUMMARY_FIELD)) summary=params.fields[DEAL_SUMMARY_FIELD];
      if(!ignoreAppointmentDate && Object.hasOwn(params.fields,APPOINTMENT_DATE_FIELD)) appointmentDate=params.fields[APPOINTMENT_DATE_FIELD];
      if(!ignoreResponsible && params.fields.ASSIGNED_BY_ID) responsible=String(params.fields.ASSIGNED_BY_ID);return true; }
    if(method==='crm.timeline.comment.add') return '600';
    throw new Error('Unexpected method: '+method);
  }};
  const restart=()=>createSchedulingService({database,bitrix,advisors:pool,now:()=>time});
  const service=restart();
  return {service,database,store,calls,events,async profile(phone='573000000001'){
    const result=await service.upsert({phone,contactName:'Prueba simulada',answers:{rch_banco:'Bancolombia',
      rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si',rch_plazo_inicial:'20 años',rch_tiempo_pagando:'10 años',obligacion_vivienda_activa:'si'}});return result.clientId;
    },restart,advance(ms){time+=ms;},get responsible(){return responsible;},set responsible(v){responsible=v;},
  set missingDeal(v){missingDeal=v;},set dealReadError(v){dealReadError=v;},
  get summary(){return summary;},set ignoreSummary(v){ignoreSummary=v;},
  get appointmentDate(){return appointmentDate;},set appointmentDate(v){appointmentDate=v;},set ignoreAppointmentDate(v){ignoreAppointmentDate=v;},
  set ignoreResponsible(v){ignoreResponsible=v;},set blockedOwner(v){blockedOwner=v;},set eventOverride(v){eventOverride=v;},
  get stage(){return stage;},set stage(v){stage=v;},set category(v){category=v;},set failCreate(v){failCreate=v;},
  set failStage(v){failStage=v;},set registered(v){registered=v;},set omitCalendar(v){omitCalendar=v;}};
}
async function scenarios(t, create) {
  await t.test('una negociación eliminada no bloquea horarios ni vincula citas al ID inexistente',async()=>{
    const f=await create();f.missingDeal=true;
    const code=await f.profile();
    const profile=await f.store.getProfile(code);
    assert.equal(profile.data.crmLinkIssue.code,'REGISTERED_DEAL_DELETED');
    assert.equal(await f.service.findRegisteredClient(profile.phone),null);
    assert.equal((await f.database.findClienteByPhone(profile.phone)).id_negociacion,'777');
    const result=await f.service.book(code,request,'deleted-deal-unlinked');
    assert.equal(result.data.status,'confirmed');
    assert.equal(result.data.crmSync,null);
    assert.equal(f.events.length,1);
    assert.equal(f.calls.filter(c=>c.method==='crm.deal.update'||c.method==='crm.timeline.comment.add').length,0);
    assert.deepEqual(f.calls.find(c=>c.method==='calendar.event.add').params.crm_fields||[],[]);
  });
  await t.test('un error de permisos o disponibilidad de Bitrix no se confunde con una negociación eliminada',async()=>{
    const f=await create();f.dealReadError=true;
    await assert.rejects(f.profile(),/BITRIX_ERROR/);
    assert.equal(f.events.length,0);
  });
  await t.test('la agenda rechaza casos descartados e incompletos antes de crear el evento',async()=>{
    for(const patch of [{rch_banco:'BBVA'},{rch_reportes_negativos:'si'},{rch_puede_aumentar_cuota:'no'},
      {rch_tiempo_pagando:'15 años'},{rch_plazo_inicial:''},{rch_banco:''},{rch_reportes_negativos:'desconocido'},
      {rch_puede_aumentar_cuota:'desconocido'},{obligacion_vivienda_activa:''}]){
      const f=await create();const code=await f.profile();const current=await f.store.getProfile(code);
      await f.service.upsert({phone:current.phone,answers:{...current.data.answers,...patch}});
      await assert.rejects(f.service.book(code,request,'blocked-profile'),/RCH_NOT_ELIGIBLE|RCH_PROFILE_INCOMPLETE/);
      assert.equal(f.events.length,0);
    }
  });
  await t.test('reintenta la fecha de asesoría si Bitrix no la guardó, sin duplicar citas',async()=>{
    const f=await create();const code=await f.profile();f.ignoreAppointmentDate=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'date-retry');
    assert.equal(result.data.status,'confirmed');assert.equal(result.data.crmSync.status,'pending');
    assert.equal(result.data.crmSync.lastError,'APPOINTMENT_DATE_NOT_CONFIRMED');
    f.ignoreAppointmentDate=false;f.advance(31_000);await f.restart().retryPendingCrm();
    const saved=await f.store.getAppointment(result.data.appointmentId);
    assert.equal(saved.response.crmSync.status,'completed');
    assert.equal(Date.parse(f.appointmentDate),Date.parse(request.startAt));assert.equal(f.events.length,1);
  });
  await t.test('una fecha equivalente con otra zona horaria ya está sincronizada',async()=>{
    const f=await create();const code=await f.profile();f.ignoreAppointmentDate=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'date-offset');
    f.appointmentDate='2026-11-03T17:00:00+03:00';
    const writes=f.calls.filter(c=>c.method==='crm.deal.update').length;
    f.advance(31_000);await f.service.retryPendingCrm();
    assert.equal((await f.store.getAppointment(result.data.appointmentId)).response.crmSync.status,'completed');
    assert.equal(f.calls.filter(c=>c.method==='crm.deal.update').length,writes);assert.equal(f.events.length,1);
  });
  await t.test('respeta una fecha de asesoría cambiada por una persona durante el reintento',async()=>{
    const f=await create();const code=await f.profile();f.failStage=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'date-manual');
    f.failStage=false;f.appointmentDate='2026-11-04T10:00:00-05:00';f.advance(31_000);
    await f.service.retryPendingCrm();
    const sync=(await f.store.getAppointment(result.data.appointmentId)).response.crmSync;
    assert.equal(sync.reviewRequired,true);assert.equal(sync.lastError,'DEAL_APPOINTMENT_DATE_CHANGED');
    assert.equal(f.appointmentDate,'2026-11-04T10:00:00-05:00');assert.equal(f.events.length,1);
  });
  await t.test('horarios consultados en Bitrix; ausencia de calendario falla cerrada',async()=>{
    const f=await create();const code=await f.profile();
    const body={dateFrom:'2026-11-03',dateTo:'2026-11-03',fromTime:'08:30',toTime:'12:00'};
    assert.ok((await f.service.availability(code,body)).data.slots.length>0);
    f.omitCalendar=true;await assert.rejects(f.service.availability(code,body),/INVALID_AVAILABILITY/);
  });
  await t.test('reserva, vincula D_ID y cambia etapa solamente después de persistir',async()=>{
    const f=await create();const code=await f.profile();
    const body={...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'};
    const result=await f.service.book(code,body,'booking-1');
    assert.equal(result.data.crmSync.status,'completed');assert.equal(f.stage,'C370:EXECUTING');
    assert.equal(f.responsible,'10');assert.equal(result.data.crmSync.responsibleId,'10');
    assert.deepEqual(f.calls.find(c=>c.method==='crm.deal.update').params.fields,{STAGE_ID:'C370:EXECUTING',ASSIGNED_BY_ID:'10',[APPOINTMENT_DATE_FIELD]:'2026-11-03T14:00:00.000Z'});
    assert.equal(Date.parse(f.appointmentDate),Date.parse(request.startAt));
    const add=f.calls.find(c=>c.method==='calendar.event.add');assert.deepEqual(add.params.crm_fields,['D_777']);
    assert.equal(Date.parse(add.params.to)-Date.parse(add.params.from),1_800_000);
    assert.equal((await f.store.getByKey('booking-1')).status,'confirmed');
    assert.ok(f.calls.findIndex(c=>c.method==='crm.deal.update')>f.calls.findIndex(c=>c.method==='calendar.event.add'));
    assert.equal((await f.service.book(code,body,'booking-1')).data.duplicate,true);
    assert.equal(f.events.length,1);
    await assert.rejects(f.service.book(code,{...body,bitrixDealId:'778'},'booking-1'),/IDEMPOTENCY_KEY_CONFLICT/);
    await assert.rejects(f.service.book(code,{...body,startAt:'2026-11-03T10:00:00-05:00'},'booking-1'),/IDEMPOTENCY_KEY_CONFLICT/);
  });
  await t.test('sin registro MySQL reserva sin vincular ni mover negociaciones',async()=>{
    const f=await create();f.registered=null;const code=await f.profile();
    const result=await f.service.book(code,request,'no-binding');
    assert.equal(result.data.status,'confirmed');assert.equal(result.data.crmSync,null);
    assert.equal(f.calls.some(c=>c.method.startsWith('crm.')),false);
    assert.equal(f.calls.find(c=>c.method==='calendar.event.add').params.crm_fields,undefined);
  });
  await t.test('respuesta perdida se recupera por marcador sin crear otra cita',async()=>{
    const f=await create();const code=await f.profile();f.failCreate=true;
    await assert.rejects(f.service.book(code,request,'lost'),/Lost response/);
    assert.equal((await f.store.getByKey('lost')).status,'pending');
    const recovered=await f.service.book(code,request,'lost');
    assert.equal(recovered.data.status,'confirmed');assert.equal(recovered.data.duplicate,true);
    assert.equal(f.events.length,1);
  });
  await t.test('pendiente sin evento identificable queda bloqueada',async()=>{
    const f=await create();const code=await f.profile();f.failCreate=true;
    await assert.rejects(f.service.book(code,request,'unknown'));
    f.events.length=0;
    await assert.rejects(f.service.book(code,request,'unknown'),/BOOKING_CHECK_REQUIRED/);
    assert.equal(f.calls.filter(c=>c.method==='calendar.event.add').length,1);
  });
  await t.test('dos solicitudes concurrentes con misma clave crean un evento',async()=>{
    const f=await create();const code=await f.profile();
    const results=await Promise.all([f.service.book(code,request,'concurrent'),f.service.book(code,request,'concurrent')]);
    assert.equal(results[0].data.appointmentId,results[1].data.appointmentId);assert.equal(f.events.length,1);
  });
  await t.test('dos clientes compiten por el horario; solo uno lo reserva',async()=>{
    const f=await create();const a=await f.profile(),b=await f.profile('573000000002');
    const results=await Promise.allSettled([f.service.book(a,request,'same-slot-1'),f.service.book(b,request,'same-slot-2')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.match(results.find(r=>r.status==='rejected').reason.message,/SLOT_UNAVAILABLE/);assert.equal(f.events.length,1);
  });
  await t.test('reintento CRM no vuelve a reservar y respeta un cambio manual de etapa',async()=>{
    const f=await create();const code=await f.profile();f.failStage=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'stage');
    assert.equal(result.data.status,'confirmed');assert.equal(result.data.crmSync.status,'pending');
    f.failStage=false;f.stage='C370:WON';
    assert.equal((await f.service.syncCrm(result.data.appointmentId)).status,'pending');assert.equal(f.stage,'C370:WON');
    f.stage='C370:NEW';assert.equal((await f.service.syncCrm(result.data.appointmentId)).status,'completed');assert.equal(f.events.length,1);
  });
  await t.test('negociación incorrecta o ambigua no crea evento',async()=>{
    const f=await create();const code=await f.profile();f.category='99';
    await assert.rejects(f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'invalid'),/INVALID_BITRIX_DEAL/);
    assert.equal(f.events.length,0);
    f.database.findClienteByPhone=async()=>{throw new Error('TELEFONO_AMBIGUO');};
    await assert.rejects(f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'ambiguous'),/TELEFONO_AMBIGUO/);
  });
  await t.test('un fallo de responsable se recupera después de reiniciar sin volver a reservar',async()=>{
    const f=await create();const code=await f.profile();f.failStage=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'responsible-retry');
    assert.equal(result.data.status,'confirmed');assert.equal(result.data.crmSync.status,'pending');
    assert.equal(await f.restart().retryPendingCrm(),0);
    f.failStage=false;f.advance(31_000);
    assert.equal(await f.restart().retryPendingCrm(),1);
    assert.equal((await f.store.getAppointment(result.data.appointmentId)).response.crmSync.status,'completed');
    assert.equal(f.responsible,'10');assert.equal(f.events.length,1);
  });
  await t.test('verifica el responsable leído y reintenta si Bitrix no aplicó el cambio',async()=>{
    const f=await create();const code=await f.profile();f.ignoreResponsible=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'responsible-verify');
    assert.equal(result.data.crmSync.status,'pending');assert.equal(f.responsible,'99');
    f.ignoreResponsible=false;f.advance(31_000);await f.service.retryPendingCrm();
    assert.equal(f.responsible,'10');assert.equal(f.events.length,1);
  });
  await t.test('respeta una reasignación humana posterior al fallo',async()=>{
    const f=await create();const code=await f.profile();f.failStage=true;
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'responsible-manual');
    f.failStage=false;f.responsible='555';f.advance(31_000);await f.service.retryPendingCrm();
    const saved=await f.store.getAppointment(result.data.appointmentId);
    assert.equal(saved.response.crmSync.reviewRequired,true);assert.equal(f.responsible,'555');
    assert.equal(f.events.length,1);assert.equal(await f.service.retryPendingCrm(),0);
  });
  await t.test('un evento eliminado no reasigna la negociación',async()=>{
    const f=await create();const code=await f.profile();f.eventOverride={DELETED:'Y'};
    const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'responsible-deleted');
    assert.equal(result.data.crmSync.reviewRequired,true);assert.equal(f.responsible,'99');
    assert.equal(f.calls.filter(c=>c.method==='crm.deal.update').length,0);
  });
  await t.test('reserva heredada sin fila local nunca se recrea',async()=>{
    const f=await create();const code=await f.profile();
    await assert.rejects(f.service.book(code,{...request,resumeOnly:true},'legacy'),/LEGACY_BOOKING_REVIEW_REQUIRED/);
    assert.equal(f.events.length,0);
  });
  await t.test('perfil y comentario repetido conservan cliente y no duplican comentario',async()=>{
    const f=await create();const body={phone:'573000000001',externalLeadId:'OLD-CODE',contactName:'Persona prueba',summary:'Resumen ficticio'};
    const first=await f.service.upsert(body);assert.equal(first.clientId,'OLD-CODE');
    assert.equal((await f.service.upsert(body)).clientId,first.clientId);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,1);
    assert.equal(f.summary,body.summary);
    assert.equal(f.calls.filter(c=>c.method==='crm.deal.update').length,1);
    assert.equal(f.stage,'C370:NEW');assert.equal(f.responsible,'99');
  });
  await t.test('resumen actualizado y timeline con negrita, saltos y contenido seguro',async()=>{
    const f=await create();const body={phone:'573000000001',summary:'RESUMEN Y FEEDBACK DE DALIA\n\nDATOS RECOPILADOS\n• Nombre: [USER=1]Prueba[/USER] <b>texto</b>'};
    await f.service.upsert(body);
    assert.equal(f.summary,body.summary);
    const comment=f.calls.find(c=>c.method==='crm.timeline.comment.add').params.fields;
    assert.equal(comment.ENTITY_ID,'777');assert.equal(comment.ENTITY_TYPE,'deal');
    assert.match(comment.COMMENT,/\[b\]DATOS RECOPILADOS\[\/b\]\n• Nombre:/);
    assert.doesNotMatch(comment.COMMENT,/\[USER|<b>/);
    assert.ok(comment.COMMENT.includes('\n\n'));
    await f.service.upsert({...body,summary:'RESUMEN Y FEEDBACK DE DALIA\n\nDatos nuevos'});
    assert.match(f.summary,/Datos nuevos/);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,2);
  });
  await t.test('campo ignorado por Bitrix no confirma resumen; el reintento recupera sin duplicar',async()=>{
    const f=await create();const body={phone:'573000000001',summary:'Resumen por confirmar'};
    f.ignoreSummary=true;
    await assert.rejects(f.service.upsert(body),/SUMMARY_NOT_CONFIRMED/);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,0);
    f.ignoreSummary=false;await f.service.upsert(body);await f.service.upsert(body);
    assert.equal(f.summary,body.summary);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,1);
  });
  await t.test('emojis en el nombre no truncan el resumen y se conserva el original en el perfil local',async()=>{
    const f=await create();const body={phone:'573000000001',
      summary:'RESUMEN Y FEEDBACK DE CHATFUEL\nJosé 😊\nEntidad: BBVA. Motivo: BANK_EXCLUDED.',answers:{rch_banco:'BBVA'}};
    const result=await f.service.upsert(body);
    assert.equal(f.stage,'C370:UC_ELJQDE');
    assert.equal(f.summary,'RESUMEN Y FEEDBACK DE CHATFUEL\nJosé \nEntidad: BBVA. Motivo: BANK_EXCLUDED.');
    assert.equal((await f.store.getProfile(result.clientId)).data.summary,body.summary);
    await f.service.upsert({...body,summary:body.summary.replace('😊','🥰')});
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,1);
    assert.match(f.calls.find(c=>c.method==='crm.timeline.comment.add').params.fields.COMMENT,/BANK_EXCLUDED/);
    assert.equal(f.events.length,0);
  });
  await t.test('un error del campo resumen no bloquea el descarte ni duplica la etapa al recuperarse',async()=>{
    const f=await create();f.ignoreSummary=true;
    const body={phone:'573000000001',summary:'Descarte por entidad',answers:{rch_banco:'BBVA'}};
    await assert.rejects(f.service.upsert(body),/SUMMARY_NOT_CONFIRMED/);
    assert.equal(f.stage,'C370:UC_ELJQDE');
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,0);
    f.ignoreSummary=false;await f.service.upsert(body);await f.service.upsert(body);
    assert.equal(f.summary,body.summary);
    assert.equal(f.calls.filter(c=>c.method==='crm.deal.update'&&c.params.fields.STAGE_ID).length,1);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,1);
    assert.equal(f.events.length,0);
  });
  await t.test('sin negociación registrada no escribe resumen ni comentario',async()=>{
    const f=await create();f.registered=null;
    await f.service.upsert({phone:'573000000001',summary:'Perfil local'});
    assert.equal(f.calls.filter(c=>c.method.startsWith('crm.')).length,0);
  });
  await t.test('error de resumen permite reintento y embudo ajeno no se modifica',async()=>{
    const f=await create();const body={phone:'573000000001',summary:'Resumen de prueba'};
    f.failStage=true;await assert.rejects(f.service.upsert(body),/CRM unavailable/);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,0);
    f.failStage=false;await f.service.upsert(body);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,1);
    f.category='1';await assert.rejects(f.service.upsert({...body,summary:'Cambio'}),/INVALID_BITRIX_DEAL/);
    assert.equal(f.summary,body.summary);
  });
  await t.test('resúmenes concurrentes iguales solo escriben una vez',async()=>{
    const f=await create();await f.profile();
    const body={phone:'573000000001',summary:'Resumen concurrente'};
    await Promise.all([f.service.upsert(body),f.service.upsert(body)]);
    assert.equal(f.calls.filter(c=>c.method==='crm.deal.update').length,1);
    assert.equal(f.calls.filter(c=>c.method==='crm.timeline.comment.add').length,1);
  });
  await t.test('feedback antes y después de reservar conserva evento, vínculo, responsable e idempotencia',async()=>{
    const f=await create();
    const profile={phone:'573000000001',summary:'RESUMEN Y FEEDBACK DE DALIA\n\nDATOS RECOPILADOS\nPerfil de prueba',
      answers:{rch_banco:'Bancolombia',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si',rch_plazo_inicial:'20 años',rch_tiempo_pagando:'10 años',obligacion_vivienda_activa:'si'}};
    const {clientId}=await f.service.upsert(profile);
    const body={...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'};
    const booking=await f.service.book(clientId,body,'feedback-booking');
    const before=structuredClone(f.events);
    await f.service.upsert({...profile,summary:'RESUMEN Y FEEDBACK DE DALIA\n\nDATOS RECOPILADOS\nPerfil actualizado'});
    const repeat=await f.service.book(clientId,body,'feedback-booking');
    assert.equal(repeat.data.bitrixEventId,booking.data.bitrixEventId);
    assert.equal(repeat.data.duplicate,true);
    assert.deepEqual(f.events,before);assert.equal(f.events.length,1);
    assert.deepEqual(f.events[0].UF_CRM_CAL_EVENT,['D_777']);
    assert.equal(f.responsible,'10');assert.equal(f.stage,'C370:EXECUTING');
    assert.equal((await f.store.getByKey('feedback-booking')).status,'confirmed');
  });
}
test('motor independiente con Bitrix simulado',async t=>scenarios(t,async()=>fixture()));

test('persiste un descarte pendiente y el worker lo recupera después de una caída de Bitrix',async()=>{
  const f=fixture();f.failStage=true;
  const {clientId,rejectionSync}=await f.service.upsert({phone:'573000000001',answers:{rch_banco:'BBVA'}});
  assert.equal(rejectionSync.status,'pending');assert.equal(f.stage,'C370:NEW');
  const saved=await f.store.getProfile(clientId);assert.equal(saved.data.rejectionSync.attempts,1);
  f.failStage=false;assert.equal(await f.service.retryPendingCrm(),0);
  f.advance(31_000);assert.equal(await f.service.retryPendingCrm(),1);
  assert.equal(f.stage,'C370:UC_ELJQDE');assert.equal((await f.store.getProfile(clientId)).data.rejectionSync.status,'completed');
  assert.equal(f.events.length,0);assert.equal(await f.service.retryPendingCrm(),0);
});

test('una corrección del perfil cancela el descarte pendiente y no mueve la negociación',async()=>{
  const f=fixture();f.failStage=true;
  const {clientId}=await f.service.upsert({phone:'573000000001',answers:{rch_banco:'BBVA'}});
  f.failStage=false;await f.service.upsert({phone:'573000000001',answers:{rch_banco:'Bancolombia'}});
  f.advance(31_000);assert.equal(await f.service.retryPendingCrm(),0);
  assert.equal(f.stage,'C370:NEW');assert.equal((await f.store.getProfile(clientId)).data.rejectionSync.reason,'NOT_DISQUALIFIED');
});
test('motor independiente con MySQL real: persistencia, locks y recuperación', {skip:!process.env.TEST_MYSQL_URL},async t=>{
  const mysql=(await import('mysql2/promise')).default;
  const uri=new URL(process.env.TEST_MYSQL_URL);uri.pathname='/';
  const admin=await mysql.createConnection(uri.href);const name='chatfuel_calendar_test_'+randomBytes(6).toString('hex');
  let db;
  try {
    await admin.query(`CREATE DATABASE \`${name}\``);uri.pathname='/'+name;
    db=createDatabase(uri.href);await db.init();await db.init();
    await scenarios(t,async()=>{
      for(const table of ['chatfuel_citas','chatfuel_comentarios','chatfuel_perfiles']) await admin.query(`DELETE FROM \`${name}\`.${table}`);
      return fixture(db.scheduling);
    });
  } finally {if(db) await db.close();await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);await admin.end();}
});
test('configuración rechaza asesores duplicados o incompletos',()=>{
  assert.throws(()=>readAdvisors({}),/INVALID_ADVISORS/);
  assert.throws(()=>readAdvisors({APPOINTMENT_ADVISORS_JSON:JSON.stringify([...advisors,...advisors])}),/INVALID_ADVISORS/);
  assert.deepEqual(readAdvisors({APPOINTMENT_ADVISORS_JSON:JSON.stringify(advisors)}),advisors);
});

test('asigna a Tatiana usando el usuario del evento realmente creado',async()=>{
  const tatiana=[{id:'tatiana',name:'Asesora de prueba',bitrixUserId:'19922'}];
  const f=fixture(undefined,tatiana);const code=await f.profile();
  const options=await f.service.availability(code,{dateFrom:'2026-11-03',dateTo:'2026-11-03',fromTime:'09:00',toTime:'10:00'});
  assert.ok(options.data.slots.length);assert.ok(options.data.slots.every(slot=>slot.advisorId==='tatiana'));
  await assert.rejects(f.service.book(code,request,'retired-advisor'),/INVALID_ADVISOR/);
  assert.equal(f.events.length,0);
  const result=await f.service.book(code,{...request,advisorId:'tatiana',bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'tatiana');
  assert.equal(result.data.crmSync.responsibleId,'19922');assert.equal(f.responsible,'19922');
  assert.ok(f.events.every(event=>event.OWNER_ID==='19922'));
});

test('el responsable corresponde al asesor disponible al confirmar, no al ofrecido antes',async()=>{
  const pool=[...advisors,{id:'advisor-b',name:'Segundo asesor',bitrixUserId:'20'}];
  const f=fixture(undefined,pool);const code=await f.profile();f.blockedOwner='10';
  const result=await f.service.book(code,{...request,bitrixDealId:'777',bitrixStageId:'C370:EXECUTING'},'changed-advisor');
  assert.equal(result.data.crmSync.responsibleId,'20');assert.equal(f.events[0].OWNER_ID,'20');
  assert.equal(f.responsible,'20');
});

test('Chatfuel recorre la agenda propia completa sin HTTP hacia otro CRM',async()=>{
  let turnNow=NOW;
  const f=fixture();
  const id='wa_999999999999_888888888888_573000000001';
  const fields={nombre_completo:'Persona simulada',ciudad_municipio:'Bogotá',obligacion_vivienda_activa:'si',
    rch_banco:'Bancolombia',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si',rch_plazo_inicial:'20 años',rch_tiempo_pagando:'10 años'};
  const secret='secreto-local-exclusivo-para-test-123456789';
  const handler=createHandler({database:f.database,scheduling:f.service,now:()=>turnNow,
    env:{CHATFUEL_BOT_ID:'mock',CHATFUEL_API_TOKEN:'mock',CHATFUEL_BOOKING_SECRET:secret},
    fetchImpl:async(url,init)=>{
      assert.equal(url,'https://panel.chatfuel.com/graphql','el único HTTP del conector es Chatfuel');
      const payload=JSON.parse(init.body);
      if(payload.query.includes('query BookingContact')) return Response.json({data:{bot:{contact:{id,phone:'573000000001',
        attributes:Object.entries(fields).map(([name,value])=>({attr:{name},value:{stringValue:value}}))}}}});
      const data={};for(const match of payload.query.matchAll(/a(\d+):contactAttributeUpdate\(id:\$id,attrName:("(?:\\.|[^"\\])*"),attrValue:\$v\d+\)/g)) {
        fields[JSON.parse(match[2])]=payload.variables[`v${match[1]}`];data[`a${match[1]}`]={id};
      }
      return Response.json({data});
    }});
  async function step(operation,answer) {
    if(answer!==undefined)fields.bitrix_agenda_respuesta=answer;
    const result=await handler(new Request('http://localhost/booking',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({contactId:id,operation})}));
    return result.json();
  }
  assert.match((await step('start')).message,/mañana/);
  turnNow+=2*60*60_000;f.advance(2*60*60_000);
  await step('step','mañana');await step('step','1');
  turnNow+=31*60_000;f.advance(31*60_000);
  assert.match((await step('step','1')).message,/horarios libres/);
  assert.match((await step('step','1')).message,/Confirmas/);
  assert.equal(f.events.length,0);
  turnNow+=31*60_000;f.advance(31*60_000);
  assert.match((await step('step','sí')).message,/horarios libres/);
  assert.equal(f.events.length,0);
  await step('step','1');
  const result=await step('step','sí');
  assert.match(result.message,/quedó agendada/);assert.equal(f.events.length,1);
  assert.equal(fields.bitrix_negociacion_id,'777');assert.equal(f.stage,'C370:EXECUTING');
  assert.equal(fields.bitrix_responsable_id,'10');assert.equal(fields.bitrix_responsable_sync,'completado');
  turnNow+=2*60*60_000;f.advance(2*60*60_000);
  await step('step','sí');assert.equal(f.events.length,1);
});

test('importador MySQL conserva citas y es idempotente', {skip:!process.env.TEST_MYSQL_URL},async()=>{
  const mysql=(await import('mysql2/promise')).default;
  const uri=new URL(process.env.TEST_MYSQL_URL);uri.pathname='/';
  const admin=await mysql.createConnection({uri:uri.href,timezone:'Z'});
  const name='chatfuel_import_test_'+randomBytes(6).toString('hex');let db;
  try {
    await admin.query(`CREATE DATABASE \`${name}\``);uri.pathname='/'+name;
    db=createDatabase(uri.href);await db.init();await admin.query(`USE \`${name}\``);
    const snapshot={profiles:[{codigo:'LEGACY-1',telefono:'573000000001',nombre:'Prueba',answers:{}}],appointments:[{
      id:'11111111-1111-4111-8111-111111111111',client_code:'LEGACY-1',advisor_user_id:'advisor-a',bitrix_owner_id:'10',bitrix_event_id:'200',
      idempotency_key:'chatfuel-'+'a'.repeat(64),starts_at:request.startAt,ends_at:'2026-11-03T09:10:00-05:00',status:'confirmed',
      request_payload:{...request,durationMinutes:10},response_payload:{crmSync:null},created_at:'2026-11-02T12:00:00Z',
    }]};
    assert.deepEqual(await importCalendar(admin,snapshot),{profilesImported:1,appointmentsImported:1});
    assert.deepEqual(await importCalendar(admin,snapshot),{profilesImported:0,appointmentsImported:0});
    const row=await db.scheduling.getByKey(snapshot.appointments[0].idempotency_key);
    assert.equal(row.bitrixEventId,'200');assert.equal(Date.parse(row.startAt),Date.parse(request.startAt));
    const f=fixture(db.scheduling);
    assert.equal((await f.service.book('LEGACY-1',{...request,durationMinutes:10},snapshot.appointments[0].idempotency_key)).data.duplicate,true);
    assert.equal(f.events.length,0);
    snapshot.profiles[0].telefono='573000000002';await assert.rejects(importCalendar(admin,snapshot),/PROFILE_CONFLICT/);
  } finally {if(db)await db.close();await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);await admin.end();}
});

test('los treinta minutos completos deben estar libres y caber antes del cierre',async()=>{
  const f=fixture();const code=await f.profile();
  const unavailable=createSchedulingService({database:f.database,advisors,now:()=>NOW,bitrix:{call:async(method)=>{
    if(method==='calendar.accessibility.get')return {'10':[{DATE_FROM:'2026-11-03T09:20:00-05:00',DATE_TO:'2026-11-03T09:30:00-05:00'}]};
    throw Error('No calendar write expected');
  }}});
  assert.equal((await unavailable.availability(code,{dateFrom:'2026-11-03',dateTo:'2026-11-03',fromTime:'09:00',toTime:'09:30'})).data.slots.length,0);
  await assert.rejects(unavailable.book(code,request,'partial-block'),/SLOT_UNAVAILABLE/);
  await assert.rejects(f.service.book(code,{...request,startAt:'2026-11-03T16:40:00-05:00'},'after-close'),/INVALID_START/);
  assert.equal(f.events.length,0);
});

test('recupera una cita antigua de diez minutos sin ampliarla ni crear otra',async()=>{
  const f=fixture();const code=await f.profile();const old={...request,durationMinutes:10};
  await f.store.insertPending({id:'legacy',clientCode:code,key:'legacy-ten',startAt:old.startAt,endAt:'2026-11-03T09:10:00-05:00',request:old,response:{crmSync:null}});
  await f.store.confirm('legacy','200',{crmSync:null});
  const result=await f.service.book(code,old,'legacy-ten');
  assert.equal(result.data.duplicate,true);assert.equal(Date.parse(result.data.endAt)-Date.parse(result.data.startAt),600_000);
  await assert.rejects(f.service.book(code,old,'new-ten'),/INVALID_START/);
  assert.equal(f.events.length,0);
});
