import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHandler, profileComment } from '../src/connector.mjs';

const CONTACT = 'wa_999999999999_888888888888_573000000001';
const SECRET = 'local-test-secret-for-mock-testing-only-12345';
const START = Date.parse('2026-11-03T21:00:00Z');
const SLOTS = [
  { startAt: '2026-11-04T14:00:00Z', advisorId: 'advisor-one' },
  { startAt: '2026-11-04T14:40:00Z', advisorId: 'advisor-one' },
  { startAt: '2026-11-04T15:20:00Z', advisorId: 'advisor-one' },
  { startAt: '2026-11-04T18:00:00Z', advisorId: 'advisor-one' },
  { startAt: '2026-11-04T18:40:00Z', advisorId: 'advisor-one' },
  { startAt: '2026-11-04T19:20:00Z', advisorId: 'advisor-one' },
  { startAt: '2026-11-05T15:00:00Z', advisorId: 'advisor-two' },
  { startAt: '2026-11-05T15:40:00Z', advisorId: 'advisor-two' },
  { startAt: '2026-11-05T16:20:00Z', advisorId: 'advisor-two' },
  { startAt: '2026-11-05T19:00:00Z', advisorId: 'advisor-two' },
  { startAt: '2026-11-05T19:40:00Z', advisorId: 'advisor-two' },
  { startAt: '2026-11-05T20:20:00Z', advisorId: 'advisor-two' },
  { startAt: '2026-11-06T16:00:00Z', advisorId: 'advisor-one' },
].map(slot => ({ ...slot, endAt: new Date(Date.parse(slot.startAt) + 1_800_000).toISOString() }));

function fixture({ initial = {}, bookingError = null, invalidBooking = false,
  human = false, live = true, failLead = false, latestText = 'Sí, quiero agendar una llamada',
  naturalStatus = 'closed', botReplied = true, staleHandoffIndex = false, previousReply = '', olderMessages = [], availabilitySlots = SLOTS,
  database = null, stagePending = false, resolveError = null, availabilityErrors = [], bookingMessages = [], incomingSentTime = new Date(START).toISOString() } = {}) {
  const fields = { nombre_completo: 'Persona de Prueba', ciudad_municipio: 'Bogotá',
    obligacion_vivienda_activa: 'si',rch_banco:'Bancolombia',rch_reportes_negativos:'no',rch_puede_aumentar_cuota:'si',
    rch_plazo_inicial:'20 años',rch_tiempo_pagando:'10 años', ...initial };
  const calls = [];
  const initialSearchFields = { ...fields };
  let time = START;
  let failed = false;
  const mockFetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, payload, headers: init.headers });
    if (url.endsWith('/graphql')) {
      if (payload.query.includes('query NaturalBookingContext')) return Response.json({ data: { bot: { conversation: {
        status: naturalStatus, messages: { edges: [...(botReplied ? [{ node: { __typename: 'WhatsAppOutTextMessage', id: 'outgoing-1' } }] : []), { node: { __typename: 'WhatsAppInTextMessage', id: 'incoming-1', text: latestText,sentTime:incomingSentTime } }, ...(previousReply ? [{ node: { __typename: 'WhatsAppOutTextMessage', id: 'offer-1', text: previousReply } }] : []), ...olderMessages.map(node => ({ node }))] },
      } } } });
      if (payload.query.includes('mutation NaturalBookingFlow')) return Response.json({ data: {
        conversationFinishSendToFlow: { id: CONTACT, status: 'closed' },
      } });
      if (payload.query.includes('query HandoffCandidates')) return Response.json({ data: { bot: { contactChatsConnection: {
        edges: [{ node: { id: CONTACT, name: 'Perfil WhatsApp de prueba', phone: '573000000001',
          assignee: human === 'shared' ? null : human ? { __typename: 'PublicUserAccount', accountType: 'Human' } : { __typename: 'FuelyAIAssignee' },
          attributes: Object.entries(staleHandoffIndex ? initialSearchFields : fields).map(([name, value]) => ({ attr: { name }, value: { stringValue: String(value) } })),
        } }], pageInfo: { hasNextPage: false, endCursor: null },
      } } } });
      if (payload.query.includes('query HandoffState')) return Response.json({ data: { bot: {
        conversation: { status: live ? 'open' : 'closed' },
      } } });
      if (payload.query.includes('query BookingContact')) return Response.json({ data: { bot: { contact: {
        id: CONTACT, phone: '573000000001', attributes: Object.entries(fields).map(([name, value]) =>
          ({ attr: { name }, value: { stringValue: String(value) } })),
      },conversation:{messages:{edges:bookingMessages.map(node=>({node}))}} } } });
      const data = {};
      for (const match of payload.query.matchAll(/a(\d+):contactAttributeUpdate\(id:\$id,attrName:("(?:\\.|[^"\\])*"),attrValue:\$v\d+\)/g)) {
        fields[JSON.parse(match[2])] = payload.variables[`v${match[1]}`];
        data[`a${match[1]}`] = { id: CONTACT };
      }
      assert.ok(Object.keys(data).length, 'Mutation must update known custom attributes');
      return Response.json({ data });
    }
    if (url.endsWith('/prospecting-bot/lead')) return Response.json({ ok: !failLead, persisted: !failLead, clientId: failLead ? null : 'CLI-MOCK-ONLY' });
    if (url.endsWith('/leads/resolve')) return resolveError
      ? Response.json({ ok: false, error: { code: 'UNAUTHORIZED' } }, { status: resolveError })
      : Response.json({ ok: true, data: { clientCode: 'CLI-MOCK-ONLY', advisorAssigned: true, created: false } });
    if (url.endsWith('/availability')) {
      const failure = availabilityErrors.shift();
      if (failure === 'network') throw new TypeError('Synthetic network error');
      if (failure) return Response.json({ ok: false }, { status: failure });
      return Response.json({ ok: true, data: {
      source: 'bitrix_accessibility', slots: availabilitySlots.filter(s => !payload.excludeStarts.includes(s.startAt)),
      } });
    }
    if (url.endsWith('/appointments')) {
      if (bookingError === 'advisor-removed' && !failed) {
        failed = true;
        throw Object.assign(new Error('INVALID_ADVISOR'), { retryable: false });
      }
      if (bookingError === 'conflict' && !failed) {
        failed = true;
        return Response.json({ ok: false, error: { code: 'SLOT_UNAVAILABLE' } }, { status: 409 });
      }
      if (bookingError === 'network-once' && !failed) { failed = true; throw new Error('simulated lost response'); }
      return Response.json({ ok: true, data: { appointmentId: 'mock-booking', bitrixEventId: invalidBooking ? '' : '12345',
        ...(payload.bitrixDealId ? { crmSync: { dealId: payload.bitrixDealId, stageId: payload.bitrixStageId, status: stagePending ? 'pending' : 'completed' } } : {}),
        status: 'confirmed', startAt: payload.startAt, endAt: new Date(Date.parse(payload.startAt) + 1_800_000).toISOString() } });
    }
    if (url.endsWith('/appointments/retry-crm')) return Response.json({ ok: true, data: { results: [
      { appointmentId: payload.appointmentId, crmSync: { dealId: '777', stageId: 'C370:EXECUTING', status: 'completed' } },
    ] } });
    throw new Error(`Unexpected mocked endpoint: ${url}`);
  };
  const handle = createHandler({ env: { CHATFUEL_BOT_ID: 'mock-bot', CHATFUEL_BOOKING_SECRET: SECRET,
    CHATFUEL_API_TOKEN: 'mock-chatfuel-token', CHATFUEL_BOOKING_FLOW_ID: 'mock-flow' }, fetchImpl: mockFetch, now: () => time, database, scheduling: { request: async (path, body, key) => {
      const response = await mockFetch('local:' + path, { body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw Object.assign(new Error(
        response.status === 401 || response.status === 403 ? 'CRM_UNAUTHORIZED'
        : response.status === 409 && result.error?.code === 'SLOT_UNAVAILABLE' ? 'SLOT_UNAVAILABLE' : 'CRM_UNAVAILABLE'),
        { retryable: response.status >= 500 || response.status === 429 });
      return result;
    } } });
  const request = async (operation = 'step', answer, extras = {}) => {
    if (answer !== undefined) fields.bitrix_agenda_respuesta = answer;
    const response = await handle(new Request('https://connector.mock.invalid/booking', { method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId: CONTACT, operation, ...extras }) }));
    return { status: response.status, ...await response.json() };
  };
  const bookings = () => calls.filter(c => c.url.endsWith('/appointments'));
  return { fields, calls, request, handle, bookings, advance: ms => { time += ms; } };
}

