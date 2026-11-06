import { createHash, randomUUID } from 'node:crypto';
import { validId } from '../bitrix.js';
import { phoneVariants } from '../phone.js';
import { bogotaToday, candidateDates, parseBitrixDate, weekdayForDate } from './appointmentAvailability.js';
import { calculateAdvisorDateSlots } from './appointmentAdvisorAvailability.js';
import { requireBitrixEventId } from './appointmentBooking.js';
import { confirmedCalendarOwner } from './confirmedEvent.js';
import { DEAL_SUMMARY_FIELD, timelineSummary } from './profileSummary.js';
import { APPOINTMENT_DURATION_MINUTES } from './policy.js';
import { evaluateRchEligibility } from './rchEligibility.js';

export const APPOINTMENT_STAGE = 'C370:EXECUTING';
export const APPOINTMENT_DATE_FIELD = 'UF_CRM_1726241234';
const dateValue = value => value == null || value === '' || value === false ? null : Date.parse(value);
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const dateOf = value => bogotaToday(new Date(value));
const sqlDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;

export function readAdvisors(env) {
  let advisors;
  try { advisors = JSON.parse(env.APPOINTMENT_ADVISORS_JSON || '[]'); } catch { fail('INVALID_ADVISORS'); }
  if (!Array.isArray(advisors) || !advisors.length || advisors.length > 50) fail('INVALID_ADVISORS');
  const ids = new Set(), users = new Set();
  for (const a of advisors) {
    if (!a || typeof a.id !== 'string' || !/^[\w:-]{1,128}$/.test(a.id) || !validId(String(a.bitrixUserId))
      || ids.has(a.id) || users.has(String(a.bitrixUserId))) fail('INVALID_ADVISORS');
    ids.add(a.id); users.add(String(a.bitrixUserId));
  }
  return advisors.map(a => ({ id: a.id, name: String(a.name || 'Asesor').slice(0, 255), bitrixUserId: String(a.bitrixUserId) }));
}

