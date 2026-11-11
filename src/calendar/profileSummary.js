export const DEAL_SUMMARY_FIELD = 'UF_CRM_1646852109830';
export const PROFILE_FEEDBACK_VERSION = 'feedback-v4';

export const FEEDBACK_HEADINGS = [
  'RESUMEN Y FEEDBACK DE CHATFUEL', 'DATOS RECOPILADOS', 'INTERESES Y CONSULTAS',
  'CONTEXTO DE ATENCIÓN', 'ANÁLISIS PARA EL ASESOR', 'PRÓXIMOS PASOS', 'DATOS POR CONFIRMAR', 'RESUMEN DE LA CITA',
];

// This portal silently truncates CRM text at supplementary Unicode characters
// (for example WhatsApp display-name emoji). Preserve the original in MySQL;
// use a compatible representation for the field, timeline and their fingerprint.
export function bitrixSummaryText(summary) {
  return String(summary).replace(/[\u{10000}-\u{10FFFF}\u200d\ufe0e\ufe0f]/gu, '');
}

// Only our headings carry BBCode. Client text cannot inject links, mentions or tags.
export function timelineSummary(summary) {
  return String(summary).split(/\r?\n/).map(line => {
    const safe = line.replaceAll('[', '［').replaceAll(']', '］').replaceAll('<', '＜').replaceAll('>', '＞');
    return FEEDBACK_HEADINGS.includes(line) || line === 'RESUMEN Y FEEDBACK DE DALIA' ? `[b]${safe}[/b]` : safe;
  }).join('\n');
}

// Appointment facts come from our durable calendar rows, never extracted chat text.
export function withAppointmentSummary(summary, appointment, { advisorName = '', now = Date.now() } = {}) {
  if (!appointment || !['pending', 'confirmed'].includes(appointment.status)) return String(summary);
  const start = Date.parse(appointment.startAt), end = Date.parse(appointment.endAt);
  const confirmed = appointment.status === 'confirmed' && /^[1-9]\d*$/.test(String(appointment.bitrixEventId || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start
    || appointment.status === 'confirmed' && !confirmed) return String(summary);
  const date = new Intl.DateTimeFormat('es-CO', { timeZone:'America/Bogota', weekday:'long', year:'numeric', month:'long', day:'numeric' }).format(new Date(start));
  const time = value => new Intl.DateTimeFormat('es-CO', { timeZone:'America/Bogota', hour:'numeric', minute:'2-digit', hour12:true }).format(new Date(value));
  const minutes = (end-start)/60_000;
  const lines = [
    confirmed ? 'Estado: confirmada en Bitrix' + (end <= now ? '; la fecha ya transcurrió.' : '.')
      : 'Estado: reserva en verificación; pendiente de confirmación técnica.',
    'Fecha: ' + date + '.',
    'Horario: ' + time(start) + ' a ' + time(end) + ' (hora de Colombia).',
    'Duración: ' + minutes + ' minutos.',
    'Modalidad: ' + (minutes === 30 ? 'asesoría virtual por Zoom.' : 'asesoría con un asesor.'),
    ...(advisorName ? ['Asesor asignado: ' + advisorName + '.'] : []),
    ...(appointment.bitrixUserId ? ['Responsable del calendario en Bitrix: ' + appointment.bitrixUserId + '.'] : []),
    ...(confirmed ? ['Identificador del evento en Bitrix: ' + appointment.bitrixEventId + '.'] : []),
  ];
  // Replace our earlier section so refreshes cannot stack repeated appointment data.
  let skipping = false;
  const base = String(summary).split(/\r?\n/).filter(line => {
    if (line === 'RESUMEN DE LA CITA') { skipping=true; return false; }
    if (skipping && FEEDBACK_HEADINGS.includes(line)) skipping=false;
    return !skipping;
  }).join('\n').trim()
    .replace('Motivo de atención: perfilamiento por WhatsApp con Chatfuel. No se registra una reserva de cita desde este resumen.',
      'Motivo de atención: perfilamiento por WhatsApp con Chatfuel. El estado de la cita figura en RESUMEN DE LA CITA.')
    .replace('Este perfilamiento no confirma una reserva; verificar el resultado técnico de la agenda en Bitrix.',
      'El estado de la reserva figura en RESUMEN DE LA CITA.')
    .replace('Este registro no acredita una solicitud ni una reserva de cita.',
      'Este descarte corresponde al perfilamiento actual; revisar por separado la cita registrada en RESUMEN DE LA CITA.');
  return base + '\n\nRESUMEN DE LA CITA\n' + lines.map(line => '• ' + line).join('\n');
}