async function prepareOptions(f) {
  await f.request('start');
  await f.request('step', 'en la mañana');
  return f.request('step', '1');
}

test('al entrar a agenda conserva la corrección real y no repite tiempos financieros',async()=>{
  const bookingMessages=[
    {__typename:'WhatsAppInTextMessage',text:'10 años ya te lo habia dicho'},
    {__typename:'WhatsAppOutTextMessage',text:'Ahora sí, ¿cuánto tiempo llevas pagando tu crédito?'},
    {__typename:'WhatsAppInTextMessage',text:'Ya te dije que 30 años'},
    {__typename:'WhatsAppOutTextMessage',text:'¿A cuántos años tomaste originalmente tu crédito?'}];
  const f=fixture({initial:{rch_plazo_inicial:'aproximadamente 28 años',rch_tiempo_pagando:'aproximadamente 6 años'},bookingMessages});
  const response=await f.request('start');
  assert.equal(f.fields.rch_plazo_inicial,'30 años');assert.equal(f.fields.rch_tiempo_pagando,'10 años');
  assert.match(response.message,/mañana o en la tarde/);assert.doesNotMatch(response.message,/tomaste|llevas pagando/);
});

test('la agenda habitual no reinicia el perfil por capturas pendientes y confirma una llamada',async()=>{
  const f=fixture({initial:{rch_plazo_inicial:'aproximadamente 28 años',rch_tiempo_pagando:'aproximadamente 6 años'}});
  const start=await f.request('start');assert.match(start.message,/mañana o en la tarde/);
  await f.request('step','mañana');await f.request('step','1');await f.request('step','1');
  const result=await f.request('step','sí');
  assert.match(result.message,/llamada quedó agendada/);assert.match(result.message,/30 minutos/);
  assert.doesNotMatch(result.message,/Zoom|PDF|titulares|Tatiana/);assert.equal(f.bookings().length,1);
});

test('aceptación enfática y petición directa de horarios recuperan el flujo una sola vez',async()=>{
  for(const text of ['Que siiiiiii','Listo dame los horarios']){
    const f=fixture({latestText:text,initial:{'last user freeform input':text},previousReply:'¿Te gustaría agendar una llamada de 30 minutos con un asesor?'});
    await f.handle.synchronizeHandoffs();await f.handle.synchronizeHandoffs();
    assert.equal(f.calls.filter(c=>c.payload.query?.includes('mutation NaturalBookingFlow')).length,1);
    assert.equal(f.bookings().length,0);
  }
});

test('una credencial rechazada tras confirmar el crédito conserva los datos sin anunciar una reserva', async () => {
  const f = fixture({ initial: { nombre_completo: '', ciudad_municipio: '', obligacion_vivienda_activa: '' }, resolveError: 401 });
  await f.request('start');
  await f.request('step', 'Persona de Prueba');
  await f.request('step', 'Bogotá');
  const response = await f.request('step', 'Sí');
  assert.equal(response.status, 200);
  assert.equal(response.error, 'BOOKING_LOOKUP_FAILED');
  assert.equal(response.cause, 'CRM_UNAUTHORIZED');
  assert.match(response.message, /no se ha solicitado/);
  assert.equal(f.fields.ciudad_municipio, 'Bogotá');
  assert.equal(f.fields.obligacion_vivienda_activa, 'si');
  assert.equal(f.bookings().length, 0);
  assert.notEqual(f.fields.bitrix_reserva_pendiente, 'si');
  assert.equal(f.calls.filter(c => c.url.endsWith('/leads/resolve')).length, 1);
});

