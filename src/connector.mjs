import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { FEEDBACK_HEADINGS, PROFILE_FEEDBACK_VERSION } from './calendar/profileSummary.js';
import { APPOINTMENT_DURATION_MINUTES, APPOINTMENT_DURATION_MS } from './calendar/policy.js';
import { evaluateRchEligibility, eligibilityMessage, RCH_QUESTION_FIELDS, RCH_POLICY_VERSION } from './calendar/rchEligibility.js';
import { reconcileQuestionnaireTimes } from './calendar/confirmedAnswers.js';

export const RELEASE_VERSION = '1.0.31';

const ATTR = [...RCH_QUESTION_FIELDS, 'rch_estado_elegibilidad','rch_motivo_elegibilidad','rch_meses_restantes','rch_eligibilidad_version',
  'nombre_completo', 'ciudad_municipio', 'obligacion_vivienda_activa',
  'tipo_obligacion', 'banco_entidad', 'estado_pago', 'necesidad_principal',
  'correo_contacto', 'anos_restantes', 'anos_pagados', 'numero_titulares',
  'puede_aumentar_cuota_mas_10', 'modalidad_pesos_uvr',
  'linea_interes', 'urgencia_caso', 'horario_contacto_preferido',
  'senal_reducir_plazo', 'senal_reducir_intereses', 'senal_deuda_aumenta',
  'senal_conoce_ley_vivienda', 'senal_consulta_honorarios', 'senal_info_adicional',
  'rch_banco', 'rch_frech', 'rch_saldo_millones', 'rch_saldo_evidencia',
  'rch_anos_pagando', 'rch_cuotas_atrasadas',
  'bitrix_agenda_estado', 'bitrix_agenda_respuesta', 'crm_30x_codigo', 'bitrix_reserva_pendiente',
  'crm_30x_handoff_hash', 'crm_30x_profile_comment_hash', 'last user freeform input',
  'solicitud_agendamiento', 'texto_solicitud_agendamiento', 'crm_30x_booking_intent_hash',
  'crm_30x_incoming_recovery_hash','bitrix_responsable_id','bitrix_responsable_sync'];
const PROFILE = ATTR.filter(name => !name.startsWith('bitrix_') && !name.startsWith('crm_')
  && !['solicitud_agendamiento', 'texto_solicitud_agendamiento'].includes(name));
const attributeMap = attributes => Object.fromEntries((attributes ?? []).map(({ attr, value }) =>
  [attr.name, value?.stringValue ?? value?.booleanValue ?? value?.doubleValue ?? '']));
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const same = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const yes = value => /^(si|s|1|true|activo|activa|confirmo|confirmar|de acuerdo|si confirmo)[.!\s]*$/.test(normalize(value));
const no = value => /^(no|n|0|false|cancelar|cancela|salir)[.!\s]*$/.test(normalize(value));
const profileText = value => {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
  return !text || /^(?:pendiente|unknown|desconocid[oa]|no (?:sabe|recuerda|informad[oa])|sin (?:dato|informaci[oó]n)|declin[oó]|prefiere no responder|null|undefined|n\/a)$/i.test(text) ? null : text;
};
const declared = (fields, ...names) => names.map(name => profileText(fields[name])).find(value => value !== null) ?? null;