export function createSchedulingService({ database, bitrix, calendar = bitrix, advisors, now = () => Date.now() }) {
  const store = database.scheduling;
  if (!store || !advisors?.length || !bitrix?.call || !calendar?.call) fail('CALENDAR_NOT_CONFIGURED');
  async function deal(id) {
    const row = await bitrix.call('crm.deal.get', { id });
    if (String(row.ID) !== id || String(row.CATEGORY_ID) !== '370') fail('INVALID_BITRIX_DEAL');
    return row;
  }
  async function resolve(body) {
    const variants = phoneVariants(body.phone);
    if (!variants.length) fail('INVALID_PHONE');
    const phone = variants.find(p => p.startsWith('57') && p.length === 12) || variants[0];
    const profile = await store.resolveProfile(phone, body.clientCode);
    return { ok: true, data: { clientCode: profile.clientCode, advisorAssigned: true } };
  }
  async function upsert(body) {
    const result = await resolve({ phone: body.phone, clientCode: body.externalLeadId });
    const profile = await store.getProfile(result.data.clientCode);
    await store.saveProfile(profile, body);
    const registered = await database.findClienteByPhone(body.phone);
    // Profiles are local. An existing registered deal receives a deduplicated
    // summary; a missing match never creates an unrelated Bitrix deal.
    if (registered && body.summary) {
      const id = String(registered.id_negociacion);
      await store.withLock('profile-summary:' + id, async db => {
        const current = await deal(id);
        // A summary field write is safe to retry. Verify it before claiming a comment,
        // so a failure cannot lose the comment or report the profile as synchronized.
        if (current[DEAL_SUMMARY_FIELD] !== body.summary) {
          if (await bitrix.call('crm.deal.update', { id, fields: { [DEAL_SUMMARY_FIELD]: body.summary } }) !== true
            || (await deal(id))[DEAL_SUMMARY_FIELD] !== body.summary) fail('SUMMARY_NOT_CONFIRMED');
        }
        const hash = createHash('sha256').update(`${id}|${profile.clientCode}|${body.summary}`).digest('hex');
        if (await db.claimComment(hash, id)) {
          const commentId = await bitrix.call('crm.timeline.comment.add', { fields: {
            ENTITY_ID: id, ENTITY_TYPE: 'deal', COMMENT: timelineSummary(body.summary),
          } });
          await db.confirmComment(hash, requireBitrixEventId(commentId));
        }
      });
    }
    return { ok: true, persisted: true, clientId: profile.clientCode };
  }
  async function calendars(from, to, db = store) {
    const payload = await calendar.call('calendar.accessibility.get', { from, to, users: advisors.map(a => Number(a.bitrixUserId)) });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_AVAILABILITY');
    const rows = await db.reservations(from, to);
    const list = advisors.map(a => {
      const reservations = rows.filter(r => r.bitrixUserId === a.bitrixUserId);
      const confirmed = reservations.filter(r => r.status === 'confirmed');
      const counts = {};
      for (const row of confirmed) { const date = dateOf(row.startAt); counts[date] = (counts[date] || 0) + 1; }
      return { advisorId: a.id, bitrixUserId: a.bitrixUserId,
        events: Array.isArray(payload[a.bitrixUserId]) ? payload[a.bitrixUserId] : null,
        reservations, confirmedByDate: counts,
        lastAssignedAt: confirmed.map(r => r.createdAt).sort().at(-1) || null };
    });
    if (list.every(c => c.events === null)) fail('INVALID_AVAILABILITY');
    return list;
  }
  async function availability(code, body) {
    if (!await store.getProfile(code)) fail('LEAD_NOT_FOUND');
    const { dateFrom: from, dateTo: to, fromTime = '08:30', toTime = '17:00', durationMinutes = APPOINTMENT_DURATION_MINUTES, quantity = 2 } = body;
    const days = (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000;
    if (!sqlDate(from) || !sqlDate(to) || days < 0 || days > 60 || from < dateOf(now())) fail('INVALID_PERIOD');
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fromTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(toTime)
      || fromTime < '08:30' || toTime > '17:00' || fromTime >= toTime || durationMinutes !== APPOINTMENT_DURATION_MINUTES
      || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) fail('INVALID_HOURS');
    const busy = await calendars(from, to);
    const excluded = new Set((Array.isArray(body.excludeStarts) ? body.excludeStarts : []).slice(0, 500).map(Date.parse));
    const result = candidateDates({ from, daysAhead: days, weekdays: ['lunes','martes','miercoles','jueves','viernes'] })
      .map(date => ({ date, slots: calculateAdvisorDateSlots({ date, calendars: busy, durationMinutes, fromTime, toTime, now: new Date(now()) })
        .filter(s => Date.parse(s.startAt) > now() && !excluded.has(Date.parse(s.startAt))) }))
      .filter(d => d.slots.length).slice(0, quantity);
    return { ok: true, data: { source: 'bitrix_accessibility', days: result, slots: result.flatMap(d => d.slots) } };
  }
  async function syncCrm(id) {
    const initial = await store.getAppointment(id);
    return store.withLock('sync:' + (initial?.response?.crmSync?.dealId || id), async db => {
      const row = await db.getAppointment(id);
      if (!row || row.status !== 'confirmed' || !row.bitrixEventId) fail('APPOINTMENT_NOT_CONFIRMED');
      const sync = row.response?.crmSync;
      if (!sync?.dealId || sync.status === 'completed') return sync || null;
      // Never allow legacy/imported stages to move a deal to another pipeline.
      if (sync.stageId !== APPOINTMENT_STAGE) return sync;
      const requiresAppointmentDate = sync.requiresAppointmentDate === true || sync.requiresResponsible === true;
      let outcome;
      const attempts = Number(sync.attempts || 0) + 1;
      try {
        let owner = null;
        if (sync.requiresResponsible) {
          if (await db.hasNewerBooking(row)) fail('NEWER_BOOKING_EXISTS');
          const event = await calendar.call('calendar.event.getbyid', { id:row.bitrixEventId });
          owner = confirmedCalendarOwner(row,event,advisors);
        }
        const current = await deal(String(sync.dealId));
        const expectedDate = new Date(row.startAt).toISOString();
        const currentDate = dateValue(current[APPOINTMENT_DATE_FIELD]);
        if (requiresAppointmentDate && currentDate !== null
          && ![dateValue(sync.fromAppointmentDate),Date.parse(expectedDate)].includes(currentDate)) fail('DEAL_APPOINTMENT_DATE_CHANGED');
        if (current.CLOSED === 'Y' || ['C370:WON','C370:LOSE'].includes(current.STAGE_ID)
          || (sync.fromStageId && ![sync.fromStageId,APPOINTMENT_STAGE].includes(current.STAGE_ID))) fail('DEAL_STAGE_CHANGED');
        if (owner && ![String(sync.fromResponsibleId),owner].includes(String(current.ASSIGNED_BY_ID))) fail('DEAL_RESPONSIBLE_CHANGED');
        if (current.STAGE_ID !== APPOINTMENT_STAGE || (owner && String(current.ASSIGNED_BY_ID) !== owner)
          || (requiresAppointmentDate && currentDate !== Date.parse(expectedDate))) {
          if (await bitrix.call('crm.deal.update', { id: sync.dealId,
            fields: { STAGE_ID:APPOINTMENT_STAGE, ...(owner ? {ASSIGNED_BY_ID:owner} : {}),
              ...(requiresAppointmentDate ? {[APPOINTMENT_DATE_FIELD]:expectedDate} : {}) } }) !== true) fail('STAGE_NOT_CONFIRMED');
          const verified = await deal(String(sync.dealId));
          if (verified.STAGE_ID !== APPOINTMENT_STAGE || (owner && String(verified.ASSIGNED_BY_ID) !== owner)) fail('STAGE_NOT_CONFIRMED');
          if (requiresAppointmentDate && dateValue(verified[APPOINTMENT_DATE_FIELD]) !== Date.parse(expectedDate)) fail('APPOINTMENT_DATE_NOT_CONFIRMED');
        }
        outcome = { ...sync, status:'completed', ...(owner ? {responsibleId:owner} : {}),
          ...(requiresAppointmentDate ? {requiresAppointmentDate:true,appointmentStartAt:expectedDate} : {}),
          attempts,reviewRequired:false,lastError:null,nextAttemptAt:null };
      } catch (error) {
        const code = /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'BITRIX_SYNC_UNAVAILABLE';
        const reviewRequired = error.reviewRequired === true || ['DEAL_STAGE_CHANGED','DEAL_RESPONSIBLE_CHANGED',
          'DEAL_APPOINTMENT_DATE_CHANGED','NEWER_BOOKING_EXISTS','INVALID_BITRIX_DEAL'].includes(code) || attempts >= 8;
        outcome = { ...sync, status:'pending',attempts,reviewRequired,lastError:code,
          nextAttemptAt:new Date(now()+Math.min(1_800_000,30_000*2**Math.min(attempts-1,6))).toISOString() };
      }
      await db.saveSync(id, { ...row.response, crmSync: outcome });
      return outcome;
    });
  }
  const resultFor = (row, duplicate, crmSync = row.response?.crmSync) => ({ ok: true, data: {
    appointmentId: row.id, bitrixEventId: row.bitrixEventId, startAt: row.startAt, endAt: row.endAt,
    status: 'confirmed', duplicate, crmSync,
    advisor:{name:advisors.find(a=>a.id===row.advisorId)?.name||'la especialista asignada',bitrixUserId:row.bitrixUserId},
  } });
  async function recoverPending(db, row) {
    // A lost response is NOT permission to create another event. Recover only
    // one exact marker in the selected owner's calendar; otherwise block.
    const date = dateOf(row.startAt);
    const events = await calendar.call('calendar.event.get', { type: 'user', ownerId: Number(row.bitrixUserId), from: date, to: date });
    const marker = row.response?.marker || `CHATFUEL_APPOINTMENT:${row.id}`;
    const matches = Array.isArray(events) ? events.filter(e => e.DELETED !== 'Y'
      && String(e.DESCRIPTION || e['~DESCRIPTION'] || '').includes(marker)
      && String(e.OWNER_ID) === row.bitrixUserId) : [];
    if (matches.length !== 1) fail('BOOKING_CHECK_REQUIRED');
    const event = matches[0], start = parseBitrixDate(event.DATE_FROM), end = parseBitrixDate(event.DATE_TO);
    const expectedStart = parseBitrixDate(row.startAt), expectedEnd = parseBitrixDate(row.endAt);
    if (!start || !end || start.date !== expectedStart.date || start.minutes !== expectedStart.minutes
      || end.date !== expectedEnd.date || end.minutes !== expectedEnd.minutes) fail('BOOKING_CHECK_REQUIRED');
    const eventId = requireBitrixEventId(event.ID);
    await db.confirm(row.id, eventId, row.response);
    return { ...row, bitrixEventId: eventId, status: 'confirmed' };
  }
  async function book(code, body, key) {
    key ||= body.idempotencyKey;
    if (!/^[\w.:-]{1,128}$/.test(key || '')) fail('IDEMPOTENCY_KEY_REQUIRED');
    const start = Date.parse(body.startAt), duration = body.durationMinutes;
    const parsed = parseBitrixDate(body.startAt);
    if (!Number.isFinite(start) || !parsed || !Number.isInteger(duration) || duration <= 0) fail('INVALID_START');
    const requestedDeal = Object.hasOwn(body, 'bitrixDealId') ? String(body.bitrixDealId) : null;
    if (requestedDeal && (!validId(requestedDeal) || body.bitrixStageId !== APPOINTMENT_STAGE)
      || !requestedDeal && Object.hasOwn(body, 'bitrixStageId')) fail('INVALID_BITRIX_BINDING');
    const row = await store.withLock('booking:' + key, async db => {
      const previous = await db.getByKey(key);
      if (previous) {
        const oldDeal = previous.request.bitrixDealId ? String(previous.request.bitrixDealId) : null;
        if (previous.clientCode !== code || Date.parse(previous.startAt) !== start
          || Date.parse(previous.endAt) - start !== duration * 60000
          || previous.request.advisorId !== body.advisorId || oldDeal !== requestedDeal
          || (previous.request.bitrixStageId || null) !== (body.bitrixStageId || null)) fail('IDEMPOTENCY_KEY_CONFLICT');
        if (previous.status === 'confirmed') return { ...previous, duplicate: true };
        if (previous.status === 'pending') return { ...await recoverPending(db, previous), duplicate: true };
        fail('BOOKING_CHECK_REQUIRED');
      }
      // Existing reservations retain their exact stored interval; only new
      // reservations must use the current duration.
      if (duration !== APPOINTMENT_DURATION_MINUTES) fail('INVALID_START');
      if (body.resumeOnly) fail('LEGACY_BOOKING_REVIEW_REQUIRED');
      if (start <= now() || !sqlDate(parsed.date) || ['sabado','domingo'].includes(weekdayForDate(parsed.date))
        || parsed.minutes < 510 || parsed.minutes + duration > 1020) fail('INVALID_START');
      const profile = await db.getProfile(code);
      if (!profile) fail('LEAD_NOT_FOUND');
      const eligibility=evaluateRchEligibility(profile.data?.answers,{requireActive:true});
      if(eligibility.status!=='APLICA')throw Object.assign(new Error(eligibility.status==='NO_APLICA'?'RCH_NOT_ELIGIBLE':'RCH_PROFILE_INCOMPLETE'),
        {code:eligibility.status==='NO_APLICA'?'RCH_NOT_ELIGIBLE':'RCH_PROFILE_INCOMPLETE',retryable:false,eligibility});
      if (!advisors.some(a => a.id === body.advisorId)) fail('INVALID_ADVISOR');
      let originalStage = null, originalResponsible = null, originalAppointmentDate = null;
      if (requestedDeal) {
        const registered = await database.findClienteByPhone(profile.phone);
        if (String(registered?.id_negociacion) !== requestedDeal) fail('INVALID_BITRIX_BINDING');
        const original = await deal(requestedDeal);
        originalStage = original.STAGE_ID;
        if (original.CLOSED === 'Y' || ['C370:WON','C370:LOSE'].includes(originalStage)) fail('DEAL_STAGE_CHANGED');
        originalResponsible = String(original.ASSIGNED_BY_ID);
        originalAppointmentDate = original[APPOINTMENT_DATE_FIELD] || null;
        if (!validId(originalResponsible)) fail('INVALID_DEAL_RESPONSIBLE');
      }
      return db.withLock('day:' + parsed.date, async locked => {
        const busy = await calendars(parsed.date, parsed.date, locked);
        const fmt = mins => `${String(Math.floor(mins / 60)).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
        const available = calculateAdvisorDateSlots({ date: parsed.date, calendars: busy, durationMinutes: duration,
          fromTime: fmt(parsed.minutes), toTime: fmt(parsed.minutes + duration), now: new Date(now()) });
        const slot = available.find(s => Date.parse(s.startAt) === start);
        if (!slot) fail('SLOT_UNAVAILABLE');
        const advisor = advisors.find(a => a.id === slot.advisorId);
        const id = randomUUID(), marker = `CHATFUEL_APPOINTMENT:${id}`;
        const response = { marker, crmSync: requestedDeal ? {
          dealId: requestedDeal, stageId: APPOINTMENT_STAGE, fromStageId: originalStage, status: 'pending',
          requiresResponsible:true,fromResponsibleId:originalResponsible,
          requiresAppointmentDate:true,fromAppointmentDate:originalAppointmentDate,
        } : null };
        const pending = { id, clientCode: code, advisorId: advisor.id, bitrixUserId: advisor.bitrixUserId, key,
          startAt: slot.startAt, endAt: slot.endAt, request: body, response, status: 'pending' };
        // Autocommit before calendar.event.add survives process/DB/network failure.
        await locked.insertPending(pending);
        const eventId = requireBitrixEventId(await calendar.call('calendar.event.add', {
          type: 'user', ownerId: Number(advisor.bitrixUserId), auto_detect_section: 'Y',
          ...(requestedDeal ? { crm_fields: [`D_${requestedDeal}`] } : {}),
          name: `Cita Chatfuel - ${profile.name}`, description: `Cliente: ${profile.name}\nTeléfono: ${profile.phone}\n${marker}`,
          from: slot.startAt, to: slot.endAt, skip_time: 'N', timezone_from: 'America/Bogota', timezone_to: 'America/Bogota',
          accessibility: 'busy', importance: 'normal', private_event: 'N', is_meeting: 'Y',
          host: Number(advisor.bitrixUserId), attendees: [Number(advisor.bitrixUserId)], remind: [{ type: 'min', count: 30 }],
        }));
        await locked.confirm(id, eventId, response);
        return { ...pending, bitrixEventId: eventId, status: 'confirmed', duplicate: false };
      });
    });
    const sync = await syncCrm(row.id).catch(() => row.response?.crmSync);
    return resultFor(row, row.duplicate, sync);
  }
  return {
    availability, book, resolve, upsert, syncCrm,
    async getBookingState({appointmentId,key,clientCode}) {
      const row = appointmentId ? await store.getAppointment(appointmentId) : key ? await store.getByKey(key) : null;
      if (row && row.clientCode !== clientCode) fail('IDEMPOTENCY_KEY_CONFLICT');
      return row;
    },
    async retryPendingCrm() {
      const ids = await store.pendingCrmAppointments(new Date(now()).toISOString());
      for (const id of ids) await syncCrm(id);
      return ids.length;
    },
    async request(path, body, key) {
      if (path === '/api/v1/leads/resolve') return resolve(body);
      if (path === '/api/webhooks/prospecting-bot/lead') return upsert(body);
      if (path === '/api/v1/appointments/retry-crm') return { ok: true, data: { results: [
        { appointmentId: body.appointmentId, crmSync: await syncCrm(body.appointmentId) },
      ] } };
      const match = /^\/api\/v1\/leads\/([^/]+)\/(availability|appointments)$/.exec(path);
      if (!match) fail('UNKNOWN_CALENDAR_OPERATION');
      return match[2] === 'availability' ? availability(decodeURIComponent(match[1]), body) : book(decodeURIComponent(match[1]), body, key);
    },
  };
}

export function startCrmSyncWorker(service, { logger = console, intervalMs = 30_000 } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await service.retryPendingCrm(); }
    catch { logger.error({ evento:'sincronizacion_responsable',causa:'RETRY_FAILED' }); }
    finally { running = false; }
  };
  void run();
  const timer = setInterval(() => { void run(); },intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