test('las consultas de horarios toleran dos fallos temporales sin duplicar reservas', async () => {
  const f = fixture({ availabilityErrors: [503, 'network'] });
  await f.request('start');
  const response = await f.request('step', 'en la mañana');
  assert.equal(response.error, undefined);
  assert.match(response.message, /Qué día/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/availability')).length, 3);
  assert.equal(f.bookings().length, 0);
});

test('los fallos persistentes de consulta terminan con un mensaje recuperable y sin reservar', async () => {
  const f = fixture({ availabilityErrors: [503, 503, 503, 503] });
  await f.request('start');
  const response = await f.request('step', 'en la mañana');
  assert.equal(response.error, 'BOOKING_LOOKUP_FAILED');
  assert.equal(f.calls.filter(c => c.url.endsWith('/availability')).length, 3);
  assert.equal(f.bookings().length, 0);
  assert.notEqual(f.fields.bitrix_reserva_pendiente, 'si');
});

test('un perfil rechazado no repite comentarios ni anuncia una reserva pendiente', async () => {
  const f = fixture({ failLead: true });
  const response = await f.request('start');
  assert.equal(response.error, 'BOOKING_LOOKUP_FAILED');
  assert.equal(f.calls.filter(c => c.url.endsWith('/prospecting-bot/lead')).length, 1);
  assert.equal(f.bookings().length, 0);
});

test('un horario rechazado no queda como reserva incierta si falla la siguiente consulta', async () => {
  const failures = [];
  const f = fixture({ bookingError: 'conflict', availabilityErrors: failures });
  await prepareOptions(f);
  await f.request('step', '1');
  failures.push(503, 503, 503);
  const response = await f.request('step', 'sí');
  assert.equal(response.error, 'BOOKING_LOOKUP_FAILED');
  assert.equal(f.fields.bitrix_reserva_pendiente, 'no');
  assert.equal(f.bookings().length, 1);
});

test('busca MySQL antes de reservar y envía negociación y etapa exactas', async () => {
  let lookups = 0;
  const f = fixture({ database: { async findClienteByPhone(phone) {
    assert.equal(phone, '573000000001');
    assert.equal(f.bookings().length, 0);
    lookups++;
    return { id_negociacion: '777' };
  } } });
  await prepareOptions(f);
  await f.request('step', '1');
  assert.equal(lookups, 0);
  const response = await f.request('step', 'sí');
  assert.match(response.message, /quedó agendada/);
  assert.equal(lookups, 1);
  assert.equal(f.bookings()[0].payload.bitrixDealId, '777');
  assert.equal(f.bookings()[0].payload.bitrixStageId, 'C370:EXECUTING');
  assert.equal(f.fields.bitrix_negociacion_sync, 'completado');
  await f.request('step', 'sí');
  assert.equal(f.bookings().length, 1);
  assert.equal(lookups, 1);
});

test('un cliente ausente en MySQL conserva el contrato anterior', async () => {
  const f = fixture({ database: { findClienteByPhone: async () => null } });
  await prepareOptions(f);
  await f.request('step', '1');
  assert.match((await f.request('step', 'sí')).message, /quedó agendada/);
  assert.equal('bitrixDealId' in f.bookings()[0].payload, false);
  assert.equal('bitrixStageId' in f.bookings()[0].payload, false);
  assert.equal(f.fields.bitrix_negociacion_sync, 'no_aplica');
});

test('error de MySQL o teléfono ambiguo no crean citas ni marcan reserva pendiente', async () => {
  for (const code of ['DB_DOWN', 'TELEFONO_AMBIGUO']) {
    const f = fixture({ database: { findClienteByPhone: async () => { throw Object.assign(new Error(), { code }); } } });
    await prepareOptions(f);
    await f.request('step', '1');
    const response = await f.request('step', 'sí');
    assert.equal(response.human, code === 'TELEFONO_AMBIGUO' ? 'si' : 'no');
    assert.equal(f.bookings().length, 0);
    assert.notEqual(f.fields.bitrix_reserva_pendiente, 'si');
  }
});

test('un reintento con respuesta perdida congela el vínculo incluso si no existía', async () => {
  for (const original of [null, '777']) {
    let lookups = 0;
    const f = fixture({ bookingError: 'network-once', database: { findClienteByPhone: async () => {
      lookups++;
      return original ? { id_negociacion: original } : null;
    } } });
    await prepareOptions(f);
    await f.request('step', '1');
    await f.request('step', 'sí');
    await f.request('step', 'sí');
    assert.equal(lookups, 1);
    assert.deepEqual(f.bookings()[0].payload, f.bookings()[1].payload);
    assert.equal(f.fields.bitrix_reserva_pendiente, 'no');
  }
});

test('etapa pendiente conserva cita confirmada y solo reintenta CRM de esa cita', async () => {
  const f = fixture({ stagePending: true, database: { findClienteByPhone: async () => ({ id_negociacion: '777' }) } });
  await prepareOptions(f);
  await f.request('step', '1');
  assert.match((await f.request('step', 'sí')).message, /quedó agendada/);
  assert.equal(f.fields.bitrix_negociacion_sync, 'pendiente');
  assert.equal(f.fields.bitrix_reserva_pendiente, 'no');
  await f.request('step', 'sí');
  assert.equal(f.bookings().length, 1);
  assert.equal(f.fields.bitrix_negociacion_sync, 'completado');
  assert.deepEqual(f.calls.find(call => call.url.endsWith('/retry-crm')).payload, { appointmentId: 'mock-booking' });
});

test('unauthorized and preview requests create no CRM records', async () => {
  const f = fixture();
  const response = await f.handle(new Request('https://connector.mock.invalid/booking', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 401);
  assert.equal((await f.request('start', undefined, { contactId: 'cfPreview:mock' })).status, 200);
  assert.equal((await f.request('start', undefined, { contactId: 'wa_cfPreview:mock' })).status, 200);
  assert.equal(f.calls.length, 0);
});

test('missing profile is collected before creating a negotiation', async () => {
  const f = fixture({ initial: { nombre_completo: '', ciudad_municipio: '', obligacion_vivienda_activa: '' } });
  assert.match((await f.request('start')).message, /nombre completo/);
  assert.match((await f.request('step', 'Persona de Prueba')).message, /ciudad/);
  assert.match((await f.request('step', 'Bogotá')).message, /actualmente/i);
  assert.equal(f.calls.filter(c => c.url.includes('crm.mock')).length, 0);
  assert.match((await f.request('step', 'sí')).message, /mañana o en la tarde/);
  assert.equal(f.fields.crm_30x_codigo, 'CLI-MOCK-ONLY');
  assert.equal(f.bookings().length, 0);
});

test('selection alone never reserves; explicit confirmation does; repeated requests are idempotent', async () => {
  const f = fixture();
  await prepareOptions(f);
  assert.equal(f.bookings().length, 0);
  assert.match((await f.request('step', '1')).message, /Confirmas/);
  assert.equal(f.bookings().length, 0);
  assert.match((await f.request('step', 'quizás')).message, /Confirmas/);
  const booked = await f.request('step', 'SÍ');
  assert.equal(booked.done, 'si');
  assert.match(booked.message, /quedó agendada/);
  assert.match(booked.message, /Duración: 30 minutos/);
  assert.equal(f.bookings()[0].payload.durationMinutes, 30);
  assert.equal(f.fields.bitrix_evento_id, '12345');
  assert.equal(f.fields.bitrix_reserva_pendiente, 'no');
  await f.request('step', 'SÍ');
  await f.request('start');
  assert.equal(f.bookings().length, 1);
  assert.equal(f.bookings()[0].headers['Idempotency-Key'], f.bookings()[0].payload.idempotencyKey);
});

test('cancel and negative active-credit answer never book', async () => {
  const f = fixture({ initial: { obligacion_vivienda_activa: '' } });
  await f.request('start');
  assert.equal((await f.request('step', 'NO')).done, 'si');
  assert.equal(f.bookings().length, 0);
  assert.equal(f.calls.filter(c => c.url.includes('crm.mock')).length, 0);
  assert.equal(f.fields.obligacion_vivienda_activa, 'no');
});

test('tampered and expired selections cannot book', async () => {
  for (const mode of ['tampered', 'expired']) {
    const f = fixture();
    await prepareOptions(f);
    if (mode === 'tampered') f.fields.bitrix_agenda_estado = `${f.fields.bitrix_agenda_estado}x`;
    else f.advance(31 * 60_000);
    const resumed = await f.request('step','1');
    assert.doesNotMatch(resumed.message,/venció/);
    assert.equal(resumed.error,undefined);
    assert.equal(f.bookings().length, 0);
  }
});

test('una franja respondida después de treinta minutos retoma con disponibilidad nueva',async()=>{
  const f=fixture();
  await f.request('start');
  f.advance(2*60*60_000);
  const response=await f.request('step','Tarde');
  assert.equal(response.error,undefined);
  assert.match(response.message,/Qué día/);
  assert.doesNotMatch(response.message,/venció|no se ha confirmado/);
  assert.equal(f.bookings().length,0);
});

test('lost booking response retries the same reservation with the same idempotency key', async () => {
  const f = fixture({ bookingError: 'network-once' });
  await prepareOptions(f); await f.request('step', '1');
  assert.equal((await f.request('step', 'SÍ')).error, 'BOOKING_CHECK_REQUIRED');
  assert.equal(f.fields.bitrix_reserva_pendiente, 'si');
  const result = await f.request('start');
  assert.match(result.message, /quedó agendada/);
  assert.equal(f.bookings().length, 2);
  assert.equal(f.bookings()[0].payload.idempotencyKey, f.bookings()[1].payload.idempotencyKey);
});

test('missing actual Bitrix event id never yields a confirmed message', async () => {
  const f = fixture({ invalidBooking: true });
  await prepareOptions(f); await f.request('step', '1');
  const result = await f.request('step', 'SÍ');
  assert.equal(result.error, 'BOOKING_CHECK_REQUIRED');
  assert.doesNotMatch(result.message, /quedó agendada/);
  assert.equal(f.fields.bitrix_reserva_pendiente, 'si');
});

test('conflicting slot refreshes real availability and requires a new selection', async () => {
  const f = fixture({ bookingError: 'conflict' });
  await prepareOptions(f); await f.request('step', '1');
  const result = await f.request('step', 'SÍ');
  assert.equal(result.done, 'no');
  assert.match(result.message, /horarios/);
  assert.equal(f.fields.bitrix_reserva_pendiente, 'no');
  assert.equal(f.bookings().length, 1);
});

test('un asesor retirado actualiza las opciones sin reservar ni dejar una reserva incierta',async()=>{
  const availabilitySlots=SLOTS.map(slot=>({...slot}));
  const f=fixture({availabilitySlots,bookingError:'advisor-removed'});
  await prepareOptions(f);await f.request('step','1');
  for(const slot of availabilitySlots)slot.advisorId='tatiana';
  const response=await f.request('step','sí');
  assert.equal(response.error,undefined);assert.match(response.message,/horarios libres/);
  assert.equal(f.fields.bitrix_reserva_pendiente,'no');
  const state=JSON.parse(Buffer.from(response.state.split('.')[0],'base64url'));
  assert.ok(state.slots.length);assert.ok(state.slots.every(slot=>slot.advisorId==='tatiana'));
  assert.equal(f.bookings().length,1);
  await f.request('step','1');assert.equal(f.bookings().length,1);
  assert.match((await f.request('step','sí')).message,/quedó agendada/);
  assert.equal(f.bookings().at(-1).payload.advisorId,'tatiana');
});

test('human handoff creates a negotiation once and updates the same code when the profile changes', async () => {
  const f = fixture({ human: true, initial: { senal_reducir_plazo: 'sí, quiere terminar antes' } });
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 1);
  assert.equal(f.fields.crm_30x_codigo, 'CLI-MOCK-ONLY');
  assert.equal(f.fields.crm_30x_handoff_estado, 'registrado');
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
  f.fields.banco_entidad = 'Entidad de prueba';
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 1);
  const leads = f.calls.filter(c => c.url.endsWith('/prospecting-bot/lead'));
  assert.equal(leads.length, 2);
  assert.equal(leads[1].payload.externalLeadId, 'CLI-MOCK-ONLY');
  assert.equal(leads[1].payload.status, 'requiere_asesor');
  assert.equal(leads[1].payload.answers.solicitudAsesor, true);
  assert.equal(leads[1].payload.answers.senal_reducir_plazo, 'sí, quiere terminar antes');
  assert.equal(f.bookings().length, 0);
});