export function profileComment(fields, { handoff = false, displayName = '', booking = false } = {}) {
  const eligibility = evaluateRchEligibility(fields);
  const details = [];
  const pending = [];
  const name = declared(fields, 'nombre_completo');
  const city = declared(fields, 'ciudad_municipio');
  if (name) details.push(`Chatfuel conversó con ${name}${city ? `, de ${city},` : ''} a través de WhatsApp.`);
  else {
    details.push(`Perfilamiento RCH recibido por Chatfuel${profileText(displayName) ? `; contacto de WhatsApp: ${profileText(displayName)}` : ''}.`);
    pending.push('nombre completo confirmado');
    if (city) details.push(`El cliente se encuentra en ${city}.`);
  }
  if (!city) pending.push('ciudad o municipio');
  const active = declared(fields, 'obligacion_vivienda_activa');
  if (yes(active)) details.push(`Confirma una obligación de vivienda activa${declared(fields, 'tipo_obligacion') ? ` de tipo ${declared(fields, 'tipo_obligacion')}` : ''}.`);
  else if (no(active)) details.push('Indica que no tiene una obligación de vivienda activa.');
  else pending.push('confirmación de obligación de vivienda activa');
  const product = declared(fields, 'tipo_obligacion');
  if (product && !yes(active)) details.push(`Producto declarado: ${product}.`);
  const bank = declared(fields, 'rch_banco', 'banco_entidad');
  if (bank) details.push(`Entidad del crédito: ${bank}.`);
  else pending.push('banco o entidad');
  const coverage = declared(fields, 'rch_frech');
  if (yes(coverage)) details.push('Declara tener cobertura de tasa Mi Casa Ya o FRECH.');
  else if (no(coverage)) details.push('Declara no tener cobertura de tasa Mi Casa Ya o FRECH.');
  const balance = declared(fields, 'rch_saldo_millones');
  const balanceEvidence = declared(fields, 'rch_saldo_evidencia');
  if (balance && /^\d+(?:[.,]\d+)?$/.test(balance)) {
    const amount = Number(balance.replace(',', '.')) * 1_000_000;
    if (Number.isFinite(amount) && amount <= Number.MAX_SAFE_INTEGER) {
      details.push(`Saldo pendiente de dinero declarado: ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(amount)} COP.`);
    } else pending.push('saldo pendiente en dinero por aclarar');
  } else if (balanceEvidence) {
    details.push(`Referencia del cliente sobre el saldo pendiente: «${balanceEvidence}».`);
    pending.push('saldo pendiente en dinero por confirmar');
  } else if (balance) {
    details.push(`Saldo pendiente declarado en millones de pesos colombianos: ${balance}.`);
  }
  const elapsed = declared(fields, 'rch_anos_pagando', 'anos_pagados');
  if (elapsed) details.push(`Tiempo que lleva pagando, en años: ${elapsed}.`);
  const arrears = declared(fields, 'rch_cuotas_atrasadas');
  if (arrears !== null && /^\d+$/.test(arrears)) {
    const count = Number(arrears);
    details.push(count === 0 ? 'Confirma estar al día, con cero cuotas vencidas sin pagar.' : `Cuotas vencidas sin pagar declaradas: ${count}.`);
  } else if (arrears !== null) details.push(`Cuotas atrasadas según lo declarado: ${arrears}.`);
  else {
    const paymentStatus = declared(fields, 'estado_pago');
    if (paymentStatus) details.push(`Estado de pago declarado: ${paymentStatus}.`);
  }
  for (const [field,label] of [['rch_reportes_negativos','Reportes negativos declarados'],
    ['rch_puede_aumentar_cuota','Posibilidad de aumentar un poco la cuota'],
    ['rch_plazo_inicial','Plazo original del crédito'],['rch_tiempo_pagando','Tiempo que lleva pagando']]) {
    const value=declared(fields,field);if(value)details.push(`${label}: ${value}.`);
  }
  if(eligibility.remainingMonths!==null)details.push(`Tiempo restante calculado: ${eligibility.remainingMonths} meses.`);
  const eligibilityLabels={rch_banco:'banco actual',rch_reportes_negativos:'reportes negativos en centrales',
    rch_puede_aumentar_cuota:'posibilidad de aumentar la cuota',rch_plazo_inicial:'plazo original',
    rch_tiempo_pagando:'tiempo pagando con unidad',obligacion_vivienda_activa:'obligación de vivienda activa'};
  pending.push(...eligibility.missing.map(field=>eligibilityLabels[field]||field));
  for (const [field, label] of [['necesidad_principal', 'Objetivo declarado'], ['urgencia_caso', 'Urgencia registrada'],
    ['horario_contacto_preferido', 'Preferencia de contacto']]) {
    const value = declared(fields, field);
    if (value) details.push(`${label}: ${value}.`);
  }
  for (const [field, label] of [['modalidad_pesos_uvr', 'Modalidad del crédito'],
    ['anos_restantes', 'Años restantes declarados'], ['numero_titulares', 'Número de titulares declarado'],
    ['puede_aumentar_cuota_mas_10', 'Posibilidad declarada de aumentar la cuota más del 10%']]) {
    const value = declared(fields, field);
    if (value) details.push(`${label}: ${value}.`);
  }
  const interests = [];
  for (const [field, label] of [
    ['senal_reducir_plazo', 'Interés registrado en reducir el plazo del crédito.'],
    ['senal_reducir_intereses', 'Interés registrado en reducir intereses.'],
    ['senal_deuda_aumenta', 'Preocupación registrada por el aumento de la deuda.'],
    ['senal_conoce_ley_vivienda', 'Declara conocer la ley de vivienda.'],
    ['senal_consulta_honorarios', 'Consulta registrada sobre honorarios.'],
    ['senal_info_adicional', 'Solicitud registrada de información adicional.'],
  ]) if (yes(declared(fields, field))) interests.push(label);
  if (!interests.length) interests.push('No hay señales adicionales de interés o consultas registradas.');
  const rejected = eligibility.status === 'NO_APLICA';
  const followUp = [rejected
    ? 'Motivo de atención: descarte del perfilamiento de reducción de crédito hipotecario por una condición declarada por el cliente. Este registro no acredita una solicitud ni una reserva de cita.'
    : handoff
      ? 'Motivo de atención: transferencia al equipo humano desde Chatfuel. Revisar el contexto y los datos pendientes antes de orientar el caso.'
      : booking
        ? 'Motivo de atención: solicitud de agendamiento. Este perfilamiento no confirma una reserva; verificar el resultado técnico de la agenda en Bitrix.'
        : 'Motivo de atención: perfilamiento por WhatsApp con Chatfuel. No se registra una reserva de cita desde este resumen.'];
  const analysis = ['Información basada en las respuestas registradas; requiere validación del asesor.'];
  analysis.push(`Filtro comercial inicial ${RCH_POLICY_VERSION}: ${eligibility.status}. Motivo: ${eligibility.reason}. No equivale a aprobación financiera ni garantiza ahorro.`);
  const nextSteps = [];
  if (yes(active)) analysis.push('Existe una obligación de vivienda activa declarada; revisar sus condiciones antes de evaluar opciones.');
  else if (no(active)) analysis.push('El cliente declara no tener obligación de vivienda activa; aclarar el motivo de atención antes de continuar la evaluación.');
  else nextSteps.push('Confirmar si existe una obligación de vivienda activa.');
  if (arrears !== null && /^\d+$/.test(arrears) && Number(arrears) > 0) {
    analysis.push('Hay cuotas vencidas declaradas; revisar el estado actual de la obligación.');
    nextSteps.push('Aclarar las cuotas vencidas y el estado de pago antes de proponer alternativas.');
  }
  if (yes(coverage)) nextSteps.push('Validar las condiciones y vigencia de la cobertura Mi Casa Ya o FRECH declarada.');
  if (yes(declared(fields, 'senal_consulta_honorarios'))) nextSteps.push('Explicar los honorarios y el alcance del servicio; confirmar si queda alguna inquietud.');
  if (yes(declared(fields, 'senal_deuda_aumenta'))) nextSteps.push('Revisar con el cliente su extracto y la evolución del saldo.');
  if (yes(declared(fields, 'senal_reducir_plazo')) || yes(declared(fields, 'senal_reducir_intereses'))) {
    nextSteps.push('Precisar el objetivo de plazo o intereses y evaluar las condiciones del crédito sin prometer resultados.');
  }
  analysis.push('No se dispone de un registro específico de objeciones; no se presume que el cliente carezca de ellas.');
  analysis.push('Este feedback no determina viabilidad, aprobación ni ahorro y no asigna un puntaje de calificación.');
  nextSteps.push('Validar banco, saldo, modalidad y plazo con información actualizada del cliente.');
  nextSteps.push(pending.length ? 'Completar los datos pendientes antes de emitir una recomendación.' : 'Corroborar los datos recopilados y resolver las preguntas del cliente.');
  if (rejected) {
    nextSteps.splice(0, nextSteps.length,
      'Registrar el motivo confirmado en NO APLICA CHATFUEL, respetando citas existentes y cambios manuales de etapa.',
      'No continuar el cuestionario ni ofrecer agenda para esta solicitud descartada. No se necesitan los demás datos para justificar este descarte.');
  }
  const sections = [details, interests, followUp, analysis, nextSteps,
    [pending.length ? `Datos pendientes: ${pending.join('; ')}.` : 'Sin pendientes en los datos básicos de perfilamiento; falta su validación por el asesor.']];
  return [FEEDBACK_HEADINGS[0], ...sections.map((lines, i) =>
    `${FEEDBACK_HEADINGS[i + 1]}\n${lines.map(line => `• ${line}`).join('\n')}`)].join('\n\n');
}
const declineBooking = value => no(value) || /^(no gracias|ahora no|por ahora no|mas tarde|despues|prefiero no|no quiero agendar|no me agendes|dejalo pendiente|lo dejamos pendiente)[.!\s]*$/.test(normalize(value));
function requestsScheduleOptions(value) {
  const text = normalize(value).replace(/[¿?¡!.,;:]/g, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  // Asking to see options authorizes browsing, never booking a selected slot.
  // Match the whole request so negations and conditions cannot become consent.
  const courtesy = '(?:(?:si+|claro|dale+|listo|bueno|por favor|porfa) )*';
  const intent = '(?:quiero|quisiera|necesito|deseo|me gustaria|me interesa|podemos|puedes|podrias)';
  const action = '(?:ver|revisar|consultar|conocer|buscar|mirar|elegir|coordinar)';
  const command = '(?:dame|muestrame|revisemos|consultemos|veamos|busquemos|miramos|revisamos)';
  const target = '(?:(?:un|una|el|la|los|las|otro|otra|otros|otras|nuevo|nueva|nuevos|nuevas) ){0,2}'
    + '(?:horarios?|opciones(?: de horarios?)?|citas?|asesorias?|reuniones?)'
    + '(?: (?:disponibles?|libres?))?(?: para (?:una |mi )?(?:cita|asesoria|reunion))?';
  return new RegExp(`^${courtesy}(?:${intent} (?:${action} )?|${command} )${target}(?: por favor| porfa)?(?: gracias)?$`).test(text);
}
function explicitBooking(value) {
  const text = normalize(value).replace(/^[¿¡]+/,'');
  if (/\b(?:no|nunca)\s+(?:(?:quiero|quisiera|deseo|necesito|puedo|vamos a)\s+)?(?:que me\s+|me\s+)?(?:agend\w*|reserv\w*|program\w*)\b/.test(text)
    || /\b(?:no se si|tal vez|depende|solo si)\b/.test(text)) return false;
  return requestsScheduleOptions(value) || /\b(?:quiero|quisiera|necesito|deseo|me gustaria|puedo|podemos|puedes)\s+(?:que me\s+)?(?:agendar(?:me)?|agendes|reservar(?:me)?|reserves|programar(?:me)?)/.test(text)
    || /\b(?:tienes|tiene)\s+(?:la\s+)?(?:capacidad|posibilidad)\s+de\s+agendarme\b/.test(text)
    || /^(?:(?:listo|bueno|si|por favor)[,\s]+)*(?:dame|muestrame|revisemos|consultemos)\s+(?:los\s+)?horarios[.!?\s]*$/.test(text)
    || /^(?:(?:pero|bueno|entonces|por favor|porfa|dale|si)[,\s]+)*(?:agendame|reservame|programame)\b/.test(text)
    || /^(?:agendar(?:me)?|agendame|reservar(?:me)?|reservame)(?:\s+(?:una|la|mi))?(?:\s+(?:cita|llamada|asesoria|reunion|horario|espacio))?[.!]*$/.test(text);
}
function availabilityAnswer(value) {
  const text=normalize(value).split(/\b(?:pero|bueno)\b/).at(-1).trim();
  if(declineBooking(value)||/\b(?:no|nunca|tal vez|depende|solo si)\b/.test(text))return false;
  return /(?:en|por) la (?:manana|tarde|noche)\b|^(?:manana|tarde|noche)[.!?]*$/.test(text);
}
const nightPreference=value=>/\b(?:en|por) la noche\b|^noche[.!?]*$/.test(normalize(value).split(/\b(?:pero|bueno)\b/).at(-1).trim());
const nightExplanation='Las asesorías se coordinan de lunes a viernes, entre las 8:30 a. m. y las 5:00 p. m., hora de Colombia. No tenemos horarios nocturnos; podemos revisar otro día 😊.';
function confirmBooking(value) {
  if (yes(value)) return true;
  const raw=normalize(value);
  if (/^[\s👍👌✅\uFE0F]+$/u.test(raw)) return true;
  if (/[¿?]/.test(raw)) return false;
  const text=raw.replace(/[.!¡,;:]/g,' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu,' ').replace(/\s+/g,' ').trim();
  const affirmative='(?:que )?si{1,12}|sip|sipi|claro(?: que si)?|de acuerdo|'
    +'me gustaria(?: mucho)?|me interesa|me parece (?:bien|perfecto)|'
    +'dale+|vale|listo+|perfecto|por supuesto|esta bien|correcto|'
    +'acepto|confirmo|confirmado|adelante|sigamos|continuemos|hagamoslo|'
    +'genial|ok|okay|okey|por favor';
  return new RegExp(`^(?:${affirmative})(?: (?:${affirmative}|porfa|gracias|muchas gracias|senor|senora|senorita))*$`).test(text);
}
function offersBooking(value) {
  const text = normalize(value);
  if (!/[¿?]/.test(text) || /\b(?:no|nunca)\b[^?!.]{0,70}\b(?:agend|coordin|organiz|program|reserv)/.test(text)) return false;
  return /\b(?:quiere|quieres|desea|deseas|le gustaria|te gustaria|podemos)\b[^?!.]{0,100}\b(?:agendar|coordinar|organizar|organicemos|agendemos|coordinemos|programar|reservar)\b[^?!.]{0,80}\b(?:llamada|cita|asesoria|reunion)\b/.test(text)
    || /\b(?:agendamos|coordinamos|organizamos|programamos|le agendo|te agendo)\b[^?!.]{0,80}\b(?:llamada|cita|asesoria|reunion)\b/.test(text);
}
function acceptedBookingHistory(messages) {
  for(let i=0;i<messages.length;i++){
    const message=messages[i];
    if(message.__typename!=='WhatsAppInTextMessage')continue;
    if(declineBooking(message.text))return false;
    if(explicitBooking(message.text))return true;
    const previous=messages.slice(i+1).find(m=>/^WhatsApp(?:In|Out)/.test(m.__typename));
    if(confirmBooking(message.text) && previous?.__typename==='WhatsAppOutTextMessage'
      && offersBooking(previous.text))return true;
  }
  return false;
}
function asksBookingPeriod(value) {
  const text=normalize(value);
  // A real scheduling invitation may omit question marks. Keep the calendar
  // context and both periods so financial questions or business hours alone
  // cannot turn a reply into appointment consent.
  if (/\bno\s+(?:puedo|podemos|se puede)\s+(?:consultar|reservar|agendar)/.test(text)) return false;
  return /\b(?:asesoria|llamada|cita|reunion|agendar|coordinar)\b/.test(text)
    && /\b(?:prefieres|prefiere|prefieren)\b[^.!?]{0,90}\bmanana\b[^.!?]{0,30}\btarde\b/.test(text);
}
// Ofrece solo inicios libres verificados, repartidos a lo largo de la franja.
// Deja al menos un intervalo de diez minutos entre las opciones ofrecidas.
function spreadSlots(slots) {
  const unique = [...new Map(slots.map(slot => [Date.parse(slot.startAt), slot])).values()]
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  if (!unique.length) return [];
  const first = unique[0], last = unique.at(-1);
  const start = Date.parse(first.startAt), end = Date.parse(last.startAt);
  const separation = APPOINTMENT_DURATION_MS + 10 * 60_000;
  if (end - start < separation) return [first];
  const midpoint = (start + end) / 2;
  const middle = unique.slice(1, -1)
    .filter(slot => Date.parse(slot.startAt) - start >= separation && end - Date.parse(slot.startAt) >= separation)
    .sort((left, right) => Math.abs(Date.parse(left.startAt) - midpoint) - Math.abs(Date.parse(right.startAt) - midpoint))[0];
  return middle ? [first, middle, last] : [first, last];
}
const PERIODS = [{ label: 'En la mañana', fromTime: '08:30', toTime: '12:00' },
  { label: 'En la tarde', fromTime: '12:00', toTime: '17:00' }];
const dateAt = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const timeAt = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const addDays = (date, count) => new Date(Date.parse(`${date}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
const dayLabel = date => new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00Z`));
function selection(value, count) {
  if (/[?¿]/.test(value)) return null;
  const text = normalize(value).replace(/[!¡.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  const match = text.match(/^(?:(?:si|claro|ok|listo|perfecto|vale)\s+)?(?:(?:yo\s+)?(?:elijo|escojo|selecciono|prefiero|confirmo|acepto|quiero|reservame|agendame|me sirve|me quedo con|me gustaria|me queda bien)\s+)?(?:la\s+|el\s+)?(?:opcion\s+|horario\s+|alternativa\s+)?(?:numero\s+)?([1-5]|uno|una|primera|primero|dos|segunda|segundo|tres|tercera|tercero)(?:\s+(?:opcion|horario|alternativa))?(?:\s+(?:me sirve|me queda bien|esta bien|me interesa))?(?:\s+por favor)?(?:\s+gracias)?$/);
  if (!match) return null;
  const number = /^\d$/.test(match[1]) ? Number(match[1]) : ({ uno: 1, una: 1, primera: 1, primero: 1, dos: 2, segunda: 2, segundo: 2, tres: 3, tercera: 3, tercero: 3 })[match[1]];
  return number >= 1 && number <= count ? number - 1 : null;
}
function periodFrom(value) {
  const text = normalize(value);
  if (/\b(no|nunca|tal vez|depende|solo si)\b/.test(text)) return null;
  if (/(?:en|por) la tarde\b|^tarde$/.test(text)) return PERIODS[1];
  if (/(?:en|por) la manana\b|^manana$/.test(text)) return PERIODS[0];
  return null;
}
function selectedDay(value, days, now) {
  const index = selection(value, days.length);
  if (index !== null) return days[index];
  const text = normalize(value).replace(/[.!]/g, '').replace(/^(?:para|prefiero|quiero|me gustaria)\s+/, '').replace(/^el\s+/, '').replace(/\s+(?:en|por) la (?:manana|tarde)$/, '').trim();
  const relative = { hoy: 0, manana: 1, 'pasado manana': 2 };
  if (Object.hasOwn(relative, text)) {
    const date = addDays(dateAt(now), relative[text]);
    return days.includes(date) ? date : null;
  }
  const matches = days.filter(date => [normalize(dayLabel(date)), normalize(new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'long' }).format(new Date(`${date}T12:00:00Z`))), date].includes(text));
  return matches.length === 1 ? matches[0] : null;
}
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export function createHandler({ env = process.env, fetchImpl = fetch, now = () => Date.now(), database = null, scheduling = null } = {}) {
  const botID = env.CHATFUEL_BOT_ID;
  const secret = env.CHATFUEL_BOOKING_SECRET;
  const configured = Boolean(botID && secret?.length >= 32 && env.CHATFUEL_API_TOKEN
    && scheduling?.request);
  const handoffStatus = { enabled: env.HANDOFF_SYNC_ENABLED === 'true', connected: false,
    lastSyncAt: null, synchronized: 0, bookingFlowsStarted: 0, lastError: null,
    incomingRecoveryEnabled: env.INCOMING_RECOVERY_ENABLED === 'true', incomingRecovered: 0,
    incomingRecoveryLastError: null, rejectionSyncLastError:null };
  let syncing = null;
  // Contact search can briefly return an old attribute snapshot after a write.
  // Keep successful writes locally too, and use a separate schema marker so an
  // older deployment cannot alternate its legacy fingerprint with this one.
  const synchronizedProfiles = new Map();
  const routedBookingIntents = new Map();
  const incomingRecoveryAttempts = new Map();
  const mac = data => createHmac('sha256', secret).update(data).digest('base64url');
  function encode(contactId, state) {
    const payload = Buffer.from(JSON.stringify({ ...state, engine: 'local-v1', contactId, expires: now() + 30 * 60_000 })).toString('base64url');
    return `${payload}.${mac(payload)}`;
  }
  function decode(token, contactId, { allowExpired = false } = {}) {
    if (!token || token.length > 20000) return null;
    const [payload, signature, extra] = token.split('.');
    if (extra || !payload || !signature || !same(signature, mac(payload))) return null;
    try {
      const state = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return state.contactId === contactId && Number.isFinite(state.expires)
        && (allowExpired || state.expires > now()) ? state : null;
    } catch { return null; }
  }
  async function graphql(query, variables) {
    const response = await fetchImpl('https://panel.chatfuel.com/graphql', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.CHATFUEL_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (!response.ok || body.errors?.length || !body.data) {
      const error = new Error('CHATFUEL_UNAVAILABLE');
      if (body.errors?.some(item => item.extensions?.code === 'ConversationThreadOwnedByExternalApp'
        || item.extensions?.errors?.some(nested => nested.extensions?.code === 'ConversationThreadOwnedByExternalApp'))) {
        error.code = 'ConversationThreadOwnedByExternalApp';
      }
      throw error;
    }
    return body.data;
  }
  async function setAttributes(contactId, fields) {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null);
    const variables = { id: contactId };
    const declarations = ['$id:ContactID!'];
    const operations = entries.map(([name, value], index) => {
      declarations.push(`$v${index}:String!`);
      variables[`v${index}`] = String(value);
      return `a${index}:contactAttributeUpdate(id:$id,attrName:${JSON.stringify(name)},attrValue:$v${index}){id}`;
    });
    await graphql(`mutation BookingAttributes(${declarations.join(',')}){${operations.join(' ')}}`, variables);
  }
  async function contact(contactId) {
    const data = await graphql(`query BookingContact($botID:BotID!,$id:ContactID!,$conversationID:ConversationID!,$names:[AttributeName!]){
      bot(id:$botID){contact(id:$id){id attributes(names:$names){attr{name} value{
        ... on BotAttributeValueString{stringValue} ... on BotAttributeValueBoolean{booleanValue}
        ... on BotAttributeValueDouble{doubleValue}}} ... on WhatsappContact{phone}}
        conversation(conversationID:$conversationID){messages(first:40){edges{node{id __typename
          ... on WhatsAppInTextMessage{text} ... on WhatsAppOutTextMessage{text}}}}}}}`,
    { botID, id: contactId,conversationID:contactId, names: ATTR });
    const item = data.bot.contact;
    const fields = attributeMap(item.attributes);
    const updates=reconcileQuestionnaireTimes(fields,data.bot.conversation?.messages?.edges?.map(e=>e.node)||[]);
    if(Object.keys(updates).length){Object.assign(fields,updates);await setAttributes(contactId,updates);}
    const phone = String(item.phone ?? '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phone)) throw new Error('INVALID_CONTACT');
    return { phone, fields };
  }
  async function crm(path, body, idempotencyKey) {
    // Solo consultas seguras: no repetir reservas o comentarios ante una respuesta perdida.
    const canRetry = path === '/api/v1/leads/resolve' || path.endsWith('/availability');
    const deadline = Date.now() + 8000;
    for (let attempt = 0; ; attempt++) {
      try {
        // In-process service: no HTTP request, token or dependency on another CRM.
        const result = await scheduling.request(path, body, idempotencyKey);
        if (result?.ok !== true) throw new Error('CRM_INVALID_RESPONSE');
        return result;
      } catch (error) {
        const delayMs = Math.max(250 * (attempt + 1), error.retryAfterMs || 0);
        if (!canRetry || error.retryable === false || attempt >= 2 || Date.now() + delayMs >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  async function reply(contactId, state, message, { done = false, fields = {}, human = false } = {}) {
    const signed = encode(contactId, state);
    await setAttributes(contactId, { ...fields, bitrix_agenda_estado: signed,
      bitrix_agenda_mensaje: message, bitrix_agenda_finalizada: done ? 'si' : 'no', bitrix_agenda_humano: human ? 'si' : 'no' });
    return json({ message, done: done ? 'si' : 'no', human: human ? 'si' : 'no', state: signed, clientCode: state.clientCode ?? '' });
  }
  function label(slot) {
    return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', weekday: 'long',
      day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(slot.startAt));
  }
  function recordedAppointmentMessage(state) {
    const date=new Intl.DateTimeFormat('es-CO',{timeZone:'America/Bogota',
      weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit'})
      .format(new Date(state.slot.startAt));
    return `Veo una cita registrada para ${date} (hora de Colombia). Esa fecha ya pasó. ¿Quieres que revisemos horarios para una nueva asesoría?`;
  }
  async function available(clientCode, from, to, window, excluded = []) {
    const result = await crm(`/api/v1/leads/${encodeURIComponent(clientCode)}/availability`, {
      advisorPool: true, mode: 'next_days', durationMinutes: APPOINTMENT_DURATION_MINUTES, quantity: 2,
      dateFrom: from, dateTo: to, daysAhead: 21, fromTime: window.fromTime, toTime: window.toTime,
      weekdays: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes'],
      excludeStarts: excluded.slice(-500),
    });
    const raw = result.data?.slots;
    if (!Array.isArray(raw) || result.data.source !== 'bitrix_accessibility') throw new Error('INVALID_AVAILABILITY');
    return raw.filter(slot => {
      const start = Date.parse(slot.startAt), end = Date.parse(slot.endAt);
      if (!(start > now()) || end - start !== APPOINTMENT_DURATION_MS || !slot.advisorId) return false;
      const date = dateAt(start);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6 && date >= from && date <= to
        && dateAt(end) === date && timeAt(start) >= window.fromTime && timeAt(end) <= window.toTime
        && !excluded.some(value => Date.parse(value) === start);
    }).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }
  function askPeriod(contactId, clientCode, { date, intro = '' } = {}) {
    return reply(contactId, { step: 'period', clientCode, ...(date ? { date } : {}) },
      `${intro ? intro + '\n\n' : 'Con gusto coordinamos tu cita de asesoría virtual de 30 minutos por Zoom con un asesor 🗓️. Es una reunión a la que debes conectarte en el horario elegido.\n\n'}${date ? `Para el ${dayLabel(date)}, ¿prefieres` : '¿Prefieres'} tu cita en la mañana o en la tarde?`);
  }
  async function offerDays(contactId, clientCode, window) {
    let from = dateAt(now());
    const cutoff = Number(env.APPOINTMENT_SAME_DAY_CUTOFF_HOUR || 12);
    if (Number(timeAt(now()).slice(0, 2)) >= (Number.isInteger(cutoff) && cutoff >= 0 && cutoff <= 23 ? cutoff : 12)) from = addDays(from, 1);
    while ([0, 6].includes(new Date(`${from}T12:00:00Z`).getUTCDay())) from = addDays(from, 1);
    const slots = await available(clientCode, from, addDays(from, 21), window);
    const days = [...new Set(slots.map(slot => dateAt(slot.startAt)))].slice(0, 2);
    if (!days.length) return askPeriod(contactId, clientCode, { intro: 'No encontré días libres en esa franja. Podemos revisar la otra franja o solicitar ayuda a un asesor.' });
    return reply(contactId, { step: 'day', clientCode, days, ...window },
      `🗓️ ¿Qué día prefieres para tu cita de asesoría virtual por Zoom con un asesor?\n\n${days.map((date, index) => `${index + 1}. ${dayLabel(date)}`).join('\n')}\n\nPuedes responder con el día o con el número.`);
  }
  async function offerTimes(contactId, state, date, excluded = []) {
    const window = { fromTime: state.fromTime || '08:30', toTime: state.toTime || '17:00' };
    const slots = spreadSlots(await available(state.clientCode, date, date, window, excluded))
      .map(({ startAt, endAt, advisorId }) => ({ startAt, endAt, advisorId }));
    const context = { ...state, ...window, step: 'choose', date, slots,
      excludedStarts: [...new Set([...excluded, ...slots.map(slot => slot.startAt)])] };
    if (!slots.length) return reply(contactId, context, 'No encontré otros horarios libres en ese día y franja. ¿Prefieres otro día u otra franja?');
    return reply(contactId, context,
      `🕒 Estos son los horarios libres para tu cita de asesoría virtual de 30 minutos por Zoom el ${dayLabel(date)} (hora de Colombia):\n\n${slots.map((slot, index) => `${index + 1}. ${timeAt(slot.startAt)}`).join('\n')}\n\n¿En cuál puedes conectarte? Puedes decir el horario, «la primera» o el número. También podemos revisar otro día u otra franja.`);
  }
  async function options(contactId, clientCode, excluded = [], context = {}) {
    if (context.date) return offerTimes(contactId, { ...context, clientCode }, context.date, excluded);
    return askPeriod(contactId, clientCode);
  }
  async function upsertLead(contactId, phone, fields, { handoff = false, displayName = '', booking = false } = {}) {
    let clientCode = fields.crm_30x_codigo;
    if (!clientCode) {
      const resolved = await crm('/api/v1/leads/resolve', { phone });
      if (!resolved.data?.clientCode || resolved.data.advisorAssigned !== true) throw new Error('ADVISOR_NOT_ASSIGNED');
      clientCode = String(resolved.data.clientCode);
    }
    const lead = await crm('/api/webhooks/prospecting-bot/lead', {
      phone, contactName: fields.nombre_completo || displayName || 'Contacto WhatsApp',
      ...(fields.ciudad_municipio ? { city: fields.ciudad_municipio } : {}),
      externalLeadId: clientCode,
      externalConversationId: contactId, source: 'whatsapp',
      status: handoff ? 'requiere_asesor' : 'perfilamiento_iniciado',
      ...(fields.correo_contacto ? { email: fields.correo_contacto } : {}),
      summary: profileComment(fields, { handoff, displayName, booking }),
      ...(handoff && fields['last user freeform input'] ? { lastMessage: String(fields['last user freeform input']).slice(0, 2000) } : {}),
      answers: { ...Object.fromEntries(PROFILE.filter(name => name !== 'last user freeform input')
        .map(name => [name, fields[name] ?? null])),
        ciudad: fields.ciudad_municipio || null,
        tieneCreditoHipotecario: yes(fields.obligacion_vivienda_activa) ? true : no(fields.obligacion_vivienda_activa) ? false : null,
        banco: declared(fields, 'rch_banco', 'banco_entidad'), estadoPago: fields.estado_pago || null,
        necesidadPrincipal: fields.necesidad_principal || null,
        lineaInteres: fields.linea_interes || 'RCH', solicitudAsesor: handoff,
        nombreConfirmado: Boolean(fields.nombre_completo) },
    });
    if (lead.persisted !== true || !lead.clientId) throw new Error('LEAD_NOT_PERSISTED');
    return String(lead.clientId);
  }
  async function recoverUnassignedIncoming(node) {
    const data = await graphql(`query IncomingRecoveryContext($botID:BotID!,$id:ContactID!,$conversationID:ConversationID!){
      bot(id:$botID){contact(id:$id){id assignee{__typename} salesStageV2 unhandledSwitchToHuman
        attributes(names:["bitrix_agenda_estado","bitrix_reserva_pendiente","crm_30x_incoming_recovery_hash"]){attr{name}value{... on BotAttributeValueString{stringValue}}}}
        conversation(conversationID:$conversationID){status messages(first:20){edges{node{id __typename sentTime}}}}}}`,
    { botID, id: node.id, conversationID: node.id });
    const current = data.bot.contact, conversation = data.bot.conversation;
    // Solo mensajes pendientes de atención automática. Nunca recuperar chats
    // humanos, perfiles ya trabajados ni un diálogo de reserva en curso.
    if (current.assignee || current.salesStageV2 !== 'New' || current.unhandledSwitchToHuman
      || conversation.status !== 'automated') return;
    const fields = attributeMap(current.attributes);
    if (decode(fields.bitrix_agenda_estado, node.id) || yes(fields.bitrix_reserva_pendiente)) return;
    const latest = conversation.messages.edges.map(edge => edge.node)
      .find(message => /^WhatsApp(?:In|Out)/.test(message.__typename));
    const age = now() - Date.parse(latest?.sentTime);
    if (!latest?.__typename.startsWith('WhatsAppIn') || !Number.isFinite(age) || age < 0 || age >= 86_400_000) return;
    const fingerprint = createHash('sha256').update(`${node.id}|${latest.id}`).digest('hex');
    if (fields.crm_30x_incoming_recovery_hash === fingerprint || incomingRecoveryAttempts.get(node.id) === fingerprint) return true;
    // Una respuesta perdida puede haber iniciado la IA. No repetir esa acción
    // para el mismo mensaje mientras se verifica su resultado.
    incomingRecoveryAttempts.set(node.id, fingerprint);
    if (incomingRecoveryAttempts.size > 5000) incomingRecoveryAttempts.delete(incomingRecoveryAttempts.keys().next().value);
    const assign = () => graphql('mutation IncomingRecoveryAssign($id:ContactID!){contactSetFuelyAIAssignee(id:$id){id assignee{__typename}}}', { id: node.id });
    try {
      let assigned;
      try { assigned = await assign(); }
      catch (error) {
        if (error.code !== 'ConversationThreadOwnedByExternalApp') throw error;
        const takeover = await graphql('mutation IncomingRecoveryTakeover($botID:BotID!,$id:ConversationID!){conversationStart(botID:$botID,conversationID:$id){id status}}', { botID, id: node.id });
        if (takeover.conversationStart?.id !== node.id) throw new Error('INCOMING_TAKEOVER_FAILED');
        assigned = await assign();
      }
      if (assigned.contactSetFuelyAIAssignee?.id !== node.id
        || assigned.contactSetFuelyAIAssignee.assignee?.__typename !== 'FuelyAIAssignee') throw new Error('INCOMING_ASSIGN_FAILED');
      handoffStatus.incomingRecovered++;
      await setAttributes(node.id, { crm_30x_incoming_recovery_hash: fingerprint });
      handoffStatus.incomingRecoveryLastError = null;
    } catch { handoffStatus.incomingRecoveryLastError = 'INCOMING_RECOVERY_FAILED'; }
    return true;
  }

  async function synchronizeHandoffs() {
    if (syncing) return syncing;
    syncing = (async () => {
      let after = null;
      let synchronized = 0;
      do {
        const data = await graphql(`query HandoffCandidates($botID:BotID!,$after:ContactSearchCursor,$names:[AttributeName!]){
          bot(id:$botID){contactChatsConnection(first:100,after:$after,assigneeFilter:{type:Any},unreadOnly:false,salesStageV2Filter:[]){
            edges{node{id name salesStageV2 unhandledSwitchToHuman assignee{__typename ... on PublicUserAccount{accountType}}
              attributes(names:$names){attr{name}value{... on BotAttributeValueString{stringValue}
                ... on BotAttributeValueBoolean{booleanValue} ... on BotAttributeValueDouble{doubleValue}}}
              ... on WhatsappContact{phone}}}pageInfo{hasNextPage endCursor}}}}`, { botID, after, names: ATTR });
        const page = data.bot.contactChatsConnection;
        for (const { node } of page.edges) {
          if (!/^wa_\d+_\d+_\d{8,15}$/.test(node.id)) continue;
          const phone = String(node.phone ?? '').replace(/\D/g, '');
          if (!/^\d{8,15}$/.test(phone)) continue;
          let fields = attributeMap(node.attributes);
          // Use the same customer-confirmed evidence as the booking gate. A
          // rejection may occur before Fuely captures any questionnaire field.
          // Unassigned chats still go through the existing incoming recovery.
          if (node.assignee || evaluateRchEligibility(fields).status === 'NO_APLICA') {
            try { fields = (await contact(node.id)).fields; }
            catch { handoffStatus.rejectionSyncLastError = 'PROFILE_EVIDENCE_UNAVAILABLE'; continue; }
          }
          // A bank/product rejection can finish before any booking intent.
          // Persist and synchronize it without starting a flow or sending a message.
          if (evaluateRchEligibility(fields).status === 'NO_APLICA') {
            try {
              const eligibility=evaluateRchEligibility(fields);
              const computed={rch_estado_elegibilidad:eligibility.status,rch_motivo_elegibilidad:eligibility.reason,
                rch_meses_restantes:eligibility.remainingMonths===null?'':String(eligibility.remainingMonths),rch_eligibilidad_version:RCH_POLICY_VERSION};
              const updates=Object.fromEntries(Object.entries(computed).filter(([name,value])=>String(fields[name]??'')!==value));
              if(Object.keys(updates).length)await setAttributes(node.id,updates);
              Object.assign(fields,computed);
              const fingerprint = createHash('sha256').update(JSON.stringify([PROFILE_FEEDBACK_VERSION,node.id,phone,
                ...PROFILE.filter(name=>name!=='last user freeform input').map(name=>String(fields[name]??''))])).digest('hex');
              if (synchronizedProfiles.get(node.id) === fingerprint) continue;
              const clientCode=await upsertLead(node.id, phone, fields, {displayName:node.name});
              if(fields.crm_30x_codigo!==clientCode)await setAttributes(node.id,{crm_30x_codigo:clientCode});
              synchronizedProfiles.set(node.id,fingerprint);
              if(synchronizedProfiles.size>5000)synchronizedProfiles.delete(synchronizedProfiles.keys().next().value);
              synchronized++;
              handoffStatus.rejectionSyncLastError = null;
            } catch { handoffStatus.rejectionSyncLastError = 'REJECTION_SYNC_FAILED'; }
            continue;
          }
          if (handoffStatus.incomingRecoveryEnabled && !node.assignee && node.salesStageV2 === 'New'
            && !node.unhandledSwitchToHuman) {
            if (await recoverUnassignedIncoming(node)) continue;
          }
          if (node.assignee?.__typename === 'FuelyAIAssignee') {
            const state = decode(fields.bitrix_agenda_estado, node.id);
            const resumeEligibleBooking = state?.step === 'eligibility_pending'
              && evaluateRchEligibility(fields).status === 'APLICA';
            const active = state && ['name', 'city', 'active', 'period', 'day', 'choose', 'confirm', 'booking', 'confirmed', 'check_pending','past_appointment'].includes(state.step);
            if ((!resumeEligibleBooking && !yes(fields.solicitud_agendamiento) && !explicitBooking(fields['last user freeform input']) && !confirmBooking(fields['last user freeform input']) && !availabilityAnswer(fields['last user freeform input']))
              || active || yes(fields.bitrix_reserva_pendiente) || !env.CHATFUEL_BOOKING_FLOW_ID) continue;
            const current = await graphql('query NaturalBookingContext($botID:BotID!,$id:ConversationID!){bot(id:$botID){conversation(conversationID:$id){status messages(first:20){edges{node{__typename id sentTime ... on WhatsAppInTextMessage{text} ... on WhatsAppOutTextMessage{text}}}}}}}', { botID, id: node.id });
            if (current.bot.conversation.status === 'open') continue;
            const messages = current.bot.conversation.messages.edges.map(edge => edge.node);
            const incomingIndex = messages.findIndex(message => message.__typename.startsWith('WhatsAppIn'));
            const incoming = messages[incomingIndex];
            if (!messages.slice(0, incomingIndex).some(message => message.__typename.startsWith('WhatsAppOut'))) continue;
            if (incoming?.__typename !== 'WhatsAppInTextMessage' || declineBooking(incoming.text)) continue;
            // Configuration changes must not replay already answered old requests.
            const incomingAt=Date.parse(incoming.sentTime);
            if(!Number.isFinite(incomingAt)||now()-incomingAt>5*60_000)continue;
            const evidence = value => normalize(value).replace(/[¿?¡!.,;:"'«»]/g, '').replace(/\s+/g, ' ').trim();
            const preceding = messages.slice(incomingIndex + 1).find(message =>
              message.__typename.startsWith('WhatsAppIn') || message.__typename.startsWith('WhatsAppOut'));
            const acceptedOffer = confirmBooking(incoming.text)
              && preceding?.__typename === 'WhatsAppOutTextMessage' && offersBooking(preceding.text);
            const requestedAvailability=availabilityAnswer(incoming.text)
              && preceding?.__typename==='WhatsAppOutTextMessage'
              && (offersBooking(preceding.text)||asksBookingPeriod(preceding.text));
            const capturedIntent = yes(fields.solicitud_agendamiento) && fields.texto_solicitud_agendamiento
              && evidence(incoming.text) === evidence(fields.texto_solicitud_agendamiento);
            const repeatedAcceptance=confirmBooking(incoming.text)
              && preceding?.__typename==='WhatsAppOutTextMessage'
              && /\brevisemos los horarios para tu cita\b/.test(normalize(preceding.text))
              && acceptedBookingHistory(messages.slice(incomingIndex+1));
            // A bare yes needs the immediately preceding call offer, even if an
            // AI-extracted attribute incorrectly classifies another answer as consent.
            if (!resumeEligibleBooking && !repeatedAcceptance && !explicitBooking(incoming.text) && !acceptedOffer && !requestedAvailability && !(capturedIntent && !confirmBooking(incoming.text))) continue;
            const intentHash = createHash('sha256').update(`${node.id}|${incoming.id}`).digest('hex');
            if (fields.crm_30x_booking_intent_hash === intentHash
              || routedBookingIntents.get(node.id) === intentHash) continue;
            const routed = await graphql('mutation NaturalBookingFlow($botID:BotID!,$id:ConversationID!,$flowID:FlowID!){conversationFinishSendToFlow(botID:$botID,conversationID:$id,flowID:$flowID){id status}}', { botID, id: node.id, flowID: env.CHATFUEL_BOOKING_FLOW_ID });
            if (routed.conversationFinishSendToFlow.id !== node.id) throw new Error('BOOKING_ROUTE_FAILED');
            // Las búsquedas pueden devolver atributos anteriores a la escritura.
            // No iniciar otra vez el flujo mientras esa actualización se propaga.
            routedBookingIntents.set(node.id, intentHash);
            if (routedBookingIntents.size > 5000) routedBookingIntents.delete(routedBookingIntents.keys().next().value);
            await setAttributes(node.id, { crm_30x_booking_intent_hash: intentHash });
            handoffStatus.bookingFlowsStarted++;
            continue;
          }
          if (node.assignee?.accountType === 'Virtual') continue;
          const fingerprint = createHash('sha256').update(JSON.stringify([PROFILE_FEEDBACK_VERSION, node.id, phone,
            ...PROFILE.map(name => String(fields[name] ?? ''))])).digest('hex');
          if ((fields.crm_30x_profile_comment_hash === fingerprint && fields.crm_30x_codigo)
            || synchronizedProfiles.get(node.id) === fingerprint) continue;
          const conversation = await graphql('query HandoffState($botID:BotID!,$id:ConversationID!){bot(id:$botID){conversation(conversationID:$id){status}}}',
            { botID, id: node.id });
          if (conversation.bot.conversation.status !== 'open') continue;
          const clientCode = await upsertLead(node.id, phone, fields, { handoff: true, displayName: node.name });
          await setAttributes(node.id, { crm_30x_codigo: clientCode, crm_30x_profile_comment_hash: fingerprint,
            crm_30x_handoff_estado: 'registrado', crm_30x_handoff_fecha: new Date(now()).toISOString() });
          synchronizedProfiles.set(node.id, fingerprint);
          if (synchronizedProfiles.size > 5000) synchronizedProfiles.delete(synchronizedProfiles.keys().next().value);
          synchronized++;
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      handoffStatus.lastSyncAt = new Date(now()).toISOString();
      handoffStatus.synchronized += synchronized;
      handoffStatus.lastError = null;
      return { ok: true, synchronized };
    })();
    try { return await syncing; }
    catch (error) { handoffStatus.lastError = 'HANDOFF_SYNC_FAILED'; throw error; }
    finally { syncing = null; }
  }
  async function eligibilityGate(contactId, phone, fields) {
    const result=evaluateRchEligibility(fields);
    const computed={rch_estado_elegibilidad:result.status,rch_motivo_elegibilidad:result.reason,
      rch_meses_restantes:result.remainingMonths===null?'':String(result.remainingMonths),rch_eligibilidad_version:RCH_POLICY_VERSION};
    await setAttributes(contactId,computed);
    if(result.status==='APLICA')return null;
    const clientCode=await upsertLead(contactId,phone,{...fields,...computed});
    return reply(contactId,{step:result.status==='NO_APLICA'?'not_eligible':'eligibility_pending',clientCode},
      eligibilityMessage(result),{done:true,fields:{solicitud_agendamiento:'no',texto_solicitud_agendamiento:'PENDIENTE'}});
  }
  async function profileOrOptions(contactId, phone, fields) {
    const blocked=await eligibilityGate(contactId,phone,fields);if(blocked)return blocked;
    if (!String(fields.nombre_completo ?? '').trim()) return reply(contactId, { step: 'name' }, 'Para agendar con el asesor, ¿cuál es tu nombre completo?');
    if (!String(fields.ciudad_municipio ?? '').trim()) return reply(contactId, { step: 'city' }, '¿En qué ciudad o municipio estás?');
    if (!yes(fields.obligacion_vivienda_activa)) return reply(contactId, { step: 'active' },
      '¿Actualmente tienes un crédito hipotecario o leasing habitacional que todavía estás pagando? Responde SÍ o NO.');
    const clientCode = await upsertLead(contactId, phone, fields, {booking:true});
    await setAttributes(contactId, { crm_30x_codigo: clientCode });
    return askPeriod(contactId, clientCode,nightPreference(fields['last user freeform input'])?{intro:nightExplanation}:{});
  }

  const handle = async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok: configured,
      service: 'chatfuel-bitrix-booking', version: RELEASE_VERSION, calendar: { provider: 'bitrix', storage: 'mysql', independent: true }, handoff: { ...handoffStatus } }, configured ? 200 : 503);
    if (!['/booking', '/sync-handoffs'].includes(url.pathname) || request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
    if (!configured) return json({ error: 'NOT_CONFIGURED' }, 503);
    if (!same(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) return json({ error: 'UNAUTHORIZED' }, 401);
    if (url.pathname === '/sync-handoffs') {
      try { return json(await synchronizeHandoffs()); }
      catch { return json({ error: 'HANDOFF_SYNC_FAILED' }, 503); }
    }
    let body;
    try { body = await request.json(); } catch { return json({ error: 'INVALID_JSON' }, 400); }
    const { contactId, operation } = body;
    // Preview sessions cannot create CRM leads or appointments.
    if (typeof contactId === 'string' && /^(?:wa_)?cfPreview:/.test(contactId)) return json({
      message: 'Este es un chat de prueba. La conexión de agenda respondió; no se creó ninguna negociación ni cita real. En WhatsApp la asistente ofrece coordinar una cita de asesoría virtual por Zoom y consulta los horarios al continuar.', done: 'si', human: 'no' });
    if (typeof contactId !== 'string' || !/^wa_\d+_\d+_\d{8,15}$/.test(contactId)
      || !['start', 'step'].includes(operation)) return json({ error: 'INVALID_CONTACT_OR_OPERATION' }, 422);
    let bookingMayExist = true;
    const run = async () => {
      const { phone, fields } = await contact(contactId);
      const answer = String(fields.bitrix_agenda_respuesta ?? '').trim();
      let state = decode(fields.bitrix_agenda_estado, contactId);
      const expired = state ? null : decode(fields.bitrix_agenda_estado, contactId, { allowExpired:true });
      bookingMayExist = yes(fields.bitrix_reserva_pendiente)
        || ['booking','confirmed','check_pending'].includes(state?.step || expired?.step);
      const previousBooking=state || expired;
      const previousEnd=Date.parse(previousBooking?.slot?.endAt);
      const previousStart=Date.parse(previousBooking?.slot?.startAt);
      if(previousBooking?.step==='confirmed'
        && /^\d{1,20}$/.test(String(previousBooking.bitrixEventId||''))
        && Number.isFinite(previousStart) && Number.isFinite(previousEnd)
        && previousStart<previousEnd && previousEnd<=now()
        && !yes(fields.bitrix_reserva_pendiente)){
        // Explain the previous appointment before offering a new one. Do not
        // interpret an answer to the old invitation as accepting a second visit.
        bookingMayExist=false;
        return reply(contactId,{...previousBooking,step:'past_appointment'},
          recordedAppointmentMessage(previousBooking));
      }
      // Profile answers and morning/afternoon preferences can resume; an expired
      // time selection never authorizes a reservation without fresh availability.
      if (expired && ['name','city','active','period','past_appointment'].includes(expired.step)) state = expired;
      if(!state && expired?.step==='confirmed'
        && /^\d{1,20}$/.test(String(expired.bitrixEventId||''))
        && Number.isFinite(previousStart) && Number.isFinite(previousEnd)
        && previousStart<previousEnd && previousEnd>now()
        && !yes(fields.bitrix_reserva_pendiente))state=expired;
      // Safely bring an old selection/profile into the local store. A reservation
      // already sent to the former engine must instead be reconciled by its key.
      if (state?.clientCode && state.engine !== 'local-v1' && !['booking', 'confirmed', 'check_pending','past_appointment'].includes(state.step)) {
        const clientCode = await upsertLead(contactId, phone, { ...fields, crm_30x_codigo: state.clientCode });
        state = { ...state, clientCode };
      }
      if (expired?.step === 'period' && expired.engine === 'local-v1') {
        const clientCode = await upsertLead(contactId,phone,{...fields,crm_30x_codigo:expired.clientCode});
        state = {...state,clientCode};
      }
      bookingMayExist = yes(fields.bitrix_reserva_pendiente) || ['booking', 'confirmed', 'check_pending'].includes(state?.step);
      if (!state && expired && ['booking','confirmed','check_pending'].includes(expired.step)) {
        bookingMayExist = true;
        const key = expired.slot && expired.clientCode ? `chatfuel-${createHash('sha256')
          .update(`${contactId}|${expired.clientCode}|${expired.slot.startAt}|${expired.slot.advisorId}`).digest('hex')}` : null;
        const saved = await scheduling.getBookingState({appointmentId:expired.appointmentId,key,clientCode:expired.clientCode});
        if (saved?.status === 'confirmed') state = {...expired,step:'confirmed',appointmentId:saved.id,
          bitrixEventId:saved.bitrixEventId,slot:{...expired.slot,startAt:saved.startAt,endAt:saved.endAt}};
        else return reply(contactId,{...expired,step:'check_pending'},
          'Estoy verificando la reserva anterior para evitar duplicarla. Un asesor puede ayudarte a confirmar su estado.',{done:true,human:true});
      }
      if (state?.step === 'confirmed') {
        // Retrying a stage update must never request another calendar event.
        let pending = state.crmSyncPending === true;
        let responsibleId = state.responsibleId || '', reviewRequired = false;
        if (pending && state.appointmentId) {
          try {
            const result = await crm('/api/v1/appointments/retry-crm', { appointmentId: state.appointmentId });
            const sync = result.data?.results?.find(item => item.appointmentId === state.appointmentId)?.crmSync;
            pending = !(sync?.status === 'completed' && String(sync.dealId) === state.bookingDealId && sync.stageId === 'C370:EXECUTING');
            responsibleId = sync?.responsibleId || responsibleId;
            reviewRequired = sync?.reviewRequired === true;
          } catch { /* The booking remains confirmed when CRM is unavailable. */ }
        }
        return reply(contactId, { ...state, crmSyncPending: pending,responsibleId },
          `Tu cita ya está confirmada para ${label(state.slot)} (hora de Colombia).`,
          { done: true, fields: { bitrix_negociacion_sync: reviewRequired ? 'revision_requerida' : pending ? 'pendiente' : state.bookingDealId ? 'completado' : 'no_aplica',
            ...(state.bookingDealId ? {bitrix_responsable_id:responsibleId,
              bitrix_responsable_sync:reviewRequired ? 'revision_requerida' : pending ? 'pendiente' : 'completado'} : {}) } });
      }
      if (yes(fields.bitrix_reserva_pendiente) && state?.step !== 'booking') return reply(contactId,
        { step: 'check_pending' }, 'Hay una reserva pendiente de verificación. Un asesor debe comprobarla antes de solicitar otra cita.', { done: true });
      if (!state && expired && ['day','choose','confirm'].includes(expired.step)) {
        const blocked=await eligibilityGate(contactId,phone,fields);if(blocked)return blocked;
        if (!fields.nombre_completo || !fields.ciudad_municipio || !yes(fields.obligacion_vivienda_activa)) return profileOrOptions(contactId,phone,fields);
        const clientCode = await upsertLead(contactId,phone,fields);
        await setAttributes(contactId,{crm_30x_codigo:clientCode});
        const context = {...expired,clientCode};
        const window = {fromTime:context.fromTime || '08:30',toTime:context.toTime || '17:00'};
        if (expired.step !== 'day' && context.date >= dateAt(now()) && context.date <= addDays(dateAt(now()),21)) return offerTimes(contactId,context,context.date);
        return offerDays(contactId,clientCode,window);
      }
      if(operation==='start' && state?.step==='past_appointment')return reply(contactId,state,recordedAppointmentMessage(state));
      if (operation === 'start' && state?.step !== 'booking' && !(expired?.step === 'period' && periodFrom(answer))) return profileOrOptions(contactId, phone, fields);
      if (!state) return profileOrOptions(contactId,phone,fields);
      if (/(?:hablar|comunicar|pasame|pasarme|contactar).*(?:asesor|persona|humano)|(?:asesor|persona|humano)\s+ahora|^(?:quiero|necesito)\s+(?:un\s+)?asesor|\b(?:demanda|embargo|remate|cobro juridico|urgente)\b/.test(normalize(answer))) return reply(contactId,
        { step: 'human_requested', clientCode: state.clientCode }, 'La atención pasa al equipo de Avanzar para revisar tu caso con el contexto disponible.', { done: true, human: true });
      if (state.step === 'active' && /^(no|n|0|false)[.!\s]*$/.test(normalize(answer))) {
        await setAttributes(contactId, { obligacion_vivienda_activa: 'no' });
        return profileOrOptions(contactId, phone, { ...fields, obligacion_vivienda_activa: 'no' });
      }
      if (state.step !== 'booking' && declineBooking(answer)) return reply(contactId, { step: 'cancelled', clientCode: state.clientCode },
        'Dejamos la cita pendiente. No reservé ningún horario; puedes pedirme que retomemos el agendamiento cuando lo prefieras.', { done: true });
      if(state.step==='past_appointment'){
        if(confirmBooking(answer)||explicitBooking(answer))return profileOrOptions(contactId,phone,fields);
        return reply(contactId,state,recordedAppointmentMessage(state));
      }
      if(['period','day','choose','confirm'].includes(state.step)) {
        const blocked=await eligibilityGate(contactId,phone,fields);if(blocked)return blocked;
      }
      // A selection offered under the previous duration is not consent to a
      // longer call. Refresh availability and require a new choice/confirmation.
      const offered = state.step === 'confirm' ? [state.slot] : state.slots;
      if (['choose','confirm'].includes(state.step) && Array.isArray(offered)
        && offered.some(slot => Date.parse(slot?.endAt) - Date.parse(slot?.startAt) !== APPOINTMENT_DURATION_MS)) {
        if (state.date >= dateAt(now()) && state.date <= addDays(dateAt(now()),21)) return offerTimes(contactId,state,state.date);
        return offerDays(contactId,state.clientCode,{fromTime:state.fromTime||'08:30',toTime:state.toTime||'17:00'});
      }
      if (state.step === 'name' || state.step === 'city') {
        const valid = state.step === 'name'
          ? /^[\p{L}][\p{L}\p{M}' .-]{2,119}$/u.test(answer) && answer.split(/\s+/).length >= 2
          : /^[\p{L}\p{N}][\p{L}\p{M}\p{N}' ,.-]{1,99}$/u.test(answer);
        if (!valid) return reply(contactId, state, state.step === 'name' ? 'Por favor, escribe tu nombre y apellido para agendar.' : 'Por favor, escribe el nombre de tu ciudad o municipio.');
        const name = state.step === 'name' ? 'nombre_completo' : 'ciudad_municipio';
        await setAttributes(contactId, { [name]: answer });
        return profileOrOptions(contactId, phone, { ...fields, [name]: answer });
      }
      if (state.step === 'active') {
        if (!yes(answer)) return reply(contactId, state, 'Para esta agenda de reducción de crédito hipotecario necesito confirmar si tienes crédito hipotecario o leasing habitacional vigente. Responde SÍ o NO.');
        await setAttributes(contactId, { obligacion_vivienda_activa: 'si', linea_interes: 'RCH' });
        return profileOrOptions(contactId, phone, { ...fields, obligacion_vivienda_activa: 'si' });
      }
      if (['period', 'day', 'choose', 'confirm'].includes(state.step)) {
        const text = normalize(answer);
        if (/\b(?:otro dia|cambiar (?:de )?dia|otra fecha)\b/.test(text)) return offerDays(contactId, state.clientCode,
          { fromTime: state.fromTime || '08:30', toTime: state.toTime || '17:00' });
        if (/\b(?:otra franja|cambiar (?:de )?franja)\b/.test(text)) return askPeriod(contactId, state.clientCode, { date: state.date });
        if (state.step === 'period') {
          if(nightPreference(answer))return askPeriod(contactId,state.clientCode,{date:state.date,intro:nightExplanation});
          const index = selection(answer, 2);
          const window = index !== null ? PERIODS[index] : periodFrom(answer);
          if (!window) return reply(contactId, state, '¿Prefieres el contacto en la mañana o en la tarde?');
          return state.date ? offerTimes(contactId, { ...state, ...window }, state.date) : offerDays(contactId, state.clientCode, window);
        }
        if (state.step === 'day') {
          const date = selectedDay(answer, state.days, now());
          if (!date) return reply(contactId, state, `Puedes elegir ${state.days.map(dayLabel).join(' o ')}. ¿Cuál prefieres?`);
          const requestedWindow = /(?:en|por) la (?:tarde|manana)\b/.test(text) ? periodFrom(answer) : null;
          return offerTimes(contactId, { ...state, ...(requestedWindow || {}) }, date);
        }
        if (/(?:en|por) la (?:tarde|manana)\b|^tarde$/.test(text)) {
          const window = periodFrom(answer);
          if (window && (window.fromTime !== state.fromTime || window.toTime !== state.toTime)) return offerTimes(contactId, { ...state, ...window }, state.date || dateAt(state.slots[0].startAt));
        }
      }
      if (state.step === 'choose') {
        if (/^(?:mas|otras opciones|otros horarios|mas opciones|mas horarios|no me sirven|ningun[oa] me sirve|ninguno|ninguna)[.!]*$/.test(normalize(answer))) return options(contactId, state.clientCode, state.excludedStarts || state.slots.map(s => s.startAt), state);
        let index = selection(answer, state.slots.length);
        const clock = normalize(answer).replace(/\b([ap])\s*\.\s*m\s*\.?/g, '$1m').match(/^(?:(?:a las|la de las|prefiero a las)\s+)?([01]?\d|2[0-3])(?:[:.]([0-5]\d))?(?:\s*(am|pm))?[.!]*$/);
        if (index === null && clock) {
          let hour = Number(clock[1]);
          if (clock[3] === 'pm' && hour < 12) hour += 12;
          if (clock[3] === 'am' && hour === 12) hour = 0;
          const time = `${String(hour).padStart(2, '0')}:${clock[2] || '00'}`;
          const matches = state.slots.map((slot, i) => timeAt(slot.startAt) === time ? i : -1).filter(i => i >= 0);
          if (matches.length === 1) index = matches[0];
        }
        if (index === null) return reply(contactId, state, '¿Cuál de los horarios ofrecidos te sirve? Puedes responder con la hora, el número o decir, por ejemplo, «la primera». También podemos revisar otro día u otra franja.');
        const slot = state.slots[index];
        return reply(contactId, { ...state, step: 'confirm', slot },
          `🗓️ Elegiste ${label(slot)} (hora de Colombia), para tu cita de asesoría virtual de 30 minutos por Zoom. ¿Confirmas que puedes conectarte y que reserve ese horario? Responde SÍ o CANCELAR.`);
      }
      if (state.step === 'confirm' || state.step === 'booking') {
        if (state.step === 'confirm' && !confirmBooking(answer)) return reply(contactId, state, '¿Confirmas que reserve el horario elegido? Si prefieres dejarlo pendiente, también me lo puedes decir.');
        // Chatfuel may stop waiting before Bitrix finishes. Replace the flow's
        // fallback before any slow work, so a timeout reports an ongoing check.
        // The durable booking key still protects later replies from duplicates.
        await setAttributes(contactId, {
          bitrix_agenda_mensaje: 'Estoy verificando tu reserva con el calendario. En unos segundos, responde «continuar» para consultar la confirmación. No necesitas elegir otro horario.',
          bitrix_agenda_finalizada: 'no',
        });
        if(state.step==='confirm')await upsertLead(contactId,phone,{...fields,crm_30x_codigo:state.clientCode});
        // Resolve before creating the appointment and freeze even a missing match
        // in signed state, so retries cannot bind an already created event elsewhere.
        let bookingDealId = Object.hasOwn(state, 'bookingDealId') ? state.bookingDealId : null;
        if (!Object.hasOwn(state, 'bookingDealId') && state.step !== 'booking' && database) {
          try {
            const registered = scheduling.findRegisteredClient
              ? await scheduling.findRegisteredClient(phone)
              : await database.findClienteByPhone(phone);
            bookingDealId = registered ? String(registered.id_negociacion) : null;
            if (bookingDealId !== null && !/^[1-9]\d*$/.test(bookingDealId)) throw new Error('INVALID_DEAL');
          } catch (error) {
            return reply(contactId, state,
              error.code === 'TELEFONO_AMBIGUO'
                ? 'Encontré más de una negociación asociada a tu teléfono. Un asesor debe revisar cuál corresponde antes de reservar.'
                : 'No pude consultar tu registro en este momento. La cita aún no se ha solicitado; podemos reintentar la confirmación.',
              { done: error.code === 'TELEFONO_AMBIGUO', human: error.code === 'TELEFONO_AMBIGUO' });
          }
        }
        const durationMinutes = state.step === 'booking'
          ? (Date.parse(state.slot.endAt) - Date.parse(state.slot.startAt)) / 60_000
          : APPOINTMENT_DURATION_MINUTES;
        const key = `chatfuel-${createHash('sha256').update(`${contactId}|${state.clientCode}|${state.slot.startAt}|${state.slot.advisorId}`).digest('hex')}`;
        const legacyPending = state.legacyPending === true || (state.step === 'booking' && state.engine !== 'local-v1');
        bookingMayExist = true;
        await setAttributes(contactId, { bitrix_reserva_pendiente: 'si',
          bitrix_agenda_estado: encode(contactId, { ...state, step: 'booking', bookingDealId, legacyPending }) });
        try {
          const result = await crm(`/api/v1/leads/${encodeURIComponent(state.clientCode)}/appointments`, {
            startAt: state.slot.startAt, durationMinutes, advisorId: state.slot.advisorId,
            advisorPool: true, idempotencyKey: key,
            ...(legacyPending ? { resumeOnly: true } : {}),
            ...(bookingDealId ? { bitrixDealId: bookingDealId, bitrixStageId: 'C370:EXECUTING' } : {}),
          }, key);
          const booking = result.data;
          if (booking?.status !== 'confirmed' || !/^\d+$/.test(String(booking.bitrixEventId ?? ''))
            || Number(booking.bitrixEventId) <= 0 || !booking.appointmentId
            || Date.parse(booking.startAt) !== Date.parse(state.slot.startAt)
            || Date.parse(booking.endAt) - Date.parse(booking.startAt) !== durationMinutes * 60_000) throw new Error('INVALID_BOOKING_CONFIRMATION');
          const crmSyncPending = Boolean(bookingDealId && !(booking.crmSync?.status === 'completed'
            && String(booking.crmSync.dealId) === bookingDealId && booking.crmSync.stageId === 'C370:EXECUTING'));
          return reply(contactId, { step: 'confirmed', clientCode: state.clientCode, bookingDealId, crmSyncPending,
            responsibleId:booking.crmSync?.responsibleId || '',
            slot: state.slot, bitrixEventId: String(booking.bitrixEventId), appointmentId: booking.appointmentId },
          `✅ Tu cita de asesoría virtual por Zoom quedó agendada para ${label(state.slot)} (hora de Colombia), con un asesor. Duración: ${durationMinutes} minutos. 💻 Recuerda conectarte puntualmente a tu cita.\n\nLa asesoría inicial es gratuita y, para atenderla, es indispensable tener el extracto bancario COMPLETO de tu crédito en PDF y compartirlo por el canal autorizado. También deben estar todos los titulares y quienes tomarán la decisión.\n\nTe esperamos; si necesitas revisarla, escríbenos por este mismo chat.`,
          { done: true, fields: { bitrix_reserva_pendiente: 'no', bitrix_evento_id: booking.bitrixEventId, bitrix_cita_id: booking.appointmentId,
            bitrix_cita_inicio: booking.startAt, crm_30x_codigo: state.clientCode,
            bitrix_negociacion_id: bookingDealId || '',
            bitrix_negociacion_sync: booking.crmSync?.reviewRequired ? 'revision_requerida' : crmSyncPending ? 'pendiente' : bookingDealId ? 'completado' : 'no_aplica',
            ...(bookingDealId ? {bitrix_responsable_id:booking.crmSync?.responsibleId || '',
              bitrix_responsable_sync:booking.crmSync?.reviewRequired ? 'revision_requerida' : crmSyncPending ? 'pendiente' : 'completado'} : {}) } });
        } catch (error) {
          if(error.code==='RCH_NOT_ELIGIBLE'||error.code==='RCH_PROFILE_INCOMPLETE') {
            await setAttributes(contactId,{bitrix_reserva_pendiente:'no'});bookingMayExist=false;
            return reply(contactId,{step:'eligibility_pending',clientCode:state.clientCode},
              eligibilityMessage(error.eligibility),{done:true});
          }
          if (error.message === 'SLOT_UNAVAILABLE' || error.message === 'INVALID_ADVISOR') {
            await setAttributes(contactId, { bitrix_reserva_pendiente: 'no' });
            bookingMayExist = false;
            // A removed advisor invalidates the old offer, not necessarily its
            // time: it may still be free in the currently enabled calendar.
            const excluded = error.message === 'INVALID_ADVISOR' ? [] : state.excludedStarts || [state.slot.startAt];
            return options(contactId, state.clientCode, excluded, { ...state, date: state.date || dateAt(state.slot.startAt) });
          }
          throw error;
        }
      }
      return reply(contactId, { step: 'restart' }, 'Puedes pedirme que volvamos a revisar los horarios para tu cita de asesoría virtual por Zoom.', { done: true });
    };
    try { return await run(); }
    catch (error) {
      const diagnostic = String(error.code || error.message || 'INTEGRATION_UNAVAILABLE');
      console.error({ evento:'agenda_chatfuel_fallo', operacion:operation,
        codigo:/^[A-Z_]{1,64}$/.test(diagnostic)?diagnostic:'INTEGRATION_UNAVAILABLE',
        reserva_posible:bookingMayExist });
      const cause = ['CRM_UNAUTHORIZED', 'CRM_UNAVAILABLE', 'CRM_INVALID_RESPONSE', 'CHATFUEL_UNAVAILABLE',
        'ADVISOR_NOT_ASSIGNED', 'LEAD_NOT_PERSISTED'].includes(error.message) ? error.message : 'INTEGRATION_UNAVAILABLE';
      // A failure may happen after Bitrix accepted a booking; never claim it was not booked.
      const failure = !bookingMayExist ? {
        message: 'No pude consultar la agenda en este momento. Conservé tus datos y todavía no se ha solicitado una cita. Escríbeme «agendar» para retomarlo 🗓️.',
        done: 'si', human: 'no', error: 'BOOKING_LOOKUP_FAILED', cause,
      } : { message: 'No pude verificar el estado de la agenda en este momento. Evita solicitar otra cita hasta que confirmemos si la reserva se completó. Puedes pedir ayuda a un asesor.', done: 'si', human: 'no', error: 'BOOKING_CHECK_REQUIRED', cause };
      try {
        // A known failure must replace the in-progress timeout notice too.
        await setAttributes(contactId, { bitrix_agenda_mensaje: failure.message, bitrix_agenda_finalizada: 'si' });
      } catch { /* Chatfuel may also be unavailable; retain the safe fallback. */ }
      return json(failure);
    }
  };
  handle.synchronizeHandoffs = synchronizeHandoffs;
  handle.handoffStatus = handoffStatus;
  return handle;
}

export function startHandoffListener(handler, { env = process.env, WebSocketImpl = globalThis.WebSocket,
  delay = setTimeout, cancelDelay = clearTimeout } = {}) {
  let socket, reconnectTimer, heartbeat, retryTimer;
  let stopped = false, retryDelay = 1000;
  let running = false, runAgain = false;
  const state = handler.handoffStatus;
  async function sync() {
    runAgain = true;
    if (running) return;
    running = true;
    try {
      do { runAgain = false; await handler.synchronizeHandoffs(); }
      while (runAgain && !stopped);
    }
    catch {
      if (!stopped && !retryTimer) retryTimer = delay(() => { retryTimer = null; void sync(); }, 10_000);
    }
    finally { running = false; }
  }
  function beat() {
    if (stopped || socket?.readyState !== 1) return;
    socket.send(JSON.stringify({ type: 'ping' }));
    heartbeat = delay(beat, 10_000);
  }
  function connect() {
    if (stopped) return;
    socket = new WebSocketImpl('wss://panel.chatfuel.com/graphql', 'graphql-transport-ws');
    socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init',
      payload: { authToken: `Bearer ${env.CHATFUEL_API_TOKEN}` } }));
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === 'connection_ack') {
        state.connected = true; retryDelay = 1000;
        socket.send(JSON.stringify({ id: 'handoffs', type: 'subscribe', payload: {
          query: 'subscription HandoffNotifications($botID:BotID!){contactsChatUpdates(botID:$botID,assigneeFilter:{type:Any},unreadOnly:false,salesStageV2Filter:[]){__typename}}',
          variables: { botID: env.CHATFUEL_BOT_ID },
        } }));
        heartbeat = delay(beat, 10_000);
        void sync();
      } else if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong', ...(message.payload ? { payload: message.payload } : {}) }));
      else if (message.type === 'next') {
        if (message.payload?.errors?.length) { state.lastError = 'SUBSCRIPTION_FAILED'; socket.close(); }
        else void sync();
      } else if (message.type === 'error') { state.lastError = 'SUBSCRIPTION_FAILED'; socket.close(); }
    };
    socket.onclose = () => {
      state.connected = false;
      if (heartbeat) cancelDelay(heartbeat);
      if (!stopped) { reconnectTimer = delay(connect, retryDelay); retryDelay = Math.min(retryDelay * 2, 30_000); }
    };
    socket.onerror = () => { state.lastError = 'WEBSOCKET_FAILED'; socket.close(); };
  }
  connect();
  return () => {
    stopped = true;
    for (const timer of [reconnectTimer, heartbeat, retryTimer]) if (timer) cancelDelay(timer);
    socket?.close();
  };
}
