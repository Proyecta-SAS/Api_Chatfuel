import test from 'node:test';
import assert from 'node:assert/strict';
import { withAppointmentSummary, timelineSummary } from '../src/calendar/profileSummary.js';
const base='RESUMEN Y FEEDBACK DE CHATFUEL\n\nCONTEXTO DE ATENCIÓN\n• Motivo de atención: perfilamiento por WhatsApp con Chatfuel. No se registra una reserva de cita desde este resumen.';
const appointment={status:'confirmed',startAt:'2026-11-13T21:30:00Z',endAt:'2026-11-13T22:00:00Z',bitrixEventId:'123',bitrixUserId:'10'};
test('el resumen distingue reservas pendientes de confirmadas y expresa la hora de Colombia',()=>{
  const text=withAppointmentSummary(base,appointment,{advisorName:'Asesor',now:Date.parse('2026-11-11T12:00:00Z')});
  assert.match(text,/viernes, 13 de noviembre de 2026/);assert.match(text,/4:30.*5:00.*hora de Colombia/);
  assert.doesNotMatch(text,/No se registra una reserva/);
  assert.equal(withAppointmentSummary(text,appointment,{advisorName:'Asesor',now:Date.parse('2026-11-11T12:00:00Z')}),text);
  assert.match(timelineSummary(text),/\[b\]RESUMEN DE LA CITA\[\/b\]/);
  const pending=withAppointmentSummary(base,{...appointment,status:'pending',bitrixEventId:null});
  assert.match(pending,/pendiente de confirmación técnica/);assert.doesNotMatch(pending,/confirmada en Bitrix|Identificador del evento/);
});
test('una cita pasada conserva su fecha sin presentarse como una próxima asesoría',()=>{
  assert.match(withAppointmentSummary(base,appointment,{now:Date.parse('2026-11-14T12:00:00Z')}),/fecha ya transcurrió/);
});
test('fechas o identificadores inválidos y ausencia de reserva no inventan una confirmación',()=>{
  for(const row of [null,{...appointment,bitrixEventId:''},{...appointment,startAt:'invalid'},{...appointment,status:'cancelled'}]){
    assert.equal(withAppointmentSummary(base,row),base);
  }
});