test('automated and closed conversations do not create handoff negotiations', async () => {
  for (const options of [{ human: false }, { human: true, live: false }, { human: 'shared', live: false }]) {
    const f = fixture(options);
    assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
    assert.equal(f.calls.filter(c => c.url.includes('crm.mock')).length, 0);
  }
});

test('human handoff accepts an incomplete profile without inventing credit status or a score', async () => {
  const f = fixture({ human: true, initial: { nombre_completo: '', ciudad_municipio: '', obligacion_vivienda_activa: '' } });
  await f.handle.synchronizeHandoffs();
  const lead = f.calls.find(c => c.url.endsWith('/prospecting-bot/lead')).payload;
  assert.equal(lead.answers.nombreConfirmado, false);
  assert.equal(lead.answers.tieneCreditoHipotecario, null);
  assert.equal(lead.score, undefined);
  assert.equal(lead.city, undefined);
  assert.equal(lead.contactName, 'Perfil WhatsApp de prueba');
});

test('new Chatfuel answers produce an advisor comment and reach the existing 30X negotiation', async () => {
  const f = fixture({ human: 'shared', initial: { rch_banco: 'Bancolombia', rch_frech: 'si',
    rch_saldo_millones: '80', rch_saldo_evidencia: 'me faltan 80 millones',
    rch_anos_pagando: '2', rch_cuotas_atrasadas: '0', banco_entidad: 'Dato anterior' } });
  await f.handle.synchronizeHandoffs();
  const lead = f.calls.find(c => c.url.endsWith('/prospecting-bot/lead')).payload;
  assert.match(lead.summary, /Chatfuel conversó con Persona de Prueba, de Bogotá/);
  assert.match(lead.summary, /Entidad del crédito: Bancolombia/);
  assert.match(lead.summary, /tener cobertura de tasa Mi Casa Ya o FRECH/);
  assert.match(lead.summary, /80\.000\.000/);
  assert.match(lead.summary, /Tiempo que lleva pagando, en años: 2/);
  assert.match(lead.summary, /cero cuotas vencidas/);
  assert.match(lead.summary, /transferencia al equipo humano/);
  assert.doesNotMatch(lead.summary, /Datos pendientes:/);
  assert.equal(lead.answers.banco, 'Bancolombia');
  assert.equal(lead.answers.rch_saldo_millones, '80');
  assert.equal(lead.answers.rch_cuotas_atrasadas, '0');
  assert.equal(lead.score, undefined);
  assert.equal(lead.temperature, undefined);
});

test('profile comments distinguish missing facts and display names from confirmed customer data', () => {
  const comment = profileComment({ rch_banco: 'FNA', rch_saldo_millones: 'PENDIENTE',
    rch_saldo_evidencia: 'debo como 50', rch_frech: 'desconocido', rch_anos_pagando: 'no sabe' },
  { handoff: true, displayName: 'Nombre del perfil' });
  assert.match(comment, /contacto de WhatsApp: Nombre del perfil/);
  assert.match(comment, /nombre completo confirmado/);
  assert.match(comment, /«debo como 50»/);
  assert.match(comment, /saldo pendiente en dinero por confirmar/);
  assert.doesNotMatch(comment, /50\.000\.000|clasifica al cliente|no tener cobertura|Chatfuel conversó con Nombre del perfil/);
});

test('feedback organiza hechos, señales y acciones sin inventar objeciones ni resultados', () => {
  const summary = profileComment({nombre_completo:'Persona de prueba', obligacion_vivienda_activa:'sí',
    rch_cuotas_atrasadas:'2', rch_frech:'sí', senal_consulta_honorarios:'sí', senal_reducir_plazo:'sí',
    senal_deuda_aumenta:'no', modalidad_pesos_uvr:'UVR', anos_restantes:'12'}, {handoff:true});
  assert.match(summary,/DATOS RECOPILADOS\n• /);
  assert.match(summary,/\n\nANÁLISIS PARA EL ASESOR\n/);
  assert.match(summary,/Modalidad del crédito: UVR/);
  assert.match(summary,/Hay cuotas vencidas declaradas/);
  assert.match(summary,/Explicar los honorarios/);
  assert.match(summary,/Validar las condiciones y vigencia de la cobertura/);
  assert.match(summary,/sin prometer resultados/);
  assert.match(summary,/No se dispone de un registro específico de objeciones/);
  assert.doesNotMatch(summary,/Preocupación registrada por el aumento|cliente aprobado|cita confirmada/i);
  const missing = profileComment({});
  assert.match(missing,/Confirmar si existe una obligación/);
  assert.doesNotMatch(missing,/Hay cuotas vencidas declaradas|Declara no tener cobertura|Existe una obligación de vivienda activa declarada/);
});

test('zero balance, zero elapsed years and explicit no coverage are preserved without inference', async () => {
  const f = fixture({ human: true, initial: { rch_banco: 'FNA', rch_frech: false,
    rch_saldo_millones: 0, rch_anos_pagando: 0, rch_cuotas_atrasadas: 0 } });
  await f.handle.synchronizeHandoffs();
  const lead = f.calls.find(c => c.url.endsWith('/prospecting-bot/lead')).payload;
  assert.match(lead.summary, /Declara no tener cobertura/);
  assert.match(lead.summary, /Saldo pendiente de dinero declarado:.*0.*COP/);
  assert.match(lead.summary, /Tiempo que lleva pagando, en años: 0/);
  assert.match(lead.summary, /cero cuotas vencidas/);
  assert.equal(lead.answers.rch_saldo_millones, '0');
  assert.equal(lead.answers.rch_frech, 'false');
});

test('a changed new questionnaire answer refreshes the same lead once without duplicate comments', async () => {
  const f = fixture({ human: true, initial: { rch_banco: 'Davivienda', rch_saldo_millones: '80' } });
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 1);
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
  f.fields.rch_saldo_millones = '50,5';
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 1);
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
  const leads = f.calls.filter(c => c.url.endsWith('/prospecting-bot/lead'));
  assert.equal(leads.length, 2);
  assert.equal(leads[1].payload.externalLeadId, leads[0].payload.externalLeadId);
  assert.match(leads[1].payload.summary, /50\.500\.000/);
});

test('stale contact search and legacy deployment fingerprints do not duplicate profile comments', async () => {
  const f = fixture({ human: true, staleHandoffIndex: true,
    initial: { rch_banco: 'Bancolombia', crm_30x_handoff_hash: 'legacy-deployment-hash' } });
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 1);
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prospecting-bot/lead')).length, 1);
  assert.equal(f.fields.crm_30x_handoff_hash, 'legacy-deployment-hash');
  assert.ok(f.fields.crm_30x_profile_comment_hash);
});

test('booking profile uses legacy facts as fallback and keeps reservation unconfirmed', async () => {
  const f = fixture({ initial: { rch_banco:'',banco_entidad: 'Caja Social', anos_pagados: 'entre 2 y 3', estado_pago: 'al día' } });
  await f.request('start');
  const lead = f.calls.find(c => c.url.endsWith('/prospecting-bot/lead')).payload;
  assert.match(lead.summary, /Entidad del crédito: Caja Social/);
  assert.match(lead.summary, /años: entre 2 y 3/);
  assert.match(lead.summary, /pendiente de confirmación técnica en Bitrix/);
  assert.doesNotMatch(lead.summary, /Datos pendientes: cobertura de tasa Mi Casa Ya o FRECH; saldo pendiente en dinero/);
  assert.match(lead.summary,/Filtro comercial inicial.*APLICA/);
  assert.doesNotMatch(lead.summary, /número de cuotas vencidas sin pagar/);
  assert.equal(f.bookings().length, 0);
});

test('a rejected CRM write does not mark handoff synchronization as complete', async () => {
  const f = fixture({ human: true, failLead: true });
  await assert.rejects(f.handle.synchronizeHandoffs());
  assert.equal(f.fields.crm_30x_handoff_hash, undefined);
  assert.equal(f.fields.crm_30x_handoff_estado, undefined);
  assert.equal(f.handle.handoffStatus.lastError, 'HANDOFF_SYNC_FAILED');
});

test('handoff to an unassigned shared inbox creates the negotiation once', async () => {
  const f = fixture({ human: 'shared' });
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 1);
  assert.equal(f.fields.crm_30x_codigo, 'CLI-MOCK-ONLY');
  assert.equal(f.fields.crm_30x_handoff_estado, 'registrado');
  assert.equal((await f.handle.synchronizeHandoffs()).synchronized, 0);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prospecting-bot/lead')).length, 1);
});

test('booking asks for a period, offers two verified days, then three times in that period', async () => {
  const f = fixture();
  const period = await f.request('start');
  assert.match(period.message, /mañana o en la tarde/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/availability')).length, 0);
  const days = await f.request('step', 'en la tarde');
  assert.match(days.message, /Qué día prefieres/);
  assert.equal(JSON.parse(Buffer.from(days.state.split('.')[0], 'base64url')).days.length, 2);
  const times = await f.request('step', 'mañana');
  const state = JSON.parse(Buffer.from(times.state.split('.')[0], 'base64url'));
  assert.equal(state.date, '2026-11-04');
  assert.equal(state.slots.length, 3);
  assert.equal(state.fromTime, '12:00');
  assert.ok(state.slots.every(s => Date.parse(s.startAt) >= Date.parse('2026-11-04T17:00:00Z')));
  assert.doesNotMatch(period.message + days.message + times.message, /AGENDAR/);
  assert.equal(f.bookings().length, 0);
});

test('weekday, ordinal selection and natural confirmation reserve only the selected time', async () => {
  const f = fixture();
  await f.request('start');
  await f.request('step', 'en la mañana');
  await f.request('step', 'jueves por la tarde');
  assert.match((await f.request('step', 'la primera')).message, /Confirmas/);
  assert.equal(f.bookings().length, 0);
  assert.match((await f.request('step', 'dale')).message, /quedó agendada/);
  assert.equal(f.bookings()[0].payload.startAt, '2026-11-05T19:00:00Z');
});

test('the user can ask for another day or period without restarting the profile', async () => {
  const f = fixture();
  await prepareOptions(f);
  assert.match((await f.request('step', 'otra franja')).message, /mañana o en la tarde/);
  const times = await f.request('step', 'en la tarde');
  assert.match(times.message, /horarios libres/);
  const state = JSON.parse(Buffer.from(times.state.split('.')[0], 'base64url'));
  assert.equal(state.date, '2026-11-04');
  assert.equal(state.fromTime, '12:00');
  assert.match((await f.request('step', 'otro día')).message, /Qué día prefieres/);
  assert.equal(f.calls.filter(c => c.url.endsWith('/prospecting-bot/lead')).length, 1);
});

test('questions and negated mentions of a time do not select or book it', async () => {
  const f = fixture();
  await prepareOptions(f);
  for (const answer of ['no quiero la primera', '¿la primera?', 'si puedo, la primera']) {
    const response = await f.request('step', answer);
    assert.match(response.message, /Cuál de los horarios/);
  }
  assert.equal(f.bookings().length, 0);
  assert.match((await f.request('step', '9 am')).message, /Confirmas/);
  assert.equal(f.bookings().length, 0);
});

test('asking for a person during booking exits toward human attention without reserving', async () => {
  const f = fixture();
  await prepareOptions(f);
  const response = await f.request('step', 'quiero hablar con un asesor');
  assert.equal(response.done, 'si');
  assert.equal(response.human, 'si');
  assert.equal(f.bookings().length, 0);
});

test('new CRM negotiations resolve through the enabled advisor rotation before profile upsert', async () => {
  const f = fixture({ human: 'shared' });
  await f.handle.synchronizeHandoffs();
  const crmCalls = f.calls.filter(c => c.url.startsWith('local:'));
  assert.ok(crmCalls[0].url.endsWith('/leads/resolve'));
  assert.equal(crmCalls[1].payload.externalLeadId, 'CLI-MOCK-ONLY');
});

test('accepting the offered call opens the booking flow once without a keyword', async () => {
  const f = fixture({ initial: { solicitud_agendamiento: 'si', texto_solicitud_agendamiento: 'Sí, quiero agendar una llamada' } });
  await f.handle.synchronizeHandoffs();
  const routes = () => f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow'));
  assert.equal(routes().length, 1);
  assert.equal(f.handle.handoffStatus.bookingFlowsStarted, 1);
  assert.ok(f.fields.crm_30x_booking_intent_hash);
  await f.handle.synchronizeHandoffs();
  assert.equal(routes().length, 1);
  assert.equal(f.bookings().length, 0);
});

test('stale or declined booking intent never routes an unrelated reply', async () => {
  for (const latestText of ['¿Cuánto cuesta el servicio?', 'no']) {
    const f = fixture({ initial: { solicitud_agendamiento: 'si', texto_solicitud_agendamiento: 'sí' }, latestText });
    await f.handle.synchronizeHandoffs();
    assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
  }
});

test('la búsqueda atrasada no reinicia la agenda para el mismo mensaje', async () => {
  const f = fixture({ staleHandoffIndex: true, initial: {
    solicitud_agendamiento: 'si', texto_solicitud_agendamiento: 'Sí, quiero agendar una llamada',
  } });
  await f.handle.synchronizeHandoffs();
  await f.handle.synchronizeHandoffs();
  const routes = f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow'));
  assert.equal(routes.length, 1);
  assert.equal(f.bookings().length, 0);
});

test('the observer leaves an active booking conversation in its current step', async () => {
  const f = fixture({ initial: { solicitud_agendamiento: 'si', texto_solicitud_agendamiento: 'Sí, quiero agendar una llamada' } });
  await prepareOptions(f);
  await f.handle.synchronizeHandoffs();
  assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
});

test('deferring the call stops the dialogue without reserving or demanding a keyword', async () => {
  const f = fixture();
  await prepareOptions(f);
  const result = await f.request('step', 'por ahora no');
  assert.equal(result.done, 'si');
  assert.doesNotMatch(result.message, /AGENDAR/);
  assert.equal(f.bookings().length, 0);
});

test('a direct natural request works without depending on a captured keyword', async () => {
  const text = 'Quisiera agendar una llamada para revisar mi crédito';
  const f = fixture({ initial: { 'last user freeform input': text }, latestText: text });
  await f.handle.synchronizeHandoffs();
  assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 1);
  assert.equal(f.bookings().length, 0);
});

test('solicitudes coloquiales y preguntas de capacidad abren la agenda aunque la captura esté pendiente',async()=>{
  for(const latestText of ['Pero agendame no?','Bueno tengo tiempo en la mañana, tienes la capacidad de agendarme?',
    '¿Tienes la posibilidad de agendarme?','Hoy no tengo tiempo, pero quiero agendar mañana']){
    const f=fixture({latestText,initial:{'last user freeform input':latestText,solicitud_agendamiento:'PENDIENTE'}});
    await f.handle.synchronizeHandoffs();await f.handle.synchronizeHandoffs();
    assert.equal(f.calls.filter(c=>c.payload.query?.includes('mutation NaturalBookingFlow')).length,1,latestText);
    assert.equal(f.bookings().length,0);
  }
});

test('una jornada tras la oferta abre opciones; una negativa, dato financiero o mensaje antiguo no las abre',async()=>{
  const offer='¿Te gustaría agendar una asesoría virtual de 30 minutos con un asesor?';
  const latestText='Ehhhh pero hoy no tengo tiempo, bueno si tengo tiempo pero en la noche';
  const f=fixture({latestText,previousReply:offer,initial:{'last user freeform input':latestText}});
  await f.handle.synchronizeHandoffs();assert.equal(f.calls.filter(c=>c.payload.query?.includes('mutation NaturalBookingFlow')).length,1);
  for(const [text,previousReply,incomingSentTime]of [['No quiero agendar',offer],['No me agendes',offer],['No puedo en la mañana',offer],
    ['en la noche','¿Puedes aumentar tu cuota?'],['Pero agendame no?',offer,new Date(START-6*60_000).toISOString()]]){
    const blocked=fixture({latestText:text,previousReply,...(incomingSentTime?{incomingSentTime}:{}),initial:{'last user freeform input':text}});
    await blocked.handle.synchronizeHandoffs();assert.equal(blocked.calls.filter(c=>c.payload.query?.includes('mutation NaturalBookingFlow')).length,0,text);
  }
});

test('pedir noche explica el horario y permite continuar en la mañana sin reservar',async()=>{
  const f=fixture();await f.request('start');
  const response=await f.request('step','en la noche');
  assert.match(response.message,/8:30/);assert.match(response.message,/5:00/);assert.match(response.message,/No tenemos horarios nocturnos/);
  assert.doesNotMatch(response.message,/no est[aá] disponible|Booking through/);
  assert.equal(f.bookings().length,0);assert.equal(JSON.parse(Buffer.from(response.state.split('.')[0],'base64url')).step,'period');
  assert.match((await f.request('step','en la mañana')).message,/Qué día/);
});

test('aceptar una asesoría virtual activa el flujo una vez sin reservar',async()=>{
  const f=fixture({latestText:'sí',initial:{'last user freeform input':'sí'},previousReply:'¿Te gustaría agendar tu asesoría virtual de 30 minutos con Tatiana Chilito?'});
  await f.handle.synchronizeHandoffs();
  assert.equal(f.calls.filter(c=>c.payload.query?.includes('mutation NaturalBookingFlow')).length,1);
  assert.equal(f.bookings().length,0);
});

test('un caso excluido no consulta horarios ni crea citas',async()=>{
  for(const initial of [{rch_banco:'BBVA'},{rch_reportes_negativos:'si'},{rch_puede_aumentar_cuota:'no'},
    {rch_tiempo_pagando:'15 años'}]){
    const f=fixture({initial});const response=await f.request('start');
    assert.equal(response.done,'si');assert.equal(f.bookings().length,0);
    assert.equal(f.calls.filter(c=>c.url.endsWith('/availability')).length,0);
    assert.ok(['PENDIENTE','NO_APLICA'].includes(f.fields.rch_estado_elegibilidad));
  }
});

test('natural routing waits for the assistant reply before starting the calendar dialogue', async () => {
  const text = 'Quiero agendar una llamada';
  const f = fixture({ initial: { 'last user freeform input': text }, latestText: text, botReplied: false });
  await f.handle.synchronizeHandoffs();
  assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
});


test('a yes to the actual call offer routes once when AI intent extraction stays pending', async () => {
  const f = fixture({ initial: { 'last user freeform input': 'si', solicitud_agendamiento: 'PENDIENTE', texto_solicitud_agendamiento: 'PENDIENTE' }, latestText: 'si',
    previousReply: 'Gracias. Resumen del caso. ¿Está correcto y quiere que organicemos una llamada con un asesor?' });
  await f.handle.synchronizeHandoffs();
  await f.handle.synchronizeHandoffs();
  assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 1);
  assert.equal(f.bookings().length, 0);
});

test('a yes to profile data never starts booking even if AI attributes incorrectly say yes', async () => {
  for (const previousReply of ['¿Tiene un crédito activo?', '¿Su nombre está correcto?', '¿Estos datos están correctos?', '¿Tiene cobertura Mi Casa Ya?']) {
    const f = fixture({ initial: { 'last user freeform input': 'si', solicitud_agendamiento: 'SI', texto_solicitud_agendamiento: 'si' }, latestText: 'si', previousReply });
    await f.handle.synchronizeHandoffs();
    assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
    assert.equal(f.bookings().length, 0);
  }
});

test('an older call offer cannot authorize a yes to a newer unrelated question', async () => {
  const f = fixture({ initial: { 'last user freeform input': 'si' }, latestText: 'si', previousReply: '¿Su banco es BBVA?',
    olderMessages: [{ __typename: 'WhatsAppOutTextMessage', id: 'older-offer', text: '¿Quiere que organicemos una llamada con un asesor?' }] });
  await f.handle.synchronizeHandoffs();
  assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
});

test('declined or conditional answers to a call offer cannot start the booking flow', async () => {
  for (const latestText of ['no', 'por ahora no', 'si puedo', 'tal vez']) {
    const f = fixture({ initial: { 'last user freeform input': latestText }, latestText, previousReply: '¿Quiere que organicemos una llamada con un asesor?' });
    await f.handle.synchronizeHandoffs();
    assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
    assert.equal(f.bookings().length, 0);
  }
});

test('contextual consent still waits for the current assistant reply and leaves live chats alone', async () => {
  for (const config of [{ botReplied: false }, { naturalStatus: 'open' }]) {
    const f = fixture({ initial: { 'last user freeform input': 'si' }, latestText: 'si', previousReply: '¿Quiere que organicemos una llamada con un asesor?', ...config });
    await f.handle.synchronizeHandoffs();
    assert.equal(f.calls.filter(c => c.payload.query?.includes('mutation NaturalBookingFlow')).length, 0);
  }
});


function localFreeSlot(time, advisorId = 'advisor-one') {
  const startAt = `2026-11-04T${time}:00-05:00`;
  return { startAt, endAt: new Date(Date.parse(startAt) + 1_800_000).toISOString(), advisorId };
}

test('la agenda reparte las opciones entre el inicio, la mitad y el final de la franja libre', async () => {
  const availabilitySlots = Array.from({ length: 21 }, (_, index) => {
    const minutes = 8 * 60 + 30 + index * 10;
    return localFreeSlot(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  });
  const f = fixture({ availabilitySlots });
  const response = await prepareOptions(f);
  const slots = JSON.parse(Buffer.from(response.state.split('.')[0], 'base64url')).slots;
  assert.deepEqual(slots.map(slot => slot.startAt), ['08:30', '10:00', '11:30'].map(time => localFreeSlot(time).startAt));
  assert.equal(f.bookings().length, 0);
});

test('solo ofrece huecos realmente libres y no duplica horas de distintos asesores', async () => {
  const availabilitySlots = ['08:30', '08:40', '10:40', '11:20'].map(time => localFreeSlot(time));
  availabilitySlots.push(localFreeSlot('10:40', 'advisor-two'));
  const f = fixture({ availabilitySlots });
  const response = await prepareOptions(f);
  const slots = JSON.parse(Buffer.from(response.state.split('.')[0], 'base64url')).slots;
  assert.deepEqual(slots.map(slot => slot.startAt), ['08:30', '10:40', '11:20'].map(time => localFreeSlot(time).startAt));
  assert.ok(slots.every(slot => availabilitySlots.some(free => free.startAt === slot.startAt && free.advisorId === slot.advisorId)));
  assert.equal(new Set(slots.map(slot => Date.parse(slot.startAt))).size, slots.length);
  assert.equal(f.bookings().length, 0);
});

test('con pocos huecos devuelve menos opciones antes que horas consecutivas', async () => {
  for (const [times, expected] of [[['08:30', '09:00', '09:30'], ['08:30', '09:30']], [['08:30', '09:00'], ['08:30']]]) {
    const f = fixture({ availabilitySlots: times.map(time => localFreeSlot(time)) });
    const response = await prepareOptions(f);
    const slots = JSON.parse(Buffer.from(response.state.split('.')[0], 'base64url')).slots;
    assert.deepEqual(slots.map(slot => slot.startAt), expected.map(time => localFreeSlot(time).startAt));
    assert.equal(f.bookings().length, 0);
  }
});

test('una opción antigua de diez minutos exige horarios y confirmación nuevos', async()=>{
  for(const step of ['choose','confirm']){
    const f=fixture();await prepareOptions(f);
    if(step==='confirm')await f.request('step','1');
    const state=JSON.parse(Buffer.from(f.fields.bitrix_agenda_estado.split('.')[0],'base64url'));
    for(const slot of [...state.slots,...(state.slot?[state.slot]:[])])slot.endAt=new Date(Date.parse(slot.startAt)+600_000).toISOString();
    const payload=Buffer.from(JSON.stringify(state)).toString('base64url');
    f.fields.bitrix_agenda_estado=payload+'.'+createHmac('sha256',SECRET).update(payload).digest('base64url');
    const refreshed=await f.request('step',step==='confirm'?'sí':'1');
    assert.match(refreshed.message,/30 minutos/);assert.equal(f.bookings().length,0);
    const current=JSON.parse(Buffer.from(refreshed.state.split('.')[0],'base64url'));
    assert.ok(current.slots.every(s=>Date.parse(s.endAt)-Date.parse(s.startAt)===1_800_000));
    await f.request('step','1');assert.equal(f.bookings().length,0);
    assert.match((await f.request('step','sí')).message,/Duración: 30 minutos/);
  }
});
